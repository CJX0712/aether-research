/**
 * 从证据合成声明。
 *
 * 这一步是"引文 → 结论"的跨越，也是幻觉最容易混入的地方，所以有两条硬约束：
 *
 * 1. **声明只能引用喂给它的 evidenceId。** 模型编 id 是常见失败模式
 *    （尤其是把两条不同来源的引文"合并"成一个不存在的第三条）。
 *    所有 id 在 Ledger 入库时被校验，编造的直接丢。
 *
 * 2. **声明不得超出引文的断言强度。** 引文说"约 30%"，声明不能说"30%"；
 *    引文是某家公司自述，声明不能写成行业事实。提示词里反复强调，
 *    并且**要求模型为每条声明自报是否有保留意见**（note）。
 *
 * 还有一条刻意的产物设计：**要求模型主动写"没找到证据的问题"**。
 * 这是对抗"因遗漏而误导"最便宜的手段 —— 让空白显式出现在报告里，
 * 而不是被流畅的文字盖过去。
 */

import { z } from "zod";

import type { Llm } from "../llm/model.js";
import type { Claim, Evidence, Ref, SubQuestion } from "../types.js";
import { siteRank } from "./extract.js";

export const claimSchema = z.object({
  statement: z
    .string()
    .min(8)
    .describe("一句可验证的事实陈述。包含必要的限定条件（时间、范围、口径），不要含糊。"),
  evidenceIds: z
    .array(z.string())
    .min(1)
    .describe("支撑该声明的证据 id。只能使用上面给出的 id，禁止编造。"),
  note: z
    .string()
    .describe("保留意见：证据强度如何、口径有何限制、是否存在相反说法。没有就留空字符串。"),
});

export const claimsSchema = z.object({
  claims: z.array(claimSchema).max(8).describe("最多 8 条。每条都必须有证据。"),
  gaps: z
    .array(z.string())
    .describe("子问题里**没能**用现有证据回答的部分。没有就返回空数组，不要为了填满而编。"),
});

export type ClaimsDraft = z.infer<typeof claimsSchema>;

export interface ClaimSynthesis {
  readonly claims: readonly Claim[];
  readonly gaps: readonly string[];
  readonly costUsd: number;
}

const CLAIM_SYSTEM = `你是一个研究分析师。你会拿到一个子问题，以及从若干来源逐字摘录的证据。

铁律：
1. 每条声明只能断言引文**确实说了**的内容。引文说"约 30%"，你不能写成"30%"；
   引文是某公司自述，你不能写成行业普遍事实；引文是 2023 年的，你不能不写时间。
2. evidenceIds 只能使用我给出的 id。绝不许写一个我没给过的 id。
3. 一条声明可以引多条证据 —— 不同独立来源说同一件事时，请合并引用，
   这比拆成两条重复声明有用得多。
4. 不同来源互相矛盾时，**不要和稀泥**。为矛盾的两边各写一条声明，
   并在 note 里说明矛盾点，后续会做冲突裁决。
5. 不要写"显而易见""众所周知"这类无需证据的话，也不要写建议和展望。
6. gaps 很重要：如果现有证据回答不了子问题的某一部分，明确写出来。
   承认不知道远好过含糊带过。`;

export async function synthesizeClaims(
  llm: Llm,
  subquestion: SubQuestion,
  evidence: readonly Evidence[],
  refs: ReadonlyMap<string, Ref>,
  signal?: AbortSignal,
): Promise<ClaimSynthesis> {
  if (evidence.length === 0) {
    return { claims: [], gaps: ["未检索到可用证据"], costUsd: 0 };
  }

  const reply = await llm.json(
    claimsSchema,
    {
      system: CLAIM_SYSTEM,
      prompt: [
        `子问题：${subquestion.question}`,
        `（为什么问：${subquestion.intent}）`,
        ``,
        `证据：`,
        renderEvidence(evidence, refs),
      ].join("\n"),
      temperature: 0.1,
      ...(signal ? { signal } : {}),
      label: "claims",
    },
    { name: "claim_synthesis" },
  );

  if (!reply.ok) return { claims: [], gaps: [], costUsd: reply.costUsd };

  let index = 0;
  const claims: Claim[] = reply.value.claims.map((draft) => {
    index += 1;
    return {
      id: `clm_${subquestion.id}_${index}`,
      subquestionId: subquestion.id,
      statement: draft.statement.trim(),
      evidenceIds: [...new Set(draft.evidenceIds)],
      support: "supported" as const,
      ...(draft.note.trim().length > 0 ? { note: draft.note.trim() } : {}),
    };
  });

  return { claims, gaps: reply.value.gaps, costUsd: reply.costUsd };
}

/**
 * 把证据渲染成模型可读的清单。
 *
 * 每条都带上来源性质与日期 —— 没有这些，模型无法判断
 * "一家公司在自己博客上说"和"监管机构公布"之间的分量差别。
 */
