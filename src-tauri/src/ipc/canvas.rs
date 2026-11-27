//! 画布命令的返回 DTO（CR-20261116-02 §3）。
//!
//! 只做序列化形状，不承载业务逻辑；路径一律相对库根的 POSIX 字符串。

use serde::Serialize;

use crate::ipc::{ErrorPayload, VaultError};
use crate::vault::canvas::{CanvasEntry, ReadCanvas, WriteCanvas};

/// 画布命令专用的错误载荷（CR-20261116-02 §5.2，H1 方案 A）。
///
/// P1 共享 `ErrorPayload` 保持 `{ code, message }` 零改动；本结构只在
/// `canvas_read` / `canvas_write` 的 IPC 边界使用。两个扩展字段都用
/// `skip_serializing_if`，不适用时**不出现键**，而不是序列化成 `null`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasErrorPayload {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<&'static str>,
}

impl From<VaultError> for CanvasErrorPayload {
    fn from(error: VaultError) -> Self {
        let current_sha = match &error {
            VaultError::Conflict { current_sha } => current_sha.clone(),
            _ => None,
        };
        let cause = match &error {
            VaultError::BackupFailed { cause } => Some(cause.code()),
            _ => None,
        };
        let message = error.to_string();
        tracing::warn!(
            target: "ipc",
            code = error.code(),
            message = %message,
            "ipc.error"
        );
        Self {
            code: error.code(),
            message,
            current_sha,
            cause,
        }
    }
}

impl From<ErrorPayload> for CanvasErrorPayload {
    /// 会话不可用等入口失败：共享载荷只有 `code` + `message`，画布扩展字段缺省。
    fn from(value: ErrorPayload) -> Self {
        Self {
            code: value.code,
            message: value.message,
            current_sha: None,
            cause: None,
        }
    }
}

/// `list_canvases` 的条目 DTO（CR-20261116-02 §4.4.4）。
///
/// `valid:false` 条目带真实相对 `path` 供受控删除定位，`bytes` 仍缺省；
/// DTO 从不包含 `sha256` 或 `text`，无效条目依旧不可打开。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEntryDto {
    pub id: String,
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

