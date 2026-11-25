import { useEffect, useRef, useState } from 'react';
import { previewDocumentMatch } from './match.ts';
import {
  commitReplacement,
  countReplaceMatches,
  prepareReplacement,
  runReplaceSearch,
  skipReplaceMatches,
  validateSearchRequest,
  type ReplaceCommitSummary,
  type ReplaceDocument,
  type ReplaceIssue,
  type ReplaceRunnerEffects,
  type ReplaceSearchRequest,
  type ReplacementPlan,
  type SearchRunResult,
} from './replace-runner.ts';
import styles from './replace.module.css';

export interface ReplaceSettingsBodyProps {
  readonly effects: ReplaceRunnerEffects;
}

type Phase = 'idle' | 'searching' | 'preflight' | 'confirm' | 'committing';

const KIND_LABEL = { title: '标题', tags: '标签', body: '正文' } as const;

function IssueList({ issues }: { readonly issues: readonly ReplaceIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className={styles.issues} role="alert">
      <strong>不可提交项（{issues.length}）</strong>
      {issues.map((issue) => (
        <p key={`${issue.path}:${issue.code}`} className={issue.code === 'stale' ? styles.stale : styles.issue}>
          <span>{issue.path}</span> · {issue.code === 'stale' ? '版本冲突' : issue.code === 'invalid' ? '校验失败' : '读取失败'} · {issue.message}
        </p>
      ))}
    </div>
  );
}

