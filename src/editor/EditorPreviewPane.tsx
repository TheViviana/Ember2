/**
 * CR-R4-5：阅读模式的预览装配（MarkdownPreview + 译文块）。
 *
 * KaTeX 与 Markdown 解析按需加载，避免进首屏主包；CodeMirror 装配仍留在 EditorView。
 */
import { lazy, Suspense } from 'react';
import type { PreviewTranslation } from './MarkdownPreview.tsx';
import styles from './EditorView.module.css';

const MarkdownPreview = lazy(() =>
  import('./MarkdownPreview.tsx').then((module) => ({ default: module.MarkdownPreview })),
);

export interface EditorPreviewPaneProps {
  readonly text: string;
  readonly docPath: string;
  readonly onOpenInternalLink?: (path: string) => void;
  readonly translation: PreviewTranslation | null;
  readonly serif: boolean;
}

export function EditorPreviewPane({
  text,
  docPath,
  onOpenInternalLink,
  translation,
  serif,
}: EditorPreviewPaneProps) {
  return (
    <div className={serif ? styles.readSerif : undefined}>
      <Suspense fallback={null}>
        <MarkdownPreview
          text={text}
          docPath={docPath}
          onOpenInternalLink={onOpenInternalLink}
          translation={translation}
          articleSerif={serif}
        />
      </Suspense>
    </div>
  );
}
