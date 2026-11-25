//! macOS 系统回收站：objc2 FFI 全部隔离在本文件（PLAN.md §10 X6）。
//!
//! 本模块只做一件事：把库内绝对路径交给 `NSFileManager.trashItemAtURL`。
//! 失败原因以字符串返回，调用方 `vault/trash.rs` 据此走库内降级。
//!
//! 安全边界：objc2 0.6 的 `NSFileManager` / `NSURL` / `NSError` 方法都是安全封装，
//! 空指针与对象生命周期由 `Retained<T>`（非空指针 + 引用计数）在类型层面保证，
//! 因此本文件**没有 `unsafe` 块**，也就没有需要逐块豁免的裸 FFI。
//! 若将来必须直接调用 `msg_send!`，每个 `unsafe` 块都要单独写明
//! 「谁保证指针非空 / 对象存活 / 线程正确」，并在此处登记。

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use objc2::rc::autoreleasepool;
use objc2_foundation::{NSError, NSFileManager, NSString, NSURL};

/// 把 `path` 移入系统废纸篓。成功返回 `Ok(())`，失败返回可读原因。
///
/// 三层防护：
/// 1. `NSError` 由 objc2 以 `Retained<NSError>` 返回，类型上不可能为空指针；
/// 2. `autoreleasepool` 兜住本次调用产生的 autorelease 对象，后台线程调用不泄漏；
/// 3. `catch_unwind` 兜住任何 Rust panic，转成 `Err` 交给上层降级，
///    绝不让宿主进程崩溃。
pub(crate) fn trash_item(path: &Path) -> Result<(), String> {
    let text = path.to_string_lossy().into_owned();
    let outcome = catch_unwind(AssertUnwindSafe(move || {
        autoreleasepool(|_pool| trash_item_inner(&text))
    }));
    match outcome {
        Ok(result) => result,
        Err(_) => Err("系统回收站调用异常（FFI panic），已转库内降级".to_string()),
    }
}

fn trash_item_inner(text: &str) -> Result<(), String> {
    let url = NSURL::fileURLWithPath(&NSString::from_str(text));
    // `resultingItemURL` 传 None：我们不需要废纸篓内的新位置，也不持有它。
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| describe(&error))
}

/// 安全提取 NSError 文案。
///
/// `Retained<NSError>` 与 `localizedDescription` 返回的 `Retained<NSString>`
/// 在类型层面保证非空且对象存活，解引用不会命中空指针或已释放内存。
/// 系统给出空文案时退回 `domain + code`，保证日志里永远有一句可读原因。
fn describe(error: &NSError) -> String {
    let message = error.localizedDescription().to_string();
    if message.trim().is_empty() {
        let domain = error.domain();
        let code = error.code();
        format!("{domain} 错误码 {code}")
    } else {
        message
    }
}
