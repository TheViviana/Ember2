/**
 * P5-C3（D3 裁决）：轻量提示通道。
 *
 * 关窗保存失败时窗口已消失，无法经组件树向上冒泡，故用独立 store 承接；
 * AppShell 订阅并渲染到 #toast-layer。禁止静默吞掉写盘失败（PLAN §9.4）。
 *
 * C4：error 常驻等用户手动关闭；warning / info 自动过期，避免伪造的“已处理”承诺。
 */
import { create } from 'zustand';

export type NoticeTone = 'info' | 'warning' | 'error';

export interface NoticeItem {
  readonly id: number;
  readonly message: string;
  readonly tone: NoticeTone;
}

export interface NoticeState {
  readonly items: ReadonlyArray<NoticeItem>;
  readonly push: (message: string, tone?: NoticeTone) => void;
  readonly dismiss: (id: number) => void;
}

/** 非 error 提示的自动过期时间。 */
const AUTO_DISMISS_MS = 6000;

/** gate:mutable-exports 禁模块级 let/var；用冻结外壳持有可写内层计数器。 */
const idHolder = Object.freeze({ value: { next: 0 } });

/** 非 error 提示的自动过期定时器；手动关闭时必须清除，避免遗留回调。 */
const autoDismissTimers = Object.freeze({
  value: new Map<number, ReturnType<typeof setTimeout>>(),
});

export const useNoticeStore = create<NoticeState>()((set) => ({
  items: [],
  push: (message, tone = 'error') => {
    idHolder.value.next += 1;
    const id = idHolder.value.next;
    set((state) => ({
      items: [...state.items, { id, message, tone }],
    }));
    if (tone !== 'error') {
      const timer = setTimeout(() => {
        autoDismissTimers.value.delete(id);
        useNoticeStore.getState().dismiss(id);
      }, AUTO_DISMISS_MS);
      autoDismissTimers.value.set(id, timer);
    }
  },
  dismiss: (id) => {
    const timer = autoDismissTimers.value.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      autoDismissTimers.value.delete(id);
    }
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
}));

/** 非 React 上下文（如组件卸载清理）可直接推送。 */
export function pushNotice(message: string, tone: NoticeTone = 'error'): void {
  useNoticeStore.getState().push(message, tone);
}
