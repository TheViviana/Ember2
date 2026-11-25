/**
 * AI 面板：端点配置 + 测试连接 + 模型列表 + 本地存储状态。
 *
 * 纯 features 组件：零 @tauri-apps、零 app imports、零 zustand。
 * 所有 IPC 调用由 AppShell 通过 effects props 注入。
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  AiEndpointRequest,
  AiKeySaveDto,
  AiKeyStatusDto,
  AiModelsDto,
  AiTestConnectionDto,
} from '../../types/ipc.ts';
import {
  AI_PROVIDER_PRESETS,
  canQueryModels,
  derivePresetId,
  inferAllowInsecureHttp,
  requiresApiKey,
  validateBaseUrl,
  type AiProvider,
  type AiProviderPreset,
} from './ai-endpoint.ts';
import { describeModelListError, mapAiErrorCode } from './ai-error-map.ts';
import {
  AI_PANEL_INITIAL,
  aiPanelReducer,
  type AiPanelState,
} from './ai-panel-reducer.ts';
import { AiChatView, type AiChatEffects } from './AiChatView.tsx';
import { useAiChatStore } from './ai-chat-store.ts';
import styles from './ai-panel.module.css';

// ─── Effects（AppShell 注入的 IPC 桥）──────────────────────────────

export interface AiPanelEffects extends AiChatEffects {
  saveKey(args: AiEndpointRequest & { key: string }): Promise<AiKeySaveDto>;
  deleteKey(args: AiEndpointRequest): Promise<null>;
  keyStatus(args: AiEndpointRequest): Promise<AiKeyStatusDto>;
  testConnection(args: AiEndpointRequest): Promise<AiTestConnectionDto>;
  listModels(args: AiEndpointRequest): Promise<AiModelsDto>;
}

// ─── Props ─────────────────────────────────────────────────────────

export interface AiPanelProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly effects: AiPanelEffects;
  /** 可选：外部已检测到的 configured/keychainAvailable（避免重复拉） */
  readonly initialStatus?: AiKeyStatusDto | null;
  /** CR-20261121-57：设置折叠面板初始状态——设置入口 → 展开，对话入口 → 收起。 */
  readonly initialTab?: 'settings' | 'chat';
}

// ─── Helpers ────────────────────────────────────────────────────────

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

// ─── Component ──────────────────────────────────────────────────────

