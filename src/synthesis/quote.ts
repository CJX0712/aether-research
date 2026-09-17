/**
 * 引文逐字校验 —— 这个项目最要紧的一段代码。
 *
 * 问题：让模型"从原文摘一句"时，它有多大概率给你一句原文里没有的话？
 * 实测远高于人们愿意相信的水平，而且**摘得越像，越难发现**。
 * 一句读起来通顺、立场正确的"引文"，比明显的胡说危险得多。
 *
 * 对策不是提示模型"请务必逐字引用"（那只是许愿），而是**机器校验**：
 *
 *   1. 先做归一化后的子串匹配（归一化只折叠空白与全角/弯引号，不改词序）
 *   2. 命中 → `direct`，并记录原文字符偏移，可回放定位
 *   3. 未命中 → 模型多半是改写或概括了。此时**吸附**到原文中最相似的那句话，
 *      用原文那句话作为引文 → `inferred`
 *   4. 连相似句都找不到 → 返回 null，整条证据丢弃
 *
 * 关键取舍：`inferred` 不是"随便编"，它的文本**同样逐字来自原文**，
 * 只是由机器而非模型选定了边界。所以它依然可被审计。
 * 真正不可接受的是"模型自己写了一句"，那种一律丢弃。
 */

export interface VerifiedQuote {
  /** 逐字来自原文的引文文本。`inferred` 时可能与模型给的原文不同。 */
  readonly quote: string;
  readonly confidence: "direct" | "inferred";
  /** 在原文中的定位；`direct` 给字符偏移，`inferred` 给段落序号。 */
  readonly locate:
    | { readonly kind: "char"; readonly start: number; readonly end: number }
    | { readonly kind: "para"; readonly index: number };
  /** 与模型所给文本的相似度（0-1）。`direct` 时为 1。 */
  readonly similarity: number;
}

/** 引文长度上限。超过这个长度既没人读，也更容易被截断得面目全非。 */
export const MAX_QUOTE_CHARS = 600;

/** 低于此相似度即认为模型在自由发挥，丢弃。 */
export const MIN_SNAP_SIMILARITY = 0.45;

/**
 * 校验并落地一条引文。
 * @returns null 表示这条证据不可用，调用方必须丢弃而不是降级保留。
 */
export function verifyQuote(source: string, candidate: string): VerifiedQuote | null {
  const cleaned = cleanQuote(candidate);
  if (cleaned.length < 12) return null; // 太短的片段没有举证价值
  if (source.trim().length === 0) return null;

  // 先按"空白折叠为一个空格"匹配，失败再按"空白全部删除"匹配。
  // 后者专门救 PDF/网页复制出来的换行：中文句子中间的换行不代表空格，
  // 只按空格折叠会让这类引文全部落到 inferred，白白损失精度。
  for (const mode of ["space", "remove"] as const) {
    const hay = normalize(source, mode);
    const needle = normalize(cleaned, mode);
    if (needle.text.length < 8) continue;

    const at = hay.text.indexOf(needle.text);
    if (at === -1) continue;

    const start = hay.map[at] ?? 0;
    const end = (hay.map[Math.min(at + needle.text.length, hay.text.length) - 1] ?? start) + 1;
    return {
      quote: source.slice(start, end),
      confidence: "direct",
      locate: { kind: "char", start, end },
      similarity: 1,
    };
  }

  // 未逐字命中：吸附到最相似的原文句子
  const best = snapToSentence(source, cleaned);
  if (!best) return null;
  return {
    quote: best.text,
    confidence: "inferred",
    locate: { kind: "para", index: best.index },
    similarity: best.similarity,
  };
}

/* ── 归一化 ──────────────────────────────────────────────────────── */

interface Normalized {
  readonly text: string;
  /** map[i] = 归一化后第 i 个字符在原文中的下标。 */
  readonly map: number[];
}

type WhitespaceMode = "space" | "remove";

/**
 * 归一化只做"不改变语义与词序"的折叠：空白、全角、弯引号、连字符变体。
 * 绝不做大小写折叠 —— 大小写可能是有意义的（如 "US" vs "us"），
 * 而且这会掩盖真正的错引。
 */
