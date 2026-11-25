/**
 * zustand 桥：把 core 的快照 / 索引 / 文档订阅折叠成 React 可用的单一 store。
 *
 * - core 在工厂函数内部闭包内装配（绕开 gate:mutable-exports 对顶层 let 的拦截）；
 * - store 只保存不可变快照，动作全部薄委托给 core；
 * - React 组件只通过 selector 订阅需要的切片，不接触 invoke / Tauri；
 * - T13 CR-B：core/canvasRegistry 可 dispose + rebuild，支持多库安全切换。
 */
import { create } from 'zustand';
import {
  createEmberCore,
  type CoreStatus,
  type EmberCore,
} from '../../core/core';
import type {
  CanvasFlushReport,
  CanvasOpenResult,
  CanvasSaveOptions,
  CanvasSaveSuccess,
} from '../../core/canvas/ports';
import type { ConflictChoice, DocState, SaveOutcome } from '../../core/doc-store';
import type { CreateDocResult, WriteDocTextResult } from '../../core/core';
import type { EmberIpcError } from '../../core/errors';
import type { CoreEvent, EventBus } from '../../core/events';
import { createSystemClock, type Unsubscribe } from '../../core/ports';
import type { VaultIndexSnapshot } from '../../core/vault-index';
import { buildLinkIndex, type LinkIndex } from '../../core/link-index';
import type { CanvasEntryDto, VaultConstantsDto, VaultIdentityDto } from '../../types/ipc';
import { canvasPort, docApi } from '../../data/app-api.ts';
import { createTauriEventPort } from '../../data/event-port';
import { createTauriVaultPort } from '../../data/vault-port';
import { createCanvasEngineRegistry, type CanvasEngineRegistry } from '../canvas/registry';
import { readDocSnapshot } from '../doc-text.ts';
import { pushNotice } from './notice-store';

/** core 一次性事件桥：仅错误进入常驻通知，ready/disposed 不产生 UI 噪声。
 * 纯函数，独立于 factory；测试与 factory 内部共同复用。 */
export function bridgeCoreEvents(
  events: Pick<EventBus<CoreEvent>, 'subscribe'>,
  push: (message: string, tone: 'error') => void,
): Unsubscribe {
  return events.subscribe((event) => {
    switch (event.type) {
      case 'core:error':
        push(`[core:error] ${event.error.code}: ${event.error.message}`, 'error');
        break;
      case 'core:ready':
      case 'core:disposed':
        break;
    }
  });
}

/**
 * 核心工厂：core / canvasRegistry 的创建、dispose、rebuild 全部在此闭包内。
 *
 * gate:mutable-exports 拦截所有顶层 let/var，所以 core/canvasRegistry 的可变引用
 * 必须藏在这个函数内部闭包。模块顶层只有 const coreFactory —— 不可变对象。
 */