export function renderEvidence(
  evidence: readonly Evidence[],
  refs: ReadonlyMap<string, Ref>,
): string {
  return evidence
    .map((item, position) => {
      const ref = refs.get(item.refId);
      const meta = ref
        ? [
            ref.title,
            ref.publisher,
            ref.siteKind,
            ref.publishedAt?.slice(0, 10),
            ref.canonicalUrl,
          ]
            .filter((value): value is string => Boolean(value))
            .join(" · ")
        : item.refId;
      return `[${item.id}] (${position + 1}) ${item.confidence === "direct" ? "逐字" : "近似"}摘录：${item.quote}\n     来源：${meta}`;
    })
    .join("\n\n");
}

/* ── 冲突裁决 ────────────────────────────────────────────────────── */

export const adjudicationSchema = z.object({
  conflicts: z
    .array(
      z.object({
        claimIds: z
          .array(z.string())
          .min(2)
          .describe("互相矛盾的声明 id，恰好两条。"),
        verdict: z
          .string()
          .describe("裁决说明：矛盾点是什么，哪一条更可信，依据是什么（来源性质/时间/口径）。"),
        prefer: z
          .array(z.string())
          .describe("更可信的声明 id；无法判断时给空数组。"),
      }),
    )
    .describe("只列真正对立的声明。口径不同、时间不同造成的差异不算冲突，那叫限定条件不同。"),
  weak: z
    .array(
      z.object({
        claimId: z.string(),
        reason: z.string(),
      }),
    )
    .describe("证据明显不足以支撑其断言强度的声明。不要因为来源少就判弱，要看断言是否过头。"),
});

export type Adjudication = z.infer<typeof adjudicationSchema>;

const ADJUDICATE_SYSTEM = `你是事实核查编辑。你会拿到一份研究报告的全部声明，以及每条声明背后的来源性质。

找出**真正互相矛盾**的声明。判断标准：
- 同一时间、同一口径下的数字或事实相反 → 是冲突
- 一条说"增长"另一条说"下降"，但两者时间范围不同 → 不是冲突，是限定条件
- 一条更宽泛、一条更具体，且互不排斥 → 不是冲突

裁决时按以下权重判断可信度（高到低）：
监管机构/政府 > 学术期刊 > 国际组织 > 官方文档 > 主流媒体 > 其他 > 用户生成内容
同时考虑：时间更新的一方通常更可信；一手数据优于转述；样本口径更完整的一方更可信。
无法判断就明说无法判断，不要强行选边。`;

export async function adjudicate(
  llm: Llm,
  claims: readonly Claim[],
  evidence: ReadonlyMap<string, Evidence>,
  refs: ReadonlyMap<string, Ref>,
  signal?: AbortSignal,
): Promise<{ verdicts: Adjudication | null; costUsd: number }> {
  if (claims.length < 2) return { verdicts: null, costUsd: 0 };

  const lines = claims.map((claim) => {
    const kinds = new Set<string>();
    let topRank = -1;
    for (const evidenceId of claim.evidenceIds) {
      const item = evidence.get(evidenceId);
      const ref = item ? refs.get(item.refId) : undefined;
      if (!ref) continue;
      kinds.add(ref.siteKind);
      topRank = Math.max(topRank, siteRank(ref.siteKind));
    }
    return `[${claim.id}] (来源性质: ${[...kinds].join("/") || "未知"} | 独立来源数: ${claim.evidenceIds.length} | 可信度序位: ${topRank}) ${claim.statement}`;
  });

  const reply = await llm.json(
    adjudicationSchema,
    {
      system: ADJUDICATE_SYSTEM,
      prompt: [`以下是报告中的全部声明：`, ``, lines.join("\n")].join("\n"),
      temperature: 0,
      ...(signal ? { signal } : {}),
      label: "verify",
    },
    { name: "conflict_adjudication" },
  );

  if (!reply.ok) return { verdicts: null, costUsd: reply.costUsd };
  return { verdicts: reply.value, costUsd: reply.costUsd };
}

/** 把裁决结果写回声明。只改 support / contestedWith / note，绝不改 statement。 */
export function applyVerdicts(
  claims: ReadonlyMap<string, Claim>,
  verdicts: Adjudication | null,
): ReadonlyMap<string, Claim> {
  if (!verdicts) return claims;
  const next = new Map(claims);

  for (const conflict of verdicts.conflicts) {
    const ids = conflict.claimIds.filter((id) => next.has(id)).slice(0, 2);
    if (ids.length < 2) continue;
    const [first, second] = ids as [string, string];
    const preferred = conflict.prefer.filter((id) => ids.includes(id));

    for (const id of ids) {
      const claim = next.get(id);
      if (!claim) continue;
      const other = id === first ? second : first;
      const leaning =
        preferred.length === 1
          ? preferred[0] === id
            ? "裁决倾向于本条。"
            : "裁决倾向于与之矛盾的那条。"
          : "裁决未分高下。";
      next.set(id, {
        ...claim,
        support: "contested",
        contestedWith: [...new Set([...(claim.contestedWith ?? []), other])],
        note: [claim.note, `冲突：${conflict.verdict} ${leaning}`].filter(Boolean).join(" "),
      });
    }
  }

  for (const weak of verdicts.weak) {
    const claim = next.get(weak.claimId);
    if (!claim || claim.support === "contested") continue;
    next.set(weak.claimId, {
      ...claim,
      support: "unverified",
      note: [claim.note, `证据不足：${weak.reason}`].filter(Boolean).join(" "),
    });
  }

  return next;
}
