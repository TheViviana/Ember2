// gate:mutable-exports —— 禁模块级可变导出（I11 / PLAN D12）。
// 拦截：export let/var；export const 以可变容器初始化（new Map/Set/WeakMap/WeakSet/Date/数组/对象字面量）。
// 放行：函数/类/箭头函数导出、Object.freeze 包裹的字面量、type/interface、纯 re-export。
// 解析失败 fail-closed（与 layers 同一纪律）。用法：node scripts/gates/mutable-exports.mjs [根目录]。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from '@typescript-eslint/parser';

const BASE = resolve(process.argv[2] ?? '.');
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs']);

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

const MUTABLE_CTOR = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Array', 'Object']);

/** 判定 const 初始化表达式是否为可变容器（Object.freeze 包裹视为不可变） */
function isMutableInit(init) {
  if (!init) return false;
  if (init.type === 'NewExpression' && init.callee?.type === 'Identifier' && MUTABLE_CTOR.has(init.callee.name)) {
    return true;
  }
  if (init.type === 'ArrayExpression' || init.type === 'ObjectExpression') return true;
  if (
    init.type === 'CallExpression' &&
    init.callee?.type === 'MemberExpression' &&
    init.callee.object?.type === 'Identifier' &&
    init.callee.object.name === 'Object' &&
    init.callee.property?.name === 'freeze'
  ) {
    // Object.freeze({…})/freeze([…])：外层冻结后字面量不可再增删属性 → 不可变，放行；
    // Object.freeze(new Map())：冻住的只是属性引用，容器内部仍可 mutate → 继续判内层。
    const arg = init.arguments?.[0];
    if (arg?.type === 'NewExpression') return isMutableInit(arg);
    return false;
  }
  return false;
}

const violations = [];
let scanned = 0;
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
    const rel = relative(BASE, file).split(sep).join('/');
    const source = readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parse(source, {
        filePath: file,
        ecmaFeatures: { jsx: true },
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        comment: false,
        tokens: false,
        loc: false,
        range: false,
      });
    } catch (err) {
      violations.push(`${rel}:  解析失败（fail-closed）：${/** @type {Error} */ (err).message}`);
      continue;
    }
    for (const node of ast.body) {
      if (node.type === 'VariableDeclaration' && (node.kind === 'let' || node.kind === 'var')) {
        const names = node.declarations.map((d) => d.id?.name ?? '?').join(', ');
        violations.push(`${rel}:  export ${node.kind} '${names}' —— 模块级可变绑定（I11/D12）`);
        continue;
      }
      if (node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportDefaultDeclaration') continue;
      const decl = node.declaration;
      if (!decl) continue;
      if (decl.type === 'VariableDeclaration' && decl.kind === 'let') {
        const names = decl.declarations.map((d) => d.id?.name ?? '?').join(', ');
        violations.push(`${rel}:  export let '${names}' —— 模块级可变绑定（I11/D12）`);
        continue;
      }
      if (decl.type === 'VariableDeclaration' && decl.kind === 'const') {
        for (const d of decl.declarations) {
          if (isMutableInit(d.init)) {
            violations.push(`${rel}:  export const '${d.id?.name ?? '?'}' —— 可变容器初始化（I11/D12；需要共享请经 EmberCore 实例或 Object.freeze）`);
          }
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`gate:mutable-exports 失败，${violations.length} 处命中：`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`gate:mutable-exports 通过（扫描 ${scanned} 个文件）`);
