use serde::Serialize;

/// `conflict_save` 的响应：副本在库内的相对路径与内容指纹。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictCopyDto {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_copy_dto_is_camel_case() {
        let value = serde_json::to_value(ConflictCopyDto {
            path: ".workbench/conflicts/a.conflict-20261127-101530-123.md".to_string(),
            bytes: 3,
            sha256: "ab".repeat(32),
        })
        .expect("json");
        assert_eq!(
            value["path"],
            ".workbench/conflicts/a.conflict-20261127-101530-123.md"
        );
        assert_eq!(value["bytes"], 3);
        assert_eq!(value["sha256"], "ab".repeat(32));
        assert!(value.get("sha256").is_some());
    }
}
