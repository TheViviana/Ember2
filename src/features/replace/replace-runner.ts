import { applyDocumentReplacements, readDocumentSource } from '../../core/document-source.ts';
import {
  findDocumentMatches,
  type DocumentMatch,
  type MatchScopes,
} from './match.ts';
import { formatUnknownError } from '../../core/errors.ts';

export interface ReplaceScanEntry {
  readonly path: string;
}

export interface ReplaceReadResult {
  readonly text: string;
  readonly sha256: string;
}

export interface ReplaceItem {
  readonly path: string;
  readonly expectedSha: string;
  readonly text: string;
}

export interface ReplaceFailure {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ReplaceResult {
  readonly status: 'applied' | 'rolledBack' | 'partial';
  readonly written: readonly string[];
  readonly restored: readonly string[];
  readonly failure: ReplaceFailure | null;
  readonly rollbackErrors: readonly ReplaceFailure[];
}

export interface ReplaceRunnerEffects {
  scan(): Promise<readonly ReplaceScanEntry[]>;
  read(path: string): Promise<ReplaceReadResult>;
  flush(): Promise<void>;
  replace(items: readonly ReplaceItem[]): Promise<ReplaceResult>;
  reconcile(paths: readonly string[]): Promise<void>;
  yieldControl(): Promise<void>;
}

export interface ReplaceSearchRequest {
  readonly query: string;
  readonly scopes: MatchScopes;
}

export interface ReplaceMatch extends DocumentMatch {
  readonly id: string;
}

export interface ReplaceDocument {
  readonly path: string;
  readonly expectedSha: string;
  readonly text: string;
  readonly matches: readonly ReplaceMatch[];
}

export type ReplaceIssueCode = 'stale' | 'read' | 'invalid';

export interface ReplaceIssue {
  readonly path: string;
  readonly code: ReplaceIssueCode;
  readonly message: string;
}

export interface SearchProgress {
  readonly scanned: number;
  readonly total: number;
  readonly documents: readonly ReplaceDocument[];
  readonly issues: readonly ReplaceIssue[];
}

export interface SearchHooks {
  onProgress(progress: SearchProgress): void;
  shouldCancel(): boolean;
}

export interface SearchRunResult {
  readonly documents: readonly ReplaceDocument[];
  readonly issues: readonly ReplaceIssue[];
  readonly scanned: number;
  readonly total: number;
  readonly cancelled: boolean;
  readonly fatalError: string | null;
}

export interface PreparedReplaceItem extends ReplaceItem {
  readonly matchIds: readonly string[];
}

export interface ReplacementPlan {
  readonly search: ReplaceSearchRequest;
  readonly replacement: string;
  readonly items: readonly PreparedReplaceItem[];
  readonly issues: readonly ReplaceIssue[];
  readonly matchCount: number;
  readonly cancelled: boolean;
  readonly fatalError: string | null;
}

export interface PreflightHooks {
  onProgress(checked: number, total: number): void;
  shouldCancel(): boolean;
}

export interface ReplaceCommitSummary {
  readonly result: ReplaceResult | null;
  readonly documents: number;
  readonly matches: number;
  readonly unavailable: readonly ReplaceIssue[];
  readonly failure: ReplaceFailure | null;
  readonly reconcileError: string | null;
}

function failureOf(error: unknown, fallbackPath: string): ReplaceFailure {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
  const code = typeof record?.rawCode === 'string'
    ? record.rawCode
    : typeof record?.code === 'string' ? record.code : 'E_UNKNOWN';
  const path = typeof record?.path === 'string' ? record.path : fallbackPath;
  return { path, code, message: formatUnknownError(error, String(error)) };
}

export function validateSearchRequest(request: ReplaceSearchRequest): string | null {
  if (request.query.length === 0) return '请输入搜索内容';
  if (!request.scopes.title && !request.scopes.body && !request.scopes.tags) {
    return '至少选择标题、正文或标签之一';
  }
  return null;
}

export function countReplaceMatches(documents: readonly ReplaceDocument[]): number {
  return documents.reduce((total, document) => total + document.matches.length, 0);
}

export function skipReplaceMatches(
  documents: readonly ReplaceDocument[],
  ids: readonly string[],
): readonly ReplaceDocument[] {
  const skipped = new Set(ids);
  return documents
    .map((document) => ({
      ...document,
      matches: document.matches.filter((match) => !skipped.has(match.id)),
    }))
    .filter((document) => document.matches.length > 0);
}

/** 文件顺序协作扫描；每个文件后通过注入的 yield 让出事件循环。 */
export async function runReplaceSearch(
  request: ReplaceSearchRequest,
  effects: ReplaceRunnerEffects,
  hooks: SearchHooks,
): Promise<SearchRunResult> {
  const invalid = validateSearchRequest(request);
  if (invalid !== null) {
    return { documents: [], issues: [], scanned: 0, total: 0, cancelled: false, fatalError: invalid };
  }

  let entries: readonly ReplaceScanEntry[];
  try {
    entries = await effects.scan();
  } catch (error: unknown) {
    return {
      documents: [],
      issues: [],
      scanned: 0,
      total: 0,
      cancelled: false,
      fatalError: `扫描文档失败：${formatUnknownError(error, String(error))}`,
    };
  }

  let documents: readonly ReplaceDocument[] = [];
  let issues: readonly ReplaceIssue[] = [];
  let scanned = 0;
  let cancelled = false;
  const total = entries.length;
  hooks.onProgress({ scanned, total, documents, issues });

  for (const entry of entries) {
    if (hooks.shouldCancel()) {
      cancelled = true;
      break;
    }
    try {
      const read = await effects.read(entry.path);
      const matches = findDocumentMatches(read.text, request.query, request.scopes).map((match) => ({
        ...match,
        id: `${entry.path}:${match.range.start}:${match.range.end}`,
      }));
      if (matches.length > 0) {
        documents = [...documents, {
          path: entry.path,
          expectedSha: read.sha256,
          text: read.text,
          matches,
        }];
      }
    } catch (error: unknown) {
      issues = [...issues, { path: entry.path, code: 'read', message: formatUnknownError(error, String(error)) }];
    }
    scanned += 1;
    hooks.onProgress({ scanned, total, documents, issues });
    await effects.yieldControl();
  }

  return { documents, issues, scanned, total, cancelled, fatalError: null };
}

function selectedDocuments(
  documents: readonly ReplaceDocument[],
  ids: readonly string[] | null,
): readonly ReplaceDocument[] {
  if (ids === null) return documents;
  const selected = new Set(ids);
  return documents
    .map((document) => ({
      ...document,
      matches: document.matches.filter((match) => selected.has(match.id)),
    }))
    .filter((document) => document.matches.length > 0);
}

/** flush + 全量重新 read/SHA 校验 + YAML 预检；本函数绝不调用写 IPC。 */
export async function prepareReplacement(
  documents: readonly ReplaceDocument[],
  ids: readonly string[] | null,
  replacement: string,
  search: ReplaceSearchRequest,
  effects: ReplaceRunnerEffects,
  hooks: PreflightHooks,
): Promise<ReplacementPlan> {
  const candidates = selectedDocuments(documents, ids);
  const matchCount = countReplaceMatches(candidates);
  const empty = (cancelled: boolean, fatalError: string | null = null): ReplacementPlan => ({
    search,
    replacement,
    items: [],
    issues: [],
    matchCount,
    cancelled,
    fatalError,
  });
  if (candidates.length === 0) return empty(false);
  if (hooks.shouldCancel()) return empty(true);
  hooks.onProgress(0, candidates.length);

  try {
    await effects.flush();
  } catch (error: unknown) {
    return empty(false, `保存当前文档失败，替换未开始：${formatUnknownError(error, String(error))}`);
  }
  if (hooks.shouldCancel()) return empty(true);

  let items: readonly PreparedReplaceItem[] = [];
  let issues: readonly ReplaceIssue[] = [];
  let checked = 0;
  let cancelled = false;
  for (const document of candidates) {
    if (hooks.shouldCancel()) {
      cancelled = true;
      break;
    }
    try {
      const current = await effects.read(document.path);
      if (current.sha256 !== document.expectedSha || current.text !== document.text) {
        issues = [...issues, {
          path: document.path,
          code: 'stale',
          message: '文档在搜索后已变化，未提交；请刷新搜索结果',
        }];
      } else {
        const replaced = applyDocumentReplacements(
          readDocumentSource(document.text),
          document.matches.map((match) => ({ range: match.range, replacement })),
        );
        if (replaced.error !== null) {
          issues = [...issues, { path: document.path, code: 'invalid', message: replaced.error }];
        } else {
          items = [...items, {
            path: document.path,
            expectedSha: document.expectedSha,
            text: replaced.text,
            matchIds: document.matches.map((match) => match.id),
          }];
        }
      }
    } catch (error: unknown) {
      issues = [...issues, { path: document.path, code: 'read', message: formatUnknownError(error, String(error)) }];
    }
    checked += 1;
    hooks.onProgress(checked, candidates.length);
    await effects.yieldControl();
  }

  return {
    search,
    replacement,
    items: cancelled ? [] : items,
    issues,
    matchCount: cancelled ? 0 : items.reduce((total, item) => total + item.matchIds.length, 0),
    cancelled,
    fatalError: null,
  };
}

/** 提交阶段不读取取消标记；返回后先对账所有相关路径，再把结果交给 UI 刷新。 */
export async function commitReplacement(
  plan: ReplacementPlan,
  effects: ReplaceRunnerEffects,
): Promise<ReplaceCommitSummary> {
  const base = {
    documents: plan.items.length,
    matches: plan.matchCount,
    unavailable: plan.issues,
  };
  if (plan.cancelled || plan.fatalError !== null || plan.items.length === 0) {
    return {
      ...base,
      result: null,
      failure: null,
      reconcileError: plan.fatalError,
    };
  }

  let result: ReplaceResult | null = null;
  let failure: ReplaceFailure | null = null;
  const paths = new Set<string>(plan.items.map((item) => item.path));
  try {
    result = await effects.replace(plan.items.map(({ path, expectedSha, text }) => ({ path, expectedSha, text })));
    for (const path of [...result.written, ...result.restored]) paths.add(path);
    if (result.failure !== null) {
      paths.add(result.failure.path);
      failure = result.failure;
    }
    for (const error of result.rollbackErrors) paths.add(error.path);
  } catch (error: unknown) {
    failure = failureOf(error, plan.items[0]?.path ?? '');
    paths.add(failure.path);
  }

  let reconcileError: string | null = null;
  try {
    await effects.reconcile([...paths]);
  } catch (error: unknown) {
    reconcileError = `文档已写入，但同步打开文档失败：${formatUnknownError(error, String(error))}`;
  }
  return { ...base, result, failure, reconcileError };
}
