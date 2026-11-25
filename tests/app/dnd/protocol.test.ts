import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DND_FALLBACK_MIME,
  DND_MIME,
  parsePayload,
  readPayload,
  serializePayload,
} from '../../../src/app/dnd/protocol.ts';
import type { DndDataSource, DndPayload } from '../../../src/app/dnd/protocol.ts';

function sourceOf(data: Readonly<Record<string, string>>): DndDataSource {
  return {
    getData(format: string): string {
      return data[format] ?? '';
    },
  };
}

void test('五类 payload 序列化后可原样反序列化', () => {
  const cases: readonly DndPayload[] = [
    { kind: 'doc', path: 'notes/a.md' },
    { kind: 'media', path: 'media/x.png' },
    { kind: 'canvas-node', nodeId: 'n1', canvasId: 'c1' },
    { kind: 'text', text: 'hello' },
    { kind: 'files', paths: ['a.md', 'b.png'] },
  ];
  for (const payload of cases) {
    const result = parsePayload(serializePayload(payload));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.payload, payload);
  }
});

void test('text 允许空字符串', () => {
  const result = parsePayload(serializePayload({ kind: 'text', text: '' }));
  assert.equal(result.ok, true);
});

void test('空串与非法 JSON 显式拒绝', () => {
  const empty = parsePayload('');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /为空/);

  const broken = parsePayload('{');
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.reason, /不是合法 JSON/);
});

void test('非对象载荷显式拒绝', () => {
  for (const raw of ['null', '[]', '"abc"', '42']) {
    const result = parsePayload(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /不是对象/);
  }
});

void test('缺少 kind 与未知 kind 显式拒绝', () => {
  const missing = parsePayload('{}');
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.reason, /缺少 kind/);

  const wrongType = parsePayload('{"kind":123}');
  assert.equal(wrongType.ok, false);
  if (!wrongType.ok) assert.match(wrongType.reason, /缺少 kind/);

  const unknown = parsePayload('{"kind":"bogus"}');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.reason, /未知的 payload 类型：bogus/);
});

void test('doc / media 缺字段与字段类型错误显式拒绝', () => {
  const cases = [
    ['{"kind":"doc"}', /doc\.path/],
    ['{"kind":"doc","path":123}', /doc\.path/],
    ['{"kind":"doc","path":""}', /doc\.path/],
    ['{"kind":"media"}', /media\.path/],
    ['{"kind":"media","path":null}', /media\.path/],
  ] as const;
  for (const [raw, pattern] of cases) {
    const result = parsePayload(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, pattern);
  }
});

void test('canvas-node 缺字段与字段类型错误显式拒绝', () => {
  const cases = [
    ['{"kind":"canvas-node"}', /nodeId/],
    ['{"kind":"canvas-node","nodeId":"n1"}', /canvasId/],
    ['{"kind":"canvas-node","nodeId":"n1","canvasId":1}', /canvasId/],
  ] as const;
  for (const [raw, pattern] of cases) {
    const result = parsePayload(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, pattern);
  }
});

void test('text 字段类型错误显式拒绝', () => {
  const result = parsePayload('{"kind":"text","text":1}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /text\.text/);
});

void test('files 非数组、空数组、含非法项显式拒绝', () => {
  const cases = [
    ['{"kind":"files","paths":"a.md"}', /不是数组/],
    ['{"kind":"files","paths":[]}', /空数组/],
    ['{"kind":"files","paths":["a.md",2]}', /非字符串/],
    ['{"kind":"files","paths":[""]}', /非字符串/],
  ] as const;
  for (const [raw, pattern] of cases) {
    const result = parsePayload(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, pattern);
  }
});

void test('readPayload 优先使用自定义 MIME', () => {
  const result = readPayload(
    sourceOf({
      [DND_MIME]: serializePayload({ kind: 'doc', path: 'a.md' }),
      [DND_FALLBACK_MIME]: 'ignored',
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.payload, { kind: 'doc', path: 'a.md' });
});

void test('readPayload 无自定义 MIME 时解析纯文本 JSON', () => {
  const result = readPayload(
    sourceOf({ [DND_FALLBACK_MIME]: serializePayload({ kind: 'media', path: 'm.png' }) }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.payload, { kind: 'media', path: 'm.png' });
});

void test('readPayload 普通纯文本降级为 text 载荷', () => {
  const result = readPayload(sourceOf({ [DND_FALLBACK_MIME]: '一段被拖选的文字' }));
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.payload, { kind: 'text', text: '一段被拖选的文字' });
});

void test('readPayload 形如 JSON 但校验失败时保留原因，不降级为 text', () => {
  const result = readPayload(sourceOf({ [DND_FALLBACK_MIME]: '{"kind":"bogus"}' }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /未知的 payload 类型/);
});

void test('readPayload 两种 MIME 皆空时显式拒绝', () => {
  const result = readPayload(sourceOf({}));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /拖拽数据为空/);
});
