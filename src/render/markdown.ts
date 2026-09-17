/**
 * Markdown 渲染。
 *
 * **引用编号在这里才生成。** 存储期不存在"第 N 条引用"这个概念 ——
 * 这是不变量 1 能成立的前提：编号由渲染期 join(Claim → Evidence → Ref) 算出，
 * 所以无论并行顺序如何、上下文是否压缩过，编号都不会漂移。
 *
 * 编号顺序按**首次出现**，不是按来源重要性。读者要能顺着编号找到出处，
 * 任何别的排序规则都会让"引用 7"出现在"引用 3"之前，制造不必要的困惑。
 */

import type {
  Claim,
  Evidence,
  Ref,
  ResearchResult,
  ReportSection,
} from "../types.js";

export interface RenderedReport {
  readonly markdown: string;
  /** 引用编号 → refId，按出现顺序。 */
  readonly citationOrder: readonly string[];
  readonly numbers: ReadonlyMap<string, number>;
  /** 正文中实际被引用的 claim。 */
  readonly usedClaims: ReadonlySet<string>;
}

export interface RenderOptions {
  /** 附上"声明 → 逐字证据"对照表。审计时用，日常阅读可关。 */
  readonly includeEvidenceAppendix?: boolean;
  /** 附上"读了但没被引用的来源"。让遗漏可见。 */
  readonly includeUnusedSources?: boolean;
}

export function renderMarkdown(
  result: ResearchResult,
  options: RenderOptions = {},
): RenderedReport {
  const numbers = new Map<string, number>();
  const citationOrder: string[] = [];
  const usedClaims = new Set<string>();
  const claimRefs = new Map<string, string[]>();

  const numberFor = (refId: string): number => {
    const existing = numbers.get(refId);
    if (existing !== undefined) return existing;
    const next = citationOrder.length + 1;
    numbers.set(refId, next);
    citationOrder.push(refId);
    return next;
  };

  const resolveClaim = (claimId: string): number[] => {
    const claim = result.claims[claimId];
    if (!claim) return [];
    usedClaims.add(claimId);
    const refIds = new Set<string>();
    for (const evidenceId of claim.evidenceIds) {
      const item = result.evidence[evidenceId];
      if (item) refIds.add(item.refId);
    }
    claimRefs.set(claimId, [...refIds]);
    const nums = [...refIds].map(numberFor).sort((a, b) => a - b);
    return nums;
  };

  /* ── 正文 ───────────────────────────────────────────────────── */

  const blocks: string[] = [];

  blocks.push(`# ${result.question}`);
  blocks.push(
    metaLine(result),
    ``,
    `## 研究口径`,
    ``,
    result.report.interpretation,
  );

  if (result.plan.outOfScope.length > 0) {
    blocks.push(``, `> **明确排除**：${result.plan.outOfScope.join("；")}`);
  }

  for (const [index, section] of result.report.sections.entries()) {
    blocks.push(
      ``,
      `## ${index + 1}. ${section.heading}`,
      ``,
      renderBody(section, resolveClaim),
    );
  }

  /* ── 参考来源 ───────────────────────────────────────────────── */

  blocks.push(``, `## 参考来源`, ``);
  if (citationOrder.length === 0) {
    blocks.push(`（本报告未引用任何来源。）`);
  } else {
    for (const refId of citationOrder) {
      const ref = result.refs[refId];
      if (!ref) continue;
      const number = numbers.get(refId) ?? 0;
      const citedBy = [...claimRefs.entries()]
        .filter(([, refIds]) => refIds.includes(refId))
        .map(([claimId]) => claimId);
      blocks.push(renderRef(number, ref, citedBy.length));
    }
  }

  /* ── 附录 ───────────────────────────────────────────────────── */

  if (options.includeEvidenceAppendix !== false) {
    blocks.push(``, `## 附录 A：声明 → 逐字证据`, ``);
    const rows = [...usedClaims]
      .map((claimId) => result.claims[claimId])
      .filter((claim): claim is Claim => Boolean(claim));
    if (rows.length === 0) {
      blocks.push(`（无。）`);
    } else {
      for (const claim of rows) {
        blocks.push(`**${claim.id}** · ${supportLabel(claim.support)}`);
        blocks.push(`> ${claim.statement}`);
        for (const evidenceId of claim.evidenceIds) {
          const item = result.evidence[evidenceId];
          if (!item) continue;
          const ref = result.refs[item.refId];
          const number = ref ? (numbers.get(ref.id) ?? 0) : 0;
          blocks.push(
            `- [${number}] ${item.confidence === "direct" ? "逐字" : "近似"}：${item.quote}`,
          );
        }
        if (claim.note) blocks.push(`- 备注：${claim.note}`);
        blocks.push(``);
      }
    }
  }

  const unused = result.report.unusedRefIds
    .map((id) => result.refs[id])
    .filter((ref): ref is Ref => Boolean(ref));
  if (options.includeUnusedSources !== false) {
    blocks.push(``, `## 附录 B：读了但未引用的来源`, ``);
    if (unused.length === 0) {
      blocks.push(`（无 —— 所有抓取的来源都被引用了。）`);
    } else {
      blocks.push(
        `列出这些是为了让"查过但没用上"可见。它们不代表结论，只代表研究边界。`,
        ``,
      );
      for (const ref of unused) {
        blocks.push(`- ${ref.title || ref.canonicalUrl} — ${ref.canonicalUrl}`);
      }
    }
  }

  /* ── 审计 ───────────────────────────────────────────────────── */

  blocks.push(``, `## 质量审计`, ``);
  blocks.push(renderAudit(result));
  blocks.push(``);

  return {
    markdown: blocks.join("\n"),
    citationOrder,
    numbers,
    usedClaims,
  };
}

