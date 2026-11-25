// gate:bans —— 全仓禁用模式扫描（PLAN.md §1.1）。命中即失败，输出 文件:行。
// 用法：node scripts/gates/bans.mjs [根目录]（默认当前目录，测试可注入 fixture 根）。
// 错误处理纪律（2026-11-15 审查修复）：根目录不存在（ENOENT，阶段早期未建）才允许跳过；
// 其它任何读取错误（权限/ENOTDIR 等）一律计为违规，绝不静默跳过后报「通过」。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const BASE = process.argv[2] ?? '.';
// 目录 + 仓库根级单文件（五轮修复：「全仓扫描」此前从不覆盖 vite.config.ts / eslint.config.mjs）
const ROOTS = ['src', 'packages', 'tests', 'scripts', 'src-tauri/src'];
// 仓库顶层任意 .ts/.tsx/.mjs/.rs 单文件自动纳入扫描（六轮修复：硬编码白名单会漏新增配置文件）
// 自排除仅限门禁脚本本身（规则表必然包含禁用模式的字面量）。
// 测试文件不得加入自排除——其 fixture 禁用字面量必须用字符串拼接构造，
// 保证 tests/ 永远在扫描范围内（2026-11-15 二轮审查修复：不许制造永久盲区）。
const SELF = /gates[\\/](bans\.mjs|layers\.mjs)$/;
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.mts', '.cts', '.rs']);

const BANS = [
  { pattern: /:\s*any\b/, label: '`: any`' },
  { pattern: /\bas\s+any\b/, label: '`as any`' },
  { pattern: /<any>/, label: '`<any>`' },
  { pattern: /\bany\[\]/, label: '`any[]`' },
  { pattern: /\bany\s*>/, label: '`any>`（如 Record<string, any>）' },
  { pattern: /\btype\s+[A-Za-z_$][\w$]*\s*=\s*any\b/, label: '`type X = any`' },
  { pattern: /@ts-ignore/, label: '`@ts-ignore`' },
  { pattern: /@ts-expect-error/, label: '`@ts-expect-error`' },
  { pattern: /@ts-nocheck/, label: '`@ts-nocheck`' },
  { pattern: /eslint-disable/, label: '`eslint-disable`' },
  { pattern: /#\[\s*allow/, label: 'Rust `#[allow]`' },
  { pattern: /#!\[\s*allow/, label: 'Rust `#![allow]`（crate 级）' },
  { pattern: /#!\[\s*expect/, label: 'Rust `#![expect]`（crate 级）' },
  { pattern: /#\[\s*expect/, label: 'Rust `#[expect]`' },
  { pattern: /\b(TODO|FIXME|HACK)\b/, label: 'TODO/FIXME/HACK 注释' },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return; // 根目录未建：合法跳过
    throw err; // 其它错误上抛，由调用方计为违规
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
      continue;
    }
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(name.slice(name.lastIndexOf('.')))) yield p;
  }
}

// BASE 顶层单文件（扩展名匹配即扫，自动覆盖未来新增的 *.config.ts 等）。
// 六轮纪律修正：statSync 失败不再静默过滤（return false 会制造盲区），改为显式上报。
function rootLevelFiles() {
  let entries;
  try {
    entries = readdirSync(BASE);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { files: [], errors: [] };
    return { files: [], errors: [`<仓库根> 不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——顶层文件未被扫描`] };
  }
  const files = [];
  const errors = [];
  for (const name of entries) {
    const p = join(BASE, name);
    try {
      const st = statSync(p);
      if (st.isFile() && EXTS.has(name.slice(name.lastIndexOf('.')))) files.push(name);
    } catch (err) {
      // 条目级 ENOENT（扫描中途被删）也显式上报，不留静默跳过（八轮审查：四轮 L4 残留）
      errors.push(`${name} 不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——未被扫描`);
    }
  }
  return { files, errors };
}

const violations = [];
const topLevel = rootLevelFiles();
violations.push(...topLevel.errors.map((e) => `${e}（bans）`));
for (const root of [...ROOTS, ...topLevel.files]) {
  let files;
  try {
    const st = statSync(join(BASE, root));
    files = st.isFile() ? [join(BASE, root)] : [...walk(join(BASE, root))];
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue; // 阶段早期未建：合法跳过
    // 其它错误（权限/ENOTDIR 等）：这棵树没查就是没查，必须显式失败
    violations.push(`${root}  不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——未被扫描`);
    continue;
  }
  for (const file of files) {
    if (SELF.test(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const { pattern, label } of BANS) {
        if (pattern.test(line)) violations.push(`${relative(BASE, file)}:${i + 1}  ${label}`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(`gate:bans 失败，${violations.length} 处命中：`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('gate:bans 通过');
