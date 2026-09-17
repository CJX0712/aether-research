/**
 * 博查 AI 搜索 —— 中文检索主力。
 *
 * 为什么必须有中文源：BrowseComp-ZH 基准上 OpenAI Deep Research 只有 42.9%，
 * 多数模型 <10%；Grok 几乎不检索中文网页。
 * 中文议题如果只靠英文索引，报告会系统性偏颇 —— 这不是模型能力问题，
 * 是检索层的问题，换什么模型都救不回来。
 *
 * 知乎 / 百度 / 公众号都没有官方开放检索 API（百度千帆仅 100 次/天且绑 ERNIE），
 * 所以走博查这类聚合源是唯一合规可行的路径。禁止登录态抓取。
 */

import { TokenBucket } from "../../fetch/limits.js";
import { classifySite, compactHits, envKey, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(5, 200);

export function createBochaProvider(apiKey?: string): SearchProvider {
  const key = apiKey ?? envKey("BOCHA_API_KEY");

  return {
    id: "bocha",
    kind: "zh",
    label: "博查 AI 搜索",
    costPerQuery: 0.0005,
    available: () => Boolean(key),

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!key) throw new ProviderError("bocha", "missing BOCHA_API_KEY");
      if (!(await bucket.take(options.signal))) return [];

      try {
        const response = await fetch("https://api.bochaai.com/v1/web-search", {
          method: "POST",
          signal: options.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            query: withSite(query, options.sites),
            count: Math.max(1, Math.min(options.limit, 20)),
            // 博查会把 AI 摘要一并给回，可作 provider 级正文兜底
            summary: true,
            freshness: options.from || options.to ? "noLimit" : undefined,
          }),
        });
        if (!response.ok) {
          throw new ProviderError("bocha", `HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        }
        const doc = (await response.json()) as {
          data?: { webPages?: { value?: BochaPage[] } };
        };
        return compactHits((doc.data?.webPages?.value ?? []).map((item) => {
          const url = str(item.url);
          return {
            url,
            title: optStr(item.name) ?? url,
            snippet: optStr(item.summary) ?? str(item.snippet),
            publishedAt: optStr(item.dateLastCrawled)?.slice(0, 10),
            provider: "bocha",
            siteKind: classifySite(url),
          } satisfies SearchHit;
        }));
      } catch (thrown) {
        if (thrown instanceof ProviderError) throw thrown;
        throw new ProviderError("bocha", thrown instanceof Error ? thrown.message : String(thrown), true);
      }
    },
  };
}

function withSite(query: string, sites?: readonly string[]): string {
  if (!sites || sites.length === 0) return query;
  return `${query} ${sites.map((site) => `site:${site}`).join(" OR ")}`;
}

interface BochaPage {
  url?: string;
  name?: string;
  snippet?: string;
  summary?: string;
  dateLastCrawled?: string;
}
