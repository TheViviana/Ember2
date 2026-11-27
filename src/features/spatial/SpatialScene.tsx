/**
 * M1 占位场景：验证动态 import、状态层与覆盖层挂载。
 *
 * 这里不做 3D 渲染，也不做拖拽/缩放；M2 按 M0 结论替换为路线 A（uikit）
 * 或路线 B（CSS3D）。占位面板只读取状态层，保持「状态层 → 渲染层」单向依赖。
 */
import { useSpatialStore } from './spatial-store.ts';
import type { SpatialContentType } from './window-state.ts';
import styles from './spatial.module.css';

function MarkdownPanelPlaceholder() {
  return (
    <div className={styles.panelBody}>
      <p className={styles.panelEyebrow}>只读预览</p>
      <p className={styles.panelTitle}>空间工作区设计笔记</p>
      <p className={styles.panelText}>
        这是 Markdown 只读占位内容。M2 接入真实文档后，这里会按阅读模式渲染当前文章。
      </p>
      <p className={styles.panelText}>M1 不读取任何文件，也不写入 Markdown 知识库。</p>
    </div>
  );
}

function AiSummaryPanelPlaceholder() {
  return (
    <div className={styles.panelBody}>
      <p className={styles.panelEyebrow}>AI 对话摘要</p>
      <div className={styles.bubble}>
        <span className={styles.bubbleRole}>用户</span>
        <span>把当前文章的结构整理成三点。</span>
      </div>
      <div className={styles.bubble}>
        <span className={styles.bubbleRole}>AI</span>
        <span>占位摘要：M2 接入真实对话数据后，这里显示简化后的回答。</span>
      </div>
    </div>
  );
}

function PanelPlaceholder({ contentType }: { readonly contentType: SpatialContentType }) {
  return contentType === 'markdown' ? <MarkdownPanelPlaceholder /> : <AiSummaryPanelPlaceholder />;
}

export default function SpatialScene() {
  const windows = useSpatialStore((state) => state.windows);

  return (
    <div className={styles.placeholder}>
      <p className={styles.placeholderHint}>
        M1 隔离骨架：两个占位面板由 windows 状态数组渲染，拖拽与缩放留到 M2。
      </p>
      <ul className={styles.windowList}>
        {windows.map((item) => (
          <li key={item.id} className={styles.windowCard}>
            <header className={styles.windowHeader}>
              <span className={styles.windowTitle}>{item.title}</span>
              <span className={styles.windowMeta}>z{item.zIndex}</span>
            </header>
            <PanelPlaceholder contentType={item.contentType} />
          </li>
        ))}
      </ul>
    </div>
  );
}