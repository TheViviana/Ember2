/**
 * P5-C3：单篇文档的 CodeMirror 6 视图（每浮窗一个实例）。
 *
 * 职责边界：
 * - 只读 props 注入的 `doc`，**不读全局 activePath**，不做窗口/文档归属记账
 *   （归属由 `binding.ts` + app 适配器负责）；
 * - Core → Editor 回写带外部事务标记，updateListener 凭标记跳过二次写回；
 * - 实例只创建一次，卸载时 destroy；文档正文首次到达时 setState 重建（清空撤销栈）。
 *
 * 不引 zustand；外部能力经 `EditorHost` 端口注入。C1-D 例外：仅 import
 * `src/app/dnd/` 的拖拽协议做读写，不引 app 状态/UI。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { basicSetup, EditorView as CodeMirrorView } from 'codemirror';
import {
  EDITOR_DND_FALLBACK_MIME,
  EDITOR_DND_MIME,
  coordinateEditorDrop,
  planEditorDrop,
  planEditorInboxDrop,
  readEditorInboxDropDetail,
  serializeTextPayload,
  type EditorMediaReadResult,
  type EditorNoticeTone,
} from './drop.ts';
import {
  conflictAction,
  shouldApplyExternal,
  shouldWriteBack,
} from './sync.ts';
import { mediaPreviewExtension } from './media-preview.ts';
import type { PreviewTranslation } from './MarkdownPreview.tsx';
import type { AiSelectionCardState, AiTextRunner } from './AiSelectionMenu.tsx';
import {
  EditorAiOverlay,
  EditorCloseOverlaySlot,
  EditorConflictBanner,
  EditorPlaceholder,
  EditorTopbar,
} from './EditorOverlays.tsx';
import { EditorPreviewPane } from './EditorPreviewPane.tsx';
import type { AiTextAction } from './ai-text-types.ts';
import { EditorToolbar } from './EditorToolbar.tsx';
import { BacklinksPanel, type BacklinksState } from './BacklinksPanel.tsx';
import { buildFormatChange, type FormatActionId } from './format-actions.ts';
import { readMediaReferences } from '../core/media-references.ts';
import { deriveSavePhase, type SavePhase } from './save-phases.ts';
import { readGutterVisible, subscribeGutterVisible } from '../core/gutter-preference.ts';
import { EDITOR_STYLE_NONCE } from './csp-nonce.ts';
import { ArticleOutline } from './ArticleOutline.tsx';
import { parseArticleOutline } from './article-outline.ts';
import type {
  EditorConflictChoice,
  EditorControl,
  EditorDocSnapshot,
  EditorHost,
  EditorInsertPoint,
  EditorLoadState,
} from './host.ts';
import styles from './EditorView.module.css';

/** Core → Editor 的回写事务标记，updateListener 凭它跳过二次写回。 */
const externalUpdate = Annotation.define<boolean>();

/** 锁定编辑的 CodeMirror 扩展：关窗协调器在保存前启用以冻结正文。 */
function lockExtensions(locked: boolean): Extension[] {
  return [CodeMirrorView.editable.of(!locked), EditorState.readOnly.of(locked)];
}

const PHASE_LABEL: Record<SavePhase, string> = {
  saved: '已保存',
  dirty: '未保存',
  saving: '保存中…',
  conflict: '有冲突',
  error: '保存失败',
};

const PHASE_CLASS: Record<SavePhase, string> = {
  saved: styles.phaseSaved ?? '',
  dirty: styles.phaseDirty ?? '',
  saving: styles.phaseSaving ?? '',
  conflict: styles.phaseConflict ?? '',
  error: styles.phaseError ?? '',
};

/** 浮窗三态：编辑 / 专注（隐藏外壳）/ 阅读（安全预览）。 */
export type EditorMode = 'edit' | 'focus' | 'read';

const EMPTY_BACKLINKS: BacklinksState = Object.freeze({
  status: 'idle',
  items: Object.freeze([]),
  error: null,
});

