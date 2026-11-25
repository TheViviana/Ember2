/**
 * CR-R4-3：文档树动作（DI）——关键路径与失败路径，fake deps，零 IPC / 零 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocMeta } from '../../../src/core/vault-index.ts';
import type { TreeDropTarget } from '../../../src/app/panels/doc-tree-drop.ts';
import {
  createDocTreeActions,
  type DocTreeStoreState,
  type DocTreeTarget,
} from '../../../src/app/panels/doc-tree-actions.ts';

interface Recorder {
  readonly notices: { message: string; tone: string }[];
  readonly created: string[];
  readonly mkdirs: string[];
  readonly removed: string[];
  readonly renames: { from: string; to: string }[];
  readonly canvasRenames: { id: string; newId: string }[];
  readonly reconciled: (readonly string[])[];
  readonly calls: string[];
}

function recorder(): Recorder {
  return {
    notices: [],
    created: [],
    mkdirs: [],
    removed: [],
    renames: [],
    canvasRenames: [],
    reconciled: [],
    calls: [],
  };
}

function meta(path: string): DocMeta {
  return { path, bytes: 1, sha256: 'sha', modifiedMs: 1 };
}

interface TreeFake
  extends Omit<DocTreeStoreState, 'pendingDirs' | 'activePath' | 'editingPath'> {
  pendingDirs: Set<string>;
  activePath: string | null;
  editingPath: string | null;
  readonly expanded: string[];
  readonly added: string[];
  readonly removedPending: (readonly string[])[];
  readonly renamed: { from: string; to: string }[];
}

interface StoreFake extends TreeFake {
  getState(): DocTreeStoreState;
}

function treeFake(initial: Partial<DocTreeStoreState> = {}): StoreFake {
  const state: TreeFake = {
    pendingDirs: new Set(initial.pendingDirs ?? []),
    activePath: initial.activePath ?? null,
    editingPath: initial.editingPath ?? null,
    expanded: [],
    added: [],
    removedPending: [],
    renamed: [],
    expandAncestors: (path) => state.expanded.push(path),
    addPendingDir: (path) => {
      state.added.push(path);
      state.pendingDirs = new Set([...state.pendingDirs, path]);
    },
    removePendingDirs: (paths) => {
      state.removedPending.push([...paths]);
      const next = new Set(state.pendingDirs);
      for (const path of paths) next.delete(path);
      state.pendingDirs = next;
    },
    setActivePath: (path) => {
      state.activePath = path;
    },
    setEditingPath: (path) => {
      state.editingPath = path;
    },
    renamePath: (from, to) => state.renamed.push({ from, to }),
  };
  return { ...state, getState: () => state };
}

function deps(options: {
  readonly rec: Recorder;
  readonly docs: Map<string, DocMeta>;
  readonly store: StoreFake;
  readonly root?: string;
  readonly createDoc?: () => { ok: true; rel: string } | { ok: false; reason: 'IO'; message: string };
  readonly fail?: { readonly remove?: boolean; readonly mkdir?: boolean; readonly rename?: boolean };
}) {
  const { rec, docs, store } = options;
  return {
    docs: () => ({ map: docs, root: options.root ?? '/vault' }),
    createDoc: (rel: string) => {
      rec.created.push(rel);
      const result = options.createDoc?.() ?? { ok: true as const, rel };
      return Promise.resolve(result);
    },
    vaultApi: {
      mkdir: (path: string) => {
        rec.mkdirs.push(path);
        rec.calls.push('mkdir');
        return options.fail?.mkdir === true ? Promise.reject(new Error('boom')) : Promise.resolve(null);
      },
      remove: (path: string) => {
        rec.removed.push(path);
        rec.calls.push('remove');
        return options.fail?.remove === true ? Promise.reject(new Error('boom')) : Promise.resolve(null);
      },
      rename: (from: string, to: string) => {
        rec.renames.push({ from, to });
        rec.calls.push('rename');
        return options.fail?.rename === true ? Promise.reject(new Error('boom')) : Promise.resolve(null);
      },
    },
    canvasApi: {
      rename: (id: string, newId: string) => {
        rec.canvasRenames.push({ id, newId });
        return Promise.resolve(null);
      },
    },
    reconcile: (paths: readonly string[]) => {
      rec.reconciled.push([...paths]);
      rec.calls.push('reconcile');
      return Promise.resolve();
    },
    notice: (message: string, tone: 'info' | 'warning' | 'error') =>
      rec.notices.push({ message, tone }),
    treeStore: store,
  };
}

void test('createDocIn：默认名冲突加后缀，成功后展开并进入改名态', async () => {
  const rec = recorder();
  const docs = new Map([
    ['未命名文章.md', meta('未命名文章.md')],
    ['未命名文章-2.md', meta('未命名文章-2.md')],
  ]);
  const store = treeFake();
  const actions = createDocTreeActions(deps({ rec, docs, store }));
  await actions.createDocIn('');
  assert.deepEqual(rec.created, ['未命名文章-3.md']);
  assert.deepEqual(store.expanded, ['未命名文章-3.md']);
  assert.equal(store.getState().editingPath, '未命名文章-3.md');
});

void test('createDocIn：创建失败只提示，不进入改名态', async () => {
  const rec = recorder();
  const store = treeFake();
  const actions = createDocTreeActions(
    deps({ rec, docs: new Map(), store, createDoc: () => ({ ok: false, reason: 'IO', message: '磁盘满' }) }),
  );
  await actions.createDocIn('notes');
  assert.deepEqual(rec.created, ['notes/未命名文章.md']);
  assert.deepEqual(store.expanded, []);
  assert.equal(store.getState().editingPath, null);
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.equal(notice.message, '新建文章失败：磁盘满');
  assert.equal(notice.tone, 'error');
});

void test('createDirIn：pendingDirs 与索引前缀都算已占用（空目录兜底）', async () => {
  const rec = recorder();
  const docs = new Map([['docs/a.md', meta('docs/a.md')]]);
  const store = treeFake({
    pendingDirs: new Set(['未命名文件夹']),
  });
  const actions = createDocTreeActions(deps({ rec, docs, store }));
  await actions.createDirIn('');
  assert.deepEqual(rec.mkdirs, ['未命名文件夹-2']);
  assert.deepEqual(store.added, ['未命名文件夹-2']);
  assert.deepEqual(store.expanded, ['未命名文件夹-2']);
});

void test('confirmTreeDelete：先 remove 再对账，并清理兜底目录/选中/改名态', async () => {
  const rec = recorder();
  const docs = new Map([
    ['notes/a.md', meta('notes/a.md')],
    ['notes/sub/b.md', meta('notes/sub/b.md')],
    ['other.md', meta('other.md')],
  ]);
  const store = treeFake({
    pendingDirs: new Set(['notes/empty', 'other']),
    activePath: 'notes/a.md',
    editingPath: 'notes/sub/b.md',
  });
  const actions = createDocTreeActions(deps({ rec, docs, store }));
  const target: DocTreeTarget = { path: 'notes', kind: 'dir', name: 'notes' };
  assert.equal(await actions.confirmTreeDelete(target), true);
  assert.deepEqual(rec.calls, ['remove', 'reconcile']);
  assert.deepEqual(rec.reconciled, [['notes/a.md', 'notes/sub/b.md']]);
  assert.deepEqual(store.removedPending, [['notes/empty']]);
  assert.equal(store.getState().activePath, null);
  assert.equal(store.getState().editingPath, null);
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.equal(notice.message, '文件夹「notes」已移入回收站');
  assert.equal(notice.tone, 'info');
});

void test('confirmTreeDelete：remove 失败保留目标并提示错误', async () => {
  const rec = recorder();
  const store = treeFake();
  const actions = createDocTreeActions(
    deps({ rec, docs: new Map([['a.md', meta('a.md')]]), store, fail: { remove: true } }),
  );
  assert.equal(await actions.confirmTreeDelete({ path: 'a.md', kind: 'file', name: 'a.md' }), false);
  assert.deepEqual(rec.calls, ['remove']);
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.match(notice.message, /^删除失败：/);
  assert.equal(notice.tone, 'error');
});

void test('commitCanvasRename：非法名不发 IPC，合法名成功', async () => {
  const rec = recorder();
  const actions = createDocTreeActions(
    deps({ rec, docs: new Map(), store: treeFake() }),
  );
  assert.deepEqual(await actions.commitCanvasRename('ok', 'bad name'), { renamed: false, newId: 'ok' });
  assert.equal(rec.canvasRenames.length, 0);
  const warning = rec.notices[0];
  assert.ok(warning);
  assert.equal(warning.tone, 'warning');

  assert.deepEqual(await actions.commitCanvasRename('ok', 'new-1'), { renamed: true, newId: 'new-1' });
  assert.deepEqual(rec.canvasRenames, [{ id: 'ok', newId: 'new-1' }]);
  const info = rec.notices[rec.notices.length - 1];
  assert.ok(info);
  assert.equal(info.message, '画布已改名：ok → new-1');
});

void test('moveDoc：跨目录 rename → 对账 → 本地迁移，返回目标目录新顺序', async () => {
  const rec = recorder();
  const docs = new Map([
    ['a.md', meta('a.md')],
    ['dir/b.md', meta('dir/b.md')],
  ]);
  const store = treeFake();
  const actions = createDocTreeActions(deps({ rec, docs, store }));
  const target: TreeDropTarget = { kind: 'place', dir: 'dir', anchor: 'b.md', position: 'after' };
  const result = await actions.moveDoc('a.md', target);
  assert.deepEqual(rec.calls, ['rename', 'reconcile']);
  assert.deepEqual(rec.renames, [{ from: 'a.md', to: 'dir/a.md' }]);
  assert.deepEqual(rec.reconciled, [['a.md', 'dir/a.md']]);
  assert.deepEqual(store.renamed, [{ from: 'a.md', to: 'dir/a.md' }]);
  assert.deepEqual(store.expanded, ['dir/a.md']);
  assert.deepEqual(result, {
    kind: 'done',
    root: '/vault',
    destDir: 'dir',
    oldDir: '',
    name: 'a.md',
    names: ['b.md', 'a.md'],
  });
});

void test('moveDoc：同目录调序只算顺序，不发 IPC', async () => {
  const rec = recorder();
  const docs = new Map([
    ['dir/a.md', meta('dir/a.md')],
    ['dir/b.md', meta('dir/b.md')],
    ['dir/c.md', meta('dir/c.md')],
  ]);
  const actions = createDocTreeActions(deps({ rec, docs, store: treeFake() }));
  const target: TreeDropTarget = { kind: 'place', dir: 'dir', anchor: 'a.md', position: 'before' };
  const result = await actions.moveDoc('dir/c.md', target);
  assert.deepEqual(rec.calls, []);
  assert.equal(result.kind, 'done');
  if (result.kind === 'done') assert.deepEqual(result.names, ['c.md', 'a.md', 'b.md']);
});

void test('moveDoc：移入自身子树被拒绝，none 直接返回', async () => {
  const rec = recorder();
  const store = treeFake();
  const actions = createDocTreeActions(deps({ rec, docs: new Map(), store }));
  const rejected = await actions.moveDoc('notes', { kind: 'into', folder: 'notes/sub' });
  assert.deepEqual(rejected, { kind: 'rejected' });
  assert.deepEqual(rec.calls, []);
  assert.deepEqual(await actions.moveDoc('a.md', { kind: 'none' }), { kind: 'none' });
  const notice = rec.notices[0];
  assert.ok(notice);
  assert.equal(notice.message, '不能把文件夹移入它自身或其子目录');
});
