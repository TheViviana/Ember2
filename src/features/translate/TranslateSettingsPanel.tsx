/**
 * 设置壳「AI / 翻译设置」页。
 *
 * 支持 AI 翻译（复用 AI 设置）与联网翻译（公开翻译端点，无需 Key）。
 * 去掉宿主 / 遮罩 / 标题 / 关闭按钮；保存后留在壳内并显示提示。
 */
import { useState } from 'react';
import { TRANSLATE_LANGUAGES } from './translate-request.ts';
import {
  loadTranslateSettings,
  saveTranslateSettings,
  type TranslateMode,
  type TranslateSettings,
} from './translate-settings.ts';
import styles from './translate-settings.module.css';

export interface TranslateSettingsBodyProps {
  readonly onSaved?: (settings: TranslateSettings) => void;
}

export function TranslateSettingsBody({ onSaved }: TranslateSettingsBodyProps) {
  const [settings, setSettings] = useState<TranslateSettings>(() => loadTranslateSettings());
  const [saved, setSaved] = useState(false);

  const chooseMode = (mode: TranslateMode): void => {
    setSettings((prev) => ({ ...prev, mode }));
    setSaved(false);
  };

  const handleSave = (): void => {
    saveTranslateSettings(settings);
    onSaved?.(settings);
    setSaved(true);
  };

  return (
    <div className={styles.root}>
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
            onChange={(event) => {
              setSettings((prev) => ({ ...prev, targetLang: event.target.value }));
              setSaved(false);
            }}
          >
            {TRANSLATE_LANGUAGES.map((language) => (
              <option key={language} value={language}>{language}</option>
            ))}
          </select>
        </label>
      </div>

      <footer className={styles.footer}>
        {saved ? <span className={styles.saved}>已保存</span> : null}
        <button type="button" className={styles.primaryButton} onClick={handleSave}>保存</button>
      </footer>
    </div>
  );
}
