/**
 * CR-R4-5：编辑器覆盖层（纯展示，状态与回调全部经 props 注入）。
 *
 * 冲突横幅、占位/错误横幅、关窗 overlay 插槽与 AI 浮层都收在这里；
 * 选区探测、冲突裁决、AI 调用与文本替换仍留在 EditorView。
 */
import type { ReactNode } from 'react';
import type { EditorConflictChoice, EditorLoadState } from './host.ts';
import { AiSelectionMenu, type AiSelectionCardState } from './AiSelectionMenu.tsx';
import type { AiTextAction } from './ai-text-types.ts';
import type { BacklinksState } from './BacklinksPanel.tsx';
import type { PreviewTranslation } from './MarkdownPreview.tsx';
import { EditorBreadcrumb } from './EditorBreadcrumb.tsx';
import styles from './EditorView.module.css';

export type ExternalKind = 'updated' | 'removed';
export type EditorModeName = 'edit' | 'focus' | 'read';

export interface EditorTopbarProps {
  readonly chromeHidden: boolean;
  readonly focusMode: boolean;
  readonly docPath: string;
  readonly title: string;
  readonly libraryName: string | null;
  readonly translation: PreviewTranslation | null;
  readonly canTranslate: boolean;
  readonly onTranslateSelection: () => void;
  readonly onCancelTranslation?: () => void;
  readonly onDismissTranslation?: () => void;
  readonly onResumeTranslation?: () => void;
  readonly backlinksOpen: boolean;
  readonly backlinks: BacklinksState;
  readonly onToggleBacklinks: () => void;
  readonly mode: EditorModeName;
  readonly onModeChange: (mode: EditorModeName) => void;
  readonly serif: boolean;
  readonly immersive: boolean;
  readonly onToggleSerif: () => void;
  readonly onToggleImmersive?: () => void;
}

/** 顶栏：面包屑、翻译控制、反向链接开关与三态模式钮。 */
export function EditorTopbar({
  chromeHidden,
  focusMode,
  docPath,
  title,
  libraryName,
  translation,
  canTranslate,
  onTranslateSelection,
  onCancelTranslation,
  onDismissTranslation,
  onResumeTranslation,
  backlinksOpen,
  backlinks,
  onToggleBacklinks,
  mode,
  onModeChange,
  serif,
  immersive,
  onToggleSerif,
  onToggleImmersive,
}: EditorTopbarProps) {
  return (
    <header className={styles.topbar}>
      {chromeHidden ? (
        <span className={styles.focusModeLabel}>专注模式</span>
      ) : (
        <EditorBreadcrumb path={docPath} title={title} libraryName={libraryName} />
      )}
      <div className={styles.topbarActions}>
        {chromeHidden || !canTranslate ? null : (
          <>
            <button type="button" className={styles.topbarButton} onClick={onTranslateSelection}>
              翻译
            </button>
            {translation !== null &&
            translation.status === 'streaming' &&
            translation.progress != null &&
            translation.progress.total > 0 ? (
              <span className={styles.translateCounter} aria-live="polite" aria-label="翻译进度">
                {translation.progress.done}/{translation.progress.total}
              </span>
            ) : null}
            {translation !== null &&
            translation.status === 'streaming' &&
            onCancelTranslation !== undefined ? (
              <button type="button" className={styles.topbarButton} onClick={onCancelTranslation}>
                中止
              </button>
            ) : null}
            {translation !== null &&
            translation.status === 'error' &&
            translation.canResume === true &&
            onResumeTranslation !== undefined ? (
              <button type="button" className={styles.topbarButton} onClick={onResumeTranslation}>
                继续翻译
              </button>
            ) : null}
            {translation !== null &&
            (translation.status === 'done' ||
              translation.status === 'error' ||
              translation.status === 'cancelled') &&
            onDismissTranslation !== undefined ? (
              <button type="button" className={styles.topbarButton} onClick={onDismissTranslation}>
                清除译文
              </button>
            ) : null}
          </>
        )}
        {chromeHidden ? null : (
          <button
            type="button"
            className={`${styles.topbarButton} ${backlinksOpen ? styles.topbarButtonActive : ''}`}
            aria-expanded={backlinksOpen}
            onClick={onToggleBacklinks}
          >
            反向链接{backlinks.status === 'ready' ? ` · ${backlinks.items.length}` : ''}
          </button>
        )}
        {/* §10 三态钮与翻译/反向链接同排同样式（topbarButton），CSS 内联不再悬浮右下角。 */}
        <div className={styles.modeToggle} role="group" aria-label="编辑模式">
          <button
            type="button"
            className={`${styles.topbarButton} ${mode === 'edit' ? styles.topbarButtonActive : ''}`}
            aria-pressed={mode === 'edit'}
            title="编辑模式（⌘1）"
            onClick={() => onModeChange('edit')}
          >
            编辑
          </button>
          <button
            type="button"
            className={`${styles.topbarButton} ${focusMode ? styles.topbarButtonActive : ''}`}
            aria-pressed={focusMode}
            title="专注模式（⌘2）"
            onClick={() => onModeChange('focus')}
          >
            专注
          </button>
          <button
            type="button"
            className={`${styles.topbarButton} ${mode === 'read' ? styles.topbarButtonActive : ''}`}
            aria-pressed={mode === 'read'}
            title="阅读模式（⌘3）"
            onClick={() => onModeChange('read')}
          >
            阅读
          </button>
        </div>
        {/* §10 衬线/沉浸随浮窗并入阅读模式（仅阅读态、非专注态显示）。 */}
        {!chromeHidden && mode === 'read' ? (
          <>
            <button
              type="button"
              className={`${styles.topbarButton} ${serif ? styles.topbarButtonActive : ''}`}
              aria-pressed={serif}
              title="衬线阅读"
              onClick={onToggleSerif}
            >
              衬线
            </button>
            <button
              type="button"
              className={`${styles.topbarButton} ${immersive ? styles.topbarButtonActive : ''}`}
              aria-pressed={immersive}
              title="沉浸阅读：画布降低存在感"
              onClick={() => onToggleImmersive?.()}
            >
              沉浸
            </button>
          </>
        ) : null}
      </div>
    </header>
  );
}

