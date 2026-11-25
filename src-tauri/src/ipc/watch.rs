//! 文件监听事件负载（`vault://file-changed`）。

use serde::Serialize;

use crate::vault::watch::{ChangeKind, FileChange, FileChanged};

/// 单条变更的类型；`renamed` 只有拿到两端路径时才会出现。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKindDto {
    Created,
    Updated,
    Removed,
    Renamed,
}

impl From<ChangeKind> for FileChangeKindDto {
    fn from(value: ChangeKind) -> Self {
        match value {
            ChangeKind::Created => Self::Created,
            ChangeKind::Updated => Self::Updated,
            ChangeKind::Removed => Self::Removed,
            ChangeKind::Renamed => Self::Renamed,
        }
    }
}

/// 单条变更。`removed` 不带 hash；`renamed` 的 `from` 是旧路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeDto {
    pub kind: FileChangeKindDto,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

impl From<FileChange> for FileChangeDto {
    fn from(value: FileChange) -> Self {
        Self {
            kind: FileChangeKindDto::from(value.kind),
            path: value.path,
            from: value.from,
            bytes: value.bytes,
            sha256: value.sha256,
            modified_ms: value.modified_ms,
        }
    }
}

/// `vault://file-changed` 负载：一次防抖冲刷对应一条事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangedDto {
    pub changes: Vec<FileChangeDto>,
}

impl From<FileChanged> for FileChangedDto {
    fn from(value: FileChanged) -> Self {
        Self {
            changes: value.changes.into_iter().map(FileChangeDto::from).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_use_camel_case_and_omit_missing_fields() {
        let payload = serde_json::to_value(FileChangedDto {
            changes: vec![
                FileChangeDto {
                    kind: FileChangeKindDto::Renamed,
                    path: "notes/b.md".to_string(),
                    from: Some("notes/a.md".to_string()),
                    bytes: Some(4),
                    sha256: Some("abc".to_string()),
                    modified_ms: Some(1_700_000_000_000),
                },
                FileChangeDto {
                    kind: FileChangeKindDto::Removed,
                    path: "notes/c.md".to_string(),
                    from: None,
                    bytes: None,
                    sha256: None,
                    modified_ms: None,
                },
            ],
        })
        .expect("serialize");

        assert_eq!(payload["changes"][0]["kind"], "renamed");
        assert_eq!(payload["changes"][0]["path"], "notes/b.md");
        assert_eq!(payload["changes"][0]["from"], "notes/a.md");
        assert_eq!(payload["changes"][0]["modifiedMs"], 1_700_000_000_000u64);
        assert_eq!(payload["changes"][1]["kind"], "removed");
        assert!(
            payload["changes"][1].get("sha256").is_none(),
            "null 字段必须省略"
        );
        assert!(payload["changes"][1].get("bytes").is_none());
    }
}
