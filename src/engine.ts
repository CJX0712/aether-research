/**
 * 研究流程编排。
 *
 * 阶段顺序是固定的，每一阶段只依赖上一阶段的产物：
 *
 *   规划 → 检索/抓取/抽取 → 声明合成 → 冲突裁决 → 大纲 → 逐节生成 → 审计
 *
 * 预算不是"跑完之后统计"，而是**每一阶段开始前检查**：
 * 触及上限时停止开新检索，但已启动的阶段会跑完 ——
 * 中途腰斩会留下半份证据，比少查两个来源更糟。
 */

import { mapLimit, createDefaultRegistry, type ModelRegistry } from "aetherflow";

import { createLlm, type Llm, type UsageSink } from "./llm/model.js";
import { fallbackPlan, planResearch } from "./plan/planner.js";
import { collectEvidence, verifyRefs } from "./pipeline/collect.js";
import {
  RetrievalRouter,
  defaultProviders,
} from "./retrieval/registry.js";
import type { SearchProvider } from "./retrieval/types.js";
import { applyVerdicts, adjudicate, synthesizeClaims } from "./synthesis/claims.js";
import { buildOutline, composeSection } from "./synthesis/compose.js";
import { Ledger } from "./store/ledger.js";
import type {
  Claim,
  ResearchConfig,
  ResearchEvent,
  ResearchResult,
  ReportSection,
  ResearchUsage,
  ResearchFinishReason,
} from "./types.js";

export interface ResearchDeps {
  readonly registry?: ModelRegistry;
  /** 自定义检索源；缺省用内置组合（按环境变量自动启用）。 */
  readonly providers?: readonly SearchProvider[];
  readonly onEvent?: (event: ResearchEvent) => void;
}

const DEFAULTS = {
  maxSubquestions: 6,
  maxQueriesPerSubquestion: 4,
  maxSources: 20,
  maxFetches: 20,
  maxDurationMs: 15 * 60_000,
};

