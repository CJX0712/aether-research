/**
 * 大纲锚定 + 分段生成。
 *
 * 为什么不让模型一口气写完整个报告：长文本生成有三个可复现的塌陷，
 * 而且都是"看起来没问题"的那种：
 *
 *  1. **水肿**：后半段开始用同义反复凑字数，信息密度断崖式下跌。
 *  2. **结构塌陷**：写着写着回到自己熟悉的模板，前面定下的大纲被架空。
 *  3. **引用漂移**：越往后，模型越倾向于引用"前面提到过的来源"，
 *     而不是真正支撑当前论断的来源 —— 引用看起来密集，实际是错的。
 *
 * 对策：先锁大纲（每节绑定具体子问题），再逐节生成，
 * 每节**只注入该节相关的声明与证据**。看不见的东西就引用不到，
 * 这从结构上消灭了引用漂移。
 */

import { z } from "zod";

import type { Llm } from "../llm/model.js";
import type {
  Claim,
  Evidence,
  Ref,
  ResearchPlan,
  ReportSection,
  SubQuestion,
} from "../types.js";
import { renderEvidence } from "./claims.js";

export interface DraftSection {
  readonly id: string;
  readonly heading: string;
  readonly subquestionIds: readonly string[];
  readonly intent: string;
}

export const outlineSchema = z.object({
  sections: z
    .array(
      z.object({
        id: z.string().min(1).describe("短标识符，如 s1、s2。"),
        heading: z.string().min(2).describe("小节标题。要具体，不要用「概述」这类空词。"),
        subquestionIds: z
          .array(z.string())
          .min(1)
          .describe("本节要回答的子问题 id。只能使用给定的 id。"),
        intent: z.string().describe("本节要达成什么；读者读完应知道什么。"),
      }),
    )
    .min(2)
    .max(10)
    .describe("按读者理解的自然顺序排列：先建立事实基线，再展开争议与不确定性。"),
});

const OUTLINE_SYSTEM = `你是一份研究报告的编辑。你会拿到研究问题、子问题清单，以及每个子问题下已确证的声明数量。

要求：
1. 把子问题组合成 3-8 个章节。可以按主题合并，也可以拆分，但每个子问题必须被覆盖。
2. 顺序要服务于读者理解：先"是什么/有多少"，再"争议与分歧"，最后"不确定性与风险"。
3. 标题要具体到能让人判断内容，不要用"背景""概述""总结"这类空词。
4. 声明数为 0 的子问题也要安排进章节 —— 报告必须显式交代"这块没查到"，
   而不是装作它不存在。`;

export async function buildOutline(
  llm: Llm,
  plan: ResearchPlan,
  claimCounts: ReadonlyMap<string, number>,
  signal?: AbortSignal,
): Promise<{ sections: readonly DraftSection[]; costUsd: number; byModel: boolean }> {
  const inventory = plan.subquestions
    .map((item) => `- ${item.id}: ${item.question}（已确证声明 ${claimCounts.get(item.id) ?? 0} 条）`)
    .join("\n");

  const reply = await llm.json(
    outlineSchema,
    {
      system: OUTLINE_SYSTEM,
      prompt: [
        `研究问题：${plan.question}`,
        `研究口径：${plan.interpretation}`,
        plan.outOfScope.length > 0 ? `排除范围：${plan.outOfScope.join("；")}` : "",
        ``,
        `子问题清单：`,
        inventory,
      ]
        .filter((line) => line !== undefined)
        .join("\n"),
      temperature: 0.3,
      ...(signal ? { signal } : {}),
      label: "outline",
    },
    { name: "report_outline" },
  );

  if (!reply.ok) {
    return { sections: fallbackOutline(plan.subquestions), costUsd: reply.costUsd, byModel: false };
  }

  return {
    sections: enforceCoverage(reply.value.sections, plan.subquestions),
    costUsd: reply.costUsd,
    byModel: true,
  };
}

/* ── 逐节生成 ────────────────────────────────────────────────────── */

