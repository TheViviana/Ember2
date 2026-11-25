/**
 * 2026-11-23：右键/拉线菜单「创建新文章」。
 * 在库根创建空文章（未命名文章.md，重名自动编号），再挂 document 节点；
 * 若来自拉线，则同时 addNode + addEdge。
 */
import { useCallback } from 'react';
import type { CanvasCommand, CanvasNodeInput } from '#canvas-format';
import {
  createAddDocumentNodeCommand,
  createConnectNewNodeCommands,
  createConnectionNodePorts,
  documentTitleFromPath,
  makeNodeId,
} from './canvas-interactions.ts';
import type { CanvasEngine } from './engine.ts';
import { useEmberStore } from '../stores/ember-store';
import { pushNotice } from '../stores/notice-store';

export interface CreateEmptyArticleDeps {
  readonly sessionRef: { readonly current: { readonly engine: CanvasEngine } | null };
  readonly readOnly: boolean;
  readonly closeMenu: () => void;
  readonly clearConnectionMenu: () => void;
}

export interface CanvasPortAnchor {
  readonly nodeId: string;
  readonly portId: string;
}

export type CreateEmptyArticleAt = (
  screenPoint: { readonly x: number; readonly y: number },
  from: CanvasPortAnchor | null,
  worldPoint?: { readonly x: number; readonly y: number },
) => Promise<void>;

function createDocumentNode(
  x: number,
  y: number,
  rel: string,
  ports: boolean,
): CanvasNodeInput {
  return {
    id: makeNodeId(),
    x,
    y,
    type: 'document',
    docPath: rel,
    label: documentTitleFromPath(rel),
    ...(ports ? { ports: createConnectionNodePorts() } : {}),
  };
}

/** 库根空文章创建器；调用方负责把返回的 Promise 接到菜单动作。 */
export function useCreateEmptyArticle(deps: CreateEmptyArticleDeps): CreateEmptyArticleAt {
  const { sessionRef, readOnly, closeMenu, clearConnectionMenu } = deps;
  return useCallback(
    async (
      screenPoint: { readonly x: number; readonly y: number },
      from: CanvasPortAnchor | null,
      worldPoint?: { readonly x: number; readonly y: number },
    ): Promise<void> => {
      const engine = sessionRef.current?.engine;
      if (engine === undefined) return;
      if (readOnly || engine.isReadOnly()) {
        pushNotice('画布只读，无法创建文章', 'warning');
        closeMenu();
        clearConnectionMenu();
        return;
      }
      const world = worldPoint ?? engine.screenToWorld(screenPoint);
      const store = useEmberStore.getState();
      let rel: string | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const candidate = attempt === 0 ? '未命名文章.md' : `未命名文章-${attempt + 1}.md`;
        const result = await store.createDoc(candidate);
        if (result.ok) {
          rel = result.rel;
          break;
        }
        if (result.reason !== 'EXISTS') {
          pushNotice(`新建文章失败：${result.message}`, 'error');
          closeMenu();
          clearConnectionMenu();
          return;
        }
      }
      if (rel === null) {
        pushNotice('新建文章失败：无法找到可用的文件名', 'error');
        closeMenu();
        clearConnectionMenu();
        return;
      }
      const currentEngine = sessionRef.current?.engine;
      if (currentEngine === undefined) {
        pushNotice('画布已切换，文章已创建但未添加节点', 'warning');
        return;
      }
      const commands: readonly CanvasCommand[] =
        from === null
          ? [createAddDocumentNodeCommand(world.x, world.y, rel)]
          : createConnectNewNodeCommands(createDocumentNode(world.x, world.y, rel, true), from);
      if (!currentEngine.executeCommands(commands)) {
        pushNotice('文章已创建，但画布节点添加失败', 'error');
      }
      if (from === null) closeMenu();
      else clearConnectionMenu();
    },
    [clearConnectionMenu, closeMenu, readOnly, sessionRef],
  );
}
