/**
 * 证据收集：检索 → 抓取 → 逐字抽取。
 *
 * 三个容易被忽略、但直接影响报告可信度的处理：
 *
 * 1. **同站配额。** 不限制的话，某个大站的十几篇内容会挤掉其它所有来源，
 *    报告看起来引用了 20 个来源，实际是同一个编辑部的口径。
 *
 * 2. **抓取失败时用检索器自带正文兜底。** 付费墙、SPA、反爬会让 Readability
 *    拿到空壳；Tavily 之类会直接回正文。有兜底就用，但要标记 `by: "provider"`，
 *    让审计看得出来这条路不是逐字取自原页面。
 *
 * 3. **正文只在内存中存在。** 抽完证据正文即弃，只留 sha256 与开头片段进 Ref。
 *    这样研究 30 个来源也不会撑爆上下文。
 */

import { mapLimit } from "aetherflow";

import { fetchPage, headCheck, type FetchedPage } from "../fetch/fetcher.js";
import { Deduper, refIdOf, sha256Of } from "../fetch/normalize.js";
import type { Llm } from "../llm/model.js";
import { RetrievalRouter, type FusionHit } from "../retrieval/registry.js";
import type { PageContent } from "../synthesis/extract.js";
import { extractFromPage } from "../synthesis/extract.js";
import type { Ledger } from "../store/ledger.js";
import type { Budget, Evidence, Ref, ResearchEvent, SubQuestion, SiteKind } from "../types.js";

export interface CollectDeps {
  readonly router: RetrievalRouter;
  readonly ledger: Ledger;
  /** 便宜模型：逐源抽取是次数最多的一步，用贵模型纯属浪费。 */
  readonly llm: Llm;
  readonly plan: readonly SubQuestion[];
  readonly queries: ReadonlyMap<string, readonly string[]>;
  readonly budget: Required<
    Pick<Budget, "maxQueriesPerSubquestion" | "maxSources" | "maxFetches">
  >;
  readonly respectRobots: boolean;
  readonly signal?: AbortSignal;
  readonly emit: (event: ResearchEvent) => void;
}

export interface CollectResult {
  readonly evidence: readonly Evidence[];
  readonly searches: number;
  readonly searchUsd: number;
  readonly modelUsd: number;
  readonly fetches: number;
  readonly fetchFailures: number;
  /** 模型给了但未能通过逐字校验的引文总数。 */
  readonly rejectedQuotes: number;
  readonly errors: readonly string[];
}

/** 同一 host 家族最多取这么多篇。防止单一来源刷屏。 */
const PER_HOST_LIMIT = 2;

/** 正文低于此长度视为空壳页（导航、页脚、JS 渲染占位）。 */
const MIN_BODY_CHARS = 120;

