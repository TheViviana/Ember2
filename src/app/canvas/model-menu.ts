/**
 * 2026-11-23：AI 节点模型原位下拉的定位工具。
 *
 * 旧实现把原生 select 铺满整颗 AI 节点；现在只量模型框（DOM）并锚定菜单。
 * 独立成纯模块，便于对位置钳制/上下翻转做单元测试。
 */
import type { CanvasOverlayRect } from './CanvasMenus.tsx';

export const MODEL_MENU_MAX_HEIGHT = 240;

/** 在画布 host 内找到指定 AI 节点的模型框屏幕矩形（相对 host）。 */
export function modelFieldRect(host: HTMLElement, nodeId: string): CanvasOverlayRect | null {
  const fields = host.querySelectorAll<HTMLElement>('[data-ai-model="true"]');
  for (const field of fields) {
    const nodeElement = field.closest<HTMLElement>('[data-node-id]');
    if (nodeElement?.dataset.nodeId !== nodeId) continue;
    const hostRect = host.getBoundingClientRect();
    const fieldRect = field.getBoundingClientRect();
    return {
      left: fieldRect.left - hostRect.left,
      top: fieldRect.top - hostRect.top,
      width: fieldRect.width,
      height: fieldRect.height,
    };
  }
  return null;
}

export interface ModelMenuLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
}

/** 菜单优先在模型框下方，空间不足翻到上方，并横向钳制在画布内。 */
export function modelMenuLayout(
  field: CanvasOverlayRect,
  hostWidth: number,
  hostHeight: number,
): ModelMenuLayout {
  const width = Math.min(Math.max(field.width, 220), Math.max(200, hostWidth - 16));
  const left = Math.max(8, Math.min(field.left, hostWidth - width - 8));
  const below = field.top + field.height + 4;
  const openAbove = below + MODEL_MENU_MAX_HEIGHT > hostHeight - 8;
  const top = openAbove
    ? Math.max(8, field.top - MODEL_MENU_MAX_HEIGHT - 4)
    : below;
  return { left, top, width, maxHeight: MODEL_MENU_MAX_HEIGHT };
}
