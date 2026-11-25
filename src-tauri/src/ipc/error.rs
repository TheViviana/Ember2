use std::io;

use serde::Serialize;
use thiserror::Error;

/// 契约错误码（docs/contract.md §II）。T1 先全部定义，未接线的码由测试守门。
pub const E_VAULT_LOCKED: &str = "E_VAULT_LOCKED";
pub const E_READONLY: &str = "E_READONLY";
pub const E_LOCK_LOST: &str = "E_LOCK_LOST";
pub const E_PATH_ESCAPE: &str = "E_PATH_ESCAPE";
pub const E_RESERVED_PATH: &str = "E_RESERVED_PATH";
pub const E_NOT_FOUND: &str = "E_NOT_FOUND";
pub const E_IO: &str = "E_IO";
pub const E_DISK_FULL: &str = "E_DISK_FULL";
pub const E_MEDIA_TYPE: &str = "E_MEDIA_TYPE";
pub const E_MEDIA_TOO_LARGE: &str = "E_MEDIA_TOO_LARGE";
pub const E_TRASH_FAILED: &str = "E_TRASH_FAILED";
pub const E_INVALID_ARG: &str = "E_INVALID_ARG";
pub const E_BAD_ID: &str = "E_BAD_ID";
pub const E_CONFLICT: &str = "E_CONFLICT";
pub const E_TOO_LARGE: &str = "E_TOO_LARGE";
pub const E_ENCODING: &str = "E_ENCODING";
pub const E_PERM: &str = "E_PERM";
pub const E_BACKUP_FAILED: &str = "E_BACKUP_FAILED";

/// `E_BACKUP_FAILED` 的根因类别（CR-20261116-02 §8.2.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupCause {
    Access,
    NoSpace,
    Io,
}

impl BackupCause {
    /// 只暴露类别，不暴露完整 errno。
    pub fn code(self) -> &'static str {
        match self {
            Self::Access => "EACCES",
            Self::NoSpace => "ENOSPC",
            Self::Io => "E_IO",
        }
    }

    /// EACCES / EPERM / EROFS 归入 `EACCES`；ENOSPC 单列；其余 `E_IO`。
    pub fn from_io(error: &io::Error) -> Self {
        match error.raw_os_error() {
            Some(1) | Some(13) | Some(30) => Self::Access,
            Some(28) => Self::NoSpace,
            _ if error.kind() == io::ErrorKind::PermissionDenied => Self::Access,
            _ => Self::Io,
        }
    }
}

/// 内核错误。`code()` 是 IPC 契约的一部分，改动必须同步 CR。
#[derive(Debug, Error)]
pub enum VaultError {
    #[error("库已被另一个实例占用")]
    VaultLocked,
    #[error("库当前为只读状态")]
    Readonly,
    #[error("库锁已丢失，写操作被拒绝")]
    LockLost,
    #[error("路径越出库范围")]
    PathEscape,
    #[error("路径命中保留名")]
    ReservedPath,
    #[error("目标不存在")]
    NotFound,
    #[error("I/O 失败：{0}")]
    Io(io::Error),
    #[error("磁盘空间不足")]
    DiskFull,
    #[error("媒体类型不受支持")]
    MediaType,
    #[error("媒体文件超过大小上限")]
    MediaTooLarge,
    #[error("移入回收站失败")]
    TrashFailed,
    #[error("{0}")]
    InvalidArg(String),
    #[error("画布 id 非法")]
    BadId,
    #[error("画布已被外部修改")]
    Conflict { current_sha: Option<String> },
    #[error("画布超过大小上限")]
    TooLarge,
    #[error("画布内容不是合法 UTF-8")]
    Encoding,
    #[error("权限不足")]
    Perm,
    #[error("画布备份失败")]
    BackupFailed { cause: BackupCause },
}

impl VaultError {
    /// 稳定错误码：前端只认这里，不解析 message 文案。
    pub fn code(&self) -> &'static str {
        match self {
            Self::VaultLocked => E_VAULT_LOCKED,
            Self::Readonly => E_READONLY,
            Self::LockLost => E_LOCK_LOST,
            Self::PathEscape => E_PATH_ESCAPE,
            Self::ReservedPath => E_RESERVED_PATH,
            Self::NotFound => E_NOT_FOUND,
            Self::Io(_) => E_IO,
            Self::DiskFull => E_DISK_FULL,
            Self::MediaType => E_MEDIA_TYPE,
            Self::MediaTooLarge => E_MEDIA_TOO_LARGE,
            Self::TrashFailed => E_TRASH_FAILED,
            Self::InvalidArg(_) => E_INVALID_ARG,
            Self::BadId => E_BAD_ID,
            Self::Conflict { .. } => E_CONFLICT,
            Self::TooLarge => E_TOO_LARGE,
            Self::Encoding => E_ENCODING,
            Self::Perm => E_PERM,
            Self::BackupFailed { .. } => E_BACKUP_FAILED,
        }
    }
}

