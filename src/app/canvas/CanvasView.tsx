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
  useReducer,
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
import { CanvasAmbience, type AmbientPhotoSource } from './CanvasAmbience.tsx';
import { watchAmbientSource } from './ambient-source.ts';
import { classifyCanvasOpen } from './canvas-open.ts';
import { createCanvasSwitchDisposer } from './lifecycle.ts';
import type { CanvasEngineRegistry } from './registry.ts';
import { createCanvasMountGuard } from './view-sync.ts';
import {
  classifyDocLink,
  createAddAiNodeCommand,
  createAddDocumentNodeCommand,
  createAddMediaNodeCommand,
  createAddMergeNodeCommand,
  createAddSplitNodeCommand,
  createAddTextNodeCommand,
  createConnectNewNodeCommands,
  createConnectionNodePorts,
  createDuplicateNodeCommands,
  createRemoveEdgeCommands,
  createRemoveNodeCommands,
  createReverseEdgeCommands,
  createSetEdgeLabelCommands,
  createUpdateAiModelCommand,
  createUpdateAiTextCommand,
  createUpdateCanvasAiContextCommand,
  createUpdateDocPathCommand,
  createUpdateSplitConfigCommand,
  documentTitleFromPath,
  isSafeLibraryDocPath,
  readCanvasAiContext,
  resolveFinderDocumentPath,
  textLabelFromText,
} from './canvas-interactions.ts';
import { useAiChatStore } from '../../features/ai/ai-chat-store.ts';
import { POINTER_DRAG_DROP_EVENT, readPointerDragDropDetail } from '../dnd/pointer-drag.ts';
import { hasOutsideNodeLabel, hitTestNodes, nodeOutsideLabelLayout, nodeScreenPosition, nodeSizeOf } from './node-layout.ts';
import { readEdgeStyle } from './edge-layout.ts';
import { useCanvasEdgeStyleMenu } from './use-canvas-edge-style.tsx';
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
import { useTreeStore } from '../stores/tree-store.ts';
import { useEditorModeRequestStore } from '../stores/editor-mode-requests.ts';
import { useTranslateStore } from '../translate/translate-store.ts';
import { buildTree } from '../tree/build-tree.ts';
import { buildMediaMenuTree } from './media-menu-tree.ts';
import { CanvasAiContextDialog } from './CanvasAiContextDialog.tsx';
import { CanvasPromptPreviewDialog } from './CanvasPromptPreviewDialog.tsx';
import { buildAiNodePromptPreview, type AiPromptPreview } from './prompt-preview.ts';
import {
  CanvasConnectionMenu,
  CanvasContextMenu,
  CanvasEdgeLabelInput,
  CanvasEditOverlay,
  CanvasModelMenu,
  type CanvasMenu,
  type CanvasModelChoices,
  type CanvasModelPickerState,
  type CanvasOverlayRect,
  type ConnectionMenuState,
} from './CanvasMenus.tsx';
import { useCanvasAiRuns } from './use-canvas-ai-runs.ts';
import { startSplitPreviewProjection } from './split-preview-projection.ts';
import { findPromptAiNode } from './ai-node-execution.ts';
import type { MediaEntry } from '../../features/media/media-groups.ts';
import { docViewerFor } from '../../features/media/doc-viewer.ts';
import { createDocViewerState, docViewerReducer } from '../../features/media/doc-viewer-reducer.ts';
import { DocViewerOverlay } from '../panels/media/DocViewerOverlay.tsx';
import { modelFieldRect, modelMenuLayout } from './model-menu.ts';
import { clampMenuPoint } from './menu-position.ts';
import { useCreateEmptyArticle } from './use-create-empty-article.ts';
import { useConnectionNodeChoice } from './use-connection-node-choice.ts';
import { useCanvasEditing } from './use-canvas-editing.ts';
import { PromptEditorWindow } from './PromptEditorWindow.tsx';
import { SplitRerunConfirmDialog } from './SplitRerunConfirmDialog.tsx';
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

