/**
 * CR-20261120-27：文档附件只读查看器映射（纯函数，零 React / 零 IPC）。
 *
 * PDF → 原生渲染（iframe，PDFKit）；HTML → 沙箱 iframe（配合协议层 nosniff +
 * sandbox CSP 双保险，无脚本）。其它扩展名 / 无扩展名 → null（不预览）。
 */

export type DocViewerKind = 'pdf' | 'html';

export interface DocViewerTarget {
  readonly kind: DocViewerKind;
}

/** 扩展名判定（大小写不敏感）；pdf → pdf，html/htm → html，其它 → null。 */
export function docViewerFor(path: string): DocViewerTarget | null {
  const normalized = path.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  if (extension === 'pdf') return { kind: 'pdf' };
  if (extension === 'html' || extension === 'htm') return { kind: 'html' };
  return null;
}
