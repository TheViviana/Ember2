/**
 * 选中集合 → 内容驱动背景来源。
 *
 * 只接受「恰好一个图片媒体节点」；文档/音频/视频暂无封面数据，回落到 L1。
 */
import type { CanvasEngine } from './engine.ts';
import type { AmbientPhotoSource } from './CanvasAmbience.tsx';
import { mediaUrlForPath } from '../../core/media-url.ts';

export function resolveAmbientSource(
  engine: CanvasEngine,
  nodes: ReadonlySet<string>,
): AmbientPhotoSource | null {
  if (nodes.size !== 1) return null;
  const id = [...nodes][0];
  const media = engine.getNodeViews().find((node) => node.id === id)?.media;
  if (media?.kind !== 'image') return null;
  return { key: `${id}:${media.path}`, url: mediaUrlForPath(media.path) };
}

/**
 * 轻量监听选中变化：引擎不派发 selection 事件，这里用 200ms 轮询比较 id 签名，
 * 只在集合真正变化时重建来源；选中/取消后最迟 200ms 触发 600ms 交叉淡入。
 */
export function watchAmbientSource(
  engine: CanvasEngine,
  onChange: (source: AmbientPhotoSource | null) => void,
): () => void {
  let signature: string | null = null;
  const tick = (): void => {
    if (document.hidden) return;
    const { nodes } = engine.getSelection();
    const next = [...nodes].sort().join('\u0000');
    if (next === signature) return;
    signature = next;
    onChange(resolveAmbientSource(engine, nodes));
  };
  tick();
  const timer = window.setInterval(tick, 200);
  return () => window.clearInterval(timer);
}
