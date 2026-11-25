/**
 * 世界层挂载点纯模块单测（Backlog ⑫ gate）。
 *
 * 只验证转发契约：非 null、同一元素、稳定、单次调用。
 * 「viewport 内唯一挂载点」需要真实 DOM 父子关系，归 C2 浏览器测试。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveWorldElement } from '../../../src/app/canvas/engine-mount.ts';

function fakeElement(): HTMLElement {
  return { nodeType: 1, tagName: 'DIV' } as unknown as HTMLElement;
}

void test('返回来源的挂载点，且非 null', () => {
  const element = fakeElement();
  const resolved = resolveWorldElement({ getWorldElement: () => element });

  assert.equal(resolved, element);
  assert.notEqual(resolved, null);
});

void test('多次解析返回同一元素（挂载点稳定）', () => {
  const element = fakeElement();
  const source = { getWorldElement: () => element };

  assert.equal(resolveWorldElement(source), resolveWorldElement(source));
});

void test('每次解析只调用一次 getWorldElement，不做额外探测', () => {
  let calls = 0;
  const element = fakeElement();
  const source = {
    getWorldElement(): HTMLElement {
      calls += 1;
      return element;
    },
  };

  resolveWorldElement(source);

  assert.equal(calls, 1);
});
