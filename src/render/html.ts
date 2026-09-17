/**
 * 单文件 HTML 报告。
 *
 * 约束（都是刻意的）：
 *  - **零外部依赖**：CSS 内联、SVG 内联。报告要能被邮件转发、被归档、被离线打开，
 *    任何 CDN 引用都会让它在三年后变成一堆裸文本。
 *  - **禁用 emoji 图标**：全部用 Lucide SVG（见 icons.ts）。
 *  - **不做紫粉渐变、不做发光、不做毛玻璃**：这是编辑排版，不是落地页。
 *  - **引用可跳转**：正文编号 → 来源列表 → 原文 URL，三级可达。
 */

import type { Claim, Ref, ResearchResult } from "../types.js";
import { ICONS, icon } from "./icons.js";
import { miniMarkdown } from "./markdown-inline.js";
import { renderMarkdown } from "./markdown.js";

export function renderHtml(result: ResearchResult): string {
  const rendered = renderMarkdown(result, {
    includeEvidenceAppendix: false,
    includeUnusedSources: false,
  });
  const numbers = rendered.numbers;

  const claimRefs = new Map<string, string[]>();
  for (const claim of Object.values(result.claims)) {
    const refIds = new Set<string>();
    for (const evidenceId of claim.evidenceIds) {
      const item = result.evidence[evidenceId];
      if (item) refIds.add(item.refId);
    }
    claimRefs.set(claim.id, [...refIds]);
  }

  const citeFor = (claimId: string): string => {
    const refIds = claimRefs.get(claimId) ?? [];
    return refIds
      .map((refId) => numbers.get(refId) ?? 0)
      .filter((value) => value > 0)
      .sort((a, b) => a - b)
      .map((value) => `<a class="cite" href="#ref-${value}">${value}</a>`)
      .join(" ");
  };

  /* ── 正文 ─────────────────────────────────────────────────────── */

  const sections = result.report.sections
    .map((section, index) => {
      // 顺序要紧：miniMarkdown 会转义正文里的 HTML，
      // 先注入 <a> 再转义的话，引用锚点会变成裸文本。
      // 而 [claim:xxx] 只含安全字符，转义前后不变，所以放在渲染之后替换是安全的。
      const body = miniMarkdown(section.body).replace(
        /\[claim:([A-Za-z0-9_-]+)\]/g,
        (_match, claimId: string) => citeFor(claimId),
      );
      const contested = section.claimIds
        .map((id) => result.claims[id])
        .filter((claim): claim is Claim => Boolean(claim) && claim?.support === "contested");

      const flags =
        contested.length > 0
          ? `<p class="section-flag">${icon(ICONS.contested, 14)} 本节含 ${contested.length} 条存在冲突的声明，报告并列呈现了双方说法。</p>`
          : "";

      return `<section id="sec-${index + 1}">
  <h2><span class="sec-no">${index + 1}</span>${escapeText(section.heading)}</h2>
  ${flags}
  ${body}
</section>`;
    })
    .join("\n");

  /* ── 来源 ─────────────────────────────────────────────────────── */

  const sources = rendered.citationOrder
    .map((refId) => result.refs[refId])
    .filter((ref): ref is Ref => Boolean(ref))
    .map((ref) => {
      const number = numbers.get(ref.id) ?? 0;
      const supported = [...claimRefs.values()].filter((ids) => ids.includes(ref.id)).length;
      return `<li id="ref-${number}" class="ref">
    <span class="ref-no">${number}</span>
    <div class="ref-body">
      <a class="ref-title" href="${escapeAttr(ref.canonicalUrl)}" target="_blank" rel="noopener noreferrer">${escapeText(ref.title || ref.canonicalUrl)} ${icon(ICONS.link, 13)}</a>
      <div class="ref-meta">
        <span class="tag tag-${ref.siteKind}">${siteLabel(ref.siteKind)}</span>
        ${ref.publisher ? `<span>${escapeText(ref.publisher)}</span>` : ""}
        ${ref.publishedAt ? `<span>${escapeText(ref.publishedAt.slice(0, 10))}</span>` : ""}
        <span class="dim">抓取于 ${escapeText(ref.fetch.at.slice(0, 10))}</span>
        <span class="dim">支撑 ${supported} 条声明</span>
      </div>
      <div class="ref-url">${escapeText(ref.canonicalUrl)}</div>
    </div>
  </li>`;
    })
    .join("\n");

  /* ── 证据附录 ─────────────────────────────────────────────────── */

  const appendix = [...rendered.usedClaims]
    .map((claimId) => result.claims[claimId])
    .filter((claim): claim is Claim => Boolean(claim))
    .map((claim) => {
      const quotes = claim.evidenceIds
        .map((evidenceId) => result.evidence[evidenceId])
        .filter((item) => Boolean(item))
        .map((item) => {
          const ref = result.refs[item?.refId ?? ""];
          const number = ref ? (numbers.get(ref.id) ?? 0) : 0;
          const kind = item?.confidence === "direct" ? "逐字" : "近似";
          return `<li><span class="quote-kind quote-kind-${item?.confidence}">${kind}</span><span class="quote-src">[${number}]</span> ${escapeText(item?.quote ?? "")}</li>`;
        })
        .join("");
      return `<li class="claim" data-support="${claim.support}">
      <div class="claim-head">${supportIcon(claim.support)}<code>${escapeText(claim.id)}</code></div>
      <p class="claim-text">${escapeText(claim.statement)}</p>
      <ul class="quotes">${quotes}</ul>
      ${claim.note ? `<p class="claim-note">${escapeText(claim.note)}</p>` : ""}
    </li>`;
    })
    .join("\n");

  /* ── 审计 ─────────────────────────────────────────────────────── */

  const audit = result.audit;
  const metrics: readonly [string, string, string][] = [
    [ICONS.fileText, "声明总数", String(audit.claimsTotal)],
    [
      audit.claimsUnverified === 0 ? ICONS.check : ICONS.alert,
      "无证据声明",
      String(audit.claimsUnverified),
    ],
    [ICONS.contested, "冲突声明", String(audit.claimsContested)],
    [ICONS.book, "引用来源", `${audit.refsUsed} / ${audit.refsTotal}`],
    [ICONS.database, "每声明来源数", String(audit.evidencePerClaim)],
    [ICONS.clock, "耗时", `${(result.durationMs / 1000).toFixed(1)}s`],
  ];

  const metricCards = metrics
    .map(
      ([name, label, value]) => `<div class="metric">
      <span class="metric-icon">${icon(name, 15)}</span>
      <span class="metric-value">${escapeText(value)}</span>
      <span class="metric-label">${escapeText(label)}</span>
    </div>`,
    )
    .join("\n");

  const warnings =
    audit.warnings.length > 0
      ? `<details class="warnings"><summary>${icon(ICONS.alert, 14)} 执行告警（${audit.warnings.length}）</summary><ul>${audit.warnings
          .map((item) => `<li>${escapeText(item)}</li>`)
          .join("")}</ul></details>`
      : "";

  const unusedList = result.report.unusedRefIds
    .map((id) => result.refs[id])
    .filter((ref): ref is Ref => Boolean(ref))
    .map(
      (ref) =>
        `<li><a href="${escapeAttr(ref.canonicalUrl)}" target="_blank" rel="noopener noreferrer">${escapeText(ref.title || ref.canonicalUrl)}</a></li>`,
    )
    .join("");

  const toc = result.report.sections
    .map(
      (section, index) =>
        `<li><a href="#sec-${index + 1}"><span>${index + 1}</span>${escapeText(section.heading)}</a></li>`,
    )
    .join("\n");

  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(result.question)} · 研究报告</title>
