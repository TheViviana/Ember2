/**
 * C0-C/C0-D：画布视图装配 + 右键菜单 + 双击文本编辑。
 *
 * - 每次 mount attempt 使用递增 generation；所有 await 后校验仍是当前 attempt，
 *   过期 Promise 不写状态、不注册新引擎、不清理新实例；
 * - 切换画布/离开画布模式走 B5 普通切换链（lock → beforeFlush → flush → dispose），
 *   失败恢复交互并留在旧画布；
 * - 致命信封错误只通知，不挂载、不改写字节；
 * - C0-D 订阅 engine 事件通道处理右键菜单和双击文本编辑；命令经 engine.execute → controller → mutate → 统一历史。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { DragEvent } from 'react';
import type { CanvasCommand, CanvasNodeInput } from '#canvas-format';
import { openWindow, getViewport } from '../../windows/use-window-manager.ts';
import { EDITOR_WINDOW_CONTENT } from '../../windows/content-types.ts';
import { parseFrontmatter } from '../../core/markdown.ts';
import { illegalSegment } from '../../core/path-segments.ts';
import type { CanvasDocumentStore, CanvasEngineEvent, CanvasNotice } from './engine.ts';
import {
  resolveCanvasConflictAfterInspection,
  type CanvasOpenResult,
} from './document-controller.ts';
import { CanvasEngine } from './engine.ts';
import { classifyCanvasOpen } from './canvas-open.ts';
import { createCanvasSwitchDisposer } from './lifecycle.ts';
import type { CanvasEngineRegistry } from './registry.ts';
import { createCanvasMountGuard } from './view-sync.ts';
import {
  classifyDocLink,
  createAddAiNodeCommand,
  createAddDocumentNodeCommand,
  createAddMediaNodeCommand,
  createAddPromptNodeCommand,
  createAddTextNodeCommand,
  createConnectNewNodeCommands,
  createConnectionNodePorts,
  createRemoveEdgeCommands,
  createRemoveNodeCommands,
  createUpdateAiModelCommand,
  createUpdateDocPathCommand,
  createUpdateLabelCommand,
  createUpdatePromptTextCommand,
  documentTitleFromPath,
  isSafeLibraryDocPath,
  makeNodeId,
  resolveFinderDocumentPath,
  textLabelFromText,
} from './canvas-interactions.ts';
import { useAiChatStore } from '../../features/ai/ai-chat-store.ts';
import { POINTER_DRAG_DROP_EVENT, readPointerDragDropDetail } from '../dnd/pointer-drag.ts';
import { hitTestNodes, nodeSizeOf } from './node-layout.ts';
import { pushNotice } from '../stores/notice-store';
import { openLibraryDocument } from '../doc-open.ts';
import { createDropTargetRegistry, readPayload } from '../dnd/index.ts';
import { insertMediaIntoEditor } from '../../editor/media-insert-registry.ts';
import type { DndPayload } from '../dnd/index.ts';
import {
  fileNameFromPath,
  groupFinderPaths,
  mediaKindFromLibraryPath,
} from '../dnd/finder-paths.ts';
import { aiApi, docApi, mediaApi } from '../../data/app-api.ts';
import type { DragDropDropEvent } from '../../data/drag-drop-port';
import { useEmberStore } from '../stores/ember-store';
import { useTranslateStore } from '../translate/translate-store.ts';
import { buildTree } from '../tree/build-tree.ts';
import { buildMediaMenuTree } from './media-menu-tree.ts';
import {
  CanvasConnectionMenu,
  CanvasContextMenu,
  CanvasEditOverlay,
  CanvasModelPicker,
  type CanvasEditState,
  type CanvasMenu,
  type CanvasModelChoices,
  type CanvasModelPickerState,
  type CanvasOverlayRect,
  type ConnectionMenuState,
} from './CanvasMenus.tsx';
import { createAiNodeRunner, type AiNodeRunner } from './ai-node-run.ts';
import type { MediaEntry } from '../../features/media/media-groups.ts';
import styles from './CanvasView.module.css';
import { formatUnknownError } from '../../core/errors.ts';

const SWITCH_FLUSH_TIMEOUT_MS = 5000;

/** D11：落到已有节点上时，新节点在该节点右侧留出的世界坐标间距。 */
const NODE_DROP_GAP = 24;

/** D11：落点命中节点 → 新节点锚定在该节点右侧；未命中 → 指针所在世界坐标。 */
function resolveDropWorld(
  engine: CanvasEngine,
  localPoint: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  const hit = hitTestNodes(engine.getNodeViews(), engine.getTransform(), localPoint);
  if (hit === null) return engine.screenToWorld(localPoint);
  const size = nodeSizeOf(hit);
  return { x: hit.x + size.w + NODE_DROP_GAP, y: hit.y };
}

/** C1-B：画布落点裁决复用 C1-A 注册表。 */
const CANVAS_DROP_TARGETS = createDropTargetRegistry();

/** 指针拖拽的媒体载荷只接受库内 `media/` 相对路径（拒绝绝对路径与 `.`/`..` 段）。 */
function isSafeLibraryMediaPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  if (!normalized.startsWith('media/')) return false;
  return illegalSegment(normalized) === null;
}

