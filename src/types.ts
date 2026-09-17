/**
 * 核心数据结构。
 *
 * ── 三条不变量（整个项目防幻觉的地基，任何改动都必须先读这里）──────────
 *
 * 1. **Claim 永不内联引文文本**，只持 `evidenceIds`。
 *    一旦允许把摘录拷进 Claim，并行子任务之间就开始了"传话游戏"，
 *    上下文压缩时也会把引文改写得面目全非。
 *
 * 2. **evidenceIds 为空的 Claim 不得进入报告。**
 *    不可验证声明数必须为 0 —— 这是本项目的第一 KPI，优先级高于字数与引用条数。
 *    竞品最危险的缺陷恰恰是"因遗漏而误导"：报告看起来完整，缺失却不可见。
 *
 * 3. **上下文压缩只允许整条丢弃 Evidence，绝不改写。**
 *    若某 Claim 的全部 Evidence 被丢弃，该 Claim 必须一并丢弃。
 *
 * 引用编号由渲染期生成（渲染时 join Claim → Evidence → Ref），
 * 存储期不存在"第 N 条引用"这个概念，因此并行与压缩都不会让它漂移。
 */

import type { z } from "zod";

/* ── 来源 ──────────────────────────────────────────────────────── */

/** 站点性质，用于来源可信度加权与冲突裁决。 */
export type SiteKind = "paper" | "gov" | "institution" | "news" | "docs" | "ugc" | "other";

/** 抓取即固化，全生命周期只读。任何字段都不得在后续阶段被改写。 */
export interface Ref {
  readonly id: string;
  readonly canonicalUrl: string;
  /** 重定向后的最终 URL；未重定向时等于 canonicalUrl。 */
  readonly finalUrl: string;
  readonly title: string;
  readonly publisher?: string;
  readonly siteKind: SiteKind;
  readonly publishedAt?: string;
  /** 来源检索器，用于溯源"这条是从哪冒出来的"。 */
  readonly via: readonly string[];
  readonly fetch: RefFetch;
  /** 原文摘录快照：即便原页面消失，证据仍可被审计。 */
  readonly snapshot: RefSnapshot;
}

export interface RefFetch {
  readonly at: string;
  readonly status: number;
  readonly contentType: string;
  readonly etag?: string;
  /** 归档前的存活校验结果。 */
  readonly headCheck?: { readonly at: string; readonly status: number };
  /** 正文抽取方式；`provider` 表示直接用检索器返回的摘要/正文。 */
  readonly extractedBy: "readability" | "pdf" | "provider" | "none";
  /** 抽取失败原因；有值时该 Ref 不可作为证据来源。 */
  readonly error?: string;
}

export interface RefSnapshot {
  readonly sha256: string;
  /** 正文字符数，用于判断是否是"空壳页"。 */
  readonly charCount: number;
  /** 前 N 字符，审计用；完整正文落存储不进上下文。 */
  readonly head: string;
}

/* ── 证据 ──────────────────────────────────────────────────────── */

/** 逐字摘录。**必须**是原文子串，不允许改写或翻译后回填。 */
export interface Evidence {
  readonly id: string;
  readonly refId: string;
  /** 子问题归属，便于按节注入证据。 */
  readonly subquestionId: string;
  readonly quote: string;
  /** 在原文中的位置；无法定位时 confidence 必须为 inferred。 */
  readonly locate?: EvidenceLocate;
  readonly by: "readability" | "pdf" | "provider";
  /** `direct` 表示在原文中逐字命中；`inferred` 表示模型概括。 */
  readonly confidence: "direct" | "inferred";
}

export type EvidenceLocate =
  | { readonly kind: "char"; readonly start: number; readonly end: number }
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "para"; readonly index: number };

/* ── 声明 ──────────────────────────────────────────────────────── */

export type Support = "supported" | "contested" | "unverified";

/** 一条可被验证的事实陈述。研究报告的最小单元。 */
export interface Claim {
  readonly id: string;
  readonly subquestionId: string;
  readonly statement: string;
  /**
   * 只存 ID（不变量 1）。为空则本条 Claim 不得入报告（不变量 2）。
   */
  readonly evidenceIds: readonly string[];
  readonly support: Support;
  /** 存在冲突时，指向与之矛盾的 Claim。 */
  readonly contestedWith?: readonly string[];
  /** 冲突裁决说明；`contested` 时必填。 */
  readonly note?: string;
}

/* ── 规划 ──────────────────────────────────────────────────────── */

export interface SubQuestion {
  readonly id: string;
  readonly question: string;
  /** 为什么问这个；用于报告里交代研究路径。 */
  readonly intent: string;
  /** 期望从哪类来源找答案，用于检索源路由。 */
  readonly prefer?: readonly ("academic" | "web" | "zh" | "official")[];
}

