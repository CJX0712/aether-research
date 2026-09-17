/**
 * Brave Search API —— 英文检索主力。
 *
 * 选它的理由：$5/千次且有 $5 免费信用/月、50 QPS、支持 freshness 与站点限定。
 * 同期对比：Bing Web Search API 已于 2025-08 退役，
 * Google CSE 2027-01 关停且不再接新客 —— 这两个都已经不是选项。
 */

import { TokenBucket } from "../../fetch/limits.js";
import { classifySite, compactHits, envKey, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(20, 60);

export function createBraveProvider(apiKey?: string): SearchProvider {
  const key = apiKey ?? envKey("BRAVE_API_KEY");

  return {
    id: "brave",
    kind: "web",
    label: "Brave Search",
    costPerQuery: 0.005,
    available: () => Boolean(key),

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!key) throw new ProviderError("brave", "missing BRAVE_API_KEY");
      if (!(await bucket.take(options.signal))) return [];

      const params = new URLSearchParams({
        q: withSite(query, options.sites),
        count: String(Math.max(1, Math.min(options.limit, 20))),
        // 显式关掉 Brave 自带的 AI 摘要：我们要原文证据，不要二次加工的摘要
        summary: "0",
      });
      if (options.from || options.to) {
        params.set("freshness", `date:${options.from ?? ""}to${options.to ?? ""}`);
      }

      try {
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
          signal: options.signal,
          headers: {
            accept: "application/json",
            "X-Subscription-Token": key,
          },
        });
        if (!response.ok) {
          throw new ProviderError("brave", `HTTP ${response.status}`, response.status === 429 || response.status >= 500);
        }
        const doc = (await response.json()) as { web?: { results?: BraveWeb[] } };
        return compactHits((doc.web?.results ?? []).map((item) => {
          const url = str(item.url);
          return {
            url,
            title: optStr(item.title) ?? url,
            snippet: stripTags(str(item.description)),
            publishedAt: optStr(item.age ?? item.page_age),
            provider: "brave",
            siteKind: classifySite(url),
          } satisfies SearchHit;
        }));
      } catch (thrown) {
        if (thrown instanceof ProviderError) throw thrown;
        throw new ProviderError("brave", thrown instanceof Error ? thrown.message : String(thrown), true);
      }
    },
  };
}

function withSite(query: string, sites?: readonly string[]): string {
  if (!sites || sites.length === 0) return query;
  return `${query} ${sites.map((site) => `site:${site}`).join(" OR ")}`;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

interface BraveWeb {
  url?: string;
  title?: string;
  description?: string;
  age?: string;
  page_age?: string;
}
