/**
 * C0-C：打开分类、valid:false 文案与新建 open→save 顺序。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyCanvasOpen,
  canvasEntryReasonLabel,
  createCanvasSession,
  EMPTY_CANVAS_TEXT,
  EXPECTED_MISSING_SHA,
  type CanvasCreateStore,
} from '../../../src/app/canvas/canvas-open.ts';
import { createEmptyCanvasDocument } from '../../../src/app/canvas/format.ts';
import type { CanvasOpenResult } from '../../../src/core/canvas/ports.ts';

function opened(text: string | null, exists = true): CanvasOpenResult {
  return { exists, text, sha256: 'sha', modifiedMs: 1 };
}

void test('valid:false 四类 reason 映射为固定文案', () => {
  assert.equal(canvasEntryReasonLabel('bad_id'), '画布 id 不合法');
  assert.equal(canvasEntryReasonLabel('symlink'), '画布文件是符号链接');
  assert.equal(canvasEntryReasonLabel('not_regular_file'), '画布路径不是普通文件');
  assert.equal(canvasEntryReasonLabel('io_error'), '读取画布信息失败');
  assert.equal(canvasEntryReasonLabel(undefined), '读取画布信息失败');
});

void test('打开三分支：missing / 合法无 issues / 合法含 issues（只读）', () => {
  assert.deepEqual(classifyCanvasOpen(opened(null, false)), { kind: 'missing' });

  const ready = classifyCanvasOpen(opened(EMPTY_CANVAS_TEXT));
  assert.equal(ready.kind, 'ready');
  if (ready.kind !== 'ready') return;
  assert.deepEqual(ready.issues, []);
  assert.equal(ready.readOnly, false);
  assert.deepEqual(ready.document.nodes, []);

  const withIssues = classifyCanvasOpen(
    opened(JSON.stringify({ schemaVersion: 3, nodes: [{ id: 'a' }], edges: [] }, null, 2)),
  );
  assert.equal(withIssues.kind, 'ready');
  if (withIssues.kind !== 'ready') return;
  assert.ok(withIssues.issues.length > 0);
  assert.equal(withIssues.readOnly, true);
});

void test('v1 与非法信封是致命错误，不静默升级', () => {
  const v1 = classifyCanvasOpen(opened(JSON.stringify({ schemaVersion: 1 })));
  assert.equal(v1.kind, 'fatal');
  if (v1.kind !== 'fatal') return;
  assert.equal(v1.code, 'E_UNSUPPORTED_VERSION');

  const broken = classifyCanvasOpen(opened('{not json'));
  assert.equal(broken.kind, 'fatal');
  if (broken.kind !== 'fatal') return;
  assert.equal(broken.code, 'E_FORMAT');
});

function fakeStore(result: CanvasOpenResult): {
  store: CanvasCreateStore;
  calls: string[];
  saved: { id: string; text: string }[];
} {
  const calls: string[] = [];
  const saved: { id: string; text: string }[] = [];
  return {
    calls,
    saved,
    store: {
      open: (id) => {
        calls.push(`open:${id}`);
        return Promise.resolve(result);
      },
      save: (id, text) => {
        calls.push(`save:${id}`);
        saved.push({ id, text });
        return Promise.resolve({ id, sha256: 'new', modifiedMs: 2 });
      },
    },
  };
}

void test('已存在：open 后直接返回 exists，不 save', async () => {
  const fake = fakeStore(opened(EMPTY_CANVAS_TEXT));
  const result = await createCanvasSession(' board ', fake.store);
  assert.deepEqual(result, { kind: 'exists' });
  assert.deepEqual(fake.calls, ['open:board']);
  assert.deepEqual(fake.saved, []);
});

void test('不存在：open 后 save 空文档，且写入文本是合法 v2', async () => {
  const fake = fakeStore(opened(null, false));
  const result = await createCanvasSession('board', fake.store);
  assert.deepEqual(result, { kind: 'created' });
  assert.deepEqual(fake.calls, ['open:board', 'save:board']);
  assert.equal(fake.saved[0]?.text, EMPTY_CANVAS_TEXT);
  assert.equal(EXPECTED_MISSING_SHA, '');
  assert.deepEqual(JSON.parse(EMPTY_CANVAS_TEXT), createEmptyCanvasDocument());
});

void test('并发创建 E_CONFLICT：返回 exists，不改名重试', async () => {
  const calls: string[] = [];
  let saves = 0;
  const store: CanvasCreateStore = {
    open: (id) => {
      calls.push(`open:${id}`);
      return Promise.resolve(opened(null, false));
    },
    save: (id) => {
      saves += 1;
      calls.push(`save:${id}`);
      return Promise.reject(Object.assign(new Error('conflict'), { code: 'E_CONFLICT' }));
    },
  };

  const result = await createCanvasSession('board', store);
  assert.deepEqual(result, { kind: 'exists' });
  assert.deepEqual(calls, ['open:board', 'save:board']);
  assert.equal(saves, 1);
});

void test('非法 id 与未知失败都显式返回 failed', async () => {
  const fake = fakeStore(opened(null, false));
  assert.deepEqual(await createCanvasSession('   ', fake.store), {
    kind: 'failed',
    code: 'bad_id',
    message: '画布 id 不合法',
  });
  assert.deepEqual(fake.calls, []);

  const failing: CanvasCreateStore = {
    open: () => Promise.reject(Object.assign(new Error('disk denied'), { code: 'E_IO' })),
    save: () => Promise.resolve({ id: 'x', sha256: 's', modifiedMs: 1 }),
  };
  assert.deepEqual(await createCanvasSession('x', failing), {
    kind: 'failed',
    code: 'E_IO',
    message: 'disk denied',
  });
});
