/**
 * CR-20261119-22：备份面板状态机（纯 reducer，零 React / 零 IPC / 零时钟副作用）。
 *
 * 六态：idle / validating / inspecting / exporting / done / error（D3）。
 * - in-flight 态只接受本阶段的 resolver 动作（VALIDATE_* / INSPECT_* / EXPORT_*），
 *   NAME_CHANGE / GO / PICK / CLOSE 一律忽略（A1 钉子）；
 * - PICK(null)（用户取消）不进 error、不清 backupName（A1 钉子）；
 * - PICK_ERR（系统选择器异常，非取消）落 error 态 phase=validate，异步零吞错；
 * - NAME_CHANGE 非法名忽略不更新（validateBackupName 白名单，复核修订）；
 * - GO 未选目录忽略；新周期（PICK 有 dir / GO）清空旧 result 与 error；
 * - 默认备份名由调用方生成后随 action 传入（reducer 保持纯函数，不取时钟）。
 */

import type { BackupInspectDto, BackupReportDto } from '../../types/ipc.ts';
import {
  buildDestination,
  generateDefaultBackupName,
  validateBackupName,
} from './backup-flow.ts';

// ─── State ──────────────────────────────────────────────────────────────────

export type BackupPanelStatus =
  | 'idle' // 面板打开，未选目录 / 待选
  | 'validating' // backup_destination 校验父目录在途
  | 'inspecting' // backup_inspect 探测子路径在途
  | 'exporting' // backup_export 在途
  | 'done' // 成功（检查结果或导出报告已展示）
  | 'error'; // 失败（保存 code + message + phase）

export interface BackupPanelError {
  readonly code: string | undefined;
  readonly message: string;
  /** 失败发生在哪个阶段（决定 E_INVALID_ARG 的文案语境）。 */
  readonly phase: 'validate' | 'inspect' | 'export';
}

export type BackupPanelResult =
  | { readonly mode: 'inspect'; readonly inspect: BackupInspectDto }
  | { readonly mode: 'export'; readonly report: BackupReportDto };

export interface BackupPanelState {
  readonly status: BackupPanelStatus;
  /** 已选父目录（backup_destination 校验对象；null = 未选）。 */
  readonly selectedDir: string | null;
  /** 子目录名（默认时间戳名，可编辑；始终为最近一次通过白名单校验的值）。 */
  readonly backupName: string;
  /** = join(selectedDir, backupName)；未选目录或名非法时为 null。 */
  readonly destination: string | null;
  readonly result: BackupPanelResult | null;
  readonly error: BackupPanelError | null;
}

// ─── Actions ────────────────────────────────────────────────────────────────

export type BackupPanelAction =
  | { readonly type: 'PICK'; readonly dir: string | null; readonly name: string }
  | { readonly type: 'PICK_ERR'; readonly code: string | undefined; readonly message: string }
  | { readonly type: 'NAME_CHANGE'; readonly name: string }
  | { readonly type: 'GO' }
  | { readonly type: 'VALIDATE_OK' }
  | { readonly type: 'VALIDATE_ERR'; readonly code: string | undefined; readonly message: string }
  | { readonly type: 'INSPECT_OK'; readonly inspect: BackupInspectDto }
  | { readonly type: 'INSPECT_NOT_FOUND' }
  | { readonly type: 'INSPECT_ERR'; readonly code: string | undefined; readonly message: string }
  | { readonly type: 'EXPORT_OK'; readonly report: BackupReportDto }
  | { readonly type: 'EXPORT_ERR'; readonly code: string | undefined; readonly message: string }
  | { readonly type: 'CLOSE' };

/** 面板初始态：backupName 默认时间戳名由调用方以 now 生成（D2 流程）。 */
export function createBackupPanelState(now: Date): BackupPanelState {
  return Object.freeze({
    status: 'idle',
    selectedDir: null,
    backupName: generateDefaultBackupName(now),
    destination: null,
    result: null,
    error: null,
  });
}

// ─── Reducer ────────────────────────────────────────────────────────────────

export function backupPanelReducer(
  state: BackupPanelState,
  action: BackupPanelAction,
): BackupPanelState {
  // in-flight 态：只接受本阶段 resolver，其余动作忽略（禁用规则由 UI 兜底）。
  switch (state.status) {
    case 'validating':
      if (action.type === 'VALIDATE_OK') {
        return Object.freeze({ ...state, status: 'inspecting', error: null });
      }
      if (action.type === 'VALIDATE_ERR') {
        return Object.freeze({
          ...state,
          status: 'error',
          error: Object.freeze({ code: action.code, message: action.message, phase: 'validate' }),
        });
      }
      return state;
    case 'inspecting':
      if (action.type === 'INSPECT_OK') {
        return Object.freeze({
          ...state,
          status: 'done',
          result: Object.freeze({ mode: 'inspect', inspect: action.inspect }),
          error: null,
        });
      }
      if (action.type === 'INSPECT_NOT_FOUND') {
        return Object.freeze({ ...state, status: 'exporting', result: null, error: null });
      }
      if (action.type === 'INSPECT_ERR') {
        return Object.freeze({
          ...state,
          status: 'error',
          error: Object.freeze({ code: action.code, message: action.message, phase: 'inspect' }),
        });
      }
      return state;
    case 'exporting':
      if (action.type === 'EXPORT_OK') {
        return Object.freeze({
          ...state,
          status: 'done',
          result: Object.freeze({ mode: 'export', report: action.report }),
          error: null,
        });
      }
      if (action.type === 'EXPORT_ERR') {
        return Object.freeze({
          ...state,
          status: 'error',
          error: Object.freeze({ code: action.code, message: action.message, phase: 'export' }),
        });
      }
      return state;
    default:
      break;
  }

  // 非 in-flight 态：idle / done / error。
  switch (action.type) {
    case 'PICK': {
      if (action.dir === null) return state; // 取消：原态维持，不进 error、不清 backupName
      return Object.freeze({
        status: 'validating',
        selectedDir: action.dir,
        backupName: action.name,
        destination: buildDestination(action.dir, action.name),
        result: null,
        error: null,
      });
    }
    case 'PICK_ERR':
      // 系统选择器异常（非用户取消）：零吞错落 error 态；已选目录/备份名保留。
      return Object.freeze({
        ...state,
        status: 'error',
        error: Object.freeze({ code: action.code, message: action.message, phase: 'validate' }),
      });
    case 'NAME_CHANGE': {
      if (!validateBackupName(action.name)) return state; // 非法忽略不更新（D3 规则 2）
      return Object.freeze({
        ...state,
        backupName: action.name,
        destination:
          state.selectedDir === null ? null : buildDestination(state.selectedDir, action.name),
      });
    }
    case 'GO': {
      if (state.selectedDir === null || state.destination === null) return state; // 未选目录忽略
      return Object.freeze({ ...state, status: 'inspecting', result: null, error: null });
    }
    case 'CLOSE':
      return Object.freeze({
        status: 'idle',
        selectedDir: null,
        backupName: '',
        destination: null,
        result: null,
        error: null,
      });
    default:
      return state; // resolver 动作不可能出现在非 in-flight 态；防御性维持原态
  }
}
