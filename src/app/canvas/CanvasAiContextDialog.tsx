/**
 * 画布级 AI 背景编辑弹窗：多行输入，保存写入 updateCanvasMeta 命令。
 * 独立组件，避免 CanvasView 继续膨胀。
 */
import { useState } from 'react';
import styles from './CanvasView.module.css';

export interface CanvasAiContextDialogProps {
  readonly value: string;
  readonly readOnly: boolean;
  readonly onSave: (value: string) => void;
  readonly onCancel: () => void;
}

export function CanvasAiContextDialog({
  value,
  readOnly,
  onSave,
  onCancel,
}: CanvasAiContextDialogProps) {
  const [draft, setDraft] = useState(value);

  return (
    <div className={styles.aiContextOverlay} role="presentation">
      <div
        className={styles.aiContextPanel}
        role="dialog"
        aria-modal="true"
        aria-label="画布 AI 背景"
      >
        <h3 className={styles.aiContextTitle}>画布 AI 背景</h3>
        <p className={styles.aiContextHint}>
          此背景将与全局系统提示词、节点指令自动拼接，仅作用于当前画布。
        </p>
        <textarea
          autoFocus
          className={styles.aiContextTextarea}
          aria-label="画布 AI 背景内容"
          placeholder="例如：这是一个产品需求评审画布，请围绕需求完整性回答。"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={readOnly}
          rows={7}
        />
        <div className={styles.aiContextActions}>
          <button
            type="button"
            className={styles.aiContextGhost}
            onClick={() => setDraft('')}
            disabled={readOnly || draft === ''}
          >
            清空
          </button>
          <span className={styles.aiContextSpacer} />
          <button type="button" className={styles.aiContextGhost} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={styles.aiContextPrimary}
            onClick={() => onSave(draft)}
            disabled={readOnly}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}