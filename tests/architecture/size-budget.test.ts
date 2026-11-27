/**
 * 行数棘轮（ADR 0003 决策二）：热点文件不得继续变大，且预算必须与真实行数咬合。
 *
 * - 增长一律失败：要么拆分/压缩，要么在 PR 中显式上调 `scripts/size-budget.json` 并说明理由。
 * - 缩减也失败：必须同步下调预算，否则留下的松弛会让下一次增长悄悄通过。
 * - 条目缺失/格式错误一律失败（fail-closed），与 scripts/gates 的纪律一致。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BUDGET_FILE = join(ROOT, 'scripts', 'size-budget.json');

interface BudgetFile {
  readonly files: readonly { readonly path: string; readonly budget: number }[];
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}

void test('行数棘轮：热点文件的 budget 与真实行数一致', () => {
  const parsed: unknown = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  assert.ok(
    typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as BudgetFile).files),
    'scripts/size-budget.json 缺少 files 数组（fail-closed）',
  );
  const budget: BudgetFile = parsed as BudgetFile;
  assert.ok(budget.files.length > 0, 'scripts/size-budget.json 的 files 不能为空（fail-closed）');

  const seen = new Set<string>();
  for (const entry of budget.files) {
    assert.ok(
      typeof entry.path === 'string' && entry.path.length > 0,
      `预算条目缺少 path：${JSON.stringify(entry)}`,
    );
    assert.ok(
      Number.isInteger(entry.budget) && entry.budget > 0,
      `${entry.path} 的 budget 必须是正整数：${String(entry.budget)}`,
    );
    assert.ok(!seen.has(entry.path), `${entry.path} 在预算文件中重复`);
    seen.add(entry.path);

    let text: string;
    try {
      text = readFileSync(join(ROOT, entry.path), 'utf8');
    } catch {
      assert.fail(
        `${entry.path} 不存在；热点文件被删除或改名时，请同步删除/更新 scripts/size-budget.json 条目`,
      );
    }
    const actual = countLines(text);
    assert.ok(
      actual <= entry.budget,
      `${entry.path} 已增长到 ${actual} 行（预算 ${entry.budget}）。请拆分或压缩；` +
        '确属必要增长时，在 PR 中显式上调 budget 并说明理由（ADR 0003 决策二）',
    );
    assert.ok(
      actual >= entry.budget,
      `${entry.path} 实际 ${actual} 行，低于预算 ${entry.budget}。棘轮必须咬合：请把 budget 下调为 ${actual}`,
    );
  }
});