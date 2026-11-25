/**
 * 翻译设置（CR-20261120-36）：与 AI 设置分开。
 * 支持 AI 翻译（复用 AI 设置）与联网翻译（公开翻译端点，无需 Key）。
 */
import { useEffect, useState } from 'react';
import { TRANSLATE_LANGUAGES } from './translate-request.ts';
import {
  loadTranslateSettings,
  saveTranslateSettings,
  type TranslateMode,
  type TranslateSettings,
} from './translate-settings.ts';
import styles from './translate-settings.module.css';

export interface TranslateSettingsPanelProps {
  readonly onClose: () => void;
  readonly onSaved?: (settings: TranslateSettings) => void;
}

export function TranslateSettingsPanel({ onClose, onSaved }: TranslateSettingsPanelProps) {
  const [settings, setSettings] = useState<TranslateSettings>(() => loadTranslateSettings());

  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  const chooseMode = (mode: TranslateMode): void => {
    setSettings((prev) => ({ ...prev, mode }));
  };

  const handleSave = (): void => {
    saveTranslateSettings(settings);
    onSaved?.(settings);
    onClose();
  };

  return (
    <div className={styles.host}>
      <div className={styles.backdrop} role="presentation">
        <section className={styles.panel} role="dialog" aria-modal="true" aria-label="翻译设置">
          <header className={styles.header}>
            <div>
              <h2 className={styles.title}>翻译设置</h2>
              <p className={styles.subtitle}>独立于 AI 对话配置</p>
            </div>
            <button type="button" className={styles.closeButton} onClick={onClose} aria-label="关闭翻译设置">
              ×
            </button>
          </header>

          <div className={styles.body}>
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>翻译方式</legend>
              <label className={settings.mode === 'ai' ? `${styles.option} ${styles.optionActive}` : styles.option}>
                <input
                  type="radio"
                  name="translate-mode"
                  value="ai"
                  checked={settings.mode === 'ai'}
                  onChange={() => chooseMode('ai')}
                />
                <span>
                  <span className={styles.optionTitle}>AI 翻译</span>
                  <span className={styles.optionDesc}>复用 AI 设置中的端点与模型，质量取决于所选模型</span>
                </span>
              </label>
              <label className={settings.mode === 'online' ? `${styles.option} ${styles.optionActive}` : styles.option}>
                <input
                  type="radio"
                  name="translate-mode"
                  value="online"
                  checked={settings.mode === 'online'}
                  onChange={() => chooseMode('online')}
                />
                <span>
                  <span className={styles.optionTitle}>联网翻译</span>
                  <span className={styles.optionDesc}>使用在线翻译服务（Google，失败时回退 MyMemory），无需 API Key</span>
                </span>
              </label>
            </fieldset>

            <label className={styles.field} htmlFor="translate-target-lang">
              <span className={styles.fieldLabel}>默认目标语言</span>
              <select
                id="translate-target-lang"
                className={styles.select}
                value={settings.targetLang}
                onChange={(event) => setSettings((prev) => ({ ...prev, targetLang: event.target.value }))}
              >
                {TRANSLATE_LANGUAGES.map((language) => (
                  <option key={language} value={language}>{language}</option>
                ))}
              </select>
            </label>
          </div>

          <footer className={styles.footer}>
            <button type="button" className={styles.ghostButton} onClick={onClose}>取消</button>
            <button type="button" className={styles.primaryButton} onClick={handleSave}>保存</button>
          </footer>
        </section>
      </div>
    </div>
  );
}
