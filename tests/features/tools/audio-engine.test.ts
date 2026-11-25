import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAudioEngine } from '../../../src/features/tools/audio-engine.ts';

class FakeBuffer {
  private readonly data: Float32Array;
  readonly length: number;

  constructor(length: number) {
    this.length = length;
    this.data = new Float32Array(length);
  }

  getChannelData(channel: number): Float32Array {
    assert.equal(channel, 0);
    return this.data;
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  startCalls = 0;
  stopCalls = 0;
  disconnectCalls = 0;
  readonly connections: unknown[] = [];

  connect(destination: unknown): void {
    this.connections.push(destination);
  }

  start(): void {
    this.startCalls += 1;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

class FakeGain {
  readonly gain = { value: 1 };
  disconnectCalls = 0;
  readonly connections: unknown[] = [];

  connect(destination: unknown): void {
    this.connections.push(destination);
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  readonly sampleRate = 10;
  readonly destination = { name: 'destination' };
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  resumeError: Error | null = null;
  closeError: Error | null = null;
  lastBufferLength: number | null = null;

  createBuffer(channels: number, length: number, sampleRate: number): FakeBuffer {
    assert.equal(channels, 1);
    assert.equal(sampleRate, this.sampleRate);
    this.lastBufferLength = length;
    return new FakeBuffer(length);
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeError !== null) return Promise.reject(this.resumeError);
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== null) return Promise.reject(this.closeError);
    this.state = 'closed';
    return Promise.resolve();
  }

  asNative(): AudioContext {
    return this as unknown as AudioContext;
  }
}

void test('用户手势 start 前不创建 AudioContext，start 内 resume 并建立循环噪声与 gain', async () => {
  const context = new FakeAudioContext();
  let factoryCalls = 0;
  const controller = createAudioEngine({
    contextFactory: () => {
      factoryCalls += 1;
      return context.asNative();
    },
    volume: 0.5,
  });
  controller.setVolume(0.5);
  assert.equal(factoryCalls, 0);
  assert.equal(context.resumeCalls, 0);

  await controller.start();
  assert.equal(factoryCalls, 1);
  assert.equal(context.resumeCalls, 1);
  assert.equal(controller.getSnapshot().status, 'running');
  assert.equal(context.sources.length, 1);
  assert.equal(context.gains.length, 1);
  const source = context.sources[0];
  const gain = context.gains[0];
  assert.ok(source !== undefined);
  assert.ok(gain !== undefined);
  assert.equal(source.loop, true);
  assert.equal(source.startCalls, 1);
  assert.equal(source.buffer?.length, 20);
  assert.deepEqual(source.connections, [gain]);
  assert.deepEqual(gain.connections, [context.destination]);
  assert.equal(gain.gain.value, 0.5);
  const samples = source.buffer?.getChannelData(0);
  assert.ok(samples !== undefined);
  assert.ok([...samples].every((sample) => sample >= -1 && sample <= 1));
});

void test('重复 start 幂等，setVolume 同步更新现有 gain', async () => {
  const context = new FakeAudioContext();
  let factoryCalls = 0;
  const controller = createAudioEngine({
    contextFactory: () => {
      factoryCalls += 1;
      return context.asNative();
    },
  });
  const first = controller.start();
  const second = controller.start();
  assert.strictEqual(first, second);
  await Promise.all([first, second]);
  await controller.start();
  assert.equal(factoryCalls, 1);
  assert.equal(context.resumeCalls, 1);
  assert.equal(context.sources.length, 1);
  assert.equal(context.sources[0]?.startCalls, 1);

  controller.setVolume(0.8);
  assert.equal(context.gains[0]?.gain.value, 0.8);
  assert.equal(controller.getSnapshot().volume, 0.8);
  assert.throws(() => controller.setVolume(1.1), /0–1/);
});

void test('stop 停止并断开节点、关闭 context，重复 stop 不重复释放', async () => {
  const context = new FakeAudioContext();
  const controller = createAudioEngine({ contextFactory: () => context.asNative() });
  await controller.start();
  await controller.stop();
  assert.equal(controller.getSnapshot().status, 'idle');
  assert.equal(controller.getSnapshot().error, null);
  assert.equal(context.sources[0]?.stopCalls, 1);
  assert.equal(context.sources[0]?.disconnectCalls, 1);
  assert.equal(context.gains[0]?.disconnectCalls, 1);
  assert.equal(context.closeCalls, 1);
  assert.equal(context.state, 'closed');
  await controller.stop();
  assert.equal(context.closeCalls, 1);
});

void test('dispose 显式释放资源，之后 start 不重建 context', async () => {
  const context = new FakeAudioContext();
  let factoryCalls = 0;
  const controller = createAudioEngine({
    contextFactory: () => {
      factoryCalls += 1;
      return context.asNative();
    },
  });
  await controller.start();
  await controller.dispose();
  assert.equal(context.closeCalls, 1);
  await controller.start();
  assert.equal(factoryCalls, 1);
  assert.equal(context.sources[0]?.disconnectCalls, 1);
});

void test('自动播放 resume 拒绝进入可见 error，stop 仍可清理', async () => {
  const context = new FakeAudioContext();
  context.resumeError = new Error('浏览器拒绝自动播放');
  const controller = createAudioEngine({ contextFactory: () => context.asNative() });
  await controller.start();
  assert.equal(controller.getSnapshot().status, 'error');
  assert.match(controller.getSnapshot().error ?? '', /拒绝自动播放/);
  assert.equal(context.sources.length, 0);
  await controller.stop();
  assert.equal(context.closeCalls, 1);
});

void test('close 失败不静默，节点仍断开且可重试释放', async () => {
  const context = new FakeAudioContext();
  context.closeError = new Error('关闭音频上下文失败');
  const controller = createAudioEngine({ contextFactory: () => context.asNative() });
  await controller.start();
  await controller.stop();
  assert.equal(controller.getSnapshot().status, 'error');
  assert.match(controller.getSnapshot().error ?? '', /关闭音频上下文失败/);
  assert.equal(context.sources[0]?.disconnectCalls, 1);
  assert.equal(context.gains[0]?.disconnectCalls, 1);
  context.closeError = null;
  await controller.stop();
  assert.equal(context.closeCalls, 2);
  assert.equal(controller.getSnapshot().status, 'idle');
});
