import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { definedTokensInRootScope } from '../scripts/gates/css-root-tokens.mjs';
import { DOC_MODEL_VERSION } from '../packages/doc-model/src/index.ts';
import { CANVAS_FORMAT_VERSION, CANVAS_SCHEMA_VERSION } from '../packages/canvas-format/src/index.ts';

void test('doc-model 桩可加载（node 直接跑 TS 验证编译链路）', () => {
  assert.equal(typeof DOC_MODEL_VERSION, 'string');
  assert.ok(DOC_MODEL_VERSION.length > 0);
});

void test('canvas-format schemaVersion 符合契约 v2（docs/canvas-format.md）', () => {
  assert.equal(typeof CANVAS_FORMAT_VERSION, 'string');
  assert.ok(CANVAS_FORMAT_VERSION.length > 0);
  assert.equal(CANVAS_SCHEMA_VERSION, 2, '画布 schema 契约是 v2（端口连线），不等于 2 即实现漂移');
});

function* walkCss(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    const st = statSync(p);
    if (st.isDirectory()) yield* walkCss(p);
    else if (name.endsWith('.css')) yield p;
  }
}

const STYLES_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const TOKENS_CSS = readFileSync(`${STYLES_DIR}styles/tokens.css`, 'utf8');
const CSS_FILES = [...walkCss(STYLES_DIR)].filter((f) => !f.endsWith('tokens.css'));

// ---- 语义化提取 :root 块内定义的 token（六轮修复：共享提取器排除 @media 条件块，
// 只在 prefers-reduced-transparency 等条件下生效的 token 不再被误判为全局已定义）----
const ROOT_TOKENS = definedTokensInRootScope(TOKENS_CSS);

// UI 交互规范 token（docs/ui-spec.md）——逐个点名，防再次"游离声明被丢掉却测不出来"
const UI_SPEC_TOKENS = [
  '--shadow-offset-x',
  '--shadow-offset-y',
  '--shadow-blur',
  '--shadow-color',
  '--hitzone-min',
] as const;

void test('UI 交互规范 token 必须真实定义在 :root 作用域内（五轮修复：整段游离声明曾静默失效）', () => {
  for (const token of UI_SPEC_TOKENS) {
    assert.ok(ROOT_TOKENS.has(token), `${token} 未在 :root 作用域定义（游离声明会被 CSS 引擎整段丢弃）`);
  }
});

void test('所有组件 CSS 引用的 token 必须定义在 :root 作用域', () => {
  assert.ok(CSS_FILES.length > 0, 'src 下应存在组件 CSS');
  for (const file of CSS_FILES) {
    const css = readFileSync(file, 'utf8');
    const used = [...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((m) => `--${m[1]}`);
    for (const token of used) {
      assert.ok(ROOT_TOKENS.has(token), `${file} 引用了未在 :root 定义的 token：${token}`);
    }
  }
});

void test('非 tokens.css 的组件 CSS 禁止裸色值（UI 规范第 4/5 条：描边与正文色必须走 token 随主题切换）', () => {
  for (const file of CSS_FILES) {
    const css = readFileSync(file, 'utf8');
    // 去掉注释后再查，注释里的示例值不算违规
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bare = [...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
    assert.deepEqual(bare, [], `${file} 存在裸色值：${bare.join(', ')}（必须改用 token）`);
  }
});

void test('非 tokens.css 的组件 CSS 禁止 blur() 裸数值（必须走 --ember-glass-blur/--ember-menu-blur，reduce-transparency 才能归零）', () => {
  for (const file of CSS_FILES) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const args = [...css.matchAll(/blur\(\s*([^)]+)\)/g)].map((m) => (m[1] ?? '').trim());
    const bare = args.filter((a) => !a.startsWith('var(') && a !== '0' && a !== '0px');
    assert.deepEqual(bare, [], `${file} 存在 blur() 裸数值：${bare.join(', ')}（必须改用 token）`);
  }
});
