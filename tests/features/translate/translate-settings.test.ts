import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TRANSLATE_SETTINGS,
  loadTranslateSettings,
  saveTranslateSettings,
} from '../../../src/features/translate/translate-settings.ts';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => { map.delete(key); },
    setItem: (key: string, value: string) => { map.set(key, value); },
  };
}

void test('默认设置：AI 翻译 + 中文', () => {
  assert.deepEqual(loadTranslateSettings(memoryStorage()), DEFAULT_TRANSLATE_SETTINGS);
});

void test('保存后可读回联网翻译与目标语言', () => {
  const storage = memoryStorage();
  saveTranslateSettings({ mode: 'online', targetLang: '英文' }, storage);
  assert.deepEqual(loadTranslateSettings(storage), { mode: 'online', targetLang: '英文' });
});

void test('损坏或非法值回退默认', () => {
  const storage = memoryStorage();
  storage.setItem('ember.translate.settings.v1', '{bad json');
  assert.deepEqual(loadTranslateSettings(storage), DEFAULT_TRANSLATE_SETTINGS);

  storage.setItem('ember.translate.settings.v1', JSON.stringify({ mode: 'robot', targetLang: '火星文' }));
  assert.deepEqual(loadTranslateSettings(storage), DEFAULT_TRANSLATE_SETTINGS);
});
