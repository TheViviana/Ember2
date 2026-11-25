/**
 * 应用壳：顶栏 + 中央主区 + 左右可折叠边缘面板（C0-C R9=D）。
 *
 * - 主区默认画布模式；画布模式替换 EditorLauncher，文档模式恢复；
 * - 画布位于 #window-layer 之下，浮窗叠加契约不变；
 * - 模式/当前画布只保留会话内状态，不跨启动持久化。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Topbar } from '../chrome/Topbar';
import { DocumentList } from '../panels/DocumentList';
import { StatusBar } from '../panels/StatusBar';
import { WindowLayer } from '../../windows/WindowLayer';
import {
  cascadeWindows,
  getViewport,
  getWindowSnapshot,
  openWindow,
  tileWindows,
  useWindowManager,
} from '../../windows/use-window-manager.ts';
import { hasTileOverlap } from '../../windows/manager.ts';
import { EDITOR_WINDOW_CONTENT } from '../../windows/content-types.ts';
import { useTreeStore } from '../stores/tree-store';
import { useNoticeStore, pushNotice } from '../stores/notice-store';
import { requestWindowClose, useCloseFlowStore } from '../stores/close-flow-store';
import { useShellRequestStore } from './shell-requests.ts';
import {
  useCanvasSessionStore,
  type WorkspaceMode,
} from '../stores/canvas-session-store';
import { useEmberStore } from '../stores/ember-store';
import { useEditorModeRequestStore } from '../stores/editor-mode-requests.ts';
import { CanvasView, type CanvasViewController } from '../canvas/CanvasView';
import { BoardView } from '../../features/board/BoardView';
import type { BoardLink } from '../../features/board/model.ts';
import { DocNewInput } from '../panels/DocNewInput';
import type { SubmenuAnchorRect } from '../canvas/doc-submenu-model.ts';
import { KEY_ZOOM_FACTOR } from '../canvas/engine';
import type { CanvasDocumentStore } from '../canvas/engine';
import { createEdgePanelController } from './edge-panel-state';
import { EdgePanel } from './EdgePanel';
import {
  createCommandRegistry,
  createCommandExecutor,
  type Command,
} from '../../features/commands/bus';
import type {
  CommandAbilities,
  CommandContext,
  CommandContextSnapshot,
} from '../../features/commands/context';
import { COMMAND_DEFINITIONS } from '../../features/commands/commands';
import type { KnownCommandId } from '../../features/commands/ids';
import {
  formatBindingList,
  loadCommandBindings,
  saveCommandBindings,
  type CommandBindingMap,
} from '../../features/commands/bindings.ts';
import { dispatchCommandKeybinding } from '../../features/commands/keybinding-dispatcher.ts';
import {
  CommandPaletteComponent,
  useCommandPalette,
} from '../../features/commands/palette';
import { ShortcutSettings } from '../../features/settings/ShortcutSettings.tsx';
import { SettingsMenu } from '../../features/settings/SettingsMenu.tsx';
import { AppearancePanel } from '../../features/settings/AppearancePanel.tsx';
import { buildSettingsSections } from '../../features/settings/settings-menu-model.ts';
import { LibrarySettingsPanel } from '../panels/LibrarySettingsPanel.tsx';
import { TranslateSettingsPanel } from '../../features/translate/TranslateSettingsPanel.tsx';
import { UpdatePanel } from '../../features/updater/UpdatePanel.tsx';
import { loadAutoCheck } from '../../features/updater/model.ts';
import { updaterPort } from '../../data/updater-port.ts';
import { NEXT_WINDOW_TARGET, armRenderFault } from '../../windows/dev-render-fault.ts';
import { createTauriDragDropPort } from '../../data/drag-drop-port.ts';
import { routeNativeDrop } from '../dnd/native-drop-router.ts';
import { resolveFinderDocumentPath } from '../canvas/canvas-interactions.ts';
import { AiPanelHost, type AiPanelEffects } from '../../features/ai/AiPanelHost';
import { aiApi, backupApi, docApi, historyApi, trashApi, vaultApi } from '../../data/app-api.ts';
import type { EmberIpcError } from '../../data/ipc-client.ts';
import { openDirectory, openMarkdownFiles } from '../../data/dialog.ts';
import { onTrashSweep } from '../../data/ipc-events.ts';
import { formatSweepNotice } from './trash-sweep-notice';
import { BackupPanel, type BackupPanelEffects } from '../../features/backup/index.ts';
import { InboxPanelHost } from '../panels/InboxPanelHost.tsx';
import { addFileItems, type InboxItem } from '../../features/collect/model.ts';
import { loadInboxItems, saveInboxItems } from '../../features/collect/storage.ts';
import {
  ImportDialog,
  type ImportDialogEffects,
} from '../../features/import/ImportDialog.tsx';
import { defaultImportTarget } from '../../features/import/import-runner.ts';
import { ReplacePanel } from '../../features/replace/ReplacePanel.tsx';
import type { ReplaceRunnerEffects } from '../../features/replace/replace-runner.ts';
import { HealthPanel } from '../../features/health/HealthPanel.tsx';
import type { HealthPanelEffects } from '../../features/health/health-flow.ts';
import { HistoryPanel } from '../../features/history/HistoryPanel.tsx';
import type { HistoryPanelEffects } from '../../features/history/history-flow.ts';
import { ToolsPanel } from '../../features/tools/ToolsPanel.tsx';
import { useTranslateStore } from '../translate/translate-store.ts';
import { RecoveryDemoPanel } from '../../windows/RecoveryDemoPanel.tsx';
import { Z_MODAL } from '../../windows/layer-z.ts';
import { readDocumentId } from '../../core/document-source.ts';
import { AiChatButton } from './AiChatButton.tsx';
import { INITIAL_SHELL_PANELS, shellPanelsReducer } from './shell-panels.ts';
import { resolveSettingsAction } from './settings-actions.ts';
import { SETTINGS_ENTRIES } from './settings-registry.ts';
import { ShellNotices } from './ShellNotices';
import { useToolControllers } from './use-tool-controllers.ts';
import { useCanvasReveal } from './use-canvas-reveal.ts';
import styles from './AppShell.module.css';

export interface AppShellProps {
  readonly closeError: string | null;
  readonly guardError: string | null;
}

function visibleWindowIds(): string[] {
  return getWindowSnapshot()
    .windows.filter((w) => !w.minimized)
    .map((w) => w.id);
}

export function AppShell({ closeError, guardError }: AppShellProps) {
  const [tileHint, setTileHint] = useState<string | null>(null);
  const [panels, dispatchPanels] = useReducer(shellPanelsReducer, INITIAL_SHELL_PANELS);
  const immersive = useEditorModeRequestStore((state) => state.immersive);
  // §10 沉浸只在编辑器窗口存续期间有效：最后一个编辑器窗口关闭（任一关窗路径）即自动复位。
  const windowSnapshot = useWindowManager();
  const editorWindowCount = windowSnapshot.windows.filter(
    (record) => record.contentType === EDITOR_WINDOW_CONTENT,
  ).length;
  useEffect(() => {
    if (editorWindowCount === 0) {
      useEditorModeRequestStore.getState().clearImmersive();
    }
  }, [editorWindowCount]);
  // §10 统一单窗口：「打开阅读浮窗」=打开（已开则聚焦/还原）编辑器窗口并切到阅读模式。
  const handleOpenReadMode = useCallback(
    (payload: { readonly docPath: string; readonly title: string; readonly sourceNodeId: string }): void => {
      openWindow(payload.docPath, EDITOR_WINDOW_CONTENT, getViewport());
      useEditorModeRequestStore.getState().requestMode(payload.docPath, 'read');
    },
    [],
  );
  const [initialBindings] = useState(() => loadCommandBindings(window.localStorage, COMMAND_DEFINITIONS));
  const [commandBindings, setCommandBindings] = useState<CommandBindingMap>(initialBindings.bindings);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasSettingsOpen = useRef(false);
  const noticeItems = useNoticeStore((state) => state.items);
  const dismissNotice = useNoticeStore((state) => state.dismiss);
  const closeViews = useCloseFlowStore((state) => state.views);
  const translateSettingsRequested = useShellRequestStore(
    (state) => state.translateSettingsRequested,
  );
  const consumeTranslateSettingsRequest = useShellRequestStore(
    (state) => state.consumeTranslateSettingsRequest,
  );

  // CR-20261120-40 C：内容组件请求打开翻译设置（AI 未配置引导），每会话只弹一次。
  useEffect(() => {
    if (!translateSettingsRequested) return;
    dispatchPanels({ type: 'open', panel: 'translate' });
    consumeTranslateSettingsRequest();
  }, [translateSettingsRequested, consumeTranslateSettingsRequest]);

  // CR-18 §2.4：浮窗关闭后把焦点还给 Topbar 的设置按钮。
  useEffect(() => {
    if (wasSettingsOpen.current && !panels.open.settings) {
      settingsButtonRef.current?.focus();
    }
    wasSettingsOpen.current = panels.open.settings;
  }, [panels.open.settings]);

  // P7：按机器本地开关做一次静默更新检查。占位 endpoint 失败只记录，不打断启动。
  useEffect(() => {
    if (!loadAutoCheck(window.localStorage)) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void updaterPort.check().then((pending) => {
        if (disposed || pending === null) return;
        pushNotice(`发现新版本 ${pending.version}：可在「设置 → 检查更新」中安装`, 'info');
      }).catch((cause: unknown) => {
        console.warn('启动静默更新检查失败', cause);
      });
    }, 2000);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, []);

  // CR-20261122-61：启动清扫报告接入通知——`vault://trash-sweep` 此前无前端消费者，
  // 报告被静默丢弃。有跳过/失败/移除才提示，无变化静默；订阅异步返回，
  // 退订按 StrictMode 双挂载语义处理（先挂载先退订）。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void onTrashSweep((report) => {
      const notice = formatSweepNotice(report);
      if (notice !== null) pushNotice(notice.message, notice.tone);
    }).then((off) => {
      if (disposed) off();
      else unlisten = off;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const mode = useCanvasSessionStore((state) => state.mode);
  const setMode = useCanvasSessionStore((state) => state.setMode);
  const activeCanvasId = useCanvasSessionStore((state) => state.activeCanvasId);
  const setActiveCanvasId = useCanvasSessionStore((state) => state.setActiveCanvasId);

  const openCanvas = useEmberStore((state) => state.openCanvas);
  const saveCanvas = useEmberStore((state) => state.saveCanvas);
  const flushCanvases = useEmberStore((state) => state.flushCanvases);
  const beginCanvasClosing = useEmberStore((state) => state.beginCanvasClosing);
  const canvasRegistry = useEmberStore((state) => state.canvasRegistry);

  const canvasStore = useMemo<CanvasDocumentStore>(
    () => ({
      open: (id) => openCanvas(id),
      save: (id, text) => saveCanvas(id, text),
      flush: (options) => flushCanvases(options),
      beginClosing: () => beginCanvasClosing(),
    }),
    [openCanvas, saveCanvas, flushCanvases, beginCanvasClosing],
  );

  const canvasRef = useRef<CanvasViewController | null>(null);
  const listCanvases = useEmberStore((state) => state.listCanvases);

  // ─── Command 系统（CR-20261119-13）──────────────────────────
  const activePath = useTreeStore((state) => state.activePath);
  const vaultIdentity = useEmberStore((state) => state.identity);

  // 看板首屏只消费 T0 索引；docs 每次变更生成新数组供 BoardView 重算 KPI。
  const vaultDocs = useEmberStore((state) => state.index.docs);
  const linkIndex = useEmberStore((state) => state.linkIndex);
  const ensureLinkIndex = useEmberStore((state) => state.ensureLinkIndex);
  const boardDocs = useMemo(
    () =>
      [...vaultDocs.values()].map((doc) => ({
        path: doc.path,
        sha256: doc.sha256,
        bytes: doc.bytes,
        modifiedMs: doc.modifiedMs,
      })),
    [vaultDocs],
  );

  // 只读态：从 VaultIdentityDto.readonly 读取；vault 未连接时当作 false（已由 vaultIdentity null 挡在 isEnabled 外）
  const readonly = vaultIdentity?.readonly ?? false;
  const vaultId = vaultIdentity?.vaultId ?? null;

  // S3：看板雷达需要文档间连线密度；进入看板时惰性构建全库链接索引。
  useEffect(() => {
    if (mode === 'docs' && vaultId !== null) ensureLinkIndex();
  }, [ensureLinkIndex, mode, vaultId]);

  const boardLinks = useMemo<BoardLink[]>(() => {
    if (linkIndex === null) return [];
    const edges: BoardLink[] = [];
    for (const [target, sources] of linkIndex.backlinks) {
      for (const source of sources) edges.push({ from: source.path, to: target });
    }
    return edges;
  }, [linkIndex]);
  const [inboxVaultId, setInboxVaultId] = useState<string | null>(null);
  const [inboxItems, setInboxItems] = useState<readonly InboxItem[]>([]);
  const [inboxLoadWarning, setInboxLoadWarning] = useState<string | null>(null);
  const [inboxPersistenceError, setInboxPersistenceError] = useState<string | null>(null);
  const [importRequest, setImportRequest] = useState<{
    readonly key: string;
    readonly vaultId: string;
    readonly paths: readonly string[];
  } | null>(null);
  const currentInboxItems = useMemo(
    () => inboxVaultId === vaultId ? inboxItems : [],
    [inboxItems, inboxVaultId, vaultId],
  );

  useEffect(() => {
    setImportRequest(null);
    setInboxVaultId(vaultId);
    setInboxPersistenceError(null);
    if (vaultId === null) {
      setInboxItems([]);
      setInboxLoadWarning(null);
      return;
    }
    const loaded = loadInboxItems(window.localStorage, vaultId);
    setInboxItems(loaded.items);
    setInboxLoadWarning(loaded.warning);
    if (loaded.warning !== null) pushNotice(loaded.warning, 'warning');
  }, [vaultId]);

  const commitInboxItems = useCallback((items: readonly InboxItem[]): void => {
    if (vaultId === null) {
      setInboxPersistenceError('本次更改未持久化：尚未连接知识库');
      return;
    }
    const failure = saveInboxItems(window.localStorage, vaultId, items);
    setInboxVaultId(vaultId);
    setInboxItems(items);
    setInboxPersistenceError(failure);
  }, [vaultId]);

  const handleCollectFiles = useCallback((paths: readonly string[]): void => {
    if (vaultId === null || paths.length === 0) return;
    const collected = addFileItems(currentInboxItems, paths, {
      id: () => globalThis.crypto.randomUUID(),
      now: () => Date.now(),
    });
    if (collected.added > 0) {
      commitInboxItems(collected.items);
      pushNotice(`已收集 ${collected.added} 个文件引用；源文件未复制`, 'info');
    }
    dispatchPanels({ type: 'open', panel: 'inbox' });
  }, [commitInboxItems, currentInboxItems, vaultId]);

  const openImportDialog = useCallback((paths: readonly string[] = []): void => {
    if (vaultId === null) {
      pushNotice('尚未连接知识库，无法导入文档', 'warning');
      return;
    }
    if (readonly) {
      pushNotice('知识库只读，无法导入文档', 'warning');
      return;
    }
    setImportRequest({ key: globalThis.crypto.randomUUID(), vaultId, paths });
  }, [readonly, vaultId]);

  /**
   * CR-20261120-34 D5：Finder 拖到编辑器窗口。
   * `.md/.txt` 且位于库内 → 直接开编辑窗；其余（含库外 md/txt）走既有导入对话框。
   */
  const openDroppedInEditor = useCallback((paths: readonly string[]): void => {
    const state = useEmberStore.getState();
    const root = state.identity?.root ?? null;
    const openPaths: string[] = [];
    const importPaths: string[] = [];
    for (const path of paths) {
      const extension = path.toLowerCase().split('.').pop() ?? '';
      if (extension !== 'md' && extension !== 'txt') {
        importPaths.push(path);
        continue;
      }
      const resolved = resolveFinderDocumentPath(path, root, (rel) => state.index.docs.has(rel));
      if (resolved.kind === 'external') importPaths.push(path);
      else openPaths.push(resolved.path);
    }
    for (const path of openPaths) openWindow(path, EDITOR_WINDOW_CONTENT, getViewport());
    if (importPaths.length > 0) openImportDialog(importPaths);
  }, [openImportDialog]);

  const importEffects = useMemo<ImportDialogEffects>(() => ({
    pickFiles: openMarkdownFiles,
    flush: () => useEmberStore.getState().flushDocs(),
    importFile: (sourcePath, targetDir, conflict) =>
      vaultApi.import(sourcePath, targetDir, conflict),
    reconcile: (path) => useEmberStore.getState().reconcilePaths([path]),
  }), []);

  // ─── P6：搜索替换 / 健康 / 历史 / 效率工具 ──────────────────

  // 工具状态随 AppShell 生命周期存活：面板关闭不暂停/重置，卸载才释放。
  const { pomodoro, audio } = useToolControllers();

  const replaceEffects = useMemo<ReplaceRunnerEffects>(() => ({
    scan: () => vaultApi.scan(),
    read: (path) => docApi.read(path),
    flush: () => useEmberStore.getState().flushDocs(),
    replace: (items) => vaultApi.replace(items),
    reconcile: (paths) => useEmberStore.getState().reconcilePaths(paths),
    yieldControl: () => new Promise<void>((resolve) => { setTimeout(resolve, 0); }),
  }), []);

  const healthEffects = useMemo<HealthPanelEffects>(() => ({
    list: async () => (await trashApi.list()).entries,
    cleanup: (ids) => trashApi.cleanup(ids),
  }), []);

  const historyEffects = useMemo<HistoryPanelEffects>(() => ({
    list: (docId) => historyApi.list(docId),
    read: async (docId, version) => ({
      text: (await historyApi.read(docId, version)).text,
    }),
    readCurrent: async (path) => {
      const current = await docApi.read(path);
      return { text: current.text, sha256: current.sha256 };
    },
    flush: () => useEmberStore.getState().flushDocs(),
    restore: (request) => historyApi.restore(request),
    delete: (docId, version) => historyApi.delete(docId, version),
    purge: (docId) => historyApi.purge(docId),
    reconcile: (path) => useEmberStore.getState().reconcilePaths([path]),
  }), []);

  const openDocs = useEmberStore((state) => state.docs);
  const activeDocId = useMemo(() => {
    if (activePath === null) return null;
    const doc = openDocs.get(activePath);
    return doc === undefined ? null : readDocumentId(doc.text);
  }, [activePath, openDocs]);

  // ─── 统一设置菜单（CR-20261120-35）────────────────────────────
  // 单层菜单：分组标题可折叠，入口直接列在标题下，不再有左侧分类/右侧列表。
  const settingsSections = useMemo(
    () => buildSettingsSections(SETTINGS_ENTRIES, {
      vaultId,
      readonly,
      activePath,
      dev: import.meta.env.DEV,
    }),
    [vaultId, readonly, activePath],
  );

  const handleSettingsSelect = useCallback((id: string): void => {
    dispatchPanels({ type: 'close', panel: 'settings' });
    const action = resolveSettingsAction(id);
    if (action === null) return;
    if (action.kind === 'panel') {
      if (action.panel === 'ai') dispatchPanels({ type: 'setAiTab', tab: 'settings' });
      dispatchPanels({ type: 'open', panel: action.panel });
      return;
    }
    if (action.id === 'import') {
      openImportDialog();
      return;
    }
    if (armRenderFault(NEXT_WINDOW_TARGET, window.localStorage)) {
      pushNotice('已布置渲染异常：下一个打开或重新打开的窗口会显示错误边界', 'info');
    } else {
      pushNotice('布置渲染异常失败：本地存储不可用', 'error');
    }
  }, [openImportDialog]);

  // 左侧圆形按钮：对话页展开/收起；不因点击空白自动关闭。
  // CR-20261121-58：右键菜单快捷键加速器（从命令绑定表格式化；与设置面板同一绑定源）
  const menuAccelerators = useMemo(() => {
    const fmt = (id: string): string => formatBindingList(commandBindings[id] ?? []);
    return {
      addText: fmt('canvas.add_text'),
      addAi: fmt('canvas.add_ai'),
      addPrompt: fmt('canvas.add_prompt'),
    };
  }, [commandBindings]);

  const handleToggleChat = useCallback((): void => {
    if (panels.open.ai && panels.aiTab === 'chat') {
      dispatchPanels({ type: 'close', panel: 'ai' });
      return;
    }
    dispatchPanels({ type: 'setAiTab', tab: 'chat' });
    dispatchPanels({ type: 'open', panel: 'ai' });
  }, [panels.open.ai, panels.aiTab]);

  // registry + executor（单例，useMemo 只创建一次）
  const registry = useMemo(() => createCommandRegistry(), []);
  const executor = useMemo(() => createCommandExecutor(registry), [registry]);

  // palette 可见性
  const palette = useCommandPalette(executor);
  const paletteOpenRef = useRef(palette.open);
  paletteOpenRef.current = palette.open;

  useEffect(() => {
    if (initialBindings.warning !== null) pushNotice(initialBindings.warning, 'warning');
  }, [initialBindings.warning]);

  // abilities
  const abilities: CommandAbilities = useMemo(
    () => ({
      pushNotice: (message, tone) => pushNotice(message, tone === 'info' ? 'info' : tone === 'warning' ? 'warning' : 'error'),
    }),
    [],
  );

  // ─── AI Panel effects：桥接 app-api → AiPanelEffects ──
  // EmberIpcError.rawCode 保留原始 E_AI_* 码；message 由 Rust 侧构造。
  function rethrow(e: unknown): Error {
    const err = e as EmberIpcError;
    const wrapped = new Error(err.message);
    (wrapped as { code?: string }).code = err.rawCode;
    return wrapped;
  }
  const aiEffects: AiPanelEffects = useMemo(() => ({
    async saveKey(args) {
      try {
        return await aiApi.keySave(args);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async deleteKey(args) {
      try {
        return await aiApi.keyDelete(args);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async keyStatus(args) {
      try {
        return await aiApi.keyStatus(args);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async testConnection(args) {
      try {
        return await aiApi.testConnection(args);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async listModels(args) {
      try {
        return await aiApi.listModels(args);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async chatStream(request, handlers) {
      try {
        await aiApi.chatStream(request, {
          onDelta: (event) => handlers.onDelta(event),
          onDone: (event) => handlers.onDone(event),
          onError: (_error, event) => handlers.onError(event),
        });
      } catch (e) {
        throw rethrow(e);
      }
    },
    async cancelChat(requestId) {
      try {
        return await aiApi.cancel(requestId);
      } catch (e) {
        throw rethrow(e);
      }
    },
  }), []);

  // ─── Backup Panel effects：桥接 app-api → BackupPanelEffects ──
  // CR-20261119-22 §3 D1：destination 语义三分——validate 收已存在父目录；
  // export / inspect 收 <父目录>/<backupName> 子路径（export 须不存在，inspect 须存在）。
  const backupEffects: BackupPanelEffects = useMemo(() => ({
    async pickDirectory() {
      return openDirectory();
    },
    async validateDestination(parentDir) {
      try {
        return await backupApi.destination(parentDir);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async exportBackup(destination) {
      try {
        return await backupApi.export(destination);
      } catch (e) {
        throw rethrow(e);
      }
    },
    async inspectBackup(destination) {
      try {
        return await backupApi.inspect(destination);
      } catch (e) {
        throw rethrow(e);
      }
    },
  }), []);

  // snapshot 构造（每次 palette 打开/执行时实时调用）
  const buildSnapshot = useCallback((): CommandContextSnapshot => {
    const engine = canvasRef.current?.getEngine();
    const windowSnap = getWindowSnapshot();
    const minimized = windowSnap.windows.filter((w) => w.minimized);
    // 活动窗口：第一个非 minimized 窗口的 id（WindowLayer 内部已有 focus 逻辑，这里用简单规则）
    const activeWin = windowSnap.windows.find((w) => !w.minimized);
    return {
      workspaceMode: mode,
      activeWindowId: activeWin?.id ?? null,
      activePath,
      activeCanvasId,
      canvasHasSelection: canvasRef.current?.hasSelection() ?? false,
      canvasHasGesture: canvasRef.current?.hasGesture() ?? false,
      canvasZoomLevel: engine?.getTransform().scale ?? 1,
      vaultIdentity,
      readOnly: readonly,
      windowCount: windowSnap.windows.length,
      hasMinimizedWindows: minimized.length > 0,
    };
  }, [mode, activePath, activeCanvasId, vaultIdentity, readonly]);

  // handleModeChange 提前引用（用 useCallback，appCommands 依赖它）
  const handleModeChangeRef = useRef<((next: WorkspaceMode) => void) | null>(null);
  const handleModeChange = useCallback(
    (next: WorkspaceMode): void => {
      if (next === mode) return;
      if (next === 'canvas') {
        setMode('canvas');
        return;
      }
      // 离开画布模式前 deactivate；失败留在画布模式。
      void (async () => {
        const controller = canvasRef.current;
        const ok = controller === null ? true : await controller.deactivate();
        if (ok) setMode('docs');
      })();
    },
    [mode, setMode],
  );
  handleModeChangeRef.current = handleModeChange;

  // S4：看板定位入口——先切回画布，再按「当前画布 → 最近编辑画布 → 提示」执行。
  const requestReveal = useCanvasReveal({
    mode,
    activeCanvasId,
    canvasRef,
    listCanvases,
    setActiveCanvasId,
    backToCanvas: () => handleModeChange('canvas'),
  });

  // 组装完整 Command 对象（注入 execute 闭包）
  const appCommands: Command[] = useMemo(() => {
    type Executor = (ctx: CommandContext) => Promise<void> | void;
    // R6-2:dispatch-table:start —— 缺任何一条 KnownCommandId 立即编译报错，无 default 兜底。
    const executors: Record<KnownCommandId, Executor> = {
      'view.command_palette': () => {
        paletteOpenRef.current();
      },
      'file.new_doc': () => {
        // 弹 DocNewInput 组件（CR-13 定死）
        dispatchPanels({ type: 'open', panel: 'docNewInput' });
      },
      'view.mode_canvas': () => {
        handleModeChangeRef.current?.('canvas');
      },
      'view.mode_docs': () => {
        handleModeChangeRef.current?.('docs');
      },
      'view.tile_windows': () => {
        const ids = visibleWindowIds();
        tileWindows(ids);
        setTileHint(hasTileOverlap(ids, getViewport()) ? '视口过小，部分窗口可能重叠' : null);
      },
      'view.cascade_windows': () => {
        cascadeWindows(visibleWindowIds());
        setTileHint(null);
      },
      'canvas.undo': () => {
        canvasRef.current?.getEngine()?.undo();
      },
      'canvas.redo': () => {
        canvasRef.current?.getEngine()?.redo();
      },
      'canvas.select_all': () => {
        canvasRef.current?.getEngine()?.selectAll();
        document.getSelection()?.removeAllRanges();
      },
      'canvas.cancel_gesture': () => {
        canvasRef.current?.cancelGesture();
      },
      'canvas.delete_selection': async () => {
        const engine = canvasRef.current?.getEngine();
        if (!engine) return;
        const doc = engine.getDocument();
        if (!doc) return;
        const sel = engine.getSelection();
        // await import：让 executor 的 try/catch 真正接住 rejection（红线⑧ 异步零吞错）
        const mod = await import('../../app/canvas/canvas-interactions.js');
        const cmds = mod.createDeleteSelectionCommands(doc, [...sel.nodes], [...sel.edges]);
        engine.executeCommands(cmds);
      },
      'canvas.add_text': () => {
        canvasRef.current?.addNodeCentered('text');
      },
      'canvas.add_ai': () => {
        canvasRef.current?.addNodeCentered('ai');
      },
      'canvas.add_prompt': () => {
        canvasRef.current?.addNodeCentered('prompt');
      },
      'canvas.zoom_in': () => {
        canvasRef.current?.zoomAt(KEY_ZOOM_FACTOR);
      },
      'canvas.zoom_out': () => {
        canvasRef.current?.zoomAt(1 / KEY_ZOOM_FACTOR);
      },
      'canvas.zoom_reset': () => {
        canvasRef.current?.resetZoom();
      },
      'window.open_current_doc': (ctx) => {
        const p = ctx.snapshot.activePath;
        if (p) openWindow(p, EDITOR_WINDOW_CONTENT, getViewport());
      },
      'window.close_active': (ctx) => {
        const id = ctx.snapshot.activeWindowId;
        if (id) requestWindowClose(id);
      },
    };
    // R6-2:dispatch-table:end
    return COMMAND_DEFINITIONS.map((def) => {
      const execute: Command['execute'] = async (ctx: CommandContext) => {
        await executors[def.id](ctx);
      };
      return { ...def, execute };
    });
  }, []);

  // 注册到 registry（只注册一次）
  useEffect(() => {
    registry.register(appCommands);
    return () => registry.clear();
  }, [registry, appCommands]);

  // 执行命令（palette 回调）
  const handleExecuteCommand = useCallback(
    async (id: string) => {
      const snapshot = buildSnapshot();
      const ctx: CommandContext = { snapshot, abilities };
      const result = await executor.execute(id, ctx);
      if (!result.ok && result.code !== 'E_COMMAND_DISABLED' && result.code !== 'E_COMMAND_BUSY') {
        // pushNotice 已由 executor 内部处理
      }
      return result;
    },
    [buildSnapshot, executor, abilities],
  );

  const handleSaveCommandBindings = useCallback((next: CommandBindingMap): string | null => {
    const failure = saveCommandBindings(window.localStorage, next);
    if (failure === null) setCommandBindings(next);
    return failure;
  }, []);

  // 所有命令快捷键唯一入口；editable 目标仅放行明确全局的命令。
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      dispatchCommandKeybinding(
        event,
        registry.list(buildSnapshot()),
        commandBindings,
        (commandId) => {
          void handleExecuteCommand(commandId).catch((error: unknown) => {
            pushNotice(`快捷键执行失败：${error instanceof Error ? error.message : String(error)}`, 'error');
          });
        },
      );
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [registry, buildSnapshot, commandBindings, handleExecuteCommand]);

  const dragDropPort = useMemo(() => createTauriDragDropPort(), []);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void dragDropPort.onDrop((event) => {
      const zone = document.elementFromPoint(event.position.x, event.position.y);
      routeNativeDrop(event, zone, {
        onDocList: (paths) => openImportDialog(paths),
        onEditor: (paths) => openDroppedInEditor(paths),
        onCanvas: (drop) => {
          const controller = canvasRef.current;
          if (controller === null) {
            pushNotice('画布尚未就绪，无法接收拖拽', 'warning');
            return;
          }
          controller.handleFinderDrop(drop);
        },
        onUnsupported: () => pushNotice('暂不支持拖到此处', 'warning'),
      });
    }).then((off) => {
      if (disposed) {
        off();
        return;
      }
      unlisten = off;
    }).catch((error: unknown) => {
      pushNotice(`拖放监听注册失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    });
    return () => {
      disposed = true;
      if (unlisten !== null) unlisten();
    };
  }, [dragDropPort, openImportDialog, openDroppedInEditor]);

  // 关闭中的窗口：working / confirming 均禁用标题栏 ×、拖动与缩放手柄（A.6）。
  const closingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const view of closeViews.values()) {
      if (view.phase === 'working' || view.phase === 'confirming') ids.add(view.windowId);
    }
    return ids;
  }, [closeViews]);

  const handleSwitchFailure = useCallback(
    (mountedId: string): void => {
      setActiveCanvasId(mountedId);
      setMode('canvas');
    },
    [setActiveCanvasId, setMode],
  );

  const edgePanels = useMemo(() => createEdgePanelController(), []);
  const subscribeEdgePanels = useCallback(
    (listener: () => void) => edgePanels.subscribe(listener),
    [edgePanels],
  );
  const getEdgePanelsState = useCallback(() => edgePanels.getState(), [edgePanels]);
  const edgeState = useSyncExternalStore(
    subscribeEdgePanels,
    getEdgePanelsState,
    getEdgePanelsState,
  );
  useEffect(
    () => () => {
      edgePanels.dispose();
    },
    [edgePanels],
  );

  const notices = (
    <ShellNotices
      items={noticeItems}
      tileHint={tileHint}
      guardError={guardError}
      closeError={closeError}
      onDismiss={dismissNotice}
    />
  );

  return (
    <div className={styles.shell}>
      <Topbar
        mode={mode}
        onModeChange={handleModeChange}
        onOpenSettings={() => dispatchPanels({ type: 'toggle', panel: 'settings' })}
        settingsOpen={panels.open.settings}
        settingsButtonRef={settingsButtonRef}
      />
      <div className={styles.body}>
        <EdgePanel
          side="left"
          label="文档与画布"
          open={edgeState.open.left}
          pinned={edgeState.pinned.left}
          onHover={(hovered) => edgePanels.setHover('left', hovered)}
          onToggle={() => edgePanels.toggle('left')}
          onPin={(pinned) => edgePanels.setPinned('left', pinned)}
        >
          <DocumentList />
        </EdgePanel>
        <main className={`${styles.main} ${immersive ? styles.mainImmersive : ''}`}>
          {mode === 'docs' ? (
            <BoardView
              docs={boardDocs}
              vaultId={vaultId}
              links={boardLinks}
              readDoc={docApi.read}
              onBackToCanvas={() => handleModeChange('canvas')}
              onRevealDoc={requestReveal}
            />
          ) : null}
          <CanvasView
            ref={canvasRef}
            active={mode === 'canvas'}
            canvasId={activeCanvasId}
            store={canvasStore}
            registry={canvasRegistry}
            onSwitchFailure={handleSwitchFailure}
            onCollectFiles={handleCollectFiles}
            onOpenReadMode={handleOpenReadMode}
            menuAccelerators={menuAccelerators}
          />
        </main>
      </div>
      <StatusBar />
      <WindowLayer
        notices={notices}
        closingIds={closingIds}
        onRequestClose={(record) => {
          // 仅编辑器窗口需要 flush；app 已接管，窗口层不得直接 closeWindow。
          requestWindowClose(record.id);
          return true;
        }}
        onWindowFocus={(record) => {
          // 聚焦浮窗时同步选中其文档（编辑内容仍只属于该浮窗，不镜像 activePath）。
          if (record.contentType === EDITOR_WINDOW_CONTENT) {
            useTreeStore.getState().setActivePath(record.id);
          }
        }}
      />
      {/* CR-20261119-13：C1 命令触发的 DocNewInput（锚点模拟视口中心偏上） */}
      {panels.open.docNewInput ? (() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const anchor: SubmenuAnchorRect = { left: vw / 2 - 140, top: vh / 2 - 40, right: vw / 2 - 140, bottom: vh / 2 - 40 };
        return <DocNewInput anchor={anchor} targetDir="" onClose={() => dispatchPanels({ type: 'close', panel: 'docNewInput' })} />;
      })() : null}
      {/* CR-20261119-13：⌘K 命令面板（只主窗口挂一个） */}
      <CommandPaletteComponent
        isOpen={palette.isOpen}
        onClose={palette.close}
        onExecute={(id) => handleExecuteCommand(id)}
        registry={registry}
        snapshot={buildSnapshot()}
        bindings={commandBindings}
      />
      {/* CR-20261120-35：左侧圆形 AI 对话入口（点击开合，不自动关闭） */}
      <AiChatButton open={panels.open.ai && panels.aiTab === 'chat'} onToggle={handleToggleChat} />
      {/* CR-20261120-35：设置单层菜单（无二级栏目）；CR-36：面板锚定设置按钮 */}
      <SettingsMenu
        open={panels.open.settings}
        sections={settingsSections}
        onSelect={handleSettingsSelect}
        onClose={() => dispatchPanels({ type: 'close', panel: 'settings' })}
        anchorRef={settingsButtonRef}
      />
      {/* CR-20261121-45 §10：文章阅读浮窗已并入编辑器窗口（右键「打开阅读浮窗」
          打开同一窗口的阅读模式，见 handleOpenReadMode），ArticleFloat 面板族删除。 */}
      {/* CR-20261120-35：库管理面板（知识库 + 媒体库） */}
      {panels.open.library ? <LibrarySettingsPanel onClose={() => dispatchPanels({ type: 'close', panel: 'library' })} /> : null}
      {panels.open.translate ? (
        <TranslateSettingsPanel
          onClose={() => dispatchPanels({ type: 'close', panel: 'translate' })}
          onSaved={(settings) => useTranslateStore.getState().setTargetLang(settings.targetLang)}
        />
      ) : null}
      {/* CR-20261119-18：T1-AI-A AI 面板（设置入口 → settings，对话入口 → chat） */}
      <AiPanelHost key={panels.aiTab} open={panels.open.ai} onClose={() => dispatchPanels({ type: 'close', panel: 'ai' })} effects={aiEffects} initialTab={panels.aiTab} />
      {panels.open.backup ? <BackupPanel effects={backupEffects} onClose={() => dispatchPanels({ type: 'close', panel: 'backup' })} /> : null}
      {panels.open.appearance ? <AppearancePanel onClose={() => dispatchPanels({ type: 'close', panel: 'appearance' })} /> : null}
      {panels.open.update ? <UpdatePanel effects={updaterPort} onClose={() => dispatchPanels({ type: 'close', panel: 'update' })} /> : null}
      {panels.open.inbox && vaultId !== null ? (
        <InboxPanelHost
          items={currentInboxItems}
          persistenceError={inboxVaultId === vaultId ? inboxPersistenceError : null}
          loadWarning={inboxVaultId === vaultId ? inboxLoadWarning : null}
          onChange={commitInboxItems}
          onClose={() => dispatchPanels({ type: 'close', panel: 'inbox' })}
        />
      ) : null}
      {importRequest !== null && importRequest.vaultId === vaultId ? (
        <ImportDialog
          key={importRequest.key}
          initialPaths={importRequest.paths}
          defaultTargetDir={defaultImportTarget(activePath)}
          effects={importEffects}
          onClose={() => setImportRequest(null)}
        />
      ) : null}
      {panels.open.shortcuts ? (
        <ShortcutSettings
          definitions={COMMAND_DEFINITIONS}
          bindings={commandBindings}
          onSave={handleSaveCommandBindings}
          onClose={() => dispatchPanels({ type: 'close', panel: 'shortcuts' })}
        />
      ) : null}
      {panels.open.replace ? <ReplacePanel effects={replaceEffects} onClose={() => dispatchPanels({ type: 'close', panel: 'replace' })} /> : null}
      {panels.open.health ? <HealthPanel effects={healthEffects} onClose={() => dispatchPanels({ type: 'close', panel: 'health' })} /> : null}
      {panels.open.history ? <HistoryPanel path={activePath} docId={activeDocId} effects={historyEffects} onClose={() => dispatchPanels({ type: 'close', panel: 'history' })} /> : null}
      {panels.open.tools ? <ToolsPanel pomodoro={pomodoro} audio={audio} onClose={() => dispatchPanels({ type: 'close', panel: 'tools' })} /> : null}
      {/* 恢复检测演示：仅 DEV 构建，从设置浮窗进入；宿主层只做定位不改 z 序 */}
      {import.meta.env.DEV && panels.open.recoveryDemo ? (
        <div
          style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: Z_MODAL }}
        >
          <RecoveryDemoPanel open onClose={() => dispatchPanels({ type: 'close', panel: 'recoveryDemo' })} />
        </div>
      ) : null}
    </div>
  );
}
