/**
 * composeSystemPrompt 边界：顺序、空层、单层无标题、fallback、对话 system 注入。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROMPT_SECTION,
  composePromptSections,
  composeSystemPrompt,
  withSystemPrompt,
} from '../../../src/features/ai/system-prompt.ts';
import type { AiChatRequest } from '../../../src/types/ipc.ts';

void test('三层完整拼接：全局 → 画布 → 节点，节点最后', () => {
  const system = composeSystemPrompt({
    global: ' 始终用中文 ',
    canvas: '产品需求评审画布',
    node: ['汇总文章', '指出冲突点'],
    fallback: '默认指令',
  });
  assert.equal(
    system,
    [
      `${PROMPT_SECTION.global}\n始终用中文`,
      `${PROMPT_SECTION.canvas}\n产品需求评审画布`,
      `${PROMPT_SECTION.node}\n汇总文章\n\n指出冲突点`,
    ].join('\n\n'),
  );
});

void test('空层跳过：只保留全局与节点，且不出现画布标题', () => {
  const system = composeSystemPrompt({
    global: '用中文',
    canvas: '   ',
    node: ['任务'],
    fallback: '默认指令',
  });
  assert.equal(system, `${PROMPT_SECTION.global}\n用中文\n\n${PROMPT_SECTION.node}\n任务`);
  assert.equal(system.includes(PROMPT_SECTION.canvas), false);
});

void test('单层不加标题：只有节点指令时保持旧行为', () => {
  assert.equal(
    composeSystemPrompt({ node: ['  只做这一件事  '], fallback: '默认指令' }),
    '只做这一件事',
  );
});

void test('节点为空回退 fallback；全部为空返回空串', () => {
  assert.equal(
    composeSystemPrompt({ node: ['', '  '], fallback: ' 默认指令 ' }),
    '默认指令',
  );
  assert.equal(composeSystemPrompt({ fallback: '  ' }), '');
});

void test('composePromptSections：预览与执行共用分层结果', () => {
  const sections = composePromptSections({
    global: ' 全局规范 ',
    canvas: '',
    node: ['节点指令'],
    fallback: '默认指令',
  });
  assert.deepEqual(sections, [
    { source: 'global', label: PROMPT_SECTION.global, text: '全局规范' },
    { source: 'node', label: PROMPT_SECTION.node, text: '节点指令' },
  ]);
});

void test('composePromptSections：节点为空时使用 fallback 作为节点层', () => {
  const sections = composePromptSections({ node: [], fallback: '默认指令' });
  assert.deepEqual(sections, [
    { source: 'node', label: PROMPT_SECTION.node, text: '默认指令' },
  ]);
});

void test('withSystemPrompt：空值不改请求，非空替换旧 system', () => {
  const request: AiChatRequest = {
    requestId: 'r1',
    provider: 'openai-compatible',
    baseUrl: 'https://example.com',
    allowInsecureHttp: false,
    model: 'm',
    messages: [
      { role: 'system', content: '旧 system' },
      { role: 'user', content: 'hi' },
    ],
  };
  assert.equal(withSystemPrompt(request, '  '), request);

  const next = withSystemPrompt(request, ' 新规范 ');
  assert.deepEqual(next.messages, [
    { role: 'system', content: '新规范' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(request.messages.length, 2);
});