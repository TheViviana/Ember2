/**
 * CR-20261122-61：`vault://trash-sweep` 启动清扫报告 → 通知文案（纯函数）。
 *
 * 全量审查发现后端启动清扫事件（vault/trash.rs sweep → SWEEP_EVENT 广播）此前
 * 无任何前端消费者，报告被静默丢弃（onTrashSweep 零引用）。用户裁定：接入通知
 * 系统——有跳过/失败/移除才提示，无变化静默；AppShell 只做订阅与推送。
 */
import type { NoticeTone } from '../stores/notice-store';
import type { SweepReportDto } from '../../types/ipc';

export interface SweepNotice {
  readonly message: string;
  readonly tone: NoticeTone;
}

/** `skipped` 非空表示清扫整轮未执行的库级原因（vault/trash.rs：只读态 / 写队列被占用）。 */
const SKIP_REASON: Record<Exclude<SweepReportDto['skipped'], null>, string> = {
  readonly: '库只读',
  busy: '写队列忙',
};

export function formatSweepNotice(report: SweepReportDto): SweepNotice | null {
  if (report.skipped !== null) {
    return { message: `回收站清扫未执行：${SKIP_REASON[report.skipped]}`, tone: 'warning' };
  }
  if (report.errors.length > 0) {
    return {
      message: `回收站清扫完成：移除 ${report.removed.length} 项，失败 ${report.errors.length} 项`,
      tone: 'warning',
    };
  }
  if (report.removed.length > 0) {
    return { message: `回收站清扫完成：移除 ${report.removed.length} 项`, tone: 'info' };
  }
  return null;
}
