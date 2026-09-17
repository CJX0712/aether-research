/**
 * 三条不变量的测试。
 *
 * 这些断言不是"覆盖率"，它们是**产品定义的机器表述**。
 * 任何一条挂了，说明这个库输出的东西不再能被审计，
 * 那它就只是另一个会编引用的写作工具。
 */

import { describe, expect, it } from "vitest";

import { Ledger } from "../src/store/ledger.js";
import type { Claim, Evidence, Ref } from "../src/types.js";

function ref(id = "ref1"): Ref {
  return {
    id,
    canonicalUrl: `https://example.com/${id}`,
    finalUrl: `https://example.com/${id}`,
    title: `来源 ${id}`,
    siteKind: "paper",
    via: ["fixture"],
    fetch: { at: "2026-01-01T00:00:00.000Z", status: 200, contentType: "text/html", extractedBy: "readability" },
    snapshot: { sha256: "a".repeat(64), charCount: 100, head: "开头" },
  };
}

function evidence(id: string, refId = "ref1"): Evidence {
  return {
    id,
    refId,
    subquestionId: "sq1",
    quote: "这是一条足够长的原文摘录，用于通过最小长度检查。",
    by: "readability",
    confidence: "direct",
  };
}

function claim(id: string, evidenceIds: readonly string[]): Claim {
  return {
    id,
    subquestionId: "sq1",
    statement: "这是一条声明。",
    evidenceIds,
    support: "supported",
  };
}

describe("不变量 2：无证据的声明不得入库", () => {
  it("evidenceIds 为空时拒绝入库并记录违规", () => {
    const ledger = new Ledger();
    expect(ledger.addClaim(claim("clm1", []))).toBe(false);
    expect(ledger.getClaims().size).toBe(0);
    expect(ledger.getViolations()).toHaveLength(1);
  });

  it("evidenceIds 指向不存在的证据时同样拒绝", () => {
    const ledger = new Ledger();
    expect(ledger.addClaim(claim("clm2", ["ev_不存在"]))).toBe(false);
    expect(ledger.getClaims().size).toBe(0);
  });

  it("混合编造与真实 id 时只保留真实部分", () => {
    const ledger = new Ledger();
    ledger.addRef(ref());
    ledger.addEvidence(evidence("ev_real"));
    expect(ledger.addClaim(claim("clm3", ["ev_real", "ev_fake"]))).toBe(true);
    expect(ledger.getClaims().get("clm3")?.evidenceIds).toEqual(["ev_real"]);
    expect(ledger.getViolations()).toHaveLength(1);
  });
});

describe("不变量 1：证据必须挂在已存在的来源上", () => {
  it("refId 未知时整条证据丢弃", () => {
    const ledger = new Ledger();
    ledger.addEvidence(evidence("ev1", "不存在的来源"));
    expect(ledger.getEvidence().size).toBe(0);
    expect(ledger.getViolations()[0]).toContain("unknown refId");
  });
});

describe("不变量 3：压缩只允许整条丢弃证据", () => {
  it("丢弃某条声明的全部证据后，该声明一并消失", () => {
    const ledger = new Ledger();
    ledger.addRef(ref());
    ledger.addEvidence(evidence("ev1"));
    ledger.addClaim(claim("clm1", ["ev1"]));
    expect(ledger.getClaims().size).toBe(1);

    const orphaned = ledger.dropEvidence(["ev1"]);
    expect(orphaned).toBe(1);
    expect(ledger.getClaims().size).toBe(0);
  });

  it("只丢弃部分证据时，声明保留并收窄引用", () => {
    const ledger = new Ledger();
    ledger.addRef(ref());
    ledger.addEvidence(evidence("ev1"));
    ledger.addEvidence(evidence("ev2"));
    ledger.addClaim(claim("clm1", ["ev1", "ev2"]));

    expect(ledger.dropEvidence(["ev1"])).toBe(0);
    expect(ledger.getClaims().get("clm1")?.evidenceIds).toEqual(["ev2"]);
  });
});

describe("审计", () => {
  it("claimsUnverified 恒为 0，且统计独立来源数而非证据条数", () => {
    const ledger = new Ledger();
    ledger.addRef(ref("ref1"));
    ledger.addRef(ref("ref2"));
    // 同一来源的两条不同摘录不应被算作两个独立来源
    ledger.addEvidence(evidence("ev1", "ref1"));
    ledger.addEvidence({ ...evidence("ev2", "ref1"), quote: "另一条摘录，同样足够长以通过检查。" });
    ledger.addClaim(claim("clm1", ["ev1", "ev2", "ev_unknown"]));

    const audit = ledger.audit();
    expect(audit.claimsUnverified).toBe(0);
    expect(audit.claimsTotal).toBe(1);
    expect(audit.evidencePerClaim).toBe(1);
    expect(audit.refsUsed).toBe(1);
    expect(audit.refsTotal).toBe(2);
  });

  it("替换声明时 statement 与 evidenceIds 不可被改写", () => {
    const ledger = new Ledger();
    ledger.addRef(ref());
    ledger.addEvidence(evidence("ev1"));
    ledger.addClaim(claim("clm1", ["ev1"]));

    ledger.replaceClaim({
      ...claim("clm1", ["ev_偷换"]),
      statement: "被偷偷改掉的结论",
      support: "contested",
    });

    const stored = ledger.getClaims().get("clm1");
    expect(stored?.statement).toBe("这是一条声明。");
    expect(stored?.evidenceIds).toEqual(["ev1"]);
    expect(stored?.support).toBe("contested");
  });
});

describe("同 URL 多源命中", () => {
  it("合并 via 而不重复建条目", () => {
    const ledger = new Ledger();
    ledger.addRef({ ...ref(), via: ["a"] });
    ledger.addRef({ ...ref(), via: ["b"] });
    expect(ledger.getRefs().size).toBe(1);
    expect(ledger.getRefs().get("ref1")?.via).toEqual(["a", "b"]);
  });
});
