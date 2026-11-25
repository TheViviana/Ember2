/**
 * 2026-11-25：设置页改为右侧栏（参考稿的行式清单），并要求修改即保存。
 * 这里锁定结构性契约，避免又回到居中浮窗或丢失首页入口。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const css = readFileSync(join(ROOT, 'src/app/shell/SettingsShell.module.css'), 'utf8');
const shell = readFileSync(join(ROOT, 'src/app/shell/SettingsShell.tsx'), 'utf8');
const host = readFileSync(join(ROOT, 'src/app/shell/SettingsShellHost.tsx'), 'utf8');
const appShell = readFileSync(join(ROOT, 'src/app/shell/AppShell.tsx'), 'utf8');

void test('设置壳贴右全高，左圆角 + 左边框，不再居中', () => {
  const hostRule = css.match(/\.host\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(hostRule, /justify-content:\s*flex-end/, '侧栏应贴右');
  assert.match(hostRule, /position:\s*absolute/, '以 .shell 为包含块，落在窗口内边线内侧');
  assert.doesNotMatch(hostRule, /position:\s*fixed/, 'fixed 会盖住窗口外环与四角');
  const windowRule = css.match(/\.window\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(windowRule, /height:\s*100%/, '侧栏占满窗口高度');
  assert.match(windowRule, /width:\s*min\(440px,\s*calc\(100% - 24px\)\)/, '侧栏极窄窗时让出画布');
  assert.match(windowRule, /border-radius:\s*18px 0 0 18px/, '只保留左侧圆角');
  assert.doesNotMatch(windowRule, /margin:\s*auto/, '不得再居中');
});

void test('首页为分区清单，详情页栏内切换且保留关闭', () => {
  assert.match(shell, /export const SETTINGS_HOME_ID = 'home'/);
  assert.match(shell, /className=\{styles\.groupLabel\}/, '分区标签');
  assert.match(shell, /className=\{styles\.rowDescription\}/, '行内说明文字');
  assert.match(shell, /aria-label="返回设置列表"/, '详情页可返回清单');
  assert.match(shell, /aria-label="关闭设置"/);
  assert.match(shell, /修改即保存，下次启动自动恢复/);
});

void test('入口默认进清单，返回首页不会被过滤掉', () => {
  assert.match(host, /id === SETTINGS_HOME_ID/);
  assert.match(appShell, /useState\('home'\)/);
  assert.match(appShell, /openSettingsAt\('home'\)/);
});
