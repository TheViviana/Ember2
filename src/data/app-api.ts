/**
 * UI 层面向的 IPC 封装（R3-2 / R3-3 / R3-4）：把 src/app/** 直接调用的 ipcClient.* 收口到 data 层，
 * src/app 不再直接 import ipcClient（gate:ipc-chokepoint 白名单随之收缩到 0）。
 *
 * 只在本文件碰 ipcClient；参数 / 返回类型取自 src/types/ipc；错误传播（reject → EmberIpcError）
 * 与流式 handlers 形状由 ipc-client 统一保证，调用侧行为不变。AI 的 rawCode 重抛仍由调用侧
 * （AppShell）读取 EmberIpcError.rawCode 完成，本层只透传错误，不做二次包装。
 */
import { ipcClient, type ChatStreamHandlers } from './ipc-client.ts';
import { createTauriCanvasPort } from './canvas-port.ts';
import type { CanvasPort } from '../core/canvas/ports';
import type {
  AiChatCancelDto,
  AiChatCancelRequest,
  AiChatRequest,
  AiEndpointRequest,
  AiKeySaveDto,
  AiKeySaveRequest,
  AiKeyStatusDto,
  AiModelsDto,
  AiTestConnectionDto,
  BackupDestinationDto,
  BackupInspectDto,
  BackupReportDto,
  DirEntryDto,
  HistoryDeleteDto,
  HistoryPurgeDto,
  HistoryReadDto,
  HistoryRestoreRequest,
  HistoryVersionDto,
  ImportDocDto,
  LibraryAddRequest,
  LibraryCurrentDto,
  LibraryCurrentRequest,
  LibraryDto,
  LibraryRemoveRequest,
  MediaEntryDto,
  MediaSaveDto,
  ReadCanvasDto,
  ReadDocDto,
  ReplaceDocDto,
  ScanDocDto,
  StatDto,
  TrashCleanupDto,
  TrashListDto,
  TrashResultDto,
  TranslateEvent,
  VaultImportRequest,
  VaultReplaceItem,
  WriteDocDto,
} from '../types/ipc';

/** 文档读 / 元信息。 */
export const docApi = Object.freeze({
  read(path: string): Promise<ReadDocDto> {
    return ipcClient.invoke('vault_read', { path });
  },
  stat(path: string): Promise<StatDto> {
    return ipcClient.invoke('vault_stat', { path });
  },
});

/** 库目录结构写：建目录 / 移入回收站 / 改名 / 导入外部文件 / 全库扫描 / 批量替换。 */
export const vaultApi = Object.freeze({
  list(path?: string): Promise<DirEntryDto[]> {
    return ipcClient.invoke('vault_list', path === undefined ? {} : { path });
  },
  reveal(path: string): Promise<null> {
    return ipcClient.invoke('vault_reveal', { path });
  },
  mkdir(path: string): Promise<null> {
    return ipcClient.invoke('vault_mkdir', { path });
  },
  remove(path: string): Promise<TrashResultDto> {
    return ipcClient.invoke('vault_remove', { path });
  },
  rename(from: string, to: string): Promise<WriteDocDto> {
    return ipcClient.invoke('vault_rename', { from, to });
  },
  import(
    sourcePath: string,
    targetDir: string,
    conflict: VaultImportRequest['conflict'],
  ): Promise<ImportDocDto> {
    return ipcClient.invoke('vault_import', { sourcePath, targetDir, conflict });
  },
  scan(): Promise<ScanDocDto[]> {
    return ipcClient.invoke('vault_scan');
  },
  replace(items: readonly VaultReplaceItem[]): Promise<ReplaceDocDto> {
    return ipcClient.invoke('vault_replace', { items: [...items] });
  },
});

/** 画布改名。 */
export const canvasApi = Object.freeze({
  rename(id: string, newId: string): Promise<ReadCanvasDto> {
    return ipcClient.invoke('canvas_rename', { id, newId });
  },
});

/** 库列表 / 切换当前库 / 添加 / 移除。 */
export const libraryApi = Object.freeze({
  list(): Promise<LibraryDto[]> {
    return ipcClient.invoke('library_list');
  },
  current(request: LibraryCurrentRequest): Promise<LibraryCurrentDto> {
    return ipcClient.invoke('library_current', request);
  },
  add(request: LibraryAddRequest): Promise<LibraryDto> {
    return ipcClient.invoke('library_add', request);
  },
  remove(request: LibraryRemoveRequest): Promise<LibraryDto[]> {
    return ipcClient.invoke('library_remove', request);
  },
});