/** C1-C：Finder paths → 画布节点（库内 doc 映射相对路径；图片/音频/视频先 media_save 入库——CR-20261119-25 扩展）。 */
async function createNodesFromFinderPaths(
  engine: CanvasEngine,
  paths: readonly string[],
  world: { readonly x: number; readonly y: number },
  libraryRoot: string | null,
  hasDoc: (path: string) => boolean,
  onCollectFiles: (paths: readonly string[]) => void,
): Promise<void> {
  const scale = engine.getTransform().scale;
  const step = scale > 0 ? 24 / scale : 24;
  let slot = 0;
  const nextPoint = (): { readonly x: number; readonly y: number } => {
    const offset = slot * step;
    slot += 1;
    return { x: world.x + offset, y: world.y + offset };
  };

  const { docs, images, audios, videos, attachments, others } = groupFinderPaths(paths);

  for (const path of docs) {
    const resolved = resolveFinderDocumentPath(path, libraryRoot, hasDoc);
    if (resolved.kind === 'external') {
      pushNotice(`外部文件暂不支持引用，仅库内文档可建节点：${fileNameFromPath(path)}`, 'warning');
      continue;
    }
    if (resolved.kind === 'unindexed') {
      pushNotice(`文档尚未收录到知识库：${fileNameFromPath(path)}`, 'warning');
      continue;
    }
    const point = nextPoint();
    if (
      !engine.executeCommands([
        createAddDocumentNodeCommand(point.x, point.y, resolved.path),
      ])
    ) {
      pushNotice('创建文档节点失败', 'error');
    }
  }

  // CR-20261119-25：音频/视频与图片同链路（media_save → 建媒体节点）；逐文件独立
  // try/catch（失败按计数汇总显式提示，不中断批次）；多文件经 nextPoint 顺序偏移落位。
  for (const path of [...images, ...audios, ...videos]) {
    try {
      const saved = await mediaApi.save(path);
      const payload: DndPayload = { kind: 'media', path: saved.path };
      const decision = CANVAS_DROP_TARGETS.resolve('canvas', payload);
      if (!decision.accepted) {
        pushNotice(decision.reason, 'error');
        continue;
      }
      const point = nextPoint();
      if (
        !engine.executeCommands([
          createAddMediaNodeCommand(point.x, point.y, saved.path, saved.kind, fileNameFromPath(path)),
        ])
      ) {
        pushNotice('创建媒体节点失败', 'error');
      }
    } catch (error: unknown) {
      pushNotice(`媒体入库失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
    }
  }

  // CR-20261120-26：只读附件（PDF/HTML）入媒体库「文档」tab，不建画布节点。
  for (const path of attachments) {
    try {
      await mediaApi.save(path);
      pushNotice('已加入媒体库 · 文档', 'info');
    } catch (error: unknown) {
      pushNotice(`附件入库失败：${fileNameFromPath(path)} ${formatUnknownError(error, '未知画布错误')}`, 'error');
    }
  }

  // D3：其它文件仅保存原始路径到当前库收集箱，不复制、不改名。
  if (others.length > 0) onCollectFiles(others);
}

export interface CanvasViewController {
  /** 离开画布模式/卸载前调用；成功才允许切走。 */
  deactivate(): Promise<boolean>;
  getEngine(): CanvasEngine | null;
  /** CR-20261119-13：命令总线委托——放大。 */
  zoomAt(factor: number): void;
  /** CR-20261119-13：命令总线委托——重置视图。 */
  resetZoom(): void;
  /** CR-20261119-13：命令总线委托——取消手势。 */
  cancelGesture(): void;
  /** CR-20261121-58：命令总线委托——视口中心新建节点（文本/AI/提示词），文本与提示词即建即编。 */
  addNodeCentered(kind: 'text' | 'ai' | 'prompt'): void;
  /** S4：看板定位——按文档路径查找节点，选中并居中；未找到返回 false。 */
  revealDoc(docPath: string): boolean;
  /** CR-20261119-13：命令总线委托——是否有选中。 */
  hasSelection(): boolean;
  /** CR-20261119-13：命令总线委托——是否有活动手势。 */
  hasGesture(): boolean;
  /** 由 AppShell 的统一原生拖放路由调用。 */
  handleFinderDrop(event: DragDropDropEvent): void;
}

export interface CanvasViewProps {
  readonly active: boolean;
  readonly canvasId: string | null;
  readonly store: CanvasDocumentStore;
  readonly registry: CanvasEngineRegistry;
  /** 切换失败时把 UI 恢复到仍挂载的画布。 */
  readonly onSwitchFailure: (canvasId: string) => void;
  /** D3：不支持的 Finder 文件只进入当前库收集箱。 */
  readonly onCollectFiles: (paths: readonly string[]) => void;
  /** CR-20261121-45 项3/项2：文档节点「展开」→ 打开阅读浮窗。 */
  readonly onOpenReadMode?: (payload: {
    readonly docPath: string;
    readonly title: string;
    readonly sourceNodeId: string;
  }) => void;
  /** CR-20261121-58：右键菜单快捷键加速器（action id → 展示串，如 '⌘T'）。 */
  readonly menuAccelerators?: Readonly<Record<string, string>>;
}

interface MountedSession {
  readonly canvasId: string;
  readonly engine: CanvasEngine;
  unsubscribe: () => void;
}

/** 节点 id → 绑定的库内相对文档路径；未绑定返回 null。 */
function docPathOf(engine: CanvasEngine, nodeId: string): string | null {
  const docNode = engine.getDocument().nodes.find(
    (n) =>
      n !== null &&
      typeof n === 'object' &&
      (n as { readonly id?: unknown }).id === nodeId,
  ) as { readonly id: string; readonly docPath?: unknown } | undefined;
  if (
    docNode === undefined ||
    typeof docNode.docPath !== 'string' ||
    docNode.docPath === ''
  ) {
    return null;
  }
  return docNode.docPath;
}

function noticeTone(notice: CanvasNotice): 'info' | 'warning' | 'error' {
  if (notice.code === 'E_SCHEMA' || notice.code === 'E_PRECISION') return 'warning';
  if (notice.code === 'E_CONFLICT' || notice.code === 'E_SAVE_FAILED') return 'error';
  return 'info';
}

/** C0-D：节点编辑浮层的屏幕定位（对齐节点盒，随视口变换）。 */
function editOverlayRect(
  nodeId: string,
  nodeX: number,
  nodeY: number,
  engine: CanvasEngine,
): CanvasOverlayRect {
  const { tx, ty, scale, originX, originY } = engine.getTransform();
  const current = engine.getNodeViews().find((node) => node.id === nodeId);
  const size = nodeSizeOf(current ?? {});
  // CR-20261121-59：编辑浮层铺满节点矩形（原位修改，不再是节点内的「另一个框」）。
  return {
    left: (nodeX + originX) * scale + tx,
    top: (nodeY + originY) * scale + ty,
    width: size.w * scale,
    height: size.h * scale,
  };
}

export const CanvasView = forwardRef<CanvasViewController, CanvasViewProps>(function CanvasView(
  { active, canvasId, store, registry, onSwitchFailure, onCollectFiles, onOpenReadMode, menuAccelerators },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<MountedSession | null>(null);
  const guardRef = useRef(createCanvasMountGuard());
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const [readOnly, setReadOnly] = useState(false);
  const [canvasStatus, setCanvasStatus] = useState<CanvasNotice | null>(null);
  const [resolvingConflict, setResolvingConflict] = useState<
    'keep-local' | 'accept-external' | null
  >(null);
  const conflictActive = readOnly && canvasStatus?.code === 'E_CONFLICT';

  // C0-D：右键菜单与文本编辑状态。
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  /** 右键「媒体库」子菜单数据；仅在空白处右键时按需拉取。 */
  const [mediaEntries, setMediaEntries] = useState<readonly MediaEntry[]>([]);
  const [editing, setEditing] = useState<CanvasEditState | null>(null);
  const [rebindNodeId, setRebindNodeId] = useState<string | null>(null);

  /** N4：拉线落空建节点菜单（与右键菜单独立）。 */
  const [connectionMenu, setConnectionMenu] = useState<ConnectionMenuState | null>(null);

  const resolveDocPath = useEmberStore((state) => state.resolveDocPath);
  const libraryRoot = useEmberStore((state) => state.identity?.root ?? null);
  // 存在性必须查知识库索引（index.docs），不能用「已打开文档」docs，否则未打开即误判死链。
  const index = useEmberStore((state) => state.index);
  const hasDoc = useMemo(
    () => (path: string): boolean => index.docs.has(path),
    [index],
  );
  const docTree = useMemo(() => buildTree(index.docs), [index]);
  const mediaTree = useMemo(
    () => buildMediaMenuTree(mediaEntries),
    [mediaEntries],
  );

  // CR-20261121-56：卡片出链/反链数据源——画布挂载即幂等触发后台链接索引；
  // 索引就绪后强制重算视图（node-layer 卡片第 3 行随 setNodes 重绘）。
  const linkIndexStatus = useEmberStore((state) => state.linkIndexStatus);
  useEffect(() => {
    void useEmberStore.getState().ensureLinkIndex();
  }, []);
  useEffect(() => {
    if (linkIndexStatus !== 'ready') return;
    sessionRef.current?.engine.refreshViews();
  }, [linkIndexStatus]);

  useEffect(() => {
    if (menu === null) return;
    const target = menu.target;
    if (target.kind !== 'contextMenu' || target.target.kind !== 'blank') return;
    let live = true;
    void mediaApi.list()
      .then((entries) => {
        if (live) setMediaEntries(entries);
      })
      .catch(() => {
        if (live) setMediaEntries([]);
      });
    return () => {
      live = false;
    };
  }, [menu]);

  const enqueue = useCallback((task: () => Promise<void>): void => {
    queueRef.current = queueRef.current.then(task, task).catch((error: unknown) => {
      pushNotice(`画布切换失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
    });
  }, []);

  const deactivateSession = useCallback(
    async (session: MountedSession): Promise<boolean> => {
      const disposer = createCanvasSwitchDisposer({
        lockInteraction: () => {
          session.engine.lockInteraction();
        },
        resumeInteraction: () => {
          session.engine.resumeInteraction();
        },
        beforeFlush: () => session.engine.flushPending(),
        flush: () => store.flush({ timeoutMs: SWITCH_FLUSH_TIMEOUT_MS }),
        dispose: async () => {
          session.unsubscribe();
          if (sessionRef.current === session) sessionRef.current = null;
          await session.engine.dispose();
        },
      });
      try {
        await disposer();
        setReadOnly(false);
        setCanvasStatus(null);
        setResolvingConflict(null);
        return true;
      } catch (error: unknown) {
        pushNotice(`画布保存失败，已留在当前画布：${formatUnknownError(error, '未知画布错误')}`, 'error');
        return false;
      }
    },
    [store],
  );

  const handleConflictAction = useCallback(
    (action: 'keep-local' | 'accept-external'): void => {
      const engine = sessionRef.current?.engine;
      if (engine === undefined) {
        pushNotice('画布尚未就绪，无法处理冲突', 'warning');
        return;
      }
      setResolvingConflict(action);
      void (async () => {
        try {
          const result = await resolveCanvasConflictAfterInspection(engine, action);
          if (!result.ok) pushNotice(result.reason, 'error');
        } catch (error: unknown) {
          pushNotice(`冲突处理失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        } finally {
          if (sessionRef.current?.engine === engine) {
            setReadOnly(engine.isReadOnly());
            setCanvasStatus(engine.getCanvasStatus());
            setResolvingConflict(null);
          }
        }
      })();
    },
    [],
  );

  // C0-D：engine 事件处理——右键菜单、双击（文档节点开文章 / 文本节点编辑）。
  const handleEngineEvent = useCallback(
    (event: CanvasEngineEvent, engine: CanvasEngine): void => {
      if (event.kind === 'contextMenu') {
        setEditing(null);
        setRebindNodeId(null);
        const hit = event.target;
        const hitNode =
          hit.kind === 'node'
            ? (engine.getNodeViews().find((view) => view.id === hit.id) ?? null)
            : null;
        setMenu({
          x: event.screenPoint.x,
          y: event.screenPoint.y,
          target: event,
          nodeDocPath: hitNode?.docPath ?? null,
          nodeLabel: hitNode?.label ?? null,
          nodeKind: hitNode?.kind ?? null,
        });
        return;
      }
      if (event.kind === 'connectionDropEmpty') {
        setMenu(null);
        setEditing(null);
        setConnectionMenu({
          x: event.screenPoint.x,
          y: event.screenPoint.y,
          worldPoint: event.worldPoint,
          from: event.from,
        });
        return;
      }
      if (event.kind === 'mediaDropToEditor') {
        try {
          const routed = insertMediaIntoEditor(event.windowId, event.media, event.clientPoint);
          if (!routed) pushNotice('目标编辑器尚未就绪，无法插入媒体', 'warning');
        } catch (error: unknown) {
          pushNotice(`媒体插入失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        }
        return;
      }
      if (event.kind === 'doubleClickNode') {
        setMenu(null);
        const nodes = engine.getDocument().nodes;
        const node = nodes.find(
          (n) =>
            n !== null &&
            typeof n === 'object' &&
            (n as { readonly id?: unknown }).id === event.nodeId,
        ) as
          | {
              readonly id: string;
              readonly x: number;
              readonly y: number;
              readonly type?: unknown;
              readonly label?: string;
              readonly docPath?: unknown;
              readonly text?: unknown;
            }
          | undefined;
        if (node === undefined) return;
        // 文档节点：双击打开关联文章，不进入文本编辑。
        if (node.type === 'document' && typeof node.docPath === 'string' && node.docPath !== '') {
          const emberState = useEmberStore.getState();
          const link = classifyDocLink(
            node.docPath,
            emberState.resolveDocPath,
            (path) => emberState.index.docs.has(path),
          );
          if (link.kind === 'dead') {
            pushNotice(`文档不存在：${link.effectivePath}`, 'error');
            return;
          }
          openWindow(
            link.kind === 'ok' ? link.effectivePath : node.docPath,
            EDITOR_WINDOW_CONTENT,
            getViewport(),
          );
          return;
        }
        // CR-20261121-53：提示词节点 → 多行编辑浮层；AI 节点 → 模型选择浮层。
        if (node.type === 'prompt') {
          setEditing({
            kind: 'prompt',
            nodeId: node.id,
            nodeX: node.x,
            nodeY: node.y,
            label: '',
            text: typeof node.text === 'string' ? node.text : '',
          });
          return;
        }
        if (node.type === 'ai') {
          setModelPicker({ nodeId: node.id, nodeX: node.x, nodeY: node.y });
          return;
        }
        setEditing({
          nodeId: node.id,
          nodeX: node.x,
          nodeY: node.y,
          label:
            typeof node.label === 'string' && node.label !== '' ? node.label : node.id,
        });
      }
    },
    [],
  );

  // CR-20261121-53：提示词编辑提交（空串=清空为占位；换行统一 \n）。
  const commitPromptEdit = useCallback(
    (text: string): void => {
      const session = sessionRef.current;
      if (session === null || editing === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法编辑提示词', 'warning');
        setEditing(null);
        return;
      }
      const normalized = text.replace(/\r\n/g, '\n');
      const ok = session.engine.executeCommands([
        createUpdatePromptTextCommand(editing.nodeId, normalized),
      ]);
      if (!ok) {
        pushNotice('提示词保存失败，请查看画布通知', 'error');
        return;
      }
      setEditing(null);
    },
    [editing, readOnly],
  );

  // CR-20261121-53：AI 节点模型选择浮层；打开时按当前 AI 设置拉取模型列表。
  const [modelPicker, setModelPicker] = useState<CanvasModelPickerState | null>(null);
  const [modelChoices, setModelChoices] = useState<CanvasModelChoices>({ state: 'loading' });

  // CR-20261122-63：编辑/模型选择浮层覆盖时，只隐藏底层装饰，不清除选中或 AI 状态。
  useEffect(() => {
    const engine = sessionRef.current?.engine;
    engine?.setEditingNode(editing?.nodeId ?? modelPicker?.nodeId ?? null);
    return () => engine?.setEditingNode(null);
  }, [editing, modelPicker]);

  useEffect(() => {
    if (modelPicker === null) return;
    let cancelled = false;
    setModelChoices({ state: 'loading' });
    const config = useAiChatStore.getState().config;
    void aiApi.listModels({
      provider: config.provider,
      baseUrl: config.baseUrl,
      allowInsecureHttp: config.allowInsecureHttp,
    })
      .then((dto) => {
        if (!cancelled) setModelChoices({ state: 'ready', models: dto.models });
      })
      .catch(() => {
        if (!cancelled) setModelChoices({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [modelPicker]);

  // CR-20261122-62：AI 节点执行（有向文档素材/输出 → chatStream → 文本或空文档写回）。
  const [runningAi, setRunningAi] = useState<
    { readonly nodeId: string; readonly requestId: string } | null
  >(null);
  const aiRunnerRef = useRef<AiNodeRunner | null>(null);
  const aiFlashTimerRef = useRef<{
    readonly engine: CanvasEngine;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const clearAiFlash = useCallback((): void => {
    const pending = aiFlashTimerRef.current;
    if (pending === null) return;
    clearTimeout(pending.timer);
    pending.engine.setAiFlash(null);
    aiFlashTimerRef.current = null;
  }, []);
  const flashAiResult = useCallback(
    (engine: CanvasEngine, nodeId: string, kind: 'ok' | 'error'): void => {
      clearAiFlash();
      engine.setAiFlash({ id: nodeId, kind });
      const timer = setTimeout(() => {
        engine.setAiFlash(null);
        if (aiFlashTimerRef.current?.timer === timer) aiFlashTimerRef.current = null;
      }, 1500);
      aiFlashTimerRef.current = { engine, timer };
    },
    [clearAiFlash],
  );
  useEffect(() => {
    const engine = sessionRef.current?.engine;
    engine?.setAiRunning(runningAi?.nodeId ?? null);
    return () => {
      engine?.setAiRunning(null);
    };
  }, [runningAi]);
  useEffect(() => clearAiFlash, [clearAiFlash]);

  const runAiNodeRef = useRef<(aiNodeId: string) => Promise<void> | void>(() => undefined);
  const runAiNode = useCallback(
    async (aiNodeId: string): Promise<void> => {
      const session = sessionRef.current;
      if (session === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法执行 AI 节点', 'warning');
        return;
      }
      if (aiRunnerRef.current !== null) {
        pushNotice('已有 AI 节点在执行，请先取消', 'warning');
        return;
      }
      const engine = session.engine;
      clearAiFlash();
      const runner = createAiNodeRunner({
        getDocument: () => engine.getDocument(),
        liveText: (path) => useEmberStore.getState().docs.get(path)?.text ?? null,
        readSnapshot: (path) => docApi.read(path),
        aiConfig: useAiChatStore.getState().config,
        stream: (request, handlers) => {
          setRunningAi({ nodeId: aiNodeId, requestId: request.requestId });
          return aiApi.chatStream(request, {
            onDelta: (event) => handlers.onDelta(event.text),
            onDone: () => handlers.onDone(),
            onError: (_error, event) => handlers.onError(event.code, event.message),
          });
        },
        cancel: (requestId) => {
          void aiApi.cancel(requestId).catch(() => undefined);
        },
        notice: (message, tone) => pushNotice(message, tone),
        execute: async (output) => {
          if (output.kind === 'label') {
            return engine.executeCommands([createUpdateLabelCommand(output.nodeId, output.text)])
              ? { ok: true }
              : { ok: false, reason: 'command' };
          }
          try {
            const result = await useEmberStore
              .getState()
              .writeDocText(output.docPath, output.text, output.expectedSha);
            if (!result.ok) {
              return result.reason === 'dirty'
                ? { ok: false, reason: 'dirty' }
                : { ok: false, reason: 'failed', error: result.error };
            }
            engine.invalidateDocPreview(output.docPath);
            engine.refreshViews();
            return { ok: true };
          } catch (error: unknown) {
            return { ok: false, reason: 'failed', error };
          }
        },
        flash: (nodeId, kind) => flashAiResult(engine, nodeId, kind),
      });
      aiRunnerRef.current = runner;
      try {
        await runner.start(aiNodeId);
      } finally {
        if (aiRunnerRef.current === runner) {
          aiRunnerRef.current = null;
          setRunningAi(null);
        }
      }
    },
    [clearAiFlash, flashAiResult, readOnly],
  );
  runAiNodeRef.current = runAiNode;

  const cancelAiRun = useCallback((): void => {
    const runner = aiRunnerRef.current;
    if (runner === null) return;
    aiRunnerRef.current = null;
    setRunningAi(null);
    runner.cancel();
  }, []);

  const closeMenu = useCallback((): void => {
    setMenu(null);
    setRebindNodeId(null);
  }, []);

  // CR-37/CR-20261121-43：节点「翻译关联文档」——先打开文档窗口再启动对照翻译（只译正文）。
  const translateNodeDoc = useCallback((engine: CanvasEngine, nodeId: string): void => {
    const path = docPathOf(engine, nodeId);
    if (path === null) {
      pushNotice('该节点未绑定文档路径', 'warning');
      return;
    }
    const label =
      engine.getNodeViews().find((node) => node.id === nodeId)?.label ??
      documentTitleFromPath(path);
    const start = (text: string): void => {
      openWindow(path, EDITOR_WINDOW_CONTENT, getViewport());
      useTranslateStore.getState().start({
        text: parseFrontmatter(text).body,
        sourcePath: path,
        sourceLabel: label,
      });
    };
    const live = useEmberStore.getState().docs.get(path)?.text;
    if (live !== undefined) {
      start(live);
      return;
    }
    void docApi.read(path)
      .then((dto) => start(dto.text))
      .catch((error: unknown) => {
        pushNotice(`读取文档失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
      });
  }, []);

  // C0-D：右键菜单项 → CanvasCommand[]。
  const executeMenuAction = useCallback(
    (action: string): void => {
      const session = sessionRef.current;
      const engine = session?.engine;
      const currentMenu = menu;
      if (engine === undefined || currentMenu === null) {
        closeMenu();
        return;
      }
      const tgt = currentMenu.target;
      // 阅读与翻译均为只读动作，先于只读守卫处理。
      if (action === 'openReadMode') {
        if (tgt.kind === 'contextMenu' && tgt.target.kind === 'node' && currentMenu.nodeDocPath !== null) {
          onOpenReadMode?.({
            docPath: currentMenu.nodeDocPath,
            title: currentMenu.nodeLabel ?? '',
            sourceNodeId: tgt.target.id,
          });
        }
        closeMenu();
        return;
      }
      // 翻译只读，不修改画布，先于只读守卫处理。
      if (action === 'translateDoc') {
        if (tgt.kind === 'contextMenu' && tgt.target.kind === 'node') {
          translateNodeDoc(engine, tgt.target.id);
        }
        closeMenu();
        return;
      }
      // Defense-in-depth：按钮已 disabled，但入口仍加前置守卫。
      if (readOnly) {
        pushNotice('画布只读，无法执行此操作', 'warning');
        closeMenu();
        return;
      }
      const worldPt = 'screenPoint' in tgt ? engine.screenToWorld(tgt.screenPoint) : null;
      const commands: CanvasCommand[] = [];
      /** CR-20261121-49：新建文本节点后立即进入编辑态。 */
      let createdEdit: {
        readonly id: string;
        readonly x: number;
        readonly y: number;
        readonly prompt?: boolean;
      } | null = null;

      switch (action) {
        case 'addText': {
          if (worldPt !== null) {
            const command = createAddTextNodeCommand(worldPt.x, worldPt.y);
            commands.push(command);
            if (command.kind === 'addNode') {
              createdEdit = { id: command.node.id, x: worldPt.x, y: worldPt.y };
            }
          }
          break;
        }
        case 'addAi': {
          if (worldPt !== null) commands.push(createAddAiNodeCommand(worldPt.x, worldPt.y));
          break;
        }
        case 'addPrompt': {
          if (worldPt !== null) {
            const command = createAddPromptNodeCommand(worldPt.x, worldPt.y);
            commands.push(command);
            if (command.kind === 'addNode') {
              createdEdit = { id: command.node.id, x: worldPt.x, y: worldPt.y, prompt: true };
            }
          }
          break;
        }
        case 'editPrompt': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'node') {
            closeMenu();
            return;
          }
          const promptNodeId: string = tgt.target.id;
          const promptNode = engine
            .getDocument()
            .nodes.find(
              (n) =>
                n !== null &&
                typeof n === 'object' &&
                (n as { readonly id?: unknown }).id === promptNodeId,
            ) as
            | {
                readonly id: string;
                readonly x?: unknown;
                readonly y?: unknown;
                readonly text?: unknown;
              }
            | undefined;
          if (
            promptNode === undefined ||
            typeof promptNode.x !== 'number' ||
            typeof promptNode.y !== 'number'
          ) {
            closeMenu();
            return;
          }
          setEditing({
            kind: 'prompt',
            nodeId: promptNode.id,
            nodeX: promptNode.x,
            nodeY: promptNode.y,
            label: '',
            text: typeof promptNode.text === 'string' ? promptNode.text : '',
          });
          closeMenu();
          return;
        }
        case 'chooseModel': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'node') {
            closeMenu();
            return;
          }
          const chooseModelNodeId: string = tgt.target.id;
          const aiNode = engine
            .getDocument()
            .nodes.find(
              (n) =>
                n !== null &&
                typeof n === 'object' &&
                (n as { readonly id?: unknown }).id === chooseModelNodeId,
            ) as
            | { readonly id: string; readonly x?: unknown; readonly y?: unknown }
            | undefined;
          if (aiNode === undefined || typeof aiNode.x !== 'number' || typeof aiNode.y !== 'number') {
            closeMenu();
            return;
          }
          setModelPicker({ nodeId: aiNode.id, nodeX: aiNode.x, nodeY: aiNode.y });
          closeMenu();
          return;
        }
        case 'runAi': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'node') {
            closeMenu();
            return;
          }
          const aiNodeId = tgt.target.id;
          closeMenu();
          void runAiNode(aiNodeId);
          return;
        }
        case 'cancelAi': {
          cancelAiRun();
          closeMenu();
          return;
        }
        case 'addDocument': {
          setRebindNodeId(null);
          return;
        }
        case 'deleteNode': {
          if (
            tgt.kind !== 'contextMenu' ||
            tgt.target.kind !== 'node'
          ) {
            closeMenu();
            return;
          }
          commands.push(...createRemoveNodeCommands([tgt.target.id]));
          break;
        }
        case 'deleteEdge': {
          if (
            tgt.kind !== 'contextMenu' ||
            tgt.target.kind !== 'edge'
          ) {
            closeMenu();
            return;
          }
          commands.push(...createRemoveEdgeCommands([tgt.target.id]));
          break;
        }
        case 'openDoc': {
          if (
            tgt.kind !== 'contextMenu' ||
            tgt.target.kind !== 'node'
          ) {
            closeMenu();
            return;
          }
          const openId = tgt.target.id;
          const docNode = engine.getDocument().nodes.find(
            (n) =>
              n !== null &&
              typeof n === 'object' &&
              (n as { readonly id?: unknown }).id === openId,
          ) as { readonly id: string; readonly docPath?: unknown } | undefined;
          if (
            docNode === undefined ||
            typeof docNode.docPath !== 'string' ||
            docNode.docPath === ''
          ) {
            pushNotice('该节点未绑定文档路径', 'warning');
            closeMenu();
            return;
          }
          openLibraryDocument(docNode.docPath, {
            hasDoc,
            resolveDocPath,
            open: (path) => openWindow(path, EDITOR_WINDOW_CONTENT, getViewport()),
            onMissing: (path) => {
              pushNotice(`文档不存在：${path}`, 'error');
              closeMenu();
            },
          });
          break;
        }
        case 'rebindDoc': {
          if (
            tgt.kind !== 'contextMenu' ||
            tgt.target.kind !== 'node'
          ) {
            closeMenu();
            return;
          }
          setRebindNodeId(tgt.target.id);
          return;
        }
        default:
          closeMenu();
          return;
      }

      if (commands.length > 0) {
        if (!engine.executeCommands(commands)) {
          pushNotice('画布操作失败，未应用更改', 'error');
        } else if (createdEdit !== null) {
          // 新节点直接进入编辑：文本节点输入框为空；提示词节点进多行编辑（⌘/Ctrl+Enter 提交）。
          setEditing({
            ...(createdEdit.prompt === true ? { kind: 'prompt' as const, text: '' } : {}),
            nodeId: createdEdit.id,
            nodeX: createdEdit.x,
            nodeY: createdEdit.y,
            label: '',
          });
        }
      }
      closeMenu();
    },
    [
      menu,
      resolveDocPath,
      hasDoc,
      closeMenu,
      readOnly,
      translateNodeDoc,
      onOpenReadMode,
      runAiNode,
      cancelAiRun,
    ],
  );

  // C0-D：层级选择器点选文件 → 在该处新建文档节点。
  const handlePickDoc = useCallback(
    (path: string): void => {
      const engine = sessionRef.current?.engine;
      const currentMenu = menu;
      if (engine === undefined || currentMenu === null) {
        closeMenu();
        return;
      }
      if (readOnly || engine.isReadOnly()) {
        pushNotice('画布只读，无法修改文档节点', 'warning');
        closeMenu();
        return;
      }
      if (!hasDoc(path)) {
        pushNotice('仅可选择知识库内文档', 'warning');
        closeMenu();
        return;
      }
      if (rebindNodeId !== null) {
        const rebound = engine.executeCommands([
          createUpdateDocPathCommand(rebindNodeId, path),
        ]);
        if (!rebound) pushNotice('重绑文档路径失败', 'error');
        closeMenu();
        return;
      }
      if (!('screenPoint' in currentMenu.target)) {
        closeMenu();
        return;
      }
      const world = engine.screenToWorld(currentMenu.target.screenPoint);
      const ok = engine.executeCommands([
        createAddDocumentNodeCommand(world.x, world.y, path),
      ]);
      if (!ok) pushNotice('新建文档节点失败', 'error');
      closeMenu();
    },
    [menu, closeMenu, hasDoc, readOnly, rebindNodeId],
  );

  // 右键「媒体库」→ 在点击位置插入媒体节点；PDF/HTML 文档附件无画布动作（CR-20261121-55，
  // 查看入口在设置中的媒体库）。菜单树全部来自 media/ 条目，不再挂知识库文章列表。
  const handlePickMedia = useCallback(
    (path: string): void => {
      if (path.endsWith('__empty__')) {
        closeMenu();
        return;
      }
      const engine = sessionRef.current?.engine;
      const currentMenu = menu;
      if (engine === undefined || currentMenu === null) {
        closeMenu();
        return;
      }
      if (readOnly || engine.isReadOnly()) {
        pushNotice('画布只读，无法创建媒体节点', 'warning');
        closeMenu();
        return;
      }
      const entry = mediaEntries.find((candidate) => candidate.path === path);
      if (entry === undefined) {
        pushNotice('媒体文件不存在或已被移除', 'warning');
        closeMenu();
        return;
      }
      if (entry.kind === 'doc') {
        pushNotice('PDF/HTML 附件暂不支持插入画布，可在设置的媒体库中查看', 'info');
        closeMenu();
        return;
      }
      if (!('screenPoint' in currentMenu.target)) {
        closeMenu();
        return;
      }
      const world = engine.screenToWorld(currentMenu.target.screenPoint);
      const ok = engine.executeCommands([
        createAddMediaNodeCommand(
          world.x,
          world.y,
          entry.path,
          entry.kind,
          fileNameFromPath(entry.path),
        ),
      ]);
      if (!ok) pushNotice('新建媒体节点失败', 'error');
      closeMenu();
    },
    [menu, closeMenu, mediaEntries, readOnly],
  );

  // N4：关闭拉线菜单——清本地状态并让 engine 清掉连接草稿（不写文档、不入历史）。
  const closeConnectionMenu = useCallback((): void => {
    sessionRef.current?.engine.cancelConnection();
    setConnectionMenu(null);
  }, []);

  // N4：一次性提交 addNode + addEdge；失败显式提示并清草稿。
  const commitConnectionNode = useCallback(
    (node: CanvasNodeInput): void => {
      const engine = sessionRef.current?.engine;
      const current = connectionMenu;
      if (engine === undefined || current === null) {
        closeConnectionMenu();
        return;
      }
      if (readOnly) {
        pushNotice('画布只读，无法创建节点', 'warning');
        closeConnectionMenu();
        return;
      }
      const ok = engine.executeCommands(
        createConnectNewNodeCommands(
          { ...node, ports: createConnectionNodePorts() },
          current.from,
        ),
      );
      if (!ok) {
        pushNotice('创建节点与连线失败', 'error');
        closeConnectionMenu();
        return;
      }
      setConnectionMenu(null);
    },
    [connectionMenu, readOnly, closeConnectionMenu],
  );

  const chooseConnectionText = useCallback((): void => {
    const current = connectionMenu;
    if (current === null) return;
    commitConnectionNode({
      id: makeNodeId(),
      x: current.worldPoint.x,
      y: current.worldPoint.y,
      type: 'text',
      label: '文本节点',
    });
  }, [connectionMenu, commitConnectionNode]);

  // N4：层级选择器点选文件 → 在落点新建文档节点并连边。
  const handlePickConnectionDoc = useCallback(
    (path: string): void => {
      const current = connectionMenu;
      if (current === null) {
        closeConnectionMenu();
        return;
      }
      commitConnectionNode({
        id: makeNodeId(),
        x: current.worldPoint.x,
        y: current.worldPoint.y,
        type: 'document',
        docPath: path,
        label: documentTitleFromPath(path),
      });
    },
    [connectionMenu, commitConnectionNode, closeConnectionMenu],
  );

  // C0-D：文本编辑提交/取消。
  const commitEdit = useCallback(
    (label: string): void => {
      const session = sessionRef.current;
      if (session === null || editing === null) return;
      const trimmed = label.trim();
      if (trimmed === '') {
        pushNotice('节点名称不能为空', 'warning');
        return;
      }
      if (readOnly) {
        pushNotice('画布只读，无法编辑标签', 'warning');
        setEditing(null);
        return;
      }
      const ok = session.engine.executeCommands([createUpdateLabelCommand(editing.nodeId, trimmed)]);
      if (!ok) {
        pushNotice('更新失败，请查看画布通知', 'error');
        // 不关闭 editing，让用户再试一次；或用户可 Esc 取消
        return;
      }
      setEditing(null);
    },
    [editing, readOnly],
  );

  const cancelEdit = useCallback((): void => setEditing(null), []);

  // CR-20261121-58：右键菜单「离开即闭」——指针离开菜单根起 180ms 定时器，
  // 进入菜单/子面板（pointerenter 冒泡回根）即取消；超时未回才关闭。不驻留、不误伤子菜单。
  const menuCloseTimerRef = useRef<number | null>(null);
  const cancelMenuClose = useCallback((): void => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
  }, []);
  const scheduleMenuClose = useCallback((): void => {
    if (menuCloseTimerRef.current !== null) return;
    menuCloseTimerRef.current = window.setTimeout(() => {
      menuCloseTimerRef.current = null;
      closeMenu();
    }, 180);
  }, [closeMenu]);
  useEffect(
    () => () => {
      if (menuCloseTimerRef.current !== null) window.clearTimeout(menuCloseTimerRef.current);
    },
    [],
  );

  // C0-D：点击画布任意位置关闭菜单。
  useEffect(() => {
    if (menu === null) return;
    const onDocClick = (): void => closeMenu();
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [menu, closeMenu]);

  // N4：拉线菜单的「点外部 / Esc 取消」只清草稿与菜单。
  useEffect(() => {
    if (connectionMenu === null) return;
    const onDocClick = (): void => closeConnectionMenu();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeConnectionMenu();
    };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [connectionMenu, closeConnectionMenu]);

  const mountSession = useCallback(
    async (targetId: string, runId: number, host: HTMLElement): Promise<void> => {
      setEditing(null);
      setModelPicker(null);
      let opened: CanvasOpenResult;
      try {
        opened = await store.open(targetId);
      } catch (error: unknown) {
        if (guardRef.current.isCurrent(runId)) {
          pushNotice(`打开画布失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        }
        return;
      }
      if (!guardRef.current.isCurrent(runId)) return;

      const classification = classifyCanvasOpen(opened);
      if (classification.kind === 'missing') {
        setReadOnly(false);
        pushNotice('画布不存在，请刷新清单', 'warning');
        return;
      }
      if (classification.kind === 'fatal') {
        setReadOnly(false);
        pushNotice(`画布无法打开（${classification.code}）：${classification.message}`, 'error');
        return;
      }

      const engine = new CanvasEngine({
        host,
        store,
        canvasId: targetId,
        registry,
        initialOpen: opened,
        // CR-20261119-05：已打开编辑器的 live text 优先，否则 vault_read 只读快照。
        docSource: {
          readLiveText: (path) => useEmberStore.getState().docs.get(path)?.text ?? null,
          readSnapshot: (path) => useEmberStore.getState().readDocSnapshot(path),
        },
        // CR-20261121-56：卡片出链/反链（wiki 语义；索引未就绪返回 null，整行隐藏）。
        // CR-20261121-59：提示词右下角「开始」钮 → 找所连 AI 节点执行（未连接给出指引）。
        // 经 ref 调用（runAiNode 声明在本回调之后，避免 TDZ）。
        onRunPrompt: (promptId) => {
          const sessionNow = sessionRef.current;
          if (sessionNow === null) return;
          const raw = sessionNow.engine.getDocument();
          let aiNodeId: string | null = null;
          for (const edge of raw.edges) {
            if (typeof edge !== 'object' || edge === null || Array.isArray(edge)) continue;
            const rec = edge as { readonly from?: unknown; readonly to?: unknown };
            const nodeIdOf = (value: unknown): string | null => {
              if (typeof value !== 'object' || value === null) return null;
              const nodeId = (value as { readonly nodeId?: unknown }).nodeId;
              return typeof nodeId === 'string' && nodeId !== '' ? nodeId : null;
            };
            const from = nodeIdOf(rec.from);
            const to = nodeIdOf(rec.to);
            const other = from === promptId ? to : to === promptId ? from : null;
            if (other === null) continue;
            const otherNode = raw.nodes.find(
              (n) =>
                typeof n === 'object' &&
                n !== null &&
                (n as { readonly id?: unknown }).id === other &&
                (n as { readonly type?: unknown }).type === 'ai',
            );
            if (otherNode !== undefined) {
              aiNodeId = other;
              break;
            }
          }
          if (aiNodeId === null) {
            pushNotice('提示词未连接到 AI 节点：先把提示词节点连到一个 AI 节点', 'warning');
            return;
          }
          void runAiNodeRef.current(aiNodeId);
        },
        readDocLinkCounts: (path) => {
          const index = useEmberStore.getState().linkIndex;
          if (index === null) return null;
          const entry = index.entries.get(path);
          return {
            out: entry === undefined ? 0 : new Set(entry.targets).size,
            back: index.backlinks.get(path)?.length ?? 0,
          };
        },
        onOpenReadMode,
      });
      const session: MountedSession = {
        canvasId: targetId,
        engine,
        unsubscribe: () => undefined,
      };
      const offNotices = engine.subscribeCanvasNotices((notice) => {
        setReadOnly(engine.isReadOnly());
        setCanvasStatus(engine.getCanvasStatus());
        pushNotice(notice.message, noticeTone(notice));
      });
      const offEvents = engine.subscribeEngineEvents((event) => {
        handleEngineEvent(event, engine);
      });
      session.unsubscribe = () => {
        offNotices();
        offEvents();
      };
      sessionRef.current = session;
      setReadOnly(classification.readOnly);
      setCanvasStatus(engine.getCanvasStatus());
      setResolvingConflict(null);

      try {
        await engine.mount();
      } catch (error: unknown) {
        session.unsubscribe();
        if (sessionRef.current === session) sessionRef.current = null;
        setReadOnly(false);
        setCanvasStatus(null);
        pushNotice(`画布挂载失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        return;
      }

      if (!guardRef.current.isCurrent(runId)) {
        // 过期挂载：只清理本实例；registry token 不匹配，不会注销新实例。
        if (sessionRef.current === session) sessionRef.current = null;
        session.unsubscribe();
        await engine.dispose();
        return;
      }
      setReadOnly(engine.isReadOnly());
      setCanvasStatus(engine.getCanvasStatus());
    },
    [store, registry, handleEngineEvent, onOpenReadMode],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const runId = guardRef.current.begin();

    enqueue(async () => {
      if (!guardRef.current.isCurrent(runId)) return;
      const session = sessionRef.current;
      if (session !== null && (!active || session.canvasId !== canvasId)) {
        const ok = await deactivateSession(session);
        if (!ok) {
          onSwitchFailure(session.canvasId);
          return;
        }
      }
      if (!guardRef.current.isCurrent(runId)) return;
      if (!active || canvasId === null) return;
      if (sessionRef.current !== null) return;
      await mountSession(canvasId, runId, host);
    });
  }, [active, canvasId, enqueue, deactivateSession, mountSession, onSwitchFailure]);

  useEffect(
    () => () => {
      guardRef.current.invalidate();
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session !== null) {
        session.unsubscribe();
        void session.engine.dispose().catch((error: unknown) => {
          pushNotice(`画布清理失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        });
      }
    },
    [],
  );

  /**
   * CR-20261119-05：已打开文档的 live text 变化时刷新文档节点预览。
   * 只比较 docs 引用，避免无关 store 更新触发画布重绘。
   */
  useEffect(() => {
    return useEmberStore.subscribe((state, previous) => {
      if (state.docs === previous.docs) return;
      sessionRef.current?.engine.refreshDocPreviews();
    });
  }, []);

  /**
   * 文档行 / 媒体卡片指针拖拽的落点处理（统一通道）。
   *
   * 拖动侧在 pointerup 用 elementFromPoint 命中 `[data-canvas-drop-host]` 后派发
   * CustomEvent；这里再做宿主矩形、只读、库内路径与命令返回值四层校验。
   */
  useEffect(() => {
    const onPointerDragDrop = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = readPointerDragDropDetail(event.detail);
      if (detail === null) return;
      const host = hostRef.current;
      const session = sessionRef.current;
      if (host === null || session === null) return;
      const rect = host.getBoundingClientRect();
      const inside =
        detail.clientX >= rect.left &&
        detail.clientX <= rect.right &&
        detail.clientY >= rect.top &&
        detail.clientY <= rect.bottom;
      if (!inside) return;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (target?.closest('[data-canvas-drop-host]') !== host) return;
      if (readOnly || session.engine.isReadOnly()) {
        pushNotice('画布只读，无法创建节点', 'warning');
        return;
      }
      const { payload } = detail;
      // D11：命中已有节点时把新节点放到该节点右侧。
      const world = resolveDropWorld(session.engine, {
        x: detail.clientX - rect.left,
        y: detail.clientY - rect.top,
      });
      if (payload.kind === 'doc') {
        if (!isSafeLibraryDocPath(payload.path, hasDoc)) {
          pushNotice('仅可拖入知识库内文档', 'warning');
          return;
        }
        if (
          !session.engine.executeCommands([
            createAddDocumentNodeCommand(world.x, world.y, payload.path),
          ])
        ) {
          pushNotice('创建文档节点失败', 'error');
        }
        return;
      }
      if (payload.kind === 'text') {
        if (!session.engine.executeCommands([
          createAddTextNodeCommand(world.x, world.y, textLabelFromText(payload.text)),
        ])) {
          pushNotice('创建文本节点失败', 'error');
        }
        return;
      }
      if (payload.kind === 'files') {
        void createNodesFromFinderPaths(
          session.engine,
          payload.paths,
          world,
          libraryRoot,
          hasDoc,
          onCollectFiles,
        ).catch((error: unknown) => {
          pushNotice(`拖入处理失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        });
        return;
      }
      if (!isSafeLibraryMediaPath(payload.path)) {
        pushNotice('仅可拖入知识库内媒体', 'warning');
        return;
      }
      const kind = mediaKindFromLibraryPath(payload.path);
      if (kind === 'doc') {
        pushNotice('文档附件仅存于媒体库，不进画布', 'warning');
        return;
      }
      if (kind === null) {
        pushNotice('无法判定媒体类型', 'error');
        return;
      }
      if (
        !session.engine.executeCommands([
          createAddMediaNodeCommand(world.x, world.y, payload.path, kind),
        ])
      ) {
        pushNotice('创建媒体节点失败', 'error');
      }
    };
    document.addEventListener(POINTER_DRAG_DROP_EVENT, onPointerDragDrop);
    return () => document.removeEventListener(POINTER_DRAG_DROP_EVENT, onPointerDragDrop);
  }, [readOnly, hasDoc, libraryRoot, onCollectFiles]);

  // C1-B：文档列表→画布。dragover 必须 preventDefault 才允许 drop。
  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);
  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>): void => {
      event.preventDefault();
      if (readOnly) {
        pushNotice('画布只读，无法创建节点', 'warning');
        return;
      }
      const session = sessionRef.current;
      if (session === null) {
        pushNotice('画布尚未就绪，无法接收拖拽', 'warning');
        return;
      }
      const parsed = readPayload({
        getData: (format: string): string => event.dataTransfer.getData(format),
      });
      if (!parsed.ok) {
        pushNotice(`拖拽数据无效：${parsed.reason}`, 'error');
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const localPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      // D11：命中已有节点时走 canvas-node 裁决，并把新节点锚定到该节点右侧。
      const hitNode = hitTestNodes(session.engine.getNodeViews(), session.engine.getTransform(), localPoint);
      const decision = CANVAS_DROP_TARGETS.resolve(hitNode === null ? 'canvas' : 'canvas-node', parsed.payload);
      if (!decision.accepted) {
        pushNotice(decision.reason, 'error');
        return;
      }
      const payload = decision.payload;
      const world = resolveDropWorld(session.engine, localPoint);
      if (payload.kind === 'doc') {
        if (
          !session.engine.executeCommands([
            createAddDocumentNodeCommand(world.x, world.y, payload.path),
          ])
        ) {
          pushNotice('创建文档节点失败', 'error');
        }
        return;
      }
      // C1-C：放开画布落点对 media 的接受（编辑器拖图等应用内链路）。
      if (payload.kind === 'media') {
        const kind = mediaKindFromLibraryPath(payload.path);
        if (kind === 'doc') {
          // CR-20261120-26：文档附件不进画布。
          pushNotice('文档附件仅存于媒体库，不进画布', 'warning');
          return;
        }
        if (kind === null) {
          pushNotice('无法判定媒体类型', 'error');
          return;
        }
        if (
          !session.engine.executeCommands([
            createAddMediaNodeCommand(world.x, world.y, payload.path, kind),
          ])
        ) {
          pushNotice('创建媒体节点失败', 'error');
        }
        return;
      }
      // C1-D：编辑器选区（text 载荷）落到画布，一次 addNode 带 label。
      if (payload.kind === 'text') {
        if (
          !session.engine.executeCommands([
            createAddTextNodeCommand(world.x, world.y, textLabelFromText(payload.text)),
          ])
        ) {
          pushNotice('创建文本节点失败', 'error');
        }
        return;
      }
      // D14/D11：收集箱或外部文件集合走 Finder 同款导入链路。
      if (payload.kind === 'files') {
        void createNodesFromFinderPaths(
          session.engine,
          payload.paths,
          world,
          libraryRoot,
          hasDoc,
          onCollectFiles,
        ).catch((error: unknown) => {
          pushNotice(`拖入处理失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
        });
        return;
      }
      pushNotice('该拖拽类型尚未支持', 'warning');
    },
    [readOnly, libraryRoot, hasDoc, onCollectFiles],
  );

  // Finder 原生通道由 AppShell 统一路由到此处；Canvas 不再注册第二个监听器。
  const handleFinderDrop = useCallback(
    (event: DragDropDropEvent): void => {
      if (event.paths.length === 0) return;
      const host = hostRef.current;
      if (host === null) {
        pushNotice('画布尚未就绪，无法接收拖拽', 'warning');
        return;
      }
      const rect = host.getBoundingClientRect();
      const insideHost =
        event.position.x >= rect.left &&
        event.position.x <= rect.right &&
        event.position.y >= rect.top &&
        event.position.y <= rect.bottom;
      if (!insideHost) {
        pushNotice('暂不支持拖到此处', 'warning');
        return;
      }
      if (readOnly) {
        pushNotice('画布只读，无法创建节点', 'warning');
        return;
      }
      const session = sessionRef.current;
      if (session === null) {
        pushNotice('画布尚未就绪，无法接收拖拽', 'warning');
        return;
      }
      if (session.engine.isReadOnly()) {
        pushNotice('画布只读，无法创建节点', 'warning');
        return;
      }
      // D11：命中节点时导入内容落在该节点右侧，否则落在指针位置。
      const world = resolveDropWorld(session.engine, {
        x: event.position.x - rect.left,
        y: event.position.y - rect.top,
      });
      void createNodesFromFinderPaths(
        session.engine,
        event.paths,
        world,
        libraryRoot,
        hasDoc,
        onCollectFiles,
      ).catch((error: unknown) => {
        pushNotice(`拖入处理失败：${formatUnknownError(error, '未知画布错误')}`, 'error');
      });
    },
    [readOnly, libraryRoot, hasDoc, onCollectFiles],
  );

  useImperativeHandle(
    ref,
    () => ({
      deactivate: async (): Promise<boolean> => {
        const session = sessionRef.current;
        return session === null ? true : deactivateSession(session);
      },
      getEngine: () => sessionRef.current?.engine ?? null,
      zoomAt: (factor: number): void => {
        sessionRef.current?.engine.zoomAtCenter(factor);
      },
      resetZoom: (): void => {
        sessionRef.current?.engine.resetView();
      },
      cancelGesture: (): void => {
        sessionRef.current?.engine.cancelGesture();
      },
      addNodeCentered: (kind: 'text' | 'ai' | 'prompt'): void => {
        const session = sessionRef.current;
        const host = hostRef.current;
        if (session === null || host === null) return;
        if (readOnly || session.engine.isReadOnly()) {
          pushNotice('画布只读，无法新建节点', 'warning');
          return;
        }
        const rect = host.getBoundingClientRect();
        const world = session.engine.screenToWorld({
          x: rect.width / 2,
          y: rect.height / 2,
        });
        const command =
          kind === 'text'
            ? createAddTextNodeCommand(world.x, world.y)
            : kind === 'ai'
              ? createAddAiNodeCommand(world.x, world.y)
              : createAddPromptNodeCommand(world.x, world.y);
        if (!session.engine.executeCommands([command])) {
          pushNotice('画布操作失败，未应用更改', 'error');
          return;
        }
        if (command.kind === 'addNode' && kind !== 'ai') {
          setEditing({
            ...(kind === 'prompt' ? { kind: 'prompt' as const, text: '' } : {}),
            nodeId: command.node.id,
            nodeX: world.x,
            nodeY: world.y,
            label: '',
          });
        }
      },
      revealDoc: (docPath: string): boolean => {
        const session = sessionRef.current;
        if (session === null) return false;
        const node = session.engine
          .getNodeViews()
          .find((entry) => entry.docPath === docPath);
        if (node === undefined) return false;
        session.engine.selectNode(node.id);
        session.engine.centerOn(node.id);
        return true;
      },
      hasSelection: (): boolean => {
        return sessionRef.current?.engine.hasSelection() ?? false;
      },
      hasGesture: (): boolean => {
        return sessionRef.current?.engine.hasActiveGesture() ?? false;
      },
      handleFinderDrop,
    }),
    [deactivateSession, handleFinderDrop, readOnly],
  );

  const pickerRect =
    modelPicker !== null && sessionRef.current !== null
      ? editOverlayRect(modelPicker.nodeId, modelPicker.nodeX, modelPicker.nodeY, sessionRef.current.engine)
      : null;
  const pickerCurrentModel =
    modelPicker !== null && sessionRef.current !== null
      ? (sessionRef.current.engine.getNodeViews().find((node) => node.id === modelPicker.nodeId)?.aiModel ?? '')
      : '';
  const pickerValue =
    modelChoices.state === 'ready' && modelChoices.models.includes(pickerCurrentModel)
      ? pickerCurrentModel
      : '';

  return (
    <div className={`${styles.root} ${active ? '' : styles.inactive}`}>
      <div
        ref={hostRef}
        className={styles.host}
        data-canvas-drop-host=""
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      />
      {canvasId === null ? (
        <div className={styles.empty}>
          <span className={styles.emptyMark} aria-hidden="true" />
          <p className={styles.emptyTitle}>还没有打开的画布</p>
          <p className={styles.emptyHint}>在左侧「画布」区段新建或选择画布。</p>
        </div>
      ) : null}
      {conflictActive ? (
        <section className={styles.conflictPanel} role="alert">
          <p>画布已被外部修改，本地改动尚未保存。请选择保留本地或采用外部版本。</p>
          <div className={styles.conflictActions}>
            <button
              type="button"
              className={styles.conflictButton}
              disabled={resolvingConflict !== null}
              onClick={() => handleConflictAction('keep-local')}
            >
              {resolvingConflict === 'keep-local' ? '保留中…' : '保留本地'}
            </button>
            <button
              type="button"
              className={styles.conflictButton}
              disabled={resolvingConflict !== null}
              onClick={() => handleConflictAction('accept-external')}
            >
              {resolvingConflict === 'accept-external' ? '载入中…' : '采用外部'}
            </button>
          </div>
        </section>
      ) : readOnly ? (
        <p className={styles.readonlyBanner} role="status">
          画布含 schema 问题，已整幅只读；修复文件后重新打开。
        </p>
      ) : null}
      {/* C0-D：右键菜单 */}
      {menu !== null ? (
        <CanvasContextMenu
          menu={menu}
          onAction={executeMenuAction}
          docTree={docTree}
          mediaTree={mediaTree}
          onPickDoc={handlePickDoc}
          onPickMedia={handlePickMedia}
          readOnly={readOnly}
          runningAiNodeId={runningAi === null ? null : runningAi.nodeId}
          accelerators={menuAccelerators ?? {}}
          onMenuEnter={cancelMenuClose}
          onMenuLeave={scheduleMenuClose}
        />
      ) : null}
      {/* N4：拉线落空 → 新建节点并连边 */}
      {connectionMenu !== null ? (
        <CanvasConnectionMenu
          menu={connectionMenu}
          onChooseText={chooseConnectionText}
          docTree={docTree}
          onPickDoc={handlePickConnectionDoc}
          readOnly={readOnly}
          onMenuEnter={cancelMenuClose}
          onMenuLeave={scheduleMenuClose}
        />
      ) : null}
      {/* C0-D：文本编辑覆盖层 */}
      {editing !== null && sessionRef.current !== null ? (
        <CanvasEditOverlay
          editing={editing}
          rect={editOverlayRect(editing.nodeId, editing.nodeX, editing.nodeY, sessionRef.current.engine)}
          onCommitLabel={commitEdit}
          onCommitPrompt={commitPromptEdit}
          onCancel={cancelEdit}
        />
      ) : null}
      {/* CR-20261121-53：AI 节点模型选择浮层 */}
      {modelPicker !== null && pickerRect !== null ? (
        <CanvasModelPicker
          rect={pickerRect}
          choices={modelChoices}
          value={pickerValue}
          onPick={(model) => {
            const session = sessionRef.current;
            if (session === null || modelPicker === null) return;
            const ok = session.engine.executeCommands([
              createUpdateAiModelCommand(modelPicker.nodeId, model === '' ? null : model),
            ]);
            if (!ok) pushNotice('模型选择保存失败，请查看画布通知', 'error');
            setModelPicker(null);
          }}
          onClose={() => setModelPicker(null)}
        />
      ) : null}
    </div>
  );
});
