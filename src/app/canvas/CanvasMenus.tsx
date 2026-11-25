/**
 * CR-R4-2：画布菜单与编辑浮层的纯展示组件。
 *
 * 只接收锚点、菜单项数据与回调，不读 store、不碰 engine；定位所需的世界坐标
 * 换算由 CanvasView 完成后以 rect 传入。
 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasEngineEvent } from './engine.ts';
import type { TreeNode } from '../tree/build-tree.ts';
import { DocSubmenu } from './DocSubmenu.tsx';
import { docSubmenuRegistry } from './doc-submenu-model.ts';
import styles from './CanvasView.module.css';

/** C0-D：右键菜单状态。 */
export interface CanvasMenu {
  readonly x: number;
  readonly y: number;
  readonly target: CanvasEngineEvent;
  /** CR-20261121-45 项D：右键命中节点为文档时的路径/标题（null=非文档节点）。 */
  readonly nodeDocPath: string | null;
  readonly nodeLabel: string | null;
  /** CR-20261121-53：右键命中节点的种类（ai/prompt），null=其他。 */
  readonly nodeKind: 'ai' | 'prompt' | null;
}

/** N4：拉线落空菜单状态；与右键菜单完全独立，不共用 target 类型。 */
export interface ConnectionMenuState {
  readonly x: number;
  readonly y: number;
  readonly worldPoint: { readonly x: number; readonly y: number };
  readonly from: { readonly nodeId: string; readonly portId: string };
}

/** C0-D：文本编辑状态。CR-20261121-53：kind='prompt' 为提示词多行编辑（text=初始正文）。 */
export interface CanvasEditState {
  readonly nodeId: string;
  readonly nodeX: number;
  readonly nodeY: number;
  readonly label: string;
  readonly kind?: 'prompt';
  readonly text?: string;
}

/** CR-20261121-53：AI 节点模型选择浮层状态。 */
export interface CanvasModelPickerState {
  readonly nodeId: string;
  readonly nodeX: number;
  readonly nodeY: number;
}

export type CanvasModelChoices =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly models: readonly string[] }
  | { readonly state: 'error' };

/** CR-20261121-59：编辑浮层铺满节点矩形的屏幕坐标。 */
export interface CanvasOverlayRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 右键菜单悬停：由 pointermove 命中测试托管，避免 WKWebView 在菜单重排后残留 :hover。 */
function syncMenuHover(event: ReactPointerEvent<HTMLUListElement>): void {
  const list = event.currentTarget;
  const target =
    event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null;
  // CR-20261121-54：悬停顶层普通项（非子菜单触发器）时收起已打开的 DocSubmenu 面板，
  // 与 macOS 菜单语义一致。子面板内的项其最近 menu 容器是面板自身而非顶层 list，
  // 不得触发收起（否则在子面板里选文件会把面板自己关掉）。
  if (
    target !== null &&
    target.getAttribute('aria-haspopup') === null &&
    target.closest('ul[role="menu"]') === list
  ) {
    docSubmenuRegistry.closeActive();
  }
  for (const element of list.querySelectorAll('[data-menu-hover="true"]')) {
    if (element !== target) element.removeAttribute('data-menu-hover');
  }
  if (target !== null && list.contains(target)) {
    target.setAttribute('data-menu-hover', 'true');
  }
}

function clearMenuHover(event: ReactPointerEvent<HTMLUListElement>): void {
  for (const element of event.currentTarget.querySelectorAll('[data-menu-hover="true"]')) {
    element.removeAttribute('data-menu-hover');
  }
}

export interface CanvasContextMenuProps {
  readonly menu: CanvasMenu;
  readonly onAction: (action: string) => void;
  readonly docTree: readonly TreeNode[];
  readonly mediaTree: readonly TreeNode[];
  readonly onPickDoc: (path: string) => void;
  readonly onPickMedia: (path: string) => void;
  readonly readOnly: boolean;
  readonly runningAiNodeId: string | null;
  readonly accelerators: Readonly<Record<string, string>>;
  readonly onMenuEnter: () => void;
  readonly onMenuLeave: () => void;
}