const SECTION_SYSTEM = `你在写一份研究报告的其中一个小节。你会拿到本节要回答的子问题，以及**该节可用的声明与逐字证据**。

铁律：
1. 每写一句事实性陈述，立刻用 [claim:声明ID] 标注。一个句子可以引多条声明。
   引用标记要放在它所支撑的陈述句末尾。
2. **只能使用本节给出的声明 ID。** 不许引用你没见过的 ID，不许凭自己知识补充事实。
3. 如果某个子问题没有足够证据，就明写"现有来源不足以回答 X"，并说明缺什么。
   这比用流畅的套话盖过去有价值得多。
4. 存在冲突的声明（标注为 contested）要**并列呈现两边**，不要挑一边说完就走。
5. 不要写"综上所述"式的总结段，不要写建议，不要展望。本节只交付事实。
6. 用中文写作（除非研究问题本身是英文）。密度优先，不要注水。`;

export interface ComposeResult {
  readonly section: ReportSection;
  readonly costUsd: number;
  /** 生成后校验发现的问题（缺少引用的段落数等）。 */
  readonly warnings: readonly string[];
}

const sectionSchema = z.object({
  body: z
    .string()
    .min(1)
    .describe("小节正文，Markdown。事实陈述后紧跟 [claim:ID] 标记。"),
});

export async function composeSection(
  llm: Llm,
  draft: DraftSection,
  claims: readonly Claim[],
  evidence: ReadonlyMap<string, Evidence>,
  refs: ReadonlyMap<string, Ref>,
  subquestions: readonly SubQuestion[],
  signal?: AbortSignal,
): Promise<ComposeResult> {
  const warnings: string[] = [];

  if (claims.length === 0) {
    const questions = subquestions
      .filter((item) => draft.subquestionIds.includes(item.id))
      .map((item) => item.question);
    return {
      section: {
        id: draft.id,
        heading: draft.heading,
        subquestionIds: draft.subquestionIds,
        claimIds: [],
        body: [
          `> 本节未获得可核查的证据。`,
          ``,
          `现有检索没有找到能回答以下问题的、可逐字核验的来源：`,
          ...questions.map((question) => `- ${question}`),
          ``,
          `这属于**未回答**而非"答案是否定的"。请勿据此推断该方向没有结论。`,
        ].join("\n"),
      },
      costUsd: 0,
      warnings: [`section ${draft.id}: no claims available`],
    };
  }

  const evidenceList: Evidence[] = [];
  for (const claim of claims) {
    for (const id of claim.evidenceIds) {
      const item = evidence.get(id);
      if (item) evidenceList.push(item);
    }
  }

  const prompt = [
    `本节标题：${draft.heading}`,
    `本节要达成：${draft.intent}`,
    ``,
    `本节要回答的子问题：`,
    ...subquestions
      .filter((item) => draft.subquestionIds.includes(item.id))
      .map((item) => `- ${item.question}（${item.intent}）`),
    ``,
    `可用声明（写正文时必须用 [claim:声明ID] 引用）：`,
    renderClaims(claims),
    ``,
    `声明背后的逐字证据：`,
    renderEvidence(evidenceList, refs),
    ``,
    `现在写这一节。篇幅 300-600 字，密度优先。`,
  ].join("\n");

  const reply = await llm.json(
    sectionSchema,
    {
      system: SECTION_SYSTEM,
      prompt,
      temperature: 0.4,
      ...(signal ? { signal } : {}),
      label: "compose",
    },
    { name: "section_body" },
  );

  if (!reply.ok) {
    return {
      section: {
        id: draft.id,
        heading: draft.heading,
        subquestionIds: draft.subquestionIds,
        claimIds: claims.map((claim) => claim.id),
        body: renderClaimsFallback(claims),
      },
      costUsd: reply.costUsd,
      warnings: [`section ${draft.id}: generation failed, fell back to claim listing`],
    };
  }

  const known = new Set(claims.map((claim) => claim.id));
  const { text, used } = normalizeMarkers(reply.value.body, known);
  if (used.length === 0) {
    warnings.push(`section ${draft.id}: no claim markers survived validation`);
  }
  const missing = countUncitedParagraphs(text);
  if (missing > 0) {
    warnings.push(`section ${draft.id}: ${missing} paragraph(s) without any citation marker`);
  }

  return {
    section: {
      id: draft.id,
      heading: draft.heading,
      subquestionIds: draft.subquestionIds,
      claimIds: used,
      body: text,
    },
    costUsd: reply.costUsd,
    warnings,
  };
}

