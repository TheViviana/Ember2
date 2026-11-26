/** 文档树与画布共用的真实目录快照；pendingDirs 只承担本地操作的即时展示。 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { vaultApi } from '../../data/app-api.ts';
import { formatUnknownError } from '../../core/errors.ts';
import { useEmberStore } from '../stores/ember-store.ts';
import { pushNotice } from '../stores/notice-store.ts';
import { useTreeStore } from '../stores/tree-store.ts';
import { collectDirectoryPaths } from '../tree/build-tree.ts';

export function useKnownDirs(): {
  readonly dirs: ReadonlySet<string>;
  readonly refreshDirs: () => void;
} {
  const docs = useEmberStore((state) => state.index.docs);
  const root = useEmberStore((state) => state.identity?.root ?? null);
  const maxDepth = useEmberStore((state) => state.constants?.maxScanDepth ?? null);
  const knownDirs = useTreeStore((state) => state.knownDirs);
  const pendingDirs = useTreeStore((state) => state.pendingDirs);
  const setKnownDirs = useTreeStore((state) => state.setKnownDirs);
  const removePendingDirs = useTreeStore((state) => state.removePendingDirs);
  const requestRef = useRef(0);

  const refreshDirs = useCallback((): void => {
    const request = ++requestRef.current;
    const target = useEmberStore.getState();
    const targetRoot = target.identity?.root ?? null;
    const targetMaxDepth = target.constants?.maxScanDepth;
    if (targetRoot === null || targetMaxDepth === undefined) return;
    const current = (): boolean =>
      requestRef.current === request &&
      useEmberStore.getState().identity?.root === targetRoot;

    void collectDirectoryPaths(vaultApi.list, targetMaxDepth)
      .then((paths) => {
        // 切库或后续刷新已发生时，迟到响应不得覆盖新目录快照。
        if (current()) setKnownDirs(paths);
      })
      .catch((error: unknown) => {
        // 单次刷新失败保留上次成功快照，避免空目录突然消失。
        if (!current()) return;
        pushNotice(`刷新文件夹失败：${formatUnknownError(error, '未知错误')}`, 'warning');
      });
  }, [setKnownDirs]);

  useEffect(() => {
    requestRef.current += 1;
    setKnownDirs(new Set());
    removePendingDirs([...useTreeStore.getState().pendingDirs]);
  }, [root, setKnownDirs, removePendingDirs]);

  useEffect(() => {
    if (root !== null && maxDepth !== null) refreshDirs();
  }, [root, docs, maxDepth, refreshDirs]);

  useEffect(() => {
    const settled = [...pendingDirs].filter(
      (dir) =>
        knownDirs.has(dir) ||
        [...docs.keys()].some((path) => path.startsWith(`${dir}/`)),
    );
    if (settled.length > 0) removePendingDirs(settled);
  }, [docs, knownDirs, pendingDirs, removePendingDirs]);

  const dirs = useMemo(
    () => new Set([...knownDirs, ...pendingDirs]),
    [knownDirs, pendingDirs],
  );
  return { dirs, refreshDirs };
}
