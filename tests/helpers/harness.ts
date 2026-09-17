/**
 * 离线测试夹具。
 *
 * 关键设计：**用 `metadata.label` 路由 mock 响应**，而不是用调用序号。
 * 用序号的 mock 一旦流水线多调一次模型（比如触发了解析修复回路），
 * 后面所有断言都会错位 —— 那种测试失败起来极其难查。
 * 按阶段标签路由，流水线怎么变都稳。
 */

import { ModelRegistry, createMockProvider, type ModelRequest, type MockResponse } from "aetherflow";

import type { SearchProvider } from "../../src/retrieval/types.js";

export type QuoteMode = "verbatim" | "fabricated" | "paraphrase";

export interface HarnessOptions {
  /** 抽取阶段返回什么质量的引文。 */
  readonly quoteMode?: QuoteMode;
  /** 强制让某个阶段返回不可解析的内容，用于验证降级。 */
  readonly breakStage?: "plan" | "extract" | "claims" | "outline" | "compose" | "verify";
  /** compose 阶段是否在正文里带上引用标记。 */
  readonly withMarkers?: boolean;
}

export interface Harness {
  readonly registry: ModelRegistry;
  readonly model: string;
  /** 收到的请求，按调用顺序。 */
  readonly calls: readonly ModelRequest[];
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const provider = createMockProvider({
    fallback: (request) => route(request, options),
  });
  const registry = new ModelRegistry();
  registry.register("mock", provider);
  return { registry, model: "mock:research", calls: provider.calls };
}

function route(request: ModelRequest, options: HarnessOptions): MockResponse {
  const label = request.metadata?.label ?? "";
  if (options.breakStage && label === options.breakStage) {
    return { text: "抱歉，我无法完成这个任务。" };
  }

  switch (label) {
    case "plan":
      return { text: planReply(promptOf(request)) };
    case "extract":
      return { text: extractReply(promptOf(request), options.quoteMode ?? "verbatim") };
    case "claims":
      return { text: claimsReply(promptOf(request)) };
    case "verify":
      return { text: JSON.stringify({ conflicts: [], weak: [] }) };
    case "outline":
      return { text: outlineReply(promptOf(request)) };
    case "compose":
      return { text: composeReply(promptOf(request), options.withMarkers !== false) };
    default:
      return { text: "{}" };
  }
}

function promptOf(request: ModelRequest): string {
  const last = request.messages[request.messages.length - 1];
  if (!last) return "";
  return typeof last.content === "string" ? last.content : "";
}

/* ── 各阶段的 mock 回复 ──────────────────────────────────────────── */

function planReply(prompt: string): string {
  const question = prompt.split("\n")[0]?.replace(/^研究问题：/, "") ?? "测试问题";
  return JSON.stringify({
    interpretation: `将「${question}」拆为三条可检索的子问题：事实基线、量化数据、争议与不确定性。`,
    subquestions: [
      { id: "sq1", question: `${question} —— 目前公认的事实基线是什么`, intent: "建立事实基线", prefer: ["academic", "web"] },
      { id: "sq2", question: `${question} —— 有哪些可核查的量化数据`, intent: "取得量化证据", prefer: ["web"] },
      { id: "sq3", question: `${question} —— 存在哪些争议与不确定性`, intent: "找出争议", prefer: ["web"] },
    ],
    outOfScope: ["不评估商业产品的性价比"],
    queries: [
      { subquestionId: "sq1", text: `${question} 定义 现状` },
      { subquestionId: "sq2", text: `${question} 数据 统计` },
      { subquestionId: "sq3", text: `${question} 争议 局限` },
    ],
  });
}

/**
 * 抽取阶段：从喂给模型的正文里**真去切两句话**作为引文。
 * 这样"逐字校验通过"是被真实逻辑验证的，不是硬编码的假数据。
 */
function extractReply(prompt: string, mode: QuoteMode): string {
  const body = prompt.split("-----")[1] ?? "";
  const sentences = body
    .split(/(?<=[。！？.!?])\s+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);

  const first = sentences[0] ?? "";
  const quote =
    mode === "fabricated"
      ? "这句话在原文里根本不存在，是模型自己编出来的所谓引文。"
      : mode === "paraphrase"
        ? `${first.slice(0, Math.max(6, Math.floor(first.length * 0.6)))}而且据说情况还在持续恶化并可能超出预期`
        : first;

  return JSON.stringify({
    relevant: true,
    quotes: quote ? [{ quote, point: "回答子问题" }] : [],
  });
}

