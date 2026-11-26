#!/usr/bin/env node
/* 主题令牌审计：找出 tokens.css 中"定义了但没有任何组件/脚本消费"的死牌。
 *
 * 判定规则：
 *  - 只统计顶层 :root（排除 @media/@supports 等条件块里的覆盖）。
 *  - 传递闭包：一个令牌只要被任何"活动令牌"的值引用，或被 src/public 下任何
 *    非 tokens.css 的文件（含 TS/TSX 字符串字面量、canvas 探针）引用，就算活。
 *  - 在令牌定义行的行内注释里写 @keep 关键字，即视为"显式预留"，不计为死牌。
 *
 * 用法：
 *  node scripts/audit-tokens.mjs          打印报告，恒 exit 0
 *  node scripts/audit-tokens.mjs --ci     存在死牌时 exit 1（可接 CI）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tokensPath = path.join(ROOT, 'src/styles/tokens.css');
const css = readFileSync(tokensPath, 'utf8');
const CI = process.argv.includes('--ci');

/* ---------- 结构工具 ---------- */
function matchBrace(src, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return src.length;
}
/* 移除 @media/@supports/@container/@document 条件块（其内定义非全局生效） */
function removeConditionalBlocks(src) {
  const re = /@(media|supports|container|document)\b/g;
  let result = '';
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    const braceIdx = src.indexOf('{', m.index);
    if (braceIdx === -1) break;
    const close = matchBrace(src, braceIdx);
    result += src.slice(last, m.index);
    last = close + 1;
    re.lastIndex = close + 1;
  }
  return result + src.slice(last);
}

/* ---------- @keep 预留标注：定义行 --name: value; 后随行内注释含 @keep ---------- */
const keepTokens = new Set();
for (const m of css.matchAll(/--([a-z0-9-]+)\s*:[^;\n]*;[^\n]*?@keep\b/gi)) {
  keepTokens.add(`--${m[1]}`);
}

/* ---------- 解析顶层令牌定义 ---------- */
const globalCss = removeConditionalBlocks(css);
const decls = new Map();
for (const m of globalCss.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
  decls.set(`--${m[1]}`, m[2].trim());
}
const definedNames = [...decls.keys()];

/* ---------- 收集消费方（src/public 下，排除 tokens.css 自身） ---------- */
function* walk(dir, exts) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, exts);
    else if (exts.some((e) => name.endsWith(e))) yield p;
  }
}
const consumerFiles = [];
for (const dir of ['src', 'public']) {
  try {
    for (const f of walk(path.join(ROOT, dir), ['.css', '.ts', '.tsx', '.js', '.mjs', '.html'])) {
      consumerFiles.push(f);
    }
  } catch { /* 目录不存在则跳过 */ }
}
try { consumerFiles.push(path.join(ROOT, 'index.html')); } catch { /* 忽略 */ }
const blob = consumerFiles
  .filter((f) => !f.endsWith('tokens.css'))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/* ---------- 基础活性 + 传递闭包 ---------- */
const base = new Set();
for (const name of definedNames) {
  const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-zA-Z0-9-])', 'g');
  if (re.test(blob)) base.add(name);
}
const refsInValue = new Map();
for (const [name, val] of decls) {
  const deps = new Set();
  const re = /var\(\s*(--[a-z0-9-]+)/g;
  let m;
  while ((m = re.exec(val)) !== null) deps.add(m[1]);
  refsInValue.set(name, deps);
}
const live = new Set(base);
let changed = true;
while (changed) {
  changed = false;
  for (const n of [...live]) {
    for (const d of refsInValue.get(n) ?? []) {
      if (!live.has(d)) { live.add(d); changed = true; }
    }
  }
}

const dead = definedNames.filter((n) => !live.has(n) && !keepTokens.has(n));
const kept = definedNames.filter((n) => !live.has(n) && keepTokens.has(n));

/* ---------- 输出 ---------- */
console.log(`令牌总数（顶层 :root）：${definedNames.length}`);
console.log(`活动：${live.size}  显式预留(@keep)：${kept.length}  死牌：${dead.length}`);
if (kept.length) {
  console.log('\n—— 显式预留（@keep，不计死牌）——');
  for (const n of kept) console.log(`  ${n}`);
}
if (dead.length) {
  console.log('\n—— 死牌（无消费方，建议删除或加 @keep 标注）——');
  for (const n of dead) console.log(`  ${n}  =  ${decls.get(n)}`);
} else {
  console.log('\n无死牌。');
}
if (CI && dead.length) {
  console.error(`\n[audit-tokens] 发现 ${dead.length} 个死牌，--ci 模式失败。`);
  process.exit(1);
}
