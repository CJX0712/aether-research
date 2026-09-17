/**
 * 问题拆解。
 *
 * 拆解质量决定报告质量的上限 —— 子问题问歪了，后面检索再全也是在错误方向上堆料。
 *
 * 两个刻意的设计：
 *
 * 1. **必须有 interpretation。** 让模型先复述它对问题的理解，
 *    用户（和下游）才有机会在报告开头就发现"这不是我想问的"，
 *    而不是读完全文才发现。
 *
 * 2. **必须有 outOfScope。** 研究任务天然会越写越宽，
 *    写成显式的排除项，比在每个阶段口头提醒"别跑偏"有效得多。
 *
 * 3. **模型不可用或输出不合规时降级到启发式拆解，绝不失败。**
 *    一次糟糕的研究体验是"报错退出"，那等于什么都没给用户。
 */

import { z } from "zod";

import type { Llm } from "../llm/model.js";
import type { ResearchPlan, SubQuestion } from "../types.js";

export const preferSchema = z.enum(["academic", "web", "zh", "official"]);

export const subQuestionSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("短标识符，如 sq1、sq2。全计划内唯一。"),
  question: z.string().min(4).describe("一个可被检索回答的具体问题，不要是泛泛的主题词。"),
  intent: z.string().min(1).describe("为什么问这个；它回答了主问题的哪一部分。"),
  prefer: z
    .array(preferSchema)
    .describe("期望从哪类来源找答案。official 表示官方文档/一手来源。"),
});

export const planSchema = z.object({
  interpretation: z
    .string()
    .min(1)
    .describe("对原始问题的理解复述，包括你对范围与口径的假设。"),
  subquestions: z
    .array(subQuestionSchema)
    .min(2)
    .max(8)
    .describe("覆盖该问题所需的子问题。彼此不重叠，合起来能回答主问题。"),
  outOfScope: z
    .array(z.string())
    .describe("明确不研究的内容，以及为什么。防止报告越写越宽。"),
  queries: z
    .array(
      z.object({
        subquestionId: z.string(),
        text: z.string().min(2),
      }),
    )
    .describe(
      "每个子问题 2-4 条检索查询。要包含不同写法：关键词式、自然语言式、" +
        "限定来源式（如 arXiv、官方文档）、以及必要的中英文双语版本。",
    ),
});

export type PlanDraft = z.infer<typeof planSchema>;

export interface PlanResult {
  readonly plan: ResearchPlan;
  /** 每个子问题对应的检索查询。与 plan 分开给，因为 plan 里不该混进执行细节。 */
  readonly queries: ReadonlyMap<string, readonly string[]>;
  readonly byModel: boolean;
  readonly costUsd: number;
}

export async function planResearch(
  llm: Llm,
  question: string,
  options: { readonly maxSubquestions?: number; readonly signal?: AbortSignal } = {},
): Promise<PlanResult> {
  const max = clamp(options.maxSubquestions ?? 6, 2, 8);

  const reply = await llm.json(planSchema, {
    system: PLANNER_SYSTEM,
    prompt: [
      `研究问题：${question}`,
      ``,
      `拆出 ${max} 个以内的子问题，并为每个子问题给出 2-4 条检索查询。`,
      `注意：检索查询要能直接拿去搜，不要写成"XX 的现状分析"这种报告目录式短语。`,
    ].join("\n"),
    temperature: 0.2,
    ...(options.signal ? { signal: options.signal } : {}),
    label: "plan",
  }, { name: "research_plan" });

  if (!reply.ok) return { ...fallbackPlan(question, max), byModel: false, costUsd: reply.costUsd };

  const draft = normalizePlan(reply.value, question, max);
  return {
    plan: {
      question,
      interpretation: draft.interpretation,
      subquestions: draft.subquestions,
      outOfScope: draft.outOfScope,
    },
    queries: groupQueries(draft, draft.subquestions),
    byModel: true,
    costUsd: reply.costUsd,
  };
}

