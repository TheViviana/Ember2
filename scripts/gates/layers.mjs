// gate:layers —— 依赖方向检查（PLAN.md §1.1）。
// 提取方式：用 @typescript-eslint/parser（真 AST，支持 TS/TSX/模板串插值/正则字面量/注释）
// 解析后遍历 AST 提取模块引用——ImportDeclaration / Export(All|Named)Declaration.source /
// 动态 ImportExpression / require 调用。解析失败一律计为违规（fail-closed），绝不静默跳过。
// bare 包名匹配分三种语义：'@tauri-apps/' 前缀、其余「全等或子路径」。同一 (文件, 引用) 只报一次。
// 用法：node scripts/gates/layers.mjs [根目录]（默认当前目录，测试可注入 fixture 根）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from '@typescript-eslint/parser';

const BASE = resolve(process.argv[2] ?? '.');
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs']);

// ---- 规则表（与 PLAN.md §1.1 对齐）----
const RULES = [
  {
    id: 'packages 纯逻辑层',
    match: (file) => file.startsWith(`packages${sep}`),
    forbidBare: ['react', 'react-dom', 'zustand', '@tauri-apps/'],
    forbidTarget: (t, importer) => {
      if (t.kind === 'src') return 'packages 禁引 src/**';
      if (t.kind === 'package' && t.pkg !== currentPackage(importer)) return 'packages 禁止跨包引用（含 #别名 与 @ember/*）';
      return null;
    },
  },
  {
    id: 'core 层',
    match: (file) => file.startsWith(`src${sep}core${sep}`),
    forbidBare: ['react', 'react-dom', 'zustand', '@tauri-apps/'],
    forbidTarget: (t) => {
      if (t.kind === 'srcLayer' && ['app', 'features', 'data', 'canvas', 'windows', 'editor'].includes(t.layer)) {
        return `core 禁引 src/${t.layer}`;
      }
      return null;
    },
  },
  {
    id: 'features 层',
    match: (file) => file.startsWith(`src${sep}features${sep}`),
    forbidBare: [],
    forbidTarget: (t) => {
      if (t.kind === 'srcLayer' && t.layer === 'app') return 'features 禁引 src/app';
      // PLAN §1.1：features 不得越层直引 packages，须经 core（canvas/windows/editor 例外，
      // P4 画布引擎按 PLAN §7 直接消费 canvas-format，见 PLAN §1.1 修订）
      if (t.kind === 'package') return 'features 禁止越层直引 packages（须经 core）';
      return null;
    },
  },
  {
    id: 'data 层',
    match: (file) => file.startsWith(`src${sep}data${sep}`),
    forbidBare: ['react', 'react-dom', 'zustand'], // D12：zustand 仅 app/features 层
    forbidTarget: (t) => {
      if (t.kind === 'srcLayer' && (t.layer === 'app' || t.layer === 'features')) {
        return `data 禁引 src/${t.layer}（适配层不得反向依赖上层）`;
      }
      return null;
    },
  },
  {
    id: '非 app/features 层禁引 zustand（D12）',
    match: (file) =>
      file.startsWith(`src${sep}`) &&
      !file.startsWith(`src${sep}app${sep}`) &&
      !file.startsWith(`src${sep}features${sep}`),
    forbidBare: ['zustand'],
    forbidTarget: () => null,
  },
  {
    id: 'data 层独占 @tauri-apps',
    match: (file) => file.startsWith(`src${sep}`) && !file.startsWith(`src${sep}data${sep}`),
    forbidBare: ['@tauri-apps/'],
    forbidTarget: () => null,
  },
  {
    id: 'windows/editor 层包禁引',
    match: (file) =>
      file.startsWith(`src${sep}windows${sep}`) || file.startsWith(`src${sep}editor${sep}`),
    forbidBare: [],
    forbidTarget: (t) => (t.kind === 'package' ? 'windows/editor 禁止直引 packages（须经 core）' : null),
  },
  {
    id: '非 app 层禁引 app',
    match: (file) => file.startsWith(`src${sep}`) && !file.startsWith(`src${sep}app${sep}`),
    forbidBare: [],
    forbidTarget: (t) => (t.kind === 'srcLayer' && t.layer === 'app' ? '非 app 层禁引 src/app' : null),
  },
];