function claimsReply(prompt: string): string {
  const ids = [...new Set([...prompt.matchAll(/\[(ev_[a-f0-9]+)\]/g)].map((match) => match[1]))];
  if (ids.length === 0) {
    return JSON.stringify({ claims: [], gaps: ["无证据"] });
  }
  return JSON.stringify({
    claims: [
      {
        statement: "测试声明：来自可核验来源的一条事实陈述。",
        evidenceIds: ids.slice(0, 2),
        note: "",
      },
    ],
    gaps: [],
  });
}

function outlineReply(prompt: string): string {
  const ids = [...new Set([...prompt.matchAll(/^- (sq\w+):/gm)].map((match) => match[1]))];
  const sections = ids.map((id, index) => ({
    id: `s${index + 1}`,
    heading: `第 ${index + 1} 部分：${id} 的结论`,
    subquestionIds: [id],
    intent: `回答 ${id}`,
  }));
  return JSON.stringify({ sections: sections.length > 0 ? sections : [] });
}

function composeReply(prompt: string, withMarkers: boolean): string {
  const ids = [...new Set([...prompt.matchAll(/\[claim:([A-Za-z0-9_-]+)\]/g)].map((match) => match[1]))];
  const marker = withMarkers && ids.length > 0 ? `[claim:${ids[0]}]` : "";
  return JSON.stringify({
    body:
      `这是测试正文，用于验证渲染管线能否正确解析引用标记。相关结论如下${marker}。` +
      `\n\n另起一段说明该结论的适用范围与限制条件：上述判断基于公开可核查的实验数据与产业统计口径，` +
      `不同来源在时间点与样本范围上存在差异，读者在引用时应当注意这些限定条件。`,
  });
}

/* ── 检索夹具 ────────────────────────────────────────────────────── */

/**
 * 固定语料。URL 用 127.0.0.1:9（discard 端口），
 * 抓取必然立刻失败，从而走"检索器自带正文兜底"这条路径 ——
 * 既零网络，又顺带把兜底逻辑测了。
 */
export const FIXTURE_DOCS = [
  {
    url: "http://127.0.0.1:9/paper-a",
    title: "量子纠错阈值的最新实验进展",
    text:
      "2024 年，谷歌的 Willow 处理器在距离为 7 的表面码上实现了低于阈值的错误率。" +
      "实验测得每轮纠错的逻辑错误率为 0.0014，相比距离为 5 时下降了约两倍。" +
      "该结果说明增加码距确实能够指数级抑制逻辑错误，是迈向容错量子计算的关键一步。" +
      "研究团队同时指出，从距离为 7 扩展到距离为 25 仍需要解决布线与制冷的工程瓶颈。" +
      "论文给出的判断是，实用规模的纠错码至少需要十万量级的物理比特。",
    publishedAt: "2024-12-10",
    siteKind: "paper" as const,
  },
  {
    url: "http://127.0.0.2:9/report-b",
    title: "产业界量子计算路线图综述",
    text:
      "多数厂商将容错量子计算机的商用时点预期放在 2030 年至 2035 年之间。" +
      "也有观点认为，受制于布线与制冷的工程瓶颈，这一时点可能进一步推迟到 2040 年前后。" +
      "统计数据显示，2025 年该领域的风险投资额出现了明显的回落，同比下降约三成。" +
      "多家初创公司转向在经典硬件上做量子算法的仿真，以等待硬件成熟。",
    publishedAt: "2025-03-02",
    siteKind: "news" as const,
  },
  {
    url: "http://127.0.0.3:9/critique-c",
    title: "对量子计算商业化预期的批评",
    text:
      "关于实用化时点的争议持续存在，批评者指出已公开的量子优势实验大多针对缺乏实用价值的采样任务构造。" +
      "在分解、搜索等实际有用的问题上，量子算法目前并未展示出对经典方法的压倒性优势。" +
      "因此，把演示实验等同于可用算力是一种误导，媒体在报道时普遍放大了结论。" +
      "该文建议以「逻辑比特数量乘以门保真度」作为更诚实的进度指标。",
    publishedAt: "2025-05-18",
    siteKind: "other" as const,
  },
] as const;

export async function fixtureProviders(): Promise<readonly SearchProvider[]> {
  const { createFixtureProvider } = await import("../../src/retrieval/providers/fixture.js");
  return [createFixtureProvider([...FIXTURE_DOCS], { id: "fixture" })];
}