function createCoreFactory() {
  let core: EmberCore = createEmberCore({
    vault: createTauriVaultPort(),
    events: createTauriEventPort(),
    clock: createSystemClock(),
    canvas: canvasPort,
  });

  let canvasRegistry: CanvasEngineRegistry = createCanvasEngineRegistry();

  let bridgeOff: Unsubscribe | null = null;
  const subscribeOffs: Unsubscribe[] = [];

  function subscribeAll(): void {
    subscribeOffs.push(
      core.subscribe((snapshot) => {
        useEmberStore.setState({
          status: snapshot.status,
          identity: snapshot.identity,
          constants: snapshot.constants,
          lastError: snapshot.lastError,
        });
      }),
    );
    let lastVaultIndex: VaultIndexSnapshot | null = null;
    subscribeOffs.push(
      core.subscribeIndex((index) => {
        // CR-20261121-56：库索引变化（扫描/外部变更/切库）→ 链接索引失效，下次挂载画布重建。
        const changed = lastVaultIndex !== null && index !== lastVaultIndex;
        lastVaultIndex = index;
        useEmberStore.setState(
          changed ? { index, linkIndex: null, linkIndexStatus: 'idle' } : { index },
        );
      }),
    );
    subscribeOffs.push(
      core.subscribeDocuments((docs) => {
        useEmberStore.setState({ docs });
      }),
    );
  }

  function disposeSubscriptions(): void {
    subscribeOffs.forEach((off) => off());
    subscribeOffs.length = 0;
    if (bridgeOff !== null) {
      bridgeOff();
      bridgeOff = null;
    }
  }

  // 初始化：挂桥 + 三个切片订阅（复用外部 export 的 bridgeCoreEvents）
  bridgeOff = bridgeCoreEvents(core.events, pushNotice);
  subscribeAll();

  return Object.freeze({
    /** 获取当前 core 实例（每次调用取最新）。 */
    getCore(): EmberCore {
      return core;
    },
    /** 获取当前 canvasRegistry（每次调用取最新）。 */
    getRegistry(): CanvasEngineRegistry {
      return canvasRegistry;
    },
    /** dispose 旧 core：退订事件 + 调 core.dispose() + 重建空 registry。包 Promise 供 effects 消费。 */
    disposeCore(): Promise<void> {
      disposeSubscriptions();
      core.dispose();
      canvasRegistry = createCanvasEngineRegistry();
      useEmberStore.setState({ canvasRegistry });
      return Promise.resolve();
    },
    /** rebuild 新 core：dispose 旧的 → 创建新的 → 重新桥 + 订阅 → 同步初始快照 → start()。 */
    async rebuildCore(): Promise<void> {
      disposeSubscriptions();
      core.dispose();

      core = createEmberCore({
        vault: createTauriVaultPort(),
        events: createTauriEventPort(),
        clock: createSystemClock(),
        canvas: canvasPort,
      });
      canvasRegistry = createCanvasEngineRegistry();

      bridgeOff = bridgeCoreEvents(core.events, pushNotice);
      subscribeAll();

      const snap = core.getSnapshot();
      useEmberStore.setState({
        status: snap.status,
        identity: snap.identity,
        constants: snap.constants,
        lastError: snap.lastError,
        index: core.getIndex(),
        docs: core.getDocuments(),
        canvasRegistry,
      });

      await core.start();
    },
  });
}

/** 不可变工厂实例。可变引用在工厂内部闭包。 */
const coreFactory = Object.freeze(createCoreFactory());

/** 链接索引读取器：单篇磁盘正文（不是未保存的 live text）。默认走 vault_read。 */
export interface LinkIndexReader {
  (path: string): Promise<{ readonly sha256: string; readonly text: string }>;
}

const readVaultDocument: LinkIndexReader = async (path) => {
  const dto = await docApi.read(path);
  return { sha256: dto.sha256, text: dto.text };
};

export interface EmberAppState {
  readonly status: CoreStatus;
  readonly identity: VaultIdentityDto | null;
  readonly constants: VaultConstantsDto | null;
  readonly lastError: EmberIpcError | null;
  readonly index: VaultIndexSnapshot;
  readonly docs: ReadonlyMap<string, DocState>;
  /** CR-20261121-56：全库 wiki 链接索引（惰性后台构建；卡片出链/反链数据源）。 */
  readonly linkIndex: LinkIndex | null;
  readonly linkIndexStatus: 'idle' | 'building' | 'ready' | 'error';
  /** 幂等触发后台构建：已有索引/构建中/空库直接返回；索引随库变更事件失效。 */
  readonly ensureLinkIndex: (reader?: LinkIndexReader) => void;
  readonly resolveDocPath: (from: string) => string | null;
  readonly start: () => Promise<void>;
  readonly openDoc: (path: string) => Promise<DocState>;
  readonly closeDoc: (path: string) => void;
  readonly editDoc: (path: string, text: string) => void;
  readonly saveDoc: (path: string) => Promise<SaveOutcome>;
  readonly resolveDocConflict: (path: string, choice: ConflictChoice) => Promise<DocState>;
  readonly flushDocs: () => Promise<void>;
  readonly reconcilePaths: (paths: readonly string[]) => Promise<void>;
  /** CR-20261119-08：create-only 新建 `.md`；只返回判别结果，不抛错。 */
  readonly createDoc: (rel: string) => Promise<CreateDocResult>;
  /** CR-R3-1b：带外写盘；已打开 dirty/saving 文档拒写为 dirty，不触盘。 */
  readonly writeDocText: (
    path: string,
    text: string,
    expectedSha: string,
  ) => Promise<WriteDocTextResult>;
  /** CR-20261119-05：文档节点预览的只读快照（vault_read 一次性读取，不改文档状态）。 */
  readonly readDocSnapshot: (path: string) => Promise<string>;
  readonly canvasRegistry: CanvasEngineRegistry;
  readonly listCanvases: () => Promise<CanvasEntryDto[]>;
  readonly openCanvas: (id: string) => Promise<CanvasOpenResult>;
  readonly saveCanvas: (
    id: string,
    text: string,
    options?: CanvasSaveOptions,
  ) => Promise<CanvasSaveSuccess>;
  readonly flushCanvases: (options?: {
    readonly timeoutMs?: number;
  }) => Promise<CanvasFlushReport>;
  readonly beginCanvasClosing: () => void;
  readonly cancelCanvasClosing: () => void;
  /** T13 CR-B：dispose 旧 core（退订 + dispose + 重建空 registry）。同步操作，包一层 Promise 供 effects 消费。 */
  readonly disposeCore: () => Promise<void>;
  /** T13 CR-B：dispose 旧 + 创建新 core + 重新桥/订阅 + start()。 */
  readonly rebuildCore: () => Promise<void>;
}

