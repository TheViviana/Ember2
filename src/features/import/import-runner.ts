import { formatUnknownError } from '../../core/errors.ts';

export type ImportConflict = 'skip' | 'rename';
export type ImportItemStatus = 'pending' | 'running' | 'imported' | 'skipped' | 'failed';

export interface ImportItem {
  readonly sourcePath: string;
  readonly status: ImportItemStatus;
  readonly path: string | null;
  readonly message: string | null;
}

export interface ImportCallResult {
  readonly status: 'imported' | 'skipped';
  readonly path: string | null;
  readonly bytes: number;
  readonly sha: string | null;
}

export interface ImportRunnerEffects {
  flush(): Promise<void>;
  importFile(
    sourcePath: string,
    targetDir: string,
    conflict: ImportConflict,
  ): Promise<ImportCallResult>;
  reconcile(path: string): Promise<void>;
}

export interface ImportRunResult {
  readonly items: readonly ImportItem[];
  readonly imported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly cancelled: boolean;
  readonly fatalError: string | null;
}

export interface ImportRunHooks {
  onChange(items: readonly ImportItem[], activeIndex: number | null): void;
  shouldCancel(): boolean;
}

function update(
  items: readonly ImportItem[],
  index: number,
  changes: Partial<ImportItem>,
): readonly ImportItem[] {
  return items.map((item, itemIndex) => itemIndex === index ? { ...item, ...changes } : item);
}

export function initialImportItems(paths: readonly string[]): readonly ImportItem[] {
  return [...new Set(paths)].map((sourcePath) => ({
    sourcePath,
    status: 'pending',
    path: null,
    message: null,
  }));
}

export function defaultImportTarget(activePath: string | null): string {
  if (activePath === null) return 'documents/';
  const slash = activePath.lastIndexOf('/');
  return slash < 0 ? '' : activePath.slice(0, slash);
}

/** 取消只在文件之间生效；已成功导入的文件绝不回滚。 */
export async function runImport(
  paths: readonly string[],
  targetDir: string,
  conflict: ImportConflict,
  effects: ImportRunnerEffects,
  hooks: ImportRunHooks,
): Promise<ImportRunResult> {
  let items = initialImportItems(paths);
  hooks.onChange(items, null);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  let cancelled = false;
  let fatalError: string | null = null;

  try {
    await effects.flush();
  } catch (error: unknown) {
    return {
      items,
      imported,
      skipped,
      failed,
      cancelled,
      fatalError: `保存当前文档失败，导入未开始：${formatUnknownError(error, String(error))}`,
    };
  }

  for (let index = 0; index < items.length; index += 1) {
    if (hooks.shouldCancel()) {
      cancelled = true;
      break;
    }
    const sourcePath = items[index]?.sourcePath;
    if (sourcePath === undefined) continue;
    items = update(items, index, { status: 'running', message: null });
    hooks.onChange(items, index);
    try {
      const result = await effects.importFile(sourcePath, targetDir, conflict);
      if (result.status === 'imported' && result.path !== null) {
        imported += 1;
        items = update(items, index, { status: 'imported', path: result.path });
        hooks.onChange(items, index);
        try {
          await effects.reconcile(result.path);
        } catch (error: unknown) {
          fatalError = `已导入 ${result.path}，但同步打开文档失败：${formatUnknownError(error, String(error))}`;
          items = update(items, index, { message: fatalError });
          hooks.onChange(items, null);
          break;
        }
      } else {
        skipped += 1;
        items = update(items, index, { status: 'skipped', path: null });
      }
    } catch (error: unknown) {
      failed += 1;
      items = update(items, index, {
        status: 'failed',
        path: null,
        message: formatUnknownError(error, String(error)),
      });
    }
    hooks.onChange(items, null);
  }

  if (hooks.shouldCancel() && items.some((item) => item.status === 'pending')) cancelled = true;
  return { items, imported, skipped, failed, cancelled, fatalError };
}
