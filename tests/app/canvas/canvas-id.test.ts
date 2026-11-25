import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANVAS_ID_MAX_LENGTH,
  validateCanvasId,
} from '../../../src/app/canvas/canvas-id.ts';

type ValidationResult = ReturnType<typeof validateCanvasId>;

const CASES: readonly (readonly [string, ValidationResult])[] = [
  ['untitled', { ok: true }],
  ['untitled-2', { ok: true }],
  ['A_B-c', { ok: true }],
  ['con', { ok: false, reason: 'reserved' }],
  ['CON', { ok: false, reason: 'reserved' }],
  ['a'.repeat(64), { ok: true }],
  ['a'.repeat(65), { ok: false, reason: 'length' }],
  ['中文', { ok: false, reason: 'charset' }],
  ['a b', { ok: false, reason: 'charset' }],
  ['a.b', { ok: false, reason: 'charset' }],
];

void test('validateCanvasId：白名单、保留名与长度边界表驱动回归', () => {
  assert.equal(CANVAS_ID_MAX_LENGTH, 64);
  for (const [id, expected] of CASES) {
    assert.deepEqual(validateCanvasId(id), expected, JSON.stringify(id));
  }
});
