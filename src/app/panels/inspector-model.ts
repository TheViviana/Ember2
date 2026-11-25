/**
 * 右侧面板的纯展示计算：保存阶段、字数、修改时间。
 * 不依赖 React 与 core 实例，便于在 Node 环境单测。
 */

export type SavePhase = 'clean' | 'dirty' | 'saving' | 'error';

export function saveLabel(phase: SavePhase): string {
  switch (phase) {
    case 'clean':
      return '已保存';
    case 'dirty':
      return '未保存';
    case 'saving':
      return '正在保存';
    default:
      return '保存失败';
  }
}

export interface SavePhaseInput {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly error: unknown;
}

/** 失败优先于进行中，避免“正在保存”掩盖上一次写盘错误。 */
export function savePhase(doc: SavePhaseInput | null): SavePhase | null {
  if (doc === null) return null;
  if (doc.error !== null) return 'error';
  if (doc.saving) return 'saving';
  if (doc.dirty) return 'dirty';
  return 'clean';
}

/** 字数按非空白码点统计，中文与 emoji 均记 1。 */
export function countCharacters(text: string): number {
  return Array.from(text.replace(/\s+/g, '')).length;
}

const MODIFIED_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatModified(ms: number): string {
  if (!(ms > 0)) return '—';
  return MODIFIED_FORMAT.format(ms);
}
