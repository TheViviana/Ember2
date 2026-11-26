import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：本文件会被 gate:bans 扫描（不在自排除名单）。
// 夹具中的禁用模式字面量一律用字符串拼接构造，保证本文件自身永不命中禁用模式。
const BANNED_LINE = `const a: an${'y'} = 1; // ${'TO'}${'DO'} 修`;
const PATTERN_ANY = new RegExp(': an' + 'y');
const PATTERN_TODO = new RegExp('TO' + 'DO');

const GATES = fileURLToPath(new URL('../scripts/gates/', import.meta.url));

function makeFixture(): string {
  return mkdtempSync(join(tmpdir(), 'ember-gate-'));
}

type GateName =
  | 'bans.mjs'
  | 'layers.mjs'
  | 'mutable-exports.mjs'
  | 'cycles.mjs'
  | 'ipc-chokepoint.mjs'
  | 'command-registry.mjs';

function runGate(script: GateName, root: string): SpawnSyncReturns<string> {
  return spawnSync('node', [join(GATES, script), root], { encoding: 'utf8' });
}

// 夹具：写入文件树 + 白名单后跑门禁，返回已捕获的结果（断言前清理）。
function runFixture(
  gate: GateName,
  files: Record<string, string>,
  allowlistName: string,
  allowlist: unknown,
): SpawnSyncReturns<string> {
  const root = makeFixture();
  try {
    writeFixturePackageJson(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    mkdirSync(join(root, 'scripts', 'gates'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'gates', allowlistName), JSON.stringify(allowlist));
    return runGate(gate, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}


// 六轮修复：layers 从 package.json imports 动态读取别名，fixture 根须带同名 imports
function writeFixturePackageJson(root: string): void {
  // 七轮修复：夹具从权威源（仓库根 package.json）复制 imports，不再手写副本（会与 *.ts 映射漂移）
  const real = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
    imports: Record<string, string>;
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ imports: real.imports }));
}

