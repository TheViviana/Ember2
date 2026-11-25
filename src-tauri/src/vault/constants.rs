use crate::ipc::VaultConstantsDto;

/// 文档写入上限（16 MiB，vault-format §2）。
pub const MAX_DOC_BYTES: u64 = 16 * 1024 * 1024;
/// 单张图片上限（20 MiB）。
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
/// 单份音视频上限（500 MiB）。
pub const MAX_MEDIA_BYTES: u64 = 500 * 1024 * 1024;
/// 历史保留份数。
pub const HISTORY_KEEP: u32 = 20;
/// 历史总量预算（64 MiB）。
pub const HISTORY_BUDGET_BYTES: u64 = 64 * 1024 * 1024;
/// 回收站保留天数。
pub const TRASH_RETENTION_DAYS: u32 = 7;
/// watcher 防抖窗口（500 ms）。
pub const WATCHER_DEBOUNCE_MS: u64 = 500;
/// 扫描最大深度。
pub const MAX_SCAN_DEPTH: u32 = 32;

/// 常量单源快照：前端不重复维护数值（contract I8 / B8）。
pub fn snapshot() -> VaultConstantsDto {
    VaultConstantsDto {
        max_doc_bytes: MAX_DOC_BYTES,
        max_image_bytes: MAX_IMAGE_BYTES,
        max_media_bytes: MAX_MEDIA_BYTES,
        history_keep: HISTORY_KEEP,
        history_budget_bytes: HISTORY_BUDGET_BYTES,
        trash_retention_days: TRASH_RETENTION_DAYS,
        watcher_debounce_ms: WATCHER_DEBOUNCE_MS,
        max_scan_depth: MAX_SCAN_DEPTH,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_match_contract() {
        let values = snapshot();
        assert_eq!(values.max_doc_bytes, 16 * 1024 * 1024);
        assert_eq!(values.max_image_bytes, 20 * 1024 * 1024);
        assert_eq!(values.max_media_bytes, 500 * 1024 * 1024);
        assert_eq!(values.history_keep, 20);
        assert_eq!(values.history_budget_bytes, 64 * 1024 * 1024);
        assert_eq!(values.trash_retention_days, 7);
        assert_eq!(values.watcher_debounce_ms, 500);
        assert_eq!(values.max_scan_depth, 32);
    }
}