<meta name="generator" content="aether-research" />
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfaf8;
  --panel: #ffffff;
  --ink: #1c1917;
  --ink-soft: #57534e;
  --ink-dim: #8a857f;
  --line: #e7e3dd;
  --accent: #0d5c63;
  --accent-soft: #e6f1f1;
  --warn: #9a3412;
  --warn-soft: #fdf0e7;
  --ok: #166534;
  --ok-soft: #eaf3ec;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
    "Noto Sans SC", "Microsoft YaHei", sans-serif;
  --serif: Georgia, "Songti SC", "Noto Serif SC", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #131211;
    --panel: #1b1a18;
    --ink: #ece8e3;
    --ink-soft: #b3ada5;
    --ink-dim: #7d766e;
    --line: #2e2b28;
    --accent: #5eead4;
    --accent-soft: #12302e;
    --warn: #fdba74;
    --warn-soft: #33210f;
    --ok: #86efac;
    --ok-soft: #122a19;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: var(--font);
  font-size: 16px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1160px; margin: 0 auto; padding: 40px 24px 96px; }
header.report-head { border-bottom: 1px solid var(--line); padding-bottom: 28px; margin-bottom: 8px; }
h1 { font-family: var(--serif); font-size: clamp(26px, 4vw, 38px); line-height: 1.3; margin: 0 0 12px; letter-spacing: -0.01em; }
.meta { color: var(--ink-dim); font-size: 13px; display: flex; gap: 14px; flex-wrap: wrap; align-items: center; }
.meta span { display: inline-flex; align-items: center; gap: 5px; }
.stance {
  background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent);
  border-radius: var(--radius); padding: 16px 20px; margin: 24px 0 8px;
}
.stance h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-dim); margin: 0 0 8px; font-weight: 600; }
.stance p { margin: 0; color: var(--ink-soft); }
.scope { color: var(--ink-dim); font-size: 13px; margin: 12px 0 0; }
.layout { display: grid; grid-template-columns: 1fr; gap: 40px; }
@media (min-width: 960px) { .layout { grid-template-columns: 220px 1fr; gap: 48px; align-items: start; } }
nav.toc { position: sticky; top: 24px; font-size: 13px; }
nav.toc h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-dim); margin: 0 0 10px; font-weight: 600; }
nav.toc ol { list-style: none; margin: 0; padding: 0; }
nav.toc a { display: flex; gap: 8px; padding: 5px 0; color: var(--ink-soft); text-decoration: none; border-left: 2px solid transparent; padding-left: 10px; }
nav.toc a:hover { color: var(--accent); border-left-color: var(--accent); }
nav.toc a span { color: var(--ink-dim); font-variant-numeric: tabular-nums; min-width: 14px; }
section { margin: 0 0 44px; scroll-margin-top: 24px; }
section h2 { font-family: var(--serif); font-size: 22px; margin: 0 0 14px; display: flex; gap: 10px; align-items: baseline; line-height: 1.4; }
.sec-no { color: var(--ink-dim); font-size: 13px; font-variant-numeric: tabular-nums; font-family: var(--mono); }
section p { margin: 0 0 14px; }
section ul { margin: 0 0 14px; padding-left: 22px; }
section li { margin-bottom: 6px; }
blockquote { margin: 14px 0; padding: 12px 18px; border-left: 3px solid var(--line); color: var(--ink-soft); background: var(--panel); border-radius: 0 var(--radius) var(--radius) 0; }
code { font-family: var(--mono); font-size: 0.88em; background: var(--accent-soft); color: var(--accent); padding: 1px 5px; border-radius: 4px; }
a.cite { font-size: 12px; font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 1px 5px; border-radius: 4px; text-decoration: none; vertical-align: super; margin-left: 2px; font-variant-numeric: tabular-nums; }
a.cite:hover { text-decoration: underline; }
.section-flag { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--warn); background: var(--warn-soft); border-radius: 6px; padding: 5px 10px; margin: 0 0 14px; }
.section-flag svg { flex: none; }
h2.part { font-family: var(--font); font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-dim); border-top: 1px solid var(--line); padding-top: 28px; margin: 52px 0 20px; font-weight: 600; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 0 0 20px; }
.metric { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
.metric-icon { color: var(--ink-dim); }
.metric-value { font-size: 24px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.2; }
.metric-label { font-size: 12px; color: var(--ink-dim); }
ol.refs { list-style: none; margin: 0; padding: 0; }
li.ref { display: flex; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.ref-no { font-family: var(--mono); font-size: 12px; color: var(--ink-dim); padding-top: 3px; min-width: 22px; font-variant-numeric: tabular-nums; }
.ref-body { min-width: 0; }
.ref-title { color: var(--ink); font-weight: 600; text-decoration: none; display: inline-flex; gap: 5px; align-items: center; }
.ref-title:hover { color: var(--accent); }
.ref-title svg { opacity: 0.5; }
.ref-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 12px; color: var(--ink-soft); margin-top: 5px; }
.dim { color: var(--ink-dim); }
.ref-url { font-family: var(--mono); font-size: 11px; color: var(--ink-dim); margin-top: 4px; word-break: break-all; }
.tag { border: 1px solid var(--line); border-radius: 999px; padding: 0 8px; font-size: 11px; background: var(--bg); }
.tag-paper, .tag-gov, .tag-institution { border-color: var(--accent); color: var(--accent); }
.tag-ugc { border-color: var(--warn); color: var(--warn); }
ul.claims { list-style: none; margin: 0; padding: 0; }
li.claim { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 14px 18px; margin-bottom: 12px; }
.claim-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.claim-head[data-support="contested"] { color: var(--warn); }
.claim-text { margin: 0 0 10px; font-weight: 550; }
ul.quotes { list-style: none; margin: 0; padding: 0; font-size: 14px; color: var(--ink-soft); }
ul.quotes li { display: flex; gap: 8px; margin-bottom: 8px; align-items: baseline; }
.quote-kind { border: 1px solid var(--line); border-radius: 4px; font-size: 10px; padding: 1px 5px; flex: none; color: var(--ink-dim); }
.quote-kind-direct { border-color: var(--ok); color: var(--ok); }
.quote-src { font-family: var(--mono); font-size: 11px; color: var(--accent); flex: none; }
.claim-note { font-size: 13px; color: var(--ink-dim); margin: 8px 0 0; padding-top: 8px; border-top: 1px dashed var(--line); }
.warnings { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 12px 16px; margin-top: 16px; font-size: 13px; }
.warnings summary { cursor: pointer; color: var(--ink-soft); display: flex; align-items: center; gap: 6px; }
.warnings ul { margin: 10px 0 0; padding-left: 20px; color: var(--ink-dim); }
footer { margin-top: 64px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--ink-dim); font-size: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
</head>
<body>
<div class="wrap">
<header class="report-head">
  <h1>${escapeText(result.question)}</h1>
  <div class="meta">
    <span>${icon(ICONS.clock, 13)} ${escapeText(generatedAt)} UTC</span>
    <span>${icon(ICONS.book, 13)} ${result.report.sections.length} 节</span>
    <span>${icon(ICONS.search, 13)} ${result.usage.searches} 次检索 · ${result.usage.fetches} 次抓取</span>
    <span>${icon(ICONS.shield, 13)} 运行 ${escapeText(result.runId)}</span>
  </div>
</header>

<div class="stance">
  <h2>${icon(ICONS.compass, 13)} 研究口径</h2>
  <p>${escapeText(result.report.interpretation)}</p>
  ${
    result.plan.outOfScope.length > 0
      ? `<p class="scope"><strong>明确排除：</strong>${escapeText(result.plan.outOfScope.join("；"))}</p>`
      : ""
  }
</div>

<div class="layout">
  <nav class="toc">
    <h3>目录</h3>
    <ol>${toc}</ol>
  </nav>
  <main>
    ${sections}

    <h2 class="part">${icon(ICONS.book, 14)} 参考来源</h2>
    <ol class="refs">
${sources}
    </ol>

    <h2 class="part">${icon(ICONS.database, 14)} 逐条声明与原文证据</h2>
    <ul class="claims">
${appendix}
    </ul>

    ${
      unusedList
        ? `<h2 class="part">${icon(ICONS.search, 14)} 查阅但未引用</h2>
    <p class="scope">以下来源被抓取但未被任何声明引用。列出它们是为了让研究的边界可见 —— 它们不代表结论。</p>
    <ul class="quotes">${unusedList}</ul>`
        : ""
    }

    <h2 class="part">${icon(ICONS.shield, 14)} 质量审计</h2>
    <div class="metrics">
${metricCards}
    </div>
    ${warnings}
  </main>
</div>

<footer>
  ${icon(ICONS.shield, 13)}
  <span>由 aether-research 生成 · 每条声明均可回溯至逐字原文摘录 · 无证据声明数 ${audit.claimsUnverified}</span>
</footer>
</div>
</body>
</html>`;
}

function supportIcon(support: Claim["support"]): string {
  if (support === "contested") return icon(ICONS.contested, 14);
  if (support === "unverified") return icon(ICONS.alert, 14);
  return icon(ICONS.check, 14);
}

const SITE_LABELS: Readonly<Record<Ref["siteKind"], string>> = {
  paper: "学术论文",
  gov: "政府/监管",
  institution: "机构/国际组织",
  news: "新闻媒体",
  docs: "官方文档",
  ugc: "用户内容",
  other: "其他",
};

function siteLabel(kind: Ref["siteKind"]): string {
  return SITE_LABELS[kind];
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
