#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 三条使用上的取舍：
 *  - **进度走 stderr，报告走 stdout/文件。** 这样 `aether-research research -q ... > report.md`
 *    不会把进度日志混进正文。
 *  - **默认同时输出 Markdown + HTML + JSON。** 三个格式服务于三种完全不同的用途：
 *    Markdown 进笔记与 diff，HTML 给人读与归档，JSON 给下游程序与回归测试。
 *  - **`providers` 子命令先自检。** 最常见的失败是"没配 key 却以为配了"，
 *    与其让人等五分钟拿到一份空报告，不如一开始就说明白。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createDefaultRegistry } from "aetherflow";

import { research } from "../engine.js";
import { defaultProviders } from "../retrieval/registry.js";
import { renderHtml } from "../render/html.js";
import { renderMarkdown } from "../render/markdown.js";
import type { ResearchConfig, ResearchEvent, ResearchResult } from "../types.js";

const HELP = `aether-research —— 可审计的深度研究

用法:
  aether-research research -q "<问题>" [选项]
  aether-research providers

research 选项:
  -q, --question <text>     研究问题（必填）
  -m, --model <ref>         主模型，用于规划/裁决/综合        [默认 anthropic:claude-sonnet-4-20250514]
      --draft <ref>         便宜模型，用于逐源证据抽取        [默认同主模型]
      --max-sources <n>     最多抓取多少个来源                [默认 20]
      --max-cost <usd>      成本硬顶                          [默认不限]
      --timeout <seconds>   总时长上限                        [默认 900]
      --out <dir>           输出目录                          [默认 ./reports]
      --name <slug>         输出文件名                        [默认按问题生成]
      --format <list>       md,html,json,all                  [默认 all]
      --no-verify-links     跳过引用存活校验
      --quiet               不打印进度

环境变量（按需配置，未配置的检索源会被自动跳过）:
  ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY ...
  BRAVE_API_KEY          Brave Search（英文主力，$5/千次）
  BOCHA_API_KEY          博查 AI 搜索（中文主力）
  TAVILY_API_KEY         Tavily（自带正文，SPA 兜底）
  EXA_API_KEY            Exa（语义检索，默认关闭）
  SEARXNG_BASE_URL       自建 SearXNG 实例（零凭证兜底）
  RESEARCH_MAILTO        填了可进 OpenAlex/Crossref 的 polite pool

示例:
  aether-research research -q "2025 年超导量子比特最高两比特门保真度是多少" \\
    --draft deepseek:deepseek-chat --max-cost 1.5
`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "research";
  const rest = command === "research" ? argv : argv.slice(1);

  if (command === "help" || command === "-h" || command === "--help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "providers") return listProviders();

  let values: ReturnType<typeof parseArgs>["values"];
  try {
    values = parseArgs({
      args: rest,
      options: {
        question: { type: "string", short: "q" },
        model: { type: "string", short: "m" },
        draft: { type: "string" },
        "max-sources": { type: "string" },
        "max-cost": { type: "string" },
        timeout: { type: "string" },
        out: { type: "string" },
        name: { type: "string" },
        format: { type: "string" },
        "verify-links": { type: "boolean", default: true },
        quiet: { type: "boolean", default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (thrown) {
    process.stderr.write(`参数解析失败：${thrown instanceof Error ? thrown.message : String(thrown)}\n\n`);
    process.stdout.write(HELP);
    return 2;
  }

  const question = typeof values.question === "string" ? values.question.trim() : "";
  if (question.length === 0) {
    process.stderr.write("缺少 --question。\n\n");
    process.stdout.write(HELP);
    return 2;
  }

  const format = String(values.format ?? "all");
  const wantMd = format === "all" || format.includes("md");
  const wantHtml = format === "all" || format.includes("html");
  const wantJson = format === "all" || format.includes("json");
  const quiet = values.quiet === true;

  const config: ResearchConfig = {
    question,
    model: String(values.model ?? "anthropic:claude-sonnet-4-20250514"),
    ...(typeof values.draft === "string" ? { draftModel: values.draft } : {}),
    budget: {
      ...(typeof values["max-sources"] === "string"
        ? { maxSources: Number(values["max-sources"]), maxFetches: Number(values["max-sources"]) }
        : {}),
      ...(typeof values["max-cost"] === "string"
        ? { maxCostUsd: Number(values["max-cost"]) }
        : {}),
      ...(typeof values.timeout === "string"
        ? { maxDurationMs: Number(values.timeout) * 1000 }
        : {}),
    },
    verifyLinks: values["verify-links"] !== false,
  };

  const onEvent = quiet
    ? undefined
    : (event: ResearchEvent): void => {
        process.stderr.write(`${formatEvent(event)}\n`);
      };

  const result = await research(config, { ...(onEvent ? { onEvent } : {}) });

  const outDir = resolve(String(values.out ?? "./reports"));
  const name = String(values.name ?? slugify(question));
  mkdirSync(outDir, { recursive: true });

  const written: string[] = [];
  if (wantMd) {
    const path = join(outDir, `${name}.md`);
    writeFileSync(path, renderMarkdown(result).markdown, "utf8");
    written.push(path);
  }
  if (wantHtml) {
    const path = join(outDir, `${name}.html`);
    writeFileSync(path, renderHtml(result), "utf8");
    written.push(path);
  }
  if (wantJson) {
    const path = join(outDir, `${name}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2), "utf8");
    written.push(path);
  }

  process.stderr.write(`${summary(result)}\n`);
  for (const path of written) process.stderr.write(`  ${path}\n`);

  return result.finishReason === "error" ? 1 : 0;
}

function listProviders(): number {
  const providers = defaultProviders();
  const registry = createDefaultRegistry();
  const models = registry.listProviders();

  process.stdout.write("检索源：\n");
  for (const provider of providers) {
    const ready = provider.available();
    process.stdout.write(
      `  ${ready ? "可用" : "未配置"}  ${provider.id.padEnd(10)} ${provider.kind.padEnd(9)} ${provider.label}  $${provider.costPerQuery.toFixed(4)}/次\n`,
    );
  }
  process.stdout.write(`\n已注册的模型供应商：${models.join(", ") || "(无)"}\n`);
  process.stdout.write(
    `\n未配置的源会在运行时自动跳过，不影响其它源。配置方法见 \`aether-research help\` 的环境变量清单。\n`,
  );
  return 0;
}

function formatEvent(event: ResearchEvent): string {
  switch (event.type) {
    case "run_start":
      return `→ 开始研究：${event.question}`;
    case "plan_ready":
      return `[ok] 拆解为 ${event.plan.subquestions.length} 个子问题`;
    case "search_done":
      return `[ok] 检索完成，融合后 ${event.hits} 条命中`;
    case "fetch_start":
      return `  ↓ 抓取 ${event.url}`;
    case "fetch_end":
      return event.ok
        ? `  [ok] ${event.chars} 字符`
        : `  [fail] 抓取失败 ${event.url}`;
    case "evidence_added":
      return `[ok] 新增 ${event.count} 条逐字证据`;
    case "claim_added":
      return `[ok] 确证 ${event.count} 条声明`;
    case "contested":
      return `[warn] 冲突声明 ${event.claimId} ↔ ${event.against.join(", ")}`;
    case "section_done":
      return `[ok] 第 ${event.index} 节完成：${event.heading}`;
    case "usage":
      return `  用量：模型 $${event.usage.modelUsd.toFixed(4)} / 检索 $${event.usage.searchUsd.toFixed(4)}`;
    case "warning":
      return `[warn] ${event.message}`;
    case "run_end":
      return `→ 结束（${event.finishReason}）`;
    default:
      return "";
  }
}

function summary(result: ResearchResult): string {
  const audit = result.audit;
  return [
    ``,
    `报告：${result.report.sections.length} 节 · ${audit.claimsTotal} 条声明 · 引用 ${audit.refsUsed}/${audit.refsTotal} 个来源`,
    `无证据声明：${audit.claimsUnverified}（必须为 0） · 冲突声明：${audit.claimsContested} · 死链：${audit.deadLinks}`,
    `耗时 ${(result.durationMs / 1000).toFixed(1)}s · 模型 $${result.usage.modelUsd.toFixed(4)} · 检索 $${result.usage.searchUsd.toFixed(4)}`,
    result.error ? `错误：${result.error.message}` : `状态：${result.finishReason}`,
    ``,
    `输出：`,
  ].join("\n");
}

function slugify(text: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const stamp = new Date().toISOString().slice(0, 10);
  return ascii.length > 0 ? `${ascii}-${stamp}` : `research-${stamp}`;
}

main().then(
  (code) => process.exit(code),
  (thrown) => {
    process.stderr.write(`致命错误：${thrown instanceof Error ? thrown.message : String(thrown)}\n`);
    process.exit(1);
  },
);
