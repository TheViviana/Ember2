import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIpcClient, type IpcTransport } from '../../src/data/ipc-client.ts';
import type { ImportDocDto, VaultImportRequest } from '../../src/types/ipc.ts';

interface RecordedCall {
  command: string;
  args: unknown;
}

class FakeTransport implements IpcTransport {
  readonly calls: RecordedCall[] = [];
  private readonly result: ImportDocDto;

  constructor(result: ImportDocDto) {
    this.result = result;
  }

  invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    return Promise.resolve(this.result as T);
  }
}

void test('vault_import：camelCase 请求与 imported 响应原样透传', async () => {
  const request: VaultImportRequest = {
    sourcePath: '/tmp/external/note.md',
    targetDir: 'documents/inbox',
    conflict: 'rename',
  };
  const result: ImportDocDto = {
    status: 'imported',
    path: 'documents/inbox/note 2.md',
    bytes: 12,
    sha: 'ab'.repeat(32),
  };
  const transport = new FakeTransport(result);

  assert.deepEqual(await createIpcClient(transport).invoke('vault_import', request), result);
  assert.deepEqual(transport.calls, [{ command: 'vault_import', args: request }]);
});

void test('vault_import：skipped 响应保留 null path/sha 与零字节', async () => {
  const result: ImportDocDto = { status: 'skipped', path: null, bytes: 0, sha: null };
  const transport = new FakeTransport(result);
  const request: VaultImportRequest = {
    sourcePath: '/tmp/external/note.md',
    targetDir: 'documents',
    conflict: 'skip',
  };

  assert.deepEqual(await createIpcClient(transport).invoke('vault_import', request), result);
  assert.deepEqual(transport.calls, [{ command: 'vault_import', args: request }]);
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type VaultImportRequestKeysAreExact = Assert<
  Equal<keyof VaultImportRequest, 'sourcePath' | 'targetDir' | 'conflict'>
>;
export type ImportDocDtoKeysAreExact = Assert<Equal<keyof ImportDocDto, 'status' | 'path' | 'bytes' | 'sha'>>;
