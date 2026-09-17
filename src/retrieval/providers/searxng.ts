/**
 * SearXNG —— 自建或公共元搜索引擎。
 *
 * 价值：**零成本、零凭证**，是"没配任何 key 也能跑起来"的兜底通道。
 * 公共实例不稳定也不承诺 SLA，所以只作 fallback，不做主力。
 *
 * 注意很多公共实例默认关闭 JSON 输出（防滥用），
 * 因此失败时静默降级而不是刷一堆红字吓唬用户。
 */

import { TokenBucket } from "../../fetch/limits.js";
import { classifySite, compactHits, optNum, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(2, 500);

export interface SearXngOptions {
  /** 实例基址，如 `https://searx.be`。 */
  readonly baseUrl?: string;
  /** 使用的引擎，逗号分隔；留空用实例默认。 */
  readonly engines?: string;
}

export function createSearXngProvider(options: SearXngOptions = {}): SearchProvider {
  const base = (options.baseUrl ?? process.env.SEARXNG_URL ?? "https://searx.be").replace(/\/+$/, "");

  return {
    id: "searxng",
    kind: "web",
    label: `SearXNG (${hostOf(base)})`,
    costPerQuery: 0,
    available: () => true,

    async search(query: string, searchOptions: SearchOptions): Promise<readonly SearchHit[]> {
      if (!(await bucket.take(searchOptions.signal))) return [];

      const params = new URLSearchParams({
        q: withSite(query, searchOptions.sites),
        format: "json",
        language: searchOptions.lang === "zh" ? "zh" : "all",
        safesearch: "0",
      });
      if (options.engines) params.set("engines", options.engines);

      try {
        const response = await fetch(`${base}/search?${params.toString()}`, {
          signal: searchOptions.signal,
          headers: {
            accept: "application/json",
            "user-agent": "AetherResearch/0.1 (research agent)",
          },
        });
        // 很多实例对 JSON 返回 403；这类失败属于预期内，直接给空结果
        if (!response.ok) return [];
        const text = await response.text();
        if (!text.trimStart().startsWith("{")) return [];

        const doc = JSON.parse(text) as { results?: SearXngResult[] };
        return compactHits((doc.results ?? []).slice(0, searchOptions.limit).map((item) => {
          const url = str(item.url);
          return {
            url,
            title: optStr(item.title) ?? url,
            snippet: str(item.content),
            publishedAt: optStr(item.publishedDate),
            provider: "searxng",
            score: optNum(item.score),
            siteKind: classifySite(url),
          } satisfies SearchHit;
        }));
      } catch (thrown) {
        throw new ProviderError("searxng", thrown instanceof Error ? thrown.message : String(thrown), true);
      }
    },
  };
}

function withSite(query: string, sites?: readonly string[]): string {
  if (!sites || sites.length === 0) return query;
  return `${query} ${sites.map((site) => `site:${site}`).join(" OR ")}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

interface SearXngResult {
  url?: string;
  title?: string;
  content?: string;
  publishedDate?: string;
  score?: number;
}
