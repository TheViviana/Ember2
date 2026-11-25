import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installCloseGuard,
  type CloseGuardPort,
  type CloseRequestLike,
} from '../../src/app/close-guard.ts';

function createEvent(): { event: CloseRequestLike; prevented: () => number } {
  let count = 0;
  return {
    event: {
      preventDefault: () => {
        count += 1;
      },
    },
    prevented: () => count,
  };
}

interface FakeOptions {
  readonly registerError?: Error;
  readonly closeError?: Error;
  /** 按第 N 次 close 指定结果；优先于 closeError。 */
  readonly closeOutcomes?: ReadonlyArray<Error | null>;
  readonly unlistenError?: Error;
  /** true 时 unlisten 返回 Deferred，需调用 releaseUnlisten 才完成。 */
  readonly deferUnlisten?: boolean;
}

function createPort(options: FakeOptions = {}): {
  port: CloseGuardPort;
  calls: string[];
  fire: (event: CloseRequestLike) => Promise<void>;
  releaseUnlisten: () => void;
} {
  const calls: string[] = [];
  let handler: ((event: CloseRequestLike) => void | Promise<void>) | null = null;
  let pendingUnlisten: (() => void) | null = null;
  let closeCount = 0;

  const unlisten = (): void | Promise<void> => {
    if (options.unlistenError) return Promise.reject(options.unlistenError);
    if (!options.deferUnlisten) {
      calls.push('unlisten');
      return undefined;
    }
    return new Promise<void>((resolve) => {
      pendingUnlisten = () => {
        calls.push('unlisten');
        resolve();
      };
    });
  };

  const port: CloseGuardPort = {
    onCloseRequested: (next) => {
      calls.push('register');
      handler = next;
      if (options.registerError) return Promise.reject(options.registerError);
      return Promise.resolve(unlisten);
    },
    close: () => {
      closeCount += 1;
      calls.push('close');
      const outcome = options.closeOutcomes?.[closeCount - 1];
      if (outcome) return Promise.reject(outcome);
      if (options.closeError) return Promise.reject(options.closeError);
      return Promise.resolve();
    },
  };

  return {
    port,
    calls,
    fire: (event) => (handler ? Promise.resolve(handler(event)) : Promise.resolve()),
    releaseUnlisten: () => {
      const resume = pendingUnlisten;
      pendingUnlisten = null;
      resume?.();
    },
  };
}

/** 模拟 Tauri：close() 会再次触发 closeRequested，且 unlisten 为异步 IPC。 */
function createEmittingPort(): {
  port: CloseGuardPort;
  calls: string[];
  first: { event: CloseRequestLike; prevented: () => number };
  second: { prevented: () => number };
  releaseUnlisten: () => void;
  run: () => Promise<void>;
} {
  const calls: string[] = [];
  let handler: ((event: CloseRequestLike) => void | Promise<void>) | null = null;
  let closeCount = 0;
  let secondDone: Promise<void> = Promise.resolve();
  let pendingUnlisten: (() => void) | null = null;
  const first = createEvent();
  const second = createEvent();

  const port: CloseGuardPort = {
    onCloseRequested: (next) => {
      calls.push('register');
      handler = next;
      return Promise.resolve(
        () =>
          new Promise<void>((resolve) => {
            pendingUnlisten = () => {
              calls.push('unlisten');
              resolve();
            };
          }),
      );
    },
    close: () => {
      closeCount += 1;
      calls.push(`close:${closeCount}`);
      if (closeCount === 1) {
        secondDone = Promise.resolve(handler?.(second.event)).then(() => undefined);
      }
      return Promise.resolve();
    },
  };

  return {
    port,
    calls,
    first,
    second,
    releaseUnlisten: () => {
      const resume = pendingUnlisten;
      pendingUnlisten = null;
      resume?.();
    },
    run: async () => {
      await Promise.resolve(handler?.(first.event));
      await secondDone;
    },
  };
}

const quiet = {
  flush: () => Promise.resolve(),
  onFlushError: () => undefined,
  onRegisterError: () => undefined,
};

