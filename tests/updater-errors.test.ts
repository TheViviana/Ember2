import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeUpdateError } from '../src/features/updater/model.ts';

void test('平台条目缺失时翻译为手动下载提示', () => {
  const cause = new Error(
    'None of the fallback platforms ["darwin-aarch64-app","darwin-aarch64"] ' +
      'were found in the response `platforms` object',
  );
  assert.equal(describeUpdateError(cause), '当前平台暂无更新包，请前往 GitHub Releases 手动下载。');
});

void test('TargetNotFound 也走友好提示', () => {
  assert.equal(
    describeUpdateError('TargetNotFound'),
    '当前平台暂无更新包，请前往 GitHub Releases 手动下载。',
  );
});

void test('其它 Error 保留原始消息', () => {
  assert.equal(describeUpdateError(new Error('network down')), 'network down');
});

void test('非 Error 且非字符串时使用 fallback', () => {
  assert.equal(describeUpdateError(42), '未知更新错误');
  assert.equal(describeUpdateError(null, '检查失败'), '检查失败');
});