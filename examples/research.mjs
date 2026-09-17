/**
 * 完整研究流水线示例。需要模型 API key（检索源可选，三个学术源免凭证）。
 *
 * 运行：
 *   export ANTHROPIC_API_KEY=...
 *   npm run build && node examples/research.mjs "室温超导的最新实验进展到哪一步了"
 */

import { writeFileSync } from "node:fs";

import { renderHtml, renderMarkdown, research } from "aether-research";

const question = process.argv[2] ?? "钠离子电池产业化当前的真实成本瓶颈在哪";

const result = await research(
  {
    question,
    // 主模型做规划、裁决、综合 —— 这三步决定报告质量，别省
    model: "anthropic:claude-sonnet-4-20250514",
    // 便宜模型做查询扩展与逐源抽取 —— 占了绝大部分 token，省这里最划算
    draftModel: "deepseek:deepseek-chat",
    budget: { maxSources: 24, maxCostUsd: 2 },
  },
  {
    onEvent: (event) => {
      if (event.type === "usage" || event.type === "fetch_start") return;
      process.stderr.write(`  [${event.type}]\n`);
    },
  },
);

const audit = result.audit;
console.log(`\n${result.report.sections.length} 节 · ${audit.claimsTotal} 条声明`);
console.log(`不可验证声明 ${audit.claimsUnverified}（必须为 0） · 冲突 ${audit.claimsContested} · 死链 ${audit.deadLinks}`);
console.log(`引用了 ${audit.refsUsed}/${audit.refsTotal} 个来源 · 模型 $${result.usage.modelUsd.toFixed(4)} · 检索 $${result.usage.searchUsd.toFixed(4)}`);
if (audit.warnings.length > 0) {
  console.log("\n告警：");
  for (const warning of audit.warnings) console.log(`  ${warning}`);
}

writeFileSync("report.md", renderMarkdown(result).markdown, "utf8");
writeFileSync("report.html", renderHtml(result), "utf8");
console.log("\n已写出 report.md 与 report.html");
