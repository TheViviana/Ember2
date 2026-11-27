/**
 * P5-C3：EditorView 与 app 层之间的端口契约。
 *
 * `src/editor/` 经 gate:layers 禁止直引 `src/app` 与 zustand，app 专属能力
 * （写回 Core、冲突裁决、请求关窗、提示上报）全部经此端口注入，保持依赖单向。
 */

/** 单个浮窗可见的文档快照（由 app 适配器从 DocState 映射）。 */
export interface EditorDocSnapshot {
  readonly path: string;
  readonly text: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  /** 外部变更类型；null 表示无冲突。 */
  readonly externalKind: 'updated' | 'removed' | null;
  /** 冲突发生时的本地草稿副本路径；写入失败或未冲突时为 null。 */
  readonly conflictCopyPath?: string | null;
  /** 冲突副本写入失败；为 true 时横幅提示手动备份。 */
  readonly conflictCopyFailed?: boolean;
  readonly errorMessage: string | null;
}

/** 文档加载状态（由适配器维护，EditorView 只负责呈现）。 */
export type EditorLoadState = 'loading' | 'ready' | 'error' | 'removed';

export type NoticeTone = 'info' | 'warning' | 'error';

export type EditorConflictChoice = 'reload' | 'overwrite';

/**
 * 编辑器句柄（EditorView 创建后经 `onReady` 交给 app 适配器）。
 * `setLocked` 同步生效：关窗协调器在保存前调用它，确保锁定已应用后才判定排空。
 */
export interface EditorMediaInsertion {
  readonly kind: 'image' | 'audio' | 'video';
  readonly path: string;
  readonly label: string;
}

export interface EditorInsertPoint {
  readonly x: number;
  readonly y: number;
}

export interface EditorFileReference {
  readonly kind: 'doc' | 'media';
  readonly path: string;
}

export interface EditorControl {
  setLocked(locked: boolean): void;
  /** 画布媒体节点落入本浮窗时插入引用；失败由编辑器自行上报。 */
  insertMedia(media: EditorMediaInsertion, point: EditorInsertPoint): void;
}

/** EditorView 需要的全部外部能力；由 `src/app/panels/EditorWindow.tsx` 实现。 */
export interface EditorHost {
  /** 编辑器正文变化 → 写回 Core（不得在外部回写事务上调用）。 */
  writeBack(path: string, text: string): void;
  /** 外部冲突裁决（reload / overwrite）。 */
  resolveConflict(path: string, choice: EditorConflictChoice): Promise<void>;
  /** 请求关闭本浮窗（外部删除占位「关闭窗口」）；统一经 app 层关窗协调器。 */
  requestCloseWindow(windowId: string): void;
  /** 冲突横幅「接受删除」：进入唯一确认流程，不直接关窗、不直接丢弃本地改动。 */
  requestAcceptDeletion(windowId: string): void;
  /** 上报用户可见提示（保存失败等，禁止静默）。 */
  reportNotice(message: string, tone?: NoticeTone): void;
  /** 收集箱文件只在能解析为当前库内文档/媒体时返回安全引用。 */
  resolveFileReference(sourcePath: string): Promise<EditorFileReference | null>;
  /** 粘贴截图：写入媒体库并返回库内引用；未实现时不接管图片粘贴。 */
  saveClipboardImage?(file: File): Promise<EditorFileReference | null>;
}
