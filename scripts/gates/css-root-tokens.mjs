// 从 CSS 源中提取「顶层 :root 块」内定义的自定义属性名。
// 七轮修复的四个作用域边界（此前逐轮踩坑）：
// 1. 剥注释（/* */ 不参与结构）；
// 2. 跳过条件组规则（@media/@supports/@document/@container）内的 :root——条件生效不算全局；
//    其它块型 at-rule（@layer 等）视为透明容器，继续下探；
// 3. 选择器组必须「每一项都是 :root」才算全局（`:root, [data-theme=light]` 是条件定义）；
// 4. 块扫描感知引号字符串与转义（content: "}" 不再打断括号配对）。
/**
 * @param {string} css
 * @returns {Set<string>} 形如 `--ember-foo` 的已定义 token 名
 */
export function definedTokensInRootScope(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const defined = new Set();
  scanRange(src, 0, src.length, defined, false);
  return defined;
}

/** 条件组规则：其内部的 :root 定义不构成全局定义 */
const CONDITIONAL_AT = new Set(['media', 'supports', 'document', 'container']);

/**
 * 扫描 [start,end) 区间。inConditional 为 true 时（位于条件组规则内）不收集 :root。
 * @returns {number} 结束下标（区间收尾）
 */
function scanRange(src, start, end, defined, inConditional) {
  let i = start;
  let selStart = start;
  while (i < end) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i, end, c);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < end && src[i] !== '\n') i++;
      continue;
    }
    if (c === '{') {
      const selector = src.slice(selStart, i).trim();
      const close = matchBrace(src, i, end);
      if (selector.startsWith('@')) {
        const name = selector.slice(1).split(/[\s(]/)[0].toLowerCase();
        if (CONDITIONAL_AT.has(name)) {
          scanRange(src, i + 1, close, defined, true); // 只下探用于跳过，不收集
        } else {
          scanRange(src, i + 1, close, defined, inConditional); // @layer 等透明容器
        }
      } else if (!inConditional && isExactRootSelector(selector)) {
        collectProps(src, i + 1, close, defined);
      }
      i = close + 1;
      selStart = i;
      continue;
    }
    if (c === ';') {
      selStart = i + 1;
    }
    i++;
  }
  return end;
}

/** 选择器组拆分后每一项都必须恰好是 :root */
function isExactRootSelector(selector) {
  if (selector === '') return false;
  const parts = selector.split(',').map((s) => s.trim());
  return parts.length > 0 && parts.every((s) => s === ':root');
}

// 八轮修复：块内收集必须字符串感知且只取深度 0 的顶层声明——
// 字符串里的 token 形态（content: "--x: 1"）与 CSS Nesting 嵌套条件规则都不得算全局定义。
function collectProps(src, start, end, defined) {
  let i = start;
  let depth = 0;
  while (i < end) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i, end, c);
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      continue;
    }
    // 无引号 url(...) 内容（如 url(--missing:scheme)）同样不是声明位置（九轮审查）
    if (/^url\(/i.test(src.slice(i, i + 4))) {
      const open = i + 3;
      let j = open + 1;
      while (j < end) {
        if (src[j] === '"' || src[j] === "'") {
          j = skipString(src, j, end, src[j]);
          continue;
        }
        if (src[j] === ')') break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (depth === 0 && c === '-') {
      const m = /^--([a-z0-9-]+)\s*:/.exec(src.slice(i, end));
      if (m) defined.add(`--${m[1]}`);
      i += 2; // '--' 至少两字符，剩余由外层逐字符推进
      continue;
    }
    i++;
  }
}

/** 跳过引号字符串（含转义），返回结束后的下标 */
function skipString(src, i, end, quote) {
  i++;
  while (i < end) {
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return end;
}

/** 从 { 起做括号配对，感知字符串；返回配对 } 的下标 */
function matchBrace(src, openIdx, end) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < end) {
    const c = src[i];
    if (c === '"' || c === "'") {
      i = skipString(src, i, end, c);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return end;
}
