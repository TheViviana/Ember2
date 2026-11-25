/**
 * 状态栏：内核状态、文档统计与当前文档信息（CR-20261120-35 右侧检查器下沉）。
 * 无边框、与画布同底色；库名只读展示，库管理入口移到设置。
 */
import type { ReactNode } from 'react';
import type { CoreStatus } from '../../core/core';
import { posixBaseName } from '../../core/path-utils.ts';
import { countUnsaved } from '../../editor/save-phases.ts';
import { useEmberStore } from '../stores/ember-store';
import { useTreeStore } from '../stores/tree-store';
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

function phaseClass(phase: SavePhase): string {
  if (phase === 'clean') return styles.phaseClean ?? '';
  if (phase === 'dirty') return styles.phaseDirty ?? '';
  if (phase === 'saving') return styles.phaseSaving ?? '';
  return styles.phaseError ?? '';
}

export function StatusBar(): ReactNode {
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

  return (
    <footer className={styles.statusbar} aria-label="状态栏">
      <span className={`${styles.status} ${toneClass(status)}`} role="status">
        <span className={styles.dot} aria-hidden="true" />
        {STATUS_LABEL[status]}
        {readonly ? <span className={styles.readonly}>只读模式</span> : null}
      </span>
      <span className={styles.meta}>
        <span className="tabular-nums">{docCount} 篇文档</span>
        {unsavedCount > 0 ? (
          <>
            <span className={styles.separator} aria-hidden="true" />
            <span className={`${styles.unsaved} tabular-nums`} role="status">
              {unsavedCount} 篇未落盘
            </span>
          </>
        ) : null}
      </span>

      <span className={styles.document} aria-label="当前文档信息">
        {activePath === null ? (
          <span className={styles.docEmpty}>未选择文档</span>
        ) : (
          <>
            <span className={styles.docPath} title={activePath}>{posixBaseName(activePath)}</span>
            <span className={styles.separator} aria-hidden="true" />
            <span className="tabular-nums">
              {characters === null ? '—' : characters.toLocaleString('zh-CN')} 字
            </span>
            <span className={styles.separator} aria-hidden="true" />
            <span className="tabular-nums">
              {meta === null ? '—' : formatModified(meta.modifiedMs)}
            </span>
            <span className={styles.separator} aria-hidden="true" />
            {phase === null ? (
              <span className={styles.docEmpty}>—</span>
            ) : (
              <span
                className={`${styles.phase} ${phaseClass(phase)}`}
                title={doc?.error?.message ?? undefined}
              >
                <span className={styles.phaseDot} aria-hidden="true" />
                {saveLabel(phase)}
              </span>
            )}
          </>
        )}
      </span>

      <span className={styles.root} title={root}>{root}</span>
    </footer>
  );
}
