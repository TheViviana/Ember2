/**
 * 目录树的纯 UI 状态：展开集合、当前高亮文档、打开失败提示。
 * 不进入 EmberCore；core 只负责索引与文档内容。
 */
import { create } from 'zustand';

export interface TreeUiState {
  readonly expanded: ReadonlySet<string>;
  readonly activePath: string | null;
  readonly openError: string | null;
  /** CR-20261121-57：右键新建、尚无文件的目录（扫描不含空目录，前端兜底展示）。 */
  readonly pendingDirs: ReadonlySet<string>;
  /** CR-20261121-57：原位重命名中的文档行（新建文章后自动进入；null=无）。 */
  readonly editingPath: string | null;
  readonly toggleDir: (path: string) => void;
  readonly expandAncestors: (path: string) => void;
  readonly setActivePath: (path: string | null) => void;
  readonly setOpenError: (message: string | null) => void;
  readonly addPendingDir: (path: string) => void;
  readonly removePendingDirs: (paths: readonly string[]) => void;
  readonly setEditingPath: (path: string | null) => void;
  /** CR-20261122-64：文件/文件夹改名成功后，同步本地的展开、选中与兜底目录路径。 */
  readonly renamePath: (from: string, to: string) => void;
}

export const useTreeStore = create<TreeUiState>()((set) => ({
  expanded: new Set<string>(),
  activePath: null,
  openError: null,
  pendingDirs: new Set<string>(),
  editingPath: null,
  toggleDir: (path) =>
    set((state) => {
      const next = new Set(state.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  expandAncestors: (path) =>
    set((state) => {
      const segments = path.split('/');
      segments.pop();
      if (segments.length === 0) return state;

      const next = new Set(state.expanded);
      let changed = false;
      let prefix = '';
      for (const segment of segments) {
        prefix = prefix === '' ? segment : `${prefix}/${segment}`;
        if (!next.has(prefix)) {
          next.add(prefix);
          changed = true;
        }
      }
      return changed ? { expanded: next } : state;
    }),
  setActivePath: (path) => set({ activePath: path }),
  setOpenError: (message) => set({ openError: message }),
  addPendingDir: (path) =>
    set((state) => {
      if (state.pendingDirs.has(path)) return state;
      const next = new Set(state.pendingDirs);
      next.add(path);
      return { pendingDirs: next };
    }),
  removePendingDirs: (paths) =>
    set((state) => {
      const next = new Set(state.pendingDirs);
      let changed = false;
      for (const path of paths) {
        if (next.delete(path)) changed = true;
      }
      return changed ? { pendingDirs: next } : state;
    }),
  setEditingPath: (path) => set({ editingPath: path }),
  renamePath: (from, to) =>
    set((state) => {
      const map = (path: string): string => {
        if (path === from) return to;
        return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
      };
      return {
        expanded: new Set([...state.expanded].map(map)),
        pendingDirs: new Set([...state.pendingDirs].map(map)),
        activePath: state.activePath === null ? null : map(state.activePath),
        editingPath: state.editingPath === null ? null : map(state.editingPath),
      };
    }),
}));
