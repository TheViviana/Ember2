/**
 * S4：日历热力图的周分组（周一为行首）。
 *
 * 输入为 `buildBoardMetrics` 产出的连续本地日期桶（旧 → 新）；
 * 输出按周切的 7 行网格，首周与末周用 null 补齐空格。
 */
import type { BoardTrendPoint } from './model.ts';

const WEEK_LENGTH = 7;

export function buildHeatmapWeeks(
  days: readonly BoardTrendPoint[],
): readonly (readonly (BoardTrendPoint | null)[])[] {
  if (days.length === 0) return [];
  const first = days[0];
  const lead =
    first === undefined
      ? 0
      : (new Date(`${first.date}T00:00:00`).getDay() + 6) % WEEK_LENGTH;
  const cells: (BoardTrendPoint | null)[] = [];
  for (let index = 0; index < lead; index += 1) cells.push(null);
  cells.push(...days);
  while (cells.length % WEEK_LENGTH !== 0) cells.push(null);
  const weeks: (BoardTrendPoint | null)[][] = [];
  for (let index = 0; index < cells.length; index += WEEK_LENGTH) {
    weeks.push(cells.slice(index, index + WEEK_LENGTH));
  }
  return weeks;
}

export interface HeatmapMonthLabel {
  /** 列的周下标。 */
  readonly index: number;
  readonly label: string;
}

/** 月份标签与上一标签的最小列间距，避免文字挤在一起。 */
const MONTH_LABEL_GAP = 3;

/**
 * 月份轴：在月份发生变化的周列上打标签，首列总是标注。
 * 间距不足 3 列的新月份标签会被跳过，但月份状态仍然更新，避免下一周重复补标。
 */
export function buildHeatmapMonthLabels(
  weeks: readonly (readonly (BoardTrendPoint | null)[])[],
): readonly HeatmapMonthLabel[] {
  const labels: HeatmapMonthLabel[] = [];
  let lastMonth = -1;
  let lastIndex = -Infinity;
  weeks.forEach((week, index) => {
    const first = week.find((day) => day !== null) ?? null;
    if (first === null) return;
    const month = Number(first.date.slice(5, 7)) - 1;
    if (month === lastMonth) return;
    lastMonth = month;
    if (index - lastIndex < MONTH_LABEL_GAP) return;
    labels.push({ index, label: `${month + 1}月` });
    lastIndex = index;
  });
  return labels;
}
