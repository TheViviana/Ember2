/**
 * CR-R4-3：文档树动作编排（依赖注入，零 React / 零 IPC）。
 *
 * 覆盖：新建文章 / 新建文件夹 / 删除确认后的落地 / 画布改名 / 拖拽移动。
 * 索引、IPC、提示与树 UI 状态全部经 deps 注入，node 下可用 fake 覆盖。
 * 顺序持久化（localStorage）留在组件侧：moveDoc 只返回目标目录的新顺序。
 */
import type { CreateDocResult } from '../../core/core.ts';
import type { DocMeta } from '../../core/vault-index.ts';
import { formatUnknownError } from '../../core/errors.ts';
import { buildTree, dirChildrenNames } from '../tree/build-tree.ts';
import { validateCanvasId } from '../canvas/canvas-id.ts';
import { isWithinPath, removedDocPaths, renamedDocPaths } from './doc-index-sync.ts';
import {
  isDescendantOf,
  nextChildOrder,
  parentDirOf,
  type TreeDropTarget,
} from './doc-tree-drop.ts';

export type NoticeTone = 'info' | 'warning' | 'error';

/** 删除确认框携带的目标。 */
export interface DocTreeTarget {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly name: string;
}

export interface DocTreeDocs {
  readonly map: ReadonlyMap<string, DocMeta>;
  readonly root: string;
}

export interface DocTreeStoreState {
  readonly knownDirs: ReadonlySet<string>;
  readonly pendingDirs: ReadonlySet<string>;
  readonly activePath: string | null;
  readonly editingPath: string | null;
  readonly expandAncestors: (path: string) => void;
  readonly addPendingDir: (path: string) => void;
  readonly removeKnownDirs: (paths: readonly string[]) => void;
  readonly removePendingDirs: (paths: readonly string[]) => void;
  readonly setActivePath: (path: string | null) => void;
  readonly setEditingPath: (path: string | null) => void;
  readonly renamePath: (from: string, to: string) => void;
}

export interface DocTreeStore {
  getState(): DocTreeStoreState;
}

export interface DocTreeVaultApi {
  readonly mkdir: (path: string) => Promise<unknown>;
  readonly remove: (path: string) => Promise<unknown>;
  readonly rename: (from: string, to: string) => Promise<unknown>;
  readonly reveal: (path: string) => Promise<unknown>;
}

export interface DocTreeCanvasApi {
  readonly rename: (id: string, newId: string) => Promise<unknown>;
}

export interface DocTreeActionsDeps {
  readonly docs: () => DocTreeDocs;
  readonly createDoc: (rel: string) => Promise<CreateDocResult>;
  readonly vaultApi: DocTreeVaultApi;
  readonly canvasApi: DocTreeCanvasApi;
  readonly reconcile: (paths: readonly string[]) => Promise<void>;
  readonly refreshDirs: () => void;
  readonly notice: (message: string, tone: NoticeTone) => void;
  readonly treeStore: DocTreeStore;
}

export type MoveResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'rejected' }
  | {
      readonly kind: 'done';
      readonly root: string;
      readonly destDir: string;
      readonly oldDir: string;
      readonly name: string;
      readonly names: readonly string[];
    };

export interface CanvasRenameOutcome {
  readonly renamed: boolean;
  readonly newId: string;
}

export interface DocTreeActions {
  readonly createDocIn: (dir: string) => Promise<void>;
  readonly createDirIn: (dir: string) => Promise<void>;
  readonly confirmTreeDelete: (target: DocTreeTarget) => Promise<boolean>;
  readonly commitCanvasRename: (id: string, raw: string) => Promise<CanvasRenameOutcome>;
  readonly revealDoc: (path: string) => Promise<void>;
  readonly moveDoc: (draggedPath: string, target: TreeDropTarget) => Promise<MoveResult>;
}

/** 默认名冲突时自动加 -2/-3 后缀。 */
function nextFreeName(existing: ReadonlySet<string>, base: string, ext: string): string {
  if (!existing.has(`${base}${ext}`)) return `${base}${ext}`;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
}

const CANVAS_NAME_MESSAGE = {
  charset: '画布名称只能用字母/数字/下划线/连字符，且以字母或数字开头',
  length: '画布名称最长 64 个字符',
  reserved: '画布名称不能使用系统保留名（如 CON/NUL）',
} as const;