export async function research(
  config: ResearchConfig,
  deps: ResearchDeps = {},
): Promise<ResearchResult> {
  const startedAt = Date.now();
  const runId = config.runId ?? newRunId();
  const budget = { ...DEFAULTS, ...config.budget };
  const emit = (event: ResearchEvent): void => deps.onEvent?.(event);
  const warnings: string[] = [];

  const registry = deps.registry ?? createDefaultRegistry();
  const router = new RetrievalRouter(deps.providers ?? defaultProviders());
  const ledger = new Ledger();

  const signal = config.signal;
  const deadline = startedAt + budget.maxDurationMs;
  const timeoutSignal = AbortSignal.timeout(budget.maxDurationMs);
  const abort = signal ? anySignal([signal, timeoutSignal]) : timeoutSignal;

  let modelUsd = 0;
  let searchUsd = 0;
  let searches = 0;
  let fetches = 0;
  let fetchFailures = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  const spend = (amount: number): void => {
    modelUsd += amount;
  };

  const overBudget = (): boolean =>
    config.budget?.maxCostUsd !== undefined && modelUsd + searchUsd >= config.budget.maxCostUsd;

  emit({ type: "run_start", runId, question: config.question });

  try {
    /* ── 1. 规划 ──────────────────────────────────────────────── */

    let llm: Llm;
    let draftLlm: Llm;
    try {
      const sink: UsageSink = (usage) => {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
      };
      llm = createLlm(registry, config.model, sink);
      draftLlm = config.draftModel ? createLlm(registry, config.draftModel, sink) : llm;
    } catch (thrown) {
      return failure(config, runId, startedAt, "error", thrown, [
        `模型注册表解析失败：${messageOf(thrown)}`,
      ]);
    }

    let planResult: Awaited<ReturnType<typeof planResearch>>;
    try {
      planResult = await planResearch(llm, config.question, {
        maxSubquestions: budget.maxSubquestions,
        ...(signal ? { signal: abort } : {}),
      });
    } catch {
      planResult = { ...fallbackPlan(config.question, budget.maxSubquestions), byModel: false, costUsd: 0 };
      warnings.push("规划阶段模型调用失败，已降级为启发式拆解。");
    }
    spend(planResult.costUsd);
    if (!planResult.byModel) warnings.push("研究计划由启发式拆解生成，建议人工确认方向。");

    const plan = {
      question: config.question,
      interpretation: planResult.plan.interpretation,
      subquestions: planResult.plan.subquestions,
      outOfScope: planResult.plan.outOfScope,
    };
    emit({ type: "plan_ready", plan });

    /* ── 2. 检索 / 抓取 / 抽取 ────────────────────────────────── */

    if (router.available().length === 0) {
      warnings.push(
        "没有任何可用的检索源（缺少 API key？）。报告将基于空证据生成，请检查环境变量。",
      );
    }

    const collected = await collectEvidence({
      router,
      ledger,
      llm: draftLlm,
      plan: plan.subquestions,
      queries: planResult.queries,
      budget: {
        maxQueriesPerSubquestion: budget.maxQueriesPerSubquestion,
        maxSources: budget.maxSources,
        maxFetches: budget.maxFetches,
      },
      respectRobots: config.respectRobots !== false,
      ...(signal ? { signal: abort } : {}),
      emit,
    });

    searchUsd += collected.searchUsd;
    modelUsd += collected.modelUsd;
    searches += collected.searches;
    fetches += collected.fetches;
    fetchFailures += collected.fetchFailures;
    for (const message of collected.errors) warnings.push(message);
    if (collected.rejectedQuotes > 0) {
      warnings.push(
        `${collected.rejectedQuotes} 条模型给出的引文未通过逐字校验，已丢弃（这是防幻觉机制在生效）。`,
      );
    }
    if (collected.evidence.length === 0) {
      warnings.push("未抽取到任何可逐字核验的证据。报告的可信度极低，请检查检索源与网络。");
    }

    /* ── 3. 声明合成 ──────────────────────────────────────────── */

    const claimCounts = new Map<string, number>();
    const claimsBySubquestion = await mapLimit(
      plan.subquestions,
      3,
      async (subquestion) => {
        const evidence = [...ledger.getEvidence().values()].filter(
          (item) => item.subquestionId === subquestion.id,
        );
        if (evidence.length === 0) {
          return { subquestion, claims: [] as Claim[], gaps: [] as string[], costUsd: 0 };
        }
        const synthesis = await synthesizeClaims(
          llm,
          subquestion,
          evidence,
          ledger.getRefs(),
          abort,
        );
        return { subquestion, claims: synthesis.claims, gaps: synthesis.gaps, costUsd: synthesis.costUsd };
      },
      { ...(signal ? { signal: abort } : {}), failFast: false },
    );

    const draftClaims: Claim[] = [];
    for (const result of claimsBySubquestion) {
      if (!result.ok) {
        warnings.push(`子问题声明合成失败：${result.error.message}`);
        continue;
      }
      spend(result.value.costUsd);
      draftClaims.push(...result.value.claims);
      claimCounts.set(result.value.subquestion.id, result.value.claims.length);
      for (const gap of result.value.gaps ?? []) {
        warnings.push(`证据缺口（${result.value.subquestion.id}）：${gap}`);
      }
    }

    const accepted = ledger.addClaimMany(draftClaims);
    if (accepted < draftClaims.length) {
      warnings.push(`${draftClaims.length - accepted} 条声明因缺少可用证据被拒绝入库。`);
    }
    if (accepted > 0) emit({ type: "claim_added", count: accepted });

    /* ── 4. 冲突裁决 ──────────────────────────────────────────── */

    if (Object.keys(ledger.getClaims()).length >= 2 && !overBudget()) {
      const before = ledger.getClaims();
      const verdict = await adjudicate(
        llm,
        [...before.values()],
        ledger.getEvidence(),
        ledger.getRefs(),
        abort,
      );
      spend(verdict.costUsd);
      if (verdict.verdicts) {
        const updated = applyVerdicts(before, verdict.verdicts);
        for (const [id, claim] of updated) {
          if (before.get(id) !== claim) ledger.replaceClaim(claim);
        }
        const contested = [...updated.values()].filter((claim) => claim.support === "contested");
        for (const claim of contested) {
          emit({ type: "contested", claimId: claim.id, against: claim.contestedWith ?? [] });
        }
      }
    }

    /* ── 5. 大纲 + 逐节生成 ───────────────────────────────────── */

    const claims = ledger.getClaims();
    const outline = await buildOutline(llm, plan, claimCounts, abort);
    spend(outline.costUsd);
    if (!outline.byModel) warnings.push("大纲生成失败，已按子问题逐条分节。");

    const composeResults = await mapLimit(
      outline.sections,
      2,
      async (draft) =>
        composeSection(
          llm,
          draft,
          [...claims.values()].filter((claim) => draft.subquestionIds.includes(claim.subquestionId)),
          ledger.getEvidence(),
          ledger.getRefs(),
          plan.subquestions,
          abort,
        ),
      { ...(signal ? { signal: abort } : {}), failFast: false },
    );

    const sections: ReportSection[] = [];
    for (const [index, result] of composeResults.entries()) {
      if (!result.ok) {
        warnings.push(`章节生成失败：${result.error.message}`);
        continue;
      }
      spend(result.value.costUsd);
      for (const warning of result.value.warnings) warnings.push(warning);
      sections.push(result.value.section);
      emit({ type: "section_done", index: index + 1, heading: result.value.section.heading });
    }

    /* ── 6. 引用存活校验 ──────────────────────────────────────── */

    const usedRefIds = ledger.usedRefIds();
    if (config.verifyLinks !== false && usedRefIds.size > 0) {
      const usedRefs = [...usedRefIds]
        .map((id) => ledger.ref(id))
        .filter((ref): ref is NonNullable<typeof ref> => Boolean(ref));
      await verifyRefs(usedRefs, ledger, abort);
    }

    /* ── 7. 收尾 ──────────────────────────────────────────────── */

    const allRefIds = [...ledger.getRefs().keys()];
    const unusedRefIds = allRefIds.filter((id) => !usedRefIds.has(id));

    let finishReason: ResearchFinishReason = "completed";
    if (overBudget()) finishReason = "budget_exceeded";
    else if (Date.now() > deadline) finishReason = "timeout";
    else if (signal?.aborted) finishReason = "aborted";
    else if (ledger.getClaims().size === 0) finishReason = "insufficient_sources";

    const usage: ResearchUsage = {
      modelUsd: round4(modelUsd),
      searchUsd: round4(searchUsd),
      inputTokens,
      outputTokens,
      searches,
      fetches,
      fetchFailures,
    };
    emit({ type: "usage", usage });

    const result: ResearchResult = {
      runId,
      question: config.question,
      plan,
      report: {
        question: config.question,
        interpretation: plan.interpretation,
        sections,
        unusedRefIds,
      },
      refs: Object.fromEntries(ledger.getRefs()),
      evidence: Object.fromEntries(ledger.getEvidence()),
      claims: Object.fromEntries(ledger.getClaims()),
      usage,
      finishReason,
      durationMs: Date.now() - startedAt,
      audit: ledger.audit(warnings),
    };
    emit({ type: "run_end", finishReason });
    return result;
  } catch (thrown) {
    const aborted = signal?.aborted === true;
    return {
      ...failure(config, runId, startedAt, aborted ? "aborted" : "error", thrown, warnings),
      audit: ledger.audit(warnings),
    };
  }
}

