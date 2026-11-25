/**
 * 2026-11-25：设置页要求「改完即存、重启不变」。
 * 效率工具（番茄钟时长、白噪音音量）此前只存在内存里，这里锁定持久化契约。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_VOLUME_KEY,
  POMODORO_DURATIONS_KEY,
  readAudioVolume,
  readPomodoroDurations,
  writeAudioVolume,
  writePomodoroDurations,
} from '../../../src/features/tools/tool-preferences.ts';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

void test('番茄钟时长写入后可按同名键读回', () => {
  const storage = memoryStorage();
  writePomodoroDurations({ focusMinutes: 45, shortBreakMinutes: 10 }, storage);
  assert.equal(storage.getItem(POMODORO_DURATIONS_KEY), '{"focusMinutes":45,"shortBreakMinutes":10}');
  assert.deepEqual(readPomodoroDurations(storage), { focusMinutes: 45, shortBreakMinutes: 10 });
});

void test('番茄钟时长缺省或越界时回退默认（返回 null）', () => {
  const storage = memoryStorage();
  assert.equal(readPomodoroDurations(storage), null);
  storage.setItem(POMODORO_DURATIONS_KEY, '{"focusMinutes":0,"shortBreakMinutes":5}');
  assert.equal(readPomodoroDurations(storage), null);
  storage.setItem(POMODORO_DURATIONS_KEY, 'not-json');
  assert.equal(readPomodoroDurations(storage), null);
});

void test('白噪音音量持久化并拒绝越界值', () => {
  const storage = memoryStorage();
  writeAudioVolume(0.62, storage);
  assert.equal(storage.getItem(AUDIO_VOLUME_KEY), '0.62');
  assert.equal(readAudioVolume(storage), 0.62);

  writeAudioVolume(1.4, storage);
  assert.equal(readAudioVolume(storage), 0.62, '越界写入不应覆盖旧值');
  storage.setItem(AUDIO_VOLUME_KEY, '2');
  assert.equal(readAudioVolume(storage), null);
});
