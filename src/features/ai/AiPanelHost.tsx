/**
 * AI 面板 Host：把 AiPanel 挂到 Z_MODAL 层（CR-20261121-49 起为按钮锚定的非模态浮层）。
 * 宿主只定位不铺遮罩：面板之外不拦截指针，画布/编辑器照常使用；
 * 开合由右下角圆形按钮负责，Esc 与 × 也可关闭。
 */
import type { CSSProperties } from 'react';
import type { AiKeyStatusDto } from '../../types/ipc.ts';
import { Z_MODAL } from '../../windows/layer-z.ts';
import { AiPanel, type AiPanelEffects } from './AiPanel.tsx';

// Re-export for AppShell convenience
export type { AiPanelEffects };
export type { AiEndpointRequest } from '../../types/ipc.ts';

export interface AiPanelHostProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly effects: AiPanelEffects;
  readonly initialStatus?: AiKeyStatusDto | null;
  readonly initialTab?: 'settings' | 'chat';
}

export function AiPanelHost({ open, onClose, effects, initialStatus, initialTab }: AiPanelHostProps) {
  // 关闭时整层卸载。固定定位的宿主若常驻，会以 Z_MODAL 覆盖全屏并截获
  // 所有指针事件——界面无法点选、顶栏无法拖窗（2026-11-19 回归）。
  // CR-20261121-49：宿主指针穿透（pointer-events:none 在 .backdrop），只由面板接管交互。
  if (!open) return null;
  // style 只设 zIndex；颜色交给 AiPanel.module.css
  const style: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: Z_MODAL,
    // CR-20261121-59 修复：宿主层不得截获指针（否则 AI 圆钮收不到点击、× 失灵）；
    // 指针交互全部由 .panel（pointer-events:auto）承担。
    pointerEvents: 'none',
  };
  return (
    <div style={style} data-ai-host="true">
      <AiPanel
        open={open}
        onClose={onClose}
        effects={effects}
        initialStatus={initialStatus}
        initialTab={initialTab}
      />
    </div>
  );
}