impl From<CanvasEntry> for CanvasEntryDto {
    fn from(value: CanvasEntry) -> Self {
        Self {
            id: value.id,
            valid: value.valid,
            reason: value.reason.map(|reason| reason.as_str()),
            path: value.path,
            bytes: value.bytes,
            modified_ms: value.modified_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCanvasDto {
    pub id: String,
    pub path: String,
    pub text: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

impl From<ReadCanvas> for ReadCanvasDto {
    fn from(value: ReadCanvas) -> Self {
        Self {
            id: value.id,
            path: value.path,
            text: value.text,
            bytes: value.bytes,
            sha256: value.sha256,
            modified_ms: value.modified_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCanvasDto {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

impl From<WriteCanvas> for WriteCanvasDto {
    fn from(value: WriteCanvas) -> Self {
        Self {
            id: value.id,
            path: value.path,
            bytes: value.bytes,
            sha256: value.sha256,
            modified_ms: value.modified_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::BackupCause;
    use crate::vault::canvas::CanvasEntryReason;

    #[test]
    fn read_dto_serializes_camel_case() {
        let dto = ReadCanvasDto::from(ReadCanvas {
            id: "c1".into(),
            path: ".workbench/canvas/c1.canvas.json".into(),
            text: "{}".into(),
            bytes: 2,
            sha256: "ab".into(),
            modified_ms: 1,
        });
        let json = serde_json::to_value(dto).expect("serialize");
        assert_eq!(json["id"], "c1");
        assert_eq!(json["modifiedMs"], 1);
        assert!(json.get("modified_ms").is_none());
        assert_eq!(json["path"], ".workbench/canvas/c1.canvas.json");
    }

    #[test]
    fn write_dto_has_no_text_field() {
        let dto = WriteCanvasDto::from(WriteCanvas {
            id: "c1".into(),
            path: ".workbench/canvas/c1.canvas.json".into(),
            bytes: 2,
            sha256: "ab".into(),
            modified_ms: 1,
        });
        let json = serde_json::to_value(dto).expect("serialize");
        assert!(json.get("text").is_none());
        assert_eq!(json["bytes"], 2);
    }

    /// H1：扩展字段只在适用时出现，且不污染 P1 共享载荷。
    #[test]
    fn canvas_error_payload_is_scoped() {
        let conflict = CanvasErrorPayload::from(VaultError::Conflict {
            current_sha: Some("9f2c".into()),
        });
        let json = serde_json::to_value(&conflict).expect("serialize");
        assert_eq!(json["code"], "E_CONFLICT");
        assert_eq!(json["currentSha"], "9f2c");
        assert!(json.get("cause").is_none(), "冲突不带 cause");
        assert_eq!(json.as_object().expect("object").len(), 3);

        let created = CanvasErrorPayload::from(VaultError::Conflict { current_sha: None });
        let json = serde_json::to_value(&created).expect("serialize");
        assert!(
            json.get("currentSha").is_none(),
            "无当前 sha 时键不出现，而不是 null"
        );

        let backup = CanvasErrorPayload::from(VaultError::BackupFailed {
            cause: BackupCause::NoSpace,
        });
        let json = serde_json::to_value(&backup).expect("serialize");
        assert_eq!(json["code"], "E_BACKUP_FAILED");
        assert_eq!(json["cause"], "ENOSPC");
        assert!(json.get("currentSha").is_none());

        let plain = CanvasErrorPayload::from(VaultError::BadId);
        let json = serde_json::to_value(&plain).expect("serialize");
        assert_eq!(json.as_object().expect("object").len(), 2);
        assert!(json.get("currentSha").is_none() && json.get("cause").is_none());
    }

    /// CR-63：无效条目保留定位路径，但不暴露正文、哈希或未确认的字节数。
    #[test]
    fn invalid_entry_dto_keeps_path_and_omits_bytes_and_sha256() {
        let dto = CanvasEntryDto::from(CanvasEntry {
            id: "a.b".into(),
            valid: false,
            reason: Some(CanvasEntryReason::BadId),
            path: Some(".workbench/canvas/a.b.canvas.json".into()),
            bytes: None,
            modified_ms: Some(1),
        });
        let json = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(json["valid"], false);
        assert_eq!(json["reason"], "bad_id");
        assert_eq!(json["path"], ".workbench/canvas/a.b.canvas.json");
        assert!(json.get("bytes").is_none(), "非法条目不得出现 bytes 键");
        assert!(json.get("sha256").is_none(), "DTO 不含 sha256");
        assert!(json.get("text").is_none(), "DTO 不含 text");
        assert_eq!(json["modifiedMs"], 1);
    }

    #[test]
    fn valid_entry_dto_keeps_relative_path() {
        let dto = CanvasEntryDto::from(CanvasEntry {
            id: "c1".into(),
            valid: true,
            reason: None,
            path: Some(".workbench/canvas/c1.canvas.json".into()),
            bytes: Some(2),
            modified_ms: Some(1),
        });
        let json = serde_json::to_value(&dto).expect("serialize");
        assert_eq!(json["path"], ".workbench/canvas/c1.canvas.json");
        assert_eq!(json["bytes"], 2);
        assert!(json.get("reason").is_none(), "合法条目不带 reason");
    }

    /// H3/S1：P1 `ipc/doc.rs::CanvasEntryDto` 被本模块接管后，合法条目的
    /// wire 输出除新增 `valid:true` 外与 P1 逐字节一致。
    ///
    /// 用 P1 影子结构（相同的 derive 与 `rename_all`）作基线，不依赖已删除类型。
    #[test]
    fn superseded_p1_canvas_dto_wire_matches_except_valid() {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct P1CanvasEntryDto {
            id: String,
            path: String,
            bytes: u64,
            modified_ms: u64,
        }

        let p1 = serde_json::to_value(P1CanvasEntryDto {
            id: "01H8".into(),
            path: ".workbench/canvas/01H8.canvas.json".into(),
            bytes: 2,
            modified_ms: 1,
        })
        .expect("P1 baseline");

        let new = serde_json::to_value(CanvasEntryDto::from(CanvasEntry {
            id: "01H8".into(),
            valid: true,
            reason: None,
            path: Some(".workbench/canvas/01H8.canvas.json".into()),
            bytes: Some(2),
            modified_ms: Some(1),
        }))
        .expect("new DTO");

        let mut without_valid = new.as_object().expect("object").clone();
        assert_eq!(
            without_valid.remove("valid"),
            Some(serde_json::Value::Bool(true)),
            "唯一新增字段必须是 valid:true"
        );
        assert_eq!(
            serde_json::to_string(&serde_json::Value::Object(without_valid)).expect("json"),
            serde_json::to_string(&p1).expect("json"),
            "去掉 valid 后必须与 P1 wire 逐字节一致"
        );
        assert_eq!(new.as_object().expect("object").len(), 5);
    }
}
