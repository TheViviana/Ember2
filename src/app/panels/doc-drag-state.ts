/**
 * CR-20261122-67 §3：文档树拖拽的跨组件轻量状态。
 *
 * TreeRow 在指针会话升级为 dragging 时发布 `{ active: true, path }`，pointerup/cancel
 * 时清回 inactive。DocumentList 订阅以决定是否显示落点指示（高亮文件夹 / 插入线）。
 *
 * 为何不用 React context：拖拽是高频 pointermove，context 会让整棵树重渲染；这里用
 * 模块级发布订阅，只有订阅者（DocumentList）按需 setState。
 */

export interface DocDragSnapshot {
  readonly active: boolean;
  readonly path: string;
}

type Listener = (snapshot: DocDragSnapshot) => void;

// 模块级状态用 const 容器承载（绑定不可变，属性可变），符合 mutable-exports 门禁。
const dragState: { snapshot: DocDragSnapshot } = { snapshot: { active: false, path: '' } };
const listeners = new Set<Listener>();

export function setDocDrag(next: DocDragSnapshot): void {
  dragState.snapshot = next;
  for (const listener of listeners) listener(dragState.snapshot);
}

export function getDocDrag(): DocDragSnapshot {
  return dragState.snapshot;
}

export function subscribeDocDrag(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
