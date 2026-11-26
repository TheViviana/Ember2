/**
 * AI 面板 Host：把 AiPanel 挂到 Z_MODAL 层（CR-20261121-49 起为按钮锚定的非模态浮层）。
 * 宿主只定位不铺遮罩：面板之外不拦截指针，画布/编辑器照常使用；
 * 开合由右下角圆形按钮负责，Esc 与 × 也可关闭。
 *
 * AI 设置已迁到设置壳；本宿主只承载对话。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { AiKeyStatusDto } from '../../types/ipc.ts';
import { Z_MODAL } from '../../windows/layer-z.ts';
import { AiPanel, type AiPanelEffects } from './AiPanel.tsx';

// Re-export for AppShell convenience
export type { AiPanelEffects };
export type { AiEndpointRequest } from '../../types/ipc.ts';

export interface AiPanelHostProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onOpenSettings?: () => void;
  readonly effects: AiPanelEffects;
  readonly initialStatus?: AiKeyStatusDto | null;
}

export function AiPanelHost({ open, onClose, onOpenSettings, effects, initialStatus }: AiPanelHostProps) {
  const [rendered, setRendered] = useState(open);
  useEffect(() => {
    if (open) {
      setRendered(true);
      return;
    }
    if (!rendered) return;
    const timer = window.setTimeout(() => setRendered(false), 160);
    return () => window.clearTimeout(timer);
  }, [open, rendered]);
  // 收起动画结束后整层卸载；宿主持久 pointer-events:none，不拦截画布。
  if (!rendered) return null;
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
        onOpenSettings={onOpenSettings}
        effects={effects}
        initialStatus={initialStatus}
      />
    </div>
  );
}
