/**
 * Exa —— 语义检索 + 结果自带正文。
 *
 * 与 Tavily 的定位差异：Exa 是**语义**检索（找"意思相近"而非"关键词匹配"），
 * 在探索性子问题上表现更好；代价是更贵（$7/千次）。
 * 默认关闭，需要显式配 `EXA_API_KEY` 才启用。
 */

import { TokenBucket } from "../../fetch/limits.js";
import { classifySite, compactHits, envKey, optNum, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(5, 200);

export function createExaProvider(apiKey?: string): SearchProvider {
  const key = apiKey ?? envKey("EXA_API_KEY");

  return {
    id: "exa",
    kind: "web",
    label: "Exa",
    costPerQuery: 0.007,
    available: () => Boolean(key),

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!key) throw new ProviderError("exa", "missing EXA_API_KEY");
      if (!(await bucket.take(options.signal))) return [];

      try {
        const response = await fetch("https://api.exa.ai/search", {
          method: "POST",
          signal: options.signal,
          headers: { "content-type": "application/json", "x-api-key": key },
          body: JSON.stringify({
            query,
            numResults: Math.max(1, Math.min(options.limit, 20)),
            contents: { text: { maxCharacters: 2_000 } },
            ...(options.sites?.length ? { includeDomains: [...options.sites] } : {}),
          }),
        });
        if (!response.ok) {
          throw new ProviderError("exa", `HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        }
        const doc = (await response.json()) as { results?: ExaResult[] };
        return compactHits((doc.results ?? []).map((item) => {
          const url = str(item.url);
          return {
            url,
            title: optStr(item.title) ?? url,
            snippet: str(item.text),
            publishedAt: optStr(item.publishedDate)?.slice(0, 10),
            provider: "exa",
            score: optNum(item.score),
            siteKind: classifySite(url),
          } satisfies SearchHit;
        }));
      } catch (thrown) {
        if (thrown instanceof ProviderError) throw thrown;
        throw new ProviderError("exa", thrown instanceof Error ? thrown.message : String(thrown), true);
      }
    },
  };
}

interface ExaResult {
  url?: string;
  title?: string;
  text?: string;
  publishedDate?: string;
  score?: number;
}
