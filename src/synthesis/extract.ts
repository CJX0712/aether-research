/**
 * 逐源证据抽取。
 *
 * 三个决定成败的处理：
 *
 * 1. **先切块排序，再喂模型。** 整页正文动辄 5 万字，全塞进去既烧钱又稀释注意力
 *    —— 模型会在无关段落里"找到"它想找的东西。按与子问题的词元重叠排序，
 *    只取前 N 字符，命中率反而更高。
 *
 * 2. **模型给的每一条引文都必须过 verifyQuote。** 不通过就丢弃，并记录丢弃数。
 *    这个数字是本项目最重要的健康指标之一：它突然升高，说明模型或提示词出了问题。
 *
 * 3. **页面正文不进长期上下文。** 抽完证据，正文就丢了，只留 Ref 的 sha256 与开头片段。
 *    这样即使研究几十个来源，上下文也不会爆 —— 而且避免了"上下文里飘着一堆
 *    半记忆的原文"导致的串源污染。
 */

import { z } from "zod";

import { sha256Of } from "../fetch/normalize.js";
import type { Llm } from "../llm/model.js";
import type { Evidence, SiteKind, SubQuestion } from "../types.js";
import { splitSentences, tokenize, verifyQuote } from "./quote.js";

/** 单个页面喂给模型的字符上限。 */
export const PAGE_BUDGET_CHARS = 20_000;

export interface PageContent {
  readonly refId: string;
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly by: "readability" | "provider";
}

export interface ExtractOutcome {
  readonly evidence: readonly Evidence[];
  /** 模型给了但无法在原文中定位的引文数。 */
  readonly rejected: number;
  readonly costUsd: number;
  /** 该页被认为与子问题无关时置位；用于统计有效抓取率。 */
  readonly skipped: boolean;
}

const extractionSchema = z.object({
  relevant: z
    .boolean()
    .describe("该页面是否真的包含能回答子问题的原文证据。只有标题相关但正文无关时填 false。"),
  quotes: z
    .array(
      z.object({
        quote: z
          .string()
          .describe("从正文里**逐字**抄录的句子或段落。禁止改写、翻译、拼接、总结。"),
        point: z.string().describe("这条引文回答了子问题的哪一点。不超过 20 字。"),
      }),
    )
    .max(5)
    .describe("最多 5 条。宁可少而准，不要用泛泛的整段充数。"),
});

const EXTRACT_SYSTEM = `你是一个证据抽取器。你会拿到一个研究子问题和一份网页正文。

铁律：
1. quote 必须是正文里**逐字存在**的连续文本。改写、翻译、拼接不相邻的句子、
   把数字四舍五入、把"约 30%"写成"30%" —— 这些都是严重错误，会被机器校验拦截。
2. 只摘**直接回答子问题**的原文。背景介绍、导航、广告、免责声明一概不要。
3. 找不到就直接返回空数组。不要用"该文讨论了相关话题"这类空话凑数。
4. 每条引文控制在 1-3 句，能独立看懂，不要截半句。`;

export async function extractFromPage(
  llm: Llm,
  page: PageContent,
  subquestion: SubQuestion,
  signal?: AbortSignal,
): Promise<ExtractOutcome> {
  const body = selectRelevantChunks(page.text, subquestion.question, PAGE_BUDGET_CHARS);
  if (body.trim().length < 80) {
    return { evidence: [], rejected: 0, costUsd: 0, skipped: true };
  }

  const reply = await llm.json(
    extractionSchema,
    {
      system: EXTRACT_SYSTEM,
      prompt: [
        `子问题：${subquestion.question}`,
        `（为什么问：${subquestion.intent}）`,
        ``,
        `页面标题：${page.title}`,
        `页面 URL：${page.url}`,
        ``,
        `正文：`,
        `-----`,
        body,
        `-----`,
      ].join("\n"),
      temperature: 0,
      ...(signal ? { signal } : {}),
      label: "extract",
    },
    { name: "evidence_extraction" },
  );

  if (!reply.ok) return { evidence: [], rejected: 0, costUsd: reply.costUsd, skipped: true };
  if (!reply.value.relevant) {
    return { evidence: [], rejected: 0, costUsd: reply.costUsd, skipped: true };
  }

  const evidence: Evidence[] = [];
  let rejected = 0;

  for (const item of reply.value.quotes) {
    const verified = verifyQuote(page.text, item.quote);
    if (!verified) {
      rejected += 1;
      continue;
    }
    // 同一页内的同一句话只留一次：模型经常把一句拆成两条交回来
    if (evidence.some((existing) => existing.quote === verified.quote)) continue;

    evidence.push({
      id: evidenceId(page.refId, subquestion.id, verified.quote),
      refId: page.refId,
      subquestionId: subquestion.id,
      quote: verified.quote,
      ...(verified.locate ? { locate: verified.locate } : {}),
      by: page.by,
      confidence: verified.confidence,
    });
  }

  return { evidence, rejected, costUsd: reply.costUsd, skipped: false };
}

/* ── 切块与排序 ──────────────────────────────────────────────────── */

/**
 * 按句子切成块，用与子问题的词元重叠打分，取最相关的若干块直到用满预算。
 *
 * 无嵌入、无依赖：对"从一篇长文里找几段相关的"这个任务，
 * 词元重叠的性价比高于引一个向量模型。
 */
export function selectRelevantChunks(
  text: string,
  question: string,
  budgetChars: number,
): string {
  if (text.length <= budgetChars) return text;

  const questionTokens = tokenize(question);
  const sentences = splitSentences(text);
  if (sentences.length === 0) return text.slice(0, budgetChars);

  const CHUNK = 6;
  const chunks: { text: string; score: number; index: number }[] = [];
  for (let i = 0; i < sentences.length; i += CHUNK) {
    const slice = sentences.slice(i, i + CHUNK);
    const chunkText = slice.map((sentence) => sentence.text).join(" ");
    const tokens = tokenize(chunkText);
    let shared = 0;
    for (const token of questionTokens) if (tokens.has(token)) shared += 1;
    chunks.push({
      text: chunkText,
      score: questionTokens.size === 0 ? 0 : shared / questionTokens.size,
      index: i,
    });
  }

  const picked = [...chunks].sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen: typeof chunks = [];
  let used = 0;
  for (const chunk of picked) {
    if (used >= budgetChars) break;
    chosen.push(chunk);
    used += chunk.text.length;
  }

  // 按原文顺序还原 —— 乱序的正文会让模型误判上下文关系
  return chosen
    .sort((a, b) => a.index - b.index)
    .map((chunk) => chunk.text)
    .join("\n");
}

/* ── ID ──────────────────────────────────────────────────────────── */

/** 证据 ID 由内容派生：同一引文多次抽取得到同一 id，天然幂等。 */
export function evidenceId(refId: string, subquestionId: string, quote: string): string {
  return `ev_${sha256Of(`${refId}|${subquestionId}|${quote}`).slice(0, 16)}`;
}

/** 按站点性质给出可信度序位；冲突裁决时才用得上。 */
const SITE_RANK: Readonly<Record<SiteKind, number>> = {
  gov: 5,
  institution: 4,
  paper: 4,
  docs: 3,
  news: 2,
  other: 1,
  ugc: 0,
};

export function siteRank(kind: SiteKind): number {
  return SITE_RANK[kind];
}
