/**
 * CR-R1-5：Windows 保留设备名清单与判定的 core 单一真源。
 *
 * - 保留设备名清单：22 项（CON/PRN/AUX/NUL + COM1-9 + LPT1-9），与备份名白名单原表逐项一致；
 * - isReservedDeviceName：按首个点之前的 stem 判，大小写不敏感（CON.txt / COM1.log 同样命中）。
 */

/** Windows 保留设备名（22 项，顺序与原备份名白名单一致）。 */
export const WINDOWS_RESERVED_NAMES: readonly string[] = Object.freeze([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/** 是否 Windows 保留设备名：取首个点前的 stem，大小写不敏感比较。 */
export function isReservedDeviceName(name: string): boolean {
  const stem = (name.split('.')[0] ?? '').toUpperCase();
  return WINDOWS_RESERVED_NAMES.includes(stem);
}
