/**
 * 空间工作区宿主：实验开关打开后才会挂载的全屏覆盖层。
 *
 * 主应用对 3D 的全部了解止于本文件；场景始终通过动态 import 进入独立 chunk。
 * 能力检测、错误边界与返回标准视图都在这一层收口。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { detectSpatialCapability, type SpatialCapability } from './capability.ts';
import { readSpatialEnabled } from './flag.ts';
import { SpatialErrorBoundary } from './SpatialErrorBoundary.tsx';
import { useSpatialStore } from './spatial-store.ts';
import styles from './spatial.module.css';

// M2 按 M0 结论替换为路线 A（uikit）或路线 B（CSS3D）渲染层；M1 只验证分包边界。
const LazyScene = lazy(() => import('./SpatialScene.tsx'));

export function SpatialWorkspaceHost() {
  const open = useSpatialStore((state) => state.open);
  const close = useSpatialStore((state) => state.closeWorkspace);
  const [capability, setCapability] = useState<SpatialCapability | null>(null);

  // 开关被关掉时立即退出，避免留下一个无法从设置页再次关闭的覆盖层。
  useEffect(() => {
    if (!open) return;
    if (!readSpatialEnabled(window.localStorage)) close();
  }, [open, close]);

  useEffect(() => {
    if (!open) {
      setCapability(null);
      return;
    }
    setCapability(detectSpatialCapability());
  }, [open]);

  // 覆盖层自己处理 Esc；AppShell 的全局快捷键在打开期间整体让路。
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, close]);

  if (!open) return null;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="空间工作区">
      <header className={styles.header}>
        <div className={styles.headerText}>
          <p className={styles.title}>空间工作区</p>
          <p className={styles.subtitle}>实验性功能 · 布局不会保存，重新打开会重置</p>
        </div>
        <button type="button" className={styles.closeButton} onClick={close}>
          返回标准视图
        </button>
      </header>

      <div className={styles.stage}>
        {/* 若 M0 选纯 CSS3D（无需 WebGL），M2 把这里从硬拦截改为仅提示。 */}
        {capability === null ? (
          <p className={styles.status}>正在检测 3D 能力…</p>
        ) : capability.webgl2 === false ? (
          <div className={styles.fallback} role="alert">
            <p className={styles.fallbackTitle}>当前环境不支持 3D 渲染</p>
            <p className={styles.fallbackHint}>
              未检测到 WebGL2，空间工作区暂不可用。可返回标准视图继续工作。
            </p>
            <button type="button" className={styles.returnButton} onClick={close}>
              返回标准视图
            </button>
          </div>
        ) : (
          <SpatialErrorBoundary onReturn={close}>
            {capability.software ? (
              <p className={styles.warning}>
                检测到软件渲染（{capability.renderer ?? '未知渲染器'}），帧率可能较低。
              </p>
            ) : null}
            <Suspense fallback={<p className={styles.status}>正在加载空间视图…</p>}>
              <LazyScene />
            </Suspense>
          </SpatialErrorBoundary>
        )}
      </div>
    </div>
  );
}