function CommitResult({ summary }: { readonly summary: ReplaceCommitSummary }) {
  const result = summary.result;
  const unresolved = result === null ? [] : [...new Set([
    ...result.written,
    ...result.rollbackErrors.map((error) => error.path),
  ])];
  const staleFailure = summary.failure !== null && /CONFLICT|STALE|SHA/i.test(summary.failure.code);
  return (
    <section className={styles.commitResult} aria-live="polite">
      {result?.status === 'applied' ? (
        <p className={styles.success} role="status">已替换 {summary.documents} 篇文档、{summary.matches} 处匹配。</p>
      ) : null}
      {result?.status === 'rolledBack' ? (
        <div className={styles.rolledBack} role="alert">
          <strong>写入未完成，已恢复本批所有已写文档。</strong>
          <p>{result.failure?.path} · {result.failure?.message}</p>
          <p>已恢复：{result.restored.join('、') || '无已写文档'}</p>
        </div>
      ) : null}
      {result?.status === 'partial' ? (
        <div className={styles.partial} role="alert">
          <strong>部分文档未能恢复，请勿盲目重试。</strong>
          <p>以下路径可能仍保留新内容或回滚失败：</p>
          <ul>{unresolved.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          {result.rollbackErrors.map((error) => <p key={error.path}>{error.path} · {error.code} · {error.message}</p>)}
        </div>
      ) : null}
      {result === null && summary.failure !== null ? (
        <p className={styles.error} role="alert">
          {staleFailure ? '版本冲突，批次未提交。请刷新搜索结果后重试。' : '提交失败，未收到批次结果。'}
          {' '}{summary.failure.path} · {summary.failure.code} · {summary.failure.message}
        </p>
      ) : null}
      <IssueList issues={summary.unavailable} />
      {summary.reconcileError !== null ? <p className={styles.error} role="alert">{summary.reconcileError}</p> : null}
    </section>
  );
}

export function ReplaceSettingsBody({ effects }: ReplaceSettingsBodyProps) {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [scopes, setScopes] = useState({ title: true, body: true, tags: true });
  const [phase, setPhase] = useState<Phase>('idle');
  const [documents, setDocuments] = useState<readonly ReplaceDocument[]>([]);
  const [searchIssues, setSearchIssues] = useState<readonly ReplaceIssue[]>([]);
  const [progress, setProgress] = useState({ scanned: 0, total: 0 });
  const [preflightProgress, setPreflightProgress] = useState({ checked: 0, total: 0 });
  const [pending, setPending] = useState<ReplacementPlan | null>(null);
  const [summary, setSummary] = useState<ReplaceCommitSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const mountedRef = useRef(true);

  const busy = phase === 'searching' || phase === 'preflight' || phase === 'committing';
  const matchCount = countReplaceMatches(documents);

  useEffect(() => () => {
    mountedRef.current = false;
    cancelRef.current = true;
  }, []);

  const clearResults = (): void => {
    setDocuments([]);
    setSearchIssues([]);
    setPending(null);
    setSummary(null);
    setMessage(null);
    setProgress({ scanned: 0, total: 0 });
  };

  const search = async (request: ReplaceSearchRequest): Promise<SearchRunResult> => {
    const completed = await runReplaceSearch(request, effects, {
      onProgress(next) {
        if (!mountedRef.current) return;
        setProgress({ scanned: next.scanned, total: next.total });
        setDocuments(next.documents);
        setSearchIssues(next.issues);
      },
      shouldCancel: () => cancelRef.current,
    });
    if (!mountedRef.current) return completed;
    setDocuments(completed.documents);
    setSearchIssues(completed.issues);
    setProgress({ scanned: completed.scanned, total: completed.total });
    return completed;
  };

  const startSearch = async (): Promise<void> => {
    if (busy || phase === 'confirm') return;
    const request = { query, scopes };
    const invalid = validateSearchRequest(request);
    if (invalid !== null) {
      setMessage(invalid);
      return;
    }
    cancelRef.current = false;
    setPhase('searching');
    setDocuments([]);
    setSearchIssues([]);
    setPending(null);
    setSummary(null);
    setMessage(null);
    const completed = await search(request);
    if (!mountedRef.current) return;
    if (completed.fatalError !== null) setMessage(completed.fatalError);
    if (completed.cancelled) setMessage('搜索已取消，未执行写入；当前仅显示部分结果。');
    setPhase('idle');
  };

  const commit = async (plan: ReplacementPlan): Promise<void> => {
    setPhase('committing');
    setMessage('正在提交批次，此阶段不可取消。');
    const committed = await commitReplacement(plan, effects);
    if (!mountedRef.current) return;
    setSummary(committed);
    const refreshed = await search(plan.search);
    if (!mountedRef.current) return;
    if (refreshed.fatalError !== null) setMessage(`替换已结束，但刷新结果失败：${refreshed.fatalError}`);
    else setMessage(null);
    setPhase('idle');
  };

  const beginReplace = async (ids: readonly string[] | null): Promise<void> => {
    if (phase !== 'idle' || documents.length === 0) return;
    const request = { query, scopes };
    cancelRef.current = false;
    setPhase('preflight');
    setSummary(null);
    setPending(null);
    setMessage(null);
    setPreflightProgress({ checked: 0, total: 0 });
    const prepared = await prepareReplacement(documents, ids, replacement, request, effects, {
      onProgress(checked, total) {
        if (mountedRef.current) setPreflightProgress({ checked, total });
      },
      shouldCancel: () => cancelRef.current,
    });
    if (!mountedRef.current) return;
    setPending(prepared);
    if (prepared.fatalError !== null) {
      setMessage(prepared.fatalError);
      setPhase('idle');
      return;
    }
    if (prepared.cancelled) {
      setMessage('预检已取消，未执行写入。');
      setPhase('idle');
      return;
    }
    if (ids === null) {
      setPhase('confirm');
      return;
    }
    if (prepared.items.length === 0) {
      setMessage('没有可提交的匹配；请查看版本冲突或校验详情。');
      setPhase('idle');
      return;
    }
    await commit(prepared);
  };

  const issuePaths = new Set((pending?.issues ?? summary?.unavailable ?? []).map((issue) => issue.path));

  return (
    <div className={styles.body} aria-busy={busy} aria-label="全局搜索与替换">
          <form className={styles.controls} onSubmit={(event) => { event.preventDefault(); void startSearch(); }}>
            <label className={styles.queryField} htmlFor="replace-query">
              搜索
              <input
                id="replace-query"
                value={query}
                onChange={(event) => { setQuery(event.target.value); clearResults(); }}
                disabled={busy || phase === 'confirm'}
                spellCheck={false}
              />
            </label>
            <label className={styles.queryField} htmlFor="replace-value">
              替换为
              <input
                id="replace-value"
                value={replacement}
                onChange={(event) => { setReplacement(event.target.value); setPending(null); setSummary(null); }}
                disabled={busy || phase === 'confirm'}
                spellCheck={false}
              />
            </label>
            <fieldset className={styles.scopes} disabled={busy || phase === 'confirm'}>
              <legend>范围</legend>
              {(['title', 'body', 'tags'] as const).map((kind) => (
                <label key={kind}>
                  <input
                    type="checkbox"
                    checked={scopes[kind]}
                    onChange={(event) => { setScopes((current) => ({ ...current, [kind]: event.target.checked })); clearResults(); }}
                  />
                  {KIND_LABEL[kind]}
                </label>
              ))}
            </fieldset>
            <button type="submit" className={styles.searchButton} disabled={busy || phase === 'confirm'}>搜索</button>
          </form>

          <div className={styles.progress} aria-live="polite">
            {phase === 'searching' ? `正在扫描 ${progress.scanned} / ${progress.total} · 已发现 ${matchCount} 处` : null}
            {phase === 'preflight' ? `正在重新读取并校验 ${preflightProgress.checked} / ${preflightProgress.total} · 尚未写入` : null}
            {phase === 'committing' ? '正在提交并同步文档，此阶段不可取消…' : null}
            {phase === 'idle' || phase === 'confirm' ? `已扫描 ${progress.scanned} / ${progress.total} · ${documents.length} 篇文档 · ${matchCount} 处匹配` : null}
          </div>
          {message !== null ? <p className={styles.message} role="status">{message}</p> : null}
          <IssueList issues={searchIssues} />
          {summary !== null ? <CommitResult summary={summary} /> : <IssueList issues={pending?.issues ?? []} />}

          {phase === 'confirm' && pending !== null ? (
            <section className={styles.confirm} role="alert">
              <strong>确认全部替换</strong>
              <p>当前结果共 {documents.length} 篇文档、{matchCount} 处匹配。</p>
              <p>本次可提交 {pending.items.length} 篇、{pending.matchCount} 处；不可提交 {pending.issues.length} 篇。</p>
              <p>提交前已重新读取并校验版本。运行期写入失败会尽力回滚，但不保证进程崩溃时跨文件原子性。</p>
            </section>
          ) : null}

          <div className={styles.results} role="list">
            {documents.length === 0 && phase === 'idle' && progress.scanned > 0 ? (
              <p className={styles.empty}>当前结果中没有匹配。</p>
            ) : null}
            {documents.map((document) => (
              <article className={styles.document} role="listitem" key={document.path}>
                <header className={styles.documentHeader}>
                  <span className={styles.path} title={document.path}>{document.path}</span>
                  <span>{document.matches.length} 处</span>
                  {issuePaths.has(document.path) ? <span className={styles.stale}>未提交</span> : null}
                </header>
                {document.matches.map((match) => {
                  const preview = previewDocumentMatch(match, replacement);
                  return (
                    <div className={styles.match} key={match.id}>
                      <div className={styles.matchMeta}>
                        <span className={styles.kind}>{KIND_LABEL[match.kind]}</span>
                        <code>offset {match.range.start}–{match.range.end}</code>
                      </div>
                      <div className={styles.preview}>
                        <p><span className={styles.previewLabel}>原文</span><span>{match.context.before}</span><mark>{match.context.match}</mark><span>{match.context.after}</span></p>
                        <p><span className={styles.previewLabel}>预览</span><span>{preview.before}</span><mark className={styles.replacement}>{preview.replacement}</mark><span>{preview.after}</span></p>
                      </div>
                      <div className={styles.matchActions}>
                        <button type="button" onClick={() => { void beginReplace([match.id]); }} disabled={phase !== 'idle'}>替换</button>
                        <button type="button" onClick={() => { setDocuments((current) => skipReplaceMatches(current, [match.id])); setPending(null); setSummary(null); }} disabled={phase !== 'idle'}>跳过</button>
                      </div>
                    </div>
                  );
                })}
              </article>
            ))}
          </div>

          <footer className={styles.footer}>
            <span className={styles.hint}>搜索和预检可取消，始终零写入；提交后不可取消。</span>
            <span className={styles.spacer} />
            {phase === 'searching' || phase === 'preflight' ? (
              <button type="button" onClick={() => { cancelRef.current = true; setMessage('将在当前文件结束后取消，未执行写入。'); }}>取消</button>
            ) : null}
            {phase === 'confirm' ? (
              <>
                <button type="button" onClick={() => { setPhase('idle'); }}>返回结果</button>
                <button type="button" className={styles.primary} disabled={pending?.items.length === 0} onClick={() => { if (pending !== null) void commit(pending); }}>确认全部替换</button>
              </>
            ) : (
              <button type="button" className={styles.primary} onClick={() => { void beginReplace(null); }} disabled={phase !== 'idle' || matchCount === 0}>全部替换</button>
            )}
          </footer>
    </div>
  );
}