export interface EditorViewProps {
  readonly windowId: string;
  readonly loadState: EditorLoadState;
  readonly doc: EditorDocSnapshot | null;
  readonly loadError: string | null;
  readonly host: EditorHost;
  /** 句柄就绪回调（关窗协调器据此取得锁定能力）。 */
  readonly onReady?: (control: EditorControl) => void;
  /** app 层注入的关窗进度 / 失败面板（editor 层不引 app）。 */
  readonly overlay?: ReactNode;
  /** C1-D：拖放失败/只读提示；由 app 适配器接线到 notice store。 */
  readonly onNotice?: (message: string, tone: EditorNoticeTone) => void;
  /** CR-20261120-34：预览内链点击 → 宿主按库内路径打开文档。 */
  readonly onOpenInternalLink?: (path: string) => void;
  /** 面包屑展示用：库名与文档标题（标题回退文件名由 app 层计算）。 */
  readonly libraryName?: string | null;
  readonly documentTitle?: string;
  /** 标签栏由 app 层（EditorWindow）渲染后注入；本层不直接引标签组件。 */
  readonly tagBar?: ReactNode;
  /** 反向链接（按需建立索引，未建立时 status 为 idle）。 */
  readonly backlinks?: BacklinksState;
  readonly onBuildBacklinks?: () => void;
  /** 翻译入口：有选区传选中文本，无选区传 null（由宿主决定译全文）。 */
  readonly onTranslate?: (selectedText: string | null) => void;
  /** 译文块：跟在正文末尾展示（取代原翻译窗口）。 */
  readonly translation?: PreviewTranslation | null;
  readonly onDismissTranslation?: () => void;
  readonly onCancelTranslation?: () => void;
  /** 2026-11-23：翻译失败后从失败段继续。 */
  readonly onResumeTranslation?: () => void;
  /** §10 统一单窗口：外部（画布右键「打开阅读浮窗」/节点「展开」）请求的模式切换；
   *  应用后经 onModeRequestConsumed 通知宿主清除，避免残留覆盖用户手切。 */
  readonly modeRequest?: EditorMode | null;
  readonly onModeRequestConsumed?: () => void;
  /** 沉浸阅读（画布降低存在感）：开关状态由宿主持有（全局单开关）。 */
  readonly immersive?: boolean;
  readonly onToggleImmersive?: () => void;
  /** AI 动作清单由 app 层注入（值定义在上层，editor 不反向依赖）。 */
  readonly actions: readonly AiTextAction[];
  /** CR-20261121-49：选中文本的 AI 动作执行器（宿主持有模型与 IPC；返回取消函数）。 */
  readonly onAiTextAction?: AiTextRunner;
}

