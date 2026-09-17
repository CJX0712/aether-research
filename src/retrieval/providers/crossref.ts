/**
 * Crossref —— DOI 元数据，免费、免 key。
 *
 * 与 OpenAlex 的关系：OpenAlex 覆盖广（含预印本、非英文期刊），
 * Crossref 对正式出版物与 DOI 的权威性强。两者互补，不是冗余。
 */

import { fetchJson, HttpError, TokenBucket } from "../../fetch/limits.js";
import { compactHits, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(5, 200);

export function createCrossrefProvider(mailto?: string): SearchProvider {
  return {
    id: "crossref",
    kind: "academic",
    label: "Crossref",
    costPerQuery: 0,
    available: () => true,

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!(await bucket.take(options.signal))) return [];

      const params = new URLSearchParams({
        query,
        rows: String(Math.max(1, Math.min(options.limit, 50))),
        select: "DOI,title,abstract,URL,issued,type,container-title,author",
      });
      if (mailto) params.set("mailto", mailto);
      if (options.from) params.set("filter", `from-pub-date:${options.from}`);

      const response = await call(`https://api.crossref.org/works?${params.toString()}`, options.signal, mailto);
      const items = (response.message?.items ?? []) as CrossrefItem[];

      return compactHits(items.map((item) => {
        const title = optStr(item.title?.[0]);
        const doi = optStr(item.DOI);
        if (!title || !doi) return null;
        const parts = item.issued?.["date-parts"]?.[0];
        return {
          url: optStr(item.URL) ?? `https://doi.org/${doi}`,
          title,
          snippet: stripTags(str(item.abstract)) || [optStr(item["container-title"]?.[0]), optStr(item.type)]
            .filter((value): value is string => Boolean(value))
            .join(" · "),
          publishedAt: parts ? formatParts(parts) : undefined,
          provider: "crossref",
          siteKind: "paper" as const,
        } satisfies SearchHit;
      }));
    },
  };
}

interface CrossrefResponse {
  message?: { items?: CrossrefItem[] };
}

interface CrossrefItem {
  DOI?: string;
  URL?: string;
  title?: string[];
  abstract?: string;
  type?: string;
  "container-title"?: string[];
  issued?: { "date-parts"?: number[][] };
}

async function call(url: string, signal?: AbortSignal, mailto?: string): Promise<CrossrefResponse> {
  try {
    return await fetchJson<CrossrefResponse>(url, {
      ...(signal ? { signal } : {}),
      headers: { "user-agent": `AetherResearch/0.1 (mailto: ${mailto ?? "anonymous"})` },
    });
  } catch (thrown) {
    if (thrown instanceof HttpError) {
      throw new ProviderError("crossref", thrown.message, thrown.retryable);
    }
    throw new ProviderError("crossref", thrown instanceof Error ? thrown.message : String(thrown), true);
  }
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function formatParts(parts: readonly number[]): string | undefined {
  const [year, month = 1, day = 1] = parts;
  if (!year) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