function normalize(input: string, whitespace: WhitespaceMode = "space"): Normalized {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    let out = char;

    if (/[\u2018\u2019\u201B\u2032]/.test(char)) out = "'";
    else if (/[\u201C\u201D\u201F\u2033\u300C\u300D\u300E\u300F]/.test(char)) out = '"';
    else if (/[\u2010-\u2015\u2212\uFF0D]/.test(char)) out = "-";
    else if (/\s/.test(char)) {
      if (whitespace === "remove") continue;
      pendingSpace = text.length > 0;
      continue;
    }

    if (pendingSpace) {
      text += " ";
      map.push(i);
      pendingSpace = false;
    }
    // NFKC 展开全角字母数字；单字符场景足够，且比整串 normalize 更省
    const folded = out.normalize("NFKC");
    for (const foldedChar of folded) {
      text += foldedChar;
      map.push(i);
    }
  }

  return { text: text.trim(), map };
}

/** 模型给回来的引文经常带引号、破折号前缀、省略号，先清掉。 */
function cleanQuote(candidate: string): string {
  const text = candidate
    .trim()
    .replace(/^["'「『"']+/, "")
    .replace(/["'」』"']+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_QUOTE_CHARS
    ? `${text.slice(0, MAX_QUOTE_CHARS).replace(/\s+\S*$/, "")}…`
    : text;
}

/* ── 句子吸附 ────────────────────────────────────────────────────── */

interface Sentence {
  readonly text: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

/**
 * 中英混排的句子切分。
 * 中文没有空格，靠标点断句；英文靠标点 + 换行。两者混排时按标点切最稳。
 */
export function splitSentences(source: string): Sentence[] {
  const out: Sentence[] = [];
  // 句点后接数字（12.4）或前接数字时不算句末 —— 小数点是断句最常见的误伤
  const pattern = /(?:[^.!?。！？；;\n]|(?<=\d)\.(?=\d))+[.!?。！？；;]?/g;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(source)) !== null) {
    const raw = match[0];
    const text = raw.trim();
    if (weight(text) >= 8) {
      out.push({ text, index, start: match.index, end: match.index + raw.length });
      index += 1;
    }
  }
  return out;
}

/**
 * 句子的信息量权重。
 * 按字符数过滤会把"净利润为 1.2 亿元。"这类短中文句全砍掉 ——
 * 一个汉字的信息量远大于一个拉丁字母，用统一字符数阈值是在惩罚中文。
 */
function weight(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return cjk * 2 + (text.length - cjk);
}

function snapToSentence(
  source: string,
  candidate: string,
): { text: string; index: number; similarity: number } | null {
  const sentences = splitSentences(source);
  if (sentences.length === 0) return null;

  const candidateTokens = tokenize(candidate);
  if (candidateTokens.size === 0) return null;

  let best: { text: string; index: number; similarity: number } | null = null;

  // 引文可能跨句：允许把相邻两句并起来再比，覆盖模型合并两句的常见情况
  for (let i = 0; i < sentences.length; i += 1) {
    const single = sentences[i] as Sentence;
    const merged =
      i + 1 < sentences.length
        ? `${single.text} ${(sentences[i + 1] as Sentence).text}`
        : single.text;

    for (const [text, index] of [
      [single.text, single.index],
      [merged, single.index],
    ] as const) {
      const score = dice(candidateTokens, tokenize(text));
      if (score >= MIN_SNAP_SIMILARITY && (!best || score > best.similarity)) {
        best = {
          text: text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}…` : text,
          index,
          similarity: score,
        };
      }
    }
  }

  return best;
}

/**
 * 混合分词：CJK 按字（中文没有空格，字就是最小的语义单位），
 * 拉丁文按词。这样中英混排的句子比较才有意义。
 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const pattern = /[㐀-䶿一-鿿぀-ヿ가-힯]|[A-Za-z0-9][A-Za-z0-9'._-]*/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    if (/[㐀-䶿一-鿿぀-ヿ가-힯]/.test(token)) tokens.add(token);
    else tokens.add(token.toLowerCase());
  }
  return tokens;
}

/** Dice 系数。对长度差异不像 Jaccard 那么敏感，适合"短引文 vs 长句子"。 */
export function dice(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/* ── 辅助 ────────────────────────────────────────────────────────── */

/** 取原文片段，带上下文；用于审计视图展示"引文在原文中的位置"。 */
export function excerptAround(
  source: string,
  locate: { readonly kind: "char"; readonly start: number; readonly end: number } | { readonly kind: "para"; readonly index: number },
  margin = 160,
): string {
  if (locate.kind === "para") {
    const sentence = splitSentences(source)[locate.index];
    return sentence ? sentence.text : "";
  }
  const start = Math.max(0, locate.start - margin);
  const end = Math.min(source.length, locate.end + margin);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < source.length ? "…" : "";
  return `${prefix}${source.slice(start, end).replace(/\s+/g, " ")}${suffix}`;
}
