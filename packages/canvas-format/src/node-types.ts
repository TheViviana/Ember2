/** 画布节点 type 白名单（八种）；运行时清单唯一来源。 */
export const CANVAS_NODE_TYPES = Object.freeze([
  'document',
  'media',
  'text',
  'group',
  'ai',
  'prompt',
  'split',
  'merge',
] as const);

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[number];

/** 未知、非字符串或白名单外的 type 一律返回 false，由调用方决定归一或报错。 */
export function isCanvasNodeType(value: unknown): value is CanvasNodeType {
  return CANVAS_NODE_TYPES.some((type) => type === value);
}
