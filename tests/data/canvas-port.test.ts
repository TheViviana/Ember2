/**
 * 提交 4：生产画布适配器（CR-20261116-02 §12.1 / §9）。
 *
 * 走真实 `createIpcClient` + 假 transport：验证只调用三条画布命令、参数 camelCase、
 * 返回值原样映射，以及 Rust 错误载荷经 `toIpcError` 归一（`currentSha` / `cause`
 * 按存在才透传，缺省为 `null`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmberIpcError } from '../../src/core/errors.ts';
import { createTauriCanvasPort } from '../../src/data/canvas-port.ts';
import { createIpcClient, type IpcTransport } from '../../src/data/ipc-client.ts';
import {
  IPC_ERROR_CODES,
  type CanvasEntryDto,
  type CanvasErrorPayload,
  type ErrorPayload,
  type ReadCanvasDto,
  type WriteCanvasDto,
} from '../../src/types/ipc.ts';

interface RecordedCall {
  command: string;
  args: unknown;
}

/** 只记录调用与回放的传输层，不碰 Tauri。 */
class FakeTransport implements IpcTransport {
  readonly calls: RecordedCall[] = [];
  private readonly replies = new Map<string, unknown>();
  private readonly failures = new Map<string, Error>();

  reply(command: string, value: unknown): void {
    this.replies.set(command, value);
  }

  /** Tauri 的 rejection 是 Rust 载荷对象（非 Error 实例）；按原样保存，运行时不改写载荷。 */
  fail(command: string, rejection: unknown): void {
    this.failures.set(command, rejection as Error);
  }

  invoke<T>(command: string, args?: unknown): Promise<T> {
    this.calls.push({ command, args });
    const failure = this.failures.get(command);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.replies.get(command) as T);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof EmberIpcError && error.code === code;
}

// ------------------------------------------------------------------ 命令映射

void test('list：只调用 list_canvases（无参），valid:false 条目原样透传', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  const entries: CanvasEntryDto[] = [
    { id: 'good', valid: true, path: '.workbench/canvas/good.canvas.json', bytes: 2, modifiedMs: 5 },
    { id: 'a.b', valid: false, reason: 'bad_id', modifiedMs: 6 },
  ];
  transport.reply('list_canvases', entries);

  assert.deepEqual(await port.list(), entries);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]?.command, 'list_canvases');
  assert.equal(transport.calls[0]?.args, undefined);
});

void test('read：参数只有 id，响应字段原样映射', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  const dto: ReadCanvasDto = {
    id: 'c1',
    path: '.workbench/canvas/c1.canvas.json',
    text: '{"nodes":[]}',
    bytes: 12,
    sha256: 'ab'.repeat(32),
    modifiedMs: 1_700_000_000_000,
  };
  transport.reply('canvas_read', dto);

  assert.deepEqual(await port.read('c1'), dto);
  assert.deepEqual(transport.calls, [{ command: 'canvas_read', args: { id: 'c1' } }]);
});

void test('write：expectedSha 原样透传，backupV1 缺省显式 false', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  const dto: WriteCanvasDto = {
    id: 'c1',
    path: '.workbench/canvas/c1.canvas.json',
    bytes: 9,
    sha256: 'cd'.repeat(32),
    modifiedMs: 1_700_000_000_001,
  };
  transport.reply('canvas_write', dto);

  assert.deepEqual(await port.write('c1', '{"n":1}', ''), dto);
  assert.deepEqual(transport.calls, [
    {
      command: 'canvas_write',
      args: { id: 'c1', text: '{"n":1}', expectedSha: '', backupV1: false },
    },
  ]);
});

void test('write：第 4 参显式 undefined 时仍回落 backupV1:false，不抛错', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  transport.reply('canvas_write', {
    id: 'c1',
    path: '.workbench/canvas/c1.canvas.json',
    bytes: 2,
    sha256: 'ab'.repeat(32),
    modifiedMs: 3,
  } satisfies WriteCanvasDto);

  await port.write('c1', '{}', 'ab'.repeat(32), undefined);
  assert.deepEqual(transport.calls[0]?.args, {
    id: 'c1',
    text: '{}',
    expectedSha: 'ab'.repeat(32),
    backupV1: false,
  });
});