/** 媒体入库 / 列举 / 删除。 */
export const mediaApi = Object.freeze({
  save(sourcePath: string): Promise<MediaSaveDto> {
    return ipcClient.invoke('media_save', { sourcePath });
  },
  /** 内存字节入库（粘贴截图）；判型与去重仍在后端。 */
  saveBytes(data: string): Promise<MediaSaveDto> {
    return ipcClient.invoke('media_save_bytes', { data });
  },
  list(): Promise<MediaEntryDto[]> {
    return ipcClient.invoke('media_list');
  },
  remove(path: string): Promise<TrashResultDto> {
    return ipcClient.invoke('media_delete', { path });
  },
});

/** 回收站列举 / 清理。 */
export const trashApi = Object.freeze({
  list(): Promise<TrashListDto> {
    return ipcClient.invoke('trash_list');
  },
  cleanup(ids: readonly string[]): Promise<TrashCleanupDto> {
    return ipcClient.invoke('trash_cleanup', { ids: [...ids] });
  },
});

/** 文档历史：版本列表 / 读取 / 恢复 / 删除 / 清空。 */
export const historyApi = Object.freeze({
  list(docId: string): Promise<HistoryVersionDto[]> {
    return ipcClient.invoke('history_list', { docId });
  },
  read(docId: string, version: string): Promise<HistoryReadDto> {
    return ipcClient.invoke('history_read', { docId, version });
  },
  restore(request: HistoryRestoreRequest): Promise<WriteDocDto> {
    return ipcClient.invoke('history_restore', request);
  },
  delete(docId: string, version: string): Promise<HistoryDeleteDto> {
    return ipcClient.invoke('history_delete', { docId, version });
  },
  purge(docId: string): Promise<HistoryPurgeDto> {
    return ipcClient.invoke('history_purge', { docId });
  },
});

/** 备份：校验目标目录 / 导出 / 检查已有备份。 */
export const backupApi = Object.freeze({
  destination(destination: string): Promise<BackupDestinationDto> {
    return ipcClient.invoke('backup_destination', { destination });
  },
  export(destination: string): Promise<BackupReportDto> {
    return ipcClient.invoke('backup_export', { destination });
  },
  inspect(destination: string): Promise<BackupInspectDto> {
    return ipcClient.invoke('backup_inspect', { destination });
  },
});

/** AI：Key 保存/删除/状态、连接测试、模型列举、流式对话与取消。 */
export const aiApi = Object.freeze({
  keySave(request: AiKeySaveRequest): Promise<AiKeySaveDto> {
    return ipcClient.invoke('ai_key_save', request);
  },
  keyDelete(request: AiEndpointRequest): Promise<null> {
    return ipcClient.invoke('ai_key_delete', request);
  },
  keyStatus(request: AiEndpointRequest): Promise<AiKeyStatusDto> {
    return ipcClient.invoke('ai_key_status', request);
  },
  testConnection(request: AiEndpointRequest): Promise<AiTestConnectionDto> {
    return ipcClient.invoke('ai_test_connection', request);
  },
  listModels(request: AiEndpointRequest): Promise<AiModelsDto> {
    return ipcClient.invoke('ai_list_models', request);
  },
  chatStream(request: AiChatRequest, handlers: ChatStreamHandlers): Promise<void> {
    return ipcClient.chatStream(request, handlers);
  },
  cancel(requestId: AiChatCancelRequest['requestId']): Promise<AiChatCancelDto> {
    return ipcClient.invoke('ai_chat_cancel', { requestId });
  },
});

/** 联网翻译：事件经 onEvent 回调，译文以 Promise resolve。 */
export const translateApi = Object.freeze({
  online(
    args: { text: string; targetLang: string },
    onEvent: (event: TranslateEvent) => void,
  ): Promise<string> {
    return ipcClient.translateOnline(args, onEvent);
  },
});

/** 生产画布端口默认实例（装配层注入 ipcClient 的收口：app 层不再引用 ipcClient）。 */
export const canvasPort: CanvasPort = Object.freeze(createTauriCanvasPort(ipcClient));
