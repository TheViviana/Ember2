/**
 * CR-20261119-08：resolveNewDocDir + validateNewDocPath 纯函数测试。
 * 零 DOM / 零 core 依赖，可直接在 node --test 链执行。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  resolveNewDocDir,
  validateNewDocPath,
  type ValidateNewDocReason,
} from '../../../src/app/panels/doc-new.ts';

// ------------------------------------------------------------------ resolveNewDocDir

void test('resolveNewDocDir：blank → 空字符串（库根）', () => {
  assert.equal(resolveNewDocDir('blank'), '');
  assert.equal(resolveNewDocDir('blank', 'unused.md'), '');
});

void test('resolveNewDocDir：file → 父目录；多层嵌套取最后一个 slash 前', () => {
  assert.equal(resolveNewDocDir('file', 'a.md'), '');
  assert.equal(resolveNewDocDir('file', 'sub/a.md'), 'sub');
  assert.equal(resolveNewDocDir('file', 'sub/deep/a.md'), 'sub/deep');
});

void test('resolveNewDocDir：dir → 该目录本身', () => {
  assert.equal(resolveNewDocDir('dir', 'sub'), 'sub');
  assert.equal(resolveNewDocDir('dir', 'sub/deep'), 'sub/deep');
});

// ------------------------------------------------------------------ validateNewDocPath 成功路径

void test('validateNewDocPath：常规文件名 + 空 targetDir → ok', () => {
  const r = validateNewDocPath('hello', '');
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r, { ok: true, rel: 'hello.md', targetDir: '', baseInput: 'hello' });
});

void test('validateNewDocPath：缺扩展名自动补 .md', () => {
  const r = validateNewDocPath('note', '');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.rel, 'note.md');
});

void test('validateNewDocPath：大小写不敏感 → .MD 也合法', () => {
  assert.ok(validateNewDocPath('NOTE.MD', '').ok);
  assert.ok(validateNewDocPath('note.Md', '').ok);
  assert.ok(validateNewDocPath('note.md', '').ok);
});

void test('validateNewDocPath：目标目录拼接', () => {
  const r = validateNewDocPath('hello', 'sub/deep');
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.rel, 'sub/deep/hello.md');
});

// ------------------------------------------------------------------ validateNewDocPath 拒绝清单

void test('validateNewDocPath：空路径 → PATH_EMPTY', () => {
  for (const input of ['', '   ']) {
    const r = validateNewDocPath(input, '');
    assert.equal(r.ok, false, `input='${input}' should reject`);
    if (!r.ok) assert.equal(r.reason, 'PATH_EMPTY');
  }
  // 全是斜杠 → startsWith('/') → PATH_ABSOLUTE（不是 PATH_EMPTY）
  for (const input of ['/', '///']) {
    const r = validateNewDocPath(input, '');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'PATH_ABSOLUTE');
  }
});

void test('validateNewDocPath：绝对路径（/ 开头）→ PATH_ABSOLUTE', () => {
  const r = validateNewDocPath('/etc/passwd', '');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'PATH_ABSOLUTE');
});

void test('validateNewDocPath：段含 .. → PATH_ESCAPE（逐段判断）', () => {
  // foo/.. → 拒
  assert.equal(validateNewDocPath('foo/..', '').ok, false);
  assert.equal(validateNewDocPath('foo/../bar.md', '').ok, false);
  // 但 a..b.md 是合法文件名段，逐段 split 后段名不会是单独的 '..'
  assert.equal(validateNewDocPath('a..b.md', '').ok, true);
  assert.equal(validateNewDocPath('sub/a..b.md', '').ok, true);
});

void test('validateNewDocPath：段以 . 开头 → PATH_HIDDEN（逐段判断）', () => {
  // .hidden.md → 段名 '.hidden.md' 以 . 开头 → 拒
  assert.equal(validateNewDocPath('.hidden.md', '').ok, false);
  assert.equal(validateNewDocPath('.env', '').ok, false);
  // a/.b/c.md → '.b' 段以 . 开头 → 拒
  assert.equal(validateNewDocPath('a/.b/c.md', '').ok, false);
  // 但 hello/.md 的末段是 '.md'（以 . 开头）→ 拒
  assert.equal(validateNewDocPath('hello/.md', '').ok, false);
});

void test('validateNewDocPath：非 .md 扩展名 → PATH_EXT', () => {
  assert.equal(validateNewDocPath('note.txt', '').ok, false);
  assert.equal(validateNewDocPath('note.json', '').ok, false);
  assert.equal(validateNewDocPath('note', '').ok, true, '缺扩展名应自动补 .md');
});

void test('validateNewDocPath：目标目录拼接后路径正确，去首尾多余斜杠', () => {
  assert.equal(validateNewDocPath('hello', 'sub').ok, true);
  assert.equal(validateNewDocPath('hello', '/sub/').ok, true); // 目标目录首尾 slash 允许
  const r = validateNewDocPath('hello', 'sub');
  if (r.ok) assert.equal(r.rel, 'sub/hello.md');
});

void test('validateNewDocPath：尾斜杠 a/ → PATH_EMPTY（空段被拒，避免 a/.md 隐藏段）', () => {
  const r = validateNewDocPath('a/', '');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'PATH_EMPTY');
});

void test('validateNewDocPath：中间空段 a//b → PATH_EMPTY（避免索引路径不一致）', () => {
  const r = validateNewDocPath('a//b', '');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'PATH_EMPTY');
});

// ------------------------------------------------------------------ CR-R2-2：与 Rust paths.rs 对齐

/** [input, expectedOk, expectedReason, expectedRel] — reason/rel 为 null 表示不校验该项。 */
const R2_2_CASES: readonly (readonly [string, boolean, ValidateNewDocReason | null, string | null])[] = [
  ['a.md', true, null, 'a.md'],
  ['a', true, null, 'a.md'],
  ['a.MD', true, null, null],
  ['a.txt', false, 'PATH_EXT', null],
  ['', false, 'PATH_EMPTY', null],
  ['/abs.md', false, 'PATH_ABSOLUTE', null],
  ['a/./b.md', false, null, null],
  ['a//b.md', false, null, null],
  ['../x.md', false, 'PATH_ESCAPE', null],
  ['.hidden.md', false, 'PATH_HIDDEN', null],
  ['a..b.md', true, null, null],
  ['C:\\x.md', false, 'PATH_ABSOLUTE', null],
];

void test('CR-R2-2 表驱动 12 条：与 Rust paths.rs 规则对齐（空串/绝对/..段/.开头/非md）', () => {
  for (const [input, expectedOk, expectedReason, expectedRel] of R2_2_CASES) {
    const r = validateNewDocPath(input, '');
    assert.equal(r.ok, expectedOk, `input=${JSON.stringify(input)} ok`);
    if (expectedOk && r.ok && expectedRel !== null) {
      assert.equal(r.rel, expectedRel, `input=${JSON.stringify(input)} rel`);
    }
    if (!expectedOk && !r.ok && expectedReason !== null) {
      assert.equal(r.reason, expectedReason, `input=${JSON.stringify(input)} reason`);
    }
  }
});