void test('write：backupV1:true 透传为 true', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  transport.reply('canvas_write', {
    id: 'c1',
    path: '.workbench/canvas/c1.canvas.json',
    bytes: 2,
    sha256: 'ef'.repeat(32),
    modifiedMs: 2,
  } satisfies WriteCanvasDto);

  await port.write('c1', '{}', 'ab'.repeat(32), { backupV1: true });
  assert.deepEqual(transport.calls[0]?.args, {
    id: 'c1',
    text: '{}',
    expectedSha: 'ab'.repeat(32),
    backupV1: true,
  });
});

// -------------------------------------------------------------- 错误归一化

void test('E_CONFLICT：currentSha 透传，cause 归一为 null', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  const payload: CanvasErrorPayload = {
    code: 'E_CONFLICT',
    message: 'canvas changed before write',
    currentSha: '9f2c',
  };
  transport.fail('canvas_write', payload);

  await assert.rejects(port.write('c1', '{}', ''), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_CONFLICT');
    assert.equal(error.command, 'canvas_write');
    assert.equal(error.currentSha, '9f2c');
    assert.equal(error.cause, null);
    return true;
  });
});

void test('E_BACKUP_FAILED：cause 透传，currentSha 归一为 null', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  transport.fail('canvas_write', {
    code: 'E_BACKUP_FAILED',
    message: '备份失败：No space left on device (os error 28)',
    cause: 'ENOSPC',
  } satisfies CanvasErrorPayload);

  await assert.rejects(port.write('c1', '{}', ''), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_BACKUP_FAILED');
    assert.equal(error.cause, 'ENOSPC');
    assert.equal(error.currentSha, null);
    return true;
  });
});

void test('错误归一：缺省扩展字段为 null（不是 undefined），未知码保留 rawCode', async () => {
  const transport = new FakeTransport();
  const port = createTauriCanvasPort(createIpcClient(transport));
  transport.fail('canvas_read', { code: 'E_NOT_FOUND', message: 'canvas not found: c1' });

  await assert.rejects(port.read('c1'), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_NOT_FOUND');
    assert.equal(error.currentSha, null);
    assert.equal(error.cause, null);
    return true;
  });

  transport.fail('canvas_read', { code: 'E_FUTURE_CODE', message: 'unknown' });
  await assert.rejects(port.read('c1'), (error: unknown) => {
    assert.ok(error instanceof EmberIpcError);
    assert.equal(error.code, 'E_UNKNOWN');
    assert.equal(error.rawCode, 'E_FUTURE_CODE');
    return true;
  });
});

void test('前端专用码不进 IPC_ERROR_CODES（Rust 永不返回 E_CLOSING / E_FLUSH_TIMEOUT）', () => {
  const codes = IPC_ERROR_CODES as readonly string[];
  assert.equal(codes.includes('E_CLOSING'), false);
  assert.equal(codes.includes('E_FLUSH_TIMEOUT'), false);
  assert.equal(hasCode(new EmberIpcError('canvas_write', 'E_CLOSING', 'x', 'E_CLOSING'), 'E_CLOSING'), true);
});

// ------------------------------------------------------------ 类型隔离（编译期）

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** P1 共享载荷不得混入画布扩展字段。 */
export type ErrorPayloadHasNoCanvasFields = Assert<
  Equal<'currentSha' extends keyof ErrorPayload ? true : false, false>
>;
/** 画布载荷才拥有 currentSha。 */
export type CanvasPayloadHasCurrentSha = Assert<
  Equal<'currentSha' extends keyof CanvasErrorPayload ? true : false, true>
>;
/** 两者不是同一个类型别名，也不可互相替代。 */
export type CanvasPayloadIsDistinct = Assert<Equal<Equal<CanvasErrorPayload, ErrorPayload>, false>>;

/**
 * 硬断言（S1）：键集必须精确相等。任何一方多出 / 少掉字段都会让 `Equal` 变 false，
 * `Assert` 随即编译失败——不依赖类型错误豁免指令（gate:bans 禁止该指令）。
 */
export type ErrorPayloadKeysAreExact = Assert<Equal<keyof ErrorPayload, 'code' | 'message'>>;
export type CanvasPayloadKeysAreExact = Assert<
  Equal<keyof CanvasErrorPayload, 'code' | 'message' | 'currentSha' | 'cause'>
>;
