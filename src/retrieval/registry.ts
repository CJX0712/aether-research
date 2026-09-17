/**
 * 多源融合检索。
 *
 * 三条设计原则：
 *
 * 1. **单源失败绝不阻断。** 任何一个检索器超时/被限流/缺 key，
 *    其余照常返回；全部失败才向上抛。这是"证据覆盖不塌陷"的第一道保险。
 *
 * 2. **跨源命中加权。** 同一 URL 被多个独立索引命中，说明它更可能是
 *    该问题的核心文献，而不是某个索引的排序偏好。这比任何单一 score 都可靠。
 *
 * 3. **按子问题性质配比检索源。** 学术问题加学术源，中文问题加中文源。
 *    一刀切地用同一个源，是中文议题偏英文文献的直接原因。
 */

import { mapLimit } from "aetherflow";

import {
  createArxivProvider,
} from "./providers/arxiv.js";
import { createBochaProvider } from "./providers/bocha.js";
import { createBraveProvider } from "./providers/brave.js";
import { createCrossrefProvider } from "./providers/crossref.js";
import { createExaProvider } from "./providers/exa.js";
import { createOpenAlexProvider } from "./providers/openalex.js";
import { createSearXngProvider } from "./providers/searxng.js";
import { createTavilyProvider } from "./providers/tavily.js";
import {
  classifySite,
  ProviderError,
  type SearchHit,
  type SearchOptions,
  type SearchProvider,
} from "./types.js";

export interface FusionHit extends SearchHit {
  /** 命中该 URL 的独立检索器。 */
  readonly providers: readonly string[];
  /** 融合后的排序分。 */
  readonly fusion: number;
  /** 来自几个不同 host 家族（用于压制同一站点的刷屏）。 */
  readonly hostGroup: string;
}

export class RetrievalRouter {
  private readonly providers = new Map<string, SearchProvider>();

  constructor(providers: readonly SearchProvider[] = defaultProviders()) {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }

  register(provider: SearchProvider): this {
    this.providers.set(provider.id, provider);
    return this;
  }

  list(): readonly SearchProvider[] {
    return [...this.providers.values()];
  }

  /** 已配置凭证、可实际使用的源。 */
  available(): readonly SearchProvider[] {
    return this.list().filter((provider) => provider.available());
  }

  /**
   * 按子问题偏好挑选检索源。
   * 没有显式指定时，取全部可用源 —— 宁可多查几个源，也不要漏掉中文或学术文献。
   */
  select(prefer?: readonly ("academic" | "web" | "zh")[]): readonly SearchProvider[] {
    const usable = this.available();
    if (!prefer || prefer.length === 0) return usable;
    const chosen = usable.filter((provider) => prefer.includes(provider.kind));
    // 偏好过滤把源筛没了就退回全部：宁可噪声，不可漏检
    return chosen.length > 0 ? chosen : usable;
  }

  /**
   * 并发检索多个查询 × 多个源，返回融合去重后的结果。
   *
   * 用 mapLimit 而非 Promise.all：可限并发，且中断时已发起的请求会被取消，
   * 不会留下继续消耗配额的孤儿请求。
   */
  async searchMany(
    queries: readonly { readonly text: string; readonly prefer?: readonly ("academic" | "web" | "zh")[] }[],
    options: SearchOptions & { readonly concurrency?: number },
  ): Promise<{ hits: readonly FusionHit[]; spendUsd: number; errors: readonly string[] }> {
    const tasks = queries.flatMap((query) => {
      const providers = this.select(query.prefer);
      return providers.map((provider) => ({ query: query.text, provider }));
    });

    let spendUsd = 0;
    const errors: string[] = [];

    // fn 内部已吞掉所有异常并转成 Outcome，所以 mapLimit 的 Err 分支
    // 理论上不会走到；仍然处理它，是因为中断信号会走那条路。
    const results = await mapLimit(
      tasks,
      options.concurrency ?? 8,
      (task): Promise<SearchOutcome> => runOne(task.provider, task.query, options),
      { ...(options.signal ? { signal: options.signal } : {}), failFast: false },
    );

    const outcomes: SearchOutcome[] = [];
    for (const result of results) {
      if (!result.ok) {
        errors.push(result.error.message);
        continue;
      }
      outcomes.push(result.value);
      // 失败也计费：检索器已经处理了这次查询，配额已经消耗
      spendUsd += result.value.cost;
    }

    const perQuery = new Map<string, Map<string, SearchHit>>();
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        errors.push(outcome.message);
        continue;
      }
      for (const hit of outcome.hits) {
        const key = canonicalKey(hit.url);
        if (!key) continue;
        let bucket = perQuery.get(outcome.query);
        if (!bucket) {
          bucket = new Map();
          perQuery.set(outcome.query, bucket);
        }
        const existing = bucket.get(key);
        // 同 URL 多源命中：保留信息更全的那条
        if (!existing || (hit.snippet?.length ?? 0) > (existing.snippet?.length ?? 0)) {
          bucket.set(key, hit);
        }
      }
    }

    return {
      hits: fuse(perQuery, tasks),
      spendUsd,
      errors: [...new Set(errors)],
    };
  }
}

