use serde::{Deserialize, Serialize};

/// `vault_read` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadDocDto {
    pub path: String,
    pub text: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// `vault_write` / `vault_rename` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteDocDto {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportConflictDto {
    Skip,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportStatusDto {
    Imported,
    Skipped,
}

/// `vault_import` 的响应；skipped 时 path/sha 显式为 null、bytes 为 0。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDocDto {
    pub status: ImportStatusDto,
    pub path: Option<String>,
    pub bytes: u64,
    pub sha: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceItemDto {
    pub path: String,
    pub expected_sha: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceStatusDto {
    Applied,
    RolledBack,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceFailureDto {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

/// `vault_replace` 的响应；预检失败仍走共享 ErrorPayload。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceDocDto {
    pub status: ReplaceStatusDto,
    pub written: Vec<String>,
    pub restored: Vec<String>,
    pub failure: Option<ReplaceFailureDto>,
    pub rollback_errors: Vec<ReplaceFailureDto>,
}

/// `vault_stat` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatDto {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// 目录项类型，序列化为 `"dir" | "file"`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKindDto {
    Dir,
    File,
}

/// `vault_list` 的单项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryDto {
    pub name: String,
    pub path: String,
    pub kind: EntryKindDto,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// `vault_scan` 的单项。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDocDto {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dtos_are_camel_case_and_entry_kind_is_lowercase() {
        let value = serde_json::to_value(ReadDocDto {
            path: "a.md".to_string(),
            text: "x".to_string(),
            bytes: 1,
            sha256: "0".repeat(64),
            modified_ms: 7,
        })
        .expect("json");
        assert_eq!(value["modifiedMs"], 7);

        let kind = serde_json::to_value(EntryKindDto::Dir).expect("json");
        assert_eq!(kind, "dir");
        let kind = serde_json::to_value(EntryKindDto::File).expect("json");
        assert_eq!(kind, "file");
    }

    #[test]
    fn replace_dto_uses_camel_case_status_and_explicit_null_failure() {
        let item: ReplaceItemDto = serde_json::from_value(serde_json::json!({
            "path": "a.md",
            "expectedSha": "ab",
            "text": "new"
        }))
        .expect("request");
        assert_eq!(item.expected_sha, "ab");

        let value = serde_json::to_value(ReplaceDocDto {
            status: ReplaceStatusDto::RolledBack,
            written: Vec::new(),
            restored: vec!["a.md".to_string()],
            failure: None,
            rollback_errors: Vec::new(),
        })
        .expect("response");
        assert_eq!(value["status"], "rolledBack");
        assert!(value["failure"].is_null());
        assert_eq!(value["rollbackErrors"], serde_json::json!([]));
        assert!(value.get("rollback_errors").is_none());
    }

    #[test]
    fn import_dto_uses_contract_names_and_explicit_nulls() {
        let conflict: ImportConflictDto =
            serde_json::from_value(serde_json::json!("rename")).expect("conflict");
        assert_eq!(conflict, ImportConflictDto::Rename);

        let imported = serde_json::to_value(ImportDocDto {
            status: ImportStatusDto::Imported,
            path: Some("documents/a.md".to_string()),
            bytes: 3,
            sha: Some("ab".repeat(32)),
        })
        .expect("imported");
        assert_eq!(imported["status"], "imported");
        assert_eq!(imported["path"], "documents/a.md");
        assert_eq!(imported["sha"], "ab".repeat(32));
        assert!(imported.get("sha256").is_none());

        let skipped = serde_json::to_value(ImportDocDto {
            status: ImportStatusDto::Skipped,
            path: None,
            bytes: 0,
            sha: None,
        })
        .expect("skipped");
        assert_eq!(skipped["status"], "skipped");
        assert!(skipped["path"].is_null());
        assert!(skipped["sha"].is_null());
        assert_eq!(skipped["bytes"], 0);
    }
}
