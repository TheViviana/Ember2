/**
 * 媒体库单张卡片：缩略图 / 文件名 / 播放器 / 删除入口 + 指针拖拽会话。
 *
 * 拖拽与 TreeRow 共用 `dnd/pointer-drag` 通道；载荷只带 `{ kind: 'media', path }`，
 * 媒体类型由画布落点按 `media/` 前缀判定，卡片不再把列表项塞进闭包。
 * 拖拽结束（无论是否落到画布）抑制一次 click，避免误开预览。
 */
import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from 'react';
import {
  beginPointerDragSession,
  dispatchPointerDragDrop,
  droppedPointerDrag,
  movePointerDragSession,
  type PointerDragSession,
} from '../../dnd/pointer-drag.ts';
import { mediaFileName, mediaUrlForPath } from '../../canvas/node-layout.ts';
import { MEDIA_CONTROL_STRIP_PX } from '../../canvas/consts.ts';
import { formatBytes, formatTime } from '../../../features/media/media-format.ts';
import { mediaLoadErrorMessage } from '../../../features/media/media-playback.ts';
import type { MediaEntry } from '../../../features/media/media-groups.ts';
import styles from '../media-library.module.css';

export interface MediaCardProps {
  readonly item: MediaEntry;
  readonly busy: boolean;
  readonly thumbBroken: boolean;
  readonly loadError: boolean;
  readonly onThumbBroken: (path: string) => void;
  readonly onLoadError: (path: string) => void;
  readonly onPlay: (event: SyntheticEvent<HTMLMediaElement>) => void;
  readonly onOpen: (item: MediaEntry) => void;
  readonly onRequestDelete: (path: string) => void;
}

/** 只抑制本次手势后紧随的那一次 click，避免遗留标记吞掉后续键盘激活。 */
function suppressNextClick(flag: { current: boolean }): void {
  flag.current = true;
  window.setTimeout(() => {
    flag.current = false;
  }, 0);
}

function kindIcon(kind: MediaEntry['kind']): string {
  switch (kind) {
    case 'image':
      return '🖼';
    case 'audio':
      return '♪';
    case 'doc':
      return '▤';
    default:
      return '▶';
  }
}