export function CanvasContextMenu({
  menu,
  onAction,
  docTree,
  mediaTree,
  onPickDoc,
  onPickMedia,
  readOnly,
  runningAiNodeId,
  accelerators,
  onMenuEnter,
  onMenuLeave,
}: CanvasContextMenuProps) {
  const tgt = menu.target;
  const onBlank = tgt.kind === 'contextMenu' && tgt.target.kind === 'blank';
  const onNode = tgt.kind === 'contextMenu' && tgt.target.kind === 'node';
  const onEdge = tgt.kind === 'contextMenu' && tgt.target.kind === 'edge';
  const style = { left: `${menu.x}px`, top: `${menu.y}px` };
  const disabled = readOnly;
  // CR-20261121-53：右键命中的 AI 节点是否正在执行（菜单项在「执行/取消执行」间切换）。
  const aiRunningHere = runningAiNodeId !== null && onNode && tgt.target.id === runningAiNodeId;

  return (
    <ul
      className={styles.contextMenu}
      style={style}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onPointerMove={syncMenuHover}
      onPointerEnter={onMenuEnter}
      onPointerLeave={(event) => {
        clearMenuHover(event);
        onMenuLeave();
      }}
    >
      {onBlank ? (
        <>
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('addText')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
                  <path d="M2 3h8M2 6h8M2 9h5" strokeLinecap="round" />
                </svg>
              </span>
              新建文本节点
              <span className={styles.menuAccelerator}>{accelerators.addText ?? ''}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('addAi')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z" />
                  <path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z" />
                  <path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17" />
                </svg>
              </span>
              新建 AI 节点
              <span className={styles.menuAccelerator}>{accelerators.addAi ?? ''}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('addPrompt')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.1">
                  <path d="M1.5 2.5h9v6.5h-5L3 11V9H1.5Z" strokeLinejoin="round" />
                  <path d="M3.5 5h5M3.5 7h3" strokeLinecap="round" />
                </svg>
              </span>
              新建提示词节点
              <span className={styles.menuAccelerator}>{accelerators.addPrompt ?? ''}</span>
            </button>
          </li>
          {/* CR-20261121-58：新建操作与分类区之间分组线 */}
          <li className={styles.contextMenuDivider} />
          <DocSubmenu
            label="新建文档节点"
            tree={docTree}
            disabled={disabled}
            onOpen={() => onAction('addDocument')}
            onPick={onPickDoc}
            onMenuEnter={onMenuEnter}
            onMenuLeave={onMenuLeave}
          />
          <DocSubmenu
            label="媒体库"
            tree={mediaTree}
            disabled={disabled}
            onPick={onPickMedia}
            emptyLabel="媒体库暂无内容"
            onMenuEnter={onMenuEnter}
            onMenuLeave={onMenuLeave}
          />
        </>
      ) : null}
      {onNode ? (
        <>
          {menu.nodeDocPath !== null ? (
            <li>
              <button
                type="button"
                className={styles.contextMenuItem}
                onClick={() => onAction('openReadMode')}
              >
                打开阅读浮窗
              </button>
            </li>
          ) : null}
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('openDoc')}
            >
              打开关联文档
            </button>
          </li>
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('translateDoc')}
            >
              翻译关联文档
            </button>
          </li>
          <DocSubmenu
            label="重绑文档路径"
            tree={docTree}
            disabled={disabled}
            onOpen={() => onAction('rebindDoc')}
            onPick={onPickDoc}
            onMenuEnter={onMenuEnter}
            onMenuLeave={onMenuLeave}
          />
          {menu.nodeKind === 'ai' ? (
            <>
              <li>
                <button
                  type="button"
                  className={styles.contextMenuItem}
                  onClick={() => onAction('chooseModel')}
                >
                  选择模型
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className={styles.contextMenuItem}
                  onClick={() => onAction(aiRunningHere ? 'cancelAi' : 'runAi')}
                >
                  {aiRunningHere ? '取消执行' : '执行'}
                </button>
              </li>
            </>
          ) : null}
          {menu.nodeKind === 'prompt' ? (
            <li>
              <button
                type="button"
                className={styles.contextMenuItem}
                disabled={disabled}
                onClick={() => onAction('editPrompt')}
              >
                编辑提示词
              </button>
            </li>
          ) : null}
          <li className={styles.contextMenuDivider} />
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('deleteNode')}
              disabled={disabled}
            >
              删除节点
            </button>
          </li>
        </>
      ) : null}
      {onEdge ? (
        <li>
          <button
            type="button"
            className={styles.contextMenuItem}
            onClick={() => onAction('deleteEdge')}
            disabled={disabled}
          >
            删除连线
          </button>
        </li>
      ) : null}
      {!onBlank && !onNode && !onEdge ? (
        <>
          <li>
            <button
              type="button"
              className={styles.contextMenuItem}
              onClick={() => onAction('addText')}
              disabled={disabled}
            >
              新建文本节点
            </button>
          </li>
        </>
      ) : null}
    </ul>
  );
}

