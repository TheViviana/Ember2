import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIpcClient, type IpcTransport } from '../../src/data/ipc-client.ts';
import type { TrashCleanupDto, TrashListDto } from '../../src/types/ipc.ts';

class FakeTransport implements IpcTransport {
  readonly calls: Array<{ command: string; args: unknown }> = [];
  private readonly results: Record<string, unknown>;
  constructor(results: Record<string, unknown>) { this.results = results; }
  invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    return Promise.resolve(this.results[command] as T);
  }
}

void test('trash_list / trash_cleanup 保持 camelCase 契约与逐项错误', async () => {
  const listed: TrashListDto = {
    entries: [{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'a.md', bytes: 42, deletedAt: null }],
  };
  const cleaned: TrashCleanupDto = {
    removedIds: ['01ARZ3NDEKTSV4RRFFQ69G5FAV'],
    errors: [{ id: 'bad', code: 'E_INVALID_ARG', message: '非法 id' }],
  };
  const transport = new FakeTransport({ trash_list: listed, trash_cleanup: cleaned });
  const client = createIpcClient(transport);
  assert.deepEqual(await client.invoke('trash_list'), listed);
  assert.deepEqual(
    await client.invoke('trash_cleanup', { ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'bad'] }),
    cleaned,
  );
  assert.deepEqual(transport.calls, [
    { command: 'trash_list', args: undefined },
    {
      command: 'trash_cleanup',
      args: { ids: ['01ARZ3NDEKTSV4RRFFQ69G5FAV', 'bad'] },
    },
  ]);
});
