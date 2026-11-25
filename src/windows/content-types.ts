/**
 * 窗口内容类型常量与联合类型。
 *
 * 仅收敛「窗口内容类型」语义的字面量；DnD 落点 id 中的 'editor'
 * 属于拖拽落点语义，与这里不是同一概念，不在此列。
 */
export const EDITOR_WINDOW_CONTENT = 'editor';

export const MEDIA_LIBRARY_WINDOW_CONTENT = 'media-library';

export type WindowContentType = 'editor' | 'media-library';
