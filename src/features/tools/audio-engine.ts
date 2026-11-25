import { formatUnknownError } from '../../core/errors.ts';

export type AudioEngineStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'error';

export interface AudioEngineSnapshot {
  readonly status: AudioEngineStatus;
  readonly volume: number;
  readonly error: string | null;
}

export type AudioContextFactory = () => AudioContext;
export type AudioEngineSubscriber = (snapshot: AudioEngineSnapshot) => void;

export interface AudioEngineOptions {
  readonly contextFactory?: AudioContextFactory;
  readonly volume?: number;
}

export interface AudioEngineController {
  getSnapshot(this: void): AudioEngineSnapshot;
  subscribe(this: void, subscriber: AudioEngineSubscriber): () => void;
  start(this: void): Promise<void>;
  stop(this: void): Promise<void>;
  setVolume(this: void, volume: number): void;
  dispose(this: void): Promise<void>;
}

const NOISE_SECONDS = 2;

const createDefaultContext: AudioContextFactory = () => {
  if (typeof globalThis.AudioContext !== 'function') {
    throw new Error('当前环境不支持 Web Audio');
  }
  return new globalThis.AudioContext();
};

function validateVolume(volume: number): void {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new RangeError('音量需为 0–1');
  }
}

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngineController {
  const contextFactory = options.contextFactory ?? createDefaultContext;
  const initialVolume = options.volume ?? 0.35;
  validateVolume(initialVolume);

  let snapshot: AudioEngineSnapshot = {
    status: 'idle',
    volume: initialVolume,
    error: null,
  };
  let context: AudioContext | null = null;
  let source: AudioBufferSourceNode | null = null;
  let gain: GainNode | null = null;
  let sourceStarted = false;
  let operationVersion = 0;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let disposed = false;
  const subscribers = new Set<AudioEngineSubscriber>();

  const publish = (next: AudioEngineSnapshot): void => {
    snapshot = next;
    for (const subscriber of [...subscribers]) subscriber(snapshot);
  };

  const patch = (next: Partial<AudioEngineSnapshot>): void => {
    publish({ ...snapshot, ...next });
  };

  const start = (): Promise<void> => {
    if (disposed || snapshot.status === 'running') return Promise.resolve();
    if (startPromise !== null) return startPromise;
    if (stopPromise !== null) return stopPromise.then(start);

    const version = ++operationVersion;
    patch({ status: 'starting', error: null });
    const operation = (async (): Promise<void> => {
      try {
        // factory 与 resume 均在 start 的同步调用链中触发，符合用户手势激活要求。
        if (context === null) context = contextFactory();
        const activeContext = context;
        if (activeContext.state !== 'running') await activeContext.resume();
        if (disposed || version !== operationVersion || context !== activeContext) return;

        if (source === null) {
          const frameCount = Math.max(1, Math.floor(activeContext.sampleRate * NOISE_SECONDS));
          const buffer = activeContext.createBuffer(1, frameCount, activeContext.sampleRate);
          const samples = buffer.getChannelData(0);
          for (let index = 0; index < samples.length; index += 1) {
            samples[index] = Math.random() * 2 - 1;
          }

          const nextSource = activeContext.createBufferSource();
          const nextGain = activeContext.createGain();
          nextSource.buffer = buffer;
          nextSource.loop = true;
          nextGain.gain.value = snapshot.volume;
          nextSource.connect(nextGain);
          nextGain.connect(activeContext.destination);
          source = nextSource;
          gain = nextGain;
          sourceStarted = false;
        }

        if (!sourceStarted && source !== null) source.start(0);
        sourceStarted = true;
        patch({ status: 'running', error: null });
      } catch (error: unknown) {
        if (disposed || version !== operationVersion) return;
        patch({ status: 'error', error: formatUnknownError(error, String(error)) });
      }
    })();

    startPromise = operation;
    void operation.finally(() => {
      if (startPromise === operation) startPromise = null;
    });
    return operation;
  };

  const stop = (): Promise<void> => {
    if (stopPromise !== null) return stopPromise;
    const version = ++operationVersion;

    if (context === null && source === null && gain === null) {
      patch({ status: 'idle', error: null });
      return Promise.resolve();
    }

    patch({ status: 'stopping', error: null });
    const operation = (async (): Promise<void> => {
      let failure: unknown = null;
      const captureFailure = (error: unknown): void => {
        if (failure === null) failure = error;
      };

      const activeSource = source;
      const activeGain = gain;
      const wasStarted = sourceStarted;
      source = null;
      gain = null;
      sourceStarted = false;

      if (activeSource !== null) {
        if (wasStarted) {
          try { activeSource.stop(); } catch (error: unknown) { captureFailure(error); }
        }
        try { activeSource.disconnect(); } catch (error: unknown) { captureFailure(error); }
      }
      if (activeGain !== null) {
        try { activeGain.disconnect(); } catch (error: unknown) { captureFailure(error); }
      }

      const activeContext = context;
      if (activeContext !== null && activeContext.state !== 'closed') {
        try {
          await activeContext.close();
          context = null;
        } catch (error: unknown) {
          captureFailure(error);
        }
      } else {
        context = null;
      }

      if (version !== operationVersion) return;
      const failureForMessage: unknown = failure;
      patch({
        status: failure === null ? 'idle' : 'error',
        error: failure === null ? null : formatUnknownError(failure, String(failureForMessage)),
      });
    })();

    stopPromise = operation;
    void operation.finally(() => {
      if (stopPromise === operation) stopPromise = null;
    });
    return operation;
  };

  const setVolume = (volume: number): void => {
    validateVolume(volume);
    if (gain !== null) gain.gain.value = volume;
    patch({ volume });
  };

  const dispose = (): Promise<void> => {
    if (disposed) return stopPromise ?? Promise.resolve();
    disposed = true;
    const operation = stop();
    void operation.finally(() => { subscribers.clear(); });
    return operation;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (subscriber) => {
      if (disposed) return () => undefined;
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    start,
    stop,
    setVolume,
    dispose,
  };
}
