/**
 * 极简 Markdown → HTML。
 *
 * 报告正文只需要段落、引用块、列表、粗体、行内代码和引用编号这几种结构，
 * 为此引一个通用 Markdown 库（连带 sanitizer、highlighter 一堆传递依赖）不划算。
 *
 * 关键顺序：**先转义 HTML，再做行内格式**。反过来会让正文里的 `<script>` 活下来。
 */

export function miniMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^\s*>\s?/, ""));
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      flushQuote();
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  flushAll();
  return out.join("\n");
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_match, group: string) =>
      group
        .split(",")
        .map((value) => {
          const number = value.trim();
          return `<a class="cite" href="#ref-${number}" title="查看来源 ${number}">${number}</a>`;
        })
        .join(", "),
    );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
