/**
 * 内核端口：core 与宿主环境之间唯一的缝。
 *
 * core 只依赖这里的接口，不接触 `@tauri-apps/*`、React、zustand；
 * 生产适配在 `src/data/`（C4），测试注入 `tests/kernel/fakes.ts`。
 */
import type {
  ConflictCopyDto,
  DirEntryDto,
  FileChangedDto,
  ReadDocDto,
  ScanDocDto,
  StatDto,
  TrashResultDto,
  VaultConstantsDto,
  VaultIdentityDto,
  WatchErrorPayload,
  WriteDocDto,
} from '../types/ipc.ts';

/** 退订函数；实现必须幂等。 */
export type Unsubscribe = () => void;

/** 条件写哨兵：仅在目标仍不存在时允许创建；null 才是旧版无条件写。 */
export const EXPECT_MISSING_SHA = '';

/** 库存储端口，逐条对应契约 §III 的 vault_* 命令。 */
export interface VaultPort {
  identity(): Promise<VaultIdentityDto>;
  constants(): Promise<VaultConstantsDto>;
  /** 全量扫描 .md，返回相对库根的正斜杠路径。 */
  scan(): Promise<ScanDocDto[]>;
  read(path: string): Promise<ReadDocDto>;
  write(path: string, text: string, expectedSha?: string | null): Promise<WriteDocDto>;
  /** 冲突发生时把本地草稿另存到 `.workbench/conflicts/`（create-only）。 */
  saveConflictCopy(path: string, text: string, stamp: string): Promise<ConflictCopyDto>;
  stat(path: string): Promise<StatDto>;
  /** 单层列举；缺省为库根。 */
  list(path?: string): Promise<DirEntryDto[]>;
  rename(from: string, to: string): Promise<WriteDocDto>;
  /** 移入废纸篓（系统或 .workbench）；core 不关心实际落点。 */
  remove(path: string): Promise<TrashResultDto>;
}

/** 后端全局事件端口；订阅是异步的（Tauri listen 返回 Promise）。 */
export interface EventPort {
  onFileChanged(handler: (payload: FileChangedDto) => void): Promise<Unsubscribe>;
  onWatchError(handler: (payload: WatchErrorPayload) => void): Promise<Unsubscribe>;
}

/**
 * 可注入时钟：内核严禁直接摸 Date / setTimeout。
 * `wait` 是防抖与退避的唯一等待手段，测试用 FakeClock 推进假时间。
 */
export interface Clock {
  now(): number;
  wait(ms: number): Promise<void>;
}

/** 生产时钟；测试请注入 FakeClock，而非缩短真实延时。 */
export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    wait: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
