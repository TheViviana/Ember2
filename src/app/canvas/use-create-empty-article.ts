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
  reverse?: boolean,
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

/** 在库根创建唯一文件名；已存在只换名，其它错误直接通知。 */
async function createUniqueArticle(baseName: string): Promise<string | null> {
  const store = useEmberStore.getState();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? `${baseName}.md` : `${baseName}-${attempt + 1}.md`;
    const result = await store.createDoc(candidate);
    if (result.ok) return result.rel;
    if (result.reason !== 'EXISTS') {
      pushNotice(`新建文章失败：${result.message}`, 'error');
      return null;
    }
  }
  pushNotice('新建文章失败：无法找到可用的文件名', 'error');
  return null;
}

/** AI 回答先落成真实 Markdown，再由 AppShell 添加对应文档节点。 */
export async function createAiAnswerArticle(text: string): Promise<string | null> {
  const rel = await createUniqueArticle('AI 回答');
  if (rel === null) return null;
  const store = useEmberStore.getState();
  const sha256 = store.index.docs.get(rel)?.sha256;
  if (sha256 === undefined) {
    pushNotice('文章已创建，但读取版本信息失败', 'error');
    return null;
  }
  const written = await store.writeDocText(rel, text, sha256);
  if (!written.ok) {
    const message = written.reason === 'dirty' ? '文档正在编辑或保存' : written.error.message;
    pushNotice(`文章已创建，但 AI 内容写入失败：${message}`, 'error');
    return null;
  }
  return rel;
}

export interface AiAnswerCanvasTarget {
  getEngine(): CanvasEngine | null;
  addNodeCentered(kind: 'document', docPath: string): boolean;
}

/** AppShell 注入给 AI 面板：保存回答并在同一画布的中心建文档节点。 */
export async function insertAiAnswerToCanvas(
  canvas: AiAnswerCanvasTarget | null,
  active: boolean,
  text: string,
): Promise<void> {
  const engine = canvas?.getEngine();
  if (!active || engine == null) {
    pushNotice('请先打开画布，再加入 AI 回答', 'warning');
    return;
  }
  if (engine.isReadOnly()) {
    pushNotice('画布只读，无法加入 AI 回答', 'warning');
    return;
  }
  const rel = await createAiAnswerArticle(text);
  if (rel === null) return;
  if (canvas === null || canvas.getEngine() !== engine) {
    pushNotice('画布已切换，文章已创建但未添加节点', 'warning');
    return;
  }
  if (canvas.addNodeCentered('document', rel)) pushNotice('AI 回答已加入画布', 'info');
}

/** 库根空文章创建器；调用方负责把返回的 Promise 接到菜单动作。 */
export function useCreateEmptyArticle(deps: CreateEmptyArticleDeps): CreateEmptyArticleAt {
  const { sessionRef, readOnly, closeMenu, clearConnectionMenu } = deps;
  return useCallback(
    async (
      screenPoint: { readonly x: number; readonly y: number },
      from: CanvasPortAnchor | null,
      worldPoint?: { readonly x: number; readonly y: number },
      reverse = false,
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
      const rel = await createUniqueArticle('未命名文章');
      if (rel === null) {
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
          : createConnectNewNodeCommands(
            createDocumentNode(world.x, world.y, rel, true),
            from,
            reverse,
          );
      if (!currentEngine.executeCommands(commands)) {
        pushNotice('文章已创建，但画布节点添加失败', 'error');
      }
      if (from === null) closeMenu();
      else clearConnectionMenu();
    },
    [clearConnectionMenu, closeMenu, readOnly, sessionRef],
  );
}
