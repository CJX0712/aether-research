# 示例

| 文件 | 需要 API key | 说明 |
|------|--------------|------|
| `offline.mjs` | 不需要 | 演示引文逐字校验与 Ledger 不变量 enforcement，直接可跑 |
| `research.mjs` | 需要 | 完整流水线：规划 → 检索 → 取证 → 综合 → 输出 md/html |

```bash
npm run build

node examples/offline.mjs                      # 零依赖零网络
node examples/research.mjs "你的研究问题"        # 需要 ANTHROPIC_API_KEY 等
```

`offline.mjs` 的输出值得看一眼：它把一条**模型编造的引文**喂进校验器，你会看到它被吸附成原文中真实存在的一句话，而不是被原样放行。
