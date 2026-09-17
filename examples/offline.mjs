/**
 * 离线示例：不需要任何 API key。
 *
 * 演示两件核心的事 —— 也是这个项目最值得被抄走的两块逻辑：
 *   1. 引文逐字校验：模型给的引文必须在原文里能被找到，找不到就吸附或丢弃
 *   2. Ledger 强制不变量：没有证据的声明写不进去
 *
 * 运行：npm run build && node examples/offline.mjs
 */

import { Ledger, verifyQuote } from "aether-research";

const source =
  "2024 年，谷歌的 Willow 处理器在距离为 7 的表面码上实现了低于阈值的错误率。" +
  "实验测得每轮纠错的逻辑错误率为 0.0014，相比距离为 5 时下降了约两倍。" +
  "该结果说明增加码距确实能够指数级抑制逻辑错误，是迈向容错量子计算的关键一步。";

/* ── 1. 引文逐字校验 ───────────────────────────────────────────── */

const cases = [
  // 逐字命中
  "实验测得每轮纠错的逻辑错误率为 0.0014",
  // 模型自己编的，原文里没有
  "实验测得每轮纠错的逻辑错误率为 0.0001，达到了商用门槛",
  // 中文被复制时常见的换行拆断：两个字之间多了个换行
  "该结果说明增加码距确实能够\n指数级抑制逻辑错误",
];

console.log("引文逐字校验\n");
for (const candidate of cases) {
  const verified = verifyQuote(source, candidate);
  if (!verified) {
    console.log(`  丢弃      ${JSON.stringify(candidate.slice(0, 32))}`);
    continue;
  }
  const inSource = source.includes(verified.quote);
  console.log(
    `  ${verified.confidence.padEnd(8)} 相似度 ${verified.similarity.toFixed(2)} ` +
      `逐字命中原文=${inSource}  ${JSON.stringify(verified.quote.slice(0, 40))}`,
  );
}

/* ── 2. Ledger 强制不变量 ──────────────────────────────────────── */

console.log("\nLedger 不变量\n");

const ledger = new Ledger();

ledger.addRef({
  id: "ref_demo",
  canonicalUrl: "https://example.com/demo",
  finalUrl: "https://example.com/demo",
  title: "示例来源",
  siteKind: "paper",
  via: ["fixture"],
  fetch: { at: new Date().toISOString(), status: 200, contentType: "text/html", extractedBy: "provider" },
  snapshot: { sha256: "0".repeat(64), charCount: source.length, head: source.slice(0, 120) },
});

ledger.addEvidence({
  id: "ev_demo",
  refId: "ref_demo",
  subquestionId: "sq1",
  quote: "实验测得每轮纠错的逻辑错误率为 0.0014",
  by: "provider",
  confidence: "direct",
});

const claim = (id, statement, evidenceIds) => ({
  id,
  statement,
  evidenceIds,
  subquestionId: "sq1",
  support: "supported",
});

// 有证据的声明：收
const accepted = ledger.addClaim(
  claim("clm_ok", "距离为 7 的表面码已将每轮纠错逻辑错误率压到 0.0014。", ["ev_demo"]),
);

// 没有证据的声明：拒（第一 KPI 就靠这个守住）
const rejected = ledger.addClaim(claim("clm_bad", "该处理器已经具备商用价值。", []));

// 伪造证据 id 的声明：也拒
const forged = ledger.addClaim(
  claim("clm_forged", "该处理器在 2025 年实现了距离 25 的表面码。", ["ev_不存在"]),
);

console.log(`  有证据的声明：${accepted ? "收下" : "拒绝"}`);
console.log(`  无证据的声明：${rejected ? "收下" : "拒绝"}`);
console.log(`  伪造证据 id：${forged ? "收下" : "拒绝"}`);

const audit = ledger.audit();
console.log(`\n  声明总数 ${audit.claimsTotal} · 不可验证 ${audit.claimsUnverified}（必须为 0）`);
for (const violation of audit.warnings) console.log(`  违规记录：${violation}`);
