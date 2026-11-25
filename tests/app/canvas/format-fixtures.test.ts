/**
 * 真实文件读取回归（R2）：磁盘上的 v1 画布只报 E_UNSUPPORTED_VERSION，
 * 且解析过程不改写任何字节。
 *
 * 仓库内尚未定义 v1 信封字段名，故同时覆盖 { version: 1 } 与 { schemaVersion: 1 }
 * 两种候选；两者都必须被拒绝，不能靠猜字段静默升级。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  CanvasFormatError,
  parseCanvasDocument,
} from '../../../src/app/canvas/format.ts';

const fixtures = [
  { file: 'legacy-v1-version.canvas.json', label: 'v1 { version: 1 }' },
  { file: 'legacy-v1-schema-version.canvas.json', label: 'v1 { schemaVersion: 1 }' },
] as const;

for (const fixture of fixtures) {
  void test(`真实文件：${fixture.label} → E_UNSUPPORTED_VERSION 且字节不变`, async () => {
    const url = new URL(`./fixtures/${fixture.file}`, import.meta.url);
    const before = await readFile(url);

    assert.throws(
      () => parseCanvasDocument(before.toString('utf8')),
      (error: unknown) =>
        error instanceof CanvasFormatError && error.code === 'E_UNSUPPORTED_VERSION',
    );

    const after = await readFile(url);
    assert.deepEqual(after, before);
  });
}
