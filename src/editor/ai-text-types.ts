/**
 * CR-20261121-49：编辑器选中文本的 AI 动作类型契约。
 *
 * 类型定义落在 editor 层，使 editor 不再反向依赖上层；
 * 动作清单模块从这里引入类型，并提供动作清单与纯函数。
 */
export type AiTextActionId =
  | 'polish'
  | 'expand'
  | 'condense'
  | 'summarize'
  | 'explain'
  | 'extend'
  | 'define'
  | 'research';

export interface AiTextAction {
  readonly id: AiTextActionId;
  readonly label: string;
  /** 系统提示：约束角色与输出形态。 */
  readonly system: string;
  /** 用户消息前缀：动作指令，后接原文。 */
  readonly instruction: string;
}
