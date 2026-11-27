/**
 * P5-C3/C4：编辑器窗口适配器（app 层，`src/editor/` 与 app store 的唯一桥接层）。
 * 绑定记账、关窗协调、EditorHost 端口与窗口 UI 面板留在这里；
 * 纯编排逻辑抽到 ai-text-run.ts / backlinks-flow.ts。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView } from '../../editor/EditorView';
import { editorBindings } from '../../editor/binding';
import type {
  EditorControl,
  EditorDocSnapshot,
  EditorHost,
  EditorLoadState,
} from '../../editor/host';
import { registerEditorMediaInserter } from '../../editor/media-insert-registry.ts';
import { registerEditorLocker } from '../editor-lock-registry.ts';
import { releaseOnUnmount } from '../window-close-flow.ts';
import {
  registerCloseTarget,
  requestAcceptDeletion,
  requestWindowClose,
  useCloseFlowStore,
} from '../stores/close-flow-store';
import { getViewport, openWindow } from '../../windows/use-window-manager.ts';
import { EDITOR_WINDOW_CONTENT } from '../../windows/content-types.ts';
import type { WindowContentProps } from '../../windows/use-window-manager.ts';
import { useEmberStore } from '../stores/ember-store';
import { pushNotice } from '../stores/notice-store';
import { EmberIpcError } from '../../data/ipc-client.ts';
import { aiApi, docApi } from '../../data/app-api.ts';
import { resolveEditorDocumentPath } from './editor-document-path.ts';
import { resolveInboxFileReference } from './inbox-file-reference.ts';
import { openLibraryDocument } from '../doc-open.ts';
import { parseFrontmatter } from '../../core/markdown.ts';
import { withDocumentTags } from '../../core/frontmatter-edit.ts';
import { backlinksOf } from '../../core/link-index.ts';
import { useTranslateStore } from '../translate/translate-store.ts';
import { useShellRequestStore } from '../shell/shell-requests.ts';
import { useEditorModeRequestStore } from '../stores/editor-mode-requests.ts';
import { AI_TEXT_ACTIONS } from '../../features/ai/ai-text-actions.ts';
import { TagBar } from '../../features/tags/TagBar.tsx';
import type { ChatRequestFailure } from '../../features/ai/ai-chat-request.ts';
import { mapAiErrorCode } from '../../features/ai/ai-error-map.ts';
import { useAiChatStore } from '../../features/ai/ai-chat-store.ts';
import { createAiTextRun } from './ai-text-run.ts';
import { createBacklinksFlow } from './backlinks-flow.ts';
import { renderCloseOverlay } from './editor-close-panels.tsx';
import { saveClipboardImage } from './editor-clipboard.ts';

const AI_REQUEST_FAILURE_TEXT: Record<ChatRequestFailure, string> = {
  invalid_request_id: '请求编号无效，请重试',
  invalid_base_url: '请先在 AI 助手「设置」中填写有效的 Base URL',
  missing_model: '请先在 AI 助手「设置」中选择模型',
  empty_messages: '选区为空，无法发送',
};

/** 宿主侧接线：配置 / 传输 / 取消 / 文案全部注入，模块本身零 store、零 IPC。 */
const aiTextRun = createAiTextRun({
  config: () => useAiChatStore.getState().config,
  stream: (request, handlers) => aiApi.chatStream(request, handlers),
  cancel: (requestId) => aiApi.cancel(requestId),
  notice: (failure) => {
    if (failure.kind === 'unknown-action') return '未知的 AI 动作';
    if (failure.kind === 'config') return AI_REQUEST_FAILURE_TEXT[failure.reason];
    return mapAiErrorCode(failure.code, failure.message).text;
  },
});

const backlinksFlow = createBacklinksFlow({
  ensureIndex: () => useEmberStore.getState().ensureLinkIndex(),
  getIndex: () => useEmberStore.getState().linkIndex,
  backlinksOf,
});

