/**
 * arXiv Atom API。
 *
 * 官方硬性要求：单连接、1 请求 / 3 秒。违反会被封 IP，
 * 所以这里用容量为 1、补给的桶严格卡住，不做任何"并发优化"的尝试。
 */

import { XMLParser } from "fast-xml-parser";

import { TokenBucket } from "../../fetch/limits.js";
import { compactHits, optStr, ProviderError, str, type SearchHit, type SearchOptions, type SearchProvider } from "../types.js";

const bucket = new TokenBucket(1, 3_100);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  isArray: (name) => ["entry", "author", "link"].includes(name),
});

export function createArxivProvider(): SearchProvider {
  return {
    id: "arxiv",
    kind: "academic",
    label: "arXiv",
    costPerQuery: 0,
    available: () => true,

    async search(query: string, options: SearchOptions): Promise<readonly SearchHit[]> {
      if (!(await bucket.take(options.signal))) return [];

      const params = new URLSearchParams({
        search_query: `all:${query}`,
        start: "0",
        max_results: String(Math.max(1, Math.min(options.limit, 50))),
        sortBy: "relevance",
        sortOrder: "descending",
      });

      let xml: string;
      try {
        const response = await fetch(`http://export.arxiv.org/api/query?${params.toString()}`, {
          signal: options.signal,
          headers: { "user-agent": "AetherResearch/0.1" },
        });
        if (!response.ok) throw new ProviderError("arxiv", `HTTP ${response.status}`, response.status >= 500);
        xml = await response.text();
      } catch (thrown) {
        if (thrown instanceof ProviderError) throw thrown;
        throw new ProviderError("arxiv", thrown instanceof Error ? thrown.message : String(thrown), true);
      }

      const doc = parser.parse(xml) as { feed?: { entry?: unknown } };
      const raw = doc.feed?.entry;
      const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];

      const hits: SearchHit[] = [];
      for (const entry of entries) {
        const item = entry as Record<string, unknown>;
        const id = str(item["id"]);
        const title = clean(str(item["title"]));
        const summary = clean(str(item["summary"]));
        if (!id || !title) continue;

        const links = Array.isArray(item["link"]) ? (item["link"] as Record<string, unknown>[]) : [];
        const hasPdf = links.some((link) => link["@title"] === "pdf");
        const pageUrl = id.replace("http://", "https://");

        hits.push({
          url: pageUrl,
          title,
          // arXiv 摘要本身即为高质量证据，正文可以晚点再抓
          snippet: summary.slice(0, 600),
          publishedAt: normalizeDate(optStr(item["published"]) ?? ""),
          provider: "arxiv",
          siteKind: "paper",
          ...(hasPdf ? {} : {}),
        });
      }

      return compactHits(dedupe(hits));
    },
  };
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeDate(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10);
}

function dedupe(hits: readonly SearchHit[]): readonly SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const hit of hits) {
    const key = hit.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}
