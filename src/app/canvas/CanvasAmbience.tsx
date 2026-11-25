/**
 * 画布动态背景栈（Cinematic Ember §2.3 的 L1 / L2 / L5 / L6）。
 *
 * - L1 默认氛围静帧：90s 慢推，窗口失焦/隐藏时暂停；
 * - L2 内容驱动层：恰好选中一个图片节点时，用其媒体图以低透明度交叉淡入，
 *   失选后 1.2s 淡回 L1；不在运行时做 blur 或取色；
 * - 偏好三档：关闭 / 静态 / 动态；系统「减少动态效果」自动降为静态。
 *
 * 只负责氛围层本身：位于画布根容器内、网格与连线之下，不拦截指针。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  readAmbientMotionPreference,
  subscribeAmbientMotionPreference,
} from '../../features/settings/ambient-motion.ts';
import styles from './CanvasView.module.css';

/** 内容驱动层的来源：`key` 用于去重与交叉淡入，`url` 为可直接铺底的媒体地址。 */
export interface AmbientPhotoSource {
  readonly key: string;
  readonly url: string;
}

export interface CanvasAmbienceProps {
  readonly source?: AmbientPhotoSource | null;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return reduced;
}

export function CanvasAmbience({ source = null }: CanvasAmbienceProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const preference = useSyncExternalStore(
    subscribeAmbientMotionPreference,
    readAmbientMotionPreference,
    () => 'dynamic' as const,
  );
  const reduced = usePrefersReducedMotion();
  const mode = preference === 'dynamic' && reduced ? 'static' : preference;
  const photoActive = mode === 'dynamic' && source !== null;
  const [layers, setLayers] = useState<readonly AmbientPhotoSource[]>([]);

  useEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const sync = (): void => {
      root.dataset.paused = document.hidden || !document.hasFocus() ? 'true' : 'false';
    };
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  // 新来源压到栈顶；最多保留两层（旧图等交叉淡入结束后再卸载）。
  useEffect(() => {
    if (!photoActive || source === null) return;
    setLayers((previous) =>
      previous.at(-1)?.key === source.key ? previous : [...previous.slice(-1), source],
    );
  }, [photoActive, source]);

  // 交叉淡入 600ms 后卸载旧层；若期间又切了新图，计时重来，始终最多两层。
  useEffect(() => {
    if (layers.length < 2) return;
    const timer = window.setTimeout(() => setLayers((previous) => previous.slice(-1)), 650);
    return () => window.clearTimeout(timer);
  }, [layers]);

  // 失选、关闭或切静态：整栈 1.2s 淡出，结束再清空。
  useEffect(() => {
    if (photoActive || layers.length === 0) return;
    const timer = window.setTimeout(() => setLayers([]), 1200);
    return () => window.clearTimeout(timer);
  }, [photoActive, layers.length]);

  return (
    <div
      ref={ref}
      className={styles.ambient}
      aria-hidden="true"
      data-paused="false"
      data-mode={mode}
    >
      <div className={styles.ambientWash} />
      <div className={styles.ambientPhotos} data-active={photoActive ? 'true' : 'false'}>
        {layers.map((layer) => (
          <div
            key={layer.key}
            className={styles.ambientPhoto}
            style={{ backgroundImage: `url("${layer.url}")` }}
          />
        ))}
      </div>
      <div className={styles.ambientVignette} />
      <div className={styles.ambientGrain} />
    </div>
  );
}