const PLANNER_SYSTEM = `你是一个研究规划器。你的任务是把一个研究问题拆成可检索、可验证的子问题。

硬性要求：
1. 子问题必须是**能靠检索原文回答**的具体问题，不是论文目录里的章节标题。
   反例："量子计算的行业现状"；正例："2025 年超导量子比特的最高保真度公开记录是多少"。
2. 子问题之间不重叠，且合起来足以回答主问题。宁可少而准，不要多而虚。
3. 涉及数字、时间、排名的主张，单独成一条子问题 —— 这类主张最需要原始出处。
4. 主动思考"反面证据在哪"，必要时单列一条子问题去找反例或争议。
5. 检索查询要给出多种写法，并显式考虑中英文双语。中文议题不要只给英文查询。
6. 不要为了显得周全而加入与主问题无关的背景调研。`;

/* ── 降级路径 ────────────────────────────────────────────────────── */

/**
 * 启发式拆解。
 *
 * 这五个角度不是随便凑的：任何一个实证性问题，答出来的报告基本都需要
 * 「是什么 / 有多少 / 谁反对 / 最近变了什么 / 还不确定什么」这五块。
 * 缺任何一块，报告都会有结构性的盲区 —— 尤其是第四块（争议），
 * 恰好是大多数自动研究报告最先省掉的部分。
 */
const FALLBACK_ANGLES: readonly { readonly intent: string; readonly suffix: string }[] = [
  { intent: "界定概念与当前公认的事实基线", suffix: "是什么 定义 现状" },
  { intent: "拿到可核查的量化证据", suffix: "数据 统计 规模 增长率" },
  { intent: "找出争议、反例与对立观点", suffix: "争议 批评 局限 反面证据" },
  { intent: "确认最新进展，避免引用过时结论", suffix: "2025 最新进展 突破" },
  { intent: "明确已知的不确定性与风险", suffix: "风险 不确定性 未解决问题" },
];

export function fallbackPlan(question: string, max: number): Omit<PlanResult, "byModel" | "costUsd"> {
  const subquestions: SubQuestion[] = FALLBACK_ANGLES.slice(0, clamp(max, 2, 8)).map(
    (angle, index) => ({
      id: `sq${index + 1}`,
      question: `${question} —— ${angle.intent}`,
      intent: angle.intent,
    }),
  );

  const queries = new Map<string, readonly string[]>(
    subquestions.map((subquestion, index) => [
      subquestion.id,
      [`${question} ${FALLBACK_ANGLES[index]?.suffix ?? ""}`.trim(), question],
    ]),
  );

  return {
    plan: {
      question,
      interpretation: `（模型拆解不可用，以下为启发式拆解，按通用研究框架展开：概念基线 / 量化证据 / 争议反例 / 最新进展 / 不确定性。请据 interpretation 判断是否需要人工调整方向。）`,
      subquestions,
      outOfScope: [],
    },
    queries,
  };
}

/* ── 归一化 ──────────────────────────────────────────────────────── */

function normalizePlan(draft: PlanDraft, question: string, max: number): PlanDraft {
  const seen = new Set<string>();
  const subquestions = draft.subquestions.slice(0, max).map((item, index) => {
    let id = item.id.trim() || `sq${index + 1}`;
    if (seen.has(id)) id = `sq${index + 1}`;
    seen.add(id);
    return { ...item, id };
  });

  const validIds = new Set(subquestions.map((item) => item.id));

  return {
    interpretation: draft.interpretation.trim() || question,
    subquestions,
    outOfScope: draft.outOfScope.filter((item) => item.trim().length > 0),
    // 指向不存在子问题的查询直接丢：留着只会污染检索预算
    queries: draft.queries.filter((item) => validIds.has(item.subquestionId)),
  };
}

function groupQueries(
  draft: PlanDraft,
  subquestions: readonly SubQuestion[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const subquestion of subquestions) grouped.set(subquestion.id, []);

  for (const query of draft.queries) {
    const text = query.text.trim();
    if (text.length < 2) continue;
    const bucket = grouped.get(query.subquestionId);
    if (!bucket) continue;
    if (!bucket.includes(text)) bucket.push(text);
  }

  // 一个子问题一条查询都没有是致命的：那个方向就完全没被检索过
  for (const subquestion of subquestions) {
    const bucket = grouped.get(subquestion.id);
    if (!bucket || bucket.length === 0) {
      grouped.set(subquestion.id, [subquestion.question]);
    }
  }

  return grouped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
