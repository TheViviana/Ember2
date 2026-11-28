/**
 * 三层系统提示词合成：全局 → 画布 → 节点，节点指令最后。
 * 纯逻辑，不读写 store/DOM；调用方负责提供各层文本与默认指令。
 */
import type { AiChatRequest } from '../../types/ipc.ts';

export const PROMPT_SECTION = {
  global: '【工作台规范】',
  canvas: '【画布背景】',
  node: '【节点指令】',
} as const;

export interface LayeredPromptSources {
  readonly global?: string;
  readonly canvas?: string;
  /** 节点指令（AI 节点正文 + 相连 prompt 节点），按顺序拼接。 */
  readonly node?: readonly string[];
  /** 节点指令为空时的默认指令。 */
  readonly fallback: string;
}

export type PromptSource = 'global' | 'canvas' | 'node';

export interface PromptSection {
  readonly source: PromptSource;
  readonly label: string;
  readonly text: string;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * 分层规则（预览与真实执行共用）：
 * - 各层 trim 后跳过空串；
 * - 节点层为空时使用 fallback；
 * - 按全局 → 画布 → 节点固定顺序返回非空段。
 */
export function composePromptSections(
  sources: LayeredPromptSources,
): readonly PromptSection[] {
  const sections: PromptSection[] = [];
  const global = clean(sources.global);
  if (global !== '') {
    sections.push({ source: 'global', label: PROMPT_SECTION.global, text: global });
  }
  const canvas = clean(sources.canvas);
  if (canvas !== '') {
    sections.push({ source: 'canvas', label: PROMPT_SECTION.canvas, text: canvas });
  }
  const node =
    (sources.node ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .join('\n\n') || clean(sources.fallback);
  if (node !== '') {
    sections.push({ source: 'node', label: PROMPT_SECTION.node, text: node });
  }
  return sections;
}

/** 渲染分层结果：单层不标题，多层加标题并以空行分隔。 */
export function renderSystemPrompt(sections: readonly PromptSection[]): string {
  if (sections.length === 0) return '';
  if (sections.length === 1) return sections[0]?.text ?? '';
  return sections.map((section) => `${section.label}\n${section.text}`).join('\n\n');
}

/**
 * 组合规则：
 * - 只有一个非空层时直接返回文本（保持单节点旧行为，不加标题）；
 * - 多层时按固定顺序加标题，以空行分隔。
 */
export function composeSystemPrompt(sources: LayeredPromptSources): string {
  return renderSystemPrompt(composePromptSections(sources));
}

/** 对话请求注入全局 system；已有 system 会被替换，避免重复。 */
export function withSystemPrompt(request: AiChatRequest, system: string | undefined): AiChatRequest {
  const text = clean(system);
  if (text === '') return request;
  return {
    ...request,
    messages: [
      { role: 'system', content: text },
      ...request.messages.filter((message) => message.role !== 'system'),
    ],
  };
}