export function AiPanel({ open, onClose, effects, initialStatus, initialTab }: AiPanelProps) {
  const chatConfig = useAiChatStore((state) => state.config);
  const setChatConfig = useAiChatStore((state) => state.setConfig);
  // CR-20261121-57：设置改为对话区顶部的折叠面板（收起态显示当前模型），不再分页签。
  const [settingsOpen, setSettingsOpen] = useState(initialTab === 'settings');

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
  const presetFocusRef = useRef<HTMLSelectElement | null>(null);

  // Esc 关闭（CR-18 §2.4）；窗口级 capture，避免被子控件截断。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  // 打开时焦点进入 Provider 的当前预设（CR-18 §2.4）。
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      presetFocusRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 面板打开时：一次性拉 key_status（限流，避免 AppShell 频繁触发）
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
      // key_status 失败不应阻塞面板；error 已由 Rust 记录
    }
  }, [effects, state]);

  // 对话视图常驻（CR-20261121-57）：openai-compatible 复核 Key 状态。
  useEffect(() => {
    if (!open) return;
    if (state.provider === 'ollama') return;
    void ensureKeyStatus();
  }, [open, state.provider, state.baseUrl, ensureKeyStatus]);

  // 生产商下拉切换：选中已知生产商 → 填入对应 BASE URL；
  // 选「自定义」→ 切到 OpenAI 兼容并保留当前 BASE URL 供用户手填。
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
    // Ollama 本地端点没有 Key 可存；Rust ai_key_save 会以空 key 报 E_AI_KEY_MISSING。
    // 保存入口在 Ollama 下不渲染，这里再兜一层，避免程序化触发。
    if (!requiresApiKey(state.provider)) return;
    // 基础校验
    const urlErr = validateBaseUrl(state.baseUrl);
    if (urlErr) {
      dispatch({ type: 'SAVE_FAIL', error: { code: undefined, message: urlErr } });
      return;
    }
    // openai-compatible 必填 key
    if (state.provider === 'openai-compatible' && state.key.trim().length === 0) {
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
      const dto = await effects.saveKey({ ...endpoint, key: state.key });
      const status = await effects.keyStatus(endpoint);
      dispatch({
        type: 'SAVE_OK',
        storage: dto.storage,
        warningCode: dto.warningCode ?? null,
        configured: status.configured,
        keychainAvailable: status.keychainAvailable,
      });
      // 成功后自动触发模型列表（openai-compatible + ollama 都可用）
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

  // 当面板刚打开且已配置过，自动拉模型
  // 用 ref 存最新的 bootstrap 依赖，避免 exhaustive-deps 要求把整个 state 放 deps
  const mountedRef = useRef(false);
  const bootstrapRef = useRef<{
    provider: AiProvider;
    configured: boolean;
    status: typeof state.status;
    modelsLen: number;
    handleListModels: () => void;
    ensureKeyStatus: () => void;
  } | null>(null);
  bootstrapRef.current = {
    provider: state.provider,
    configured: state.configured,
    status: state.status,
    modelsLen: state.models.length,
    handleListModels: () => { void handleListModels(); },
    ensureKeyStatus: () => { void ensureKeyStatus(); },
  };
  useEffect(() => {
    if (!open) {
      mountedRef.current = false;
      return;
    }
    if (!mountedRef.current) {
      mountedRef.current = true;
      const b = bootstrapRef.current;
      // Ollama 无需 key_status 的 configured 即可拉模型；openai-compatible 需已保存 Key。
      if (
        b !== null &&
        (b.provider === 'ollama' || b.configured) &&
        b.status !== 'loading_models' &&
        b.modelsLen === 0
      ) {
        b.handleListModels();
      }
      // Ollama 没有 Key 可查；跳过 key_status，避免它把 loading_models 覆盖成 idle。
      if (b !== null && b.provider !== 'ollama') b.ensureKeyStatus();
    }
  }, [open]);

  // 当前端点的 Key 语义：Ollama 无 Key，不显示保存/删除。
  const needsKey = requiresApiKey(state.provider);
  const modelsAvailable = canQueryModels(state.provider, state.configured);
  // 生产商下拉回显：BASE URL 不匹配任何已知生产商时显示「自定义」。
  const activePresetId = derivePresetId(state.baseUrl, state.provider);

  const errorMsg = mapError(state.error);
  const modelListError = state.status === 'models_fail' && state.error !== null
    ? describeModelListError(state.error.code, state.error.message)
    : null;
  const blocking = isBlockingStatus(state.status);

  // ─── Short-circuit：面板未挂载 ─────────────────────────────────
  if (!open) return null;

  return (
    <div className={styles.backdrop} role="presentation" onClick={onClose}>
      <div
        className={styles.panel}
        id="ai-panel"
        role="dialog"
        aria-label="AI 面板"
        onClick={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>
            <svg
              className={styles.titleIcon}
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z" />
              <path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z" />
              <path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17" />
            </svg>
            AI 助手
          </h2>
        </header>

        {/* CR-20261121-57：设置=对话区顶端折叠面板；收起态显示当前模型 */}
        <button
          type="button"
          className={styles.collapseToggle}
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((value) => !value)}
        >
          <span className={styles.collapseModel}>
            当前模型：{AI_PROVIDER_PRESETS.find((preset) => preset.id === activePresetId)?.label ?? '自定义'}
            （{state.selectedModel ?? '未选择'}）
          </span>
          <span className={styles.collapseChevron} aria-hidden="true">
            {settingsOpen ? '▾' : '▸'}
          </span>
        </button>

        <section
          id="ai-panel-settings"
          aria-label="AI 设置"
          className={styles.tabPanel}
          hidden={!settingsOpen}
        >
        {/* ── 生产商：选中即填入对应 BASE URL；「自定义」由用户手填 ── */}
        <section className={styles.section} aria-label="生产商">
          <label className={styles.sectionLabel} htmlFor="ai-producer">生产商</label>
          <select
            id="ai-producer"
            ref={presetFocusRef}
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

        {/* ── Base URL ── */}
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

        {/* ── Key（ollama 不显示） ── */}
        {needsKey ? (
          <section className={styles.section}>
            <label className={styles.sectionLabel} htmlFor="ai-key">API Key</label>
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

        {/* ── allowInsecureHttp 提示 ── */}
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

        {/* ── 状态区 ── */}
        {(!needsKey ||
          errorMsg !== null ||
          state.saveStorage !== null ||
          state.saveWarningCode !== null ||
          state.configured) ? (
          <section className={styles.section} aria-live="polite">
            {!needsKey ? (
              <p className={styles.infoBox}>
                Ollama 本地端点无需 API Key，可直接测试连接或拉取模型。
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

        {/* ── 模型列表 ── */}
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
                ? (needsKey ? '（未拉取，先保存 Key）' : '（点「重新拉取」获取本地模型）')
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

        {/* ── 操作按钮 ── */}
        <footer className={styles.actions}>
          {needsKey && state.configured ? (
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
          {needsKey ? (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => { void handleSave(); }}
              disabled={blocking}
            >
              {state.status === 'saving' ? '保存中…' : '保存 Key'}
            </button>
          ) : null}
        </footer>
        </section>

        <div className={styles.tabPanel} aria-label="AI 对话">
          <AiChatView effects={effects} configured={state.configured} />
        </div>
      </div>
    </div>
  );
}
