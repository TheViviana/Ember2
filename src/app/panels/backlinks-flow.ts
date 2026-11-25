/**
 * CR-R4-4：反向链接编排（依赖注入，零 React / 零 IPC）。
 *
 * 「读全库 → 建索引」由 ensureIndex 惰性触发；本模块只负责触发构建，
 * 并把订阅到的索引状态折成面板状态，组件不再自带计算逻辑。
 */
import type { LinkIndex, LinkIndexEntry } from '../../core/link-index.ts';
import type { BacklinksState } from '../../editor/BacklinksPanel.tsx';

export type LinkIndexStatus = 'idle' | 'building' | 'ready' | 'error';

export interface BacklinksFlowDeps {
  readonly ensureIndex: () => void;
  readonly getIndex: () => LinkIndex | null;
  readonly backlinksOf: (index: LinkIndex, path: string) => readonly LinkIndexEntry[];
}

export interface BacklinksFlow {
  /** 用户点击「建立索引」：幂等触发后台全库读取。 */
  readonly build: () => void;
  /** status 由组件订阅传入；building / error 文案与既有行为一致。 */
  readonly stateFor: (status: LinkIndexStatus, path: string) => BacklinksState;
}

export function createBacklinksFlow(deps: BacklinksFlowDeps): BacklinksFlow {
  const { ensureIndex, getIndex, backlinksOf } = deps;

  const build = (): void => {
    ensureIndex();
  };

  const stateFor = (status: LinkIndexStatus, path: string): BacklinksState => {
    if (status === 'building') return { status: 'building', items: [], error: null };
    if (status === 'error') return { status: 'error', items: [], error: '建立链接索引失败' };
    const index = getIndex();
    if (index === null) return { status: 'idle', items: [], error: null };
    return {
      status: 'ready',
      items: backlinksOf(index, path).map((entry) => ({ path: entry.path, title: entry.title })),
      error: null,
    };
  };

  return Object.freeze({ build, stateFor });
}
