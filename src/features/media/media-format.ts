/**
 * CR-20261119-23：媒体库格式化纯函数（零 React / 零 IPC / 零 app / 零 data）。
 * 与 features/backup 的字节格式化同规格（1024 进制、1 位小数、<1KiB 显示 B）。
 */

const BYTE_UNITS: readonly string[] = Object.freeze(['B', 'KiB', 'MiB', 'GiB', 'TiB']);

/** 字节格式化：非有限 / 负数一律显示 `0 B`，绝不抛错。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) return `${Math.round(value)} B`;
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/** epoch 毫秒 → 本地可读 `YYYY-MM-DD HH:mm:ss`；非法输入原样标记，不抛错。 */
export function formatTime(modifiedMs: number): string {
  if (!Number.isFinite(modifiedMs) || modifiedMs < 0) return '—';
  const parsed = new Date(modifiedMs);
  if (Number.isNaN(parsed.getTime())) return '—';
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const y = String(parsed.getFullYear()).padStart(4, '0');
  return `${y}-${p2(parsed.getMonth() + 1)}-${p2(parsed.getDate())} ${p2(parsed.getHours())}:${p2(parsed.getMinutes())}:${p2(parsed.getSeconds())}`;
}