/* ── 校验与清洗 ──────────────────────────────────────────────────── */

/**
 * 清洗正文中模型编造的引用标记。
 * 这一步必须有：报告里出现一个指向不存在声明的 `[claim:xxx]`，
 * 渲染出来就是一个空引用 —— 比没有引用更糟，因为它看起来像有出处。
 */
export function normalizeMarkers(
  body: string,
  known: ReadonlySet<string>,
): { text: string; used: string[] } {
  const used: string[] = [];
  const text = body.replace(/\[claim:([A-Za-z0-9_-]+)\]/g, (match, id: string) => {
    if (!known.has(id)) return "";
    if (!used.includes(id)) used.push(id);
    return match;
  });
  return { text: text.replace(/ {2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim(), used };
}

/**
 * 没有任何引用标记的正文段落数。用启发式发现"整段没出处"的情况。
 *
 * 阈值取 60 而非 120：一段中文 60 字已经是一句完整的论断，
 * 按英文习惯设 120 会让中文段落几乎永远逃过检查。
 */
export const UNCITED_PARAGRAPH_MIN_CHARS = 60;

export function countUncitedParagraphs(body: string): number {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > UNCITED_PARAGRAPH_MIN_CHARS)
    .filter((paragraph) => !paragraph.startsWith(">") && !paragraph.startsWith("#"))
    .filter((paragraph) => !paragraph.startsWith("-") && !paragraph.startsWith("|"))
    .filter((paragraph) => !/\[claim:/.test(paragraph)).length;
}

/* ── 降级 ────────────────────────────────────────────────────────── */

/** 每个子问题一节。平淡但不会漏内容 —— 大纲生成的兜底就该这样。 */
export function fallbackOutline(subquestions: readonly SubQuestion[]): DraftSection[] {
  return subquestions.map((item, index) => ({
    id: `s${index + 1}`,
    heading: item.question.length > 40 ? `${item.question.slice(0, 39)}…` : item.question,
    subquestionIds: [item.id],
    intent: item.intent,
  }));
}

/**
 * 强制覆盖所有子问题。
 * 模型偶尔会漏掉一两个子问题（通常是声明数为 0 的那些，
 * 而那恰恰是最该在报告里交代的部分）。
 */
export function enforceCoverage(
  sections: readonly DraftSection[],
  subquestions: readonly SubQuestion[],
): DraftSection[] {
  const validIds = new Set(subquestions.map((item) => item.id));
  const cleaned = sections
    .map((section, index) => ({
      ...section,
      id: section.id.trim() || `s${index + 1}`,
      subquestionIds: [...new Set(section.subquestionIds.filter((id) => validIds.has(id)))],
    }))
    .filter((section) => section.subquestionIds.length > 0 || sections.length === 1);

  const covered = new Set(cleaned.flatMap((section) => section.subquestionIds));
  const orphans = subquestions.filter((item) => !covered.has(item.id));

  return [
    ...cleaned,
    ...orphans.map((item, index) => ({
      id: `s${cleaned.length + index + 1}`,
      heading: item.question.length > 40 ? `${item.question.slice(0, 39)}…` : item.question,
      subquestionIds: [item.id],
      intent: item.intent,
    })),
  ];
}

/* ── 渲染辅助 ────────────────────────────────────────────────────── */

function renderClaims(claims: readonly Claim[]): string {
  return claims
    .map((claim) => {
      const flags = [
        claim.support === "contested" ? "**存在冲突**" : "",
        claim.support === "unverified" ? "证据不足" : "",
        claim.evidenceIds.length > 1 ? `${claim.evidenceIds.length} 个来源` : "",
      ]
        .filter(Boolean)
        .join(" / ");
      const note = claim.note ? `\n     备注：${claim.note}` : "";
      return `- [claim:${claim.id}]${flags ? ` (${flags})` : ""} ${claim.statement}${note}`;
    })
    .join("\n");
}

/** 生成彻底失败时的兜底正文：把声明原样列出。宁可丑，不可空。 */
function renderClaimsFallback(claims: readonly Claim[]): string {
  return [
    `> 本节正文生成失败，以下为已确证的原始声明：`,
    ``,
    ...claims.map((claim) => `- [claim:${claim.id}] ${claim.statement}`),
  ].join("\n");
}
