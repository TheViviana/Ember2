/**
 * 图片大图预览遮罩：点击遮罩或按 Esc 关闭（Esc 由窗口统一处理）。
 */
import { mediaFileName, mediaUrlForPath } from '../../canvas/node-layout.ts';
import styles from '../media-library.module.css';

export interface MediaImagePreviewProps {
  readonly path: string;
  readonly onClose: () => void;
}

export function MediaImagePreview({ path, onClose }: MediaImagePreviewProps) {
  return (
    <div className={styles.previewScrim} role="presentation" onClick={onClose}>
      <img className={styles.previewImg} src={mediaUrlForPath(path)} alt={mediaFileName(path)} />
    </div>
  );
}
