/**
 * CR-20261119-14：library-validate 纯函数测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateLibraryPath, sanitizeLibraryPath } from '../../../src/features/library/library-validate.ts';

function ok(s: string): void {
  const r = validateLibraryPath(s);
  assert.ok(r.ok, `"${s}" 应通过，实际：${JSON.stringify(r)}`);
}

function fail(s: string, needle: string): void {
  const r = validateLibraryPath(s);
  assert.ok(!r.ok, `"${s}" 应拒绝`);
  assert.ok(r.message?.includes(needle), `"${s}" 应含「${needle}」，实际：${r.message}`);
}

void describe('validateLibraryPath', () => {
  void it('ASCII 绝对路径通过', () => {
    ok('/Users/zero/Documents/MyVault');
    ok('/tmp/test-vault');
    ok('/');
    ok('/a/b/c');
  });

  void it('含空格的路径通过', () => {
    ok('/Users/zero/Documents/My Vault');
    ok('/tmp/a long path here');
  });

  void it('中文路径通过（Unicode 放行）', () => {
    ok('/Users/xxx/文档/知识库');
    ok('/home/用户/我的库');
    ok('/tmp/日本語ライブラリ');
  });

  void it('特殊 Unicode 符号通过', () => {
    ok('/path/with#hash');
    ok('/path/with(parens)');
    ok('/path/with[brackets]');
    ok('/path/with@sign');
    ok('/path/with+plus');
  });

  void it('相对路径拒绝', () => {
    fail('MyVault', '绝对路径');
    fail('./test', '绝对路径');
    fail('../a', '绝对路径');
  });

  void it('~ 前缀拒绝（前端不做 tilde 展开）', () => {
    fail('~/vault', '不支持 ~');
  });

  void it('空字符串拒绝', () => {
    fail('', '请输入库路径');
    fail('   ', '请输入库路径');
  });

  void it('.. 嵌套段拒绝（含中文+.. 混合）', () => {
    fail('/tmp/../etc', '..');
    fail('/tmp/a/..', '..');
    fail('/..', '..');
    fail('/tmp/../中文目录', '..');
  });

  void it('\\0 拒绝', () => {
    fail('/tmp/x\0y', '非法字符');
  });

  void it('控制字符拒绝（制表符/回车）', () => {
    fail('/tmp/x\ty', '控制字符');
    fail('/tmp/x\ny', '控制字符');
    fail('/tmp/x\ry', '控制字符');
  });

  void it('连续斜杠拒绝', () => {
    fail('/tmp//a', '连续斜杠');
    fail('///tmp/a', '连续斜杠');
  });

  void it('反斜杠（Windows 风格）拒绝', () => {
    fail('C:\\Users\\Vault', '绝对路径');
  });

  void it('前后空白被 trim 后再校验', () => {
    ok('  /tmp/ok  ');
    fail('   relative  ', '绝对路径');
  });
});

void describe('sanitizeLibraryPath', () => {
  void it('trim 前后空白', () => {
    assert.equal(sanitizeLibraryPath('  /tmp/a  '), '/tmp/a');
  });
});
