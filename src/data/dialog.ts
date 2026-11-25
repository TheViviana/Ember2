/**
 * @tauri-apps/plugin-dialog 适配器（gate:layers —— @tauri-apps 仅 data 层可引）。
 * 宿主层（StatusBar 等）从此模块消费，不直引 @tauri-apps/plugin-dialog。
 */
import { open as tauriOpen } from '@tauri-apps/plugin-dialog';

/** 打开系统文件夹选择器。
 * @returns 选中的绝对路径；用户取消返回 null；抛错由调用方处理。 */
export async function openDirectory(): Promise<string | null> {
  const result: unknown = await tauriOpen({ directory: true, multiple: false });
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) {
    const first: unknown = result[0];
    return typeof first === 'string' ? first : null;
  }
  return typeof result === 'string' ? result : null;
}

/** 多选外部 Markdown；取消返回空数组。后端仍会逐项校验扩展名、UTF-8 与大小。 */
export async function openMarkdownFiles(): Promise<readonly string[]> {
  const result: unknown = await tauriOpen({
    directory: false,
    multiple: true,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result === null || result === undefined) return [];
  const values = Array.isArray(result) ? result : [result];
  return values.filter((value): value is string => typeof value === 'string');
}
