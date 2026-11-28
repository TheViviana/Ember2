/**
 * AI 对话浮窗：只承载对话。
 *
 * 端点 / Key / 模型设置已迁到设置壳（AiSettingsBody）；本组件不再包含设置区。
 * 纯 features 组件：零 @tauri-apps、零 app imports、零 zustand（store 为 features 内部）。
 * 所有 IPC 调用由 AppShell 通过 effects props 注入。
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type {
  AiEndpointRequest,
  AiKeySaveDto,
  AiKeyStatusDto,
  AiModelsDto,
  AiTestConnectionDto,
} from '../../types/ipc.ts';
import { Icon } from '../../ui/icon.tsx';
import { AiChatView, type AiChatEffects } from './AiChatView.tsx';
import { useAiChatStore } from './ai-chat-store.ts';
import {
  clampAiPanelHeight,
  defaultAiPanelHeight,
  maxAiPanelHeight,
  MIN_AI_PANEL_HEIGHT,
  readAiPanelHeight,
  writeAiPanelHeight,
} from './ai-panel-reducer.ts';
import { requiresApiKey } from './ai-endpoint.ts';
import styles from './ai-panel.module.css';

// ─── Effects（AppShell 注入的 IPC 桥）──────────────────────────────

export interface AiPanelEffects extends AiChatEffects {
  saveKey(args: AiEndpointRequest & { key: string }): Promise<AiKeySaveDto>;
  deleteKey(args: AiEndpointRequest): Promise<null>;
  keyStatus(args: AiEndpointRequest): Promise<AiKeyStatusDto>;
  testConnection(args: AiEndpointRequest): Promise<AiTestConnectionDto>;
  listModels(args: AiEndpointRequest): Promise<AiModelsDto>;
}

// ─── Props ─────────────────────────────────────────────────────────

export interface AiPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 头部「⋯」：打开设置壳的 AI 设置页。 */
  readonly onOpenSettings?: () => void;
  readonly effects: AiPanelEffects;
  /** 可选：外部已检测到的 configured/keychainAvailable（避免重复拉） */
  readonly initialStatus?: AiKeyStatusDto | null;
}

// ─── Component ──────────────────────────────────────────────────────

export function AiPanel({ open, onClose, onOpenSettings, effects, initialStatus }: AiPanelProps) {
  const config = useAiChatStore((state) => state.config);
  const [configured, setConfigured] = useState(initialStatus?.configured ?? false);
  const [height, setHeight] = useState(() => (
    readAiPanelHeight(window.innerHeight) ?? defaultAiPanelHeight(window.innerHeight)
  ));
  const resizeRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const lastStatusCheck = useRef(0);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // 对话只需知道端点是否已配置；Ollama 无 Key，直接视为可用。
  useEffect(() => {
    if (!open) return;
    if (!requiresApiKey(config.provider)) {
      setConfigured(true);
      return;
    }
    const now = Date.now();
    if (now - lastStatusCheck.current < 3000) return;
    lastStatusCheck.current = now;
    let disposed = false;
    void effects
      .keyStatus({
        provider: config.provider,
        baseUrl: config.baseUrl,
        allowInsecureHttp: config.allowInsecureHttp,
      })
      .then((dto) => {
        if (!disposed) setConfigured(dto.configured);
      })
      .catch(() => {
        // key_status 失败不阻塞对话；错误由 Rust 记录
      });
    return () => {
      disposed = true;
    };
  }, [open, effects, config.provider, config.baseUrl, config.allowInsecureHttp]);

  useEffect(() => {
    const clampToViewport = (): void => {
      setHeight((current) => clampAiPanelHeight(current, window.innerHeight));
    };
    window.addEventListener('resize', clampToViewport);
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  function resizeTo(next: number): void {
    const value = clampAiPanelHeight(next, window.innerHeight);
    setHeight(value);
    writeAiPanelHeight(value, window.innerHeight);
  }

  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
  }

  function moveResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    setHeight(clampAiPanelHeight(drag.startHeight + drag.startY - event.clientY, window.innerHeight));
  }

  function endResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = resizeRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeTo(drag.startHeight + drag.startY - event.clientY);
  }

  function resizeWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    resizeTo(height + (event.key === 'ArrowUp' ? 16 : -16));
  }

  const model = (config.model ?? '').trim();
  const modelLabel =
    model.length > 0
      ? model
      : config.provider === 'ollama'
        ? 'OLLAMA · 本地'
        : config.provider === 'openai-compatible-local'
          ? 'LOCAL · 本地'
          : 'OPENAI';

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.panel}
        id="ai-panel"
        role="dialog"
        aria-label="AI 面板"
        data-open={open}
        style={{ height }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className={styles.resizeHandle}
          role="separator"
          aria-label="调整 AI 面板高度"
          aria-orientation="horizontal"
          aria-valuemin={MIN_AI_PANEL_HEIGHT}
          aria-valuemax={maxAiPanelHeight(window.innerHeight)}
          aria-valuenow={height}
          tabIndex={0}
          onKeyDown={resizeWithKeyboard}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
        <header className={styles.header}>
          <h2 className={styles.title}>
            <Icon size={16} className={styles.titleIcon}>
              <path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z" />
              <path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z" />
              <path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17" />
            </Icon>
            AI 助手
            <span className={styles.modelChip} title={modelLabel}>
              {modelLabel}
            </span>
          </h2>
          <span className={styles.headerSpacer} />
          {onOpenSettings === undefined ? null : (
            <button
              type="button"
              className={styles.headerButton}
              aria-label="AI 设置"
              title="AI 设置"
              onClick={onOpenSettings}
            >
              ⋯
            </button>
          )}
          <button
            type="button"
            className={styles.headerButton}
            aria-label="收起 AI 助手"
            title="收起"
            onClick={onClose}
          >
            <Icon size={14}>
              <path d="m6 9 6 6 6-6" />
            </Icon>
          </button>
        </header>

        <div className={styles.tabPanel} aria-label="AI 对话">
          <AiChatView effects={effects} configured={configured} />
        </div>
      </div>
    </div>
  );
}
