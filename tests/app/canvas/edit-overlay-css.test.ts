import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();

/**
 * CR-20261121-52：文本编辑输入框的节点定位完全依赖 inline style 的 left/top——
 * 只有 `.editInput` 自带 position:absolute 才会生效。C0-D 的 .editOverlay 包装层
 * 从未被 TSX 使用（死类），裸 input 掉进文档流停在画布左上角，即建即编与双击
 * 改名的编辑框视觉上不存在。此文件钉住定位声明并防止死类回潮。
 */
void test('editInput 必须自带绝对定位与层级（回归钉子）', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  const rule = css.match(/\.editInput\s*\{[^}]*\}/);
  assert.ok(rule !== null, 'CanvasView.module.css 应包含 .editInput 规则');
  assert.match(rule[0], /position:\s*absolute/, 'inline left/top 只对定位元素生效');
  assert.match(rule[0], /z-index:/, '编辑框必须浮在画布之上');
});

void test('未被 TSX 使用的 .editOverlay 包装死类不得回潮', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  // 只禁规则定义本身；注释中说明历史原因的提及不受影响。
  assert.doesNotMatch(css, /\.editOverlay\s*\{/);
});

void test('编辑中的底层节点不得叠加边框、选中环或 AI 轮廓动画', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/canvas.module.css'), 'utf8');
  const rule = css.match(/\.node\[data-editing='true'\][\s\S]*?\{[^}]*\}/);
  assert.ok(rule !== null, 'canvas.module.css 应包含编辑态抑制规则');
  assert.match(rule[0], /border-color:\s*transparent/);
  assert.match(rule[0], /outline:\s*none/);
  assert.match(rule[0], /box-shadow:\s*none/);
  assert.match(rule[0], /animation:\s*none/);
});

void test('三个编辑控件只保留单一主题边框，不叠装饰阴影', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  for (const name of ['editInput', 'editTextarea', 'modelSelect']) {
    const rule = css.match(new RegExp(`\\.${name}\\s*\\{[^}]*\\}`));
    assert.ok(rule !== null, `缺少 .${name}`);
    assert.match(rule[0], /border:\s*1px solid var\(--ember-primary\)/);
    assert.doesNotMatch(rule[0], /box-shadow:/);
  }
});
