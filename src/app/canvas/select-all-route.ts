/**
 * S3：⌘/Ctrl+A 路由守卫（纯逻辑，可在 node 下测试）。
 *
 * 焦点不在画布 host（例如刚点过顶栏按钮）时，键盘事件不会冒泡到画布，
 * 浏览器会把 ⌘A 当作「全选整页文本」，进而出现整页高亮/白屏。
 * 这里只决定「这条快捷键应该交给画布，还是放行给文本编辑」。
 */

export type SelectAllRoute = 'ignore' | 'canvas';

interface EditableTargetShape {
  readonly tagName?: unknown;
  readonly isContentEditable?: unknown;
  readonly closest?: unknown;
}

/** 文本输入、可编辑区与 CodeMirror 内部都应保留原生 ⌘A。 */
export function isTextEditingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const candidate = target as EditableTargetShape;
  const tag = typeof candidate.tagName === 'string' ? candidate.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  if (candidate.isContentEditable === true) return true;
  return (
    typeof candidate.closest === 'function' &&
    (candidate.closest as (selector: string) => unknown)('.cm-editor') !== null
  );
}

export interface SelectAllInput {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly key: string;
  readonly target: unknown;
}

/** 非文本编辑焦点下的 ⌘/Ctrl+A 交给画布；其余按键一律放行。 */
export function resolveSelectAllRoute(input: SelectAllInput): SelectAllRoute {
  if (!(input.metaKey || input.ctrlKey)) return 'ignore';
  if (input.key.toLowerCase() !== 'a') return 'ignore';
  if (isTextEditingTarget(input.target)) return 'ignore';
  return 'canvas';
}
