/**
 * P3 启动入口：启动 EmberCore，就绪后渲染三栏应用壳。
 * 关闭窗口前先 flush 所有防抖中的脏文档，写盘失败则取消关闭并提示。
 */
import { useEffect, useState } from 'react';
import { createTauriWindowPort } from '../data/window-port';
import { createCanvasCloseHooks } from './canvas/close-hooks';
import { installCloseGuard } from './close-guard';
import { lockAllEditors, resumeAllEditors } from './editor-lock-registry';
import { AppShell } from './shell/AppShell';
import { SpatialWorkspaceHost } from '../features/spatial/SpatialWorkspaceHost.tsx';
import { useEmberStore } from './stores/ember-store';
import { registerBuiltInWindowContent } from './window-content.ts';

registerBuiltInWindowContent();

export function App() {
  const status = useEmberStore((state) => state.status);
  const identity = useEmberStore((state) => state.identity);
  const lastError = useEmberStore((state) => state.lastError);
  const start = useEmberStore((state) => state.start);
  const flushDocs = useEmberStore((state) => state.flushDocs);
  const canvasRegistry = useEmberStore((state) => state.canvasRegistry);
  const flushCanvases = useEmberStore((state) => state.flushCanvases);
  const beginCanvasClosing = useEmberStore((state) => state.beginCanvasClosing);
  const cancelCanvasClosing = useEmberStore((state) => state.cancelCanvasClosing);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [guardError, setGuardError] = useState<string | null>(null);

  useEffect(() => {
    void start();
  }, [start]);

  // 拦截关窗：flush 成功后才能放行；监听注册失败必须持久提示，不能静默。
  useEffect(() => {
    const port = (() => {
      try {
        return createTauriWindowPort();
      } catch {
        // 浏览器预览没有 Tauri 窗口环境，跳过关窗拦截。
        return null;
      }
    })();
    if (port === null) return;

    return installCloseGuard(port, {
      flush: flushDocs,
      canvas: createCanvasCloseHooks(canvasRegistry, {
        flush: (options) => flushCanvases(options),
        beginClosing: beginCanvasClosing,
        cancelClosing: cancelCanvasClosing,
      }),
      // flush 前锁住所有已就绪编辑器：防抖窗口里的新输入不能落到关闭之后。
      editors: { lock: lockAllEditors, resume: resumeAllEditors },
      onFlushError: (message) => setCloseError(`保存未完成，已取消关闭：${message}`),
      onRegisterError: (message) =>
        setGuardError(`关窗自动保存失败，请手动保存（${message}）`),
    });
  }, [
    flushDocs,
    canvasRegistry,
    flushCanvases,
    beginCanvasClosing,
    cancelCanvasClosing,
  ]);

  const content =
    status === 'failed' ? (
      <div className="boot-shell">
        <p className="boot-shell__title">Ember 2.0</p>
        <p className="boot-shell__hint">启动失败 · {lastError?.message ?? '未知错误'}</p>
      </div>
    ) : status === 'ready' && identity ? (
      <>
        <AppShell closeError={closeError} guardError={guardError} />
        <SpatialWorkspaceHost />
      </>
    ) : (
      <div className="boot-shell">
        <p className="boot-shell__title">Ember 2.0</p>
        <p className="boot-shell__hint">正在读取库…</p>
      </div>
    );

  // 关窗 flush 提示已迁入 WindowLayer 的 #toast-layer（由 AppShell 组装 notices 注入）。
  return <>{content}</>;
}
