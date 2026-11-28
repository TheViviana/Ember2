/**
 * 设置壳「AI / AI 设置」页：端点、Key、模型与连接测试。
 *
 * 从 AiPanel 拆出；AI 对话浮窗只保留对话。外框由 SettingsShell 提供。
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AiEndpointRequest, AiKeyStatusDto } from '../../types/ipc.ts';
import {
  AI_PROVIDER_PRESETS,
  canQueryModels,
  derivePresetId,
  inferAllowInsecureHttp,
  isKeyOptional,
  requiresApiKey,
  validateBaseUrl,
  type AiProviderPreset,
} from './ai-endpoint.ts';
import { describeModelListError, mapAiErrorCode } from './ai-error-map.ts';
import { AI_PANEL_INITIAL, aiPanelReducer, type AiPanelState } from './ai-panel-reducer.ts';
import { useAiChatStore } from './ai-chat-store.ts';
import type { AiPanelEffects } from './AiPanel.tsx';
import styles from './ai-panel.module.css';

export interface AiSettingsBodyProps {
  readonly effects: AiPanelEffects;
  /** 可选：外部已检测到的 configured/keychainAvailable（避免重复拉） */
  readonly initialStatus?: AiKeyStatusDto | null;
}

function toEndpointRequest(state: AiPanelState): AiEndpointRequest {
  return {
    provider: state.provider,
    baseUrl: state.baseUrl,
    allowInsecureHttp: state.allowInsecureHttp,
  };
}

function isBlockingStatus(s: AiPanelState['status']): boolean {
  return s === 'saving' || s === 'deleting' || s === 'testing' || s === 'loading_models';
}

function mapError(e: AiPanelState['error']) {
  if (!e) return null;
  return mapAiErrorCode(e.code, e.message);
}