export async function collectEvidence(deps: CollectDeps): Promise<CollectResult> {
  const { router, ledger, llm, plan, queries, budget, emit } = deps;

  const hostCounts = new Map<string, number>();
  const seenRefIds = new Set<string>();
  const deduper = new Deduper();
  const tasks: { readonly subquestion: SubQuestion; readonly hit: FusionHit }[] = [];
  const errors = new Set<string>();

  let searches = 0;
  let searchUsd = 0;

  /* ── 检索 ─────────────────────────────────────────────────────── */

  const searchTasks = plan.flatMap((subquestion) => {
    const list = (queries.get(subquestion.id) ?? [subquestion.question]).slice(
      0,
      budget.maxQueriesPerSubquestion,
    );
    return list.map((text) => ({
      text,
      ...(subquestion.prefer ? { prefer: normalizePrefer(subquestion.prefer) } : {}),
    }));
  });

  if (searchTasks.length > 0) {
    const outcome = await router.searchMany(searchTasks, {
      limit: 8,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    searches = searchTasks.length;
    searchUsd = outcome.spendUsd;
    for (const message of outcome.errors) errors.add(message);
    emit({ type: "search_done", provider: "all", hits: outcome.hits.length });

    // 融合分已排序；同站配额在此生效
    for (const hit of outcome.hits) {
      if (tasks.length >= budget.maxSources) break;
      const group = hit.hostGroup;
      const count = hostCounts.get(group) ?? 0;
      if (count >= PER_HOST_LIMIT) continue;
      hostCounts.set(group, count + 1);

      const subquestion = attribute(hit, plan, queries) ?? plan[0];
      if (!subquestion) continue;
      tasks.push({ subquestion, hit });
    }
  }

  /* ── 抓取 ─────────────────────────────────────────────────────── */

  const limited = tasks.slice(0, budget.maxFetches);
  let fetchFailures = 0;

  const pages = await mapLimit(
    limited,
    6,
    async (task) => {
      const refId = refIdOf(task.hit.url);
      if (seenRefIds.has(refId)) return null;
      seenRefIds.add(refId);

      emit({ type: "fetch_start", url: task.hit.url });

      let page = await fetchPage(task.hit.url, {
        respectRobots: deps.respectRobots,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });

      // 抓不到正文就用检索器自带内容兜底
      let text = page.text;
      let by: "readability" | "provider" = "readability";
      if (text.length < 200 && (task.hit.content?.length ?? 0) > text.length) {
        text = task.hit.content ?? "";
        by = "provider";
      }

      // 低于 120 字符基本是导航/页脚/空壳页。阈值不能定太高：
      // 摘要页、新闻快讯、官方公告的正文往往只有一两百字，却是高价值来源。
      if (text.length < MIN_BODY_CHARS) {
        fetchFailures += 1;
        emit({ type: "fetch_end", url: task.hit.url, ok: false, chars: 0 });
        return null;
      }

      emit({ type: "fetch_end", url: task.hit.url, ok: true, chars: text.length });

      const ref = buildRef(task.hit, page, text, refId);
      if (!deduper.add(refId, text)) return null;
      ledger.addRef(ref);

      const content: PageContent = {
        refId,
        url: ref.canonicalUrl,
        title: ref.title,
        text,
        by,
      };
      return { content, subquestion: task.subquestion };
    },
    { ...(deps.signal ? { signal: deps.signal } : {}), failFast: false },
  );

  const collected: { content: PageContent; subquestion: SubQuestion }[] = [];
  for (const result of pages) {
    if (!result.ok) {
      errors.add(result.error.message);
      continue;
    }
    if (result.value) collected.push(result.value);
  }

  /* ── 逐源抽取 ─────────────────────────────────────────────────── */

  const evidence: Evidence[] = [];
  let modelUsd = 0;
  let rejectedQuotes = 0;

  const extractions = await mapLimit(
    collected,
    4,
    async (item) => extractFromPage(llm, item.content, item.subquestion, deps.signal),
    { ...(deps.signal ? { signal: deps.signal } : {}), failFast: false },
  );

  for (const result of extractions) {
    if (!result.ok) {
      errors.add(result.error.message);
      continue;
    }
    modelUsd += result.value.costUsd;
    rejectedQuotes += result.value.rejected;
    evidence.push(...result.value.evidence);
  }

  ledger.addEvidenceMany(evidence);
  if (evidence.length > 0) emit({ type: "evidence_added", count: evidence.length });

  return {
    evidence,
    searches,
    searchUsd,
    modelUsd,
    fetches: collected.length,
    fetchFailures,
    rejectedQuotes,
    errors: [...errors],
  };
}

/* ── 辅助 ────────────────────────────────────────────────────────── */

/**
 * 把一条命中归到最相关的子问题。
 * 用查询文本回指：命中来自哪条查询，那条查询属于哪个子问题。
 * 比"分给第一个子问题"准确得多 —— 后者会让所有证据堆在 sq1 上。
 */
function attribute(
  hit: FusionHit,
  plan: readonly SubQuestion[],
  queries: ReadonlyMap<string, readonly string[]>,
): SubQuestion | undefined {
  const hitText = `${hit.title} ${hit.snippet}`.toLowerCase();

  // 先统计每个词出现在几个子问题的查询里。所有子问题共享的词（通常是主问题本身）
  // 对区分归属毫无帮助，必须降权；真正决定归属的是"只属于某个子问题"的词。
  const perSubquestion = plan.map((subquestion) => ({
    subquestion,
    tokens: [
      ...new Set(
        (queries.get(subquestion.id) ?? [])
          .join(" ")
          .toLowerCase()
          .split(/[^\p{Script=Han}a-z0-9]+/u)
          .filter((token) => token.length > 1),
      ),
    ],
  }));

  const documentFrequency = new Map<string, number>();
  for (const entry of perSubquestion) {
    for (const token of new Set(entry.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  let best: { subquestion: SubQuestion; score: number } | undefined;
  for (const entry of perSubquestion) {
    let matched = 0;
    let total = 0;
    for (const token of entry.tokens) {
      // 独有词权重高，共享词几乎不贡献
      const weight = 1 / (documentFrequency.get(token) ?? 1);
      total += weight;
      if (hitText.includes(token)) matched += weight;
    }
    if (total === 0) continue;
    const score = matched / total;
    if (!best || score > best.score) best = { subquestion: entry.subquestion, score };
  }
  return best?.subquestion;
}

function normalizePrefer(
  prefer: readonly ("academic" | "web" | "zh" | "official")[],
): readonly ("academic" | "web" | "zh")[] {
  const mapped = prefer.flatMap((item): ("academic" | "web" | "zh")[] =>
    item === "official" ? ["web"] : [item],
  );
  return [...new Set(mapped)];
}

function buildRef(hit: FusionHit, page: FetchedPage, text: string, refId: string): Ref {
  const siteKind: SiteKind = hit.siteKind ?? "other";
  return {
    id: refId,
    canonicalUrl: hit.url,
    finalUrl: page.finalUrl || hit.url,
    title: hit.title || page.title || hit.url,
    siteKind,
    ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
    via: [...new Set(hit.providers)],
    fetch: {
      at: new Date().toISOString(),
      status: page.status || 200,
      contentType: page.contentType || "text/html",
      extractedBy: page.by === "none" ? "provider" : page.by,
      ...(page.error ? { error: page.error } : {}),
    },
    snapshot: {
      sha256: sha256Of(text),
      charCount: text.length,
      head: text.slice(0, 400),
    },
  };
}

/** 归档前的引用存活校验。只对被真正引用的来源做，省请求也省时间。 */
export async function verifyRefs(
  refs: readonly Ref[],
  ledger: Ledger,
  signal?: AbortSignal,
): Promise<number> {
  const results = await mapLimit(
    refs,
    6,
    async (ref) => {
      try {
        const check = await headCheck(ref.canonicalUrl, signal);
        // 403/429 多半是反爬而非死链，不算失效
        const dead = check.status >= 400 && check.status !== 403 && check.status !== 429;
        if (dead) ledger.countDeadLink();
        return { ref, check, dead };
      } catch {
        return { ref, check: null, dead: false };
      }
    },
    { ...(signal ? { signal } : {}), failFast: false },
  );

  let dead = 0;
  for (const result of results) {
    if (!result.ok) continue;
    if (result.value.dead) dead += 1;
    const { ref, check } = result.value;
    if (!check) continue;
    ledger.addRef({ ...ref, fetch: { ...ref.fetch, headCheck: check } });
  }
  return dead;
}
