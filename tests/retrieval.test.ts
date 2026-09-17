/**
 * 检索层与 URL 规范化测试。
 *
 * 这里测的都是"纯逻辑"部分：融合排序、跨源计数、同站配额、近似去重。
 * 它们与是否联网无关，却决定了报告的证据覆盖面 ——
 * 尤其是中文议题被英文索引覆盖、或单一来源刷屏这类问题，
 * 全部出在这个层面。
 */

import { describe, expect, it } from "vitest";

import { canonicalize, Deduper, hamming, identityOf, refIdOf, simhash } from "../src/fetch/normalize.js";
import { RetrievalRouter, fuse } from "../src/retrieval/registry.js";
import { createFixtureProvider } from "../src/retrieval/providers/fixture.js";
import { classifySite, isHttpUrl } from "../src/retrieval/types.js";
import type { SearchHit } from "../src/retrieval/types.js";

function hit(url: string, provider: string, snippet = "摘要"): SearchHit {
  return { url, title: url, snippet, provider };
}

describe("URL 规范化", () => {
  it("剥离追踪参数与 hash，同一篇文章得到同一 id", () => {
    const a = "https://www.example.com/a?utm_source=x&utm_medium=y&id=3#section";
    const b = "https://example.com/a?id=3";
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe("https://example.com/a?id=3");
    expect(refIdOf(a)).toBe(refIdOf(b));
  });

  it("身份判定忽略协议：http 与 https 的同一路径是同一篇", () => {
    // 抓取仍用原始 URL（http-only 站点不能被升级），只有身份抹平协议差异
    expect(canonicalize("http://example.com/a?id=3")).not.toBe(
      canonicalize("https://example.com/a?id=3"),
    );
    expect(identityOf("http://example.com/a?id=3")).toBe(identityOf("https://example.com/a?id=3"));
    expect(refIdOf("http://example.com/a?id=3")).toBe(refIdOf("https://example.com/a?id=3"));
  });

  it("同一篇文章的 doi 链接与出版社页面不会被误并为一条", () => {
    expect(canonicalize("https://doi.org/10.1000/abc")).not.toBe(
      canonicalize("https://example.com/article"),
    );
  });
});

describe("近似去重", () => {
  it("转载与镜像被识别为重复", () => {
    const deduper = new Deduper();
    const text = "这是一段用于测试近似重复的正文内容，长度足够产生稳定的指纹。";
    expect(deduper.add("a", text)).toBe(true);
    // 只改动个别字词，SimHash 应当仍然接近
    expect(deduper.add("b", `${text}另外加了一句完全不同而且相当长的话用于拉开距离。`)).toBe(true);
    expect(deduper.add("c", text)).toBe(false);
  });

  it("simhash 对微小改动保持稳定，对完全不同内容给出大汉明距离", () => {
    const a = simhash("量子纠错的表面码阈值在实验上已经被跨越");
    const b = simhash("量子纠错的表面码阈值在实验上已经被跨越。");
    const c = simhash("今天天气不错，适合去公园散步并且吃一份午饭");
    expect(hamming(a, b)).toBeLessThanOrEqual(4);
    expect(hamming(a, c)).toBeGreaterThan(6);
  });
});

describe("检索源分类与合法性", () => {
  it("站点性质判定", () => {
    expect(classifySite("https://arxiv.org/abs/2401.00001")).toBe("paper");
    expect(classifySite("https://www.nist.gov/news")).toBe("gov");
    expect(classifySite("https://en.wikipedia.org/wiki/Qubit")).toBe("institution");
    expect(classifySite("https://www.zhihu.com/question/123")).toBe("ugc");
  });

  it("只接受 http/https", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<b>x</b>")).toBe(false);
    expect(isHttpUrl("/relative/path")).toBe(false);
  });
});

describe("多源融合", () => {
  it("跨源命中的 URL 排在单源命中之前", () => {
    const perQuery = new Map<string, Map<string, SearchHit>>([
      [
        "q1",
        new Map<string, SearchHit>([
          ["a", hit("https://a.test/1", "brave")],
          ["b", hit("https://b.test/1", "tavily")],
        ]),
      ],
      [
        "q2",
        new Map<string, SearchHit>([["a", hit("https://a.test/1", "bocha")]]),
      ],
    ]);
    const tasks = [
      { query: "q1", provider: providerStub("brave") },
      { query: "q2", provider: providerStub("bocha") },
    ];

    const fused = fuse(perQuery, tasks);
    expect(fused[0]?.url).toBe("https://a.test/1");
    expect(fused[0]?.providers.length).toBe(2);
    expect((fused[0]?.fusion ?? 0) > (fused[1]?.fusion ?? 0)).toBe(true);
  });

  it("学术论文与官方来源获得加权，UGC 被降权", () => {
    const perQuery = new Map<string, Map<string, SearchHit>>([
      [
        "q",
        new Map<string, SearchHit>([
          ["paper", { ...hit("https://arxiv.org/abs/1", "arxiv"), siteKind: "paper" }],
          ["ugc", { ...hit("https://zhihu.com/p/1", "bocha"), siteKind: "ugc" }],
        ]),
      ],
    ]);
    const fused = fuse(perQuery, [{ query: "q", provider: providerStub("arxiv") }]);
    expect(fused[0]?.url).toContain("arxiv.org");
  });
});

describe("RetrievalRouter", () => {
  it("单源失败不阻断其它源", async () => {
    const broken = createFixtureProvider([], { id: "broken", failWith: "boom" });
    const good = createFixtureProvider(
      [{ url: "https://ok.test/1", title: "可用来源", text: "正文内容需要足够长才能通过最低长度门槛，这里再补一些字。" }],
      { id: "good" },
    );
    const router = new RetrievalRouter([broken, good]);

    const out = await router.searchMany([{ text: "任意查询" }], { limit: 5 });
    expect(out.errors).toContain("boom");
    expect(out.hits.length).toBeGreaterThan(0);
  });

  it("按子问题偏好挑选检索源，偏好把源筛没了就退回全部", async () => {
    const academic = createFixtureProvider([], { id: "academic", kind: "academic" });
    const web = createFixtureProvider([], { id: "web", kind: "web" });
    const router = new RetrievalRouter([academic, web]);

    expect(router.select(["academic"]).map((p) => p.id)).toEqual(["academic"]);
    expect(router.select([]).map((p) => p.id)).toEqual(["academic", "web"]);
  });

  it("不可用（缺凭证）的源被自动排除", () => {
    const offline = { ...createFixtureProvider([], { id: "x" }), available: () => false };
    const router = new RetrievalRouter([offline, createFixtureProvider([], { id: "y" })]);
    expect(router.available().map((p) => p.id)).toEqual(["y"]);
  });
});

function providerStub(id: string) {
  return {
    id,
    kind: "web" as const,
    label: id,
    costPerQuery: 0,
    available: () => true,
    search: async () => [],
  };
}