void test('gate:bans：干净 fixture 通过', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'ok.ts'), 'const answer = 42;\n');
    const r = runGate('bans.mjs', root);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:bans：命中禁用模式必须失败', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'bad.ts'), `${BANNED_LINE}\n`);
    const r = runGate('bans.mjs', root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, PATTERN_ANY);
    assert.match(r.stderr, PATTERN_TODO);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:bans：根不可读（chmod 000 目录）必须失败而不是静默跳过', () => {
  const root = makeFixture();
  const locked = join(root, 'packages');
  try {
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'bad.ts'), `${BANNED_LINE}\n`);
    chmodSync(locked, 0o000); // 目录不可读：readdirSync 抛 EACCES，这棵树没查就是没查
    const r = runGate('bans.mjs', root);
    assert.equal(r.status, 1, '不可读的树必须显式失败');
    assert.match(r.stderr, /未被扫描/);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：首轮六类漏检写法全部命中', () => {
  const root = makeFixture();
  try {
    writeFixturePackageJson(root);
    mkdirSync(join(root, 'src', 'features'), { recursive: true });
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    mkdirSync(join(root, 'packages', 'p1', 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'features', 'a.ts'), "import { x } from '../app/boot';\n");
    writeFileSync(join(root, 'src', 'features', 'b.ts'), "export { y } from '../app/boot';\n");
    writeFileSync(join(root, 'src', 'core', 'c.ts'), "const m = await import('react');\n");
    writeFileSync(join(root, 'src', 'app', 'd.ts'), "import { invoke } from '@tauri-apps/api/core';\n");
    writeFileSync(join(root, 'packages', 'p1', 'src', 'index.ts'), "import { z } from '#doc-model';\n");
    writeFileSync(join(root, 'src', 'data', 'ok.ts'), "import { invoke } from '@tauri-apps/api/core';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /features 禁引 src\/app/);
    assert.match(r.stderr, /react/);
    assert.match(r.stderr, /@tauri-apps\/api\/core/);
    assert.match(r.stderr, /跨包引用/);
    const okLines = r.stderr.split('\n').filter((l) => l.includes('data/ok.ts'));
    assert.equal(okLines.length, 0, 'data 层 @tauri-apps 不应误报');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：二轮修复——前缀误报与重复报告不再出现', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    // 'reactflow' 不是 react（前缀匹配误报回归）
    writeFileSync(join(root, 'src', 'app', 'rf.ts'), "import { flow } from 'reactflow';\n");
    // 'react-dom/client' 在 data 层只应报一次（react 与 react-dom 各匹配一次的重复报告回归）
    writeFileSync(join(root, 'src', 'data', 'dom.ts'), "import { createRoot } from 'react-dom/client';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const domLines = r.stderr.split('\n').filter((l) => l.includes('data/dom.ts'));
    assert.equal(domLines.length, 1, `react-dom/client 应恰好报一次，实际 ${domLines.length}`);
    const rfLines = r.stderr.split('\n').filter((l) => l.includes('reactflow'));
    assert.equal(rfLines.length, 0, 'reactflow 不得被判为 react');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：二轮修复——四类漏检写法全部命中', () => {
  const root = makeFixture();
  try {
    writeFixturePackageJson(root);
    mkdirSync(join(root, 'src', 'features'), { recursive: true });
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    // 1. require() 形式：core → zustand
    writeFileSync(join(root, 'src', 'core', 'r.ts'), "const z = require('zustand');\n");
    // 2. 带选项的动态 import：features → app
    writeFileSync(join(root, 'src', 'features', 'd.ts'), "const m = import('../app/boot', { with: { type: 'json' } });\n");
    // 3. '@/ 别名：core → app
    writeFileSync(join(root, 'src', 'core', 'a.ts'), "import { x } from '@/app/boot';\n");
    // 4. features 越层直引 packages（须经 core）
    writeFileSync(join(root, 'src', 'features', 'p.ts'), "import { y } from '#doc-model';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /zustand/);
    assert.match(r.stderr, /features 禁引 src\/app/);
    assert.match(r.stderr, /@\/app\/boot/);
    assert.match(r.stderr, /越层直引 packages/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：注释与普通字符串里的 import 字样永不误报（三轮修复回归）', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    mkdirSync(join(root, 'src', 'features'), { recursive: true });
    // 以下三份文件在 core/features 层，若按文本扫描必然误报——分词后必须全部通过
    writeFileSync(join(root, 'src', 'core', 'comment.ts'), "// import { x } from 'react'\n");
    writeFileSync(join(root, 'src', 'core', 'block.ts'), "/* import('react') — 文档示例 */\n");
    writeFileSync(join(root, 'src', 'features', 'str.ts'), "const doc = \"import { y } from 'react'\";\n");
    // 同文件同引用被重叠规则命中时只报一次
    writeFileSync(join(root, 'src', 'core', 'alias.ts'), "import { x } from '@/app/boot';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const lines = r.stderr.split('\n').filter((l) => l.includes('src/'));
    assert.equal(lines.length, 1, `只应报 alias.ts 一条，实际 ${lines.length}：\n${r.stderr}`);
    assert.match(r.stderr, /@\/app\/boot/);
    assert.ok(!r.stderr.includes('comment.ts'), '行注释不得误报');
    assert.ok(!r.stderr.includes('block.ts'), '块注释不得误报');
    assert.ok(!r.stderr.includes('str.ts'), '字符串内容不得误报');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：四轮修复——三种真实引用不再漏检（先红后绿的失败用例）', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    // 1. 模板串插值内的动态 import（真引用，此前被模板串吞掉）
    writeFileSync(join(root, 'src', 'core', 'tpl.ts'), "const m = `pre ${await import('zustand')} post`;\n");
    // 2. 模板串插值内的 require（真引用，此前同被吞掉）
    writeFileSync(join(root, 'src', 'core', 'tpl-req.ts'), "const z = `${require('zustand')}`;\n");
    // 3. `}` 后跟 `/`（除法）——此前整段被当正则吞掉，其后的真 import 漏检
    writeFileSync(
      join(root, 'src', 'core', 'div.ts'),
      "const x = {} / 2;\nimport { q } from 'zustand';\n",
    );
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, `三种真引用必须全部命中，实际：\n${r.stdout}`);
    const hit = (name: string): number => r.stderr.split('\n').filter((l) => l.includes(name)).length;
    assert.equal(hit('tpl.ts'), 1, '模板串插值 import 必须命中');
    assert.equal(hit('tpl-req.ts'), 1, '模板串插值 require 必须命中');
    assert.equal(hit('div.ts'), 1, '除法后的真 import 必须命中');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：合规 fixture 通过（features/data 层合规引用）', () => {
  const root = makeFixture();
  try {
    writeFixturePackageJson(root);
    mkdirSync(join(root, 'src', 'features'), { recursive: true });
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    writeFileSync(join(root, 'src', 'features', 'ok.ts'), "import { x } from '../core/store';\n");
    writeFileSync(join(root, 'src', 'data', 'ok.ts'), "import { invoke } from '@tauri-apps/api/core';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /通过/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:bans：五轮补漏——TS 宽松逃逸形态 / Rust 属性宏 / 根级配置文件', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'bad.ts'), `const m: Record<string, an${'y'}> = {}; @ts-${'nocheck'}\n`);
    writeFileSync(join(root, 'src', 'lib.rs'), `#![al${'low'}(dead_code)]\n#[ex${'pect'}(dead_code)]\n`);
    // 根级单文件此前从不被扫描（B4）
    writeFileSync(join(root, 'vite.config.ts'), `const x: an${'y'}[] = [];\n`);
    const r = runGate('bans.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /Record<string, an/, '宽松类型注解形态必须命中');
    assert.match(r.stderr, /nocheck/, 'TS 文件级检查抑制必须命中');
    assert.match(r.stderr, /crate 级/, 'Rust 内层属性宏必须命中');
    assert.match(r.stderr, /vite\.config\.ts/, '根级单文件必须被扫描');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：五轮补漏——data 反向依赖 / data 引 zustand / windows 包禁引', () => {
  const root = makeFixture();
  try {
    writeFixturePackageJson(root);
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    mkdirSync(join(root, 'src', 'windows'), { recursive: true });
    writeFileSync(join(root, 'src', 'data', 'up.ts'), "import { x } from '../features/store';\n");
    writeFileSync(join(root, 'src', 'data', 'z.ts'), "import { create } from 'zustand';\n");
    writeFileSync(join(root, 'src', 'windows', 'p.ts'), "import { y } from '#doc-model';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /data 禁引 src\/features/);
    assert.match(r.stderr, /zustand/);
    const winLines = r.stderr.split('\n').filter((l) => l.includes('windows/p.ts'));
    assert.equal(winLines.length, 1, 'windows 直引 packages 应恰好一条');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：六轮修复——未登记 # 别名必须 fail-closed（防新增包静默绕过）', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'features'), { recursive: true });
    writeFileSync(join(root, 'src', 'features', 'bypass.ts'), "import { x } from '#ai-format/foo';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, `未登记别名必须报违规，实际：\n${r.stdout}`);
    assert.match(r.stderr, /未登记/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：六轮修复——.mjs/.mts/.cts 也在扫描口径内', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'data'), { recursive: true });
    writeFileSync(join(root, 'src', 'data', 'probe.mts'), "import { x } from '../features/store';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, `非 .ts 扩展名也必须被扫描，实际：\n${r.stdout}`);
    assert.match(r.stderr, /data 禁引 src\/features/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:bans：六轮修复——crate 级内层 expect 属性也必须命中', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
    writeFileSync(join(root, 'src-tauri', 'src', 'lib.rs'), `#!${'[ex'}pect(dead_code)]\nfn f() {}\n`);
    const r = runGate('bans.mjs', root);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /expect/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('css-root-tokens：七轮修复——@layer 下探 / 组合选择器 / 字符串花括号', async () => {
  const { definedTokensInRootScope } = await import('../scripts/gates/css-root-tokens.mjs');
  const layer = definedTokensInRootScope('@layer tokens { :root { --in-layer: 1px; } }');
  assert.ok(layer.has('--in-layer'), '@layer 是透明容器，内部 :root 是全局定义');
  const combo = definedTokensInRootScope(':root, [data-theme=light] { --combo: 2px; }');
  assert.ok(!combo.has('--combo'), '组合选择器是条件定义，不得计入全局');
  const exact = definedTokensInRootScope(':root { --global-ok: 3px; }');
  assert.ok(exact.has('--global-ok'), '纯 :root 正常收集');
  const strBrace = definedTokensInRootScope(':root { --a: 1px; content: "}"; --b: 2px; }');
  assert.ok(strBrace.has('--a') && strBrace.has('--b'), `字符串中的花括号不得打断配对：${[...strBrace].join(', ')}`);
});

void test('gate:bans：七轮修复——.mts/.cts 也在禁用模式扫描口径内', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.mts'), `const x: an${'y'} = 1;\n`);
    writeFileSync(join(root, 'src', 'b.cts'), `const y: an${'y'} = 1;\n`);
    const r = runGate('bans.mjs', root);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /a\.mts/);
    assert.match(r.stderr, /b\.cts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('css-root-tokens：@media 内的条件 :root 定义不算全局（六轮修复回归）', async () => {
  const { definedTokensInRootScope } = await import('../scripts/gates/css-root-tokens.mjs');
  const css = [
    ':root { --a: 1px; }',
    '@media (prefers-reduced-transparency: reduce) { :root { --b: 2px; --c: 3px; } }',
    ':root { --d: var(--a); }',
  ].join('\n');
  const defined = definedTokensInRootScope(css);
  assert.ok(defined.has('--a') && defined.has('--d'), `顶层定义必须命中：${[...defined].join(", ")}`);
  assert.ok(!defined.has('--b') && !defined.has('--c'), `@media 内条件定义不得计入全局：${[...defined].join(", ")}`);
  assert.equal(defined.size, 2);
});

void test('css-root-tokens：八轮修复——块内字符串与嵌套规则不得充当 token 定义', async () => {
  const { definedTokensInRootScope } = await import('../scripts/gates/css-root-tokens.mjs');
  // 1. 字符串内容里的 token 形态（A1 复活路径：UI token 点名断言会被它假绿）
  const str = definedTokensInRootScope(':root { content: "--hitzone-min: 44px"; }');
  assert.ok(!str.has('--hitzone-min'), `字符串里的 token 形态不得算定义：${[...str].join(", ")}`);
  // 2. CSS Nesting 嵌套条件规则（与「组合选择器」同类问题）
  const nested = definedTokensInRootScope(':root { &[data-theme=light] { --nested: 1px; } }');
  assert.ok(!nested.has('--nested'), `嵌套条件规则不得算全局定义：${[...nested].join(", ")}`);
  // 3. url() 内字符串
  const url = definedTokensInRootScope(':root { --a: 1px; background: url("--fake: 1"); }');
  assert.ok(url.has('--a') && !url.has('--fake'), `url 字符串不得算定义：${[...url].join(", ")}`);
});

void test('css-root-tokens：九轮修复——无引号 url() 内容不得充当 token 定义', async () => {
  const { definedTokensInRootScope } = await import('../scripts/gates/css-root-tokens.mjs');
  const url = definedTokensInRootScope(':root { --a: 1px; background-image: url(--missing:scheme); }');
  assert.ok(url.has('--a'), `正常声明必须收集：${[...url].join(', ')}`);
  assert.ok(!url.has('--missing'), `无引号 url() 内容不得算定义：${[...url].join(', ')}`);
});

void test('gate:mutable-exports：export let/var/可变容器拦截，freeze/函数/纯常量放行', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'core'), { recursive: true });
    writeFileSync(join(root, 'src', 'core', 'bad.ts'), "export let counter = 0;\nexport const m = new Map();\nexport const arr = [];\n");
    writeFileSync(join(root, 'src', 'core', 'ok.ts'), "export const N = 1;\nexport const FROZEN = Object.freeze({ a: 1 });\nexport const fn = () => N;\nexport function helper(): number { return N; }\n");
    writeFileSync(join(root, 'src', 'core', 'parse.ts'), "export const = ;\n");
    const r = runGate('mutable-exports.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const lines = (name: string): number => r.stderr.split('\n').filter((l) => l.includes(name)).length;
    assert.equal(lines('bad.ts'), 3, 'let/Map/数组三处必须全报');
    assert.equal(lines('ok.ts'), 0, '冻结/函数/纯常量不得误报');
    assert.match(r.stderr, /解析失败/, '坏语法必须 fail-closed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：A1 补齐——canvas/windows/editor 引 zustand 必须命中（D12）', () => {
  const root = makeFixture();
  try {
    mkdirSync(join(root, 'src', 'canvas'), { recursive: true });
    mkdirSync(join(root, 'src', 'windows'), { recursive: true });
    writeFileSync(join(root, 'src', 'canvas', 'z.ts'), "import { create } from 'zustand';\n");
    writeFileSync(join(root, 'src', 'windows', 'z.ts'), "import { create } from 'zustand';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const lines = (name: string): number => r.stderr.split('\n').filter((l) => l.includes(name)).length;
    assert.equal(lines('canvas/z.ts'), 1);
    assert.equal(lines('windows/z.ts'), 1);
    assert.match(r.stderr, /D12/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('gate:layers：A3 补齐——@ember/* 包名直引形式与 #别名 同语义', () => {
  const root = makeFixture();
  try {
    writeFixturePackageJson(root);
    mkdirSync(join(root, 'src', 'features'), { recursive: true });
    writeFileSync(join(root, 'src', 'features', 'e.ts'), "import { x } from '@ember/doc-model';\n");
    const r = runGate('layers.mjs', root);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /越层直引 packages/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test('css-root-tokens：A4/A5 补齐——@supports/@container 条件块与 :root 伪类变体', async () => {
  const { definedTokensInRootScope } = await import('../scripts/gates/css-root-tokens.mjs');
  const supports = definedTokensInRootScope('@supports (backdrop-filter: blur(1px)) { :root { --cond: 1px; } } :root { --ok: 2px; }');
  assert.ok(supports.has('--ok') && !supports.has('--cond'), `@supports 条件定义不得计入全局：${[...supports].join(', ')}`);
  const container = definedTokensInRootScope('@container (width > 10px) { :root { --c: 1px; } }');
  assert.ok(!container.has('--c'), '@container 条件定义不得计入全局');
  const layer = definedTokensInRootScope('@layer tokens { :root { --l: 1px; } }');
  assert.ok(layer.has('--l'), '@layer 透明容器继续下探（七轮回归）');
  const pseudo = definedTokensInRootScope(':root:has(input) { --pseudo: 1px; }');
  assert.ok(!pseudo.has('--pseudo'), ':root 伪类变体按 fail-closed 处理（漏收由未定义测试兜底）');
});

void test('gate:cycles：干净 fixture 通过', () => {
  const r = runFixture(
    'cycles.mjs',
    { 'src/a.ts': "import './b.ts';\n", 'src/b.ts': 'export const b = 1;\n' },
    'cycles-allowlist.json',
    { ceiling: 0, cycles: [] },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

void test('gate:cycles：注入新环必红', () => {
  const r = runFixture(
    'cycles.mjs',
    { 'src/a.ts': "import './b.ts';\n", 'src/b.ts': "import './a.ts';\n" },
    'cycles-allowlist.json',
    { ceiling: 0, cycles: [] },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /新增环/);
});

void test('gate:cycles：白名单扩容必红（登记不存在的环）', () => {
  const r = runFixture(
    'cycles.mjs',
    { 'src/a.ts': "import './b.ts';\n", 'src/b.ts': "import './a.ts';\n" },
    'cycles-allowlist.json',
    { ceiling: 2, cycles: [['src/a.ts', 'src/b.ts'], ['src/x.ts', 'src/y.ts']] },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /白名单过期/);
});

void test('gate:ipc-chokepoint：干净 fixture 通过（src/data 不在口径内）', () => {
  const r = runFixture(
    'ipc-chokepoint.mjs',
    {
      'src/app/a.ts': "void ipcClient.invoke('vault_read');\n",
      'src/data/port.ts': "void ipcClient.invoke('vault_write');\n",
    },
    'ipc-allowlist.json',
    { ceiling: 1, sites: [{ file: 'src/app/a.ts', callee: 'invoke', command: 'vault_read', ordinal: 1 }] },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

void test('gate:ipc-chokepoint：白名单外调用必红（含跨行写法）', () => {
  const r = runFixture(
    'ipc-chokepoint.mjs',
    { 'src/app/m.ts': "void ipcClient\n  .invoke('vault_write');\n" },
    'ipc-allowlist.json',
    { ceiling: 0, sites: [] },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /vault_write/);
});

void test('gate:ipc-chokepoint：白名单扩容必红（登记不存在的调用点）', () => {
  const r = runFixture(
    'ipc-chokepoint.mjs',
    { 'src/app/a.ts': "void ipcClient.invoke('vault_read');\n" },
    'ipc-allowlist.json',
    {
      ceiling: 2,
      sites: [
        { file: 'src/app/a.ts', callee: 'invoke', command: 'vault_read', ordinal: 1 },
        { file: 'src/app/ghost.ts', callee: 'invoke', command: 'vault_read', ordinal: 1 },
      ],
    },
  );
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /白名单过期/);
});

void test('gate:ipc-chokepoint：AST 计数——注释/字符串里的字样不算，真实与跨行调用算', () => {
  const source = [
    "// 文档示例：ipcClient.invoke('vault_write') 不应计数",
    "/* ipcClient.chatStream('x') 也不应计数 */",
    "const s = \"ipcClient.invoke('vault_remove')\";",
    "void ipcClient.invoke('vault_read');",
    "void ipcClient\n  .invoke('vault_stat');",
    '',
  ].join('\n');
  const r = runFixture(
    'ipc-chokepoint.mjs',
    { 'src/app/a.ts': source },
    'ipc-allowlist.json',
    {
      ceiling: 2,
      sites: [
        { file: 'src/app/a.ts', callee: 'invoke', command: 'vault_read', ordinal: 1 },
        { file: 'src/app/a.ts', callee: 'invoke', command: 'vault_stat', ordinal: 1 },
      ],
    },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /调用点 2 处/);
});

void test('gate:ipc-chokepoint：AST 计数——注释里的字样不计入，白名单按真实调用数核对', () => {
  // 若把注释里的 ipcClient.invoke 误算成第 2 个 vault_read，ceiling/sites=1 会因「未登记」变红；
  // AST 口径下注释不算，仅 1 处真实调用，应通过。
  const r = runFixture(
    'ipc-chokepoint.mjs',
    { 'src/app/b.ts': "// ipcClient.invoke('vault_read')\nvoid ipcClient.invoke('vault_read');\n" },
    'ipc-allowlist.json',
    {
      ceiling: 1,
      sites: [{ file: 'src/app/b.ts', callee: 'invoke', command: 'vault_read', ordinal: 1 }],
    },
  );
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /调用点 1 处/);
});

// 夹具：按给定数量构造「命令实现文件 + lib.rs 注册表 + TS 命令映射」，不依赖真实仓库。
function runRegistryFixture(
  implemented: number,
  registered: number,
  mapped: readonly string[] = Array.from({ length: registered }, (_, i) => `c${i}`),
): SpawnSyncReturns<string> {
  const root = makeFixture();
  try {
    const src = join(root, 'src-tauri', 'src');
    mkdirSync(src, { recursive: true });
    const commands = Array.from(
      { length: implemented },
      (_, i) => `#[tauri::command]\npub fn c${i}() {}\n`,
    ).join('');
    writeFileSync(join(src, 'commands.rs'), commands);
    const entries = Array.from(
      { length: registered },
      (_, i) => `        crate::commands::c${i},`,
    ).join('\n');
    writeFileSync(
      join(src, 'lib.rs'),
      `pub fn run() {\n    tauri::Builder::default().invoke_handler(tauri::generate_handler![\n${entries}\n    ]);\n}\n`,
    );
    const data = join(root, 'src', 'data');
    mkdirSync(data, { recursive: true });
    const properties = mapped
      .map((name) => `  ${name}: { args: undefined; result: null };`)
      .join('\n');
    writeFileSync(
      join(data, 'ipc-client.ts'),
      `export interface IpcCommandMap {\n${properties}\n}\n`,
    );
    return runGate('command-registry.mjs', root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void test('gate:command-registry：漏注册（实现数 > 注册数）必红', () => {
  const r = runRegistryFixture(2, 1);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /命令实现 2 个/);
  assert.match(r.stderr, /注册 1 个/);
});

void test('gate:command-registry：多注册（注册数 > 实现数）必红', () => {
  const r = runRegistryFixture(1, 2);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /命令实现 1 个/);
  assert.match(r.stderr, /注册 2 个/);
});

void test('gate:command-registry：实现数与注册数一致时通过', () => {
  const r = runRegistryFixture(2, 2);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /通过/);
  assert.match(r.stdout, /名称一致/);
});

void test('gate:command-registry：数量相同但 TS 命令名错位必红', () => {
  const r = runRegistryFixture(2, 2, ['c0', 'ghost']);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  assert.match(r.stderr, /IpcCommandMap 缺少：c1/);
  assert.match(r.stderr, /IpcCommandMap 多余：ghost/);
});
