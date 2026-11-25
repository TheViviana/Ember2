/**
 * 效率工具偏好持久化（2026-11-25）：番茄钟时长与白噪音音量。
 *
 * 与设置壳其余页面一致：localStorage 记住上次选择，下次启动由
 * useToolControllers 读取并作为控制器初始值，保证「改完就存、重启仍在」。
 */
import { MAX_DURATION_MINUTES, MIN_DURATION_MINUTES } from './pomodoro.ts';

export const POMODORO_DURATIONS_KEY = 'ember.tools.pomodoro.durations.v1';
export const AUDIO_VOLUME_KEY = 'ember.tools.audio.volume.v1';

export interface PomodoroDurationPreference {
  readonly focusMinutes: number;
  readonly shortBreakMinutes: number;
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function isMinutes(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= MIN_DURATION_MINUTES
    && value <= MAX_DURATION_MINUTES
  );
}

export function readPomodoroDurations(
  storage?: Storage | null,
): PomodoroDurationPreference | null {
  const target = storage ?? defaultStorage();
  if (target === null) return null;
  try {
    const raw = target.getItem(POMODORO_DURATIONS_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (!isMinutes(record.focusMinutes) || !isMinutes(record.shortBreakMinutes)) return null;
    return {
      focusMinutes: record.focusMinutes,
      shortBreakMinutes: record.shortBreakMinutes,
    };
  } catch {
    return null;
  }
}

export function writePomodoroDurations(
  preference: PomodoroDurationPreference,
  storage?: Storage | null,
): void {
  const target = storage ?? defaultStorage();
  if (target === null) return;
  try {
    target.setItem(POMODORO_DURATIONS_KEY, JSON.stringify(preference));
  } catch {
    /* 本地存储不可用时仅本次生效 */
  }
}

export function readAudioVolume(storage?: Storage | null): number | null {
  const target = storage ?? defaultStorage();
  if (target === null) return null;
  try {
    const raw = target.getItem(AUDIO_VOLUME_KEY);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
  } catch {
    return null;
  }
}

export function writeAudioVolume(volume: number, storage?: Storage | null): void {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) return;
  const target = storage ?? defaultStorage();
  if (target === null) return;
  try {
    target.setItem(AUDIO_VOLUME_KEY, String(volume));
  } catch {
    /* 本地存储不可用时仅本次生效 */
  }
}