export function createDocTreeActions(deps: DocTreeActionsDeps): DocTreeActions {
  const { docs, createDoc, vaultApi, canvasApi, reconcile, refreshDirs, notice, treeStore } = deps;

  async function createDocIn(dir: string): Promise<void> {
    const siblings = new Set(
      [...docs().map.keys()]
        .filter((path) => (dir === '' ? !path.includes('/') : path.startsWith(`${dir}/`)))
        .map((path) => path.slice(path.lastIndexOf('/') + 1)),
    );
    const name = nextFreeName(siblings, '未命名文章', '.md');
    const rel = dir === '' ? name : `${dir}/${name}`;
    const result = await createDoc(rel);
    if (!result.ok) {
      notice(`新建文章失败：${result.message}`, 'error');
      return;
    }
    treeStore.getState().expandAncestors(rel);
    treeStore.getState().setEditingPath(rel);
  }

  async function createDirIn(dir: string): Promise<void> {
    const treeState = treeStore.getState();
    const allDirs = new Set<string>([...treeState.knownDirs, ...treeState.pendingDirs]);
    for (const path of docs().map.keys()) {
      const segments = path.split('/');
      segments.pop();
      let prefix = '';
      for (const segment of segments) {
        prefix = prefix === '' ? segment : `${prefix}/${segment}`;
        allDirs.add(prefix);
      }
    }
    const siblings = new Set(
      [...allDirs]
        .filter((path) => parentDirOf(path) === dir)
        .map((path) => path.slice(path.lastIndexOf('/') + 1)),
    );
    const name = nextFreeName(siblings, '未命名文件夹', '');
    const rel = dir === '' ? name : `${dir}/${name}`;
    try {
      await vaultApi.mkdir(rel);
    } catch (error: unknown) {
      notice(`新建文件夹失败：${formatUnknownError(error, '未知错误')}`, 'error');
      return;
    }
    treeStore.getState().addPendingDir(rel);
    treeStore.getState().expandAncestors(rel);
    refreshDirs();
  }

  /** 删除成功后主动对账索引；失败不推翻已完成的删除。 */
  async function syncRemoved(target: string): Promise<void> {
    const paths = removedDocPaths(docs().map.keys(), target);
    if (paths.length === 0) return;
    try {
      await reconcile(paths);
    } catch (error: unknown) {
      notice(`目录索引刷新失败：${formatUnknownError(error, '未知错误')}`, 'warning');
    }
  }

  async function confirmTreeDelete(target: DocTreeTarget): Promise<boolean> {
    try {
      await vaultApi.remove(target.path);
    } catch (error: unknown) {
      // 失败保留确认入口，方便用户重试或取消。
      notice(`删除失败：${formatUnknownError(error, '未知错误')}`, 'error');
      return false;
    }
    // 自写日志会压掉 watcher 的 removed 事件，必须主动对账；目录删除带全部后代。
    await syncRemoved(target.path);
    const treeState = treeStore.getState();
    treeState.removeKnownDirs(
      [...treeState.knownDirs].filter((dir) => isWithinPath(dir, target.path)),
    );
    treeState.removePendingDirs(
      [...treeState.pendingDirs].filter((dir) => isWithinPath(dir, target.path)),
    );
    if (treeState.activePath !== null && isWithinPath(treeState.activePath, target.path)) {
      treeState.setActivePath(null);
    }
    if (treeState.editingPath !== null && isWithinPath(treeState.editingPath, target.path)) {
      treeState.setEditingPath(null);
    }
    refreshDirs();
    notice(
      target.kind === 'dir'
        ? `文件夹「${target.name}」已移入回收站`
        : `文章「${target.name}」已移入回收站`,
      'info',
    );
    return true;
  }

  async function commitCanvasRename(id: string, raw: string): Promise<CanvasRenameOutcome> {
    const newId = raw.trim();
    if (newId === '' || newId === id) return { renamed: false, newId: id };
    const validation = validateCanvasId(newId);
    if (!validation.ok) {
      notice(CANVAS_NAME_MESSAGE[validation.reason], 'warning');
      return { renamed: false, newId: id };
    }
    try {
      await canvasApi.rename(id, newId);
    } catch (error: unknown) {
      notice(`画布改名失败：${formatUnknownError(error, '未知错误')}`, 'error');
      return { renamed: false, newId: id };
    }
    notice(`画布已改名：${id} → ${newId}`, 'info');
    return { renamed: true, newId };
  }

  async function revealDoc(path: string): Promise<void> {
    try {
      await vaultApi.reveal(path);
    } catch (error: unknown) {
      notice(`在访达中查看失败：${formatUnknownError(error, '未知错误')}`, 'error');
      return;
    }
    notice(`已在访达中显示：${path}`, 'info');
  }

  async function moveDoc(draggedPath: string, target: TreeDropTarget): Promise<MoveResult> {
    if (target.kind === 'none') return { kind: 'none' };
    const name = draggedPath.slice(draggedPath.lastIndexOf('/') + 1);
    const oldDir = parentDirOf(draggedPath);
    const destDir = target.kind === 'into' ? target.folder : target.dir;
    // 不能把文件夹移入它自身或其子目录。
    if (destDir === draggedPath || isDescendantOf(destDir, draggedPath)) {
      notice('不能把文件夹移入它自身或其子目录', 'warning');
      return { kind: 'rejected' };
    }
    const to = destDir === '' ? name : `${destDir}/${name}`;
    if (to !== draggedPath) {
      try {
        await vaultApi.rename(draggedPath, to);
      } catch (error: unknown) {
        notice(`移动失败：${formatUnknownError(error, '未知错误')}`, 'error');
        return { kind: 'rejected' };
      }
      // 自写日志压掉 watcher 事件，必须主动对账（目录移动带全部后代）。
      const { stale, fresh } = renamedDocPaths(docs().map.keys(), draggedPath, to);
      try {
        await reconcile([...stale, ...fresh]);
      } catch (error: unknown) {
        notice(`目录索引刷新失败：${formatUnknownError(error, '未知错误')}`, 'warning');
      }
      const treeState = treeStore.getState();
      treeState.renamePath(draggedPath, to);
      treeState.expandAncestors(to);
      refreshDirs();
      notice(`已移动：${name}`, 'info');
    }
    const snapshot = docs();
    const currentTreeState = treeStore.getState();
    const dirs = new Set([...currentTreeState.knownDirs, ...currentTreeState.pendingDirs]);
    const currentNames = dirChildrenNames(
      buildTree(snapshot.map, { dirs }),
      destDir,
    );
    const names = nextChildOrder(currentNames, name, target);
    return { kind: 'done', root: snapshot.root, destDir, oldDir, name, names };
  }

  return Object.freeze({
    createDocIn,
    createDirIn,
    confirmTreeDelete,
    commitCanvasRename,
    revealDoc,
    moveDoc,
  });
}
