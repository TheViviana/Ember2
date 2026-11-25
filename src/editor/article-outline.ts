/**
 * 文章大纲的数据源（纯函数，零 DOM / React）。
 *
 * 2026-11-23 用户需求：文章内大纲 = 点列式 + 点击跳转 + 滚动高亮。
 * 大纲直接从原始 Markdown 提取，而不是读渲染后的 DOM：
 * - 编辑模式（CodeMirror）没有渲染后的标题节点，源文本是唯一共同真相；
 * - 阅读模式的 DOM 顺序与源文本标题顺序一致，组件按序映射即可。
 *
 * 只识别 ATX 标题（`#` ~ `######`），并跳过 frontmatter 与代码围栏内部，
 * 避免把 YAML 注释或代码里的 `#` 误当成标题。
 */

export interface ArticleOutlineItem {
  /** 稳定 id（行号唯一）；滚动高亮与跳转都按它对齐。 */
  readonly id: string;
  /** 1 基源文本行号（CodeMirror / 渲染顺序映射用）。 */
  readonly line: number;
  /** 1..6。 */
  readonly depth: number;
  /** 去掉行内标记后的纯文本；空标题被过滤。 */
  readonly text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})/;
/** setext 下划线：`===` 为一级、`---` 为二级（CommonMark 允许 0~3 空格缩进）。 */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;

function stripClosingHashes(text: string): string {
  return text.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/** 标题里的行内 Markdown → 纯文本（只做展示与搜索用的轻量清理）。 */
function plainHeadingText(text: string): string {
  let value = text;
  // 图片/链接：保留可读文案，丢弃 URL。
  value = value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  value = value.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // wikilink：`[[目标|别名]]` → 别名，`[[目标]]` → 目标。
  value = value.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, '$1');
  value = value.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // 行内代码 / 强调 / 删除线。
  value = value.replace(/`+([^`]*)`+/g, '$1');
  value = value.replace(/(\*\*|__)(.*?)\1/g, '$2');
  value = value.replace(/(\*|_)(.*?)\1/g, '$2');
  value = value.replace(/~~(.*?)~~/g, '$1');
  // 原始 HTML 标签不进入大纲（安全预览本身也不执行）。
  value = value.replace(/<[^>]+>/g, '');
  // 反斜杠转义。
  value = value.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
  return value.trim();
}

function frontmatterEnd(lines: readonly string[]): number {
  const first = lines[0]?.replace(/^\uFEFF/, '').trim();
  if (first !== '---') return 0;
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim();
    if (trimmed === '---' || trimmed === '...') return index + 1;
  }
  return 0;
}

/**
 * 从 Markdown 源文本提取大纲条目。
 * 空文本、只有 frontmatter 的文本都返回空数组；坏输入永不抛错。
 */
export function parseArticleOutline(text: string): readonly ArticleOutlineItem[] {
  if (typeof text !== 'string' || text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const items: ArticleOutlineItem[] = [];
  let fence: { readonly marker: string; readonly length: number } | null = null;

  for (let index = frontmatterEnd(lines); index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmedStart = line.trimStart();

    if (fence !== null) {
      const close = FENCE.exec(trimmedStart);
      if (close !== null && close[1] !== undefined) {
        const marker = close[1][0];
        if (marker === fence.marker && close[1].length >= fence.length) fence = null;
      }
      continue;
    }

    const open = FENCE.exec(trimmedStart);
    if (open !== null && open[1] !== undefined) {
      fence = { marker: open[1][0] ?? '`', length: open[1].length };
      continue;
    }

    const match = ATX_HEADING.exec(line);
    if (match !== null) {
      const marks = match[1] ?? '';
      const display = plainHeadingText(stripClosingHashes(match[2] ?? ''));
      if (display === '') continue;
      items.push({
        id: `line-${index + 1}`,
        line: index + 1,
        depth: marks.length,
        text: display,
      });
      continue;
    }

    // setext 标题：下一行是 `===` / `---` 时，当前行就是标题文本。
    // 只认顶格（0~3 空格）的普通段落行，避免把列表/引用/缩进代码误判。
    const underline = SETEXT_UNDERLINE.exec(lines[index + 1] ?? '');
    if (underline !== null && line.trim() !== '' && line === line.trimStart()) {
      const mark = underline[1]?.[0] ?? '';
      const display = plainHeadingText(line.trim());
      if (display !== '') {
        items.push({
          id: `line-${index + 1}`,
          line: index + 1,
          depth: mark === '=' ? 1 : 2,
          text: display,
        });
        index += 1;
      }
    }
  }
  return items;
}
