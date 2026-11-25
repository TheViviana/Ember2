/**
 * 编辑模式格式工具栏：按钮只产出 FormatActionId，由 EditorView 应用到当前选区。
 */
import type { FormatActionId } from './format-actions.ts';
import styles from './EditorView.module.css';

interface ToolbarItem {
  readonly id: FormatActionId;
  readonly label: string;
  readonly title: string;
}

interface ToolbarGroup {
  readonly key: string;
  readonly items: readonly ToolbarItem[];
}

const GROUPS: readonly ToolbarGroup[] = Object.freeze([
  {
    key: 'inline',
    items: [
      { id: 'bold', label: 'B', title: '加粗（**文字**）' },
      { id: 'italic', label: 'I', title: '斜体（*文字*）' },
      { id: 'strike', label: 'S', title: '删除线（~~文字~~）' },
      { id: 'inlineCode', label: '</>', title: '行内代码' },
      { id: 'math', label: '∑', title: '行内公式（$…$）' },
      { id: 'link', label: '🔗', title: '链接' },
    ],
  },
  {
    key: 'block',
    items: [
      { id: 'h1', label: 'H1', title: '一级标题' },
      { id: 'h2', label: 'H2', title: '二级标题' },
      { id: 'h3', label: 'H3', title: '三级标题' },
      { id: 'bulletList', label: '•', title: '无序列表' },
      { id: 'orderedList', label: '1.', title: '有序列表' },
      { id: 'task', label: '☐', title: '任务列表' },
      { id: 'quote', label: '❝', title: '引用' },
      { id: 'table', label: '▦', title: '表格' },
    ],
  },
]);

export interface EditorToolbarProps {
  readonly disabled: boolean;
  readonly onAction: (action: FormatActionId) => void;
}

export function EditorToolbar({ disabled, onAction }: EditorToolbarProps) {
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="格式工具栏">
      {GROUPS.map((group) => (
        <div key={group.key} className={styles.toolbarGroup}>
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={styles.toolbarButton}
              title={item.title}
              aria-label={item.title}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onAction(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
