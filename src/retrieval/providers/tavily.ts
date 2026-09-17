/**
 * Tavily —— 面向 Agent 的搜索 API，**自带正文抽取**。
 *
 * 它的价值不在搜索质量，而在 `include_raw_content` 能直接拿正文：
 * 遇到 JS 渲染的 SPA、软 paywall、知乎这类反爬站点时，
 * 这一条通道是"证据覆盖不塌陷"的保险，不是锦上添花。
 */

import { TokenBucket } from "../../fetch/limits.js";
import { classifySite, compactHits, envKey, optNum, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(10, 120);

export function createTavilyProvider(apiKey?: string): SearchProvider {
  const key = apiKey ?? envKey("TAVILY_API_KEY");

  return {
    id: "tavily",
    kind: "web",
    label: "Tavily",
    costPerQuery: 0.008,
    available: () => Boolean(key),

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!key) throw new ProviderError("tavily", "missing TAVILY_API_KEY");
      if (!(await bucket.take(options.signal))) return [];

      try {
        const response = await fetch("https://api.tavily.com/search", {
          method: "POST",
          signal: options.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            query,
            max_results: Math.max(1, Math.min(options.limit, 20)),
            search_depth: "advanced",
            include_raw_content: false,
            include_answer: false,
            ...(options.sites?.length ? { include_domains: [...options.sites] } : {}),
          }),
        });
        if (!response.ok) {
          throw new ProviderError("tavily", `HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        }
        const doc = (await response.json()) as { results?: TavilyResult[] };
        return compactHits((doc.results ?? []).map((item) => {
          const url = str(item.url);
          return {
            url,
            title: optStr(item.title) ?? url,
            snippet: str(item.content),
            provider: "tavily",
            score: optNum(item.score),
            siteKind: classifySite(url),
          } satisfies SearchHit;
        }));
      } catch (thrown) {
        if (thrown instanceof ProviderError) throw thrown;
        throw new ProviderError("tavily", thrown instanceof Error ? thrown.message : String(thrown), true);
      }
    },
  };
}

interface TavilyResult {
  url?: string;
  title?: string;
  content?: string;
  score?: number;
}
