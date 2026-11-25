/**
 * C0-D 纯逻辑测试：canvas-interactions（右键菜单命令映射、dead-link、连线规则）。
 * 不依赖 DOM/React；跑在独立 node harness 下。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDocLink,
  createAddAiNodeCommand,
  createAddDocumentNodeCommand,
  createAddMediaNodeCommand,
  createAddPromptNodeCommand,
  createAddTextNodeCommand,
  createRemoveNodeCommands,
  createUpdateAiModelCommand,
  createUpdateDocPathCommand,
  createUpdateLabelCommand,
  createUpdatePromptTextCommand,
  documentTitleFromPath,
  makeEdgeId,
  makeNodeId,
  resolveEffectivePath,
} from '../../../src/app/canvas/canvas-interactions.ts';

// ── id 生成 ─────────────────────────────────────────────────────────

void void test('makeNodeId / makeEdgeId：每次调用唯一，无前缀冲突', () => {
  const ids = Array.from({ length: 20 }, () => makeNodeId());
  assert.equal(new Set(ids).size, 20, '20 次调用全部唯一');
  for (const id of ids) {
    assert.ok(id.startsWith('n_'), `node id 前缀 n_：${id}`);
  }
  const eid = makeEdgeId();
  assert.ok(eid.startsWith('e_'), `edge id 前缀 e_：${eid}`);
});

// ── 右键菜单命令映射 ───────────────────────────────────────────────

void test('createAddTextNodeCommand：最小合法形状，type=text，有唯一 id', () => {
  const cmd = createAddTextNodeCommand(120, 340);
  assert.equal(cmd.kind, 'addNode');
  assert.equal(cmd.node.type, 'text');
  assert.equal(cmd.node.x, 120);
  assert.equal(cmd.node.y, 340);
  assert.ok(typeof cmd.node.id === 'string' && cmd.node.id.length > 0);
  assert.equal(cmd.node.label, '文本节点');
  // 不自动补默认端口（R3=B 兼容投影）
  assert.equal('ports' in cmd.node, false, '不自动补 ports 数组');
  assert.equal('parentId' in cmd.node, false, '不自动补 parentId');
});

void test('createAddDocumentNodeCommand：type=document，带 docPath，label 取文件名', () => {
  const cmd = createAddDocumentNodeCommand(10, 20, 'docs/foo.md');
  assert.equal(cmd.kind, 'addNode');
  assert.equal(cmd.node.type, 'document');
  assert.equal(cmd.node.docPath, 'docs/foo.md');
  assert.equal(cmd.node.label, 'foo.md');
});

void test('documentTitleFromPath：取文件名，兼容反斜杠与无分隔符', () => {
  assert.equal(documentTitleFromPath('docs/foo.md'), 'foo.md');
  assert.equal(documentTitleFromPath('a/b/c/标题.md'), '标题.md');
  assert.equal(documentTitleFromPath('a\\b\\c.md'), 'c.md');
  assert.equal(documentTitleFromPath('plain.md'), 'plain.md');
});

void test('createRemoveNodeCommands：批量，每个都是 removeNode', () => {
  const cmds = createRemoveNodeCommands(['a', 'b', 'c']);
  assert.equal(cmds.length, 3);
  assert.deepEqual(cmds.map((c) => c.kind), ['removeNode', 'removeNode', 'removeNode']);
  assert.deepEqual(cmds.map((c) => (c.kind === 'removeNode' ? c.id : null)), ['a', 'b', 'c']);
});

void test('createRemoveNodeCommands：空数组返回空数组（不报错）', () => {
  assert.deepEqual(createRemoveNodeCommands([]), []);
});

void test('createUpdateLabelCommand / createUpdateDocPathCommand：updateNode 命令', () => {
  const labelCmd = createUpdateLabelCommand('n1', '新标签');
  assert.equal(labelCmd.kind, 'updateNode');
  assert.equal(labelCmd.id, 'n1');
  assert.deepEqual(labelCmd.changes, { label: '新标签' });

  const pathCmd = createUpdateDocPathCommand('n1', 'docs/bar.md');
  assert.equal(pathCmd.kind, 'updateNode');
  assert.equal(pathCmd.id, 'n1');
  assert.deepEqual(pathCmd.changes, { docPath: 'docs/bar.md' });
});

// ── dead-link 四分支 ────────────────────────────────────────────────

void test('resolveEffectivePath：空字符串返回 null（未绑定）', () => {
  assert.equal(resolveEffectivePath('', () => null), null);
});

void test('resolveEffectivePath：别名命中返回别名解析后路径', () => {
  const resolve = (from: string) =>
    from === 'docs/old-name.md' ? 'docs/new-name.md' : null;
  assert.equal(resolveEffectivePath('docs/old-name.md', resolve), 'docs/new-name.md');
});

void test('resolveEffectivePath：无别名命中返回原路径', () => {
  assert.equal(resolveEffectivePath('docs/exists.md', () => null), 'docs/exists.md');
});

void test('classifyDocLink：unbound（空路径）', () => {
  const status = classifyDocLink('', () => null, () => true);
  assert.equal(status.kind, 'unbound');
});

void test('classifyDocLink：ok（别名命中且 docs 有）', () => {
  const status = classifyDocLink(
    'docs/old.md',
    (from) => (from === 'docs/old.md' ? 'docs/new.md' : null),
    (path) => path === 'docs/new.md',
  );
  assert.equal(status.kind, 'ok');
  assert.equal(status.effectivePath, 'docs/new.md');
});

void test('classifyDocLink：ok（无别名但 docs 有原路径）', () => {
  const status = classifyDocLink('docs/foo.md', () => null, (p) => p === 'docs/foo.md');
  assert.equal(status.kind, 'ok');
  assert.equal(status.effectivePath, 'docs/foo.md');
});

void test('classifyDocLink：dead（别名也不命中，docs 也没有）', () => {
  const status = classifyDocLink('docs/missing.md', () => null, () => false);
  assert.equal(status.kind, 'dead');
  assert.equal(status.effectivePath, 'docs/missing.md');
});

void test('classifyDocLink：别名命中但 docs 也没有别名路径 → dead', () => {
  const status = classifyDocLink(
    'docs/old.md',
    () => 'docs/gone.md',
    () => false,
  );
  assert.equal(status.kind, 'dead');
  assert.equal(status.effectivePath, 'docs/gone.md');
});

// ── CR-24 C3：媒体节点按 kind 写默认尺寸（不带 w/h 会回退 160×96，控件被压扁）──

void test('createAddMediaNodeCommand：audio 默认 280×90', () => {
  const command = createAddMediaNodeCommand(10, 20, 'media/audio/ab/v.mp3', 'audio');
  assert.equal(command.kind, 'addNode');
  if (command.kind !== 'addNode') return;
  assert.equal(command.node.type, 'media');
  assert.equal(command.node.w, 280);
  assert.equal(command.node.h, 90);
});

void test('createAddMediaNodeCommand：video 默认 320×180', () => {
  const command = createAddMediaNodeCommand(10, 20, 'media/video/ef/c.mp4', 'video');
  if (command.kind !== 'addNode') return;
  assert.equal(command.node.w, 320);
  assert.equal(command.node.h, 180);
});

void test('createAddMediaNodeCommand：image 不写 w/h（沿用现状）', () => {
  const command = createAddMediaNodeCommand(10, 20, 'media/image/ab/i.png', 'image');
  if (command.kind !== 'addNode') return;
  assert.equal(command.node.w, undefined);
  assert.equal(command.node.h, undefined);
});

void test('CR-20261121-53：AI/提示词节点创建命令与 text/model 更新命令', () => {
  const ai = createAddAiNodeCommand(5, 6);
  if (ai.kind !== 'addNode') throw new Error('预期 addNode');
  assert.equal(ai.node.type, 'ai');
  assert.equal(ai.node.label, 'AI 节点');

  const prompt = createAddPromptNodeCommand(7, 8);
  if (prompt.kind !== 'addNode') throw new Error('预期 addNode');
  assert.equal(prompt.node.type, 'prompt');
  assert.equal(prompt.node.text, '');

  assert.deepEqual(createUpdatePromptTextCommand('p', 'a\nb'), {
    kind: 'updateNode',
    id: 'p',
    changes: { text: 'a\nb' },
  });
  assert.deepEqual(createUpdateAiModelCommand('ai', null), {
    kind: 'updateNode',
    id: 'ai',
    changes: { model: null },
  });
});
