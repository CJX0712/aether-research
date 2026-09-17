/**
 * 评测集（离线、可复现、非循环）。
 *
 * 这是 README 路线图的第一条。它要解决的问题是：
 * 大多数 deep research 工具**没有任何质量度量**，只能靠"读起来很对"。
 * 这里用固定语料 + 脚本化模型，把防幻觉主线上该被守住的指标**量出来**。
 *
 * 为什么是这些指标、为什么非循环：
 *  - 模型是脚本化的，所以"召回率"无法诚实测量（那会循环）。
 *  - 但"最终入库的引文是否 100% 逐字来自原文"可以测 —— 而且这是真测量：
 *    我们故意让模型给编造的引文，再看 Ledger 里最终落下的引文。
 *  - 「注入 N 条幻觉，捕获多少」同样真测量：mock 故意给 fabricated / paraphrase。
 *
 * 运行：npm run eval
 */

import { describe, expect, it } from "vitest";

import { research } from "../src/engine.js";
import { createFixtureProvider } from "../src/retrieval/providers/fixture.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { createHarness, FIXTURE_DOCS } from "../tests/helpers/harness.js";

const QUESTION = "量子计算距离实用化还有多远";

async function run(options: Parameters<typeof createHarness>[0] = {}) {
  const harness = createHarness(options);
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
    },
  );
  return result;
}

/**
 * 逐字保真率：最终入库的每一条证据，都必须能在其来源正文中逐字找到。
 * 这里用夹具语料原文做端到端核对 —— 不是循环断言，因为模型是脚本化的，
 * 我们故意喂编造引文，看它能否落到 Ledger 里。
 *
 * 比较时忽略空白：逐字校验保证的是"字符级逐字"，而吸附阶段会把句间空白归一化
 * （中文句子间补空格），原文无空格，所以按"去空白后是否为子串"判定。
 */
const CORPUS = FIXTURE_DOCS.map((doc) => doc.text).join("\n");
const FLAT_CORPUS = CORPUS.replace(/\s+/g, "");
const flat = (s: string): string => s.replace(/\s+/g, "");

function verbatimRate(result: Awaited<ReturnType<typeof run>>): {
  readonly rate: number;
  readonly total: number;
} {
  let total = 0;
  let ok = 0;
  for (const evidence of Object.values(result.evidence)) {
    total += 1;
    // 直接命中必然是子串；吸附（inferred）也逐字来自原文，同样应是子串
    if (evidence.quote.length >= 8 && FLAT_CORPUS.includes(flat(evidence.quote))) ok += 1;
  }
  return { rate: total === 0 ? 0 : ok / total, total };
}

describe("评测集 — 防幻觉主线指标", () => {
  it("逐字保真率：最终入库的引文 100% 经过校验", async () => {
    const result = await run();
    const { rate, total } = verbatimRate(result);
    expect(total).toBeGreaterThan(0);
    expect(rate).toBe(1);
  });

  it("幻觉捕获率：注入编造引文时一条都不入库，改写引文被吸附为原文句", async () => {
    // fabricated：模型全程给原文里不存在的引文 → 应当一条证据都进不来
    const fabricated = await run({ quoteMode: "fabricated" });
    expect(fabricated.audit.claimsUnverified).toBe(0);
    expect(Object.keys(fabricated.evidence).length).toBe(0);
    expect(fabricated.audit.claimsTotal).toBe(0); // 不编造声明，宁可产出空报告

    // paraphrase：模型给"改写过的引文" → 必须被吸附成原文句子（inferred 仍逐字）
    const paraphrased = await run({ quoteMode: "paraphrase" });
    expect(paraphrased.audit.claimsUnverified).toBe(0);
    expect(paraphrased.audit.claimsTotal).toBeGreaterThan(0);
    for (const evidence of Object.values(paraphrased.evidence)) {
      expect(["direct", "inferred"]).toContain(evidence.confidence);
      expect(evidence.quote.length).toBeGreaterThanOrEqual(8);
      expect(FLAT_CORPUS.includes(flat(evidence.quote))).toBe(true); // 逐字来自原文
    }
  });

  it("第一 KPI：不可验证声明数必须为 0", async () => {
    const result = await run();
    expect(result.audit.claimsUnverified).toBe(0);
    expect(result.audit.claimsTotal).toBeGreaterThan(0);
    // 死链数：离线夹具，未被校验，应当为 0
    expect(result.audit.deadLinks).toBe(0);
  });

  it("子问题覆盖率：大纲覆盖全部子问题", async () => {
    const result = await run();
    const planned = new Set(result.plan.subquestions.map((sq) => sq.id));
    const covered = new Set<string>();
    for (const section of result.report.sections) {
      for (const id of section.subquestionIds) covered.add(id);
    }
    // 每个规划子问题至少有一个对应节（覆盖不足会被 enforceCoverage 补成独立节）
    for (const id of planned) expect(covered.has(id)).toBe(true);
  });

  it("降级可用性：模型在任意阶段失效都不崩溃，且绝不产出无证据声明", async () => {
    // plan / outline 有启发式兜底，应当仍能产出覆盖全部子问题的报告
    const withFallback = ["plan", "outline"] as const;
    for (const stage of withFallback) {
      const result = await run({ breakStage: stage });
      expect(result.finishReason, `阶段 ${stage} 失效后仍应产出报告`).toBe("completed");
      const planned = result.plan.subquestions.map((sq) => sq.id);
      const covered = new Set<string>();
      for (const section of result.report.sections) {
        for (const id of section.subquestionIds) covered.add(id);
      }
      for (const id of planned) expect(covered.has(id), `阶段 ${stage} 失效后子问题 ${id} 未被覆盖`).toBe(true);
    }

    // extract / claims / compose 失效：没有可核验材料时，必须诚实降级
    // （report insufficient_sources），绝不能崩溃、也不能把假声明塞进报告
    const without = ["extract", "claims", "compose"] as const;
    for (const stage of without) {
      const result = await run({ breakStage: stage });
      expect(result.finishReason, `阶段 ${stage} 失效不应崩溃`).not.toBe("error");
      expect(result.audit.claimsUnverified, `阶段 ${stage} 失效绝不能产出无证据声明`).toBe(0);
    }
  });

  it("去重有效性：同源转载不应膨胀来源列表", async () => {
    const result = await run();
    // 3 篇不同语料，每个都有独一无二的内容，去重后 refs 应等于命中的 doc 数
    const refsTotal = result.audit.refsTotal;
    expect(refsTotal).toBeGreaterThan(0);
    expect(refsTotal).toBeLessThanOrEqual(FIXTURE_DOCS.length);
    expect(result.audit.refsUsed).toBeGreaterThan(0);
  });

  it("引用编号完整性：Markdown 每个编号都能在来源列表找到", async () => {
    const result = await run();
    const { markdown } = renderMarkdown(result);
    const refs = [...markdown.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const maxRef = refs.reduce((a, b) => Math.max(a, b), 0);
    // 引用编号从 1 连续，且最大值不超过来源总数
    expect(maxRef).toBeLessThanOrEqual(result.audit.refsUsed);
    expect(new Set(refs).size).toBeGreaterThan(0);
  });
});