export interface EditorConflictBannerProps {
  readonly external: ExternalKind;
  readonly error: string | null;
  readonly resolving: EditorConflictChoice | null;
  readonly onResolve: (choice: EditorConflictChoice) => void;
}

export function EditorConflictBanner({
  external,
  error,
  resolving,
  onResolve,
}: EditorConflictBannerProps) {
  return (
    <section className={styles.banner} role="alert">
      <div className={styles.bannerText}>
        <p className={styles.bannerTitle}>
          {external === 'removed' ? '磁盘上的文件已被删除' : '磁盘内容已被外部修改'}
        </p>
        <p className={styles.bannerHint}>
          {external === 'removed'
            ? '关闭浮窗后本地未保存改动的处理交由关窗流程。'
            : '本地改动尚未写盘，请选择处理方式后继续编辑。'}
        </p>
        {error !== null ? <p className={styles.bannerError}>{error}</p> : null}
      </div>
      <div className={styles.bannerActions}>
        <button
          type="button"
          className={styles.button}
          disabled={resolving !== null}
          onClick={() => onResolve('reload')}
        >
          {external === 'removed'
            ? '接受删除'
            : resolving === 'reload'
              ? '重新加载中…'
              : '重新加载'}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={resolving !== null}
          onClick={() => onResolve('overwrite')}
        >
          {resolving === 'overwrite' ? '保留中…' : '保留本地'}
        </button>
      </div>
    </section>
  );
}

export interface EditorPlaceholderProps {
  readonly loadState: EditorLoadState;
  readonly loadError: string | null;
  readonly onCloseWindow: () => void;
}

/** 载入 / 打开失败 / 外部删除三种占位；错误态带 alert。 */
export function EditorPlaceholder({
  loadState,
  loadError,
  onCloseWindow,
}: EditorPlaceholderProps) {
  return (
    <div className={styles.placeholder} role={loadState === 'error' ? 'alert' : undefined}>
      {loadState === 'error' ? (
        <>
          <span className={styles.placeholderMark} aria-hidden="true" />
          <p className={styles.placeholderTitle}>打开失败</p>
          <p className={styles.placeholderHint}>{loadError ?? '未知错误'}</p>
        </>
      ) : loadState === 'removed' ? (
        <>
          <span className={styles.placeholderMark} aria-hidden="true" />
          <p className={styles.placeholderTitle}>文件已被外部删除</p>
          <p className={styles.placeholderHint}>
            该文档已不在磁盘上，浮窗保留为只读占位；关闭后可重新打开其他文档。
          </p>
          <button
            type="button"
            className={`${styles.button} ${styles.buttonQuiet}`}
            onClick={onCloseWindow}
          >
            关闭窗口
          </button>
        </>
      ) : (
        <>
          <span className={styles.placeholderMark} aria-hidden="true" />
          <p className={styles.placeholderTitle}>正在载入文档…</p>
        </>
      )}
    </div>
  );
}

export interface AiMenuAnchor {
  readonly left: number;
  readonly top: number;
}

export interface EditorAiOverlayProps {
  readonly card: AiSelectionCardState | null;
  readonly menu: AiMenuAnchor | null;
  readonly actions: readonly AiTextAction[];
  readonly onPick: (action: AiTextAction) => void;
  readonly onDiscard: () => void;
  readonly onReplace: () => void;
}

/** AI 动作浮层与结果卡片：位置沿用卡片自身锚点，否则回退到选区锚点。 */
export function EditorAiOverlay({
  card,
  menu,
  actions,
  onPick,
  onDiscard,
  onReplace,
}: EditorAiOverlayProps) {
  if (card === null && menu === null) return null;
  return (
    <AiSelectionMenu
      left={card?.left ?? menu?.left ?? 0}
      top={card?.top ?? menu?.top ?? 0}
      card={card}
      actions={actions}
      onPick={onPick}
      onDiscard={onDiscard}
      onReplace={onReplace}
    />
  );
}

/** 关窗进度 / 失败 / 二次确认面板由 app 层注入，这里只给插槽。 */
export function EditorCloseOverlaySlot({ overlay }: { readonly overlay?: ReactNode }) {
  return overlay ? <div className={styles.overlay}>{overlay}</div> : null;
}
