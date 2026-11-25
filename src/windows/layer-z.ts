/**
 * P5-C2：浮窗系统层级 z-index 常量。
 *
 * 四档分层（数值留足间隔，便于中间层插入而不重排已有层）：
 * - Z_WINDOW：普通窗体，每窗实际 z = Z_WINDOW + zOrder（manager 派生）。
 * - Z_DRAG：拖拽/缩放中的窗体预览，保证高于兄弟窗体。
 * - Z_MODAL：模态层（C4 接线关窗确认等），C2 预留空容器。
 * - Z_TOAST：提示层（最小化条 + 关窗 flush 提示 + 重叠提示），始终最上层。
 *
 * 均为 const 基本类型，本身不可变；不导出可变容器（gate:mutable-exports）。
 */
export const Z_WINDOW = 1000;
export const Z_DRAG = 2000;
export const Z_MODAL = 3000;
export const Z_TOAST = 4000;
