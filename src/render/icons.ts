/**
 * 图标来源：Lucide（`lucide-static`，统一 24px 描边风格）。
 *
 * 项目锁定的唯一图标来源。禁止任何 emoji 充当功能图标 ——
 * emoji 在不同系统上渲染差异极大，无法统一描边与尺寸，且在无障碍读屏里
 * 会被念成一串莫名其妙的词。
 *
 * SVG 在运行时从 `lucide-static/icons/` 读取并内联，因此产物是单文件 HTML，
 * 不依赖 CDN、不依赖网络。
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const cache = new Map<string, string>();

/**
 * CJS 产物里 `import.meta` 会被打包器替换成空对象，
 * 直接 `createRequire(undefined)` 会抛 ERR_INVALID_ARG_TYPE。
 * 所以这里兜一层：拿不到自身 URL 就退回 cwd。
 */
const require = createRequire(moduleUrl());

function moduleUrl(): string {
  try {
    const url = import.meta.url;
    if (typeof url === "string" && url.length > 0) return url;
  } catch {
    /* CJS 环境下 import.meta 不可用 */
  }
  return `file://${join(process.cwd(), "index.js")}`;
}

let iconsDir: string | null | undefined;

function resolveIconsDir(): string | null {
  if (iconsDir !== undefined) return iconsDir;
  try {
    iconsDir = join(require.resolve("lucide-static/package.json"), "..", "icons");
  } catch {
    iconsDir = null;
  }
  return iconsDir;
}

/**
 * 取一个 Lucide 图标的内联 SVG 内容（不含外层 <svg>）。
 * 图标不存在时返回空串 —— 缺图标比塞个占位方块体面。
 */
export function icon(name: string, size = 16): string {
  const key = `${name}@${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const dir = resolveIconsDir();
  let inner = "";
  if (dir) {
    try {
      const svg = readFileSync(join(dir, `${name}.svg`), "utf8");
      inner = svg
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<svg[^>]*>/i, "")
        .replace(/<\/svg>/i, "")
        .trim();
    } catch {
      inner = "";
    }
  }

  const result = inner
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`
    : "";

  cache.set(key, result);
  return result;
}

/** 报告里用到的图标名集中在此，便于一眼看出用了哪些、有没有混别的库。 */
export const ICONS = {
  shield: "shield-check",
  link: "link",
  alert: "triangle-alert",
  contested: "scale",
  book: "book-open",
  clock: "clock",
  check: "check",
  chevron: "chevron-right",
  database: "database",
  search: "search",
  fileText: "file-text",
  compass: "compass",
} as const;
