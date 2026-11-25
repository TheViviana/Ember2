import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * PLAN 纪律 22 的行为级兑现：# 别名在 package.json imports（唯一权威源）、
 * tsconfig×2、vite.config 三方必须与 imports 同步（含子路径）。
 * 六轮修复：ALIASES 改为从 package.json 现算（不再硬编码两个成员，新增第三个包测试自动覆盖）；
 * Node 子路径映射必须带扩展名（Node 原生解析不像 TS/Vite 会补 .ts）。
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(`${ROOT}${p}`, 'utf8');

const PKG = JSON.parse(read('package.json')) as { imports: Record<string, string> };
const IMPORT_KEYS = Object.keys(PKG.imports).filter((k) => k.startsWith('#'));
// 现算精确名集合（#foo/* 归并为 #foo）
const ALIASES = [...new Set(IMPORT_KEYS.map((k) => k.replace('/*', '')))];
// 子路径映射必须以 *.ts 结尾（Node 兼容）
const SUBPATH_KEYS = IMPORT_KEYS.filter((k) => k.endsWith('/*'));

void test('package.json imports 至少登记两个包别名（防误删导致门禁空转）', () => {
  assert.ok(ALIASES.length >= 2, `imports 别名过少：${IMPORT_KEYS.join(", ")}`);
});

void test('每个子路径别名映射到 *.ts（Node 原生解析无扩展名补全）', () => {
  assert.ok(SUBPATH_KEYS.length > 0, '应存在 #pkg/* 子路径条目');
  for (const key of SUBPATH_KEYS) {
    const target = PKG.imports[key];
    assert.ok(target !== undefined, `${key} 缺映射`);
    assert.match(target, /\.ts$/, `${key} 的映射必须以 .ts 结尾：${target}`);
    assert.ok(target.includes('/packages/'), `${key} 必须指向 packages/ 内：${target}`);
  }
});

void test('tsconfig.json 与 tests/tsconfig.json 的 paths 与 imports 同步（精确名+子路径）', () => {
  for (const file of ['tsconfig.json', 'tests/tsconfig.json']) {
    const conf = JSON.parse(read(file)) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    const paths = conf.compilerOptions.paths;
    for (const key of IMPORT_KEYS) {
      assert.ok(paths[key]?.length, `${file} 缺 ${key}`);
    }
  }
});

void test('vite.config.ts：每个别名都有正则锚定的精确名与子路径 alias', () => {
  const vite = read('vite.config.ts');
  for (const a of ALIASES) {
    assert.ok(vite.includes(`^${a}$`), `vite 缺精确锚定 ^${a}$`);
    assert.ok(vite.includes(`^${a}\\/(.*)$`), `vite 缺子路径锚定 ^${a}\\/(.*)$`);
  }
});

void test('Node 原生解析：#别名 与 #别名/* 子路径在 node --test 下真实可用（行为级）', async () => {
  const exact = await import('#doc-model');
  assert.ok(exact && typeof exact === 'object', '#doc-model 精确导入失败');
  const sub = await import('#doc-model/index');
  assert.ok(sub && typeof sub === 'object', '#doc-model/index 子路径导入失败');
  const canvas = await import('#canvas-format');
  assert.ok(canvas && typeof canvas === 'object', '#canvas-format 导入失败');
});