/** C1-C：Finder paths → 画布节点（库内 Markdown 映射相对路径；媒体与 PDF/HTML 附件先 media_save 入库）。 */
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

  // 四类媒体同链路入库建节点；逐文件独立捕获错误，多文件经 nextPoint 顺序偏移落位。
  for (const path of [...images, ...audios, ...videos, ...attachments]) {
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
      pushNotice(`媒体入库失败：${fileNameFromPath(path)} ${formatUnknownError(error, '未知画布错误')}`, 'error');
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
  /** 视口中心新建文本、AI 或文档节点；文档节点传 docPath。 */
  addNodeCentered(kind: 'text' | 'ai' | 'document', docPath?: string): boolean;
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

/** C0-D：文本铺满节点；独立标题只覆盖外标题所在行。 */
function editOverlayRect(
  nodeId: string,
  nodeX: number,
  nodeY: number,
  engine: CanvasEngine,
): CanvasOverlayRect {
  const transform = engine.getTransform();
  const current = engine.getNodeViews().find((node) => node.id === nodeId);
  if (current !== undefined && hasOutsideNodeLabel(current)) {
    const label = nodeOutsideLabelLayout(current, transform);
    const point = nodeScreenPosition(label, transform);
    const fontSize = (label.fontSize ?? 13) * transform.scale;
    return { left: point.x, top: point.y, width: label.width * transform.scale, height: fontSize * 1.2, fontSize, title: true };
  }
  const { tx, ty, scale, originX, originY } = transform;
  const size = nodeSizeOf(current ?? {});
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
  /** 内容驱动背景：恰好选中一个图片节点时的媒体地址。 */
  const [ambientSource, setAmbientSource] = useState<AmbientPhotoSource | null>(null);
  const { editing, setEditing, commitPromptEdit, commitEdit, commitTextEdit, cancelEdit } =
    useCanvasEditing(sessionRef, readOnly);
  const [docViewer, dispatchDocViewer] = useReducer(docViewerReducer, undefined, createDocViewerState);
  const [rebindNodeId, setRebindNodeId] = useState<string | null>(null);

  /** N4：拉线落空建节点菜单（与右键菜单独立）。 */
  const [connectionMenu, setConnectionMenu] = useState<ConnectionMenuState | null>(null);
  /** 连线标签内联输入：记录目标边、菜单定位点与初始值。 */
  const [edgeLabelEdit, setEdgeLabelEdit] = useState<{
    readonly edgeId: string;
    readonly x: number;
    readonly y: number;
    readonly value: string;
  } | null>(null);
  /** 连线样式浮层：状态与命令在独立 hook 内装配。 */
  const {
    element: edgeStyleElement,
    open: openEdgeStyleMenu,
    close: closeEdgeStyleMenu,
  } = useCanvasEdgeStyleMenu(sessionRef, readOnly);
  /** 画布 AI 背景弹窗；null=关闭。 */
  const [canvasContextEdit, setCanvasContextEdit] = useState<{ readonly value: string } | null>(null);
  /** System Prompt 预览弹窗；null=关闭。 */
  const [promptPreview, setPromptPreview] = useState<AiPromptPreview | null>(null);

  const resolveDocPath = useEmberStore((state) => state.resolveDocPath);
  const libraryRoot = useEmberStore((state) => state.identity?.root ?? null);
  // 存在性必须查知识库索引（index.docs），不能用「已打开文档」docs，否则未打开即误判死链。
  const index = useEmberStore((state) => state.index);
  const hasDoc = useMemo(
    () => (path: string): boolean => index.docs.has(path),
    [index],
  );
  const knownDirs = useTreeStore((state) => state.knownDirs);
  const pendingDirs = useTreeStore((state) => state.pendingDirs);
  const docDirs = useMemo(
    () => new Set([...knownDirs, ...pendingDirs]),
    [knownDirs, pendingDirs],
  );
  const docTree = useMemo(() => buildTree(index.docs, { dirs: docDirs }), [index, docDirs]);
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
  // 文档附件预览与媒体库共用超时/代次语义，关闭即卸载 iframe。
  useEffect(() => {
    if (docViewer.viewer === null || docViewer.loaded) return;
    const token = docViewer.token;
    const timer = window.setTimeout(() => dispatchDocViewer({ type: 'DOC_TIMEOUT', token }), 5000);
    return () => window.clearTimeout(timer);
  }, [docViewer]);

  useEffect(() => {
    if (docViewer.viewer === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      dispatchDocViewer({ type: 'CLOSE_DOC' });
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [docViewer.viewer]);

  const handleEngineEvent = useCallback(
    (event: CanvasEngineEvent, engine: CanvasEngine): void => {
      if (event.kind === 'contextMenu') {
        setEditing(null);
        setRebindNodeId(null);
        setEdgeLabelEdit(null);
        closeEdgeStyleMenu();
        // 2026-11-23：右键打开菜单时收掉可能还开着的拉线菜单，避免两层菜单叠加。
        setConnectionMenu(null);
        const hit = event.target;
        const hitNode =
          hit.kind === 'node'
            ? (engine.getNodeViews().find((view) => view.id === hit.id) ?? null)
            : null;
        const rawNode = hit.kind === 'node'
          ? engine.getDocument().nodes.find(
              (node) => node !== null && typeof node === 'object' &&
                (node as { readonly id?: unknown }).id === hit.id,
            ) as { readonly type?: unknown } | undefined
          : undefined;
        const rawEdge = hit.kind === 'edge'
          ? engine.getDocument().edges.find(
              (edge) => edge !== null && typeof edge === 'object' &&
                (edge as { readonly id?: unknown }).id === hit.id,
            ) as { readonly label?: unknown; readonly style?: unknown } | undefined
          : undefined;
        const host = hostRef.current;
        const point = clampMenuPoint(
          event.screenPoint,
          host?.clientWidth ?? event.screenPoint.x + 240,
          host?.clientHeight ?? event.screenPoint.y + 360,
        );
        setMenu({
          x: point.x,
          y: point.y,
          target: event,
          nodeDocPath: hitNode?.docPath ?? null,
          nodeLabel: hitNode?.label ?? null,
          nodeType: typeof rawNode?.type === 'string' ? rawNode.type : null,
          nodeKind: hitNode?.kind ?? null,
          edgeLabel:
            hit.kind === 'edge'
              ? (typeof rawEdge?.label === 'string' ? rawEdge.label : '')
              : null,
          edgeStyle: hit.kind === 'edge' ? readEdgeStyle(rawEdge?.style) : null,
        });
        return;
      }
      if (event.kind === 'connectionDropEmpty') {
        setMenu(null);
        setEditing(null);
        setEdgeLabelEdit(null);
        const host = hostRef.current;
        const point = clampMenuPoint(
          event.screenPoint,
          host?.clientWidth ?? event.screenPoint.x + 220,
          host?.clientHeight ?? event.screenPoint.y + 260,
          220,
          260,
        );
        setConnectionMenu({
          x: point.x,
          y: point.y,
          worldPoint: event.worldPoint,
          from: event.from,
          reverse: event.reverse,
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
              readonly kind?: unknown;
              readonly path?: unknown;
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
          const targetPath = link.kind === 'ok' ? link.effectivePath : node.docPath;
          openWindow(targetPath, EDITOR_WINDOW_CONTENT, getViewport());
          useEditorModeRequestStore.getState().requestMode(targetPath, 'edit');
          return;
        }
        // 媒体库 PDF/HTML 附件：双击复用只读查看器，不进入文本编辑。
        if (node.type === 'media' && node.kind === 'doc' && typeof node.path === 'string') {
          const viewer = docViewerFor(node.path);
          if (viewer === null) pushNotice('此文档格式暂不支持预览', 'warning');
          else dispatchDocViewer({ type: 'OPEN_DOC', path: node.path, kind: viewer.kind });
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
        if (node.type === 'ai' || node.type === 'split' || node.type === 'merge') {
          setModelPicker({ nodeId: node.id, nodeX: node.x, nodeY: node.y });
          return;
        }
        setEditing({
          ...(node.type === 'text' ? { kind: 'text' as const } : {}),
          nodeId: node.id,
          nodeX: node.x,
          nodeY: node.y,
          label: typeof node.label === 'string'
            ? node.label
            : node.type === 'text' ? '' : node.id,
        });
      }
    },
    [setEditing, closeEdgeStyleMenu],
  );

  // CR-20261121-53：AI 节点模型选择浮层；打开时按当前 AI 设置拉取模型列表。
  const [modelPicker, setModelPicker] = useState<CanvasModelPickerState | null>(null);
  const [modelChoices, setModelChoices] = useState<CanvasModelChoices>({ state: 'loading' });

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
  const {
    runningAi,
    stepProgress,
    splitConfirm,
    retryConfirm,
    runAiNode,
    cancelAiRun,
    runStepNode,
    cancelStepRun,
    confirmSplitRerun,
    cancelSplitRerun,
    confirmRetryBlock,
    cancelRetryBlock,
    retryStepBlockRef,
    runAiNodeRef,
    runStepNodeRef,
  } = useCanvasAiRuns({
    getEngine: () => sessionRef.current?.engine ?? null,
    readOnly,
    clearAiFlash,
    flashAiResult,
  });
  useEffect(() => {
    const engine = sessionRef.current?.engine;
    engine?.setAiRunning(runningAi?.nodeId ?? null);
    return () => {
      engine?.setAiRunning(null);
    };
  }, [runningAi]);
  useEffect(() => {
    sessionRef.current?.engine.setStepProgress(stepProgress);
  }, [stepProgress]);
  useEffect(() => clearAiFlash, [clearAiFlash]);

  const closeMenu = useCallback((): void => {
    setMenu(null);
    setRebindNodeId(null);
  }, []);

  const createEmptyArticleAt = useCreateEmptyArticle({
    sessionRef,
    readOnly,
    closeMenu,
    clearConnectionMenu: () => setConnectionMenu(null),
  });

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
        case 'addSplit': {
          if (worldPt !== null) commands.push(createAddSplitNodeCommand(worldPt.x, worldPt.y));
          break;
        }
        case 'addMerge': {
          if (worldPt !== null) commands.push(createAddMergeNodeCommand(worldPt.x, worldPt.y));
          break;
        }
        case 'createArticle': {
          if (tgt.kind === 'contextMenu' && 'screenPoint' in tgt) {
            void createEmptyArticleAt(tgt.screenPoint, null);
          } else {
            closeMenu();
          }
          return;
        }
        case 'editText':
        case 'editLabel': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'node') {
            closeMenu();
            return;
          }
          const editingNodeId = tgt.target.id;
          const node = engine.getDocument().nodes.find(
            (candidate) => candidate !== null && typeof candidate === 'object' &&
              (candidate as { readonly id?: unknown }).id === editingNodeId,
          ) as {
            readonly id: string;
            readonly x?: unknown;
            readonly y?: unknown;
            readonly label?: unknown;
          } | undefined;
          if (node === undefined || typeof node.x !== 'number' || typeof node.y !== 'number') {
            closeMenu();
            return;
          }
          setEditing({
            ...(action === 'editText' ? { kind: 'text' as const } : {}),
            nodeId: node.id,
            nodeX: node.x,
            nodeY: node.y,
            label: typeof node.label === 'string' ? node.label : '',
          });
          closeMenu();
          return;
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
          const runNode = engine.getDocument().nodes.find(
            (n) =>
              n !== null &&
              typeof n === 'object' &&
              (n as { readonly id?: unknown }).id === aiNodeId,
          ) as { readonly type?: unknown } | undefined;
          closeMenu();
          if (runNode?.type === 'split') void runStepNode('split', aiNodeId);
          else if (runNode?.type === 'merge') void runStepNode('merge', aiNodeId);
          else void runAiNode(aiNodeId);
          return;
        }
        case 'cancelAi': {
          cancelAiRun();
          cancelStepRun();
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
        case 'duplicateNode': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'node') {
            closeMenu();
            return;
          }
          const duplicateNodeId = tgt.target.id;
          const dupNode = engine.getDocument().nodes.find(
            (n) => n !== null && typeof n === 'object' &&
              (n as { readonly id?: unknown }).id === duplicateNodeId,
          ) as { readonly x?: unknown; readonly y?: unknown } | undefined;
          if (dupNode === undefined || typeof dupNode.x !== 'number' || typeof dupNode.y !== 'number') {
            closeMenu();
            return;
          }
          commands.push(
            ...createDuplicateNodeCommands(
              [{ id: duplicateNodeId, x: dupNode.x + 24, y: dupNode.y + 24 }],
              engine.getDocument().nodes,
            ),
          );
          break;
        }
        case 'previewPrompt': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'node') {
            closeMenu();
            return;
          }
          const document = engine.getDocument();
          const config = useAiChatStore.getState().config;
          const preview = buildAiNodePromptPreview(document, tgt.target.id, {
            global: config.systemPrompt,
            canvas: readCanvasAiContext(document),
          });
          if (preview === null) {
            pushNotice('该节点不存在或不是 AI 节点', 'error');
          } else {
            setPromptPreview(preview);
          }
          closeMenu();
          return;
        }
        case 'editCanvasContext': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'blank') {
            closeMenu();
            return;
          }
          setCanvasContextEdit({ value: readCanvasAiContext(engine.getDocument()) });
          closeMenu();
          return;
        }
        case 'editEdgeLabel': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'edge') {
            closeMenu();
            return;
          }
          setEdgeLabelEdit({
            edgeId: tgt.target.id,
            x: currentMenu.x,
            y: currentMenu.y,
            value: currentMenu.edgeLabel ?? '',
          });
          closeMenu();
          return;
        }
        case 'reverseEdge': {
          if (tgt.kind !== 'contextMenu' || tgt.target.kind !== 'edge') {
            closeMenu();
            return;
          }
          const commandsForEdge = createReverseEdgeCommands(
            engine.getDocument(),
            tgt.target.id,
          );
          if (commandsForEdge === null) {
            pushNotice('连线不存在，无法反转', 'error');
          } else if (!engine.executeCommands(commandsForEdge)) {
            pushNotice('反转连线失败，未应用更改', 'error');
          }
          closeMenu();
          return;
        }
        case 'editEdgeStyle': {
          if (tgt.kind === 'contextMenu' && tgt.target.kind === 'edge') {
            openEdgeStyleMenu(tgt.target.id, currentMenu.x, currentMenu.y);
          }
          closeMenu();
          return;
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
            open: (path) => {
              openWindow(path, EDITOR_WINDOW_CONTENT, getViewport());
              useEditorModeRequestStore.getState().requestMode(path, 'edit');
            },
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
            ...(createdEdit.prompt === true
              ? { kind: 'prompt' as const, text: '' }
              : { kind: 'text' as const }),
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
      runStepNode,
      cancelAiRun,
      cancelStepRun,
      createEmptyArticleAt,
      setEditing,
      openEdgeStyleMenu,
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

  // 右键「媒体库」→ 在点击位置插入图像/音频/视频/文档附件节点。
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

  // N4：关闭拉线菜单——只收菜单，不写文档、不入历史。草稿线在菜单弹出前已由
  // engine 的 connectionDropEmpty 清掉；此处不得再 cancelConnection：菜单开着时
  // 用户可能已从端口拉起新连线手势（pointerdown 先于本关闭到达），取消会把新手势
  // 掐死在起点——线条卡死不动、松手无响应（用户 2026-11-24 回归报告）。
  const closeConnectionMenu = useCallback((): void => {
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
          current.reverse,
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

  const {
    chooseText: chooseConnectionText,
    chooseAi: chooseConnectionAi,
    chooseSplit: chooseConnectionSplit,
    chooseMerge: chooseConnectionMerge,
    chooseDoc: chooseConnectionDoc,
  } = useConnectionNodeChoice(connectionMenu, commitConnectionNode);

  // 用户 2026-11-23：拖线落空菜单直接新建空文章（库根）并连边。
  const chooseConnectionArticle = useCallback((): void => {
    const current = connectionMenu;
    if (current === null) return;
    void createEmptyArticleAt(
      { x: current.x, y: current.y },
      current.from,
      current.worldPoint,
      current.reverse,
    );
  }, [connectionMenu, createEmptyArticleAt]);

  /** 连线标签提交：空串等价清空；与当前值相同则直接关闭。 */
  const commitEdgeLabel = useCallback(
    (label: string): void => {
      const engine = sessionRef.current?.engine;
      const current = edgeLabelEdit;
      setEdgeLabelEdit(null);
      if (engine === undefined || current === null) return;
      if (label.trim() === current.value.trim()) return;
      const commands = createSetEdgeLabelCommands(engine.getDocument(), current.edgeId, label);
      if (commands === null) {
        pushNotice('连线不存在，标签未保存', 'error');
        return;
      }
      if (!engine.executeCommands(commands)) {
        pushNotice('连线标签保存失败，未应用更改', 'error');
      }
    },
    [edgeLabelEdit],
  );

  /** 画布 AI 背景保存：空串等价删除，统一走 updateCanvasMeta 命令与历史。 */
  const saveCanvasContext = useCallback((value: string): void => {
    const engine = sessionRef.current?.engine;
    setCanvasContextEdit(null);
    if (engine === undefined) return;
    if (!engine.executeCommands([createUpdateCanvasAiContextCommand(value)])) {
      pushNotice('画布 AI 背景保存失败，未应用更改', 'error');
    }
  }, []);

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
  // 2026-11-23：外部关闭改听 pointerdown——菜单在 pointerup 里弹出，若听 click，
  // 短距拖线松手时浏览器仍会派发同轮合成 click（host 的 pointer capture 把按下/
  // 抬起目标归一到画布），菜单刚挂载即被关掉，表现为「菜单一闪而过/不出现」；
  // pointerdown 属下一轮交互，无此竞态。命中任意菜单（含 portal 出去的文档
  // 子菜单 ul[role=menu]）不关闭，交给菜单自身 onClick 处理。
  useEffect(() => {
    if (connectionMenu === null) return;
    const onDocPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest('ul[role="menu"]') !== null) return;
      closeConnectionMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeConnectionMenu();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
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

      const docSource = {
        readLiveText: (path: string) => useEmberStore.getState().docs.get(path)?.text ?? null,
        readSnapshot: (path: string) => useEmberStore.getState().readDocSnapshot(path),
      };
      const engine = new CanvasEngine({
        host,
        store,
        canvasId: targetId,
        registry,
        initialOpen: opened,
        // CR-20261119-05：已打开编辑器的 live text 优先，否则 vault_read 只读快照。
        docSource,
        // CR-20261121-56：卡片出链/反链（wiki 语义；索引未就绪返回 null，整行隐藏）。
        // CR-20261121-59：提示词右下角「开始」钮 → 找所连 AI 节点执行（未连接给出指引）。
        // 经 ref 调用（runAiNode 声明在本回调之后，避免 TDZ）。
        onRunPrompt: (promptId) => {
          const sessionNow = sessionRef.current;
          if (sessionNow === null) return;
          const raw = sessionNow.engine.getDocument();
          const aiNodeId = findPromptAiNode(raw.nodes, raw.edges, promptId);
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
        onUpdateAiText: (id, text) => {
          const sessionNow = sessionRef.current;
          if (sessionNow === null || sessionNow.engine.isReadOnly()) {
            pushNotice('画布只读，无法编辑提示词', 'warning');
            return false;
          }
          const ok = sessionNow.engine.executeCommands([createUpdateAiTextCommand(id, text)]);
          if (!ok) pushNotice('提示词保存失败，请查看画布通知', 'error');
          return ok;
        },
        onRunAi: (id) => { void runAiNodeRef.current(id); },
        onRunSplit: (id) => { void runStepNodeRef.current('split', id); }, onRunMerge: (id) => { void runStepNodeRef.current('merge', id); },
        onCancelRun: (kind) => { if (kind === 'ai') cancelAiRun(); else cancelStepRun(); },
        onRetryBlock: (id) => { void retryStepBlockRef.current(id); },
        onUpdateSplitConfig: (id, patch) => {
          const sessionNow = sessionRef.current;
          if (sessionNow === null || sessionNow.engine.isReadOnly()) {
            pushNotice('画布只读，无法修改分块设置', 'warning');
            return;
          }
          if (!sessionNow.engine.executeCommands([createUpdateSplitConfigCommand(id, patch)])) {
            pushNotice('分块设置保存失败，请查看画布通知', 'error');
          }
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
      // 内容驱动背景：恰好选中一个图片节点时，用其媒体图做 L2；其余情况回落到 L1。
      const stopAmbientWatch = watchAmbientSource(engine, setAmbientSource);
      const stopSplitPreviews = startSplitPreviewProjection(engine, docSource);
      session.unsubscribe = () => {
        offNotices();
        offEvents();
        stopAmbientWatch();
        stopSplitPreviews();
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
    [store, registry, handleEngineEvent, onOpenReadMode, setEditing, runAiNodeRef, runStepNodeRef, retryStepBlockRef, cancelAiRun, cancelStepRun],
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
      if (!active || canvasId === null) {
        setAmbientSource(null);
        return;
      }
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
      addNodeCentered: (kind: 'text' | 'ai' | 'document', docPath?: string): boolean => {
        const session = sessionRef.current;
        const host = hostRef.current;
        if (session === null || host === null || (kind === 'document' && docPath === undefined)) return false;
        if (readOnly || session.engine.isReadOnly()) {
          pushNotice('画布只读，无法新建节点', 'warning');
          return false;
        }
        const rect = host.getBoundingClientRect();
        const world = session.engine.screenToWorld({
          x: rect.width / 2,
          y: rect.height / 2,
        });
        const command = kind === 'document'
          ? createAddDocumentNodeCommand(world.x, world.y, docPath ?? '')
          : kind === 'text' ? createAddTextNodeCommand(world.x, world.y) : createAddAiNodeCommand(world.x, world.y);
        if (!session.engine.executeCommands([command])) {
          pushNotice('画布操作失败，未应用更改', 'error');
          return false;
        }
        if (command.kind === 'addNode' && kind === 'text') {
          setEditing({ nodeId: command.node.id, nodeX: world.x, nodeY: world.y, label: '' });
        }
        return true;
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
    [deactivateSession, handleFinderDrop, readOnly, setEditing],
  );

  const pickerField =
    modelPicker !== null && hostRef.current !== null
      ? modelFieldRect(hostRef.current, modelPicker.nodeId)
      : null;
  const pickerLayout =
    pickerField !== null && hostRef.current !== null
      ? modelMenuLayout(pickerField, hostRef.current.clientWidth, hostRef.current.clientHeight)
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
      <CanvasAmbience source={ambientSource} />
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
          onClose={closeMenu}
        />
      ) : null}
      {/* N4：拉线落空 → 新建节点并连边 */}
      {connectionMenu !== null ? (
        <CanvasConnectionMenu
          menu={connectionMenu}
          onChooseText={chooseConnectionText}
          onChooseAi={chooseConnectionAi}
          onChooseSplit={chooseConnectionSplit}
          onChooseMerge={chooseConnectionMerge}
          onChooseArticle={chooseConnectionArticle}
          docTree={docTree}
          onPickDoc={chooseConnectionDoc}
          readOnly={readOnly}
          onMenuEnter={cancelMenuClose}
          onMenuLeave={scheduleMenuClose}
          onClose={closeConnectionMenu}
        />
      ) : null}
      {/* 画布级 AI 背景 */}
      {canvasContextEdit !== null ? (
        <CanvasAiContextDialog
          value={canvasContextEdit.value}
          readOnly={readOnly}
          onSave={saveCanvasContext}
          onCancel={() => setCanvasContextEdit(null)}
        />
      ) : null}
      {/* AI 节点 System Prompt 预览 */}
      {promptPreview !== null ? (
        <CanvasPromptPreviewDialog
          preview={promptPreview}
          onClose={() => setPromptPreview(null)}
        />
      ) : null}
      {/* 连线状态/标签内联输入 */}
      {edgeLabelEdit !== null ? (
        <CanvasEdgeLabelInput
          key={edgeLabelEdit.edgeId}
          left={edgeLabelEdit.x}
          top={edgeLabelEdit.y}
          defaultValue={edgeLabelEdit.value}
          onCommit={commitEdgeLabel}
          onCancel={() => setEdgeLabelEdit(null)}
        />
      ) : null}
      {/* 连线样式浮层 */}
      {edgeStyleElement}
      {/* C0-D：文本编辑覆盖层；提示词改为独立可缩放浮窗 */}
      {editing !== null && sessionRef.current !== null ? (
        editing.kind === 'prompt' ? (
          <PromptEditorWindow
            key={editing.nodeId}
            initialText={editing.text ?? ''}
            onClose={commitPromptEdit}
          />
        ) : (
          <CanvasEditOverlay
            key={`${editing.nodeId}:${editing.kind ?? 'label'}`}
            editing={editing}
            rect={editOverlayRect(editing.nodeId, editing.nodeX, editing.nodeY, sessionRef.current.engine)}
            onCommitLabel={commitEdit}
            onCommitText={commitTextEdit}
            onCommitPrompt={commitPromptEdit}
            onCancel={cancelEdit}
          />
        )
      ) : null}
      {/* 2026-11-23：AI 节点模型原位下拉（锚定模型框，不再铺满节点） */}
      {modelPicker !== null && pickerLayout !== null ? (
        <CanvasModelMenu
          left={pickerLayout.left}
          top={pickerLayout.top}
          width={pickerLayout.width}
          maxHeight={pickerLayout.maxHeight}
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
      {docViewer.viewer !== null ? (
        <DocViewerOverlay
          viewer={docViewer.viewer}
          token={docViewer.token}
          failed={docViewer.failed}
          onLoaded={() => dispatchDocViewer({ type: 'DOC_LOADED', token: docViewer.token })}
          onTimeout={() => dispatchDocViewer({ type: 'DOC_TIMEOUT', token: docViewer.token })}
          onClose={() => dispatchDocViewer({ type: 'CLOSE_DOC' })}
        />
      ) : null}
      {splitConfirm !== null ? (
        <SplitRerunConfirmDialog
          message={splitConfirm.message}
          onCancel={cancelSplitRerun}
          onConfirm={() => { void confirmSplitRerun(); }}
        />
      ) : null}
      {retryConfirm !== null ? (
        <SplitRerunConfirmDialog
          title="确认重试"
          confirmLabel="继续重试"
          message={retryConfirm.message}
          onCancel={cancelRetryBlock}
          onConfirm={() => { void confirmRetryBlock(); }}
        />
      ) : null}
    </div>
  );
});
