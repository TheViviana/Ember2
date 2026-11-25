/**
 * CR-R2-10：链接索引单源——ember-store 是唯一建立点。
 * 注入 fake reader 验证：全库每个文档只读一次、状态 idle→building→ready、读盘失败转 error。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { test } from 'node:test';

import { backlinksOf } from '../../../src/core/link-index.ts';
import type { DocMeta, VaultIndexSnapshot } from '../../../src/core/vault-index.ts';

// app 生产模块沿用 Vite 的无扩展名导入；仅为本测试进程补齐 Node 原生 .ts 解析。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      extname(specifier) === '' &&
      context.parentURL !== undefined &&
      existsSync(new URL(`${specifier}.ts`, context.parentURL))
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier);
  },
});

const { useEmberStore } = await import('../../../src/app/stores/ember-store.ts');

type LinkIndexStatus = ReturnType<typeof useEmberStore.getState>['linkIndexStatus'];
type Reader = (path: string) => Promise<{ readonly sha256: string; readonly text: string }>;

const DOCUMENTS: readonly { readonly path: string; readonly text: string }[] = [
  { path: 'a.md', text: '参看 [[b]]' },
  { path: 'b.md', text: '没有链接' },
];

/** 只替换索引与链接索引切片，其余状态保持 store 原样。 */
function seedIndex(): void {
  const docs = new Map<string, DocMeta>();
  for (const doc of DOCUMENTS) {
    docs.set(doc.path, {
      path: doc.path,
      bytes: doc.text.length,
      sha256: `${doc.path}-sha`,
      modifiedMs: 1,
    });
  }
  const index: VaultIndexSnapshot = Object.freeze({ docs });
  useEmberStore.setState({ index, linkIndex: null, linkIndexStatus: 'idle' });
}

function waitForStatus(target: LinkIndexStatus): Promise<void> {
  return new Promise<void>((resolve) => {
    if (useEmberStore.getState().linkIndexStatus === target) {
      resolve();
      return;
    }
    const unsubscribe = useEmberStore.subscribe((state) => {
      if (state.linkIndexStatus !== target) return;
      unsubscribe();
      resolve();
    });
  });
}

void test('ensureLinkIndex 注入 reader：全库只读一次，状态 idle→building→ready', { timeout: 5000 }, async () => {
  seedIndex();
  const calls: string[] = [];
  const reader: Reader = (path) => {
    calls.push(path);
    const doc = DOCUMENTS.find((entry) => entry.path === path);
    return doc === undefined
      ? Promise.reject(new Error(`未知路径：${path}`))
      : Promise.resolve({ sha256: `${path}-sha`, text: doc.text });
  };

  assert.equal(useEmberStore.getState().linkIndexStatus, 'idle');
  useEmberStore.getState().ensureLinkIndex(reader);
  assert.equal(useEmberStore.getState().linkIndexStatus, 'building');

  await waitForStatus('ready');
  assert.deepEqual(calls, ['a.md', 'b.md']);

  const state = useEmberStore.getState();
  assert.equal(state.linkIndex?.sourceCount, 2);
  const backlinks = state.linkIndex === null
    ? []
    : backlinksOf(state.linkIndex, 'b.md').map((entry) => entry.path);
  assert.deepEqual(backlinks, ['a.md']);

  // 已建立后再次触发是幂等的，不会重读全库。
  state.ensureLinkIndex(reader);
  assert.deepEqual(calls, ['a.md', 'b.md']);
});

void test('reader 抛错时状态转 error 且不保留索引', { timeout: 5000 }, async () => {
  seedIndex();
  const reader: Reader = (path) =>
    path === 'b.md'
      ? Promise.reject(new Error('读盘失败'))
      : Promise.resolve({ sha256: `${path}-sha`, text: '没有链接' });

  useEmberStore.getState().ensureLinkIndex(reader);
  assert.equal(useEmberStore.getState().linkIndexStatus, 'building');

  await waitForStatus('error');
  assert.equal(useEmberStore.getState().linkIndex, null);
});
