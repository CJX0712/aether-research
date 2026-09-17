/**
 * 证据账本 —— 三条不变量的**执行者**，不只是文档里的口号。
 *
 * 为什么需要一个专门的类来管这些 Map：
 * 不变量如果散落在各个阶段的代码里，就一定会有人（包括以后的我）绕过去。
 * 集中到这里之后，任何"存一条没有证据的声明"的企图都只能从这一个门过，
 * 而这道门会把它拦下来并记一笔违规。
 *
 * 违规不是静默丢弃 —— 静默丢弃会让"因遗漏而误导"变成"因沉默而误导"。
 * 每一条被拒的声明都进 `violations`，最终出现在报告的审计区。
 */

import type { Claim, Evidence, Ref, ResearchAudit } from "../types.js";

export interface LedgerSnapshot {
  readonly refs: ReadonlyMap<string, Ref>;
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly claims: ReadonlyMap<string, Claim>;
}

export class Ledger {
  private readonly refs = new Map<string, Ref>();
  private readonly evidence = new Map<string, Evidence>();
  private readonly claims = new Map<string, Claim>();
  private readonly violations: string[] = [];
  private deadLinks = 0;

  /* ── 写入 ─────────────────────────────────────────────────────── */

  addRef(ref: Ref): void {
    const existing = this.refs.get(ref.id);
    if (existing) {
      // 同一 URL 被多个检索器命中是好事：合并 via，保留信息更全的那条
      const merged = new Set([...existing.via, ...ref.via]);
      this.refs.set(ref.id, {
        ...(existing.title.length >= ref.title.length ? existing : ref),
        via: [...merged],
      });
      return;
    }
    this.refs.set(ref.id, ref);
  }

  /** 证据必须挂在一个已存在的 Ref 上；否则整条丢弃并记录。 */
  addEvidence(item: Evidence): void {
    if (!this.refs.has(item.refId)) {
      this.violations.push(`evidence ${item.id} dropped: unknown refId ${item.refId}`);
      return;
    }
    this.evidence.set(item.id, item);
  }

  addEvidenceMany(items: readonly Evidence[]): void {
    for (const item of items) this.addEvidence(item);
  }

  /**
   * 不变量 2 的执行点：evidenceIds 为空的 Claim 一律不得入库。
   * 同时过滤掉指向不存在证据的 id —— 模型编造 evidenceId 是常见失败模式。
   */
  addClaim(claim: Claim): boolean {
    const known = claim.evidenceIds.filter((id) => this.evidence.has(id));
    if (known.length === 0) {
      this.violations.push(
        `claim rejected (no usable evidence): "${truncate(claim.statement, 80)}"`,
      );
      return false;
    }
    if (known.length !== claim.evidenceIds.length) {
      this.violations.push(
        `claim ${claim.id}: dropped ${claim.evidenceIds.length - known.length} fabricated evidenceId(s)`,
      );
    }
    this.claims.set(claim.id, known.length === claim.evidenceIds.length ? claim : { ...claim, evidenceIds: known });
    return true;
  }

  addClaimMany(claims: readonly Claim[]): number {
    let accepted = 0;
    for (const claim of claims) if (this.addClaim(claim)) accepted += 1;
    return accepted;
  }

  /**
   * 用裁决后的版本替换原声明。
   * 只允许改 support / contestedWith / note —— statement 与 evidenceIds 不可变，
   * 否则就是绕过不变量偷偷改结论。
   */
  replaceClaim(claim: Claim): void {
    const existing = this.claims.get(claim.id);
    if (!existing) return;
    this.claims.set(claim.id, {
      ...claim,
      statement: existing.statement,
      evidenceIds: existing.evidenceIds,
    });
  }

  countDeadLink(): void {
    this.deadLinks += 1;
  }

  /**
   * 不变量 3 的执行点：上下文压缩只允许整条丢弃 Evidence。
   * 被丢弃后失去全部证据的 Claim 必须跟着走 —— 留下来就是无源声明。
   */
  dropEvidence(ids: readonly string[]): number {
    const removed = new Set(ids.filter((id) => this.evidence.delete(id)));
    if (removed.size === 0) return 0;

    let orphaned = 0;
    for (const [claimId, claim] of [...this.claims]) {
      const left = claim.evidenceIds.filter((id) => this.evidence.has(id));
      if (left.length === 0) {
        this.claims.delete(claimId);
        orphaned += 1;
      } else if (left.length !== claim.evidenceIds.length) {
        this.claims.set(claimId, { ...claim, evidenceIds: left });
      }
    }
    return orphaned;
  }

  /* ── 读取 ─────────────────────────────────────────────────────── */

  ref(id: string): Ref | undefined {
    return this.refs.get(id);
  }

  getRefs(): ReadonlyMap<string, Ref> {
    return this.refs;
  }

  getEvidence(): ReadonlyMap<string, Evidence> {
    return this.evidence;
  }

  getClaims(): ReadonlyMap<string, Claim> {
    return this.claims;
  }

  evidenceFor(claim: Claim): Evidence[] {
    const out: Evidence[] = [];
    for (const id of claim.evidenceIds) {
      const item = this.evidence.get(id);
      if (item) out.push(item);
    }
    return out;
  }

  claimsFor(subquestionId: string): Claim[] {
    return [...this.claims.values()].filter((claim) => claim.subquestionId === subquestionId);
  }

  /** 被引用的 Ref；其余进"读了但没用"附录，让遗漏可见。 */
  usedRefIds(): Set<string> {
    const used = new Set<string>();
    for (const claim of this.claims.values()) {
      for (const evidenceId of claim.evidenceIds) {
        const item = this.evidence.get(evidenceId);
        if (item) used.add(item.refId);
      }
    }
    return used;
  }

  getViolations(): readonly string[] {
    return this.violations;
  }

  snapshot(): LedgerSnapshot {
    return {
      refs: new Map(this.refs),
      evidence: new Map(this.evidence),
      claims: new Map(this.claims),
    };
  }

  /* ── 审计 ─────────────────────────────────────────────────────── */

  audit(extraWarnings: readonly string[] = []): ResearchAudit {
    const claims = [...this.claims.values()];
    const used = this.usedRefIds();

    // 定义上 claimsUnverified 永远为 0（入库即拦截）。
    // 仍然算一遍：如果这里不是 0，说明有人绕过了 Ledger 直接写 Map，那是个 bug。
    const claimsUnverified = claims.filter((claim) => claim.evidenceIds.length === 0).length;

    const evidencePerClaim =
      claims.length === 0
        ? 0
        : claims.reduce((sum, claim) => sum + new Set(
            claim.evidenceIds
              .map((id) => this.evidence.get(id)?.refId)
              .filter((refId): refId is string => Boolean(refId)),
          ).size, 0) / claims.length;

    return {
      claimsTotal: claims.length,
      claimsUnverified,
      claimsContested: claims.filter((claim) => claim.support === "contested").length,
      refsTotal: this.refs.size,
      refsUsed: used.size,
      evidencePerClaim: Math.round(evidencePerClaim * 100) / 100,
      deadLinks: this.deadLinks,
      warnings: [...extraWarnings, ...this.violations],
    };
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