export function EditorView({
  windowId,
  loadState,
  doc,
  loadError,
  host,
  onReady,
  overlay,
  onNotice,
  onOpenInternalLink,
  libraryName = null,
  documentTitle,
  tagBar,
  backlinks = EMPTY_BACKLINKS,
  onBuildBacklinks,
  onTranslate,
  translation = null,
  onDismissTranslation,
  onCancelTranslation,
  onResumeTranslation,
  modeRequest = null,
  onModeRequestConsumed,
  immersive = false,
  onToggleImmersive,
  actions,
  onAiTextAction,
}: EditorViewProps) {
  const hostElementRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<CodeMirrorView | null>(null);
  const extensionsRef = useRef<Extension[] | null>(null);
  const lockCompartmentRef = useRef<Compartment | null>(null);
  const lockedRef = useRef(false);
  const initializedRef = useRef(false);
  const hostRef = useRef(host);
  const windowIdRef = useRef(windowId);
  const onReadyRef = useRef(onReady);
  const onNoticeRef = useRef(onNotice);
  const onModeRequestConsumedRef = useRef(onModeRequestConsumed);
  const [resolving, setResolving] = useState<EditorConflictChoice | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  /** CR-20261120-34：编辑 / 专注 / 阅读三态；阅读模式不卸载 CodeMirror。 */
  const [mode, setMode] = useState<EditorMode>('edit');
  const [backlinksOpen, setBacklinksOpen] = useState(false);
  /**
   * §10 衬线阅读（原浮窗功能随迁）：仅作用于阅读模式预览。
   * 2026-11-24 对齐 cinematic mock：阅读默认衬线（可切回无衬线）。
   */
  const [serif, setSerif] = useState(true);
  /** 设置→外观：浮窗行号显隐，跨窗口实时同步。 */
  const [gutterVisible, setGutterVisible] = useState(() => readGutterVisible());
  /** CR-20261121-49：选中文本的动作浮层锚点（非 null 即显示动作列表）。 */
  const [aiMenu, setAiMenu] = useState<{ readonly left: number; readonly top: number } | null>(null);
  const [aiCard, setAiCard] = useState<AiSelectionCardState | null>(null);
  const aiRangeRef = useRef<{ from: number; to: number; text: string } | null>(null);
  const aiCancelRef = useRef<(() => void) | null>(null);
  const aiRunnerRef = useRef(onAiTextAction);
  const modeRef = useRef(mode);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const reportAiSelectionRef = useRef<((view: CodeMirrorView) => void) | null>(null);
  const aiPopupOpenRef = useRef(false);

  // 与 hostRef 同一约定：渲染期同步最新能力，供 CodeMirror / 原生选区回调读取。
  aiRunnerRef.current = onAiTextAction;
  modeRef.current = mode;
  aiPopupOpenRef.current = aiMenu !== null || aiCard !== null;

  /** CR-20261121-49：编辑 / 专注态的 CodeMirror 选区 → 动作浮层。 */
  const reportCodeMirrorSelection = (view: CodeMirrorView): void => {
    if (aiRunnerRef.current === undefined || modeRef.current === 'read' || !view.hasFocus) return;
    const main = view.state.selection.main;
    if (main.empty) {
      setAiMenu(null);
      return;
    }
    const text = view.state.sliceDoc(main.from, main.to);
    if (text.trim() === '') {
      setAiMenu(null);
      return;
    }
    const coords = view.coordsAtPos(main.to);
    if (coords === null) return;
    aiRangeRef.current = { from: main.from, to: main.to, text };
    setAiMenu({ left: coords.left, top: coords.bottom + 8 });
  };
  reportAiSelectionRef.current = reportCodeMirrorSelection;

  useEffect(() => subscribeGutterVisible(setGutterVisible), []);

  // 文章大纲：标题直接从源文本提取（编辑/阅读共用），编辑模式另给 CodeMirror 定位能力。
  const articleText = doc?.text ?? '';
  const outlineItems = useMemo(() => parseArticleOutline(articleText), [articleText]);

  const jumpToOutlineLine = useCallback((line: number): void => {
    const view = viewRef.current;
    if (view === null) return;
    const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
    const from = view.state.doc.line(clamped).from;
    view.dispatch({
      selection: { anchor: from },
      effects: CodeMirrorView.scrollIntoView(from, { y: 'start' }),
    });
    view.focus();
  }, []);

  const outlineLineTop = useCallback((line: number): number | null => {
    const view = viewRef.current;
    if (view === null) return null;
    const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
    return view.documentTop + view.lineBlockAt(view.state.doc.line(clamped).from).top;
  }, []);

  // updateListener 在 React 渲染之外异步触发，用 ref 取最新端口与窗口 id。
  useEffect(() => {
    hostRef.current = host;
    windowIdRef.current = windowId;
    onReadyRef.current = onReady;
    onNoticeRef.current = onNotice;
    onModeRequestConsumedRef.current = onModeRequestConsumed;
  });

  // 外部冲突解除后清空上次的裁决错误，避免张冠李戴。
  useEffect(() => {
    if (doc === null || doc.externalKind === null) setConflictError(null);
  }, [doc]);

  // 译文只存在于阅读模式的正文末尾：翻译一出现就自动切到阅读模式。
  const translationActive = translation !== null;
  useEffect(() => {
    if (translationActive) setMode('read');
  }, [translationActive]);

  // §10 统一单窗口：外部模式请求（画布「打开阅读浮窗」→ read）应用后即消费。
  useEffect(() => {
    if (modeRequest === null) return;
    setMode(modeRequest);
    onModeRequestConsumedRef.current?.();
  }, [modeRequest]);

  // 生命周期内只创建一次 CodeMirror 实例；卸载时销毁。
  useEffect(() => {
    const parent = hostElementRef.current;
    if (!parent) return;

    const lockCompartment = new Compartment();
    lockCompartmentRef.current = lockCompartment;

    // 基础扩展不含锁定 compartment：重建 EditorState 时按当前锁定态重新挂载，
    // 避免首次载入正文（setState）把协调器已应用的锁定重置掉。
    const extensions: Extension[] = [
      basicSetup,
      // 生产 CSP 只放行带固定 nonce 的 <style>；不接线时 CodeMirror baseTheme
      // 会被拦截（2026-11-23 打包版行号/滚动回归的根因）。
      CodeMirrorView.cspNonce.of(EDITOR_STYLE_NONCE),
      markdown(),
      mediaPreviewExtension(readMediaReferences),
      CodeMirrorView.lineWrapping,
      CodeMirrorView.updateListener.of((update) => {
        if (update.selectionSet) reportAiSelectionRef.current?.(update.view);
        const external = update.transactions.some(
          (transaction) => transaction.annotation(externalUpdate) === true,
        );
        if (!shouldWriteBack({ docChanged: update.docChanged, external })) return;
        hostRef.current.writeBack(windowIdRef.current, update.state.doc.toString());
      }),
    ];

    extensionsRef.current = extensions;
    const view = new CodeMirrorView({
      state: EditorState.create({
        doc: '',
        extensions: [...extensions, lockCompartment.of(lockExtensions(false))],
      }),
      parent,
    });
    viewRef.current = view;

    // C1-D：dragstart 留在 view.dom；dragover/drop 在祖先 capture 阶段协调，
    // 需要接管的自定义载荷先于 CodeMirror 内建 handler 停止传播。
    const notify = (message: string, tone: EditorNoticeTone): void => {
      onNoticeRef.current?.(message, tone);
    };
    const insertTextAt = (
      insert: string,
      point: EditorInsertPoint,
      notice?: { readonly message: string; readonly tone: EditorNoticeTone },
    ): void => {
      const position = view.posAtCoords(point) ?? view.state.selection.main.head;
      try {
        view.dispatch({
          changes: { from: position, insert },
          selection: { anchor: position + insert.length },
        });
      } catch (error: unknown) {
        notify(`插入失败：${error instanceof Error ? error.message : '未知错误'}`, 'error');
        return;
      }
      if (notice !== undefined) notify(notice.message, notice.tone);
    };
    const insertMediaAt = (read: EditorMediaReadResult, point: EditorInsertPoint): void => {
      const outcome = planEditorDrop(view.state.readOnly, read);
      if (!outcome.ok) {
        notify(outcome.message, outcome.tone);
        return;
      }
      insertTextAt(outcome.plan.insert, point, outcome.plan.notice);
    };

    onReadyRef.current?.({
      setLocked: (locked: boolean) => {
        lockedRef.current = locked;
        const current = viewRef.current;
        if (!current) return;
        current.dispatch({ effects: lockCompartment.reconfigure(lockExtensions(locked)) });
      },
      insertMedia: (media, point) => {
        insertMediaAt(
          { ok: true, path: media.path, kind: media.kind, label: media.label },
          point,
        );
      },
    });

    const handleDragStart = (event: DragEvent): void => {
      const selection = view.state.selection.main;
      const text = view.state.sliceDoc(selection.from, selection.to);
      if (text === '') return;
      const transfer = event.dataTransfer;
      if (transfer === null) return;
      transfer.setData(EDITOR_DND_MIME, serializeTextPayload(text));
      transfer.setData(EDITOR_DND_FALLBACK_MIME, text);
      transfer.effectAllowed = 'copy';
    };
    const handleDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes(EDITOR_DND_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const handleDrop = (event: DragEvent): void => {
      const transfer = event.dataTransfer;
      const coordination = coordinateEditorDrop(
        (format: string): string => transfer?.getData(format) ?? '',
      );
      if (coordination.kind === 'native') return;
      event.preventDefault();
      event.stopPropagation();
      insertMediaAt(coordination.read, { x: event.clientX, y: event.clientY });
    };
    const handleInboxDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = readEditorInboxDropDetail(event.detail);
      if (detail === null) return;
      const root = parent.closest('[data-editor-drop-host]');
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (root === null || target?.closest('[data-editor-drop-host]') !== root) return;
      void planEditorInboxDrop(
        view.state.readOnly,
        detail.payload,
        (sourcePath) => hostRef.current.resolveFileReference(sourcePath),
      ).then((outcome) => {
        if (viewRef.current !== view) return;
        if (!outcome.ok) {
          notify(outcome.message, outcome.tone);
          return;
        }
        if (view.state.readOnly) {
          notify('编辑器只读，无法插入', 'warning');
          return;
        }
        insertTextAt(
          outcome.plan.insert,
          { x: detail.clientX, y: detail.clientY },
          outcome.plan.notice,
        );
      }).catch((error: unknown) => {
        notify(`拖入处理失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    };
    view.dom.addEventListener('dragstart', handleDragStart);
    parent.addEventListener('dragover', handleDragOver, true);
    parent.addEventListener('drop', handleDrop, true);
    document.addEventListener('ember:pointer-drag-drop', handleInboxDrop);

    return () => {
      view.dom.removeEventListener('dragstart', handleDragStart);
      parent.removeEventListener('dragover', handleDragOver, true);
      parent.removeEventListener('drop', handleDrop, true);
      document.removeEventListener('ember:pointer-drag-drop', handleInboxDrop);
      view.destroy();
      viewRef.current = null;
      extensionsRef.current = null;
      lockCompartmentRef.current = null;
      lockedRef.current = false;
      initializedRef.current = false;
    };
  }, []);

  // 正文首次到达：重建 EditorState（清空撤销栈）；后续 Core 变化只做外部回写。
  useEffect(() => {
    if (loadState !== 'ready' || doc === null) return;
    const view = viewRef.current;
    const extensions = extensionsRef.current;
    const lockCompartment = lockCompartmentRef.current;
    if (!view || !extensions || !lockCompartment) return;

    if (!initializedRef.current) {
      view.setState(
        EditorState.create({
          doc: doc.text,
          extensions: [...extensions, lockCompartment.of(lockExtensions(lockedRef.current))],
        }),
      );
      initializedRef.current = true;
      view.focus();
      return;
    }

    if (!shouldApplyExternal(view.state.doc.toString(), doc.text)) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc.text },
      annotations: externalUpdate.of(true),
    });
  }, [loadState, doc]);

  const handleResolve = (choice: EditorConflictChoice): void => {
    if (doc === null || doc.externalKind === null) return;
    setConflictError(null);

    if (conflictAction(doc.externalKind, choice) === 'close') {
      // 接受外部删除：按 D4 不自动关窗；进入 app 层唯一确认流程，确认前不丢弃改动。
      host.requestAcceptDeletion(windowId);
      return;
    }

    setResolving(choice);
    void (async () => {
      try {
        await host.resolveConflict(doc.path, choice);
      } catch (error: unknown) {
        setConflictError(error instanceof Error ? error.message : '处理冲突失败');
      } finally {
        setResolving(null);
      }
    })();
  };

  const external = doc?.externalKind ?? null;
  const showPlaceholder = loadState !== 'ready' || doc === null;
  const savePhase = deriveSavePhase(doc);
  const focusMode = mode === 'focus';
  const chromeHidden = focusMode;

  /* 专注态 Esc 退出（顶栏已隐藏，键盘必须留逃生通道）；AI 浮层打开时先关浮层。 */
  useEffect(() => {
    if (!focusMode) return;
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (aiPopupOpenRef.current) return;
      event.preventDefault();
      setMode('read');
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [focusMode]);

  // CR-20261121-49：阅读模式的原生选区 → 动作浮层（预览是 DOM 渲染，走 selectionchange）。
  useEffect(() => {
    if (mode !== 'read') {
      // 切出阅读态时收起仅由原生选区驱动的浮层；结果卡片保留。
      setAiMenu(null);
      return;
    }
    const onSelectionChange = (): void => {
      if (aiRunnerRef.current === undefined) return;
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setAiMenu(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const body = bodyRef.current;
      if (body === null || !body.contains(range.commonAncestorContainer)) return;
      const text = selection.toString();
      if (text.trim() === '') {
        setAiMenu(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      // 阅读态的选区无法可靠映射回源码，替换时按唯一原文定位。
      aiRangeRef.current = { from: -1, to: -1, text };
      setAiMenu({ left: rect.left, top: rect.bottom + 8 });
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [mode]);

  // 浮层 / 卡片打开时 Esc 先关闭它（拦在窗口 capture 阶段）。
  useEffect(() => {
    if (aiMenu === null && aiCard === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      aiCancelRef.current?.();
      aiCancelRef.current = null;
      aiRangeRef.current = null;
      setAiMenu(null);
      setAiCard(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [aiMenu, aiCard]);

  const handleAiPick = (action: AiTextAction): void => {
    const runner = aiRunnerRef.current;
    const range = aiRangeRef.current;
    const anchor = aiMenu;
    if (runner === undefined || range === null || anchor === null) return;
    aiCancelRef.current?.();
    setAiMenu(null);
    setAiCard({
      action,
      status: 'streaming',
      text: '',
      error: null,
      left: anchor.left,
      top: anchor.top,
    });
    aiCancelRef.current = runner(action.id, range.text.trim(), {
      onDelta: (full) => setAiCard((card) => (card === null ? card : { ...card, text: full })),
      onDone: (full) => setAiCard((card) => (card === null ? card : { ...card, status: 'done', text: full })),
      onError: (message) => setAiCard((card) => (card === null ? card : { ...card, status: 'error', error: message })),
    });
  };

  const handleAiDiscard = (): void => {
    aiCancelRef.current?.();
    aiCancelRef.current = null;
    aiRangeRef.current = null;
    setAiCard(null);
    setAiMenu(null);
    if (modeRef.current !== 'read') viewRef.current?.focus();
  };

  const handleAiReplace = (): void => {
    const card = aiCard;
    const range = aiRangeRef.current;
    const view = viewRef.current;
    if (card === null || card.status !== 'done' || range === null || view === null) return;
    const current = view.state.doc.toString();
    let from = range.from;
    let to = range.to;
    const exact = from >= 0 && to >= from && current.slice(from, to) === range.text;
    if (!exact) {
      // 选区已变化（阅读态或编辑后）：仅在原文唯一时替换，避免误改重复内容。
      const first = current.indexOf(range.text);
      const second = first < 0 ? -1 : current.indexOf(range.text, first + 1);
      if (first < 0 || second >= 0) {
        onNoticeRef.current?.('无法定位唯一原文（内容可能已变化），请重新选中后再试', 'warning');
        return;
      }
      from = first;
      to = first + range.text.length;
    }
    view.dispatch({
      changes: { from, to, insert: card.text },
      selection: { anchor: from + card.text.length },
    });
    aiRangeRef.current = null;
    aiCancelRef.current = null;
    setAiCard(null);
    setAiMenu(null);
    if (modeRef.current !== 'read') view.focus();
  };

  const documentTitleText = documentTitle
    ?? (doc === null ? '' : doc.path.split('/').pop() ?? doc.path);

  // ⌘1/2/3 在编辑 / 专注 / 阅读之间切换。
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === '1') {
        event.preventDefault();
        setMode('edit');
      } else if (event.key === '2') {
        event.preventDefault();
        setMode('focus');
      } else if (event.key === '3') {
        event.preventDefault();
        setMode('read');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const readSelectedText = (): string | null => {
    if (mode === 'read') {
      const selected = window.getSelection()?.toString().trim() ?? '';
      return selected === '' ? null : selected;
    }
    const view = viewRef.current;
    if (view === null) return null;
    const selection = view.state.selection.main;
    if (selection.empty) return null;
    const text = view.state.sliceDoc(selection.from, selection.to).trim();
    return text === '' ? null : text;
  };

  const applyFormat = (action: FormatActionId): void => {
    const view = viewRef.current;
    if (view === null || view.state.readOnly) return;
    const selection = view.state.selection.main;
    const change = buildFormatChange(
      view.state.doc.toString(),
      { from: selection.from, to: selection.to },
      action,
    );
    view.dispatch({
      changes: { from: change.from, to: change.to, insert: change.insert },
      selection: { anchor: change.anchor, head: change.head },
    });
    view.focus();
  };

  return (
    <div
      className={`${styles.view} ${gutterVisible ? '' : styles.gutterHidden}`}
      data-editor-window-id={windowId}
      data-editor-drop-host=""
    >
      {external !== null ? (
        <EditorConflictBanner
          external={external}
          error={conflictError}
          resolving={resolving}
          onResolve={handleResolve}
        />
      ) : null}

      {loadState === 'ready' && doc !== null ? (
        <EditorTopbar
          chromeHidden={chromeHidden}
          focusMode={focusMode}
          docPath={doc.path}
          title={documentTitleText}
          libraryName={libraryName}
          translation={translation}
          canTranslate={onTranslate !== undefined}
          onTranslateSelection={() => onTranslate?.(readSelectedText())}
          onCancelTranslation={onCancelTranslation}
          onDismissTranslation={onDismissTranslation}
          onResumeTranslation={onResumeTranslation}
          backlinksOpen={backlinksOpen}
          backlinks={backlinks}
          onToggleBacklinks={() => setBacklinksOpen((open) => !open)}
          mode={mode}
          onModeChange={setMode}
          serif={serif}
          immersive={immersive}
          onToggleSerif={() => setSerif((prev) => !prev)}
          onToggleImmersive={onToggleImmersive}
        />
      ) : null}

      {!chromeHidden && loadState === 'ready' && doc !== null ? tagBar : null}

      {!chromeHidden && mode === 'edit' && loadState === 'ready' && doc !== null ? (
        <EditorToolbar disabled={lockedRef.current} onAction={applyFormat} />
      ) : null}

      {!chromeHidden && backlinksOpen && loadState === 'ready' && doc !== null ? (
        <BacklinksPanel
          state={backlinks}
          onBuild={onBuildBacklinks ?? (() => undefined)}
          onOpen={(path) => onOpenInternalLink?.(path)}
        />
      ) : null}

      {/* §10：底部三态浮层已删（用户裁定三态钮统一走顶栏）；专注态逃生=Esc 回阅读
          （上方 effect）+ ⌘1/2/3；专注态只保留顶栏三态切换，其余入口隐藏。 */}

      <div className={styles.body} ref={bodyRef}>
        <div
          ref={hostElementRef}
          className={`${styles.editor} ${mode === 'read' ? styles.editorHidden : ''}`}
        />
        {mode === 'read' && loadState === 'ready' && doc !== null ? (
          <EditorPreviewPane
            text={doc.text}
            docPath={doc.path}
            onOpenInternalLink={onOpenInternalLink}
            translation={translation}
            serif={serif}
          />
        ) : null}
        {loadState === 'ready' && doc !== null && mode !== 'focus' ? (
          <ArticleOutline
            items={outlineItems}
            mode={mode}
            hostRef={bodyRef}
            onJumpToLine={jumpToOutlineLine}
            getLineTop={outlineLineTop}
          />
        ) : null}
        {loadState === 'ready' && doc !== null && !chromeHidden ? (
          <span
            className={`${styles.phaseChip} ${PHASE_CLASS[savePhase]}`}
            role="status"
            title="保存状态"
          >
            {PHASE_LABEL[savePhase]}
          </span>
        ) : null}
        {showPlaceholder ? (
          <EditorPlaceholder
            loadState={loadState}
            loadError={loadError}
            onCloseWindow={() => host.requestCloseWindow(windowId)}
          />
        ) : null}
      </div>
      <EditorCloseOverlaySlot overlay={overlay} />
      <EditorAiOverlay
        card={aiCard}
        menu={aiMenu}
        actions={actions}
        onPick={handleAiPick}
        onDiscard={handleAiDiscard}
        onReplace={handleAiReplace}
      />
    </div>
  );
}
