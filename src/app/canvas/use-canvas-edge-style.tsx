/**
 * 连线样式浮层的状态与命令装配：把 React 侧的状态机从 CanvasView 拆出，
 * 避免装配文件继续膨胀。纯入口层：读取文档当前样式 → 生成可逆命令 → 交给 engine。
 */
import { useCallback, useState, type ReactElement } from 'react';
import type { CanvasEngine } from './engine.ts';
import { EdgeStyleMenu } from './EdgeStyleMenu.tsx';
import { readEdgeStyle, type EdgeStyleView } from './edge-layout.ts';
import { createSetEdgeStyleCommands, type EdgeStylePatch } from './canvas-interactions.ts';
import { pushNotice } from '../stores/notice-store';

interface EdgeStyleSession {
  readonly engine: CanvasEngine;
}

interface EdgeStyleSessionRef {
  readonly current: EdgeStyleSession | null;
}

interface EdgeStyleMenuState {
  readonly edgeId: string;
  readonly x: number;
  readonly y: number;
  readonly style: EdgeStyleView;
}

export interface CanvasEdgeStyleMenu {
  readonly element: ReactElement | null;
  readonly open: (edgeId: string, left: number, top: number) => void;
  readonly close: () => void;
}

function findEdge(document: ReturnType<CanvasEngine['getDocument']>, edgeId: string): unknown {
  return document.edges.find(
    (edge) => edge !== null && typeof edge === 'object' &&
      (edge as { readonly id?: unknown }).id === edgeId,
  );
}

export function useCanvasEdgeStyleMenu(
  sessionRef: EdgeStyleSessionRef,
  readOnly: boolean,
): CanvasEdgeStyleMenu {
  const [state, setState] = useState<EdgeStyleMenuState | null>(null);

  const close = useCallback((): void => {
    setState(null);
  }, []);

  const open = useCallback(
    (edgeId: string, left: number, top: number): void => {
      const engine = sessionRef.current?.engine;
      if (engine === undefined || readOnly || engine.isReadOnly()) return;
      const raw = findEdge(engine.getDocument(), edgeId) as { readonly style?: unknown } | undefined;
      setState({ edgeId, x: left, y: top, style: readEdgeStyle(raw?.style) });
    },
    [sessionRef, readOnly],
  );

  const apply = useCallback(
    (patch: EdgeStylePatch): void => {
      const engine = sessionRef.current?.engine;
      if (engine === undefined || state === null) return;
      if (readOnly || engine.isReadOnly()) return;
      const commands = createSetEdgeStyleCommands(engine.getDocument(), state.edgeId, patch);
      if (commands === null) {
        pushNotice('连线不存在，样式未保存', 'error');
        setState(null);
        return;
      }
      if (!engine.executeCommands(commands)) {
        pushNotice('连线样式保存失败，未应用更改', 'error');
        return;
      }
      const raw = findEdge(engine.getDocument(), state.edgeId) as
        | { readonly style?: unknown }
        | undefined;
      const style = readEdgeStyle(raw?.style);
      setState((prev) => (prev === null ? null : { ...prev, style }));
    },
    [sessionRef, state, readOnly],
  );

  const element =
    state === null ? null : (
      <EdgeStyleMenu
        left={state.x}
        top={state.y}
        style={state.style}
        onChange={apply}
        onClose={close}
      />
    );

  return { element, open, close };
}