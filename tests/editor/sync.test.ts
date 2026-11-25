import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  conflictAction,
  shouldApplyExternal,
  shouldWriteBack,
  type EditorUpdateLike,
} from '../../src/editor/sync.ts';

function update(docChanged: boolean, external: boolean): EditorUpdateLike {
  return { docChanged, external };
}

void test('shouldWriteBack：仅正文变化且非外部事务时写回 Core', () => {
  assert.equal(shouldWriteBack(update(true, false)), true);
  assert.equal(shouldWriteBack(update(false, false)), false);
  assert.equal(shouldWriteBack(update(true, true)), false);
  assert.equal(shouldWriteBack(update(false, true)), false);
});

void test('shouldApplyExternal：文本相同不派发事务，文本不同才回写编辑器', () => {
  assert.equal(shouldApplyExternal('same', 'same'), false);
  assert.equal(shouldApplyExternal('old', 'new'), true);
  assert.equal(shouldApplyExternal('', 'x'), true);
});

void test('conflictAction：文件被删除时的 reload 转为接受删除，不再读盘', () => {
  assert.equal(conflictAction('removed', 'reload'), 'close');
  assert.equal(conflictAction('removed', 'overwrite'), 'overwrite');
});

void test('conflictAction：普通外部修改保持 reload / overwrite', () => {
  assert.equal(conflictAction('updated', 'reload'), 'reload');
  assert.equal(conflictAction('updated', 'overwrite'), 'overwrite');
});
