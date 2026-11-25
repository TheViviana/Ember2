/**
 * R4-1：壳层通知渲染（notice 队列 + 平铺提示 + 关窗守卫错误）。
 * 纯展示组件：不订阅 store、不持有状态，关闭动作由 onDismiss 回传。
 */
import type { NoticeItem } from '../stores/notice-store';
import { NoticeIcon } from '../../features/notice/NoticeIcon';

export interface ShellNoticesProps {
  readonly items: ReadonlyArray<NoticeItem>;
  readonly tileHint: string | null;
  readonly guardError: string | null;
  readonly closeError: string | null;
  readonly onDismiss: (id: number) => void;
}

export function ShellNotices({
  items,
  tileHint,
  guardError,
  closeError,
  onDismiss,
}: ShellNoticesProps) {
  return (
    <>
      {items.map((item) => {
        const prefix = item.tone === 'error' ? '错误：' : item.tone === 'warning' ? '注意：' : '';
        const message = prefix !== '' && !item.message.startsWith(prefix) ? prefix + item.message : item.message;
        return (
          <div key={item.id} className={`app-notice app-notice--${item.tone}`} role="alert">
            <span className="app-notice-icon" aria-hidden="true"><NoticeIcon tone={item.tone} /></span>
            <span className="app-notice-message">{message}</span>
            <button type="button" className="app-notice-dismiss" onClick={() => onDismiss(item.id)} aria-label="关闭提示">
              ×
            </button>
          </div>
        );
      })}
      {tileHint !== null ? <p className="app-notice app-notice--info" role="status">{tileHint}</p> : null}
      {guardError !== null ? <p className="app-notice app-notice--warning" role="alert">{guardError}</p> : null}
      {closeError !== null ? <p className="app-notice app-notice--error" role="alert">{closeError}</p> : null}
    </>
  );
}