export interface ResearchPlan {
  readonly question: string;
  /** 对原始问题的理解复述，用户可据此判断拆解是否跑偏。 */
  readonly interpretation: string;
  readonly subquestions: readonly SubQuestion[];
  /** 明确的排除项，防止报告越写越宽。 */
  readonly outOfScope: readonly string[];
}

/* ── 配置 ──────────────────────────────────────────────────────── */

export interface Budget {
  /** 美元硬顶；触及即停止新检索但会完成已启动阶段。 */
  readonly maxCostUsd?: number;
  readonly maxSubquestions?: number;
  readonly maxQueriesPerSubquestion?: number;
  readonly maxSources?: number;
  readonly maxFetches?: number;
  readonly maxDurationMs?: number;
}

export interface ResearchConfig {
  readonly question: string;
  /** 主模型，用于规划、裁决、综合。 */
  readonly model: string;
  /** 便宜模型，用于查询扩展与逐源证据抽取（可省 40-60% 成本）。 */
  readonly draftModel?: string;
  readonly budget?: Budget;
  /** 检索器 id 列表；缺省用全部已启用且有凭证的检索器。 */
  readonly providers?: readonly string[];
  /** 语言偏好，影响检索源路由与报告语言。默认 `auto`。 */
  readonly lang?: "auto" | "zh" | "en";
  /** 是否尊重 robots.txt。默认 true，关掉请自行承担合规责任。 */
  readonly respectRobots?: boolean;
  /** 归档前是否做引用存活校验（HTTP HEAD）。默认 true。 */
  readonly verifyLinks?: boolean;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

/* ── 结果 ──────────────────────────────────────────────────────── */

export interface ReportSection {
  readonly id: string;
  readonly heading: string;
  readonly subquestionIds: readonly string[];
  readonly claimIds: readonly string[];
  readonly body: string;
}

export interface ResearchReport {
  readonly question: string;
  readonly interpretation: string;
  readonly sections: readonly ReportSection[];
  /** 未被任何 Claim 引用的来源，进附录而非正文 —— 让"读了但没用"可见。 */
  readonly unusedRefIds: readonly string[];
}

export interface ResearchUsage {
  readonly modelUsd: number;
  readonly searchUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly searches: number;
  readonly fetches: number;
  readonly fetchFailures: number;
}

export type ResearchFinishReason =
  | "completed"
  | "budget_exceeded"
  | "timeout"
  | "aborted"
  | "insufficient_sources"
  | "error";

export interface ResearchResult {
  readonly runId: string;
  readonly question: string;
  readonly plan: ResearchPlan;
  readonly report: ResearchReport;
  /** 全部来源，按 id 索引。 */
  readonly refs: Readonly<Record<string, Ref>>;
  readonly evidence: Readonly<Record<string, Evidence>>;
  readonly claims: Readonly<Record<string, Claim>>;
  readonly usage: ResearchUsage;
  readonly finishReason: ResearchFinishReason;
  readonly durationMs: number;
  readonly error?: Error;
  /** 质量断言结果 —— 不达标不意味着报告更好，但会让 finishReason 反映出来。 */
  readonly audit: ResearchAudit;
}

export interface ResearchAudit {
  readonly claimsTotal: number;
  /** 无证据的声明数。**必须为 0**。 */
  readonly claimsUnverified: number;
  readonly claimsContested: number;
  readonly refsTotal: number;
  readonly refsUsed: number;
  /** 平均每条声明的独立来源数；低于 1.5 说明证据偏薄。 */
  readonly evidencePerClaim: number;
  readonly deadLinks: number;
  readonly warnings: readonly string[];
}

/** 运行期事件；UI、持久化、指标共用这一份流。 */
export type ResearchEvent =
  | { readonly type: "run_start"; readonly runId: string; readonly question: string }
  | { readonly type: "plan_ready"; readonly plan: ResearchPlan }
  | { readonly type: "query_expanded"; readonly subquestionId: string; readonly queries: readonly string[] }
  | { readonly type: "search_done"; readonly provider: string; readonly hits: number }
  | { readonly type: "fetch_start"; readonly url: string }
  | { readonly type: "fetch_end"; readonly url: string; readonly ok: boolean; readonly chars: number }
  | { readonly type: "evidence_added"; readonly count: number }
  | { readonly type: "claim_added"; readonly count: number }
  | { readonly type: "contested"; readonly claimId: string; readonly against: readonly string[] }
  | { readonly type: "section_done"; readonly index: number; readonly heading: string }
  | { readonly type: "usage"; readonly usage: ResearchUsage }
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "run_end"; readonly finishReason: ResearchFinishReason };

export type ZodSchema<T> = z.ZodType<T>;
