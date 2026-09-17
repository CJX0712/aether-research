/**
 * aether-research —— 可审计的深度研究。
 *
 * ```ts
 * import { research, renderMarkdown } from "aether-research";
 *
 * const result = await research({
 *   question: "2025 年超导量子比特的最高两比特门保真度是多少？",
 *   model: "anthropic:claude-sonnet-4-20250514",
 *   draftModel: "deepseek:deepseek-chat",
 *   budget: { maxCostUsd: 1.5 },
 * });
 *
 * console.log(renderMarkdown(result).markdown);
 * console.log(result.audit.claimsUnverified); // 必须是 0
 * ```
 *
 * 设计前提：**报告的敌人不是错误，是看起来正确的不可验证内容。**
 * 整个库围绕"让每一句话都能回溯到逐字原文"组织。
 */

export { research } from "./engine.js";
export type { ResearchDeps } from "./engine.js";

export { createLlm } from "./llm/model.js";
export type { Llm, LlmReply, LlmRequest, JsonOptions, UsageSink } from "./llm/model.js";

export { planResearch, fallbackPlan, planSchema, subQuestionSchema } from "./plan/planner.js";
export type { PlanDraft, PlanResult } from "./plan/planner.js";

export { collectEvidence, verifyRefs } from "./pipeline/collect.js";
export type { CollectDeps, CollectResult } from "./pipeline/collect.js";

export {
  RetrievalRouter,
  defaultProviders,
  fuse,
} from "./retrieval/registry.js";
export type { FusionHit } from "./retrieval/registry.js";

export {
  classifySite,
  compactHits,
  envKey,
  isHttpUrl,
  optNum,
  optStr,
  ProviderError,
  str,
} from "./retrieval/types.js";
export type { SearchHit, SearchOptions, SearchProvider } from "./retrieval/types.js";

export {
  createArxivProvider,
} from "./retrieval/providers/arxiv.js";
export { createBochaProvider } from "./retrieval/providers/bocha.js";
export { createBraveProvider } from "./retrieval/providers/brave.js";
export { createCrossrefProvider } from "./retrieval/providers/crossref.js";
export { createExaProvider } from "./retrieval/providers/exa.js";
export { createFixtureProvider } from "./retrieval/providers/fixture.js";
export { createOpenAlexProvider } from "./retrieval/providers/openalex.js";
export { createSearXngProvider } from "./retrieval/providers/searxng.js";
export { createTavilyProvider } from "./retrieval/providers/tavily.js";

export {
  adjudicate,
  applyVerdicts,
  claimSchema,
  claimsSchema,
  adjudicationSchema,
  renderEvidence,
  synthesizeClaims,
} from "./synthesis/claims.js";
export type { Adjudication, ClaimSynthesis, ClaimsDraft } from "./synthesis/claims.js";

export {
  buildOutline,
  composeSection,
  countUncitedParagraphs,
  enforceCoverage,
  fallbackOutline,
  normalizeMarkers,
  outlineSchema,
} from "./synthesis/compose.js";
export type { ComposeResult, DraftSection } from "./synthesis/compose.js";

export {
  MAX_QUOTE_CHARS,
  MIN_SNAP_SIMILARITY,
  dice,
  excerptAround,
  splitSentences,
  tokenize,
  verifyQuote,
} from "./synthesis/quote.js";
export type { VerifiedQuote } from "./synthesis/quote.js";

export { extractFromPage, evidenceId, selectRelevantChunks, siteRank } from "./synthesis/extract.js";
export type { ExtractOutcome, PageContent } from "./synthesis/extract.js";

export { Ledger } from "./store/ledger.js";
export type { LedgerSnapshot } from "./store/ledger.js";

export { renderMarkdown, toJson } from "./render/markdown.js";
export type { RenderOptions, RenderedReport } from "./render/markdown.js";
export { renderHtml } from "./render/html.js";
export { icon, ICONS } from "./render/icons.js";

export { canonicalize, Deduper, hamming, refIdOf, sha256Of, simhash } from "./fetch/normalize.js";
export { fetchPage, extractWithReadability, headCheck } from "./fetch/fetcher.js";
export type { FetchOptions, FetchedPage } from "./fetch/fetcher.js";
export { TokenBucket, USER_AGENT } from "./fetch/limits.js";

export type {
  Budget,
  Claim,
  Evidence,
  EvidenceLocate,
  Ref,
  RefFetch,
  RefSnapshot,
  ReportSection,
  ResearchAudit,
  ResearchConfig,
  ResearchEvent,
  ResearchFinishReason,
  ResearchPlan,
  ResearchReport,
  ResearchResult,
  ResearchUsage,
  SiteKind,
  SubQuestion,
  Support,
} from "./types.js";
