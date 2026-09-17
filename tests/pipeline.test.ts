/**
 * 端到端离线回归。
 *
 * 这是整个测试套件里最重要的一批：**完整流水线在零网络、零成本、完全确定的
 * 条件下跑通，并证明输出的每一条声明都挂着逐字可核验的证据。**
 *
 * 它同时是架构约束的执行者 —— 如果哪天有人把"允许无证据声明"当优化加进来，
 * 这里会立刻红，而不是等三个月后有人在真实报告里发现一条编造的引用。
 */

import { describe, expect, it } from "vitest";

import { research } from "../src/engine.js";
import { createFixtureProvider } from "../src/retrieval/providers/fixture.js";
import { renderHtml } from "../src/render/html.js";
import { renderMarkdown } from "../src/render/markdown.js";
import type { ResearchEvent } from "../src/types.js";
import { FIXTURE_DOCS, createHarness } from "./helpers/harness.js";

const QUESTION = "量子计算距离实用化还有多远";

async function run(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
  const events: ResearchEvent[] = [];
  const result = await research(
    {
      question: QUESTION,
      model: harness.model,
      budget: { maxSources: 6, maxFetches: 6, maxSubquestions: 3, maxQueriesPerSubquestion: 1 },
      verifyLinks: false,
      respectRobots: false,
    },
    {
      registry: harness.registry,
      providers: [createFixtureProvider([...FIXTURE_DOCS], { id: "fixture" })],
      onEvent: (event) => events.push(event),
    },
  );
  return { result, events };
}

describe("完整研究流水线（离线）", () => {
  it("跑通全流程并产出带引用的报告", async () => {
    const { result, events } = await run();

    expect(result.finishReason).toBe("completed");
    expect(result.plan.subquestions.length).toBeGreaterThan(0);
    expect(result.report.sections.length).toBeGreaterThan(0);
    expect(Object.keys(result.claims).length).toBeGreaterThan(0);
    expect(Object.keys(result.refs).length).toBeGreaterThan(0);

    // 事件流按阶段推进，可被 UI 与持久化消费
    const types = events.map((event) => event.type);
    expect(types).toContain("run_start");
    expect(types).toContain("plan_ready");
    expect(types).toContain("evidence_added");
    expect(types).toContain("claim_added");
    expect(types).toContain("run_end");
  });

  it("第一 KPI：不可验证声明数为 0", async () => {
    const { result } = await run();
    expect(result.audit.claimsUnverified).toBe(0);
    expect(result.audit.claimsTotal).toBeGreaterThan(0);

    for (const claim of Object.values(result.claims)) {
      expect(claim.evidenceIds.length).toBeGreaterThan(0);
      for (const evidenceId of claim.evidenceIds) {
        expect(result.evidence[evidenceId]).toBeDefined();
      }
    }
  });

  it("每条证据都是对应来源正文的逐字子串", async () => {
    const { result } = await run();
    const byUrl = new Map<string, string>([...FIXTURE_DOCS].map((doc) => [doc.url, doc.text]));

    for (const item of Object.values(result.evidence)) {
      const ref = result.refs[item.refId];
      expect(ref).toBeDefined();
      const source = byUrl.get(ref?.canonicalUrl ?? "");
      expect(source).toBeDefined();
      // 这是防幻觉机制的落点：不是"看起来像引文"，而是真的在原文里
      expect(source ?? "").toContain(item.quote);
    }
  });

  it("模型编造引文时，证据被丢弃且违规可查", async () => {
    const { result } = await run({ quoteMode: "fabricated" });

    expect(Object.keys(result.evidence).length).toBe(0);
    expect(result.audit.claimsTotal).toBe(0);
    expect(result.finishReason).toBe("insufficient_sources");
    expect(result.audit.warnings.some((line) => line.includes("逐字校验"))).toBe(true);
    expect(result.audit.warnings.some((line) => line.includes("未抽取到任何"))).toBe(true);
  });

  it("模型改写原文时，引文被吸附为原文句子而非保留改写", async () => {
    const { result } = await run({ quoteMode: "paraphrase" });
    const items = Object.values(result.evidence);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.confidence === "inferred")).toBe(true);
  });

  it("规划阶段模型失效时降级为启发式拆解，而不是报错退出", async () => {
    const { result } = await run({ breakStage: "plan" });

    expect(result.finishReason).toBe("completed");
    expect(result.plan.subquestions.length).toBeGreaterThan(0);
    expect(result.plan.interpretation).toContain("启发式");
    expect(result.audit.warnings.some((line) => line.includes("启发式"))).toBe(true);
  });

  it("大纲阶段失效时仍能覆盖全部子问题", async () => {
    const { result } = await run({ breakStage: "outline" });
    const covered = new Set(result.report.sections.flatMap((section) => section.subquestionIds));
    for (const subquestion of result.plan.subquestions) {
      expect(covered.has(subquestion.id)).toBe(true);
    }
  });

  it("章节正文缺失引用标记时会被记录为告警", async () => {
    const { result } = await run({ withMarkers: false });
    expect(result.audit.warnings.some((line) => line.includes("citation marker"))).toBe(true);
  });
});

describe("渲染", () => {
  it("Markdown 引用编号连续，且每个编号都能在来源列表中找到", async () => {
    const { result } = await run();
    const rendered = renderMarkdown(result);

    expect(rendered.citationOrder.length).toBeGreaterThan(0);
    expect(rendered.markdown).not.toContain("[claim:");

    for (let index = 0; index < rendered.citationOrder.length; index += 1) {
      const refId = rendered.citationOrder[index] as string;
      expect(rendered.numbers.get(refId)).toBe(index + 1);
      expect(rendered.markdown).toContain(`[${index + 1}]`);
      const url = result.refs[refId]?.canonicalUrl;
      expect(url).toBeDefined();
      expect(rendered.markdown).toContain(url ?? "###");
    }

    // 审计区必须把"无证据声明数"显式写出来，让人一眼能查
    expect(rendered.markdown).toContain("无证据声明");
    expect(rendered.markdown).toContain("质量审计");
  });

  it("HTML 为单文件、无外部依赖、无 emoji 图标", async () => {
    const { result } = await run();
    const html = renderHtml(result);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    expect(html).not.toContain("[claim:");
    expect(html).toContain('href="#ref-1"');
    // 外部资源会让它三年后变成一堆裸文本
    expect(html).not.toMatch(/<link[^>]+href="http/);
    expect(html).not.toMatch(/<script[^>]+src="http/);

    // P0：禁止 emoji 充当功能图标
    const emoji =
      /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1FA00}-\u{1FAFF}]/u;
    expect(html.match(emoji)).toBeNull();
    // 图标来自 Lucide SVG
    expect(html).toContain('stroke="currentColor"');
  });
});
