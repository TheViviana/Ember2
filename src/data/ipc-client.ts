/**
 * 统一 IPC 客户端：所有 `invoke` 调用的唯一入口（gate:layers 规定 @tauri-apps 只出现在 src/data/）。
 *
 * 职责：
 * 1. 命令名与请求 / 响应类型严格绑定到 `IpcCommandMap`，拼错命令或漏传参数在编译期报错；
 * 2. 把 Rust 返回的 `ErrorPayload { code, message }` 统一转成 `EmberIpcError`；
 *    非命令级拒绝（Tauri 返回纯字符串等）折成 `code: 'E_UNKNOWN'`，绝不静默吞错；
 * 3. 收口 `ai_chat_stream` 的 `Channel<AiChatEvent>`，上层（core / features）不需要接触 Tauri。
 *
 * 契约唯一真理源：docs/contract.md §II / §III。
 */
import { Channel, invoke } from '@tauri-apps/api/core';
import { toIpcError, type EmberIpcError } from '../core/errors.ts';
import type {
  AiChatCancelRequest,
  AiChatCancelDto,
  AiChatDeltaEvent,
  AiChatDoneEvent,
  AiChatErrorEvent,
  AiChatEvent,
  AiChatRequest,
  AiEndpointRequest,
  AiKeySaveDto,
  AiKeySaveRequest,
  AiKeyStatusDto,
  AiModelsDto,
  AiTestConnectionDto,
  BackupDestinationDto,
  BackupDestinationRequest,
  BackupExportRequest,
  BackupInspectDto,
  BackupInspectRequest,
  BackupReportDto,
  CanvasEntryDto,
  CanvasReadRequest,
  CanvasWriteRequest,
  DirEntryDto,
  HistoryDeleteDto,
  HistoryDeleteRequest,
  HistoryListRequest,
  HistoryPurgeDto,
  HistoryPurgeRequest,
  HistoryReadDto,
  HistoryReadRequest,
  HistoryRestoreRequest,
  HistoryVersionDto,
  ImportDocDto,
  LibraryAddRequest,
  LibraryCurrentDto,
  LibraryCurrentRequest,
  LibraryDto,
  LibraryRemoveRequest,
  MediaDeleteRequest,
  MediaEntryDto,
  MediaSaveDto,
  MediaSaveRequest,
  ReadCanvasDto,
  ReadDocDto,
  ReplaceDocDto,
  ScanDocDto,
  StatDto,
  TrashCleanupDto,
  TrashCleanupRequest,
  TrashListDto,
  TrashResultDto,
  TranslateEvent,
  VaultConstantsDto,
  VaultIdentityDto,
  VaultImportRequest,
  VaultListRequest,
  VaultReadRequest,
  VaultMkdirRequest,
  VaultRemoveRequest,
  VaultRenameRequest,
  VaultReplaceRequest,
  VaultStatRequest,
  VaultWriteRequest,
  WindowResizeFrameRequest,
  WriteCanvasDto,
  WriteDocDto,
} from '../types/ipc';

// ------------------------------------------------------------- 命令类型映射

/** `ai_chat_stream` 的 invoke 参数：`onEvent` 由 chatStream() 内部创建。 */
export interface AiChatStreamInvokeArgs {
  request: AiChatRequest;
  onEvent: Channel<AiChatEvent>;
}

/** `translate_online` 的 invoke 参数：`onEvent` 由 translateOnline() 内部创建。 */
export interface TranslateOnlineInvokeArgs {
  text: string;
  targetLang: string;
  onEvent: Channel<TranslateEvent>;
}

/**
 * 契约 §III 全部命令的请求 / 响应映射。
 * `args: undefined` 表示无参命令；`result: null` 表示 Rust 返回 `()`。
 * 注：`window_resize_frame` 的失败是字符串而非 ErrorPayload，由 toIpcError 兜底为 E_UNKNOWN。
 */
export interface IpcCommandMap {
  window_resize_frame: { args: WindowResizeFrameRequest; result: null };

  vault_identity: { args: undefined; result: VaultIdentityDto };
  vault_constants: { args: undefined; result: VaultConstantsDto };
  vault_read: { args: VaultReadRequest; result: ReadDocDto };
  vault_write: { args: VaultWriteRequest; result: WriteDocDto };
  vault_replace: { args: VaultReplaceRequest; result: ReplaceDocDto };
  vault_import: { args: VaultImportRequest; result: ImportDocDto };
  vault_rename: { args: VaultRenameRequest; result: WriteDocDto };
  vault_list: { args: VaultListRequest; result: DirEntryDto[] };
  vault_scan: { args: undefined; result: ScanDocDto[] };
  vault_stat: { args: VaultStatRequest; result: StatDto };
  list_canvases: { args: undefined; result: CanvasEntryDto[] };
  canvas_read: { args: CanvasReadRequest; result: ReadCanvasDto };
  canvas_write: { args: CanvasWriteRequest; result: WriteCanvasDto };
  canvas_rename: { args: { id: string; newId: string }; result: ReadCanvasDto };

  media_save: { args: MediaSaveRequest; result: MediaSaveDto };
  media_list: { args: undefined; result: MediaEntryDto[] };
  media_delete: { args: MediaDeleteRequest; result: TrashResultDto };

  vault_remove: { args: VaultRemoveRequest; result: TrashResultDto };
  vault_mkdir: { args: VaultMkdirRequest; result: null };
  trash_list: { args: undefined; result: TrashListDto };
  trash_cleanup: { args: TrashCleanupRequest; result: TrashCleanupDto };

  backup_destination: { args: BackupDestinationRequest; result: BackupDestinationDto };
  backup_export: { args: BackupExportRequest; result: BackupReportDto };
  backup_inspect: { args: BackupInspectRequest; result: BackupInspectDto };