// 从 package.json imports 读取全部 # 别名 → 包名映射（key 精确名与 /* 子路径归并为同一包）。
// 七轮修复：缓存单次读取；package.json 不可读/损坏时返回 error（fail-closed），
// 不再当「无别名」处理——那会报一堆误导性的「未登记」而非配置错误。
let aliasCache = null;
function loadAliasMap() {
  if (aliasCache) return aliasCache;
  const map = new Map();
  const confPath = join(BASE, 'package.json');
  // 九轮审查：existsSync 对 EACCES 也返回 false——改 statSync 区分「不存在」与「不可读」
  try {
    statSync(confPath);
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    const reason = code === 'ENOENT'
      ? '扫描根缺 package.json（# 别名唯一权威源）——门禁无法解析别名，fail-closed；若非仓库根请指定正确根或提供 imports'
      : `package.json 不可读（${code ?? String(err)}）——别名无法解析，fail-closed`;
    aliasCache = { map, error: reason };
    return aliasCache;
  }
  try {
    const pkgJson = JSON.parse(readFileSync(confPath, 'utf8'));
    for (const [key, value] of Object.entries(pkgJson.imports ?? {})) {
      const m = typeof value === 'string' ? value.match(/^\.\/packages\/([^/]+)\//) : null;
      if (key.startsWith('#') && m) {
        map.set(key.replace(/\/\*$/, ''), m[1]);
      }
    }
    aliasCache = { map, error: null };
  } catch (err) {
    aliasCache = { map, error: `package.json 不可读或损坏（${/** @type {NodeJS.ErrnoException} */ (err).message}）——别名无法解析，fail-closed` };
  }
  return aliasCache;
}

function currentPackage(file) {
  const m = file.match(new RegExp(`^packages${sep}([^${sep.replace('\\', '\\\\')}]+)`));
  return m?.[1] ?? null;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return;
    throw err;
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

// ---- AST 提取：ImportDeclaration / Export(All|Named)Declaration.source / 动态 ImportExpression / require() ----
function collectSpecifiers(node, specs) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectSpecifiers(item, specs);
    return;
  }
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportAllDeclaration':
    case 'ExportNamedDeclaration': {
      const s = node.source;
      if (s?.type === 'Literal' && typeof s.value === 'string') specs.push(s.value);
      break;
    }
    case 'ImportExpression': {
      // 动态 import('x', { … })：@typescript-eslint/parser 的 ImportExpression.source
      const s = node.source;
      if (s?.type === 'Literal' && typeof s.value === 'string') specs.push(s.value);
      break;
    }
    case 'CallExpression': {
      if (node.callee?.type === 'Identifier' && node.callee.name === 'require') {
        const a = node.arguments?.[0];
        if (a?.type === 'Literal' && typeof a.value === 'string') specs.push(a.value);
      }
      break;
    }
    default:
      break;
  }
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range') continue;
    collectSpecifiers(node[key], specs);
  }
}


// ---- bare 包名匹配：'@tauri-apps/' 前缀；其余全等或子路径（reactflow≠react，react-dom/client∈react-dom）----
function bareViolates(name, banned) {
  if (banned.endsWith('/')) return name.startsWith(banned);
  return name === banned || name.startsWith(`${banned}/`);
}

