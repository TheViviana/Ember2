/** 节点标题、正文与提示词的原位编辑状态和提交；保持三类编辑语义互不混用。 */
import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { CanvasEngine } from './engine.ts';
import type { CanvasEditState } from './CanvasMenus.tsx';
import {
  createUpdateLabelCommand,
  createUpdatePromptTextCommand,
} from './canvas-interactions.ts';
import { pushNotice } from '../stores/notice-store.ts';

export function useCanvasEditing<Session extends { readonly engine: CanvasEngine }>(
  sessionRef: RefObject<Session | null>,
  readOnly: boolean,
) {
  const [editing, setEditing] = useState<CanvasEditState | null>(null);

  const commitPromptEdit = useCallback(
    (text: string): boolean => {
      const session = sessionRef.current;
      if (session === null || editing === null) return false;
      if (readOnly) {
        pushNotice('画布只读，无法编辑提示词', 'warning');
        setEditing(null);
        return true;
      }
      const normalized = text.replace(/\r\n/g, '\n');
      const ok = session.engine.executeCommands([
        createUpdatePromptTextCommand(editing.nodeId, normalized),
      ]);
      if (!ok) {
        pushNotice('提示词保存失败，请查看画布通知', 'error');
        return false;
      }
      setEditing(null);
      return true;
    },
    [editing, readOnly, sessionRef],
  );

  const commitEdit = useCallback(
    (label: string): void => {
      const session = sessionRef.current;
      if (session === null || editing === null) return;
      const trimmed = label.trim();
      if (trimmed === '') {
        pushNotice('节点名称不能为空', 'warning');
        return;
      }
      if (readOnly) {
        pushNotice('画布只读，无法编辑标签', 'warning');
        setEditing(null);
        return;
      }
      const ok = session.engine.executeCommands([createUpdateLabelCommand(editing.nodeId, trimmed)]);
      if (!ok) {
        pushNotice('更新失败，请查看画布通知', 'error');
        return;
      }
      setEditing(null);
    },
    [editing, readOnly, sessionRef],
  );

  const commitTextEdit = useCallback(
    (text: string): void => {
      const session = sessionRef.current;
      if (session === null || editing === null) return;
      if (readOnly) {
        pushNotice('画布只读，无法编辑文本', 'warning');
        setEditing(null);
        return;
      }
      const normalized = text.replace(/\r\n/g, '\n');
      const ok = session.engine.executeCommands([
        createUpdateLabelCommand(editing.nodeId, normalized),
      ]);
      if (!ok) {
        pushNotice('更新失败，请查看画布通知', 'error');
        return;
      }
      setEditing(null);
    },
    [editing, readOnly, sessionRef],
  );

  const cancelEdit = useCallback((): void => setEditing(null), []);

  useEffect(() => {
    const engine = sessionRef.current?.engine;
    engine?.setEditingNode(
      editing !== null && editing.kind !== 'prompt' ? editing.nodeId : null,
    );
    return () => engine?.setEditingNode(null);
  }, [editing, sessionRef]);

  return { editing, setEditing, commitPromptEdit, commitEdit, commitTextEdit, cancelEdit };
}