const initialSnap = coreFactory.getCore().getSnapshot();
const initialRegistry = coreFactory.getRegistry();

export const useEmberStore = create<EmberAppState>()(() => ({
  status: initialSnap.status,
  identity: initialSnap.identity,
  constants: initialSnap.constants,
  lastError: initialSnap.lastError,
  index: coreFactory.getCore().getIndex(),
  docs: coreFactory.getCore().getDocuments(),
  linkIndex: null,
  linkIndexStatus: 'idle',
  ensureLinkIndex: (reader = readVaultDocument) => {
    const state = useEmberStore.getState();
    if (state.linkIndexStatus === 'building' || state.linkIndexStatus === 'ready') return;
    if (state.index.docs.size === 0) return;
    useEmberStore.setState({ linkIndexStatus: 'building' });
    void (async () => {
      try {
        const paths = [...useEmberStore.getState().index.docs.values()].map(
          (entry) => entry.path,
        );
        const sources = await Promise.all(
          paths.map(async (relativePath) => {
            const dto = await reader(relativePath);
            return { path: relativePath, sha256: dto.sha256, text: dto.text };
          }),
        );
        useEmberStore.setState({ linkIndex: buildLinkIndex(sources), linkIndexStatus: 'ready' });
      } catch {
        useEmberStore.setState({ linkIndex: null, linkIndexStatus: 'error' });
      }
    })();
  },
  resolveDocPath: (from) => coreFactory.getCore().resolveDocPath(from),
  start: () => coreFactory.getCore().start(),
  openDoc: (path) => coreFactory.getCore().openDoc(path),
  closeDoc: (path) => coreFactory.getCore().closeDoc(path),
  editDoc: (path, text) => coreFactory.getCore().editDoc(path, text),
  saveDoc: (path) => coreFactory.getCore().saveDoc(path),
  resolveDocConflict: (path, choice) => coreFactory.getCore().resolveDocConflict(path, choice),
  flushDocs: () => coreFactory.getCore().flushDocs(),
  reconcilePaths: (paths) => coreFactory.getCore().reconcilePaths(paths),
  createDoc: (rel) => coreFactory.getCore().createDoc(rel),
  writeDocText: (path, text, expectedSha) =>
    coreFactory.getCore().writeDocText(path, text, expectedSha),
  readDocSnapshot: (path) =>
    readDocSnapshot(path, {
      liveText: () => null,
      readDisk: async (target) => {
        const doc = await docApi.read(target);
        return doc.text;
      },
    }),
  canvasRegistry: initialRegistry,
  listCanvases: () => coreFactory.getCore().canvas.list(),
  openCanvas: (id) => coreFactory.getCore().canvas.open(id),
  saveCanvas: (id, text, options) => coreFactory.getCore().canvas.save(id, text, options),
  flushCanvases: (options) => coreFactory.getCore().canvas.flush(options),
  beginCanvasClosing: () => coreFactory.getCore().canvas.beginClosing(),
  cancelCanvasClosing: () => coreFactory.getCore().canvas.cancelClosing(),
  disposeCore: () => coreFactory.disposeCore(),
  rebuildCore: () => coreFactory.rebuildCore(),
}));
