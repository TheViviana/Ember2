import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIpcClient, type IpcTransport } from '../../src/data/ipc-client.ts';
import type {
  ReplaceDocDto,
  VaultReplaceFailure,
  VaultReplaceItem,
  VaultReplaceRequest,
} from '../../src/types/ipc.ts';

interface RecordedCall {
  command: string;
  args: unknown;
}

class FakeTransport implements IpcTransport {
  readonly calls: RecordedCall[] = [];
  private readonly result: ReplaceDocDto;

  constructor(result: ReplaceDocDto) {
    this.result = result;
  }

  invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    return Promise.resolve(this.result as T);
  }
}

void test('vault_replace：camelCase 请求与 partial 回滚明细原样透传', async () => {
  const request: VaultReplaceRequest = {
    items: [
      { path: 'a.md', expectedSha: 'aa'.repeat(32), text: 'new-a' },
      { path: 'b.md', expectedSha: 'bb'.repeat(32), text: 'new-b' },
      { path: 'c.md', expectedSha: 'cc'.repeat(32), text: 'new-c' },
    ],
  };
  const result: ReplaceDocDto = {
    status: 'partial',
    written: ['b.md'],
    restored: ['a.md'],
    failure: { path: 'c.md', code: 'E_IO', message: 'write failed' },
    rollbackErrors: [{ path: 'b.md', code: 'E_INVALID_ARG', message: 'changed during rollback' }],
  };
  const transport = new FakeTransport(result);

  assert.deepEqual(await createIpcClient(transport).invoke('vault_replace', request), result);
  assert.deepEqual(transport.calls, [{ command: 'vault_replace', args: request }]);
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type VaultReplaceRequestKeysAreExact = Assert<Equal<keyof VaultReplaceRequest, 'items'>>;
export type VaultReplaceItemKeysAreExact = Assert<
  Equal<keyof VaultReplaceItem, 'path' | 'expectedSha' | 'text'>
>;
export type VaultReplaceFailureKeysAreExact = Assert<
  Equal<keyof VaultReplaceFailure, 'path' | 'code' | 'message'>
>;
export type ReplaceDocDtoKeysAreExact = Assert<
  Equal<keyof ReplaceDocDto, 'status' | 'written' | 'restored' | 'failure' | 'rollbackErrors'>
>;
