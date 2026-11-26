//! Windows 系统回收站：FFI 全部隔离在本文件（与 `vault/macos.rs` 对称）。
//!
//! 本模块只做一件事：把库内绝对路径交给 Shell 的 `SHFileOperationW`
//! （`FO_DELETE` + `FOF_ALLOWUNDO`）。成功即进回收站；失败原因以字符串返回，
//! 调用方 `vault/trash.rs` 据此走库内降级。
//!
//! 安全边界：
//! - `SHFILEOPSTRUCTW` 布局由 windows-sys 按真实 ABI 定义（x86 / x64 各一份），
//!   本文件不手写结构体，也不猜字段偏移；
//! - `pFrom` 指向本函数栈帧内持有的双 NUL 结尾宽字符缓冲，`SHFileOperationW`
//!   同步返回前该缓冲始终存活，不会被移动或释放；
//! - 其余指针字段经 `zeroed` 置空：Shell 接受空 `hwnd` / `pTo`。

use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows_sys::Win32::UI::Shell::{
    SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
    SHFILEOPSTRUCTW,
};

/// 把 `path` 移入系统回收站。成功返回 `Ok(())`，失败返回可读原因。
pub(crate) fn trash_item(path: &Path) -> Result<(), String> {
    // `pFrom` 是「多路径」格式：路径之间用 NUL 分隔，整体再以一个 NUL 结尾。
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    if from.contains(&0) {
        // 路径里出现 NUL 只可能来自非法输入；截断后可能删到别的文件，直接拒绝。
        return Err("路径含有 NUL 字符".to_string());
    }
    from.extend([0, 0]);

    // SAFETY: `op` 先全零初始化（裸指针全空，对 SHFILEOPSTRUCTW 是合法值），
    // 随后只填写本函数已校验的字段；`from` 与 `op` 同处一个栈帧，
    // SHFileOperationW 是同步调用，返回前 `from` 不会被释放或移动。
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16;
    // SAFETY: 同上，`op` 的指针字段均指向本栈帧内有效数据或为空。
    let code = unsafe { SHFileOperationW(&mut op) };
    if code != 0 {
        return Err(format!("SHFileOperationW 失败，代码 {code}"));
    }
    if op.fAnyOperationsAborted != 0 {
        return Err("回收站操作被中止".to_string());
    }
    Ok(())
}