  history_list: { args: HistoryListRequest; result: HistoryVersionDto[] };
  history_read: { args: HistoryReadRequest; result: HistoryReadDto };
  history_restore: { args: HistoryRestoreRequest; result: WriteDocDto };
  history_delete: { args: HistoryDeleteRequest; result: HistoryDeleteDto };
  history_purge: { args: HistoryPurgeRequest; result: HistoryPurgeDto };

  ai_key_save: { args: AiKeySaveRequest; result: AiKeySaveDto };
  ai_key_status: { args: AiEndpointRequest; result: AiKeyStatusDto };
  ai_key_delete: { args: AiEndpointRequest; result: null };
  ai_test_connection: { args: AiEndpointRequest; result: AiTestConnectionDto };
  ai_list_models: { args: AiEndpointRequest; result: AiModelsDto };
  ai_chat_stream: { args: AiChatStreamInvokeArgs; result: null };
  ai_chat_cancel: { args: AiChatCancelRequest; result: AiChatCancelDto };
  translate_online: { args: TranslateOnlineInvokeArgs; result: string };

  library_list: { args: undefined; result: LibraryDto[] };
  library_add: { args: LibraryAddRequest; result: LibraryDto };
  library_remove: { args: LibraryRemoveRequest; result: LibraryDto[] };
  library_current: { args: LibraryCurrentRequest; result: LibraryCurrentDto };
}

export type IpcCommandName = keyof IpcCommandMap;

/** 无参命令展开成空参数表，保证 `client.invoke('vault_scan')` 不许多写。 */
type InvokeArgs<K extends IpcCommandName> = IpcCommandMap[K]['args'] extends undefined
  ? []
  : [args: IpcCommandMap[K]['args']];

// ------------------------------------------------------------------ 错误类

// 错误归一化归 core（core 不得反向依赖 data）；此处 re-export 保持既有导入路径可用。
export { EmberIpcError, isIpcErrorCode, toIpcError } from '../core/errors.ts';

// ---------------------------------------------------------------- 传输层

/** invoke 的最小抽象，便于内核测试注入假实现（不改变生产路径）。 */
export interface IpcTransport {
  invoke<T>(command: string, args?: unknown): Promise<T>;
}

const tauriTransport: IpcTransport = {
  invoke<T>(command: string, args?: unknown): Promise<T> {
    return invoke<T>(command, args as Record<string, unknown> | undefined);
  },
};

// ------------------------------------------------------------------ 客户端

export interface ChatStreamHandlers {
  onDelta: (event: AiChatDeltaEvent) => void;
  onDone: (event: AiChatDoneEvent) => void;
  /** code 与流内 error 事件一致（如 E_AI_CANCELLED）；event 保留 requestId 等原始负载。 */
  onError: (error: EmberIpcError, event: AiChatErrorEvent) => void;
}

export interface IpcClient {
  invoke<K extends IpcCommandName>(
    command: K,
    ...args: InvokeArgs<K>
  ): Promise<IpcCommandMap[K]['result']>;

  /**
   * 流式对话：首个 delta 前的失败以 Promise reject（EmberIpcError）；
   * 首个 delta 后的失败走 handlers.onError，Promise 正常 resolve。
   */
  chatStream(request: AiChatRequest, handlers: ChatStreamHandlers): Promise<void>;

  /**
   * 联网翻译（CR-20261120-40 / CR-20261121-41）：事件经 onEvent 回调
   * （progress 报进度、segment 逐段推送，best-effort，通道断开即停发）；
   * 译文以 Promise resolve（权威完整结果），失败以 EmberIpcError reject（code 为 E_TRANSLATE_*）。
   */
  translateOnline(
    args: { text: string; targetLang: string },
    onEvent: (event: TranslateEvent) => void,
  ): Promise<string>;
}

export function createIpcClient(transport: IpcTransport = tauriTransport): IpcClient {
  async function invokeCommand<K extends IpcCommandName>(
    command: K,
    ...args: InvokeArgs<K>
  ): Promise<IpcCommandMap[K]['result']> {
    try {
      return await transport.invoke<IpcCommandMap[K]['result']>(command, args[0]);
    } catch (rejection) {
      throw toIpcError(command, rejection);
    }
  }

  async function chatStream(
    request: AiChatRequest,
    handlers: ChatStreamHandlers,
  ): Promise<void> {
    const onEvent = new Channel<AiChatEvent>();
    onEvent.onmessage = (event) => {
      switch (event.type) {
        case 'delta':
          handlers.onDelta(event);
          break;
        case 'done':
          handlers.onDone(event);
          break;
        case 'error':
          handlers.onError(toIpcError('ai_chat_stream', event), event);
          break;
      }
    };
    try {
      await transport.invoke<void>('ai_chat_stream', { request, onEvent });
    } catch (rejection) {
      throw toIpcError('ai_chat_stream', rejection);
    }
  }

  async function translateOnline(
    args: { text: string; targetLang: string },
    onEvent: (event: TranslateEvent) => void,
  ): Promise<string> {
    const onEventChannel = new Channel<TranslateEvent>();
    onEventChannel.onmessage = (event) => onEvent(event);
    try {
      return await transport.invoke<string>('translate_online', {
        text: args.text,
        targetLang: args.targetLang,
        onEvent: onEventChannel,
      });
    } catch (rejection) {
      throw toIpcError('translate_online', rejection);
    }
  }

  return { invoke: invokeCommand, chatStream, translateOnline };
}

/** 应用默认实例；内核层可注入 createIpcClient(fakeTransport) 做测试。 */
export const ipcClient: IpcClient = createIpcClient();
