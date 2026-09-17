/**
 * URL 规范化与近似去重。
 *
 * 为什么要较真：同一篇论文会有 doi.org 链接、出版社页面、PDF 直链、
 * 带 utm 的分享链接等五六种 URL 形式。不规范化，报告里就会出现
 * "引用 5 条其实是同一篇"的水分 —— 这正是"引用数当 KPI"最典型的注水方式。
 */

import { createHash } from "node:crypto";

import normalizeUrl from "normalize-url";

/** 规范化的 URL：去 utm 等追踪参数、统一协议与 www、排序查询参数。 */
export function canonicalize(url: string): string {
  try {
    return normalizeUrl(url, {
      defaultProtocol: "https",
      normalizeProtocol: true,
      removeTrailingSlash: true,
      removeSingleSlash: false,
      sortQueryParameters: true,
      stripWWW: true,
      stripHash: true,
      stripAuthentication: false,
      removeQueryParameters: [
        /^utm_\w+/i,
        /^ga_/i,
        /^mc_/i,
        /^_ga\w*/i,
        /^_hs\w*/i,
        /^ref$/i,
        /^ref_src$/i,
        /^spm$/i,
        /^from$/i,
      ],
    });
  } catch {
    return url;
  }
}

/**
 * 身份 URL：在规范化基础上抹平 http/https 差异。
 *
 * 为什么单独一层：抓取与展示必须用**原始** URL（http-only 站点被升级成 https
 * 会直接打不开），但"这两条命中是不是同一篇"的判定必须忽略协议 ——
 * 现实中大量站点给同一篇文章同时提供两种协议的链接，把协议计入身份
 * 就会得到"引用 5 条其实 3 条是同一篇"的水分。
 */
export function identityOf(url: string): string {
  return canonicalize(url).replace(/^http:/i, "https:");
}

/** 稳定的来源 ID：同一篇文章永远得到同一 id，跨运行可复现。 */
export function refIdOf(url: string): string {
  return createHash("sha1").update(identityOf(url)).digest("hex").slice(0, 16);
}

export function sha256Of(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 64 位 SimHash。
 *
 * 自研而不用库：核心只有 20 行，引一个依赖不划算，
 * 而且我们需要能针对中英混排调 n-gram 大小。
 */
export function simhash(text: string): bigint {
  const tokens = ngrams(text);
  const vector = new Array<number>(64).fill(0);

  for (const token of tokens) {
    const digest = createHash("sha1").update(token).digest();
    for (let i = 0; i < 8; i += 1) {
      const byte = digest[i] as number;
      for (let bit = 0; bit < 8; bit += 1) {
        const index = i * 8 + bit;
        vector[index] = (vector[index] as number) + ((byte >> bit) & 1 ? 1 : -1);
      }
    }
  }

  let hash = 0n;
  for (let i = 0; i < 64; i += 1) {
    if ((vector[i] as number) > 0) hash |= 1n << BigInt(i);
  }
  return hash;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

/** 汉明距离 ≤ 3 视为近似重复：这个阈值对新闻转载与镜像站效果最好。 */
export const NEAR_DUP_THRESHOLD = 3;

export class Deduper {
  private readonly seen = new Map<string, bigint>();

  /** 返回 true 表示这是新内容；false 表示与已有内容重复。 */
  add(id: string, text: string): boolean {
    const hash = simhash(text);
    for (const existing of this.seen.values()) {
      if (hamming(existing, hash) <= NEAR_DUP_THRESHOLD) return false;
    }
    this.seen.set(id, hash);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

function ngrams(text: string, size = 5): readonly string[] {
  const cleaned = text.toLowerCase().replace(/\s+/g, "");
  if (cleaned.length === 0) return [];
  // 中文按字切（无空格），英文按词切，混排时两者都保留
  const cjk = cleaned.match(/[\u4e00-\u9fa5]/g);
  const words = cleaned.match(/[a-z0-9]+/g) ?? [];
  const grams: string[] = [];

  if (cjk && cjk.length > size) {
    for (let i = 0; i + size <= cjk.length; i += 1) grams.push(cjk.slice(i, i + size).join(""));
  } else if (cjk) {
    grams.push(cjk.join(""));
  }

  if (words.length >= size) {
    for (let i = 0; i + size <= words.length; i += 2) grams.push(words.slice(i, i + size).join(""));
  } else if (words.length > 0) {
    grams.push(words.join(""));
  }

  return grams.length > 0 ? grams : [cleaned];
}
