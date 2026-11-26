// gate:command-registry —— 命令实现数必须等于 generate_handler! 注册数（CR-R2-11），
// 且 generate_handler! 注册名必须与 src/data/ipc-client.ts 的 IpcCommandMap 键完全一致。
// 用法：node scripts/gates/command-registry.mjs [根目录]（默认当前目录，测试可注入 fixture 根）。
// 判定口径：src-tauri/src 下全部 .rs 的 `#[tauri::command]` 出现次数 vs lib.rs 里
// generate_handler![ ... ] 的条目数；不等即失败。数量一致后再双向比较 Rust 注册名与 TS 映射键。
// 缺 generate_handler / 解析为空 / 缺 IpcCommandMap 一律失败（fail-closed），
// 避免「注册表被删掉一半」或「数量相同但名称错位」被误放通过。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@typescript-eslint/parser';

const BASE = process.argv[2] ?? '.';
const SRC = join(BASE, 'src-tauri', 'src');
const LIB = join(SRC, 'lib.rs');
const IPC_CLIENT = join(BASE, 'src', 'data', 'ipc-client.ts');
const ATTR = '#[tauri::command]';
const HANDLER = 'generate_handler!';

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
    else if (name.endsWith('.rs')) yield p;
  }
}

// 命令实现数：逐文件按固定字面量出现次数累加，避免正则/字符串上下文误判。
function countImplemented() {
  let files;
  try {
    files = [...walk(SRC)];
  } catch (err) {
    return { error: `src-tauri/src 不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——命令实现数无法统计` };
  }
  let count = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    count += source.split(ATTR).length - 1;
  }
  return { count };
}

// 注册名：定位 generate_handler! 后的方括号参数列表，按深度配对取全量，再按逗号切条目。
function readRegistered() {
  let source;
  try {
    source = readFileSync(LIB, 'utf8');
  } catch (err) {
    return { error: `src-tauri/src/lib.rs 不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——注册数无法统计` };
  }
  const start = source.indexOf(HANDLER);
  if (start === -1) return { error: `lib.rs 未找到 ${HANDLER}，无法校验命令注册` };
  const open = source.indexOf('[', start);
  if (open === -1) return { error: `${HANDLER} 缺少参数列表` };
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return { error: `${HANDLER} 参数列表未闭合` };
  const entries = source
    .slice(open + 1, end)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const names = [];
  for (const entry of entries) {
    const match = entry.match(/([A-Za-z_][A-Za-z0-9_]*)$/);
    if (match === null) return { error: `${HANDLER} 条目无法解析命令名：${entry}` };
    names.push(match[1]);
  }
  return { count: entries.length, names };
}

// TS 映射键：用 AST 只读取 IpcCommandMap 的属性签名，避免注释/字符串干扰。
function readMappedCommands() {
  let source;
  try {
    source = readFileSync(IPC_CLIENT, 'utf8');
  } catch (err) {
    return { error: `src/data/ipc-client.ts 不可读（${/** @type {NodeJS.ErrnoException} */ (err).code ?? String(err)}）——IpcCommandMap 无法校验` };
  }
  let ast;
  try {
    ast = parse(source, { filePath: IPC_CLIENT, ecmaVersion: 'latest', sourceType: 'module' });
  } catch (err) {
    return { error: `src/data/ipc-client.ts 解析失败（${err.message}）` };
  }
  const declarations = ast.body.flatMap((node) =>
    node.type === 'ExportNamedDeclaration' && node.declaration !== null
      ? [node.declaration]
      : [node],
  );
  const declaration = declarations.find(
    (node) => node.type === 'TSInterfaceDeclaration' && node.id.name === 'IpcCommandMap',
  );
  if (declaration === undefined) return { error: 'src/data/ipc-client.ts 未找到 IpcCommandMap' };
  const names = [];
  for (const property of declaration.body.body) {
    if (property.type !== 'TSPropertySignature' || property.computed) {
      return { error: 'IpcCommandMap 仅允许普通命令属性签名' };
    }
    if (property.key.type === 'Identifier') names.push(property.key.name);
    else if (property.key.type === 'Literal' && typeof property.key.value === 'string') {
      names.push(property.key.value);
    } else return { error: 'IpcCommandMap 存在无法解析的命令键' };
  }
  return { names };
}

const implemented = countImplemented();
if (implemented.error) {
  console.error(`gate:command-registry 失败：${implemented.error}`);
  process.exit(1);
}

const registered = readRegistered();
if (registered.error) {
  console.error(`gate:command-registry 失败：${registered.error}`);
  process.exit(1);
}

if (registered.count === 0) {
  console.error('gate:command-registry 失败：generate_handler! 解析为空，注册表缺失');
  process.exit(1);
}

if (implemented.count !== registered.count) {
  console.error(
    `gate:command-registry 失败：命令实现 ${implemented.count} 个，generate_handler! 注册 ${registered.count} 个，数量不一致`,
  );
  process.exit(1);
}

const mapped = readMappedCommands();
if (mapped.error) {
  console.error(`gate:command-registry 失败：${mapped.error}`);
  process.exit(1);
}

const registeredNames = new Set(registered.names);
const mappedNames = new Set(mapped.names);
if (registeredNames.size !== registered.names.length || mappedNames.size !== mapped.names.length) {
  console.error('gate:command-registry 失败：Rust 注册表或 IpcCommandMap 存在重复命令名');
  process.exit(1);
}
const missing = [...registeredNames].filter((name) => !mappedNames.has(name)).sort();
const extra = [...mappedNames].filter((name) => !registeredNames.has(name)).sort();
if (missing.length > 0 || extra.length > 0) {
  const details = [
    missing.length > 0 ? `IpcCommandMap 缺少：${missing.join(', ')}` : '',
    extra.length > 0 ? `IpcCommandMap 多余：${extra.join(', ')}` : '',
  ].filter(Boolean).join('；');
  console.error(`gate:command-registry 失败：命令名称不一致（${details}）`);
  process.exit(1);
}

console.log(
  `gate:command-registry 通过（命令实现 ${implemented.count} == 注册 ${registered.count} == IpcCommandMap ${mapped.names.length}，名称一致）`,
);