export interface CanvasConnectionMenuProps {
  readonly menu: ConnectionMenuState;
  readonly onChooseText: () => void;
  readonly docTree: readonly TreeNode[];
  readonly onPickDoc: (path: string) => void;
  readonly readOnly: boolean;
  readonly onMenuEnter: () => void;
  readonly onMenuLeave: () => void;
}

/** N4：拉线落空菜单。选择后一次提交 addNode + addEdge，取消只清草稿。 */
export function CanvasConnectionMenu({
  menu,
  onChooseText,
  docTree,
  onPickDoc,
  readOnly,
  onMenuEnter,
  onMenuLeave,
}: CanvasConnectionMenuProps) {
  const style = { left: `${menu.x}px`, top: `${menu.y}px` };
  return (
    <ul
      className={styles.contextMenu}
      style={style}
      role="menu"
      onClick={(event) => event.stopPropagation()}
      onPointerMove={syncMenuHover}
      onPointerEnter={onMenuEnter}
      onPointerLeave={(event) => {
        clearMenuHover(event);
        onMenuLeave();
      }}
    >
      <li>
        <button
          type="button"
          className={styles.contextMenuItem}
          onClick={onChooseText}
          disabled={readOnly}
        >
          新建文本节点
        </button>
      </li>
      <DocSubmenu
        label="新建文档节点…"
        tree={docTree}
        disabled={readOnly}
        onPick={onPickDoc}
        onMenuEnter={onMenuEnter}
        onMenuLeave={onMenuLeave}
      />
    </ul>
  );
}

export interface CanvasEditOverlayProps {
  readonly editing: CanvasEditState;
  readonly rect: CanvasOverlayRect;
  readonly onCommitLabel: (label: string) => void;
  readonly onCommitPrompt: (text: string) => void;
  readonly onCancel: () => void;
}

/** C0-D：文本编辑输入框覆盖层。CR-20261121-53：kind='prompt' 渲染多行 textarea。 */
export function CanvasEditOverlay({
  editing,
  rect,
  onCommitLabel,
  onCommitPrompt,
  onCancel,
}: CanvasEditOverlayProps) {
  if (editing.kind === 'prompt') {
    return (
      <textarea
        autoFocus
        className={styles.editTextarea}
        defaultValue={editing.text ?? ''}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        onBlur={(e) => onCommitPrompt(e.target.value)}
        onKeyDown={(e) => {
          // IME 组合期间按键归输入法；Enter 换行，⌘/Ctrl+Enter 提交，Esc 取消。
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommitPrompt((e.target as HTMLTextAreaElement).value);
          }
        }}
      />
    );
  }
  return (
    <input
      autoFocus
      className={styles.editInput}
      defaultValue={editing.label}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      type="text"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => onCommitLabel(e.target.value)}
      onKeyDown={(e) => {
        // 中文输入法组合期间 Enter/Esc 属于选字/取消组合（WKWebView 同样派发）：
        // 不拦截会在组合中途提交并卸载输入框，正输入的文本随之丢失。
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommitLabel((e.target as HTMLInputElement).value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export interface CanvasModelPickerProps {
  readonly rect: CanvasOverlayRect;
  readonly choices: CanvasModelChoices;
  readonly value: string;
  readonly onPick: (model: string) => void;
  readonly onClose: () => void;
}

/** CR-20261121-53：AI 节点模型选择下拉（原生 select；Esc/失焦关闭，选中即写回节点）。 */
export function CanvasModelPicker({
  rect,
  choices,
  value,
  onPick,
  onClose,
}: CanvasModelPickerProps) {
  return (
    <select
      autoFocus
      className={styles.modelSelect}
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
      value={value}
      onBlur={() => onClose()}
      onChange={(e) => onPick(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <option value="" disabled>
        {choices.state === 'loading'
          ? '加载模型列表…'
          : choices.state === 'error'
            ? '模型列表加载失败（检查 AI 设置）'
            : '选择模型…'}
      </option>
      {choices.state === 'ready'
        ? choices.models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))
        : null}
    </select>
  );
}
