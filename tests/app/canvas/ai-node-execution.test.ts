/**
 * CR-20261122-62：AI 节点执行纯逻辑——文档有向收集与消息构造。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_RUN_MAX_CHARS,
  buildAiRunMessages,
  collectAiNeighbors,
  findPromptAiNode,
} from '../../../src/app/canvas/ai-node-execution.ts';

const nodes: readonly unknown[] = [
  { id: 'doc1', type: 'document', docPath: '/docs/a.md', label: '甲文' },
  { id: 'doc2', type: 'document', docPath: '/docs/b.md', label: '乙文' },
  { id: 'prompt1', type: 'prompt', text: '检测关联性' },
  { id: 'promptEmpty', type: 'prompt', text: '   ' },
  { id: 'out1', type: 'text', label: '输出一' },
  { id: 'out2', type: 'text', label: '输出二' },
  { id: 'ai', type: 'ai', model: 'qwen3:8b', text: '先比较主题，再深化分析' },
];

function edge(id: string, from: string, to: string): unknown {
  return { id, from: { nodeId: from }, to: { nodeId: to } };
}

void test('findPromptAiNode：无连接或只连接非 AI 节点时返回 null', () => {
  assert.equal(findPromptAiNode(nodes, [], 'prompt1'), null);
  assert.equal(
    findPromptAiNode(nodes, [edge('e1', 'prompt1', 'out1')], 'prompt1'),
    null,
  );
});

void test('findPromptAiNode：多连接按边顺序取首个 AI，方向无关', () => {
  const withSecondAi = [...nodes, { id: 'ai2', type: 'ai' }];
  const edges = [
    edge('e1', 'prompt1', 'out1'),
    edge('e2', 'ai2', 'prompt1'),
    edge('e3', 'prompt1', 'ai'),
  ];
  assert.equal(findPromptAiNode(withSecondAi, edges, 'prompt1'), 'ai2');
});

void test('findPromptAiNode：自环不算 AI 连接，也不阻断后续有效边', () => {
  const selfLoop = edge('loop', 'prompt1', 'prompt1');
  assert.equal(findPromptAiNode(nodes, [selfLoop], 'prompt1'), null);
  assert.equal(
    findPromptAiNode(nodes, [selfLoop, edge('e1', 'prompt1', 'ai')], 'prompt1'),
    'ai',
  );
});

void test('文档按方向区分素材与输出；提示词和文本保持方向无关', () => {
  const edges: readonly unknown[] = [
    edge('e1', 'doc1', 'ai'),
    edge('e2', 'ai', 'doc2'),
    edge('e3', 'prompt1', 'ai'),
    edge('e4', 'promptEmpty', 'ai'),
    edge('e5', 'ai', 'out2'),
    edge('e6', 'out1', 'ai'),
    edge('e7', 'ai', 'doc1'),
  ];
  const collected = collectAiNeighbors(nodes, edges, 'ai');
  assert.deepEqual(collected.docs.map((doc) => doc.docPath), ['/docs/a.md']);
  assert.deepEqual(collected.docs.map((doc) => doc.label), ['甲文']);
  assert.deepEqual(
    collected.prompts,
    ['先比较主题，再深化分析', '检测关联性'],
    'AI 自身提示词优先，其后按原连线顺序追加旧提示词并跳过空文本',
  );
  assert.equal(collected.outputNodeId, 'out2', '按连线顺序取首个文本节点');
  assert.deepEqual(
    collected.outputDoc,
    { nodeId: 'doc2', docPath: '/docs/b.md', label: '乙文' },
    '按连线顺序取首个 AI → 文档输出',
  );
  assert.equal(collected.model, 'qwen3:8b');
});

void test('重复素材文档去重；同一文档可同时作为素材和输出', () => {
  const edges: readonly unknown[] = [
    edge('e1', 'doc1', 'ai'),
    edge('e2', 'ai', 'doc1'),
    edge('e3', 'ai', 'out1'),
  ];
  const collected = collectAiNeighbors(nodes, edges, 'ai');
  assert.equal(collected.docs.length, 1);
  assert.equal(collected.outputDoc?.nodeId, 'doc1');
  assert.equal(collected.model, 'qwen3:8b');

  const bare = collectAiNeighbors([{ id: 'ai2', type: 'ai' }], [], 'ai2');
  assert.deepEqual(bare, {
    docs: [],
    prompts: [],
    outputNodeId: null,
    outputDoc: null,
    model: null,
  });
});

void test('buildAiRunMessages：提示词=system、文章分节=user', () => {
  const built = buildAiRunMessages({
    docs: [
      { title: '甲文', content: '内容甲' },
      { title: '乙文', content: '内容乙' },
    ],
    prompts: ['检测两篇文章的关联性'],
  });
  assert.deepEqual(built, {
    ok: true,
    system: '检测两篇文章的关联性',
    user: '【文章 1：甲文】\n\n内容甲\n\n【文章 2：乙文】\n\n内容乙',
  });

  const fallback = buildAiRunMessages({ docs: [{ title: '甲', content: 'c' }], prompts: [] });
  assert.ok(fallback.ok && fallback.system.length > 0, '无提示词回退内置指令');
});

void test('buildAiRunMessages：超长拒绝、空素材拒绝', () => {
  const tooLong = buildAiRunMessages({
    docs: [{ title: '甲', content: 'x'.repeat(AI_RUN_MAX_CHARS) }],
    prompts: [],
  });
  assert.deepEqual(tooLong, { ok: false, reason: 'too_long' });
  assert.deepEqual(buildAiRunMessages({ docs: [], prompts: ['p'] }), {
    ok: false,
    reason: 'empty_docs',
  });
});
