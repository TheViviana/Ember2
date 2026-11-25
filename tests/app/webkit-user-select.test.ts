import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/**
 * CR-20261119-07 S2：应用运行于 WKWebView，`user-select` 必须带 `-webkit-` 前缀双写，
 * 否则标准属性在真机不生效（浏览器预览却能生效，属最容易漏掉的差异）。
 */
void test('global.css 的 body 禁选与文本例外均带 -webkit- 前缀', () => {
  const css = read('src/styles/global.css');
  assert.match(css, /-webkit-user-select:\s*none/);
  assert.match(css, /-webkit-user-select:\s*text/);
});

void test('编辑器与状态栏的 user-select 声明全部双写', () => {
  const files = [
    'src/editor/EditorView.module.css',
    'src/app/panels/StatusBar.module.css',
  ];
  for (const file of files) {
    const lines = read(file)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('user-select:'));
    assert.ok(lines.length > 0, `${file} 应保留 user-select 声明`);
    const css = read(file);
    const prefixed = css.match(/-webkit-user-select:/g) ?? [];
    assert.equal(prefixed.length, lines.length, `${file} 的前缀声明数量应与标准声明一致`);
  }
});