impl From<io::Error> for VaultError {
    /// ENOSPC(28) 单列为可恢复的 `E_DISK_FULL`，其余统一 `E_IO`。
    fn from(error: io::Error) -> Self {
        if error.raw_os_error() == Some(28) {
            Self::DiskFull
        } else {
            Self::Io(error)
        }
    }
}

pub type VaultResult<T> = Result<T, VaultError>;

/// P1 共享错误载荷（docs/contract.md §II）：形状保持 `{ code, message }`，
/// 本 CR 不扩展该结构。画布的 `currentSha` / `cause` 走独立的
/// `ipc::canvas::CanvasErrorPayload`，只在画布命令边界使用。
#[derive(Debug, Clone, Serialize)]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
}

impl From<VaultError> for ErrorPayload {
    fn from(error: VaultError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    /// 覆盖全部已定义变体：新增变体而漏映射时此表会先红。
    #[test]
    fn every_variant_has_stable_code() {
        let cases: Vec<(VaultError, &str)> = vec![
            (VaultError::VaultLocked, E_VAULT_LOCKED),
            (VaultError::Readonly, E_READONLY),
            (VaultError::LockLost, E_LOCK_LOST),
            (VaultError::PathEscape, E_PATH_ESCAPE),
            (VaultError::ReservedPath, E_RESERVED_PATH),
            (VaultError::NotFound, E_NOT_FOUND),
            (VaultError::Io(io::Error::other("boom")), E_IO),
            (VaultError::DiskFull, E_DISK_FULL),
            (VaultError::MediaType, E_MEDIA_TYPE),
            (VaultError::MediaTooLarge, E_MEDIA_TOO_LARGE),
            (VaultError::TrashFailed, E_TRASH_FAILED),
            (VaultError::InvalidArg("bad".into()), E_INVALID_ARG),
            (VaultError::BadId, E_BAD_ID),
            (VaultError::Conflict { current_sha: None }, E_CONFLICT),
            (VaultError::TooLarge, E_TOO_LARGE),
            (VaultError::Encoding, E_ENCODING),
            (VaultError::Perm, E_PERM),
            (
                VaultError::BackupFailed {
                    cause: BackupCause::Access,
                },
                E_BACKUP_FAILED,
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(error.code(), expected, "错误码映射漂移");
            let payload: ErrorPayload = error.into();
            assert_eq!(payload.code, expected);
            assert!(!payload.message.is_empty());
        }
    }

    /// H1：P1 共享载荷形状固定为 `{ code, message }`。
    ///
    /// 即使错误本身携带 `current_sha` / `cause`，也不得出现在共享载荷里；
    /// 画布命令改用独立的 `ipc::canvas::CanvasErrorPayload`。
    #[test]
    fn shared_payload_stays_code_and_message_only() {
        let conflict: ErrorPayload = VaultError::Conflict {
            current_sha: Some("9f2c".into()),
        }
        .into();
        let json = serde_json::to_value(&conflict).expect("serialize");
        assert_eq!(json["code"], E_CONFLICT);
        assert!(json.get("currentSha").is_none(), "P1 载荷不得新增字段");
        assert!(json.get("cause").is_none(), "P1 载荷不得新增字段");
    }

    #[test]
    fn backup_cause_classifies_errno() {
        assert_eq!(
            BackupCause::from_io(&io::Error::from_raw_os_error(13)),
            BackupCause::Access
        );
        assert_eq!(
            BackupCause::from_io(&io::Error::from_raw_os_error(1)),
            BackupCause::Access
        );
        assert_eq!(
            BackupCause::from_io(&io::Error::from_raw_os_error(30)),
            BackupCause::Access
        );
        assert_eq!(
            BackupCause::from_io(&io::Error::from_raw_os_error(28)),
            BackupCause::NoSpace
        );
        assert_eq!(
            BackupCause::from_io(&io::Error::other("boom")),
            BackupCause::Io
        );
        assert_eq!(BackupCause::Access.code(), "EACCES");
        assert_eq!(BackupCause::NoSpace.code(), "ENOSPC");
        assert_eq!(BackupCause::Io.code(), "E_IO");
    }

    #[test]
    fn enospc_maps_to_disk_full() {
        let error: VaultError = io::Error::from_raw_os_error(28).into();
        assert_eq!(error.code(), E_DISK_FULL);
        let other: VaultError = io::Error::from_raw_os_error(13).into();
        assert_eq!(other.code(), E_IO);
    }
}
