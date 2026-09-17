/**
 * 模型调用封装。
 *
 * 两件事值得单独做一层：
 *
 * 1. **结构化输出的解析修复回路。** 模型返回违规 JSON 是预期内的分支，不是异常。
 *    第一次失败后把 zod 的报错原文回喂一次，成功率能从 ~90% 提到 ~99%，
 *    代价只是一次短调用。直接抛错等于把整轮研究废掉。
 *
 * 2. **成本即时归因。** 每个阶段用了多少钱必须能当场说出来，
 *    否则预算控制就是纸面上的 —— 你只能在跑完之后才发现超支。
 */

import { z } from "zod";
import {
  computeCost,
  extractJsonCandidates,
  textOf,
  toJsonSchema,
  type ModelRegistry,
  type ModelRequest,
  type Usage,
} from "aetherflow";

export interface LlmRequest {
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  /** 成本归因标签，例如 `plan` / `extract` / `verify`。 */
  readonly label?: string;
}

export interface LlmReply {
  readonly text: string;
  readonly usage: Usage;
  readonly costUsd: number;
  readonly model: string;
}

export interface JsonOptions {
  /** schema 名，进 response_format。 */
  readonly name?: string;
  /** 解析失败后是否回喂报错重试一次。默认 true。 */
  readonly repair?: boolean;
}

export interface Llm {
  readonly model: string;
  text(request: LlmRequest): Promise<LlmReply>;
  json<T>(
    schema: z.ZodType<T>,
    request: LlmRequest,
    options?: JsonOptions,
  ): Promise<{ ok: true; value: T; costUsd: number } | { ok: false; error: Error; costUsd: number }>;
}

const JSON_INSTRUCTION =
  "Reply with JSON only. No prose, no code fence, no commentary before or after. " +
  "The JSON must validate against the schema I described.";

/** 用量回调：让调用方能按阶段累计 token，而不必层层回传 usage 对象。 */
export type UsageSink = (usage: Usage) => void;

export function createLlm(registry: ModelRegistry, model: string, onUsage?: UsageSink): Llm {
  const resolved = registry.resolve(model);
  const provider = resolved.provider;
  const canNativeJson = provider.capabilities.jsonSchema;

  async function call(
    modelName: string,
    messages: ModelRequest["messages"],
    request: LlmRequest,
    responseFormat?: ModelRequest["responseFormat"],
  ): Promise<LlmReply> {
    const target = registry.resolve(modelName);
    const response = await target.provider.generate({
      model: target.model,
      messages,
      ...(responseFormat ? { responseFormat } : {}),
      ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.label ? { metadata: { label: request.label } } : {}),
    });
    const pricing = target.provider.pricing?.(target.model);
    onUsage?.(response.usage);
    return {
      text: textOf(response.message),
      usage: response.usage,
      costUsd: computeCost(response.usage, pricing).total,
      model: target.model,
    };
  }

  return {
    model: resolved.model,

    async text(request: LlmRequest): Promise<LlmReply> {
      const messages: ModelRequest["messages"] = [
        ...(request.system ? [{ role: "system" as const, content: request.system }] : []),
        { role: "user" as const, content: request.prompt },
      ];
      return call(model, messages, request);
    },

    async json<T>(
      schema: z.ZodType<T>,
      request: LlmRequest,
      options: JsonOptions = {},
    ): Promise<
      { ok: true; value: T; costUsd: number } | { ok: false; error: Error; costUsd: number }
    > {
      const jsonSchema = toJsonSchema(schema);
      const systemParts = [request.system, canNativeJson ? "" : schemaHint(jsonSchema)].filter(
        (part) => part && part.length > 0,
      );
      const messages: ModelRequest["messages"] = [
        ...(systemParts.length > 0
          ? [{ role: "system" as const, content: systemParts.join("\n\n") }]
          : []),
        {
          role: "user" as const,
          content: canNativeJson
            ? `${request.prompt}\n\n${JSON_INSTRUCTION}`
            : `${request.prompt}\n\n${JSON_INSTRUCTION}\n\nSchema:\n${JSON.stringify(jsonSchema)}`,
        },
      ];

      let costUsd = 0;
      const first = await call(
        model,
        messages,
        request,
        canNativeJson
          ? { type: "json_schema", name: options.name ?? "output", schema: jsonSchema }
          : undefined,
      );
      costUsd += first.costUsd;

      const parsed = parseWith(schema, first.text);
      if (parsed.success) return { ok: true, value: parsed.data, costUsd };

      if (options.repair === false) {
        return { ok: false, error: new Error(parsed.message), costUsd };
      }

      // 修复回路：把 zod 的报错原文喂回去。模型看到具体哪个字段错了，
      // 比看到"格式不对"有用得多。
      const repairPrompt = [
        "Your previous reply did not validate. Fix it and return the corrected JSON only.",
        "",
        `Validation error: ${parsed.message}`,
        "",
        "Your previous reply:",
        "```",
        first.text.slice(0, 6_000),
        "```",
      ].join("\n");

      const second = await call(
        model,
        [
          ...(systemParts.length > 0
            ? [{ role: "system" as const, content: systemParts.join("\n\n") }]
            : []),
          { role: "user" as const, content: request.prompt },
          { role: "assistant" as const, content: first.text.slice(0, 6_000) },
          { role: "user" as const, content: repairPrompt },
        ],
        { ...request, maxTokens: request.maxTokens },
      );
      costUsd += second.costUsd;

      const repaired = parseWith(schema, second.text);
      if (repaired.success) return { ok: true, value: repaired.data, costUsd };
      return { ok: false, error: new Error(repaired.message), costUsd };
    },
  };
}

function parseWith<T>(
  schema: z.ZodType<T>,
  text: string,
): { success: true; data: T } | { success: false; message: string } {
  for (const candidate of extractJsonCandidates(text)) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) return { success: true, data: parsed.data };
  }
  // 直接 parse 一次，拿 zod 的具体报错（candidates 为空也要有可用信息）
  const fallback = schema.safeParse(safeJson(text));
  if (fallback.success) return { success: true, data: fallback.data };
  const issue = fallback.error.issues[0];
  const where = issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : "";
  return {
    success: false,
    message: extractJsonCandidates(text).length > 0 ? `schema mismatch${where}` : `no JSON found in reply${where}`,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function schemaHint(schema: unknown): string {
  return `Output must be a single JSON object. Schema:\n${JSON.stringify(schema)}`;
}