export function AiSettingsBody({ effects, initialStatus }: AiSettingsBodyProps) {
  const chatConfig = useAiChatStore((state) => state.config);
  const setChatConfig = useAiChatStore((state) => state.setConfig);

  const initialState: AiPanelState = (() => {
    const hydrated = aiPanelReducer(AI_PANEL_INITIAL, {
      type: 'HYDRATE',
      preset: chatConfig.preset,
      provider: chatConfig.provider,
      baseUrl: chatConfig.baseUrl,
      allowInsecureHttp: chatConfig.allowInsecureHttp,
      model: chatConfig.model,
    });
    return initialStatus
      ? aiPanelReducer(hydrated, {
        type: 'KEY_STATUS',
        configured: initialStatus.configured,
        keychainAvailable: initialStatus.keychainAvailable,
      })
      : hydrated;
  })();
  const [state, dispatch] = useReducer(aiPanelReducer, initialState);

  // 设置项变化写回内存 store；Key 永不进入 store。
  useEffect(() => {
    setChatConfig({
      preset: state.preset,
      provider: state.provider,
      baseUrl: state.baseUrl,
      allowInsecureHttp: state.allowInsecureHttp,
      model: state.selectedModel,
    });
  }, [
    setChatConfig,
    state.preset,
    state.provider,
    state.baseUrl,
    state.allowInsecureHttp,
    state.selectedModel,
  ]);

  const savingOpen = useRef(false);
  const lastStatusCheck = useRef(0);

  const ensureKeyStatus = useCallback(async () => {
    const now = Date.now();
    if (now - lastStatusCheck.current < 3000) return;
    lastStatusCheck.current = now;
    try {
      const dto = await effects.keyStatus(toEndpointRequest(state));
      dispatch({
        type: 'KEY_STATUS',
        configured: dto.configured,
        keychainAvailable: dto.keychainAvailable,
      });
    } catch {
      // key_status 失败不应阻塞设置页；error 已由 Rust 记录
    }
  }, [effects, state]);

  useEffect(() => {
    if (state.provider === 'ollama') return;
    void ensureKeyStatus();
  }, [state.provider, state.baseUrl, ensureKeyStatus]);

  const handleProducerChange = useCallback((id: AiProviderPreset) => {
    lastStatusCheck.current = 0;
    if (id === 'custom') {
      dispatch({
        type: 'SET_PROVIDER',
        preset: 'custom',
        provider: 'openai-compatible',
        defaultBaseUrl: state.baseUrl,
        inferAllowInsecure: inferAllowInsecureHttp(state.baseUrl),
      });
      return;
    }
    const preset = AI_PROVIDER_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    dispatch({
      type: 'SET_PROVIDER',
      preset: preset.id,
      provider: preset.provider,
      defaultBaseUrl: preset.defaultBaseUrl,
      inferAllowInsecure: inferAllowInsecureHttp(preset.defaultBaseUrl),
    });
  }, [state.baseUrl]);

  const handleBaseUrlChange = useCallback((value: string) => {
    lastStatusCheck.current = 0;
    dispatch({
      type: 'SET_BASE_URL',
      baseUrl: value,
      inferAllowInsecure: inferAllowInsecureHttp(value),
    });
  }, []);

  const handleKeyChange = useCallback((value: string) => {
    dispatch({ type: 'SET_KEY', key: value });
  }, []);

  const handleAllowInsecureChange = useCallback((value: boolean) => {
    dispatch({ type: 'SET_ALLOW_INSECURE_HTTP', value });
  }, []);

  const handleSave = useCallback(async () => {
    const keyRequired = requiresApiKey(state.provider);
    if (!keyRequired && !isKeyOptional(state.provider)) return;
    const urlErr = validateBaseUrl(state.baseUrl);
    if (urlErr) {
      dispatch({ type: 'SAVE_FAIL', error: { code: undefined, message: urlErr } });
      return;
    }
    const key = state.key.trim();
    if (keyRequired && key.length === 0) {
      dispatch({
        type: 'SAVE_FAIL',
        error: { code: 'E_AI_KEY_MISSING', message: 'API Key 不能为空' },
      });
      return;
    }
    if (savingOpen.current) return;
    savingOpen.current = true;
    dispatch({ type: 'SAVE_START' });
    try {
      const endpoint = toEndpointRequest(state);
      // 本地端点 Key 可选：留空时不写密钥，直接拉模型验证端点可达。
      if (key.length > 0) {
        const dto = await effects.saveKey({ ...endpoint, key });
        const status = await effects.keyStatus(endpoint);
        dispatch({
          type: 'SAVE_OK',
          storage: dto.storage,
          warningCode: dto.warningCode ?? null,
          configured: status.configured,
          keychainAvailable: status.keychainAvailable,
        });
      }
      dispatch({ type: 'MODELS_START' });
      try {
        const models = await effects.listModels(endpoint);
        dispatch({ type: 'MODELS_OK', models: models.models });
      } catch (e) {
        const err = (e as { code?: string; message: string });
        dispatch({ type: 'MODELS_FAIL', error: { code: err.code, message: err.message } });
      }
    } catch (e) {
      const err = e as { code?: string; message: string };
      dispatch({ type: 'SAVE_FAIL', error: { code: err.code, message: err.message } });
    } finally {
      savingOpen.current = false;
    }
  }, [effects, state]);

  const handleDelete = useCallback(async () => {
    const endpoint = toEndpointRequest(state);
    dispatch({ type: 'DELETE_START' });
    try {
      await effects.deleteKey(endpoint);
      dispatch({ type: 'DELETE_OK' });
    } catch (e) {
      const err = e as { code?: string; message: string };
      dispatch({ type: 'DELETE_FAIL', error: { code: err.code, message: err.message } });
    }
  }, [effects, state]);

  const handleTest = useCallback(async () => {
    const urlErr = validateBaseUrl(state.baseUrl);
    if (urlErr) {
      dispatch({ type: 'TEST_FAIL', error: { code: undefined, message: urlErr } });
      return;
    }
    dispatch({ type: 'TEST_START' });
    try {
      await effects.testConnection(toEndpointRequest(state));
      dispatch({ type: 'TEST_OK' });
    } catch (e) {
      const err = e as { code?: string; message: string };
      dispatch({ type: 'TEST_FAIL', error: { code: err.code, message: err.message } });
    }
  }, [effects, state]);

  const handleListModels = useCallback(async () => {
    const endpoint = toEndpointRequest(state);
    dispatch({ type: 'MODELS_START' });
    try {
      const dto = await effects.listModels(endpoint);
      dispatch({ type: 'MODELS_OK', models: dto.models });
    } catch (e) {
      const err = e as { code?: string; message: string };
      dispatch({ type: 'MODELS_FAIL', error: { code: err.code, message: err.message } });
    }
  }, [effects, state]);

  const handleSelectModel = useCallback((value: string | null) => {
    dispatch({ type: 'SELECT_MODEL', model: value });
  }, []);

  // 首次挂载：已配置或 Ollama 时自动拉模型。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (state.status === 'loading_models' || state.models.length > 0) return;
    if (!requiresApiKey(state.provider) || state.configured) void handleListModels();
  }, [handleListModels, state.configured, state.models.length, state.provider, state.status]);

  const needsKey = requiresApiKey(state.provider);
  const keyOptional = isKeyOptional(state.provider);
  const showKeyField = needsKey || keyOptional;
  const modelsAvailable = canQueryModels(state.provider, state.configured);
  const activePresetId = derivePresetId(state.baseUrl, state.provider);
  const errorMsg = mapError(state.error);
  const modelListError = state.status === 'models_fail' && state.error !== null
    ? describeModelListError(state.error.code, state.error.message)
    : null;
  const blocking = isBlockingStatus(state.status);

  return (
    <div className={styles.settingsBody}>
      <section className={styles.section} aria-label="生产商">
        <label className={styles.sectionLabel} htmlFor="ai-producer">生产商</label>
        <select
          id="ai-producer"
          className={styles.select}
          value={activePresetId}
          onChange={(e) => handleProducerChange(e.target.value as AiProviderPreset)}
          disabled={blocking}
        >
          {AI_PROVIDER_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
          <option value="custom">自定义（手动填写 BASE URL）</option>
        </select>
      </section>

      <section className={styles.section}>
        <label className={styles.sectionLabel} htmlFor="ai-base-url">Base URL</label>
        <input
          id="ai-base-url"
          type="url"
          className={styles.input}
          value={state.baseUrl}
          onChange={(e) => handleBaseUrlChange(e.target.value)}
          placeholder="https://api.openai.com/v1"
          disabled={blocking}
        />
      </section>

      {showKeyField ? (
        <section className={styles.section}>
          <label className={styles.sectionLabel} htmlFor="ai-key">
            API Key{keyOptional ? '（可选）' : ''}
          </label>
          <input
            id="ai-key"
            type="password"
            className={styles.input}
            value={state.key}
            onChange={(e) => handleKeyChange(e.target.value)}
            placeholder="sk-..."
            disabled={blocking}
            autoComplete="off"
          />
        </section>
      ) : null}

      <section className={styles.section}>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={state.allowInsecureHttp}
            onChange={(e) => handleAllowInsecureChange(e.target.checked)}
            disabled={blocking}
          />
          <span>允许不安全 HTTP（非回环地址需手动勾选）</span>
        </label>
      </section>

      {(!needsKey ||
        errorMsg !== null ||
        state.saveStorage !== null ||
        state.saveWarningCode !== null ||
        state.configured) ? (
        <section className={styles.section} aria-live="polite">
          {state.provider === 'ollama' ? (
            <p className={styles.infoBox}>Ollama 本地端点无需 API Key，可直接测试连接或拉取模型。</p>
          ) : keyOptional ? (
            <p className={styles.infoBox}>
              本地端点 API Key 可选：留空即可直接访问；服务端要求鉴权时再填写。
            </p>
          ) : null}
          {state.saveStorage ? (
            <p className={styles.successBox}>
              已保存至 <strong>{state.saveStorage === 'file' ? '本地存储' : '进程内存'}</strong>
              {state.saveWarningCode === 'E_AI_KEYCHAIN_DENIED'
                ? '（写入本地失败，降级为内存；重启后需重填）'
                : null}
            </p>
          ) : null}
          {errorMsg && state.status !== 'models_fail' ? (
            <p className={errorMsg.tone === 'error' ? styles.errorBox : styles.warningBox}>
              {errorMsg.text}
            </p>
          ) : null}
          {state.configured && !state.saveStorage ? (
            <p className={styles.infoBox}>端点已配置</p>
          ) : null}
        </section>
      ) : null}

      <section className={styles.section}>
        <div className={styles.modelsHeader}>
          <label className={styles.sectionLabel} htmlFor="ai-model">模型</label>
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => { void handleListModels(); }}
            disabled={blocking || !modelsAvailable}
          >
            {state.status === 'loading_models' ? '拉取中…' : '重新拉取'}
          </button>
        </div>
        <select
          id="ai-model"
          className={styles.select}
          value={state.selectedModel ?? ''}
          onChange={(e) => handleSelectModel(e.target.value || null)}
          disabled={blocking || state.models.length === 0}
        >
          <option value="">
            {state.models.length === 0
              ? (modelsAvailable ? '（点「重新拉取」获取模型）' : '（未拉取，先保存 Key）')
              : '请选择…'}
          </option>
          {state.models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        {state.status === 'models_empty' ? (
          <p className={styles.infoBox}>该 provider 未返回任何模型</p>
        ) : null}
        {modelListError !== null ? (
          <p className={modelListError.tone === 'error' ? styles.errorBox : styles.warningBox}>
            {modelListError.text}
          </p>
        ) : null}
        <label className={styles.sectionLabel} htmlFor="ai-model-manual">模型 ID（手动）</label>
        <input
          id="ai-model-manual"
          className={styles.input}
          type="text"
          placeholder="例如 gpt-oss:20b"
          value={state.selectedModel ?? ''}
          onChange={(e) => handleSelectModel(e.target.value.trim() || null)}
          disabled={blocking}
        />
      </section>

      <footer className={styles.actions}>
        {showKeyField && state.configured ? (
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={() => { void handleDelete(); }}
            disabled={blocking}
          >
            删除 Key
          </button>
        ) : null}
        <span className={styles.actionsSpacer} />
        <button
          type="button"
          className={styles.ghostBtn}
          onClick={() => { void handleTest(); }}
          disabled={blocking}
        >
          {state.status === 'testing' ? '测试中…' : '测试连接'}
        </button>
        {showKeyField ? (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => { void handleSave(); }}
            disabled={blocking}
          >
            {state.status === 'saving'
              ? '保存中…'
              : needsKey ? '保存 Key' : '保存 Key（可选）'}
          </button>
        ) : null}
      </footer>
    </div>
  );
}
