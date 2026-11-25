/**
 * C0-B B5：关窗两阶段错误收集、seal 后中止恢复。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  installCloseGuard,
  type CloseGuardCanvas,
  type CloseGuardPort,
  type CloseRequestLike,
} from '../../src/app/close-guard.ts';

function event(): CloseRequestLike {
  return { preventDefault: () => undefined };
}

function createPort(options: {
  readonly unlistenError?: Error;
  readonly closeOutcomes?: ReadonlyArray<Error | null>;
} = {}): {
  port: CloseGuardPort;
  calls: string[];
  fire: () => Promise<void>;
} {
  let handler: ((event: CloseRequestLike) => void | Promise<void>) | null = null;
  let closeCount = 0;
  const calls: string[] = [];

  const port: CloseGuardPort = {
    onCloseRequested: (next) => {
      calls.push('register');
      handler = next;
      return Promise.resolve(() => {
        calls.push('unlisten');
        if (options.unlistenError) return Promise.reject(options.unlistenError);
        return undefined;
      });
    },
    close: () => {
      closeCount += 1;
      calls.push(`close:${closeCount}`);
      const outcome = options.closeOutcomes?.[closeCount - 1];
      return outcome ? Promise.reject(outcome) : Promise.resolve();
    },
  };

  return {
    port,
    calls,
    fire: () => Promise.resolve(handler?.(event())).then(() => undefined),
  };
}

function createCanvas(options: { readonly fail?: Error } = {}): {
  canvas: CloseGuardCanvas;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    canvas: {
      lock: () => calls.push('lock'),
      resume: () => calls.push('resume'),
      flush: () => {
        calls.push('flush');
        return options.fail ? Promise.reject(options.fail) : Promise.resolve();
      },
      seal: () => calls.push('seal'),
      cancelSeal: () => calls.push('cancelSeal'),
    },
  };
}

void test('两阶段成功：lock → 文档 flush → 画布 flush → seal → close', async () => {
  const port = createPort();
  const canvas = createCanvas();
  const docs: string[] = [];

  installCloseGuard(port.port, {
    flush: () => {
      docs.push('doc');
      return Promise.resolve();
    },
    canvas: canvas.canvas,
    onFlushError: () => undefined,
    onRegisterError: () => undefined,
  });

  await port.fire();
  assert.deepEqual(docs, ['doc']);
  assert.deepEqual(canvas.calls, ['lock', 'flush', 'seal']);
  assert.deepEqual(port.calls, ['register', 'close:1']);

  await port.fire();
  assert.deepEqual(port.calls, ['register', 'close:1', 'unlisten', 'close:2']);
});

void test('文档成功 + 画布失败：收集错误、resume、不 seal、不 close', async () => {
  const port = createPort();
  const canvas = createCanvas({ fail: new Error('canvas flush failed') });
  const messages: string[] = [];

  installCloseGuard(port.port, {
    flush: () => Promise.resolve(),
    canvas: canvas.canvas,
    onFlushError: (message) => messages.push(message),
    onRegisterError: () => undefined,
  });

  await port.fire();
  assert.deepEqual(messages, ['canvas flush failed']);
  assert.deepEqual(canvas.calls, ['lock', 'flush', 'resume']);
  assert.equal(port.calls.includes('close:1'), false);
});

void test('双失败：两阶段错误都进入同一次提示', async () => {
  const port = createPort();
  const canvas = createCanvas({ fail: new Error('canvas flush failed') });
  const messages: string[] = [];

  installCloseGuard(port.port, {
    flush: () => Promise.reject(new Error('doc flush failed')),
    canvas: canvas.canvas,
    onFlushError: (message) => messages.push(message),
    onRegisterError: () => undefined,
  });

  await port.fire();
  assert.deepEqual(messages, ['doc flush failed；canvas flush failed']);
  assert.deepEqual(canvas.calls, ['lock', 'flush', 'resume']);
  assert.equal(port.calls.includes('close:1'), false);
});

void test('seal 后 unlisten 失败：cancelClosing + resume + 提示', async () => {
  const port = createPort({ unlistenError: new Error('unlisten failed') });
  const canvas = createCanvas();
  const messages: string[] = [];

  installCloseGuard(port.port, {
    flush: () => Promise.resolve(),
    canvas: canvas.canvas,
    onFlushError: () => undefined,
    onRegisterError: (message) => messages.push(message),
  });

  await port.fire();
  assert.deepEqual(canvas.calls, ['lock', 'flush', 'seal']);
  await port.fire();

  assert.deepEqual(messages, ['窗口关闭失败，请手动保存']);
  assert.deepEqual(canvas.calls, ['lock', 'flush', 'seal', 'cancelSeal', 'resume']);
  assert.equal(port.calls.filter((call) => call.startsWith('close:')).length, 1);
});

void test('seal 后二次 close 失败：cancelClosing + resume + 持久提示', async () => {
  const port = createPort({ closeOutcomes: [null, new Error('close denied')] });
  const canvas = createCanvas();
  const messages: string[] = [];

  installCloseGuard(port.port, {
    flush: () => Promise.resolve(),
    canvas: canvas.canvas,
    onFlushError: () => undefined,
    onRegisterError: (message) => messages.push(message),
  });

  await port.fire();
  await port.fire();

  assert.deepEqual(messages, ['自动保存已失效，请手动保存后再关闭']);
  assert.deepEqual(canvas.calls, ['lock', 'flush', 'seal', 'cancelSeal', 'resume']);
});
