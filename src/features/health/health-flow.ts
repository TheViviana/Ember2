import { formatUnknownError } from '../../core/errors.ts';

export interface WorkbenchTrashEntry {
  readonly id: string;
  readonly path: string | null;
  readonly bytes: number;
  readonly deletedAt: string | null;
}

export interface WorkbenchTrashCleanupError {
  readonly id: string;
  readonly code: string;
  readonly message: string;
}

export interface WorkbenchTrashCleanupResult {
  readonly removedIds: readonly string[];
  readonly errors: readonly WorkbenchTrashCleanupError[];
}

export interface HealthPanelEffects {
  list(): Promise<readonly WorkbenchTrashEntry[]>;
  cleanup(ids: readonly string[]): Promise<WorkbenchTrashCleanupResult>;
}

export interface TrashSummary {
  readonly count: number;
  readonly totalBytes: number;
}

export type HealthFlowResult<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'cancelled'; readonly value: T }
  | { readonly status: 'error'; readonly error: string; readonly value: T };

export interface TrashCleanupOutcome {
  readonly entries: readonly WorkbenchTrashEntry[];
  readonly cleanup: WorkbenchTrashCleanupResult | null;
}

export function summarizeTrash(entries: readonly WorkbenchTrashEntry[]): TrashSummary {
  return {
    count: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  };
}

export function formatTrashBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unit]}`;
}

export async function loadWorkbenchTrash(
  effects: HealthPanelEffects,
): Promise<HealthFlowResult<readonly WorkbenchTrashEntry[]>> {
  try {
    return { status: 'ok', value: await effects.list() };
  } catch (error: unknown) {
    return {
      status: 'error',
      error: `读取 Workbench 回收站失败：${formatUnknownError(error, String(error))}`,
      value: [],
    };
  }
}

function applyCleanup(
  current: readonly WorkbenchTrashEntry[],
  refreshed: readonly WorkbenchTrashEntry[],
  result: WorkbenchTrashCleanupResult,
): readonly WorkbenchTrashEntry[] {
  const failedIds = new Set(result.errors.map((error) => error.id));
  const removedIds = new Set(result.removedIds.filter((id) => !failedIds.has(id)));
  const entries = refreshed.filter((entry) => !removedIds.has(entry.id));
  const present = new Set(entries.map((entry) => entry.id));
  for (const entry of current) {
    if (failedIds.has(entry.id) && !present.has(entry.id)) {
      entries.push(entry);
      present.add(entry.id);
    }
  }
  return entries;
}

export async function cleanupWorkbenchTrash(
  current: readonly WorkbenchTrashEntry[],
  selectedIds: readonly string[],
  effects: HealthPanelEffects,
  confirm: (summary: TrashSummary) => boolean,
): Promise<HealthFlowResult<TrashCleanupOutcome>> {
  const selected = new Set(selectedIds);
  const entries = current.filter((entry) => selected.has(entry.id));
  if (entries.length === 0) {
    return { status: 'cancelled', value: { entries: current, cleanup: null } };
  }
  if (!confirm(summarizeTrash(entries))) {
    return { status: 'cancelled', value: { entries: current, cleanup: null } };
  }

  let cleanup: WorkbenchTrashCleanupResult;
  try {
    cleanup = await effects.cleanup(entries.map((entry) => entry.id));
  } catch (error: unknown) {
    return {
      status: 'error',
      error: `整理 Workbench 回收站失败：${formatUnknownError(error, String(error))}`,
      value: { entries: current, cleanup: null },
    };
  }

  try {
    const refreshed = await effects.list();
    return {
      status: 'ok',
      value: { entries: applyCleanup(current, refreshed, cleanup), cleanup },
    };
  } catch (error: unknown) {
    return {
      status: 'error',
      error: `整理已返回，但刷新 Workbench 回收站失败：${formatUnknownError(error, String(error))}`,
      value: { entries: applyCleanup(current, current, cleanup), cleanup },
    };
  }
}
