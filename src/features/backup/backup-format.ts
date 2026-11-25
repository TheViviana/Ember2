/**
 * CR-20261119-22：备份展示格式化（纯函数，非法输入不抛错）。
 *
 * - formatBytes：1024 进制，保留 1 位小数；< 1 KiB 显示 B；
 * - formatTime：ISO 8601 → 本地可读 `YYYY-MM-DD HH:mm:ss`；解析失败原样返回（A2 钉子）。
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

/** 时间格式化：非法 ISO 串原样返回，不抛错。 */
export function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const y = String(parsed.getFullYear()).padStart(4, '0');
  const mo = p2(parsed.getMonth() + 1);
  const d = p2(parsed.getDate());
  const h = p2(parsed.getHours());
  const mi = p2(parsed.getMinutes());
  const s = p2(parsed.getSeconds());
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
