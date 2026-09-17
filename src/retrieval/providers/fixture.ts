/**
 * 离线检索器。
 *
 * 存在的理由：**没有它，整个 CI 就要么联网花钱，要么没法测。**
 * 它把一批固定语料当成一个检索源，配合 AetherFlow 的 mock provider，
 * 可以让完整流水线在零成本、零网络、完全确定的条件下回归。
 *
 * 这不是玩具 —— 流水线里最容易坏的恰恰是"多源融合、去重、跨源计数"
 * 这些纯逻辑部分，它们与是否真联网无关。
 */

import type { SearchHit, SearchOptions, SearchProvider } from "../types.js";

export interface FixtureDoc {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly publishedAt?: string;
  readonly siteKind?: SearchHit["siteKind"];
  /** 命中这些词时才返回；留空表示任意查询都返回。 */
  readonly match?: readonly string[];
}

export interface FixtureOptions {
  readonly id?: string;
  readonly label?: string;
  /** 来源性质（web / academic / news ...），用来验证按子问题的偏好筛选。 */
  readonly kind?: SearchProvider["kind"];
  /** 模拟网络延迟，用来验证并发与超时行为。 */
  readonly delayMs?: number;
  /** 注入失败，用来验证降级路径。 */
  readonly failWith?: string;
}

export function createFixtureProvider(
  docs: readonly FixtureDoc[],
  options: FixtureOptions = {},
): SearchProvider & { readonly docs: readonly FixtureDoc[] } {
  const id = options.id ?? "fixture";

  return {
    id,
    kind: options.kind ?? "web",
    label: options.label ?? `Fixture(${docs.length})`,
    costPerQuery: 0,
    docs,
    available: () => true,

    async search(query: string, searchOptions: SearchOptions): Promise<readonly SearchHit[]> {
      if (options.delayMs && options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      if (options.failWith) throw new Error(options.failWith);
      if (searchOptions.signal?.aborted) return [];

      const terms = tokenize(query);
      const scored = docs
        .map((doc) => ({ doc, score: relevance(terms, doc) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, searchOptions.limit);

      // 一条都没命中时退化为返回前 N 条：真实检索器也不会返回空，
      // 让上层能验证"低质量结果如何被过滤"而不是"没结果"。
      const picked = scored.length > 0 ? scored : docs.slice(0, searchOptions.limit).map((doc) => ({ doc, score: 0.01 }));

      return picked.map(({ doc, score }) => ({
        url: doc.url,
        title: doc.title,
        snippet: doc.text.slice(0, 300),
        provider: id,
        score,
        ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
        ...(doc.siteKind ? { siteKind: doc.siteKind } : {}),
        // 正文一并给出，省掉抓取阶段（fixture 场景不需要测网络抓取）
        content: doc.text,
      }));
    },
  };
}

function relevance(terms: readonly string[], doc: FixtureDoc): number {
  const haystack = `${doc.title} ${doc.text}`.toLowerCase();
  const whitelist = doc.match?.map((term) => term.toLowerCase()) ?? [];
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) score += 1;
  }
  if (whitelist.length > 0) {
    const hit = terms.some((term) => whitelist.some((allowed) => allowed.includes(term) || term.includes(allowed)));
    if (!hit) return 0;
    score += 2;
  }
  return score;
}

/** 中英混排分词：英文按词，中文按 2-gram。够用且零依赖。 */
function tokenize(query: string): readonly string[] {
  const lower = query.toLowerCase();
  const words = lower.match(/[a-z0-9][a-z0-9.+-]*/g) ?? [];
  const grams: string[] = [];
  const cjk = lower.match(/[\u4e00-\u9fa5]+/g) ?? [];
  for (const run of cjk) {
    if (run.length === 1) grams.push(run);
    for (let i = 0; i + 2 <= run.length; i += 1) grams.push(run.slice(i, i + 2));
  }
  return [...words, ...grams].filter((token) => token.length > 0);
}