/* ── 辅助 ────────────────────────────────────────────────────────── */

function failure(
  config: ResearchConfig,
  runId: string,
  startedAt: number,
  reason: ResearchFinishReason,
  thrown: unknown,
  warnings: readonly string[],
): ResearchResult {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown));
  return {
    runId,
    question: config.question,
    plan: { question: config.question, interpretation: "", subquestions: [], outOfScope: [] },
    report: { question: config.question, interpretation: "", sections: [], unusedRefIds: [] },
    refs: {},
    evidence: {},
    claims: {},
    usage: {
      modelUsd: 0,
      searchUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      searches: 0,
      fetches: 0,
      fetchFailures: 0,
    },
    finishReason: reason,
    durationMs: Date.now() - startedAt,
    error,
    audit: {
      claimsTotal: 0,
      claimsUnverified: 0,
      claimsContested: 0,
      refsTotal: 0,
      refsUsed: 0,
      evidencePerClaim: 0,
      deadLinks: 0,
      warnings: [...warnings, `运行失败：${error.message}`],
    },
  };
}

/** 合并多个中断信号。AbortSignal.any 在 Node 22 可用，但语义略不同，这里自持一份。 */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0] as AbortSignal;
  const controller = new AbortController();
  for (const item of signals) {
    if (item.aborted) {
      controller.abort();
      break;
    }
    item.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function newRunId(): string {
  return `rr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
