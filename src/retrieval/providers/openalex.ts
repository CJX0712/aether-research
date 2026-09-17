/**
 * OpenAlex —— 免费的开放学术索引，无需 key。
 *
 * 填了 `mailto` 会进 polite pool（速率翻倍且更稳定），
 * 这是官方明确鼓励的做法，不是 trick。
 */

import { fetchJson, HttpError, TokenBucket } from "../../fetch/limits.js";
import { compactHits, optNum, optStr, ProviderError, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(5, 200);

export function createOpenAlexProvider(mailto?: string): SearchProvider {
  return {
    id: "openalex",
    kind: "academic",
    label: "OpenAlex",
    costPerQuery: 0,
    available: () => true,

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!(await bucket.take(options.signal))) return [];

      const params = new URLSearchParams({
        search: query,
        per_page: String(Math.max(1, Math.min(options.limit, 50))),
        sort: "relevance_score:desc",
      });
      if (mailto) params.set("mailto", mailto);
      if (options.from) params.set("from_publication_date", options.from);
      if (options.to) params.set("to_publication_date", options.to);

      const response = await call(`https://api.openalex.org/works?${params.toString()}`, options.signal, mailto);
      const rows = (response.results ?? []) as OpenAlexWork[];

      return compactHits(rows.map((work) => {
        const url = optStr(work.doi) ?? optStr(work.primary_location?.landing_page_url) ?? optStr(work.id);
        const title = optStr(work.display_name);
        if (!url || !title) return null;
        const abstract = work.abstract_inverted_index ? reconstruct(work.abstract_inverted_index) : "";
        return {
          url,
          title,
          snippet: abstract || `${title}${work.publication_year ? ` (${work.publication_year})` : ""}`,
          publishedAt: optStr(work.publication_date),
          provider: "openalex",
          score: optNum(work.relevance_score),
          siteKind: "paper" as const,
        } satisfies SearchHit;
      }));
    },
  };
}

interface OpenAlexResult {
  results?: OpenAlexWork[];
}

interface OpenAlexWork {
  id?: string;
  doi?: string;
  display_name?: string;
  publication_date?: string;
  publication_year?: number;
  relevance_score?: number;
  abstract_inverted_index?: Record<string, number[]>;
  primary_location?: { landing_page_url?: string };
}

/**
 * OpenAlex 的 polite pool 要求 UA 或查询参数里带 mailto。
 * 不填的话共享出口 IP 极易被 429 —— 这不是 trick，是官方明确要求的做法。
 */
async function call(url: string, signal?: AbortSignal, mailto?: string): Promise<OpenAlexResult> {
  try {
    return await fetchJson<OpenAlexResult>(url, {
      ...(signal ? { signal } : {}),
      headers: { "user-agent": `AetherResearch/0.1 (mailto: ${mailto ?? "anonymous"})` },
    });
  } catch (thrown) {
    if (thrown instanceof HttpError) {
      throw new ProviderError("openalex", thrown.message, thrown.retryable);
    }
    throw new ProviderError("openalex", thrown instanceof Error ? thrown.message : String(thrown), true);
  }
}

/**
 * OpenAlex 的摘要是倒排索引（词 → 位置数组），需要还原。
 * 这是它免费但略微反人类的地方。
 */
function reconstruct(index: Record<string, number[]>): string {
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions) slots[position] = word;
  }
  return slots.filter(Boolean).join(" ").trim();
}
