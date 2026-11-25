/**
 * P6-C1 拖拽落点注册表。
 *
 * 每个落点声明可接受的 payload 子集；收到子集外类型时返回显式拒绝原因。
 * 注册表只做判定，不直接操作 DOM / React 状态（接线留在 C1-B / C1-D）。
 */
import type { DndKind, DndPayload } from './protocol.ts';

export type DropTargetId = 'canvas' | 'canvas-node' | 'doc-list' | 'editor';

export type DropDecision =
  | { readonly accepted: true; readonly payload: DndPayload; readonly notice?: string }
  | { readonly accepted: false; readonly reason: string };

export interface DropTargetSpec {
  readonly id: DropTargetId;
  readonly accepts: readonly DndKind[];
  readonly rejectReason: string;
  /** 接受后仍需提示用户的语义（如「文档导入尚未开放」）。 */
  readonly notices?: Readonly<Partial<Record<DndKind, string>>>;
}

/** CR-20261118-04 §5.2 的落点语义表。 */
export const DEFAULT_DROP_TARGETS: readonly DropTargetSpec[] = Object.freeze([
  Object.freeze({
    id: 'canvas',
    accepts: Object.freeze(['doc', 'media', 'text', 'files'] as const),
    rejectReason: '不支持的类型',
  }),
  Object.freeze({
    id: 'canvas-node',
    accepts: Object.freeze(['doc', 'media', 'text', 'files'] as const),
    rejectReason: '该内容不能放到节点上',
  }),
  Object.freeze({
    id: 'doc-list',
    accepts: Object.freeze(['files'] as const),
    rejectReason: '此处仅支持文件',
    notices: Object.freeze({ files: '文档导入尚未开放' }),
  }),
  Object.freeze({
    id: 'editor',
    accepts: Object.freeze(['media'] as const),
    rejectReason: '此处仅支持媒体插入',
  }),
]);

export interface DropTargetRegistry {
  get(id: DropTargetId): DropTargetSpec | undefined;
  list(): readonly DropTargetSpec[];
  resolve(id: DropTargetId, payload: DndPayload): DropDecision;
}

export function createDropTargetRegistry(
  specs: readonly DropTargetSpec[] = DEFAULT_DROP_TARGETS,
): DropTargetRegistry {
  const table = new Map<DropTargetId, DropTargetSpec>();
  for (const spec of specs) table.set(spec.id, spec);

  return {
    get(id: DropTargetId): DropTargetSpec | undefined {
      return table.get(id);
    },
    list(): readonly DropTargetSpec[] {
      return [...table.values()];
    },
    resolve(id: DropTargetId, payload: DndPayload): DropDecision {
      const spec = table.get(id);
      if (spec === undefined) return { accepted: false, reason: `未知的落点：${id}` };
      if (!spec.accepts.includes(payload.kind)) {
        return { accepted: false, reason: spec.rejectReason };
      }
      const notice = spec.notices?.[payload.kind];
      return notice === undefined ? { accepted: true, payload } : { accepted: true, payload, notice };
    },
  };
}