void test('注册失败：上报错误而不是静默吞掉', async () => {
  const messages: string[] = [];
  const { port } = createPort({ registerError: new Error('ipc down') });

  installCloseGuard(port, {
    ...quiet,
    onRegisterError: (message) => messages.push(message),
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(messages, ['ipc down']);
});

void test('关窗：unlisten 完成后才 close，二次事件仍 preventDefault', async () => {
  const sequence: string[] = [];
  const fake = createEmittingPort();
  installCloseGuard(fake.port, {
    ...quiet,
    flush: () => {
      sequence.push('flush');
      return Promise.resolve();
    },
  });

  const running = fake.run();
  await new Promise((resolve) => setImmediate(resolve));

  // 二次事件已进入 unlisten 等待，close:2 绝不能提前发生。
  assert.deepEqual(fake.calls, ['register', 'close:1']);

  fake.releaseUnlisten();
  await running;

  assert.deepEqual(sequence, ['flush']);
  assert.equal(fake.first.prevented(), 1);
  assert.equal(fake.second.prevented(), 1);
  // 关键顺序：unlisten 真正 resolve 之后才 close。
  assert.deepEqual(fake.calls, ['register', 'close:1', 'unlisten', 'close:2']);
});

void test('unlisten 失败：不调用 close，上报错误并复位状态', async () => {
  const messages: string[] = [];
  let flushes = 0;
  const { port, calls, fire } = createPort({ unlistenError: new Error('unlisten failed') });

  installCloseGuard(port, {
    ...quiet,
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    onRegisterError: (message) => messages.push(message),
  });

  await fire(createEvent().event); // 首次：flush → close
  await fire(createEvent().event); // 二次：unlisten 失败

  assert.equal(calls.filter((call) => call === 'close').length, 1);
  assert.deepEqual(messages, ['窗口关闭失败，请手动保存']);

  // 标记已复位：下一次事件重新 flush 并尝试关闭。
  await fire(createEvent().event);
  assert.equal(flushes, 2);
  assert.equal(calls.filter((call) => call === 'close').length, 2);
});

void test('close 失败（监听已摘除）：持久告警并复位状态', async () => {
  const messages: string[] = [];
  let flushes = 0;
  const { port, calls, fire } = createPort({
    closeOutcomes: [null, new Error('close denied')],
  });

  installCloseGuard(port, {
    ...quiet,
    flush: () => {
      flushes += 1;
      return Promise.resolve();
    },
    onRegisterError: (message) => messages.push(message),
  });

  await fire(createEvent().event); // close #1 成功
  await fire(createEvent().event); // unlisten 成功，close #2 失败

  assert.equal(calls.filter((call) => call === 'unlisten').length, 1);
  assert.equal(calls.filter((call) => call === 'close').length, 2);
  assert.deepEqual(messages, ['自动保存已失效，请手动保存后再关闭']);

  // 标记已复位：后续事件重新 flush 并尝试关闭。
  await fire(createEvent().event);
  assert.equal(flushes, 2);
  assert.equal(calls.filter((call) => call === 'close').length, 3);
});

void test('flush 失败：取消关闭并允许下次重试', async () => {
  const messages: string[] = [];
  const { port, calls, fire } = createPort();
  let attempts = 0;

  installCloseGuard(port, {
    ...quiet,
    flush: () => {
      attempts += 1;
      if (attempts === 1) return Promise.reject(new Error('disk full'));
      return Promise.resolve();
    },
    onFlushError: (message) => messages.push(message),
  });

  await fire(createEvent().event);
  assert.deepEqual(messages, ['disk full']);
  assert.equal(calls.includes('close'), false);

  await fire(createEvent().event);
  assert.equal(calls.filter((call) => call === 'close').length, 1);
});

void test('关闭失败：允许再次尝试', async () => {
  const { port, calls, fire } = createPort({ closeError: new Error('denied') });
  installCloseGuard(port, quiet);

  await fire(createEvent().event);
  await fire(createEvent().event);

  assert.equal(calls.filter((call) => call === 'close').length, 2);
});

void test('关窗：先锁编辑器再 flush，关闭成功后保持锁定', async () => {
  const sequence: string[] = [];
  const { port, calls, fire } = createPort();
  installCloseGuard(port, {
    ...quiet,
    flush: () => {
      sequence.push('flush');
      return Promise.resolve();
    },
    editors: {
      lock: () => sequence.push('lock'),
      resume: () => sequence.push('resume'),
    },
  });

  await fire(createEvent().event);

  assert.deepEqual(sequence, ['lock', 'flush']);
  assert.equal(calls.includes('close'), true);
});

void test('flush 失败：解锁编辑器，窗口保持打开', async () => {
  const sequence: string[] = [];
  const { port, calls, fire } = createPort();
  installCloseGuard(port, {
    ...quiet,
    flush: () => Promise.reject(new Error('disk full')),
    editors: {
      lock: () => sequence.push('lock'),
      resume: () => sequence.push('resume'),
    },
  });

  await fire(createEvent().event);

  assert.deepEqual(sequence, ['lock', 'resume']);
  assert.equal(calls.includes('close'), false);
});

void test('关闭失败：解锁编辑器并复位，允许再次尝试', async () => {
  const sequence: string[] = [];
  const { port, calls, fire } = createPort({ closeError: new Error('denied') });
  installCloseGuard(port, {
    ...quiet,
    editors: {
      lock: () => sequence.push('lock'),
      resume: () => sequence.push('resume'),
    },
  });

  await fire(createEvent().event);

  assert.deepEqual(sequence, ['lock', 'resume']);
  assert.equal(calls.filter((call) => call === 'close').length, 1);
});

void test('退订：注册完成后调用 unlisten，注册未完成则补调', async () => {
  const { port, calls } = createPort();
  const dispose = installCloseGuard(port, quiet);
  await Promise.resolve();
  dispose();
  assert.ok(calls.includes('unlisten'));

  const pending = createPort();
  const disposePending = installCloseGuard(pending.port, quiet);
  disposePending();
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(pending.calls.includes('unlisten'));
});
