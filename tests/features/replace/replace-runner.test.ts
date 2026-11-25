import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commitReplacement,
  countReplaceMatches,
  prepareReplacement,
  runReplaceSearch,
  skipReplaceMatches,
  type PreparedReplaceItem,
  type ReplaceItem,
  type ReplacementPlan,
  type ReplaceRunnerEffects,
  type ReplaceSearchRequest,
} from '../../../src/features/replace/replace-runner.ts';

const SEARCH: ReplaceSearchRequest = {
  query: 'old',
  scopes: { title: true, body: true, tags: true },
};

function effectsFor(
  source: Record<string, string>,
  overrides: Partial<ReplaceRunnerEffects> = {},
): ReplaceRunnerEffects {
  return {
    scan: () => Promise.resolve(Object.keys(source).map((path) => ({ path }))),
    read: (path) => {
      const text = source[path];
      return text === undefined
        ? Promise.reject(new Error(`missing ${path}`))
        : Promise.resolve({ text, sha256: `sha:${text}` });
    },
    flush: () => Promise.resolve(),
    replace: (items) => Promise.resolve({
      status: 'applied',
      written: items.map((item) => item.path),
      restored: [],
      failure: null,
      rollbackErrors: [],
    }),
    reconcile: () => Promise.resolve(),
    yieldControl: () => Promise.resolve(),
    ...overrides,
  };
}

function plan(items: readonly PreparedReplaceItem[]): ReplacementPlan {
  return {
    search: SEARCH,
    replacement: 'new',
    items,
    issues: [],
    matchCount: items.reduce((total, item) => total + item.matchIds.length, 0),
    cancelled: false,
    fatalError: null,
  };
}

void test('搜索按 scan 顺序增量进度，每文件 yield，read 失败不阻断后续', async () => {
  const source: Record<string, string> = { 'a.md': 'old', 'bad.md': 'unused', 'b.md': 'old old' };
  const progress: number[] = [];
  let yields = 0;
  const run = await runReplaceSearch(SEARCH, effectsFor(source, {
    read: (path) => path === 'bad.md'
      ? Promise.reject(new Error('bad utf8'))
      : Promise.resolve({ text: source[path] ?? '', sha256: `sha:${path}` }),
    yieldControl: () => { yields += 1; return Promise.resolve(); },
  }), {
    onProgress: (value) => { progress.push(value.scanned); },
    shouldCancel: () => false,
  });
  assert.deepEqual(progress, [0, 1, 2, 3]);
  assert.equal(yields, 3);
  assert.deepEqual(run.documents.map((document) => document.path), ['a.md', 'b.md']);
  assert.equal(countReplaceMatches(run.documents), 3);
  assert.equal(run.issues[0]?.path, 'bad.md');
});

void test('搜索取消和预检取消均为零写入', async () => {
  let cancelSearch = false;
  let writes = 0;
  const searched = await runReplaceSearch(SEARCH, effectsFor({ 'a.md': 'old', 'b.md': 'old' }, {
    replace: () => { writes += 1; return Promise.reject(new Error('unreachable')); },
    yieldControl: () => { cancelSearch = true; return Promise.resolve(); },
  }), { onProgress: () => {}, shouldCancel: () => cancelSearch });
  assert.equal(searched.cancelled, true);
  assert.equal(searched.scanned, 1);

  let cancelPreflight = false;
  const prepared = await prepareReplacement(searched.documents, null, 'new', SEARCH, effectsFor({ 'a.md': 'old' }, {
    flush: () => { cancelPreflight = true; return Promise.resolve(); },
    replace: () => { writes += 1; return Promise.reject(new Error('unreachable')); },
  }), { onProgress: () => {}, shouldCancel: () => cancelPreflight });
  assert.equal(prepared.cancelled, true);
  assert.equal(prepared.items.length, 0);
  assert.equal(writes, 0);
});

void test('flush 失败时预检中止且不读取或写入', async () => {
  let reads = 0;
  const searched = await runReplaceSearch(SEARCH, effectsFor({ 'a.md': 'old' }), {
    onProgress: () => {}, shouldCancel: () => false,
  });
  const prepared = await prepareReplacement(searched.documents, null, 'new', SEARCH, effectsFor({ 'a.md': 'old' }, {
    flush: () => Promise.reject(new Error('dirty')),
    read: () => { reads += 1; return Promise.reject(new Error('unreachable')); },
  }), { onProgress: () => {}, shouldCancel: () => false });
  assert.match(prepared.fatalError ?? '', /替换未开始/);
  assert.equal(reads, 0);
});

void test('预检先 flush 再重读全部候选，stale 文档不进入写批', async () => {
  const source: Record<string, string> = { 'a.md': 'old', 'b.md': 'old' };
  const searched = await runReplaceSearch(SEARCH, effectsFor(source), {
    onProgress: () => {}, shouldCancel: () => false,
  });
  source['a.md'] = 'externally changed';
  const calls: string[] = [];
  let submitted: readonly ReplaceItem[] = [];
  const effects = effectsFor(source, {
    flush: () => { calls.push('flush'); return Promise.resolve(); },
    read: (path) => {
      calls.push(`read:${path}`);
      return Promise.resolve({ text: source[path] ?? '', sha256: `sha:${source[path] ?? ''}` });
    },
    replace: (items) => {
      submitted = items;
      return Promise.resolve({ status: 'applied', written: ['b.md'], restored: [], failure: null, rollbackErrors: [] });
    },
  });
  const prepared = await prepareReplacement(searched.documents, null, 'new', SEARCH, effects, {
    onProgress: () => {}, shouldCancel: () => false,
  });
  assert.deepEqual(calls.slice(0, 3), ['flush', 'read:a.md', 'read:b.md']);
  assert.deepEqual(prepared.items.map((item) => item.path), ['b.md']);
  assert.equal(prepared.issues[0]?.code, 'stale');
  const committed = await commitReplacement(prepared, effects);
  assert.deepEqual(submitted.map((item) => item.path), ['b.md']);
  assert.equal(committed.result?.status, 'applied');
  assert.equal(committed.unavailable[0]?.code, 'stale');
});

