//! 备份 IPC 负载。

use serde::Serialize;

use crate::vault::backup::{BackupInspect, BackupReport, DestinationCheck};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupDestinationDto {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReportDto {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInspectDto {
    pub path: String,
    pub version: u32,
    pub created_at: String,
    pub source_root: String,
    pub files: usize,
    pub bytes: u64,
}

impl From<DestinationCheck> for BackupDestinationDto {
    fn from(value: DestinationCheck) -> Self {
        Self { path: value.path }
    }
}

impl From<BackupReport> for BackupReportDto {
    fn from(value: BackupReport) -> Self {
        Self {
            path: value.path,
            files: value.files,
            bytes: value.bytes,
            created_at: value.created_at,
        }
    }
}

impl From<BackupInspect> for BackupInspectDto {
    fn from(value: BackupInspect) -> Self {
        Self {
            path: value.path,
            version: value.version,
            created_at: value.created_at,
            source_root: value.source_root,
            files: value.files,
            bytes: value.bytes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_use_camel_case() {
        let report = serde_json::to_value(BackupReportDto {
            path: "/tmp/b".to_string(),
            files: 3,
            bytes: 12,
            created_at: "2026-11-15T00:00:00Z".to_string(),
        })
        .expect("serialize");
        assert_eq!(report["createdAt"], "2026-11-15T00:00:00Z");
        assert_eq!(report["files"], 3);

        let inspect = serde_json::to_value(BackupInspectDto {
            path: "/tmp/b".to_string(),
            version: 1,
            created_at: "2026-11-15T00:00:00Z".to_string(),
            source_root: "/vault".to_string(),
            files: 1,
            bytes: 4,
        })
        .expect("serialize");
        assert_eq!(inspect["sourceRoot"], "/vault");
    }
}
