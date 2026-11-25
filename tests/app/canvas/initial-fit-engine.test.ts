import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../../../src/app/canvas/engine.ts', import.meta.url),
  'utf8',
);

void test('初始适配在节点测量之后、屏幕连线计算之前执行', () => {
  const draw = source.slice(source.indexOf('  private draw(): void {'));
  const measure = draw.indexOf('this.nodes.measure(toMeasure)');
  const fit = draw.indexOf('this.applyInitialFit()');
  const edges = draw.indexOf('this.updateScreenEdges(movedNodeIds)');
  assert.ok(measure >= 0 && fit > measure && edges > fit);
});

void test('初始适配等待字体/测量/预览，并在连续稳定后关闭', () => {
  const start = source.indexOf('  private applyInitialFit(): void {');
  const end = source.indexOf('  private applyTransform(', start);
  const body = source.slice(start, end);
  assert.match(body, /fit\.fontsPending/);
  assert.match(body, /this\.pendingMeasureIds\.size > 0/);
  assert.match(body, /this\.docPreview\?\.pendingRequests/);
  assert.match(body, /fit\.stableFrames >= 2/);
  assert.match(body, /this\.initialFit = null/);
});

void test('指针、滚轮、键盘与重置/缩放命令都会优先结束初始适配', () => {
  for (const handler of ['onPointerDown', 'onWheel', 'onKeyDown']) {
    const start = source.indexOf(`private readonly ${handler}`);
    assert.ok(start >= 0, `缺少 ${handler}`);
    const body = source.slice(start, start + 700);
    assert.match(body, /this\.finishInitialFit\(\)/, `${handler} 应结束初始适配`);
  }
  for (const method of ['resetPrecisionView', 'resetView', 'zoomAtCenter']) {
    const start = source.indexOf(`  ${method}(`);
    assert.ok(start >= 0, `缺少 ${method}`);
    assert.match(source.slice(start, start + 260), /this\.finishInitialFit\(\)/);
  }
});

void test('每次 doMount 都创建新的初始适配周期，dispose 则清理', () => {
  const mount = source.slice(source.indexOf('  private async doMount(): Promise<void> {'));
  assert.match(mount, /this\.initialFit = \{ stableFrames: 0, fontsPending: false \}/);
  const stop = source.slice(source.indexOf('  private stop(): void {'));
  assert.match(stop, /this\.initialFit = null/);
});

void test('退化视口不消费初始适配，尺寸恢复后重新适配（启动空白回归）', () => {
  const fitStart = source.indexOf('  private applyInitialFit(): void {');
  const fitBody = source.slice(fitStart, source.indexOf('  private applyTransform(', fitStart));
  const guard = fitBody.indexOf('this.size.width <= 1 || this.size.height <= 1');
  const firstNodeCheck = fitBody.indexOf('this.nodeViews.length === 0');
  assert.ok(guard >= 0, 'applyInitialFit 必须识别退化视口');
  assert.ok(firstNodeCheck > guard, '退化视口判断应早于节点遍历/适配');

  const resizeStart = source.indexOf('  private resize(): void {');
  const resizeBody = source.slice(resizeStart);
  assert.match(resizeBody, /const wasDegenerate = this\.size\.width <= 1 \|\| this\.size\.height <= 1/);
  assert.match(resizeBody, /wasDegenerate && width > 1 && height > 1/);
  assert.match(resizeBody, /this\.initialFit = \{ stableFrames: 0, fontsPending: false \}/);
});
