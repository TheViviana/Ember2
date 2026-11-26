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

void test('自由文本编辑区从左上开始并保留多行', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  const rule = css.match(/\.editNodeText\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /box-sizing:\s*border-box/);
  assert.match(rule, /text-align:\s*left/);
  assert.match(rule, /vertical-align:\s*top/);
  const canvasCss = readFileSync(join(ROOT, 'src/app/canvas/canvas.module.css'), 'utf8');
  const displayRule = canvasCss.match(/\.nodeCardContent\[data-simple-kind='text'\]\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(displayRule, /white-space:\s*pre-wrap/, '提交后的文本节点也必须保留换行');
});

void test('独立标题改名只描出标题行，不再使用整节点的大输入框', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  const rule = css.match(/\.editTitleInput\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /min-width:\s*0/);
  assert.match(rule, /padding:\s*0/);
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /outline:\s*1px solid var\(--ember-primary\)/);
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

void test('文本编辑控件保留单一主题边框；模型下拉改为原位菜单', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/CanvasView.module.css'), 'utf8');
  for (const name of ['editInput', 'editTextarea']) {
    const rule = css.match(new RegExp(`\\.${name}\\s*\\{[^}]*\\}`));
    assert.ok(rule !== null, `缺少 .${name}`);
    assert.match(rule[0], /border:\s*1px solid var\(--ember-primary\)/);
    assert.doesNotMatch(rule[0], /box-shadow:/);
  }
  const menu = css.match(/\.modelMenu\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(menu, /position:\s*absolute/, '模型菜单必须锚定模型框');
  assert.match(menu, /overflow-y:\s*auto/, '模型多时菜单内部滚动');
  assert.doesNotMatch(css, /\.modelSelect\s*\{/, '旧的铺满节点 select 样式应删除');
});


void test('画布视口 keyboard 焦点不再画整窗外框（用户截图 #3）', () => {
  const css = readFileSync(join(ROOT, 'src/app/canvas/canvas.module.css'), 'utf8');
  const rule = css.match(/\.viewport:focus-visible\s*\{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /outline:\s*none/, '整窗大面积焦点目标不显示外框');
});
