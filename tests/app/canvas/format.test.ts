/**
 * 格式层：信封解析/序列化、schemaVersion v2 校验、错误码与未知键保留。
 *
 * CR-20261117-02 §1：v1 文件只报 E_UNSUPPORTED_VERSION，不静默升级或改写。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CanvasFormatError,
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
} from '../../../src/app/canvas/format.ts';
import { extractNodes } from '../../../src/app/canvas/node-layout.ts';
import { CANVAS_SCHEMA_VERSION } from '#canvas-format';

function expectFormatError(code: 'E_FORMAT' | 'E_UNSUPPORTED_VERSION', text: string): void {
  assert.throws(
    () => parseCanvasDocument(text),
    (error: unknown) => error instanceof CanvasFormatError && error.code === code,
  );
}

void test('空文档：schemaVersion 3、nodes/edges 均为空数组', () => {
  const document = createEmptyCanvasDocument();

  assert.equal(document.schemaVersion, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(document.nodes, []);
  assert.deepEqual(document.edges, []);
  assert.notEqual(createEmptyCanvasDocument().nodes, document.nodes, '每次调用应返回新数组');
});

void test('序列化：2 空格缩进 + 末尾换行', () => {
  const text = serializeCanvasDocument(createEmptyCanvasDocument());

  assert.equal(text, '{\n  "schemaVersion": 3,\n  "nodes": [],\n  "edges": []\n}\n');
});

void test('往返：解析后序列化字节稳定', () => {
  const text = serializeCanvasDocument(createEmptyCanvasDocument());

  assert.equal(serializeCanvasDocument(parseCanvasDocument(text)), text);
});

void test('v2 文件正常解析：nodes/edges 内容与 lastOrigin 保留', () => {
  const parsed = parseCanvasDocument(
    '{"schemaVersion":2,"lastOrigin":{"x":24,"y":-48},"nodes":[{"id":"a","x":120}],"edges":[]}',
  );

  assert.equal(parsed.schemaVersion, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(parsed.nodes, [{ id: 'a', x: 120 }]);
  assert.deepEqual(parsed.lastOrigin, { x: 24, y: -48 });
});

void test('未知顶层键原样保留，不因降级丢字段', () => {
  const parsed = parseCanvasDocument(
    '{"schemaVersion":2,"nodes":[],"edges":[],"viewport":{"x":1},"meta":{"title":"草稿"}}',
  );

  assert.deepEqual(parsed.viewport, { x: 1 });
  assert.deepEqual(parsed.meta, { title: '草稿' });
  assert.ok(serializeCanvasDocument(parsed).includes('"viewport"'));
});

void test('空文件与非法 JSON：E_FORMAT', () => {
  expectFormatError('E_FORMAT', '');
  expectFormatError('E_FORMAT', '   \n');
  expectFormatError('E_FORMAT', '{');
});

void test('顶层非对象：E_FORMAT', () => {
  expectFormatError('E_FORMAT', '[]');
  expectFormatError('E_FORMAT', 'null');
  expectFormatError('E_FORMAT', '42');
});

void test('非 v3 版本（且非 v2）：E_UNSUPPORTED_VERSION', () => {
  expectFormatError('E_UNSUPPORTED_VERSION', '{"schemaVersion":1,"nodes":[],"edges":[]}');
  expectFormatError('E_UNSUPPORTED_VERSION', '{"schemaVersion":4,"nodes":[],"edges":[]}');
  expectFormatError('E_UNSUPPORTED_VERSION', '{"nodes":[],"edges":[]}');
});

void test('v2 画布读入后内存归一为 v3，字段原样保留', () => {
  const parsed = parseCanvasDocument(
    '{"schemaVersion":2,"nodes":[{"id":"a","x":1,"y":2}],"edges":[]}',
  );

  assert.equal(parsed.schemaVersion, CANVAS_SCHEMA_VERSION);
  assert.deepEqual(parsed.nodes, [{ id: 'a', x: 1, y: 2 }]);
});

void test('v1 文件只报错，不静默升级或改写', () => {
  const v1 = '{"version":1,"nodes":[],"edges":[]}';

  expectFormatError('E_UNSUPPORTED_VERSION', v1);
  assert.equal(v1, '{"version":1,"nodes":[],"edges":[]}', '输入字节不能被原地改写');
});

void test('nodes/edges 不是数组：E_FORMAT', () => {
  expectFormatError('E_FORMAT', '{"schemaVersion":2,"edges":[]}');
  expectFormatError('E_FORMAT', '{"schemaVersion":2,"nodes":{},"edges":[]}');
  expectFormatError('E_FORMAT', '{"schemaVersion":2,"nodes":[]}');
  expectFormatError('E_FORMAT', '{"schemaVersion":2,"nodes":[],"edges":{}}');
});

void test('含坏节点的文件：extractNodes 只用于渲染，序列化全量保留不丢数据', () => {
  const text =
    '{"schemaVersion":2,"nodes":[{"id":"a","x":1,"y":2},{"id":"bad","x":"1","y":2},{"id":"","x":0,"y":0},42],"edges":[]}';
  const document = parseCanvasDocument(text);

  assert.deepEqual(extractNodes(document).map((node) => node.id), ['a'], '渲染视图只取合法节点');

  const saved = serializeCanvasDocument(document);
  const reparsed = parseCanvasDocument(saved);
  assert.deepEqual(
    reparsed.nodes,
    [{ id: 'a', x: 1, y: 2 }, { id: 'bad', x: '1', y: 2 }, { id: '', x: 0, y: 0 }, 42],
    '坏节点与非法值原样保留，不静默丢弃',
  );
  assert.equal(serializeCanvasDocument(reparsed), saved, '第二次保存字节稳定');
});
