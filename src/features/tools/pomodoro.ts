export const DEFAULT_FOCUS_MINUTES = 25;
export const DEFAULT_SHORT_BREAK_MINUTES = 5;
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 180;

const MINUTE_MS = 60_000;
const DISPLAY_TICK_MS = 250;

export type PomodoroPhase = 'focus' | 'short-break';
export type PomodoroStatus = 'idle' | 'running' | 'paused';

export interface PomodoroSnapshot {
  readonly phase: PomodoroPhase;
  readonly status: PomodoroStatus;
  readonly remainingMs: number;
  readonly focusMinutes: number;
  readonly shortBreakMinutes: number;
  readonly completedRounds: number;
}

export interface PomodoroDurations {
  readonly focusMinutes?: number;
  readonly shortBreakMinutes?: number;
}

export interface PomodoroClock {
  now(): number;
}

export interface PomodoroScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PomodoroControllerOptions {
  readonly clock?: PomodoroClock;
  readonly scheduler?: PomodoroScheduler;
  readonly focusMinutes?: number;
  readonly shortBreakMinutes?: number;
}

export type PomodoroSubscriber = (snapshot: PomodoroSnapshot) => void;

export interface PomodoroController {
  getSnapshot(this: void): PomodoroSnapshot;
  subscribe(this: void, subscriber: PomodoroSubscriber): () => void;
  start(this: void): void;
  pause(this: void): void;
  resume(this: void): void;
  reset(this: void): void;
  setDurations(this: void, durations: PomodoroDurations): void;
  dispose(this: void): void;
}

const systemClock: PomodoroClock = {
  now: () => Date.now(),
};

const systemScheduler: PomodoroScheduler = {
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => { globalThis.clearInterval(handle as ReturnType<typeof setInterval>); },
};

function validateMinutes(value: number, name: string): void {
  if (
    !Number.isFinite(value)
    || value < MIN_DURATION_MINUTES
    || value > MAX_DURATION_MINUTES
  ) {
    throw new RangeError(`${name}需为 ${MIN_DURATION_MINUTES}–${MAX_DURATION_MINUTES} 分钟`);
  }
}

function durationForPhase(
  phase: PomodoroPhase,
  focusMinutes: number,
  shortBreakMinutes: number,
): number {
  return (phase === 'focus' ? focusMinutes : shortBreakMinutes) * MINUTE_MS;
}

export function createPomodoroController(
  options: PomodoroControllerOptions = {},
): PomodoroController {
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? systemScheduler;
  const focusMinutes = options.focusMinutes ?? DEFAULT_FOCUS_MINUTES;
  const shortBreakMinutes = options.shortBreakMinutes ?? DEFAULT_SHORT_BREAK_MINUTES;
  validateMinutes(focusMinutes, '专注时长');
  validateMinutes(shortBreakMinutes, '短休时长');

  let snapshot: PomodoroSnapshot = {
    phase: 'focus',
    status: 'idle',
    remainingMs: focusMinutes * MINUTE_MS,
    focusMinutes,
    shortBreakMinutes,
    completedRounds: 0,
  };
  let deadlineMs: number | null = null;
  let timerHandle: unknown = null;
  let disposed = false;
  const subscribers = new Set<PomodoroSubscriber>();

  const publish = (next: PomodoroSnapshot): void => {
    snapshot = next;
    for (const subscriber of [...subscribers]) subscriber(snapshot);
  };

  const patch = (next: Partial<PomodoroSnapshot>): void => {
    publish({ ...snapshot, ...next });
  };

  const clearDisplayTimer = (): void => {
    if (timerHandle === null) return;
    const handle = timerHandle;
    timerHandle = null;
    scheduler.clearInterval(handle);
  };

  const ensureDisplayTimer = (): void => {
    if (disposed || timerHandle !== null || snapshot.status !== 'running') return;
    timerHandle = scheduler.setInterval(() => {
      if (!disposed) advance();
    }, DISPLAY_TICK_MS);
  };

  const advance = (): void => {
    if (snapshot.status !== 'running' || deadlineMs === null) return;
    const now = clock.now();
    let nextDeadline = deadlineMs;
    let phase = snapshot.phase;
    let completedRounds = snapshot.completedRounds;
    let phaseChanged = false;

    // 从旧 deadline 接续下一周期；后台跳时只经过这里校准，不按 tick 次数扣时。
    while (now >= nextDeadline) {
      phaseChanged = true;
      if (phase === 'focus') {
        phase = 'short-break';
        completedRounds += 1;
        nextDeadline += snapshot.shortBreakMinutes * MINUTE_MS;
      } else {
        phase = 'focus';
        nextDeadline += snapshot.focusMinutes * MINUTE_MS;
      }
    }

    deadlineMs = nextDeadline;
    const remainingMs = Math.max(0, nextDeadline - now);
    if (phaseChanged) {
      patch({ phase, completedRounds, remainingMs });
    } else if (remainingMs !== snapshot.remainingMs) {
      patch({ remainingMs });
    }
  };

  const start = (): void => {
    if (disposed || snapshot.status !== 'idle') return;
    deadlineMs = clock.now() + snapshot.remainingMs;
    patch({ status: 'running' });
    ensureDisplayTimer();
  };

  const pause = (): void => {
    if (disposed || snapshot.status !== 'running') return;
    advance();
    if (snapshot.status !== 'running' || deadlineMs === null) return;
    const remainingMs = snapshot.remainingMs;
    deadlineMs = null;
    clearDisplayTimer();
    patch({ status: 'paused', remainingMs });
  };

  const resume = (): void => {
    if (disposed || snapshot.status !== 'paused') return;
    deadlineMs = clock.now() + snapshot.remainingMs;
    patch({ status: 'running' });
    ensureDisplayTimer();
  };

  const reset = (): void => {
    if (disposed) return;
    clearDisplayTimer();
    deadlineMs = null;
    patch({
      status: 'idle',
      remainingMs: durationForPhase(
        snapshot.phase,
        snapshot.focusMinutes,
        snapshot.shortBreakMinutes,
      ),
    });
  };

  const setDurations = (durations: PomodoroDurations): void => {
    if (disposed) return;
    const nextFocus = durations.focusMinutes ?? snapshot.focusMinutes;
    const nextShortBreak = durations.shortBreakMinutes ?? snapshot.shortBreakMinutes;
    validateMinutes(nextFocus, '专注时长');
    validateMinutes(nextShortBreak, '短休时长');
    if (nextFocus === snapshot.focusMinutes && nextShortBreak === snapshot.shortBreakMinutes) return;

    advance();
    const runningOrPaused = snapshot.status !== 'idle';
    patch({
      focusMinutes: nextFocus,
      shortBreakMinutes: nextShortBreak,
      remainingMs: runningOrPaused
        ? snapshot.remainingMs
        : durationForPhase(snapshot.phase, nextFocus, nextShortBreak),
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearDisplayTimer();
    deadlineMs = null;
    subscribers.clear();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (subscriber) => {
      if (disposed) return () => undefined;
      subscribers.add(subscriber);
      return () => { subscribers.delete(subscriber); };
    },
    start,
    pause,
    resume,
    reset,
    setDurations,
    dispose,
  };
}
