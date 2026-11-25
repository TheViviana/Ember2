// gate:ipc-chokepoint —— IPC 收口门禁（R0 架构门禁）：扫描 src/**（排除 src/data/ 适配层），
// ipcClient 后跟 .invoke / .chatStream / .translateOnline 的每一处 CallExpression 都必须逐点在
// ipc-allowlist.json 登记。用 @typescript-eslint/parser 做 AST 计数，注释 / 字符串 / 模板串里的
// 字样一律不算；命令名取 invoke 第一个实参字面量，非字面量或 chatStream/translateOnline 记 <dynamic>。
// 匹配键 = file + callee + command + 同键第 n 次出现（ordinal），不按行号；白名单漏登记、过期、
// ceiling 漂移或超硬上限均判红。用法：node scripts/gates/ipc-chokepoint.mjs [根目录] [--init]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from '@typescript-eslint/parser';

const ARGS = process.argv.slice(2);
const INIT = ARGS.includes('--init');
const BASE = resolve(ARGS.find((arg) => !arg.startsWith('--')) ?? '.');
const HARD_CAP = 56;
const ALLOWLIST = join(BASE, 'scripts', 'gates', 'ipc-allowlist.json');
const CALLEES = new Set(['invoke', 'chatStream', 'translateOnline']);

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

// 递归遍历 ESTree AST，按源码顺序回调每个节点（Object.keys 保留 ESTree 定义的子节点顺序）。
function visit(node, cb) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  cb(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) visit(child, cb);
    } else if (val && typeof val === 'object' && typeof val.type === 'string') {
      visit(val, cb);
    }
  }
}

// 命中 ipcClient.<callee>(...) 的 CallExpression；返回 { callee, command }，否则 null。
function matchIpcCall(node) {
  if (node.type !== 'CallExpression') return null;
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression' || callee.computed) return null;
  const obj = callee.object;
  const prop = callee.property;
  if (!obj || obj.type !== 'Identifier' || obj.name !== 'ipcClient') return null;
  if (!prop || prop.type !== 'Identifier' || !CALLEES.has(prop.name)) return null;
  const name = prop.name;
  if (name === 'invoke') {
    const first = node.arguments[0];
    const command = first && first.type === 'Literal' && typeof first.value === 'string'
      ? first.value
      : '<dynamic>';
    return { callee: name, command };
  }
  return { callee: name, command: '<dynamic>' };
}

const sites = [];
const srcFiles = [];
try {
  for (const abs of walk(join(BASE, 'src'))) srcFiles.push(abs);
} catch (err) {
  console.error(`gate:ipc-chokepoint 失败：src/ 不可读（${err.code ?? String(err)}）`);
  process.exit(1);
}
for (const abs of srcFiles.sort()) {
  const file = relative(BASE, abs).split(sep).join('/');
  if (file.startsWith('src/data/')) continue;
  const source = readFileSync(abs, 'utf8');
  let ast;
  try {
    // filePath 让 parser 按扩展名决定是否启用 JSX：.tsx 开、.ts 不开，
    // 否则 .ts 里的泛型 <T> 会被当作 JSX 标签误报（与 layers.mjs 同口径）。
    ast = parse(source, {
      filePath: abs,
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: { jsx: true },
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      comment: false,
      tokens: false,
      loc: false,
      range: false,
    });
  } catch (err) {
    console.error(`gate:ipc-chokepoint 失败：${file} 解析失败（fail-closed，${err.message}）`);
    process.exit(1);
  }
  const ordinals = new Map();
  visit(ast, (node) => {
    const hit = matchIpcCall(node);
    if (!hit) return;
    const key = `${file}|${hit.callee}|${hit.command}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    sites.push({ file, callee: hit.callee, command: hit.command, ordinal });
  });
}

if (INIT) {
  // 与 ipc-allowlist.json 现有紧凑风格一致：每条 site 一行。
  const lines = sites.map((s) =>
    `    { "file": "${s.file}", "callee": "${s.callee}", "command": "${s.command}", "ordinal": ${s.ordinal} }`,
  );
  console.log(`{\n  "ceiling": ${sites.length},\n  "sites": [\n${lines.join(',\n')}\n  ]\n}`);
  process.exit(0);
}

let allow;
try {
  allow = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
} catch (err) {
  console.error(`gate:ipc-chokepoint 失败：${relative(BASE, ALLOWLIST)} 不可读或损坏（${err.message}）`);
  process.exit(1);
}
const allowSites = Array.isArray(allow.sites) ? allow.sites : [];
const violations = [];
if (!Number.isInteger(allow.ceiling)) violations.push('allowlist.ceiling 必须是整数');
if (allow.ceiling !== allowSites.length) {
  violations.push(`allowlist.ceiling=${allow.ceiling} 与 sites 数量 ${allowSites.length} 不一致（只删 sites 不减 ceiling）`);
}
if (Number.isInteger(allow.ceiling) && allow.ceiling > HARD_CAP) {
  violations.push(`allowlist.ceiling=${allow.ceiling} 超过硬上限 ${HARD_CAP}`);
}
const describe = (s) => `${s.file}  ${s.callee}('${s.command}') #${s.ordinal}`;
const allowKeys = new Set(allowSites.map((s) => `${s.file}|${s.callee}|${s.command}|${s.ordinal}`));
const actualKeys = new Set(sites.map((s) => `${s.file}|${s.callee}|${s.command}|${s.ordinal}`));
for (const site of sites) {
  if (!allowKeys.has(`${site.file}|${site.callee}|${site.command}|${site.ordinal}`)) {
    violations.push(`未登记的 ipcClient 调用（收口失败）：${describe(site)}`);
  }
}
for (const site of allowSites) {
  if (!actualKeys.has(`${site.file}|${site.callee}|${site.command}|${site.ordinal}`)) {
    violations.push(`白名单过期（该调用点已不存在）：${describe(site)}`);
  }
}
if (violations.length > 0) {
  console.error(`gate:ipc-chokepoint 失败，${violations.length} 处问题：`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`gate:ipc-chokepoint 通过（扫描 ${srcFiles.length} 个文件，调用点 ${sites.length} 处）`);