export const MediaCard = memo(function MediaCard({
  item,
  busy,
  thumbBroken,
  loadError,
  onThumbBroken,
  onLoadError,
  onPlay,
  onOpen,
  onRequestDelete,
}: MediaCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<PointerDragSession | null>(null);
  const suppressClickRef = useRef(false);
  const openOnReleaseRef = useRef(false);
  const [ghost, setGhost] = useState<{ readonly x: number; readonly y: number } | null>(null);

  // Esc 取消拖拽；只在出现 ghost 时挂监听，卸载即移除。
  useEffect(() => {
    if (ghost === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      const session = sessionRef.current;
      sessionRef.current = null;
      suppressNextClick(suppressClickRef);
      setGhost(null);
      const card = cardRef.current;
      if (card !== null && session !== null && card.hasPointerCapture(session.pointerId)) {
        card.releasePointerCapture(session.pointerId);
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [ghost]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (busy || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    // 视频只在底部原生控制条区域吃掉手势；画面区域仍可作拖拽手柄搬到画布。
    const mediaElement = target?.closest('audio, video') ?? null;
    if (mediaElement !== null) {
      if (item.kind === 'audio') return;
      const rect = mediaElement.getBoundingClientRect();
      const hasRect = rect.width > 0 || rect.height > 0;
      if (!hasRect || event.clientY >= rect.bottom - MEDIA_CONTROL_STRIP_PX) return;
    }
    if (target?.closest('[data-role="delete"]') !== null) {
      return; // 删除按钮吃掉手势，不启动会话
    }
    suppressClickRef.current = false; // 清掉上一次拖拽遗留的抑制标记
    openOnReleaseRef.current = target !== null && target.closest('[data-role="open"]') !== null;
    sessionRef.current = beginPointerDragSession(
      { kind: 'media', path: item.path },
      event.pointerId,
      { x: event.clientX, y: event.clientY },
    );
    // 立即捕获：快速拖拽时首帧 move 就可能落在卡片外，不捕获会丢掉阈值判定与 up。
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = sessionRef.current;
    if (session === null) return;
    const next = movePointerDragSession(session, event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (next === null) return;
    sessionRef.current = next;
    if (next.phase !== 'dragging') return;
    setGhost({ x: next.current.x, y: next.current.y });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const session = sessionRef.current;
    if (session === null) return;
    const payload = droppedPointerDrag(session, event.pointerId);
    const shouldOpen = openOnReleaseRef.current;
    sessionRef.current = null;
    openOnReleaseRef.current = false;
    setGhost(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (payload === null) {
      // 未过阈值 = 普通点击。capture 会把 click 改派到卡片，故这里手动判定是否打开。
      if (!shouldOpen) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const card = cardRef.current;
      if (
        target === null ||
        card === null ||
        !card.contains(target) ||
        target.closest('audio, video, [data-role="delete"]') !== null
      ) {
        return;
      }
      suppressNextClick(suppressClickRef); // 若浏览器仍把 click 派给按钮，只打开一次
      onOpen(item);
      return;
    }
    suppressNextClick(suppressClickRef); // 拖拽结束后的 click 不再打开预览
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target === null || target.closest('[data-canvas-drop-host]') === null) return;
    dispatchPointerDragDrop({ payload, clientX: event.clientX, clientY: event.clientY });
  }

  function handlePointerCancel(): void {
    sessionRef.current = null;
    openOnReleaseRef.current = false;
    suppressClickRef.current = false;
    setGhost(null);
  }

  function handleOpen(): void {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpen(item);
  }

  const title =
    item.kind === 'image'
      ? '点击查看大图'
      : item.kind === 'doc'
        ? '点击预览（只读）'
        : mediaFileName(item.path);

  return (
    <div
      ref={cardRef}
      className={styles.card}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div className={styles.thumb}>
        {item.kind === 'image' && !thumbBroken ? (
          <img
            className={styles.thumbImg}
            src={mediaUrlForPath(item.path)}
            alt={mediaFileName(item.path)}
            loading="lazy"
            draggable={false}
            onError={() => onThumbBroken(item.path)}
          />
        ) : (
          <span
            className={styles.kindIcon}
            aria-hidden="true"
            title={item.kind === 'image' && thumbBroken ? '缩略图加载失败' : undefined}
          >
            {kindIcon(item.kind)}
          </span>
        )}
      </div>

      <div className={styles.meta}>
        <button
          type="button"
          className={styles.nameBtn}
          data-role="open"
          title={title}
          onClick={handleOpen}
        >
          {mediaFileName(item.path)}
        </button>
        <p className={styles.sub}>
          {formatBytes(item.bytes)} · {formatTime(item.modifiedMs)}
        </p>
      </div>

      {item.kind === 'audio' || item.kind === 'video' ? (
        loadError ? (
          <span className={styles.playbackUnsupported}>{mediaLoadErrorMessage(4)}</span>
        ) : item.kind === 'audio' ? (
          <audio
            className={styles.playerFull}
            controls
            preload="metadata"
            src={mediaUrlForPath(item.path)}
            draggable={false}
            onPlay={onPlay}
            onError={() => onLoadError(item.path)}
          />
        ) : (
          <video
            className={styles.playerFull}
            controls
            preload="metadata"
            src={mediaUrlForPath(item.path)}
            draggable={false}
            onPlay={onPlay}
            onError={() => onLoadError(item.path)}
          />
        )
      ) : null}

      <button
        type="button"
        className={styles.deleteBtn}
        disabled={busy}
        data-role="delete"
        onClick={() => onRequestDelete(item.path)}
      >
        删除
      </button>

      {ghost === null ? null : (
        <span
          className={styles.dragGhost}
          style={{ left: ghost.x, top: ghost.y }}
          aria-hidden="true"
        >
          {mediaFileName(item.path)}
        </span>
      )}
    </div>
  );
});
