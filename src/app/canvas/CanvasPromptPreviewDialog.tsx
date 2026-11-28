/**
 * System Prompt 预览弹窗：分层视图与最终原文，只读。
 */
import { useEffect, useState } from 'react';
import type { AiPromptPreview } from './prompt-preview.ts';
import styles from './CanvasPromptPreviewDialog.module.css';

export interface CanvasPromptPreviewDialogProps {
  readonly preview: AiPromptPreview;
  readonly onClose: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  global: '全局',
  canvas: '画布',
  node: '节点',
};

/** 粗估 token：按字符数除以 2，仅用于量级提示。 */
function estimateTokens(chars: number): number {
  return Math.ceil(chars / 2);
}

export function CanvasPromptPreviewDialog({
  preview,
  onClose,
}: CanvasPromptPreviewDialogProps) {
  const [tab, setTab] = useState<'layers' | 'raw'>('layers');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const copy = (): void => {
    void navigator.clipboard.writeText(preview.system).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {
      // 剪贴板不可用时保持静默，预览内容仍可手动选择复制。
    });
  };

  return (
    <div className={styles.overlay} role="presentation" onClick={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="查看完整 Prompt"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <header className={styles.header}>
          <div>
            <h3 className={styles.title}>完整 System Prompt</h3>
            <p className={styles.meta}>
              {preview.sections.length} 层 · 模型 {preview.model ?? '未选择'} ·{' '}
              {preview.system.length} 字符 · 约 {estimateTokens(preview.system.length)} tokens（按字符粗估）
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <div className={styles.tabs}>
          <button
            type="button"
            className={tab === 'layers' ? styles.tabActive : styles.tab}
            onClick={() => setTab('layers')}
          >
            分层视图
          </button>
          <button
            type="button"
            className={tab === 'raw' ? styles.tabActive : styles.tab}
            onClick={() => setTab('raw')}
          >
            最终原文
          </button>
        </div>

        {tab === 'layers' ? (
          <div className={styles.layers}>
            {preview.sections.length === 0 ? (
              <p className={styles.empty}>当前没有可用的 System Prompt。</p>
            ) : (
              preview.sections.map((section) => (
                <section key={section.source} className={styles.section}>
                  <div className={styles.sectionHeader}>
                    <span className={styles.badge} data-source={section.source}>
                      {SOURCE_LABEL[section.source] ?? section.source}
                    </span>
                    <span className={styles.sectionLabel}>{section.label}</span>
                    <span className={styles.sectionCount}>{section.text.length} 字符</span>
                  </div>
                  <pre className={styles.sectionBody}>{section.text}</pre>
                </section>
              ))
            )}
            {preview.sections.some((section) => section.source === 'node') ? (
              <p className={styles.note}>
                节点层来自 AI 节点指令与相连提示词节点，共 {preview.promptCount} 条。
              </p>
            ) : null}
          </div>
        ) : (
          <pre className={styles.raw}>{preview.system}</pre>
        )}

        <footer className={styles.footer}>
          {preview.docCount === 0 ? (
            <span className={styles.warning}>未连接素材文档，运行前请先连接。</span>
          ) : (
            <span className={styles.note}>已连接 {preview.docCount} 篇素材。</span>
          )}
          {tab === 'raw' ? (
            <button type="button" className={styles.copy} onClick={copy}>
              {copied ? '已复制' : '复制全文'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}