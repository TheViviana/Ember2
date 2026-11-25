// gate:cycles —— 模块级循环依赖（SCC）检测（R0 架构门禁）：扫描 src/ 与 packages/ 的 .ts/.tsx，
// 解析 import / export-from / 动态 import / require 建图，Tarjan 求 SCC，只报 size>1 的环
// （import type 同样构成边）；环身份 = 排序后的相对路径集合。白名单 {"ceiling":N,"cycles":[...]}：
// 新增环、白名单过期、ceiling 漂移或超硬上限均判红。用法：node scripts/gates/cycles.mjs [根目录] [--init]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from '@typescript-eslint/parser';
const ARGS = process.argv.slice(2);
const INIT = ARGS.includes('--init');
const BASE = resolve(ARGS.find((arg) => !arg.startsWith('--')) ?? '.');
const HARD_CAP = 2;
const ALLOWLIST = join(BASE, 'scripts', 'gates', 'cycles-allowlist.json');
function* walk(dir) {
  let names;
  try { names = readdirSync(dir); } catch (err) { if (err.code === 'ENOENT') return; throw err; }
  for (const name of names) {
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch (err) { if (err.code !== 'ENOENT') throw err; continue; }
    if (st.isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name)) yield p;
  }
}
// 与 layers 同口径：AST 提取，注释/字符串里的 import 字样不误报。
function collect(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) collect(item, out); return; }
  const kinds = ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'];
  const src = node.source;
  if (kinds.includes(node.type) && src?.type === 'Literal' && typeof src.value === 'string') out.push(src.value);
  const arg = node.arguments?.[0];
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
    if (arg?.type === 'Literal' && typeof arg.value === 'string') out.push(arg.value);
  }
  for (const key of Object.keys(node)) {
    if (key !== 'parent' && key !== 'loc' && key !== 'range') collect(node[key], out);
  }
}
// 别名唯一权威源是 package.json imports；不可读时 fail-closed（别名边消失会让门禁假绿）。
function loadAliases() {
  try {
    const pkg = JSON.parse(readFileSync(join(BASE, 'package.json'), 'utf8'));
    return Object.entries(pkg.imports ?? {})
      .filter(([key, target]) => key.startsWith('#') && typeof target === 'string' && target.startsWith('./'));
  } catch { return null; }
}
const aliases = loadAliases();
const problems = aliases === null ? ['package.json:  不可读或损坏 —— # 别名边无法解析（fail-closed）'] : [];
const files = new Map();
for (const root of ['src', 'packages']) {
  try {
    for (const abs of walk(join(BASE, root))) files.set(relative(BASE, abs).split(sep).join('/'), abs);
  } catch (err) {
    problems.push(`${root}/  目录不可读（${err.code ?? String(err)}）——该树未被扫描`);
  }
}
function resolveSpec(spec, importer) {
  const bases = [];
  if (spec.startsWith('.')) {
    bases.push(resolve(dirname(join(BASE, importer)), spec));
  } else if (aliases !== null) {
    for (const [key, target] of aliases) {
      if (key.endsWith('/*') && spec.startsWith(key.slice(0, -1))) {
        bases.push(resolve(BASE, target.replace('*', spec.slice(key.length - 1))));
        break;
      }
      if (spec === key) { bases.push(resolve(BASE, target)); break; }
    }
  }
  for (const base of bases) {
    for (const probe of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
      const rel = relative(BASE, probe).split(sep).join('/');
      if (files.has(rel)) return rel;
    }
  }
  return null;
}
const graph = new Map();
for (const [rel, abs] of files) {
  let ast = null;
  try {
    ast = parse(readFileSync(abs, 'utf8'), {
      filePath: abs, ecmaFeatures: { jsx: true }, ecmaVersion: 'latest', sourceType: 'module',
      allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
      comment: false, tokens: false, loc: false, range: false,
    });
  } catch (err) {
    problems.push(`${rel}:  解析失败（fail-closed）：${err.message}`);
  }
  const refs = [];
  if (ast !== null) collect(ast, refs);
  const next = new Set();
  for (const ref of refs) {
    const target = resolveSpec(ref, rel);
    if (target !== null && target !== rel) next.add(target);
  }
  graph.set(rel, [...next]);
}
// Tarjan 强连通分量：分量 size>1 即环；排序后作为身份，与行号无关。
function findCycles(graphMap) {
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];
  const visit = (node) => {
    idx.set(node, index); low.set(node, index); index += 1;
    stack.push(node); onStack.add(node);
    for (const next of graphMap.get(node) ?? []) {
      if (!idx.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), idx.get(next)));
    }
    if (low.get(node) !== idx.get(node)) return;
    const comp = [];
    let popped;
    do { popped = stack.pop(); onStack.delete(popped); comp.push(popped); } while (popped !== node);
    if (comp.length > 1) cycles.push(comp.sort());
  };
  for (const node of graphMap.keys()) if (!idx.has(node)) visit(node);
  return cycles.sort((a, b) => a.join('|').localeCompare(b.join('|')));
}
const actual = findCycles(graph);
if (INIT) {
  // 一环一行：便于 grep -c '"src/' 直接核对环数量。
  const body = actual.map((cycle) => `    [${cycle.map((f) => JSON.stringify(f)).join(', ')}]`).join(',\n');
  console.log(`{\n  "ceiling": ${actual.length},\n  "cycles": [\n${body}\n  ]\n}`);
  process.exit(0);
}
if (problems.length > 0) {
  console.error(`gate:cycles 失败，配置或扫描有 ${problems.length} 处问题：`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
let allow;
try {
  allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
} catch (err) {
  console.error(`gate:cycles 失败：${relative(BASE, ALLOWLIST)} 不可读或损坏（${err.message}）`);
  process.exit(1);
}
const allowCycles = Array.isArray(allow.cycles) ? allow.cycles : [];
const violations = [];
if (!Number.isInteger(allow.ceiling)) violations.push('allowlist.ceiling 必须是整数');
if (allow.ceiling !== allowCycles.length) {
  violations.push(`allowlist.ceiling=${allow.ceiling} 与 cycles 数量 ${allowCycles.length} 不一致（只删 cycles 不减 ceiling）`);
}
if (Number.isInteger(allow.ceiling) && allow.ceiling > HARD_CAP) {
  violations.push(`allowlist.ceiling=${allow.ceiling} 超过硬上限 ${HARD_CAP}`);
}
const key = (cycle) => cycle.join('|');
const allowKeys = new Set(allowCycles.map(key));
const actualKeys = new Set(actual.map(key));
for (const cycle of actual) {
  if (!allowKeys.has(key(cycle))) violations.push(`新增环（${cycle.length} 文件）：\n      ${cycle.join('\n      ')}`);
}
for (const cycle of allowCycles) {
  if (!actualKeys.has(key(cycle))) violations.push(`白名单过期：\n      ${cycle.join('\n      ')}`);
}
if (violations.length > 0) {
  console.error(`gate:cycles 失败，${violations.length} 处问题：`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`gate:cycles 通过（扫描 ${files.size} 个文件，环 ${actual.length} 处）`);