export function EditorWindow({ record }: WindowContentProps) {
  /** windowId 永远保留初始路径；实际文档路径可随外部改名迁移。 */
  const windowId = record.id;
  const resolveDocPath = useEmberStore((state) => state.resolveDocPath);
  const path = resolveEditorDocumentPath(windowId, resolveDocPath);
  const docState = useEmberStore((state) => state.docs.get(path) ?? null);
  const openDoc = useEmberStore((state) => state.openDoc);
  const closeFlow = useCloseFlowStore((state) => state.views.get(windowId) ?? null);
  const translateState = useTranslateStore();
  const translation =
    translateState.open && translateState.sourcePath === path
      ? {
          status: translateState.status,
          segments: translateState.segments,
          progress: translateState.progress,
        }
      : null;
  const modeRequest = useEditorModeRequestStore((state) => state.byPath[path] ?? null);
  const consumeMode = useEditorModeRequestStore((state) => state.consumeMode);
  const immersive = useEditorModeRequestStore((state) => state.immersive);
  const toggleImmersive = useEditorModeRequestStore((state) => state.toggleImmersive);

  const [loadState, setLoadState] = useState<EditorLoadState>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const everLoadedRef = useRef(false);
  const controlRef = useRef<EditorControl | null>(null);
  const unregisterMediaInsertRef = useRef<(() => void) | null>(null);
  const unregisterEditorLockRef = useRef<(() => void) | null>(null);
  const editorWaitersRef = useRef<Set<() => void>>(new Set());
  const pendingReleaseRef =
    useRef<{ readonly path: string; readonly settled: Promise<void> } | null>(null);

  /** EditorView 句柄就绪：记录控制能力并唤醒 awaitEditor 的等待者。 */
  const handleEditorReady = (control: EditorControl): void => {
    controlRef.current = control;
    unregisterMediaInsertRef.current?.();
    unregisterMediaInsertRef.current = registerEditorMediaInserter(
      windowId,
      (media, point) => control.insertMedia(media, point),
    );
    unregisterEditorLockRef.current?.();
    unregisterEditorLockRef.current = registerEditorLocker(windowId, (locked) =>
      control.setLocked(locked),
    );
    const waiters = [...editorWaitersRef.current];
    editorWaitersRef.current.clear();
    for (const resolve of waiters) resolve();
  };

  useEffect(() => () => {
    unregisterMediaInsertRef.current?.();
    unregisterMediaInsertRef.current = null;
    unregisterEditorLockRef.current?.();
    unregisterEditorLockRef.current = null;
  }, []);

  // 挂载：认领绑定 → 注册关闭目标 → openDoc；卸载：注销目标 → 等 open 落定 → release。
  useEffect(() => {
    let cancelled = false;
    let claimedToken: number | null = null;
    let openSettled: Promise<void> | null = null;
    let unregister: (() => void) | null = null;
    const editorWaiters = editorWaitersRef.current;

    const activate = (): void => {
      if (cancelled) return;
      const claimed = editorBindings.claim(windowId, path);
      if (!claimed.ok) {
        pushNotice(
          claimed.reason === 'doc-already-bound'
            ? `文档已在另一个浮窗中打开：${path}`
            : `浮窗已绑定其他文档，无法重复绑定：${path}`,
          'warning',
        );
        setLoadState('error');
        setLoadError('窗口绑定失败');
        return;
      }
      claimedToken = claimed.token;
      setLoadState('loading');
      setLoadError(null);

      const opening = openDoc(path).then(
        () => {
          if (!cancelled) setLoadState('ready');
        },
        (error: unknown) => {
          if (!cancelled) {
            setLoadState('error');
            setLoadError(error instanceof Error ? error.message : '打开文档失败');
          }
        },
      );
      openSettled = opening;

      unregister = registerCloseTarget(windowId, {
        path,
        token: claimed.token,
        awaitOpen: () => opening,
        awaitEditor: () => {
          if (controlRef.current !== null) return Promise.resolve();
          return new Promise<void>((resolve) => {
            editorWaiters.add(resolve);
          });
        },
        lockEditing: () => {
          const control = controlRef.current;
          if (!control) return Promise.reject(new Error('编辑器句柄尚未就绪'));
          control.setLocked(true);
          return Promise.resolve();
        },
        handoff: () => {
          editorBindings.handoff(windowId, claimed.token);
        },
        resume: () => {
          editorBindings.revokeHandoff(windowId, claimed.token);
          controlRef.current?.setLocked(false);
        },
      });
    };

    const pendingRelease = pendingReleaseRef.current;
    if (pendingRelease !== null && pendingRelease.path !== path) {
      void pendingRelease.settled.then(activate).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : '未知错误';
        if (!cancelled) {
          setLoadState('error');
          setLoadError('窗口绑定失败');
        }
        pushNotice(`文档改名后重新绑定失败：${detail}`, 'error');
      });
    } else {
      activate();
    }

    return () => {
      cancelled = true;
      const token = claimedToken;
      const opening = openSettled;
      // 同路径 StrictMode 重挂载会立即 claim 新 token，使旧 release 失效；
      // 不同路径则由下一次 effect 等本次 release 完成后再 claim。
      if (token !== null) editorBindings.retire(windowId, token);
      unregister?.();
      editorWaiters.clear();
      controlRef.current = null;
      if (token === null || opening === null) return;
      const settled = releaseOnUnmount({
        path,
        awaitOpen: opening,
        release: () =>
          editorBindings.release(windowId, token, {
            hasDoc: (target) => useEmberStore.getState().docs.has(target),
            saveDoc: (target) => useEmberStore.getState().saveDoc(target),
            closeDoc: (target) => useEmberStore.getState().closeDoc(target),
          }),
        report: (message) => pushNotice(message, 'error'),
      });
      pendingReleaseRef.current = { path, settled };
    };
  }, [path, windowId, openDoc]);

  // 文档从 Core 消失（外部删除且 clean）→ 只读占位，窗口不自动关闭（D4）。
  useEffect(() => {
    if (docState !== null) {
      everLoadedRef.current = true;
      return;
    }
    if (everLoadedRef.current) setLoadState('removed');
  }, [docState]);

  const host: EditorHost = {
    writeBack: (target, text) => {
      useEmberStore.getState().editDoc(target, text);
    },
    resolveConflict: async (target, choice) => {
      await useEmberStore.getState().resolveDocConflict(target, choice);
    },
    requestCloseWindow: (target) => {
      // 统一经 app 层协调器；窗口层只转发，不直接 closeWindow。
      requestWindowClose(target);
    },
    requestAcceptDeletion: (target) => {
      requestAcceptDeletion(target);
    },
    reportNotice: (message, tone) => {
      pushNotice(message, tone);
    },
    resolveFileReference: async (sourcePath) => {
      const state = useEmberStore.getState();
      const reference = resolveInboxFileReference(
        sourcePath,
        state.identity?.root ?? null,
        (relativePath) => state.index.docs.has(relativePath),
      );
      if (reference === null) return null;
      try {
        await docApi.stat(reference.path);
        return reference;
      } catch (error: unknown) {
        if (error instanceof EmberIpcError && error.code === 'E_NOT_FOUND') return null;
        throw error;
      }
    },
    saveClipboardImage,
  };

  const doc: EditorDocSnapshot | null =
    docState === null
      ? null
      : {
          path: docState.path,
          text: docState.text,
          dirty: docState.dirty,
          saving: docState.saving,
          externalKind: docState.external?.kind ?? null,
          conflictCopyPath: docState.conflictCopy?.path ?? null,
          conflictCopyFailed: docState.conflictCopyFailed,
          errorMessage: docState.error?.message ?? null,
        };

  // 阅读窗口：标题 / 标签来自 frontmatter；写回沿用 doc-store 的自动保存与冲突矩阵。
  const libraryRoot = useEmberStore((state) => state.identity?.root ?? null);
  const libraryName = libraryRoot?.split('/').filter((segment) => segment !== '').pop() ?? null;
  const frontmatter = useMemo(
    () => (docState === null ? null : parseFrontmatter(docState.text).frontmatter),
    [docState],
  );
  const tags = frontmatter?.tags ?? [];
  const documentTitle = frontmatter?.title;

  // 反向链接索引单源：只订阅状态，索引读取与折叠交给 backlinksFlow。
  const linkIndexStatus = useEmberStore((state) => state.linkIndexStatus);

  const handleTagsChange = (next: readonly string[]): void => {
    const state = useEmberStore.getState();
    const current = state.docs.get(path) ?? null;
    if (current === null) return;
    const result = withDocumentTags(current.text, next);
    if (result.error !== null) {
      pushNotice(result.error, 'warning');
      return;
    }
    state.editDoc(current.path, result.text);
  };

  const handleTranslate = (selectedText: string | null): void => {
    const current = useEmberStore.getState().docs.get(path) ?? null;
    if (current === null) return;
    // 对照内联（CR-20261121-43）：只译正文——frontmatter 不渲染也不翻译。
    const body = selectedText ?? parseFrontmatter(current.text).body;
    useTranslateStore.getState().start({
      text: body,
      sourcePath: current.path,
      sourceLabel: selectedText === null ? current.path : `${current.path} · 选区`,
      // CR-20261120-40 B/C：失败在点击处即时提示；AI 未配置时引导打开翻译设置（每会话一次）。
      onFailure: (failure) => {
        pushNotice(failure.message, failure.kind === 'unconfigured' ? 'warning' : 'error');
        if (failure.kind === 'unconfigured') {
          useShellRequestStore.getState().requestTranslateSettings();
        }
      },
    });
  };

  const backlinksState = backlinksFlow.stateFor(linkIndexStatus, doc?.path ?? '');

  // CR-20261120-34：预览内链 → 与画布文档节点同一打开口径（库内索引命中才开窗）。
  // CR-R2-3：接入库内文档打开闸门单源；顺带获得改名别名解析（修正）。
  const handleOpenInternalLink = (target: string): void => {
    const state = useEmberStore.getState();
    openLibraryDocument(target, {
      hasDoc: (path) => state.index.docs.has(path),
      resolveDocPath: state.resolveDocPath,
      open: (path) => openWindow(path, EDITOR_WINDOW_CONTENT, getViewport()),
      onMissing: (path) => pushNotice(`未找到文档：${path}`, 'warning'),
    });
  };

  return (
    <EditorView
      windowId={windowId}
      loadState={loadState}
      doc={doc}
      loadError={loadError}
      host={host}
      onReady={handleEditorReady}
      onNotice={pushNotice}
      onOpenInternalLink={handleOpenInternalLink}
      libraryName={libraryName}
      documentTitle={documentTitle}
      tagBar={({ readOnly }) => (
        <TagBar tags={tags} onChange={handleTagsChange} disabled={readOnly} />
      )}
      backlinks={backlinksState}
      onBuildBacklinks={backlinksFlow.build}
      onTranslate={handleTranslate}
      translation={translation}
      onDismissTranslation={() => useTranslateStore.getState().close()}
      onCancelTranslation={() => useTranslateStore.getState().cancel()}
      onResumeTranslation={() => useTranslateStore.getState().resume()}
      modeRequest={modeRequest}
      onModeRequestConsumed={() => consumeMode(path)}
      immersive={immersive}
      onToggleImmersive={toggleImmersive}
      actions={AI_TEXT_ACTIONS}
      onAiTextAction={aiTextRun.run}
      overlay={renderCloseOverlay(closeFlow)}
    />
  );
}
