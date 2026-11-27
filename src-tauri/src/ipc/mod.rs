pub mod backup;
pub mod canvas;
pub mod conflict;
pub mod doc;
pub mod error;
pub mod history;
pub mod media;
pub mod trash;
pub mod watch;

pub use error::{BackupCause, ErrorPayload, VaultError, VaultResult};

use serde::Serialize;

/// 只读原因：IPC 与前端文案映射共用，序列化为 camelCase。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadonlyReason {
    /// 另一实例正在使用（pid 存活）
    LockedByOther,
    /// 运行期锁丢失
    LockLost,
    /// 库所在位置不可写（只读卷/只读目录）：身份可读，但无法建锁与写入
    FilesystemReadonly,
}

/// `vault_identity` 的响应（docs/contract.md §III，T1 先落地字段）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIdentityDto {
    pub vault_id: String,
    pub root: String,
    pub schema_version: u32,
    pub readonly: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readonly_reason: Option<ReadonlyReason>,
}

/// `vault_constants` 的响应：所有数值单源在这里（contract I8）。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConstantsDto {
    pub max_doc_bytes: u64,
    pub max_image_bytes: u64,
    pub max_media_bytes: u64,
    pub history_keep: u32,
    pub history_budget_bytes: u64,
    pub trash_retention_days: u32,
    pub watcher_debounce_ms: u64,
    pub max_scan_depth: u32,
}
