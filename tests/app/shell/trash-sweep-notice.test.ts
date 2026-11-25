/**
 * CR-20261122-61：启动清扫报告 → 通知文案的映射纪律。
 * 跳过/失败 → warning；仅移除 → info；无变化 → null（静默，不制造通知噪音）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatSweepNotice } from '../../../src/app/shell/trash-sweep-notice.ts';
import type { SweepReportDto } from '../../../src/types/ipc.ts';

function report(overrides: Partial<SweepReportDto> = {}): SweepReportDto {
  return { scanned: 12, removed: [], errors: [], skipped: null, ...overrides };
}

void test('无移除无错未跳过 → null（静默）', () => {
  assert.equal(formatSweepNotice(report()), null);
});

void test('正常移除 → info 文案含数量', () => {
  const notice = formatSweepNotice(report({ removed: ['a.md', 'b.png'] }));
  assert.deepEqual(notice, { message: '回收站清扫完成：移除 2 项', tone: 'info' });
});

void test('有失败项 → warning 且同时报告移除与失败数', () => {
  const notice = formatSweepNotice(
    report({ removed: ['a.md'], errors: [{ id: 'x', message: 'E_IO' }] }),
  );
  assert.deepEqual(notice, {
    message: '回收站清扫完成：移除 1 项，失败 1 项',
    tone: 'warning',
  });
});

void test('库只读跳过 → warning', () => {
  const notice = formatSweepNotice(report({ skipped: 'readonly' }));
  assert.deepEqual(notice, { message: '回收站清扫未执行：库只读', tone: 'warning' });
});

void test('写队列忙跳过 → warning', () => {
  const notice = formatSweepNotice(report({ skipped: 'busy' }));
  assert.deepEqual(notice, { message: '回收站清扫未执行：写队列忙', tone: 'warning' });
});
