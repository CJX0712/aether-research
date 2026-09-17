/**
 * 检索器插件接口。
 *
 * 设计取舍：**检索质量决定报告质量上限，换模型救不回来。**
 * 所以检索器必须是可插拔、可按任务配比、可单独降级的，
 * 绝不能让整个系统被单一索引（尤其是英文为主的索引）绑架。
 */

import type { SiteKind } from "../types.js";

export interface SearchHit {
  readonly url: string;
  readonly title: string;
  /** 检索器返回的摘要；可能是正文片段，也可能是 SEO 描述。 */
  readonly snippet: string;
  readonly publishedAt?: string;
  readonly provider: string;
  /** 检索器自报的相关性；跨源不可直接比较，仅同源自排序用。 */
  readonly score?: number;
  /** 检索器顺带回的正文，省一次抓取。 */
  readonly content?: string;
  readonly siteKind?: SiteKind;
}

export interface SearchOptions {
  readonly limit: number;
  readonly signal?: AbortSignal;
  /** ISO 日期，限定发表时间窗口。 */
  readonly from?: string;
  readonly to?: string;
  /** 站点限定，由上层展开为各检索器的语法。 */
  readonly sites?: readonly string[];
  readonly lang?: "zh" | "en";
}

export interface SearchProvider {
  readonly id: string;
  /** `academic` 源在学术类子问题上加权；`zh` 源在中文问题上加权。 */
  readonly kind: "web" | "academic" | "zh";
  readonly label: string;
  /** 缺少凭证时返回 false，编排层会静默跳过而不报错。 */
  available(): boolean;
  search(query: string, options: SearchOptions): Promise<readonly SearchHit[]>;
  /** 单条检索的近似美元成本，用于预算预估与实时记账。 */
  readonly costPerQuery: number;
}

export interface RetrievedPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly by: "readability" | "provider";
}

/** 检索器抛出的可预期错误（缺 key、配额、被限流），上层据此降级。 */
export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly retryable = false,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "ProviderError";
  }
}

/** 从环境变量读 key；缺失返回 undefined 而不是抛错。 */
export function envKey(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** 依据 URL 粗判站点性质，用于来源可信度加权。 */
export function classifySite(url: string): SiteKind {
  const host = safeHost(url);
  if (/(^|\.)(arxiv\.org|doi\.org|ncbi\.nlm\.nih\.gov|pubmed|acm\.org|ieee\.org|springer|sciencedirect|nature\.com|science\.org|biorxiv\.org|openalex\.org)$/.test(host)) {
    return "paper";
  }
  if (/(^|\.)(gov|edu)(\.[a-z]{2})?$/.test(host) || /\.gov\.[a-z]{2}$/.test(host)) return "gov";
  if (/(^|\.)(wikipedia\.org|who\.int|un\.org|oecd\.org|worldbank\.org|nist\.gov|iso\.org)$/.test(host)) {
    return "institution";
  }
  if (/(^|\.)(docs?\.|developer\.|mdn\.|readthedocs\.io|npmjs\.com|github\.com\/.*\/blob)/.test(url)) {
    return "docs";
  }
  if (/(^|\.)(zhihu\.com|juejin\.cn|csdn\.net|weixin|mp\.weixin\.qq\.com|reddit\.com|twitter\.com|x\.com|medium\.com|substack\.com)$/.test(host)) {
    return "ugc";
  }
  if (/(^|\.)(reuters\.com|bloomberg\.com|ft\.com|wsj\.com|nytimes\.com|bbc\.co|theguardian\.com|apnews\.com)$/.test(host)) {
    return "news";
  }
  return "other";
}

/**
 * 检索器返回的 JSON 一律当作不可信输入：字段可能缺失、可能是数字、
 * 可能是 null。**任何字段都不得直接透传进 SearchHit**，必须先过这些收敛函数。
 *
 * 这不是洁癖。一条 `url: undefined` 的 hit 会一路流到抓取层，
 * 最后变成 `new URL(undefined)` 崩溃，或者在报告里变成一条没有出处的引用 ——
 * 后者正是这个项目存在的意义所要消灭的东西。
 */
export function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** 空串归一为 undefined，避免 "  " 这类脏值被当作有效内容。 */
export function optStr(value: unknown): string | undefined {
  const text = str(value).trim();
  return text.length > 0 ? text : undefined;
}

export function optNum(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(str(value));
  return Number.isFinite(num) ? num : undefined;
}

/** 只接受 http/https。javascript:、data:、相对路径一律丢弃。 */
export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** 过滤掉无 URL / 非法 URL / 空条目的 hit。 */
export function compactHits(hits: readonly (SearchHit | null | undefined)[]): SearchHit[] {
  const out: SearchHit[] = [];
  for (const hit of hits) {
    if (!hit) continue;
    if (!isHttpUrl(hit.url)) continue;
    out.push(hit);
  }
  return out;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
