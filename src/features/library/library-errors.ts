/**
 * CR-20261119-14：Rust 错误码 → UI 内联提示文案——纯函数。
 *
 * 来自 src-tauri/src/vault/library.rs 边界行为 + docs/contract.md §library：
 *   - E_INVALID_ARG：重复路径 / 互相嵌套 / 必须绝对路径 / 当前库禁删
 *   - E_NOT_FOUND：路径不存在 / 不是目录
 *   - 其余 → 通用 fallback
 *
 * 只做「库内联提示」场景（添加库表单、移除确认），全局 notice 由 app 层处理。
 */

export interface IpcErrorLike {
  readonly code: string;
  readonly message: string;
}

/** library_add / library_remove 失败时的内联提示（不 pushNotice）。 */
export function mapLibraryIpcError(err: IpcErrorLike): string {
  switch (err.code) {
    case 'E_INVALID_ARG':
      return mapInvalidArgMessage(err.message);
    case 'E_NOT_FOUND':
      return '目录不存在，请确认路径正确';
    case 'E_IO':
      return '无法访问目录（可能无权限）';
    case 'E_DISK_FULL':
      return '磁盘空间不足';
    default:
      return `操作失败：${err.message}`;
  }
}

function mapInvalidArgMessage(raw: string): string {
  const msg = raw.toLowerCase();
  if (msg.includes('已经在库列表中') || msg.includes('已在库列表中')) {
    return '该目录已注册';
  }
  if (msg.includes('不能互相嵌套') || msg.includes('互相嵌套')) {
    return '库目录不能嵌套在已有库中';
  }
  if (msg.includes('必须是绝对路径') || msg.includes('绝对路径')) {
    return '请输入绝对路径（以 / 开头）';
  }
  if (msg.includes('不能移除当前库') || msg.includes('当前库')) {
    return '不能移除当前使用的库';
  }
  if (msg.includes('已注册') && msg.includes('vaultid')) {
    return '该目录已是已注册的库（vaultId 重复）';
  }
  return raw;
}
