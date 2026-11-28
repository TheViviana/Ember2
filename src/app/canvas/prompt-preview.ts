/**
 * AI 节点 System Prompt 预览：复用运行期邻居收集与三层合成，保证预览与执行同源。
 */
import type { CanvasDocument } from '#canvas-format';
import { collectAiNeighbors, DEFAULT_AI_INSTRUCTION } from './ai-node-execution.ts';
import {
  composePromptSections,
  renderSystemPrompt,
  type PromptSection,
} from '../../features/ai/system-prompt.ts';

export interface AiPromptPreview {
  readonly sections: readonly PromptSection[];
  readonly system: string;
  readonly model: string | null;
  readonly promptCount: number;
  readonly docCount: number;
}

/**
 * 构造指定 AI 节点的 System 预览；节点不存在或不是 AI 节点返回 null。
 * 不读取文档正文，因此不会触发 IO。
 */
export function buildAiNodePromptPreview(
  document: CanvasDocument,
  nodeId: string,
  context: { readonly global?: string; readonly canvas?: string },
): AiPromptPreview | null {
  const aiNode = document.nodes.find(
    (node) => node !== null && typeof node === 'object' &&
      (node as { readonly id?: unknown }).id === nodeId,
  );
  if (aiNode === undefined || (aiNode as { readonly type?: unknown }).type !== 'ai') {
    return null;
  }

  const collected = collectAiNeighbors(document.nodes, document.edges, nodeId);
  const sources = {
    global: context.global,
    canvas: context.canvas,
    node: collected.prompts,
    fallback: DEFAULT_AI_INSTRUCTION,
  };
  const sections = composePromptSections(sources);
  return {
    sections,
    system: renderSystemPrompt(sections),
    model: collected.model,
    promptCount: collected.prompts.length,
    docCount: collected.docs.length,
  };
}