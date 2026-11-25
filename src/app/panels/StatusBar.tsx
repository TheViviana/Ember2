/**
 * 状态栏（§8.3）：三段式——左=保存/同步状态，中=当前文档路径，右=节点数/缩放。
 * 无边框、与画布同底色；库名只读展示，库管理入口在设置。
 * 只有缩放可点击；其余保持静态，避免整条像按钮。
 */
import type { ReactNode } from 'react';
import type { CoreStatus } from '../../core/core';
import { posixBaseName } from '../../core/path-utils.ts';
import { countUnsaved } from '../../editor/save-phases.ts';
import { useEmberStore } from '../stores/ember-store';
import { useTreeStore } from '../stores/tree-store';
import type { CanvasStats } from '../shell/use-canvas-stats.ts';
import {
  countCharacters,
  formatModified,
  saveLabel,
  savePhase,
  type SavePhase,
} from './inspector-model';
import styles from './StatusBar.module.css';

const STATUS_LABEL: Record<CoreStatus, string> = {
  idle: '等待启动',
  starting: '正在读取库',
  ready: '库已就绪',
  failed: '启动失败',
  disposed: '内核已关闭',
};

function toneClass(status: CoreStatus): string {
  if (status === 'ready') return styles.toneSuccess ?? '';
  if (status === 'failed') return styles.toneDanger ?? '';
  return styles.toneMuted ?? '';
}

/** 已保存绿点、保存中/未落盘琥珀、失败红点。 */
function phaseTone(phase: SavePhase): string {
  if (phase === 'clean') return styles.toneSuccess ?? '';
  if (phase === 'error') return styles.toneDanger ?? '';
  return styles.toneWarning ?? '';
}

export interface StatusBarProps {
  /** 画布模式的节点/连线/缩放；非画布或引擎未就绪时为 null。 */
  readonly canvasStats?: CanvasStats | null;
  readonly onResetZoom?: () => void;
}

export function StatusBar({ canvasStats = null, onResetZoom }: StatusBarProps): ReactNode {
  const status = useEmberStore((s) => s.status);
  const docCount = useEmberStore((s) => s.index.docs.size);
  const unsavedCount = useEmberStore((s) => countUnsaved(s.docs.values()));
  const root = useEmberStore((s) => s.identity?.root ?? '');
  const readonly = useEmberStore((s) => s.identity?.readonly ?? false);
  const activePath = useTreeStore((s) => s.activePath);
  const doc = useEmberStore((s) =>
    activePath === null ? null : (s.docs.get(activePath) ?? null),
  );
  const meta = useEmberStore((s) =>
    activePath === null ? null : (s.index.docs.get(activePath) ?? null),
  );

  const phase = savePhase(doc);
  const characters = doc === null ? null : countCharacters(doc.text);
  const rootName = root === '' ? '' : posixBaseName(root);
  const hasPhase = activePath !== null && phase !== null;

  return (
    <footer className={styles.statusbar} aria-label="状态栏">
      <span
        className={`${styles.status} ${hasPhase ? phaseTone(phase) : toneClass(status)}`}
        role="status"
      >
        <span className={styles.dot} aria-hidden="true" />
        {hasPhase ? `${saveLabel(phase)} · 本地` : STATUS_LABEL[status]}
        {readonly ? <span className={styles.readonly}>只读</span> : null}
        {unsavedCount > 0 ? (
          <span className={styles.unsaved}>{unsavedCount} 篇未落盘</span>
        ) : null}
      </span>

      <span className={styles.document} aria-label="当前文档路径">
        {activePath === null ? (
          <span className={styles.docEmpty}>未选择文档</span>
        ) : (
          <>
            <span className={styles.docPath} title={root === '' ? activePath : `${root} / ${activePath}`}>
              {rootName === '' ? activePath : `${rootName} / ${activePath}`}
            </span>
            <span className={styles.separator} aria-hidden="true" />
            <span className={styles.numeric}>
              {characters === null ? '—' : characters.toLocaleString('zh-CN')} 字
            </span>
            <span className={styles.separator} aria-hidden="true" />
            <span className={styles.numeric}>
              {meta === null ? '—' : formatModified(meta.modifiedMs)}
            </span>
          </>
        )}
      </span>

      <span className={styles.stats}>
        {canvasStats === null ? (
          <span className={styles.numeric}>{docCount} 篇文档</span>
        ) : (
          <>
            <span className={styles.numeric}>{canvasStats.nodes} 节点</span>
            <span className={styles.separator} aria-hidden="true" />
            <span className={styles.numeric}>{canvasStats.edges} 连线</span>
            <span className={styles.separator} aria-hidden="true" />
            <button
              type="button"
              className={styles.zoom}
              title="点击回到 100%"
              aria-label={`当前缩放 ${canvasStats.zoomPercent}%，点击回到 100%`}
              onClick={onResetZoom}
            >
              {canvasStats.zoomPercent}%
            </button>
          </>
        )}
      </span>
    </footer>
  );
}
