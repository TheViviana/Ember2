/**
 * P5-C2：窗口内容注册表测试（注册 / 取数 / 兜底契约）。
 * 注册表位于 use-window-manager.ts（引 react 的绑定模块），node 24 原生剥离类型可直接导入。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import {
  EDITOR_WINDOW_CONTENT,
  MEDIA_LIBRARY_WINDOW_CONTENT,
} from '../../src/windows/content-types.ts';
import {
  getWindowContent,
  registerWindowContent,
  type WindowContentProps,
} from '../../src/windows/use-window-manager.ts';

// 仅为本测试进程替换 TSX 组件，避免加载 JSX/CSS；注册入口本身仍执行真实实现。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './panels/EditorWindow.tsx') {
      return { url: 'data:text/javascript,export function EditorWindow(){}', shortCircuit: true };
    }
    if (specifier === './panels/MediaLibraryWindow.tsx') {
      return { url: 'data:text/javascript,export function MediaLibraryWindow(){}', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { registerBuiltInWindowContent } = await import('../../src/app/window-content.ts');

const NoopRenderer = (_props: WindowContentProps): null => null;
const FirstRenderer = (_props: WindowContentProps): null => null;
const SecondRenderer = (_props: WindowContentProps): null => null;

void test('内容注册表：注册后可取数，未注册返回 undefined（兜底契约）', () => {
  registerWindowContent('editor', NoopRenderer);
  assert.equal(getWindowContent('editor'), NoopRenderer);
  assert.equal(
    getWindowContent('unknown'),
    undefined,
    '未注册类型返回 undefined，WindowLayer 据此渲染兜底提示',
  );
});

void test('内容注册表：重复注册覆盖，不抛错', () => {
  registerWindowContent('canvas', FirstRenderer);
  assert.equal(getWindowContent('canvas'), FirstRenderer);
  registerWindowContent('canvas', SecondRenderer);
  assert.equal(getWindowContent('canvas'), SecondRenderer);
});

void test('CR-R6-3：内置内容显式注册，重复调用幂等', () => {
  registerBuiltInWindowContent();
  assert.notEqual(getWindowContent(EDITOR_WINDOW_CONTENT), undefined);
  assert.notEqual(getWindowContent(MEDIA_LIBRARY_WINDOW_CONTENT), undefined);
  assert.doesNotThrow(() => registerBuiltInWindowContent());
});

void test('CR-R6-3：AppShell 不含 panels 副作用导入', () => {
  const source = readFileSync(
    new URL('../../src/app/shell/AppShell.tsx', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes("import '../panels/"), false);
});