// 解析一个 specifier 相对 importer 的目标位置
function resolveTarget(spec, importer) {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(join(BASE, importer)), spec);
    const rel = relative(BASE, base);
    const norm = rel.split(sep).join('/');
    if (norm.startsWith('packages/')) {
      const pkg = norm.slice('packages/'.length).split('/')[0];
      return { kind: 'package', pkg, file: rel };
    }
    if (norm.startsWith('src/')) {
      return { kind: 'srcLayer', layer: norm.slice('src/'.length).split('/')[0], file: rel };
    }
    return { kind: 'other', file: rel };
  }
  // 动态别名表：从 package.json imports 现算（六轮修复：硬编码两分支会让新增包静默绕过规则）
  const { map: aliases } = loadAliasMap();
  let matched = null;
  for (const [key, pkg] of aliases) {
    if (spec === key || spec.startsWith(`${key}/`)) {
      matched = pkg;
      break;
    }
  }
  if (matched !== null) {
    return { kind: 'package', pkg: matched, file: `packages/${matched}` };
  }
  if (spec.startsWith('#')) {
    // 未登记的 # 别名：fail-closed，绝不当作 bare 放行
    return { kind: 'unregisteredAlias', name: spec };
  }
  if (spec.startsWith('@ember/')) {
    return { kind: 'package', pkg: spec.slice('@ember/'.length), file: `packages/${spec.slice('@ember/'.length)}` };
  }
  if (spec.startsWith('@/')) {
    // tsconfig 路径别名（若未来配置）：按 src 内层路径处理
    return { kind: 'srcLayer', layer: spec.slice(2).split('/')[0], file: `src/${spec.slice(2)}` };
  }
  return { kind: 'bare', name: spec };
}

const violations = [];
const seen = new Set(); // (文件, 引用) 去重：重叠规则只报首条，统计不失真
let scanned = 0;
{
  const { error } = loadAliasMap();
  if (error) violations.push(`package.json:  ${error}`);
}
for (const root of ['packages', 'src']) {
  let files;
  try {
    files = [...walk(join(BASE, root))];
  } catch (err) {
    violations.push(`${root}/  目录不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——该树未被扫描`);
    continue;
  }
  for (const file of files) {
    scanned += 1;
    const rel = relative(BASE, file);
    const source = readFileSync(file, 'utf8');
    let ast;
    try {
      // parse() 直接返回 Program（非 { ast } 包装）
      ast = parse(source, {
        filePath: file,
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowImportExportEverywhere: true,
        comment: false,
        tokens: false,
        loc: false,
        range: false,
      });
    } catch (err) {
      // 解析失败 = 这份文件没被检查，必须显式失败（fail-closed），与目录不可读同一纪律
      violations.push(`${rel.split(sep).join('/')}:  解析失败（fail-closed）：${/** @type {Error} */ (err).message}`);
      continue;
    }
    const specs = [];
    collectSpecifiers(ast, specs);
    for (const spec of specs) {
      const dedupeKey = `${rel}|${spec}`;
      if (seen.has(dedupeKey)) continue;
      const target = resolveTarget(spec, rel);
      if (target.kind === 'unregisteredAlias') {
        // 与层无关的全局不变量：必须在规则循环外判定，不依赖「该文件命中某条规则」
        seen.add(dedupeKey);
        violations.push(`${rel.split(sep).join('/')}:  未登记 # 别名 —— '${target.name}'（必须在 package.json imports 登记并同步各配置）`);
        continue;
      }
      for (const rule of RULES) {
        if (!rule.match(rel)) continue;
        if (target.kind === 'bare') {
          const banned = rule.forbidBare.find((b) => bareViolates(target.name, b));
          if (banned !== undefined) {
            seen.add(dedupeKey);
            violations.push(`${rel.split(sep).join('/')}:  ${rule.id} —— 引用了被禁模块 '${target.name}'`);
            break;
          }
        } else {
          const reason = rule.forbidTarget(target, rel);
          if (reason) {
            seen.add(dedupeKey);
            violations.push(`${rel.split(sep).join('/')}:  ${rule.id} —— '${spec}'（${reason}）`);
            break;
          }
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`gate:layers 失败，${violations.length} 处越界：`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`gate:layers 通过（扫描 ${scanned} 个文件）`);
