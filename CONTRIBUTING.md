# 贡献指南

## 先读这个

改动任何代码之前，先读 `src/types.ts` 的文件头。那里写着三条不变量，整个项目的防幻觉能力都建立在它们之上：

1. Claim 永不内联引文文本，只持 `evidenceIds`
2. `evidenceIds` 为空的 Claim 不得进入报告（第一 KPI：不可验证声明数 = 0）
3. 上下文压缩只允许整条丢弃 Evidence，绝不改写

**违反其中任何一条的 PR，无论功能多好都会被退回。** 这不是教条：它们每一条都对应一个具体的失败模式。

## 本地开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest，41 个用例，全离线
npm run build       # tsup，ESM + CJS + d.ts
```

测试不需要任何 API key。这不是巧合：流水线里最容易坏的恰恰是多源融合、去重、跨源计数这些纯逻辑，它们与是否真联网无关。

## 三条硬规矩

### 1. 禁止 emoji 作为功能图标

UI 图标必须是内联 SVG（`lucide-static`）。CI 有专门的扫描任务，会拦下 emoji。

### 2. 禁止硬编码颜色

渲染层的所有颜色走 Design Token（CSS 变量）。唯一允许的硬编码值是 `#fff` 与 `#000`。

### 3. 新增检索源必须能独立失败

任何检索源挂掉都不能拖垮整次运行。实现时：

- 用 `str` / `optStr` / `optNum` 收敛字段，把检索器返回的 JSON 当**不可信输入**
- URL 过 `isHttpUrl`，只接受 http/https
- 缺凭证时 `available()` 返回 false，由路由层自动跳过

参考 `src/retrieval/providers/arxiv.ts`，它是最完整的一个例子（含 Atom 解析与字段收敛）。

## 提交 PR 前

- [ ] `npm run typecheck` 通过
- [ ] `npm test` 全绿
- [ ] 新增逻辑有对应测试（尤其是纯逻辑部分）
- [ ] 如果改了 Claim / Evidence 的数据流，说明三条不变量如何仍然成立

## 提交信息

用 Conventional Commits：`feat:` / `fix:` / `docs:` / `refactor:` / `test:` / `chore:`。

## 行为准则

就事论事，对代码不对人。有分歧时拿证据说话 —— 跑一个测试、给一段复现，比争论有用。
