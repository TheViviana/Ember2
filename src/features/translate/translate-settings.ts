/** 翻译设置（与 AI 设置分离）：AI 翻译或联网翻译，本地持久化。 */
import {
  DEFAULT_TRANSLATE_LANGUAGE,
  TRANSLATE_LANGUAGES,
} from './translate-request.ts';

export type TranslateMode = 'ai' | 'online';

export interface TranslateSettings {
  readonly mode: TranslateMode;
  readonly targetLang: string;
}

const STORAGE_KEY = 'ember.translate.settings.v1';

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = Object.freeze({
  mode: 'ai',
  targetLang: DEFAULT_TRANSLATE_LANGUAGE,
});

function isMode(value: unknown): value is TranslateMode {
  return value === 'ai' || value === 'online';
}

function isLanguage(value: unknown): value is string {
  return typeof value === 'string' && TRANSLATE_LANGUAGES.includes(value);
}

function defaultStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function loadTranslateSettings(storage?: Storage | null): TranslateSettings {
  const target = storage ?? defaultStorage();
  if (target === null) return DEFAULT_TRANSLATE_SETTINGS;
  try {
    const raw = target.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_TRANSLATE_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_TRANSLATE_SETTINGS;
    const record = parsed as Record<string, unknown>;
    return {
      mode: isMode(record.mode) ? record.mode : DEFAULT_TRANSLATE_SETTINGS.mode,
      targetLang: isLanguage(record.targetLang)
        ? record.targetLang
        : DEFAULT_TRANSLATE_SETTINGS.targetLang,
    };
  } catch {
    return DEFAULT_TRANSLATE_SETTINGS;
  }
}

export function saveTranslateSettings(
  settings: TranslateSettings,
  storage?: Storage | null,
): void {
  const target = storage ?? defaultStorage();
  if (target === null) return;
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 本地存储不可用时仅本次生效，不阻断翻译。
  }
}
