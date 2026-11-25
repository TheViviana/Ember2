/**
 * PDF / HTML 文档附件只读预览。
 *
 * iframe 只在 viewer 非空时挂载；关闭即卸载（不手写 removeAttribute——C3 教训）。
 * HTML 一律 `sandbox=""` 且不带 referrer；PDF 保留原生阅读器能力。
 */
import { mediaFileName, mediaUrlForPath } from '../../canvas/node-layout.ts';
import type { DocViewerTarget } from '../../../features/media/doc-viewer-reducer.ts';
import styles from '../media-library.module.css';

export interface DocViewerOverlayProps {
  readonly viewer: DocViewerTarget;
  readonly token: number;
  readonly failed: boolean;
  readonly onLoaded: () => void;
  readonly onTimeout: () => void;
  readonly onClose: () => void;
}

export function DocViewerOverlay({
  viewer,
  token,
  failed,
  onLoaded,
  onTimeout,
  onClose,
}: DocViewerOverlayProps) {
  const label = `只读预览：${mediaFileName(viewer.path)}`;
  return (
    <div className={styles.previewScrim} role="presentation" onClick={onClose}>
      <div
        className={styles.docViewerBox}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        {failed ? (
          <p className={styles.docViewerFailed}>
            无法预览，可尝试在系统中打开：
            <br />
            <span className={styles.errorDetail}>{viewer.path}</span>
          </p>
        ) : viewer.kind === 'pdf' ? (
          <iframe
            key={`${viewer.path}:${token}`}
            className={styles.docViewerFrame}
            src={mediaUrlForPath(viewer.path)}
            title={label}
            onLoad={onLoaded}
            onError={onTimeout}
          />
        ) : (
          <iframe
            key={`${viewer.path}:${token}`}
            className={styles.docViewerFrame}
            src={mediaUrlForPath(viewer.path)}
            sandbox=""
            referrerPolicy="no-referrer"
            title={label}
            onLoad={onLoaded}
            onError={onTimeout}
          />
        )}
      </div>
    </div>
  );
}
