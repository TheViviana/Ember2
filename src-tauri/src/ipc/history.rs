//! history IPC DTO（contract §III history，CR-20261119-21）。
//! 全部 camelCase 序列化；不引入新错误码（复用 §II 既有码）。

use serde::Serialize;

/// `history_list` 单条版本元数据；按时间升序返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersionDto {
    /// 版本 id = 快照文件名去 `.md`（26 字符 ULID）。
    pub version: String,
    /// 由 ULID 时间戳解码的 ISO 8601（UTC）。
    pub created_at: String,
    pub bytes: u64,
}

/// `history_read` 响应：版本全文 + 同源 sha256。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryReadDto {
    pub doc_id: String,
    pub version: String,
    pub text: String,
    pub sha256: String,
    pub bytes: u64,
    pub created_at: String,
}

/// `history_delete` 响应：是否实际删除。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDeleteDto {
    pub deleted: bool,
}

/// `history_purge` 响应：被删除的文件数。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPurgeDto {
    pub deleted: u32,
}
