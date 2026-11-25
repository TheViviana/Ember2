/**
 * CR-20261121-49：编辑器选中文本的 AI 动作定义（纯函数，零 React / 零 IPC）。
 *
 * 动作只负责「给模型的系统提示 + 用户消息」，不关心模型与传输；
 * 请求由 app 层组装，保证 editor 层不接触 IPC。
 */
// 类型契约落在 editor 层（src/editor/ai-text-types.ts）：editor 不反向依赖 features。
// 本文件只提供动作清单与纯函数；re-export 类型以兼容既有 import 源（AiSelectionMenu / EditorWindow）。
import type { AiTextAction, AiTextActionId } from '../../editor/ai-text-types.ts';
export type { AiTextAction, AiTextActionId };

const OUTPUT_ONLY = '只输出结果本身，不要加标题、前言或寒暄，不要复述原文。';

export const AI_TEXT_ACTIONS: readonly AiTextAction[] = Object.freeze([
  {
    id: 'polish',
    label: '润色',
    system: `你是中文写作编辑。${OUTPUT_ONLY}保留原意与语气，改善用词、语序与节奏。`,
    instruction: '润色下面的文字：',
  },
  {
    id: 'expand',
    label: '扩写',
    system: `你是中文写作助手。${OUTPUT_ONLY}在不改变原意的前提下补充细节、例子与论证。`,
    instruction: '扩写下面的文字：',
  },
  {
    id: 'condense',
    label: '缩写',
    system: `你是中文写作编辑。${OUTPUT_ONLY}压缩为更精炼的表达，保留全部核心信息。`,
    instruction: '缩写下面的文字：',
  },
  {
    id: 'summarize',
    label: '总结',
    system: `你是中文信息整理助手。${OUTPUT_ONLY}用 3-5 条简短要点总结。`,
    instruction: '总结下面的文字：',
  },
  {
    id: 'explain',
    label: '解释',
    system: `你是中文讲解者。${OUTPUT_ONLY}解释这段文字的含义、背景与关键概念，语言清晰。`,
    instruction: '解释下面的文字：',
  },
  {
    id: 'extend',
    label: '延伸',
    system: `你是中文思考伙伴。${OUTPUT_ONLY}基于这段文字延伸讨论，给出进一步的观点或例子。`,
    instruction: '延伸下面的文字：',
  },
  {
    id: 'define',
    label: '定义',
    system: `你是中文术语顾问。${OUTPUT_ONLY}给出这段文字核心概念的清晰定义与边界。`,
    instruction: '给出下面文字中核心概念的定义：',
  },
  {
    id: 'research',
    label: '研究',
    system: `你是中文研究助理。${OUTPUT_ONLY}围绕这段文字给出研究问题、分析框架与可行方向。`,
    instruction: '围绕下面的文字展开研究：',
  },
]);

export interface AiTextPrompt {
  readonly system: string;
  readonly user: string;
}

export function findAiTextAction(id: AiTextActionId): AiTextAction | null {
  return AI_TEXT_ACTIONS.find((action) => action.id === id) ?? null;
}

/** 组装一次动作请求：系统提示 + 「指令 + 原文」。 */
export function buildAiTextPrompt(action: AiTextAction, text: string): AiTextPrompt {
  return Object.freeze({
    system: action.system,
    user: `${action.instruction}\n\n${text}`,
  });
}
