/**
 * CR-20261119-02 P1-4：编辑器 drop capture 的载荷协调边界。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coordinateEditorDrop,
  EDITOR_DND_FALLBACK_MIME,
  EDITOR_DND_MIME,
  planEditorDrop,
  planEditorInboxDrop,
  readEditorInboxDropDetail,
  serializeTextPayload,
} from '../../src/editor/drop.ts';

function reader(custom: string, plain = ''): (format: string) => string {
  return (format: string): string => {
    if (format === EDITOR_DND_MIME) return custom;
    if (format === EDITOR_DND_FALLBACK_MIME) return plain;
    return '';
  };
}

void test('doc 自定义载荷被拦截并拒绝，不产生正文插入计划', () => {
  const coordination = coordinateEditorDrop(
    reader(JSON.stringify({ kind: 'doc', path: 'notes/a.md' }), 'notes/a.md'),
  );
  assert.equal(coordination.kind, 'intercept');
  if (coordination.kind !== 'intercept') return;
  assert.deepEqual(coordination.read, {
    ok: false,
    reason: '此处仅支持媒体插入',
    tone: 'warning',
  });
  const outcome = planEditorDrop(false, coordination.read);
  assert.equal(outcome.ok, false);
});

void test('无自定义 MIME 的纯文本交 CodeMirror 原生处理，不拦截不提示', () => {
  assert.deepEqual(coordinateEditorDrop(reader('', '普通选区文本')), { kind: 'native' });
});

void test('编辑器自身 text 自定义载荷同样交原生处理', () => {
  assert.deepEqual(
    coordinateEditorDrop(reader(serializeTextPayload('普通选区文本'), '普通选区文本')),
    { kind: 'native' },
  );
});

void test('media 自定义载荷被拦截并生成媒体插入计划', () => {
  const coordination = coordinateEditorDrop(
    reader(JSON.stringify({ kind: 'media', path: 'media/image/abc.png' })),
  );
  assert.equal(coordination.kind, 'intercept');
  if (coordination.kind !== 'intercept') return;
  const outcome = planEditorDrop(false, coordination.read);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.plan.insert, '![abc.png](media/image/abc.png)');
});

void test('收集箱事件结构拒绝非法坐标与空文件列表', () => {
  assert.equal(readEditorInboxDropDetail({
    payload: { kind: 'files', paths: [] },
    clientX: 1,
    clientY: 2,
  }), null);
  assert.deepEqual(readEditorInboxDropDetail({
    payload: { kind: 'text', text: '文本' },
    clientX: 1,
    clientY: 2,
  }), {
    payload: { kind: 'text', text: '文本' },
    clientX: 1,
    clientY: 2,
  });
});

void test('收集箱文本与库内文件生成安全 Markdown 引用', async () => {
  const text = await planEditorInboxDrop(
    false,
    { kind: 'text', text: '[链接](https://example.com)' },
    () => Promise.resolve(null),
  );
  assert.equal(text.ok, true);
  if (text.ok) assert.equal(text.plan.insert, '[链接](https://example.com)');

  const files = await planEditorInboxDrop(
    false,
    { kind: 'files', paths: ['/vault/notes/a.md', '/vault/media/image/p.png'] },
    (path) => Promise.resolve(path.endsWith('.md')
      ? { kind: 'doc', path: 'notes/a.md' } as const
      : { kind: 'media', path: 'media/image/p.png' } as const),
  );
  assert.equal(files.ok, true);
  if (files.ok) {
    assert.equal(files.plan.insert, '[a.md](notes/a.md)\n![p.png](media/image/p.png)');
    assert.equal(files.plan.insert.includes('file://'), false);
  }
});

void test('缺失或外部文件保留可见错误且不产生插入计划', async () => {
  const outcome = await planEditorInboxDrop(
    false,
    { kind: 'files', paths: ['/outside/secret.txt'] },
    () => Promise.resolve(null),
  );
  assert.deepEqual(outcome, {
    ok: false,
    message: '源文件缺失或不在当前知识库：secret.txt',
    tone: 'warning',
  });
});

void test('源文件校验异常与只读状态均明确失败', async () => {
  const failure = await planEditorInboxDrop(
    false,
    { kind: 'files', paths: ['/vault/media/image/p.png'] },
    () => Promise.reject(new Error('denied')),
  );
  assert.equal(failure.ok, false);
  if (!failure.ok) assert.match(failure.message, /denied/);
  const readonly = await planEditorInboxDrop(
    true,
    { kind: 'text', text: '文本' },
    () => Promise.resolve(null),
  );
  assert.equal(readonly.ok, false);
});