interface SearchOutcomeBase {
  readonly provider: string;
  readonly query: string;
  /** 该次检索的近似成本；失败同样计入，因为配额已经消耗。 */
  readonly cost: number;
}

type SearchOutcome =
  | (SearchOutcomeBase & { readonly ok: true; readonly hits: readonly SearchHit[] })
  | (SearchOutcomeBase & { readonly ok: false; readonly message: string });

async function runOne(
  provider: SearchProvider,
  query: string,
  options: SearchOptions,
): Promise<SearchOutcome> {
  try {
    const hits = await provider.search(query, options);
    return { ok: true, provider: provider.id, query, cost: provider.costPerQuery, hits };
  } catch (thrown) {
    const message =
      thrown instanceof ProviderError
        ? thrown.message
        : thrown instanceof Error
          ? thrown.message
          : String(thrown);
    return { ok: false, provider: provider.id, query, cost: provider.costPerQuery, message };
  }
}

/**
 * 融合打分。
 * 核心是**跨源命中数** —— 它比任何检索器自报的 score 都更能说明
 * "这篇是不是该问题的核心文献"，因为不同索引的排序偏好会互相抵消。
 */
export function fuse(
  perQuery: ReadonlyMap<string, ReadonlyMap<string, SearchHit>>,
  tasks: readonly { readonly query: string; readonly provider: SearchProvider }[],
): readonly FusionHit[] {
  const merged = new Map<string, { hit: SearchHit; providers: Set<string>; queries: Set<string> }>();

  for (const [query, bucket] of perQuery) {
    for (const [key, hit] of bucket) {
      let entry = merged.get(key);
      if (!entry) {
        entry = { hit, providers: new Set(), queries: new Set() };
        merged.set(key, entry);
      }
      entry.providers.add(hit.provider);
      entry.queries.add(query);
      if ((hit.snippet?.length ?? 0) > (entry.hit.snippet?.length ?? 0)) entry.hit = hit;
    }
  }

  const totalQueries = new Set(tasks.map((task) => task.query)).size || 1;

  return [...merged.values()]
    .map(({ hit, providers, queries }) => {
      const crossSource = providers.size;                       // 跨源命中：主导项
      const queryCoverage = queries.size / totalQueries;         // 覆盖了多少个子查询
      const siteBump = siteWeight(hit.siteKind ?? classifySite(hit.url));
      const snippetBump = Math.min(1, (hit.snippet?.length ?? 0) / 400);
      const fusion = crossSource * 2 + queryCoverage * 1.5 + siteBump + snippetBump * 0.3;
      return {
        ...hit,
        providers: [...providers],
        fusion,
        hostGroup: hostGroup(hit.url),
      } satisfies FusionHit;
    })
    .sort((a, b) => b.fusion - a.fusion);
}

function siteWeight(kind: string): number {
  switch (kind) {
    case "paper":
      return 0.8;
    case "gov":
    case "institution":
      return 0.7;
    case "docs":
      return 0.5;
    case "news":
      return 0.2;
    case "ugc":
      return -0.1;
    default:
      return 0;
  }
}

function hostGroup(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const parts = host.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : host;
  } catch {
    return url;
  }
}

/** 排序用的规范化键；不做完整规范化（那是 fetch 层的事），只求同 URL 归并。 */
function canonicalKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch {
    return "";
  }
}

/** 默认检索源组合：三个免费学术源 + 中文 + 英文 + 兜底。 */
export function defaultProviders(): readonly SearchProvider[] {
  const mailto = process.env.RESEARCH_MAILTO;
  return [
    createArxivProvider(),
    createOpenAlexProvider(mailto),
    createCrossrefProvider(mailto),
    createBochaProvider(),
    createBraveProvider(),
    createTavilyProvider(),
    createExaProvider(),
    createSearXngProvider(),
  ];
}
