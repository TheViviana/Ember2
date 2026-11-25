/**
 * S4：日历热力图周分组。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHeatmapMonthLabels, buildHeatmapWeeks } from '../../../src/features/board/calendar.ts';
import type { BoardTrendPoint } from '../../../src/features/board/model.ts';

function day(date: string, count = 0): BoardTrendPoint {
  return { date, count };
}

function weekdays(days: readonly (BoardTrendPoint | null)[]): readonly (string | null)[] {
  return days.map((entry) => (entry === null ? null : entry.date));
}

void test('空输入返回空数组', () => {
  assert.deepEqual(buildHeatmapWeeks([]), []);
});

void test('周一起始的 7 天正好一周，无空格', () => {
  const days = [
    day('2024-01-01'),
    day('2024-01-02'),
    day('2024-01-03'),
    day('2024-01-04'),
    day('2024-01-05'),
    day('2024-01-06'),
    day('2024-01-07'),
  ];
  const weeks = buildHeatmapWeeks(days);
  assert.equal(weeks.length, 1);
  assert.deepEqual(weekdays(weeks[0] ?? []), days.map((entry) => entry.date));
});

void test('首日为周三时前置两个空格', () => {
  const days = [day('2024-01-03'), day('2024-01-04'), day('2024-01-05')];
  const weeks = buildHeatmapWeeks(days);
  assert.equal(weeks.length, 1);
  const cells = weeks[0] ?? [];
  assert.equal(cells.length, 7);
  assert.equal(cells[0], null);
  assert.equal(cells[1], null);
  assert.equal(cells[2]?.date, '2024-01-03');
  assert.equal(cells[3]?.date, '2024-01-04');
  assert.equal(cells[4]?.date, '2024-01-05');
  assert.equal(cells[5], null);
  assert.equal(cells[6], null);
});

void test('末周不足 7 天补 null，总格数为 7 的倍数', () => {
  const days = Array.from({ length: 10 }, (_, index) =>
    day(`2024-01-${String(index + 1).padStart(2, '0')}`),
  );
  const weeks = buildHeatmapWeeks(days);
  const cells = weeks.flat();
  assert.equal(cells.length % 7, 0);
  assert.equal(weeks.length, 2);
  assert.equal(cells[9]?.date, '2024-01-10');
  assert.equal(cells[10], null);
  assert.equal(cells[13], null);
});

void test('不修改输入数组与元素', () => {
  const days = Object.freeze([Object.freeze(day('2024-01-03', 2))]);
  const before = JSON.stringify(days);
  buildHeatmapWeeks(days);
  assert.equal(JSON.stringify(days), before);
});

void test('月份轴：空输入无标签', () => {
  assert.deepEqual(buildHeatmapMonthLabels([]), []);
});

void test('月份轴：在月份变化的周列标注，首列为 1 月', () => {
  const days = Array.from({ length: 70 }, (_, index) => {
    const date = new Date(2024, 0, 1 + index);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const dayOfMonth = String(date.getDate()).padStart(2, '0');
    return day(`2024-${month}-${dayOfMonth}`);
  });
  const labels = buildHeatmapMonthLabels(buildHeatmapWeeks(days));
  assert.deepEqual(
    labels.map((label) => label.label),
    ['1月', '2月', '3月'],
  );
  assert.equal(labels[0]?.index, 0);
  assert.ok(labels[1] !== undefined && labels[1].index >= 3, '标签之间至少间隔 3 列');
});
