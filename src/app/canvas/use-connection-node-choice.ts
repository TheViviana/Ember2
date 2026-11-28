/**
 * 拉线落空菜单的「新建并连边」选择。
 * 统一从菜单落点构造节点输入，避免 CanvasView 里堆叠近似回调。
 */
import { useCallback } from 'react';
import type { CanvasNodeInput } from '#canvas-format';
import type { ConnectionMenuState } from './CanvasMenus.tsx';
import { documentTitleFromPath, makeNodeId } from './canvas-interactions.ts';

export interface ConnectionNodeChoice {
  readonly chooseText: () => void;
  readonly chooseAi: () => void;
  readonly chooseSplit: () => void;
  readonly chooseMerge: () => void;
  readonly chooseDoc: (path: string) => void;
}

export function useConnectionNodeChoice(
  current: ConnectionMenuState | null,
  commit: (node: CanvasNodeInput) => void,
): ConnectionNodeChoice {
  const choose = useCallback(
    (build: (point: { readonly x: number; readonly y: number }) => CanvasNodeInput): void => {
      if (current === null) return;
      commit(build(current.worldPoint));
    },
    [commit, current],
  );

  const chooseText = useCallback((): void => {
    choose((point) => ({ id: makeNodeId(), x: point.x, y: point.y, type: 'text', label: '文本节点' }));
  }, [choose]);

  const chooseAi = useCallback((): void => {
    choose((point) => ({ id: makeNodeId(), x: point.x, y: point.y, type: 'ai', label: 'AI 节点', text: '' }));
  }, [choose]);

  const chooseSplit = useCallback((): void => {
    choose((point) => ({ id: makeNodeId(), x: point.x, y: point.y, type: 'split', label: '分块节点' }));
  }, [choose]);

  const chooseMerge = useCallback((): void => {
    choose((point) => ({ id: makeNodeId(), x: point.x, y: point.y, type: 'merge', label: '汇总节点' }));
  }, [choose]);

  const chooseDoc = useCallback(
    (path: string): void => {
      choose((point) => ({
        id: makeNodeId(),
        x: point.x,
        y: point.y,
        type: 'document',
        docPath: path,
        label: documentTitleFromPath(path),
      }));
    },
    [choose],
  );

  return { chooseText, chooseAi, chooseSplit, chooseMerge, chooseDoc };
}
