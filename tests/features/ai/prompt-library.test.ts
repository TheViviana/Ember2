/**
 * 常用提示词库：损坏数据容错、增删改、长度与容量边界、持久化回读。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUILTIN_PROMPTS,
  PROMPT_CONTENT_MAX,
  PROMPT_LIBRARY_MAX_ITEMS,
  PROMPT_LIBRARY_STORAGE_KEY,
  PROMPT_NAME_MAX,
  addPrompt,
  addPromptFailureLabel,
  loadPromptLibrary,
  removePrompt,
  renamePrompt,
  savePromptLibrary,
  type PromptStorage,
  type SavedPrompt,
} from '../../../src/features/ai/prompt-library.ts';

function memoryStorage(initial: Record<string, string> = {}): PromptStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

void test('首次加载注入 10 条内置提示词，并立即落盘', () => {
  const storage = memoryStorage();
  const seeded = loadPromptLibrary(storage);
  assert.equal(seeded.length, BUILTIN_PROMPTS.length);
  assert.equal(seeded.length, 10);
  assert.deepEqual(
    seeded.map((item) => item.name),
    BUILTIN_PROMPTS.map((item) => item.name),
  );
  const saved = JSON.parse(storage.getItem(PROMPT_LIBRARY_STORAGE_KEY) ?? '{}') as {
    readonly items?: readonly SavedPrompt[];
  };
  assert.equal(saved.items?.length, 10);
});

void test('再次加载直接读已保存数据，不重复注入', () => {
  const storage = memoryStorage();
  const first = loadPromptLibrary(storage);
  const second = loadPromptLibrary(storage);
  assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));
  assert.equal(second.length, first.length);
});

void test('用户删光内置词后刷新不复活', () => {
  const storage = memoryStorage();
  loadPromptLibrary(storage);
  savePromptLibrary(storage, []);
  assert.deepEqual(loadPromptLibrary(storage), []);
});

void test('损坏 JSON、非法 items 都安全回退为空库', () => {
  assert.deepEqual(
    loadPromptLibrary(memoryStorage({ [PROMPT_LIBRARY_STORAGE_KEY]: '' })),
    [],
  );
  assert.deepEqual(
    loadPromptLibrary(memoryStorage({ [PROMPT_LIBRARY_STORAGE_KEY]: 'not-json' })),
    [],
  );
  assert.deepEqual(
    loadPromptLibrary(memoryStorage({ [PROMPT_LIBRARY_STORAGE_KEY]: '{"items":"x"}' })),
    [],
  );
});

void test('只保留合法条目并去重，非法条目被跳过', () => {
  const storage = memoryStorage({
    [PROMPT_LIBRARY_STORAGE_KEY]: JSON.stringify({
      version: 1,
      items: [
        { id: 'a', name: 'A', content: 'a', createdAt: 1, updatedAt: 1 },
        { id: 'a', name: '重复', content: 'dup', createdAt: 1, updatedAt: 1 },
        { id: 'b', name: '', content: 'x', createdAt: 1, updatedAt: 1 },
        { id: 'c', name: 'C', content: 'c', createdAt: '1', updatedAt: 1 },
      ],
    }),
  });
  assert.deepEqual(loadPromptLibrary(storage).map((item) => item.id), ['a']);
});

void test('新增：trim、置顶、生成 id，保存后可回读', () => {
  const storage = memoryStorage();
  const result = addPrompt([], { name: '  写作规范  ', content: '  用中文  ' }, 100);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.prompt.name, '写作规范');
  assert.equal(result.prompt.content, '用中文');
  assert.equal(result.items.length, 1);

  savePromptLibrary(storage, result.items);
  assert.deepEqual(loadPromptLibrary(storage), result.items);
});

void test('新增边界：空名称、空内容、超长、达到 50 条', () => {
  assert.deepEqual(addPrompt([], { name: ' ', content: 'x' }), {
    ok: false,
    reason: 'empty-name',
  });
  assert.deepEqual(addPrompt([], { name: 'a', content: ' ' }), {
    ok: false,
    reason: 'empty-content',
  });
  assert.deepEqual(
    addPrompt([], { name: 'x'.repeat(PROMPT_NAME_MAX + 1), content: 'x' }),
    { ok: false, reason: 'name-too-long' },
  );
  assert.deepEqual(
    addPrompt([], { name: 'a', content: 'x'.repeat(PROMPT_CONTENT_MAX + 1) }),
    { ok: false, reason: 'content-too-long' },
  );

  const full: SavedPrompt[] = Array.from({ length: PROMPT_LIBRARY_MAX_ITEMS }, (_, index) => ({
    id: `p${index}`,
    name: `n${index}`,
    content: 'c',
    createdAt: 1,
    updatedAt: 1,
  }));
  assert.deepEqual(addPrompt(full, { name: 'new', content: 'c' }), {
    ok: false,
    reason: 'limit',
  });
});

void test('删除与改名：改名保留内容并更新 updatedAt', () => {
  const added = addPrompt([], { name: '旧名', content: '正文' }, 1);
  assert.equal(added.ok, true);
  if (!added.ok) return;

  const renamed = renamePrompt(added.items, added.prompt.id, '新名', 2);
  assert.equal(renamed.ok, true);
  if (!renamed.ok) return;
  assert.equal(renamed.items[0]?.name, '新名');
  assert.equal(renamed.items[0]?.content, '正文');
  assert.equal(renamed.items[0]?.updatedAt, 2);

  assert.deepEqual(renamePrompt(added.items, 'missing', 'x'), {
    ok: false,
    reason: 'not-found',
  });
  assert.deepEqual(removePrompt(renamed.items, added.prompt.id), []);
});

void test('失败原因有可展示文案', () => {
  assert.equal(addPromptFailureLabel('limit'), `最多保存 ${PROMPT_LIBRARY_MAX_ITEMS} 条`);
  assert.equal(addPromptFailureLabel('empty-name'), '名称不能为空');
});