/**
 * 画布端口与保存队列的公共类型（CR-20261116-02 §7.1）。
 *
 * 只依赖 `types/ipc.ts`、`../errors.ts` 与 `../ports.ts`；不引 `@tauri-apps/*`。
 * 真实 IPC 适配在 `src/data/`（提交 4），测试注入 `tests/kernel/fakes.ts` 的
 * `FakeCanvasPort`（提交 3 的 mock 边界）。
 */
import type { CanvasEntryDto, ReadCanvasDto, WriteCanvasDto } from '../../types/ipc.ts';
import type { EmberIpcError } from '../errors.ts';

/** 一次成功保存的结果；`sha256` 来自落盘字节。 */
export interface CanvasSaveSuccess {
  readonly id: string;
  readonly sha256: string;
  readonly modifiedMs: number;
}

/** `flush` 的逐项结果：成功与失败都必须出现，禁止静默丢弃。 */
export type CanvasSaveResult =
  | {
      readonly id: string;
      readonly ok: true;
      readonly sha256: string;
      readonly modifiedMs: number;
    }
  | { readonly id: string; readonly ok: false; readonly error: EmberIpcError };

/** `flush` 报告；`timedOut:true` 时 `ok` 必须为 `false`，不得误报成功。 */
export interface CanvasFlushReport {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly error: EmberIpcError | null;
  readonly results: CanvasSaveResult[];
  /** 超时后仍未结算的 id；排空时为空数组。 */
  readonly pendingIds: string[];
}

/** `open` 结果：不存在是正常态（`exists:false` + `sha256:""`），不是错误。 */
export interface CanvasOpenResult {
  readonly exists: boolean;
  readonly text: string | null;
  readonly sha256: string;
  readonly modifiedMs: number | null;
}

export interface CanvasSaveOptions {
  /** 首份 v1 升级时备份为 `.v1.bak`；缺省 `false`。 */
  readonly backupV1?: boolean;
}

/**
 * 画布 IPC 端口：逐条对应 `list_canvases` / `canvas_read` / `canvas_write`，
 * 原样透传（包含 `valid:false` 条目），不做 schema 解析、不做防抖、不做重试。
 */
export interface CanvasPort {
  list(): Promise<CanvasEntryDto[]>;
  /** 文件不存在时 reject `E_NOT_FOUND`，由 `CanvasStore.open` 转成 `exists:false`。 */
  read(id: string): Promise<ReadCanvasDto>;
  /**
   * 条件写：`expectedSha` 为空串表示「期望目标不存在」（沿用 `EXPECT_MISSING_SHA`），
   * core 永不传 `null`。冲突由 Rust 判定并返回 `E_CONFLICT`。
   */
  write(
    id: string,
    text: string,
    expectedSha: string,
    options?: CanvasSaveOptions,
  ): Promise<WriteCanvasDto>;
}

/** 画布 store 接口（CR-20261116-02 §7.1）；正文与撤销栈归 UI，不在本层存储。 */
export interface CanvasStore {
  list(): Promise<CanvasEntryDto[]>;
  open(id: string): Promise<CanvasOpenResult>;
  /** 同步入队；Promise 在写盘完成后结算（成功 resolve / 失败 reject）。 */
  save(id: string, text: string, options?: CanvasSaveOptions): Promise<CanvasSaveSuccess>;
  beginClosing(): void;
  cancelClosing(): void;
  flush(options?: { readonly timeoutMs?: number }): Promise<CanvasFlushReport>;
}