/* ── 片段 ────────────────────────────────────────────────────────── */

function renderBody(
  section: ReportSection,
  resolveClaim: (claimId: string) => number[],
): string {
  return section.body.replace(/\[claim:([A-Za-z0-9_-]+)\]/g, (_match, claimId: string) => {
    const nums = resolveClaim(claimId);
    if (nums.length === 0) return "";
    return `[${nums.join(", ")}]`;
  });
}

function renderRef(number: number, ref: Ref, citedBy: number): string {
  const bits = [ref.publisher, siteLabel(ref.siteKind), ref.publishedAt?.slice(0, 10)].filter(
    (value): value is string => Boolean(value),
  );
  const head = bits.length > 0 ? ` — ${bits.join(" · ")}` : "";
  const fetched = `抓取于 ${ref.fetch.at.slice(0, 10)}`;
  const usage = citedBy > 0 ? ` · 支撑 ${citedBy} 条声明` : "";
  return `[${number}] **${ref.title || ref.canonicalUrl}**${head}\n    ${ref.canonicalUrl}\n    ${fetched}${usage}`;
}

function renderAudit(result: ResearchResult): string {
  const audit = result.audit;
  const rows: string[] = [
    `| 指标 | 值 |`,
    `| --- | --- |`,
    `| 声明总数 | ${audit.claimsTotal} |`,
    `| **无证据声明（必须为 0）** | ${audit.claimsUnverified} |`,
    `| 存在冲突的声明 | ${audit.claimsContested} |`,
    `| 来源总数 / 被引用 | ${audit.refsUsed} / ${audit.refsTotal} |`,
    `| 每条声明的平均独立来源数 | ${audit.evidencePerClaim} |`,
    `| 失效链接 | ${audit.deadLinks} |`,
    `| 完成状态 | ${result.finishReason} |`,
    `| 耗时 | ${(result.durationMs / 1000).toFixed(1)}s |`,
    `| 模型成本 / 检索成本 | $${result.usage.modelUsd.toFixed(4)} / $${result.usage.searchUsd.toFixed(4)} |`,
    `| 检索次数 / 抓取次数（失败） | ${result.usage.searches} / ${result.usage.fetches}（${result.usage.fetchFailures}） |`,
  ];

  if (audit.warnings.length > 0) {
    rows.push(``, `**执行过程中的告警：**`, ``);
    for (const warning of audit.warnings.slice(0, 20)) rows.push(`- ${warning}`);
    if (audit.warnings.length > 20) rows.push(`- ……另有 ${audit.warnings.length - 20} 条`);
  }

  return rows.join("\n");
}

function metaLine(result: ResearchResult): string {
  const parts = [
    `生成时间 ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `运行 ID ${result.runId}`,
    `${result.report.sections.length} 节`,
  ];
  return `*${parts.join(" · ")}*`;
}

const SITE_LABELS: Readonly<Record<Ref["siteKind"], string>> = {
  paper: "学术论文",
  gov: "政府/监管",
  institution: "国际组织/机构",
  news: "新闻媒体",
  docs: "官方文档",
  ugc: "用户生成内容",
  other: "其他",
};

function siteLabel(kind: Ref["siteKind"]): string {
  return SITE_LABELS[kind];
}

function supportLabel(support: Claim["support"]): string {
  switch (support) {
    case "contested":
      return "存在冲突";
    case "unverified":
      return "证据不足";
    default:
      return "已确证";
  }
}

/** 机器可读导出：给下游程序消费，不给人读。 */
export function toJson(result: ResearchResult): string {
  const evidence: Record<string, Evidence> = {};
  for (const claimId of renderMarkdown(result, { includeEvidenceAppendix: false }).usedClaims) {
    const claim = result.claims[claimId];
    if (!claim) continue;
    for (const evidenceId of claim.evidenceIds) {
      const item = result.evidence[evidenceId];
      if (item) evidence[evidenceId] = item;
    }
  }
  return JSON.stringify({ ...result, evidence }, null, 2);
}
