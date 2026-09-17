/**
 * 引文逐字校验的测试。
 *
 * 这个文件的分量比它的行数重得多 —— 它验证的是整个项目对抗幻觉的**唯一机械手段**。
 * 提示词写得再好，如果这里的逻辑漏了，编造的引文就会带着引用编号出现在报告里。
 */

import { describe, expect, it } from "vitest";

import {
  MIN_SNAP_SIMILARITY,
  dice,
  splitSentences,
  tokenize,
  verifyQuote,
} from "../src/synthesis/quote.js";

const SOURCE =
  "2024 年，谷歌的 Willow 处理器在距离为 7 的表面码上实现了低于阈值的错误率。" +
  "实验测得每轮纠错的逻辑错误率为 0.0014，相比距离为 5 时下降了约两倍。" +
  "该结果说明增加码距确实能够指数级抑制逻辑错误。";

describe("verifyQuote", () => {
  it("逐字命中时返回 direct 并给出原文偏移", () => {
    const quote = "实验测得每轮纠错的逻辑错误率为 0.0014";
    const result = verifyQuote(SOURCE, quote);
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("direct");
    expect(result?.similarity).toBe(1);
    expect(result?.locate.kind).toBe("char");

    if (result?.locate.kind === "char") {
      expect(SOURCE.slice(result.locate.start, result.locate.end)).toBe(quote);
    }
  });

  it("空白与换行被折叠后仍能命中原文", () => {
    const quote = "实验测得每轮纠错的\n逻辑错误率为   0.0014";
    const result = verifyQuote(SOURCE, quote);
    expect(result?.confidence).toBe("direct");
  });

  it("全角与弯引号归一化后仍能命中", () => {
    const source = "他强调「可验证性」是研究工具的第一原则，其余都是次要的。";
    const result = verifyQuote(source, "他强调“可验证性”是研究工具的第一原则，其余都是次要的。");
    expect(result?.confidence).toBe("direct");
  });

  it("模型自由发挥的引文被直接丢弃", () => {
    // 读起来完全合理，但原文里没有 —— 这正是最危险的一类
    const result = verifyQuote(
      SOURCE,
      "实验团队在论文中承认该结果尚未经过独立第三方的复现验证。",
    );
    expect(result).toBeNull();
  });

  it("模型改写原文时吸附到最相似的原句，且引文文本仍逐字来自原文", () => {
    const source = "该公司 2025 年的营收为 12.4 亿元，同比增长 18%。净利润为 1.2 亿元。";
    const result = verifyQuote(source, "该公司2025年营收12.4亿元，同期增长大约18%");
    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("inferred");
    expect(result?.similarity).toBeGreaterThanOrEqual(MIN_SNAP_SIMILARITY);
    // 关键断言：吸附后的文本必须逐字存在于原文
    expect(source).toContain(result?.quote.replace(/…$/, "") ?? "###");
  });

  it("过短的片段不作为证据", () => {
    expect(verifyQuote(SOURCE, "0.0014")).toBeNull();
  });

  it("空原文返回 null 而不是抛错", () => {
    expect(verifyQuote("", "任何一句话都要够长才能作为证据出现在这里。")).toBeNull();
  });
});

describe("splitSentences", () => {
  it("中英混排都能断句", () => {
    const sentences = splitSentences(
      "First sentence here. 这是第二句！And the third one? 最后一句。",
    );
    expect(sentences.length).toBe(4);
    expect(sentences[0]?.text).toContain("First");
  });
});

describe("tokenize / dice", () => {
  it("中文按字切、英文按词切并统一小写", () => {
    const tokens = tokenize("量子计算 Quantum Computing");
    expect(tokens.has("量")).toBe(true);
    expect(tokens.has("quantum")).toBe(true);
    expect(tokens.has("Quantum")).toBe(false);
  });

  it("dice 对完全相同与完全无关的集合给出 1 和 0", () => {
    const a = tokenize("量子纠错阈值");
    expect(dice(a, tokenize("量子纠错阈值"))).toBe(1);
    expect(dice(a, tokenize("完全不同的另一句话"))).toBe(0);
  });
});
