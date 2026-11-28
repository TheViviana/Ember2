/**
 * canvas-format：画布文件格式 v3（端口连线 + 分块/汇总节点）。
 * 已实现 types/document/validate/mutate 单一规则源（CR-20261118-03 C0-A）。
 * v3 新增 split/merge 节点；读入仍接受 v2，由 app 信封层归一为 v3 后写回。
 * v2 边预留 flow?: string（数据流扩展点 X1），节点 type 'ai' 为 AI 节点化扩展点 X2。
 */
export const CANVAS_FORMAT_VERSION = '3.0.0-p0';
export const CANVAS_SCHEMA_VERSION = 3 as const;

export { CANVAS_NODE_TYPES, isCanvasNodeType } from './node-types.ts';
export type { CanvasNodeType } from './node-types.ts';
export { inspect, MAX_NODE_DIMENSION } from './document.ts';
export { validate } from './validate.ts';
export { mutate } from './mutate.ts';
export type * from './types.ts';
