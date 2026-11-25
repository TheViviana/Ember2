import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `缺少 ${selector} 规则`);
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

void test('子面板与父菜单本身不得成为 fixed 后代的包含块', () => {
  const panelCss = read('src/app/canvas/DocSubmenu.module.css');
  const menuCss = read('src/app/canvas/CanvasView.module.css');
  const listCss = read('src/app/panels/DocumentList.module.css');

  // Cinematic Ember §3.5：菜单改为单色哑光底，不再使用毛玻璃；
  // 同时保持「菜单本身不成为 fixed 后代的包含块」，避免三级菜单被父面板裁掉。
  for (const css of [panelCss, menuCss, listCss]) {
    assert.doesNotMatch(css, /backdrop-filter/);
    for (const selector of ['.panel', '.contextMenu']) {
      if (!css.includes(`${selector} {`)) continue;
      const body = rule(css, selector);
      assert.doesNotMatch(body, /backdrop-filter/);
      assert.doesNotMatch(body, /(^|[^-])filter:/);
      assert.doesNotMatch(body, /transform:/);
    }
  }
});

void test('展开的菜单项在指针进入子菜单后仍保持持续选中底', () => {
  const panelCss = read('src/app/canvas/DocSubmenu.module.css');
  assert.match(rule(panelCss, ".item[aria-expanded='true']"), /--ember-menu-active/);
});

void test('子面板保留独立滚动，长列表仍可在面板内滚动', () => {
  const panelCss = read('src/app/canvas/DocSubmenu.module.css');
  const body = rule(panelCss, '.panel');
  assert.match(body, /position: fixed;/);
  assert.match(body, /overflow-y: auto;/);
  assert.match(body, /z-index: 51;/);
});
