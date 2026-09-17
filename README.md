# aether-research

**可审计的深度研究。** 一条声明如果没有逐字出处，它就不该出现在报告里。

TypeScript · Node 22 · 构建在 [AetherFlow](https://github.com/CJX0712/aetherflow) 之上。

---

## 为什么还要再做一个 deep research

市面上的深度研究产品有两个共同缺陷，而且都是**结构性的**，不是调 prompt 能修的：

1. **引用是装饰。** 报告先由模型写出来，再回头找几个链接贴上去。引文与原文常常对不上，甚至原文里根本没有那句话。
2. **缺失不可见。** 这比幻觉更危险。报告读起来完整流畅，但某个关键角度根本没被查过 —— 读者没有任何办法发现这件事。

`aether-research` 的做法是把顺序反过来：**先有证据，后有声明，声明只是证据的索引。**

## 三条不变量

整个项目的防幻觉能力都建立在这三条上，任何改动都得先过这一关：

| # | 不变量 | 为什么 |
|---|--------|--------|
| 1 | **Claim 永不内联引文文本**，只持 `evidenceIds` | 一旦允许把摘录拷进 Claim，并行子任务之间就开始"传话游戏"，上下文压缩时也会把引文改得面目全非 |
| 2 | **`evidenceIds` 为空的 Claim 不得进入报告** | 不可验证声明数必须为 0 —— 这是第一 KPI，优先级高于字数与引用条数 |
| 3 | **上下文压缩只允许整条丢弃 Evidence，绝不改写** | 若某 Claim 的全部 Evidence 被丢弃，该 Claim 必须一并丢弃 |

推论：**引用编号在渲染期才生成**（渲染时 join `Claim → Evidence → Ref`）。存储期不存在"第 N 条引用"这个概念，所以并行执行和上下文压缩都不会让它漂移。

## 防幻觉的关键一步：引文逐字校验

模型给出的每一条引文，都要在原文里做一次**归一化子串匹配**（`src/synthesis/quote.ts`）：

```
模型引文 → 归一化匹配 → 命中？  → direct（记录字符偏移）
                     └ 未命中 → 吸附到最相似的原句 → inferred（文本仍逐字来自原文）
                                              └ 相似度 < 0.45 → 丢弃
```

三个细节是踩出来的：

- **两级空白归一化。** 先折叠空白，再**完全删除空白**重试一次 —— 后者专门救 PDF 和网页复制出来的中文换行被拆断的情况。
- **小数点保护。** 断句正则要放过 `12.4` 里的点，否则一句数字论断会被劈成两半。
- **按信息量而非字符数断句。** 中文一句话可能只有 12 个字，按 `length >= 8` 过滤会误杀。权重是 `cjk 字数 × 2 + 非 cjk 字符数`。

结果：**报告里每一条引文，都能在来源正文里被 `indexOf` 找到。** 测试里有对应的断言。

## 快速开始

```bash
git clone https://github.com/CJX0712/aether-research.git
cd aether-research
npm install
npm run build

# 先自检：看看哪些检索源配好了
node dist/cli.js providers

# 跑一次研究
node dist/cli.js research -q "2025 年超导量子比特最高两比特门保真度是多少"
```

产物默认落到 `./reports/`，同时给三种格式：

| 文件 | 用途 |
|------|------|
| `*.md` | 进笔记、进 diff、贴进聊天框 |
| `*.html` | 给人读、归档、发链接。单文件、零外部依赖、图标内联为 SVG |
| `*.json` | 给下游程序与回归测试。含全部 refs / evidence / claims 与审计结果 |

## 配置

只需要环境变量。没配的检索源会被**自动跳过**，不会拖累其它源。

```bash
# 模型（至少一个）
export ANTHROPIC_API_KEY=...      # 或 OPENAI_API_KEY / DEEPSEEK_API_KEY ...

# 检索（可选，配几个用几个）
export BRAVE_API_KEY=...          # Brave Search，英文主力
export BOCHA_API_KEY=...          # 博查 AI 搜索，中文主力
export TAVILY_API_KEY=...         # Tavily，自带正文，SPA 页兜底
export EXA_API_KEY=...            # Exa，语义检索
export SEARXNG_BASE_URL=...       # 自建 SearXNG，零凭证兜底

# 免费学术源，无需凭证
#   arXiv / OpenAlex / Crossref —— 填了 mailto 可进 polite pool
export RESEARCH_MAILTO=you@example.com
```

### 内置检索源

| id | 类型 | 凭证 | 单价 | 说明 |
|----|------|------|------|------|
| `arxiv` | academic | 无 | $0 | arXiv Atom API |
| `openalex` | academic | 无 | $0 | 2.4 亿+ 学术作品元数据 |
| `crossref` | academic | 无 | $0 | DOI 注册库 |
| `brave` | web | `BRAVE_API_KEY` | $5/千次 | 英文主力 |
| `bocha` | web | `BOCHA_API_KEY` | — | 中文主力 |
| `tavily` | web | `TAVILY_API_KEY` | — | 返回正文，省一次抓取 |
| `exa` | web | `EXA_API_KEY` | — | 语义检索，默认关闭 |
| `searxng` | web | `SEARXNG_BASE_URL` | $0 | 自建实例 |
| `fixture` | web | 无 | $0 | 离线语料，供测试与示例 |

## CLI

```
用法:
  aether-research research -q "<问题>" [选项]
  aether-research providers

research 选项:
  -q, --question <text>     研究问题（必填）
  -m, --model <ref>         主模型，用于规划/裁决/综合
      --draft <ref>         便宜模型，用于逐源证据抽取
      --max-sources <n>     最多抓取多少个来源          [默认 20]
      --max-cost <usd>      成本硬顶
      --timeout <seconds>   总时长上限                  [默认 900]
      --out <dir>           输出目录                    [默认 ./reports]
      --name <slug>         输出文件名
      --format <list>       md,html,json,all            [默认 all]
      --no-verify-links     跳过引用存活校验
      --quiet               不打印进度
```

进度走 **stderr**，报告走 **stdout/文件**，所以 `aether-research research -q "..." > report.md` 不会把日志混进正文。

**分阶段模型路由是最省钱的一招**：主模型做规划、裁决、综合，便宜模型做查询扩展和逐源抽取。后者占了绝大部分 token，换便宜档通常省 40–60%。

```bash
aether-research research -q "钠离子电池产业化当前的真实成本瓶颈在哪" \
  --model anthropic:claude-sonnet-4-20250514 \
  --draft deepseek:deepseek-chat \
  --max-cost 1.5
```

## 编程 API

```ts
import { research, renderMarkdown } from "aether-research";

const result = await research({
  question: "室温超导的最新实验进展到哪一步了",
  model: "anthropic:claude-sonnet-4-20250514",
  draftModel: "deepseek:deepseek-chat",
  budget: { maxSources: 24, maxCostUsd: 2 },
});

// 第一 KPI：必须为 0
console.log(result.audit.claimsUnverified);

const { markdown } = renderMarkdown(result);
```

也可以完全离线跑 —— 用 `createFixtureProvider` 喂固定语料，配 AetherFlow 的 mock provider，整条流水线在零成本零网络的条件下可复现（见 `examples/`）。这不只是为了测试：流水线里最容易坏的恰恰是多源融合、去重、跨源计数这些纯逻辑。

## 流水线

```
规划 → 检索/抓取/抽取 → 声明合成 → 冲突裁决 → 大纲 → 逐节生成 → 审计
```

几个值得说的设计：

- **预算在每阶段开始前检查**，不是跑完统计。触及上限就停止开新检索，但已启动的阶段会跑完 —— 中途腰斩会留下半份证据，比少查两个来源更糟。
- **同站配额**（默认 2）+ **空壳页阈值**（正文 < 120 字符直接丢弃）：防止单一来源刷屏引用列表。
- **SimHash 近似去重**：识别转载与镜像站，避免"引用 15 条其实 5 篇"。
- **独有词加权归因**（DF 逆频权重）：否则所有证据都会被归到第一个子问题 —— 因为主问题里的词在所有子查询里都出现。
- **大纲锚定 + 分段生成**：每节只注入本节相关的声明，结构上消灭引用漂移。
- **冲突不抹平**：来源打架时保留两条，标注 `contestedWith` 并按来源性质、时间、口径裁决，把"谁更可信"的判断显式地交给读者。
- **失效降级而非报错**：规划或大纲阶段模型挂了，退到启发式拆解，保证报告仍能覆盖全部子问题。

## 审查看什么

每次运行结束都会给出审计结果，这些是**质量指标，不是"越多越好"的 KPI**：

| 指标 | 含义 | 期望 |
|------|------|------|
| `claimsUnverified` | 无证据的声明数 | **必须为 0** |
| `claimsContested` | 存在矛盾来源的声明数 | 不为 0 是好事，说明查到了分歧 |
| `refsUsed / refsTotal` | 真正被引用的来源占比 | 太低说明抓了一堆没用的 |
| `evidencePerClaim` | 按**去重后的来源数**计，不是证据条数 | 同一来源抄三段只算一个 |
| `deadLinks` | 归档时 HEAD 校验失败的链接 | 越接近 0 越好（403/429 不算死链） |
| `warnings` | 段落缺引用、覆盖率不足等 | 逐条可读 |

## 目录

```
src/
  types.ts            核心数据结构 + 三条不变量（改动前必读）
  engine.ts           七阶段编排
  plan/               问题拆解与查询扩展
  retrieval/          8+ 个检索源、多源融合、同站配额
  fetch/              抓取、robots.txt、限速、URL 规范化、SimHash
  synthesis/          引文逐字校验、证据抽取、声明合成、冲突裁决、分段生成
  store/ledger.ts     三条不变量的**执行者**
  render/             Markdown / 单文件 HTML / JSON
  cli/                命令行
```

`Ledger` 是唯一能写入 Claim 和 Evidence 的地方。不变量不是写注释里希望别人遵守，而是**在写入路径上强制执行**：伪造 `evidenceIds` 会被拒绝并记进 `violations`。

## 与 AetherFlow 的关系

[AetherFlow](https://github.com/CJX0712/aetherflow) 提供模型无关的模型层（注册表、provider 抽象、成本计量、并发 `mapLimit`）。`aether-research` 专注在研究这一层：检索、取证、防幻觉、可审计产出。

模型供应商与检索源都是可插拔的，没有 vendor lock-in。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest，41 个用例，全离线
npm run build       # tsup，ESM + CJS + d.ts
```

测试全部离线可跑，不需要任何 API key。

## 路线图

- [x] **评测集**：离线、可复现的防幻觉主线指标（`npm run eval`，见 `EVAL.md`）—— 逐字保真率 100%、幻觉捕获率、第一 KPI、子问题覆盖率、降级可用性、去重、引用编号完整性
- [ ] 召回率评测：固定问题集 + 人工标注的"应有声明"。需在真实联网 + 模型 key 下跑，不在离线范围
- [ ] 增量研究：同一问题二次运行时复用已有 evidence
- [ ] PDF 正文抽取（目前 PDF 走提供方摘要）
- [ ] 引用图谱可视化（谁支持谁、谁与谁冲突）

## License

MIT © 晨星 (Chenxing)
