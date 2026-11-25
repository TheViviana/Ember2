/**
 * CR-20261119-23：T2-A 媒体库浮窗（单例窗口 id「媒体库」，contentType 'media-library'）。
 *
 * app 层窗口组件（A 口径）：经 app-api 收口调用 IPC（app→data 合法，StatusBar/CanvasView 先例）、
 * 复用 src/app/dnd 的指针拖拽通道与 node-layout 的 mediaUrlForPath；纯逻辑在 features/media。
 *
 * P6 重构：窗口只保留列表状态 / 加载 / 删除编排；卡片、播放协调、大图预览、
 * 文档查看器、删除确认框拆到 `./media/`，各自只接收原始 props。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { WindowContentProps } from '../../windows/use-window-manager.ts';
import { mediaApi } from '../../data/app-api.ts';
import {
  countByTab,
  filterByTab,
  MEDIA_TABS,
  sliceVisible,
  type MediaEntry,
  type MediaTab,
} from '../../features/media/media-groups.ts';
import { mapMediaErrorCode } from '../../features/media/media-errors.ts';
import { docViewerFor } from '../../features/media/doc-viewer.ts';
import {
  createDocViewerState,
  docViewerReducer,
} from '../../features/media/doc-viewer-reducer.ts';
import { createMediaListState, mediaListReducer } from '../../features/media/media-list-reducer.ts';
import { MediaCard } from './media/MediaCard.tsx';
import { MediaImagePreview } from './media/MediaImagePreview.tsx';
import { DocViewerOverlay } from './media/DocViewerOverlay.tsx';
import { DeleteConfirmDialog } from './media/DeleteConfirmDialog.tsx';
import { useMediaPlayback } from './media/use-media-playback.ts';
import styles from './media-library.module.css';

const TAB_LABELS: Record<MediaTab, string> = {
  all: '全部',
  image: '图片',
  audio: '音频',
  video: '视频',
  doc: '文档',
};

export function MediaLibraryBody() {
  const [state, dispatch] = useReducer(mediaListReducer, undefined, createMediaListState);
  const liveRef = useRef(true);
  const rootRef = useRef<HTMLElement | null>(null);
  // 缩略图加载失败的本地标记（C2c）：占位展示，不弹错误、不崩。
  const [brokenThumbs, setBrokenThumbs] = useState<ReadonlySet<string>>(() => new Set());
  // 音频/视频元素加载失败标记（CR-24：error 事件判定编码支持，不静默）。
  const [loadErrors, setLoadErrors] = useState<ReadonlySet<string>>(() => new Set());
  // 图片大图预览（CR-24 C1）：仅图片；Esc / 点击遮罩关闭。
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // 文档附件查看器（CR-20261120-27 C2-fix）：状态机外移 features/media（零 React）。
  const [docViewer, dispatchDocViewer] = useReducer(docViewerReducer, undefined, createDocViewerState);

  const busy = state.status === 'loading' || state.status === 'deleting';
  const { pauseAllMedia, handlePlay } = useMediaPlayback(rootRef);

  const markBroken = useCallback((path: string): void => {
    setBrokenThumbs((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  const markLoadError = useCallback((path: string): void => {
    setLoadErrors((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  /** 5s 未 load → 视为无法预览（不静默）；DOC_LOADED/关闭取消计时；token 隔离旧代次。 */
  useEffect(() => {
    if (docViewer.viewer === null || docViewer.loaded) return;
    const token = docViewer.token;
    const timer = window.setTimeout(() => dispatchDocViewer({ type: 'DOC_TIMEOUT', token }), 5000);
    return () => window.clearTimeout(timer);
  }, [docViewer]);

  /** 统一关闭文档查看器：CLOSE_DOC + 暂停播放（Esc/遮罩/切 tab 三处同源）。 */
  const closeDocViewer = useCallback((): void => {
    dispatchDocViewer({ type: 'CLOSE_DOC' });
    pauseAllMedia();
  }, [pauseAllMedia]);

  // Esc 关闭大图预览 / 文档查看器。
  useEffect(() => {
    if (previewPath === null && docViewer.viewer === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      pauseAllMedia();
      setPreviewPath(null);
      dispatchDocViewer({ type: 'CLOSE_DOC' }); // React 卸载 iframe 即释放（C3 教训）
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [previewPath, docViewer.viewer, pauseAllMedia]);

  // 窗口卸载：暂停全部播放元素，并把异步回调标记为失效。
  useEffect(
    () => () => {
      liveRef.current = false;
      pauseAllMedia();
    },
    [pauseAllMedia],
  );

  const handleTabChange = useCallback(
    (tab: MediaTab): void => {
      pauseAllMedia(); // 切 tab 暂停（C3 修正：只 pause，不删 src）
      dispatchDocViewer({ type: 'CLOSE_DOC' }); // 切 tab 关闭文档查看器（C2-fix 第三处）
      dispatch({ type: 'TAB_CHANGE', tab });
    },
    [pauseAllMedia],
  );

  // 挂载即发起首次加载；DELETE_OK / 重试后的 loading 态统一在此发请求。
  useEffect(() => {
    dispatch({ type: 'LOAD_START' });
  }, []);

  useEffect(() => {
    if (state.status !== 'loading') return;
    let live = true;
    void mediaApi.list()
      .then((entries) => {
        if (live) dispatch({ type: 'LOAD_OK', entries });
      })
      .catch((e: unknown) => {
        if (!live) {
          console.error('[MediaLibraryWindow] media_list 失败（窗口已关闭）', e);
          return;
        }
        const err = e as { code?: string; message: string };
        dispatch({ type: 'LOAD_ERR', code: err.code, message: err.message });
      });
    return () => {
      live = false;
    };
  }, [state.status]);

  const handleDeleteConfirm = useCallback((): void => {
    const path = state.pendingPath;
    if (path === null) return;
    dispatch({ type: 'DELETE_START' });
    void mediaApi.remove(path)
      .then((result) => {
        dispatch({ type: 'DELETE_OK', via: result.via });
      })
      .catch((e: unknown) => {
        if (!liveRef.current) {
          console.error('[MediaLibraryWindow] media_delete 失败（窗口已关闭）', e);
          return;
        }
        const err = e as { code?: string; message: string };
        dispatch({ type: 'DELETE_ERR', code: err.code, message: err.message });
      });
  }, [state.pendingPath]);

  /** 图片走大图预览；PDF/HTML 走只读查看器；音视频点击文件名不额外动作。 */
  const handleOpen = useCallback((item: MediaEntry): void => {
    if (item.kind === 'image') {
      setPreviewPath(item.path);
      return;
    }
    const viewer = docViewerFor(item.path);
    if (viewer === null) return;
    dispatchDocViewer({ type: 'OPEN_DOC', path: item.path, kind: viewer.kind });
  }, []);

  const handleRequestDelete = useCallback((path: string): void => {
    dispatch({ type: 'CONFIRM_OPEN', path });
  }, []);

  // 确认框在 confirming 与 deleting 两个态都保持显示（删除中按钮禁用）。
  const showConfirm =
    (state.status === 'confirming' || state.status === 'deleting') && state.pendingPath !== null;
  const counts = countByTab(state.entries);
  const filtered = filterByTab(state.entries, state.tab);
  const visible = sliceVisible(filtered, state.visibleCount);
  const hasMore = state.visibleCount < filtered.length;

  return (
    <section className={styles.window} aria-label="媒体库" aria-busy={busy} ref={rootRef}>
      <div className={styles.tabs} role="tablist" aria-label="媒体类型">
        {MEDIA_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={state.tab === tab}
            className={state.tab === tab ? `${styles.tabBtn} ${styles.tabActive}` : styles.tabBtn}
            disabled={busy}
            onClick={() => handleTabChange(tab)}
          >
            {TAB_LABELS[tab]}（{counts[tab]}）
          </button>
        ))}
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => {
            pauseAllMedia();
            dispatch({ type: 'LOAD_START' });
          }}
          disabled={busy}
        >
          刷新
        </button>
      </div>

      {state.lastDeleteVia !== null ? (
        <p className={styles.viaLine} role="status">
          {state.lastDeleteVia === 'system' ? '已移入系统回收站' : '已移入库内回收站'}
        </p>
      ) : null}

      {state.error !== null ? (
        <p className={styles.errorBar} role="alert">
          {(() => {
            const mapped = mapMediaErrorCode(state.error.code, state.error.message);
            return (
              <>
                {mapped.text}
                {mapped.detail !== null ? (
                  <span className={styles.errorDetail}>（{mapped.detail}）</span>
                ) : null}
              </>
            );
          })()}
          <button
            type="button"
            className={styles.errorRetry}
            onClick={() => dispatch({ type: 'LOAD_START' })}
          >
            重新加载
          </button>
        </p>
      ) : null}

      {state.entries.length === 0 && state.status === 'ready' ? (
        <p className={styles.hint}>
          {state.tab === 'doc' ? '库里还没有文档附件' : '库内还没有媒体文件'}
        </p>
      ) : null}
      {state.entries.length === 0 && state.status === 'loading' ? (
        <p className={styles.hint}>正在加载媒体列表…</p>
      ) : null}

      <ul className={styles.list}>
        {visible.map((item) => (
          <li key={item.path} className={styles.item}>
            <MediaCard
              item={item}
              busy={busy}
              thumbBroken={brokenThumbs.has(item.path)}
              loadError={loadErrors.has(item.path)}
              onThumbBroken={markBroken}
              onLoadError={markLoadError}
              onPlay={handlePlay}
              onOpen={handleOpen}
              onRequestDelete={handleRequestDelete}
            />
          </li>
        ))}
      </ul>

      {hasMore ? (
        <button
          type="button"
          className={styles.moreBtn}
          onClick={() => dispatch({ type: 'SHOW_MORE' })}
          disabled={busy}
        >
          加载更多（已显示 {visible.length} / {filtered.length}）
        </button>
      ) : null}

      {previewPath !== null ? (
        <MediaImagePreview
          path={previewPath}
          onClose={() => {
            pauseAllMedia();
            setPreviewPath(null);
          }}
        />
      ) : null}

      {docViewer.viewer !== null ? (
        <DocViewerOverlay
          viewer={docViewer.viewer}
          token={docViewer.token}
          failed={docViewer.failed}
          onLoaded={() => dispatchDocViewer({ type: 'DOC_LOADED', token: docViewer.token })}
          onTimeout={() => dispatchDocViewer({ type: 'DOC_TIMEOUT', token: docViewer.token })}
          onClose={closeDocViewer}
        />
      ) : null}

      {showConfirm && state.pendingPath !== null ? (
        <DeleteConfirmDialog
          path={state.pendingPath}
          deleting={state.status === 'deleting'}
          onCancel={() => dispatch({ type: 'CONFIRM_CANCEL' })}
          onConfirm={handleDeleteConfirm}
        />
      ) : null}
    </section>
  );
}

/** 浮窗包装：单例窗口不消费窗口记录（id/contentType 固定）。 */
export function MediaLibraryWindow(_props: WindowContentProps) {
  return <MediaLibraryBody />;
}
