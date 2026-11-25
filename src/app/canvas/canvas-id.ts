import { isReservedDeviceName } from '../../core/reserved-names.ts';

export const CANVAS_ID_MAX_LENGTH = 64;

/** 与 Rust canvas.rs 一致：ASCII 白名单、1..64 字符、非 Windows 保留设备名。 */
export function validateCanvasId(
  id: string,
): { ok: true } | { ok: false; reason: 'charset' | 'length' | 'reserved' } {
  if (id.length > CANVAS_ID_MAX_LENGTH) return { ok: false, reason: 'length' };
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) return { ok: false, reason: 'charset' };
  if (isReservedDeviceName(id)) return { ok: false, reason: 'reserved' };
  return { ok: true };
}
