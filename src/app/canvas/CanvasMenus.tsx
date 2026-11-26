/**
 * CR-R4-2：画布菜单与编辑浮层的纯展示组件。
 *
 * 只接收锚点、菜单项数据与回调，不读 store、不碰 engine；定位所需的世界坐标
 * 换算由 CanvasView 完成后以 rect 传入。
 */
import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasEngineEvent } from './engine.ts';
import type { TreeNode } from '../tree/build-tree.ts';
import { DocSubmenu } from './DocSubmenu.tsx';
import { docSubmenuRegistry } from './doc-submenu-model.ts';
import { canvasTextEditKeyAction } from './canvas-interactions.ts';
import { useMenuKeyboard } from './use-menu-keyboard.ts';
import { Icon } from '../../ui/icon.tsx';
import styles from './CanvasView.module.css';

/** C0-D：右键菜单状态。 */
export interface CanvasMenu {
  readonly x: number;
  readonly y: number;
  readonly target: CanvasEngineEvent;
  /** CR-20261121-45 项D：右键命中节点为文档时的路径/标题（null=非文档节点）。 */
  readonly nodeDocPath: string | null;
  readonly nodeLabel: string | null;
  /** 原始节点类型：用于区分文本正文编辑与独立标题改名。 */
  readonly nodeType: string | null;
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

/** C0-D：文本编辑状态。kind='text' 编辑自由文本；kind='prompt' 编辑提示词；其余为节点标题。 */
export interface CanvasEditState {
  readonly nodeId: string;
  readonly nodeX: number;
  readonly nodeY: number;
  readonly label: string;
  readonly kind?: 'text' | 'prompt';
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
  readonly fontSize?: number;
  readonly title?: boolean;
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

/**
 * §8.1：禁用项在行右侧给出原因。禁用按钮不派发鼠标事件，title 在 WKWebView
 * 下不可靠，因此用常驻文案而不是 tooltip。
 */
function MenuNote({ reason }: { readonly reason: string | undefined }) {
  return reason === undefined ? null : <span className={styles.menuNote}>{reason}</span>;
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
  readonly onClose: () => void;
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
  onClose,
}: CanvasContextMenuProps) {
  const tgt = menu.target;
  const onBlank = tgt.kind === 'contextMenu' && tgt.target.kind === 'blank';
  const onNode = tgt.kind === 'contextMenu' && tgt.target.kind === 'node';
  const onEdge = tgt.kind === 'contextMenu' && tgt.target.kind === 'edge';
  const style = { left: `${menu.x}px`, top: `${menu.y}px` };
  const disabled = readOnly;
  const disabledReason = disabled ? '只读' : undefined;
  const { ref: menuRef, onKeyDown } = useMenuKeyboard(onClose);
  // CR-20261121-53：右键命中的 AI 节点是否正在执行（菜单项在「执行/取消执行」间切换）。
  const aiRunningHere = runningAiNodeId !== null && onNode && tgt.target.id === runningAiNodeId;

  return (
    <ul
      ref={menuRef}
      className={styles.contextMenu}
      style={style}
      role="menu"
      onKeyDown={onKeyDown}
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
              role="menuitem"
              className={styles.contextMenuItem}
              onClick={() => onAction('addText')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <Icon size={12} viewBox="0 0 12 12">
                  <path d="M2 3h8M2 6h8M2 9h5" />
                </Icon>
              </span>
              新建文本节点
              {disabled ? (
                <MenuNote reason={disabledReason} />
              ) : (
                <span className={styles.menuAccelerator}>{accelerators.addText ?? ''}</span>
              )}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuItem}
              onClick={() => onAction('addAi')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <Icon size={12}>
                  <path d="M10.5 3.5A2.3 2.3 0 0 0 8.2 5.6 2.3 2.3 0 0 0 6.3 8.7a2.3 2.3 0 0 0 .5 4.2A2.3 2.3 0 0 0 9 17h1.5v-13.5Z" />
                  <path d="M13.5 3.5A2.3 2.3 0 0 1 15.8 5.6 2.3 2.3 0 0 1 17.7 8.7a2.3 2.3 0 0 1-.5 4.2A2.3 2.3 0 0 1 15 17h-1.5v-13.5Z" />
                  <path d="M10.5 17v1.5a1.5 1.5 0 0 0 3 0V17" />
                </Icon>
              </span>
              新建 AI 节点
              {disabled ? (
                <MenuNote reason={disabledReason} />
              ) : (
                <span className={styles.menuAccelerator}>{accelerators.addAi ?? ''}</span>
              )}
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuItem}
              onClick={() => onAction('createArticle')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <Icon size={12} viewBox="0 0 12 12">
                  <path d="M2.5 1.5h5L10 4v6.5H2.5Z" />
                  <path d="M7.5 1.5V4H10M4 7h4M4 9h2.5" />
                </Icon>
              </span>
              创建新文章
              <MenuNote reason={disabledReason} />
            </button>
          </li>
          {/* CR-20261121-58：新建操作与分类区之间分组线 */}
          <li className={styles.contextMenuDivider} />
          <DocSubmenu
            label="新建文档节点"
            tree={docTree}
            disabled={disabled}
            disabledReason={disabledReason}
            onOpen={() => onAction('addDocument')}
            onPick={onPickDoc}
            onMenuEnter={onMenuEnter}
            onMenuLeave={onMenuLeave}
          />
          <DocSubmenu
            label="媒体库"
            tree={mediaTree}
            disabled={disabled}
            disabledReason={disabledReason}
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
                role="menuitem"
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
              role="menuitem"
              className={styles.contextMenuItem}
              onClick={() => onAction('openDoc')}
            >
              打开关联文档
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
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
            disabledReason={disabledReason}
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
                  role="menuitem"
                  className={styles.contextMenuItem}
                  onClick={() => onAction('chooseModel')}
                >
                  选择模型
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
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
                role="menuitem"
                className={styles.contextMenuItem}
                disabled={disabled}
                onClick={() => onAction('editPrompt')}
              >
                编辑提示词
                <MenuNote reason={disabledReason} />
              </button>
            </li>
          ) : null}
          <li>
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuItem}
              disabled={disabled}
              onClick={() => onAction(menu.nodeType === 'text' ? 'editText' : 'editLabel')}
            >
              {menu.nodeType === 'text' ? '编辑文本' : '修改标题'}
              <MenuNote reason={disabledReason} />
            </button>
          </li>
          <li className={styles.contextMenuDivider} />
          <li>
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuItem}
              data-variant="danger"
              onClick={() => onAction('deleteNode')}
              disabled={disabled}
            >
              <span className={styles.menuIcon} aria-hidden="true">
                <Icon size={12} viewBox="0 0 12 12">
                  <path d="M2 3h8M4.5 3V2h3v1M3 3l.5 7h5L9 3" />
                </Icon>
              </span>
              删除节点
              <MenuNote reason={disabledReason} />
            </button>
          </li>
        </>
      ) : null}
      {onEdge ? (
        <li>
          <button
            type="button"
            role="menuitem"
            className={styles.contextMenuItem}
            data-variant="danger"
            onClick={() => onAction('deleteEdge')}
            disabled={disabled}
          >
            <span className={styles.menuIcon} aria-hidden="true">
              <Icon size={12} viewBox="0 0 12 12">
                <path d="M2 3h8M4.5 3V2h3v1M3 3l.5 7h5L9 3" />
              </Icon>
            </span>
            删除连线
            <MenuNote reason={disabledReason} />
          </button>
        </li>
      ) : null}
      {!onBlank && !onNode && !onEdge ? (
        <>
          <li>
            <button
              type="button"
              role="menuitem"
              className={styles.contextMenuItem}
              onClick={() => onAction('addText')}
              disabled={disabled}
            >
              新建文本节点
              <MenuNote reason={disabledReason} />
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
  readonly onChooseAi: () => void;
  /** 用户 2026-11-23：直接新建空文章（库根）并连边。 */
  readonly onChooseArticle: () => void;
  readonly docTree: readonly TreeNode[];
  readonly onPickDoc: (path: string) => void;
  readonly readOnly: boolean;
  readonly onMenuEnter: () => void;
  readonly onMenuLeave: () => void;
  readonly onClose: () => void;
}

/** N4：拉线落空菜单。选择后一次提交 addNode + addEdge，取消只清草稿。 */
export function CanvasConnectionMenu({
  menu,
  onChooseText,
  onChooseAi,
  onChooseArticle,
  docTree,
  onPickDoc,
  readOnly,
  onMenuEnter,
  onMenuLeave,
  onClose,
}: CanvasConnectionMenuProps) {
  const style = { left: `${menu.x}px`, top: `${menu.y}px` };
  const disabledReason = readOnly ? '只读' : undefined;
  const { ref: menuRef, onKeyDown } = useMenuKeyboard(onClose);
  return (
    <ul
      ref={menuRef}
      className={styles.contextMenu}
      style={style}
      role="menu"
      onKeyDown={onKeyDown}
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
          role="menuitem"
          className={styles.contextMenuItem}
          onClick={onChooseText}
          disabled={readOnly}
        >
          新建文本节点
          <MenuNote reason={disabledReason} />
        </button>
      </li>
      <li>
        <button
          type="button"
          role="menuitem"
          className={styles.contextMenuItem}
          onClick={onChooseArticle}
          disabled={readOnly}
        >
          创建新文章
          <MenuNote reason={disabledReason} />
        </button>
      </li>
      <li>
        <button
          type="button"
          role="menuitem"
          className={styles.contextMenuItem}
          onClick={onChooseAi}
          disabled={readOnly}
        >
          新建 AI 节点
          <MenuNote reason={disabledReason} />
        </button>
      </li>
      <DocSubmenu
        label="新建文档节点…"
        tree={docTree}
        disabled={readOnly}
        disabledReason={disabledReason}
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
  readonly onCommitText: (text: string) => void;
  readonly onCommitPrompt: (text: string) => void;
  readonly onCancel: () => void;
}

/** C0-D：文本编辑输入框覆盖层。CR-20261121-53：kind='prompt' 渲染多行 textarea。 */
export function CanvasEditOverlay({
  editing,
  rect,
  onCommitLabel,
  onCommitText,
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
  if (editing.kind === 'text') {
    return (
      <textarea
        autoFocus
        aria-label="编辑文本节点"
        className={`${styles.editTextarea} ${styles.editNodeText}`}
        defaultValue={editing.label}
        style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        onFocus={(event) => event.currentTarget.setSelectionRange(0, 0)}
        onBlur={(event) => onCommitText(event.currentTarget.value)}
        onKeyDown={(event) => {
          const action = canvasTextEditKeyAction(event.nativeEvent);
          if (action === 'newline') {
            event.preventDefault();
            const target = event.currentTarget;
            target.setRangeText('\n', target.selectionStart, target.selectionEnd, 'end');
          } else if (action === 'cancel') {
            event.preventDefault();
            onCancel();
          } else if (action === 'submit') {
            event.preventDefault();
            onCommitText(event.currentTarget.value);
          }
        }}
      />
    );
  }
  return (
    <input
      autoFocus
      className={`${styles.editInput} ${rect.title === true ? styles.editTitleInput : ''}`}
      defaultValue={editing.label}
      aria-label="修改节点标题"
      style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height, fontSize: rect.fontSize }}
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

export interface CanvasModelMenuProps {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly maxHeight: number;
  readonly choices: CanvasModelChoices;
  readonly value: string;
  readonly onPick: (model: string) => void;
  readonly onClose: () => void;
}

/**
 * 2026-11-23：AI 节点原位模型下拉。
 *
 * 旧实现是铺满整颗节点的原生 select，用户看到的是「整个 AI 节点变成了选择窗口」。
 * 现在菜单锚定在模型框下方（空间不足时翻到上方），点击模型框即可展开；点外部/Esc 关闭。
 */
export function CanvasModelMenu({
  left,
  top,
  width,
  maxHeight,
  choices,
  value,
  onPick,
  onClose,
}: CanvasModelMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menuRef.current?.contains(target) === true) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className={styles.modelMenu}
      style={{ left, top, width, maxHeight }}
      role="listbox"
      aria-label="选择模型"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {choices.state === 'loading' ? (
        <p className={styles.modelHint}>加载模型列表…</p>
      ) : choices.state === 'error' ? (
        <p className={styles.modelHint}>模型列表加载失败（检查 AI 设置）</p>
      ) : choices.models.length === 0 ? (
        <p className={styles.modelHint}>暂无可用模型（检查 AI 设置）</p>
      ) : (
        <>
          <button
            type="button"
            role="option"
            aria-selected={value === ''}
            className={styles.modelOption}
            data-selected={value === '' ? 'true' : 'false'}
            onClick={() => onPick('')}
          >
            <span>不选择模型</span>
            <span className={styles.modelCheck} aria-hidden="true">✓</span>
          </button>
          {choices.models.map((model) => (
            <button
              key={model}
              type="button"
              role="option"
              aria-selected={value === model}
              className={styles.modelOption}
              data-selected={value === model ? 'true' : 'false'}
              onClick={() => onPick(model)}
            >
              <span>{model}</span>
              <span className={styles.modelCheck} aria-hidden="true">✓</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