void test('逐项替换也走批次命令，skip 仅移除本地匹配', async () => {
  const searched = await runReplaceSearch(SEARCH, effectsFor({ 'a.md': 'old then old' }), {
    onProgress: () => {}, shouldCancel: () => false,
  });
  const first = searched.documents[0]?.matches[0];
  const second = searched.documents[0]?.matches[1];
  assert.ok(first && second);
  const remaining = skipReplaceMatches(searched.documents, [second.id]);
  assert.equal(countReplaceMatches(remaining), 1);
  let submitted: readonly ReplaceItem[] = [];
  const prepared = await prepareReplacement(remaining, [first.id], 'new', SEARCH, effectsFor({ 'a.md': 'old then old' }, {
    replace: (items) => {
      submitted = items;
      return Promise.resolve({ status: 'applied', written: ['a.md'], restored: [], failure: null, rollbackErrors: [] });
    },
  }), { onProgress: () => {}, shouldCancel: () => false });
  assert.equal(prepared.matchCount, 1);
  assert.equal(prepared.items[0]?.text, 'new then old');
  await commitReplacement(prepared, effectsFor({ 'a.md': 'old then old' }, {
    replace: (items) => {
      submitted = items;
      return Promise.resolve({ status: 'applied', written: ['a.md'], restored: [], failure: null, rollbackErrors: [] });
    },
  }));
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.text, 'new then old');
});

void test('YAML 校验失败项保留为不可提交，其余项可继续', async () => {
  const source = { 'a.md': '---\ntitle: old\n---\n', 'b.md': 'old' };
  const searched = await runReplaceSearch(SEARCH, effectsFor(source), {
    onProgress: () => {}, shouldCancel: () => false,
  });
  const prepared = await prepareReplacement(searched.documents, null, '123', SEARCH, effectsFor(source), {
    onProgress: () => {}, shouldCancel: () => false,
  });
  assert.deepEqual(prepared.items.map((item) => item.path), ['b.md']);
  assert.equal(prepared.issues[0]?.code, 'invalid');
});

void test('partial/rolledBack 结果原样返回，并去重对账所有相关路径', async () => {
  const items: PreparedReplaceItem[] = [
    { path: 'a.md', expectedSha: 'a', text: 'new', matchIds: ['a:0:3'] },
    { path: 'b.md', expectedSha: 'b', text: 'new', matchIds: ['b:0:3'] },
  ];
  let reconciled: readonly string[] = [];
  const partial = await commitReplacement(plan(items), effectsFor({}, {
    replace: () => Promise.resolve({
      status: 'partial',
      written: ['a.md', 'd.md'],
      restored: ['b.md'],
      failure: { path: 'c.md', code: 'E_IO', message: 'write failed' },
      rollbackErrors: [{ path: 'a.md', code: 'E_CONFLICT', message: 'external' }],
    }),
    reconcile: (paths) => { reconciled = paths; return Promise.resolve(); },
  }));
  assert.equal(partial.result?.status, 'partial');
  assert.deepEqual(new Set(reconciled), new Set(['a.md', 'b.md', 'c.md', 'd.md']));

  const rolledBack = await commitReplacement(plan(items), effectsFor({}, {
    replace: () => Promise.resolve({
      status: 'rolledBack', written: [], restored: ['a.md', 'b.md'],
      failure: { path: 'b.md', code: 'E_IO', message: 'failed' }, rollbackErrors: [],
    }),
  }));
  assert.equal(rolledBack.result?.status, 'rolledBack');
  assert.equal(rolledBack.failure?.path, 'b.md');
});

void test('提交抛错仍对账候选路径，空计划不调用替换', async () => {
  let reconciled: readonly string[] = [];
  const failed = await commitReplacement(plan([
    { path: 'a.md', expectedSha: 'a', text: 'new', matchIds: ['a'] },
    { path: 'b.md', expectedSha: 'b', text: 'new', matchIds: ['b'] },
  ]), effectsFor({}, {
    replace: () => Promise.reject(Object.assign(new Error('sha changed'), { code: 'E_CONFLICT', path: 'b.md' })),
    reconcile: (paths) => { reconciled = paths; return Promise.resolve(); },
  }));
  assert.equal(failed.result, null);
  assert.equal(failed.failure?.code, 'E_CONFLICT');
  assert.deepEqual(new Set(reconciled), new Set(['a.md', 'b.md']));

  let writes = 0;
  const empty = await commitReplacement(plan([]), effectsFor({}, {
    replace: () => { writes += 1; return Promise.reject(new Error('unreachable')); },
  }));
  assert.equal(empty.result, null);
  assert.equal(writes, 0);
});
