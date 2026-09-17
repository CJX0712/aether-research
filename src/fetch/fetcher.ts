/**
 * 抓取与正文抽取。
 *
 * 合规不是可选项：尊重 robots.txt、显式 UA 带联系方式、按 host 限速、
 * 失败退避而不是猛冲。被封的不只是这个 IP，是以后所有用这个库的人。
 *
 * Readability 的三个坑（都踩过）：
 *  1. `parse()` 会**原地修改 DOM**，所以每个页面必须新建 JSDOM
 *  2. 相对 URL 需要 JSDOM 知道页面 url，否则链接全是相对路径
 *  3. 它不执行 JS，SPA 站点只能拿到空壳 —— 这类必须靠检索器自带正文兜底
 */

import { JSDOM, VirtualConsole } from "jsdom";
import { Readability } from "@mozilla/readability";
import robotsParser from "robots-parser";

import { sleep, TokenBucket, USER_AGENT, fetchText } from "./limits.js";
import { canonicalize } from "./normalize.js";

export interface FetchOptions {
  readonly signal?: AbortSignal;
  readonly respectRobots?: boolean;
  readonly timeoutMs?: number;
  readonly maxChars?: number;
}

export interface FetchedPage {
  readonly url: string;
  readonly finalUrl: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly text: string;
  readonly status: number;
  readonly contentType: string;
  readonly etag?: string;
  readonly by: "readability" | "provider" | "none";
  readonly error?: string;
  readonly blockedByRobots?: boolean;
}

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
const robotsCache = new Map<string, { at: number; parser: ReturnType<typeof robotsParser> }>();
const hostBuckets = new Map<string, TokenBucket>();

/**
 * 抓取一个页面并抽取正文。
 *
 * 返回对象而非抛错：抓取失败在研究流程里是**常态**（付费墙、反爬、死链），
 * 让它变成异常会逼得调用方到处 try/catch，最后干脆忽略。
 */
export async function fetchPage(
  url: string,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  const canonicalUrl = canonicalize(url);

  if (options.signal?.aborted) {
    return empty(canonicalUrl, url, "aborted");
  }

  if (options.respectRobots !== false) {
    const allowed = await robotsAllows(url, options.signal);
    if (allowed === false) {
      return { ...empty(canonicalUrl, url, "blocked by robots.txt"), blockedByRobots: true };
    }
  }

  const host = safeHost(url);
  const bucket = hostBucket(host);
  if (!(await bucket.take(options.signal))) {
    return empty(canonicalUrl, url, "aborted");
  }

  const result = await fetchText(url, {
    timeoutMs: options.timeoutMs ?? 12_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!result.ok || result.body.length === 0) {
    return {
      ...empty(canonicalUrl, result.url || url, `HTTP ${result.status || "network error"}`),
      status: result.status,
    };
  }

  if (!/html|xml/i.test(result.contentType)) {
    return {
      ...empty(canonicalUrl, result.url, `unsupported content-type: ${result.contentType || "unknown"}`),
      status: result.status,
      contentType: result.contentType,
    };
  }

  const extracted = extractWithReadability(result.body, result.url);
  const maxChars = options.maxChars ?? 60_000;

  return {
    url,
    finalUrl: result.url,
    canonicalUrl,
    title: extracted.title,
    text: extracted.text.slice(0, maxChars),
    status: result.status,
    contentType: result.contentType,
    ...(result.etag ? { etag: result.etag } : {}),
    by: extracted.text.length > 0 ? "readability" : "none",
    ...(extracted.text.length === 0 ? { error: "no main content extracted (likely JS-rendered)" } : {}),
  };
}

/**
 * 用 Readability 抽正文。
 *
 * VirtualConsole 静音：真实网页满是 CSS 解析错误与资源加载失败，
 * 不静音的话控制台会被无关噪声淹没。
 */
export function extractWithReadability(
  html: string,
  url: string,
): { title: string; text: string } {
  try {
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });
    const reader = new Readability(dom.window.document.cloneNode(true) as Document);
    const article = reader.parse();
    dom.window.close();

    const title = (article?.title ?? dom.window.document.title ?? "").trim();
    const text = normalizeText(article?.textContent ?? "");
    return { title: title || url, text };
  } catch {
    return { title: url, text: "" };
  }
}

/** HEAD 探测，用于归档前的引用存活校验。 */
export async function headCheck(
  url: string,
  signal?: AbortSignal,
): Promise<{ at: string; status: number }> {
  const result = await fetchText(url, { method: "HEAD", timeoutMs: 8_000, ...(signal ? { signal } : {}) });
  return { at: new Date().toISOString(), status: result.status };
}

async function robotsAllows(url: string, signal?: AbortSignal): Promise<boolean | undefined> {
  const host = safeHost(url);
  if (!host) return undefined;

  let entry = robotsCache.get(host);
  if (!entry || Date.now() - entry.at > ROBOTS_TTL_MS) {
    const origin = `https://${host}`;
    const response = await fetchText(`${origin}/robots.txt`, {
      timeoutMs: 6_000,
      accept: "text/plain",
      ...(signal ? { signal } : {}),
    });
    // 拿不到 robots.txt 视为允许（RFC 9309 的惯例），但要限速
    const parser = robotsParser(origin, response.ok ? response.body : "");
    entry = { at: Date.now(), parser };
    robotsCache.set(host, entry);
  }

  const crawlDelay = entry.parser.getCrawlDelay?.(USER_AGENT);
  if (typeof crawlDelay === "number" && crawlDelay > 0) {
    await sleep(Math.min(crawlDelay * 1000, 10_000), signal);
  }
  return entry.parser.isAllowed(url, USER_AGENT) ?? true;
}

function hostBucket(host: string): TokenBucket {
  let bucket = hostBuckets.get(host);
  if (!bucket) {
    // 每 host 1 并发 + 1.2 秒间隔，同时对 50 个站点仍有 40+ QPS 的聚合速度
    bucket = new TokenBucket(2, 1_200);
    hostBuckets.set(host, bucket);
  }
  return bucket;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function empty(canonicalUrl: string, url: string, error: string): FetchedPage {
  return {
    url,
    finalUrl: url,
    canonicalUrl,
    title: canonicalUrl,
    text: "",
    status: 0,
    contentType: "",
    by: "none",
    error,
  };
}
