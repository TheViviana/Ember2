//! 回收站 IPC 负载：删除结果与启动清扫报告。

use serde::Serialize;

use crate::vault::trash::{SweepError, SweepReport, SweepSkip, TrashResult, TrashVia};

/// 删除实际落点，前端据此提示「已移入废纸篓 / 库内暂存」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TrashViaDto {
    System,
    Workbench,
}

impl From<TrashVia> for TrashViaDto {
    fn from(value: TrashVia) -> Self {
        match value {
            TrashVia::System => Self::System,
            TrashVia::Workbench => Self::Workbench,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashResultDto {
    pub via: TrashViaDto,
    pub trash_id: String,
}

impl From<TrashResult> for TrashResultDto {
    fn from(value: TrashResult) -> Self {
        Self {
            via: TrashViaDto::from(value.via),
            trash_id: value.trash_id,
        }
    }
}

/// `trash_list` 单条 Workbench 暂存；时间来自 metadata，字节数来自真实 item。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntryDto {
    pub id: String,
    pub path: Option<String>,
    pub bytes: u64,
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashListDto {
    pub entries: Vec<TrashEntryDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashCleanupErrorDto {
    pub id: String,
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashCleanupDto {
    pub removed_ids: Vec<String>,
    pub errors: Vec<TrashCleanupErrorDto>,
}

/// 本轮清扫为何跳过；`None` 表示正常执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SweepSkipDto {
    Readonly,
    Busy,
}

impl From<SweepSkip> for SweepSkipDto {
    fn from(value: SweepSkip) -> Self {
        match value {
            SweepSkip::Readonly => Self::Readonly,
            SweepSkip::Busy => Self::Busy,
        }
    }
}

/// 单条暂存目录清理失败：不中断后续目录，前端只在健康面板展示。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepErrorDto {
    pub id: String,
    pub message: String,
}

impl From<SweepError> for SweepErrorDto {
    fn from(value: SweepError) -> Self {
        Self {
            id: value.id,
            message: value.message,
        }
    }
}

/// `vault://trash-sweep` 事件负载。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepReportDto {
    pub scanned: usize,
    pub removed: Vec<String>,
    pub errors: Vec<SweepErrorDto>,
    pub skipped: Option<SweepSkipDto>,
}

impl From<SweepReport> for SweepReportDto {
    fn from(value: SweepReport) -> Self {
        Self {
            scanned: value.scanned,
            removed: value.removed,
            errors: value.errors.into_iter().map(SweepErrorDto::from).collect(),
            skipped: value.skipped.map(SweepSkipDto::from),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payloads_use_camel_case_and_lowercase_enums() {
        let removed = serde_json::to_value(SweepReportDto {
            scanned: 2,
            removed: vec!["A".to_string()],
            errors: vec![SweepErrorDto {
                id: "B".to_string(),
                message: "被占用".to_string(),
            }],
            skipped: Some(SweepSkipDto::Busy),
        })
        .expect("serialize");

        assert_eq!(removed["removed"][0], "A");
        assert_eq!(removed["errors"][0]["id"], "B");
        assert_eq!(removed["skipped"], "busy");

        let deleted = serde_json::to_value(TrashResultDto {
            via: TrashViaDto::Workbench,
            trash_id: "01J".to_string(),
        })
        .expect("serialize");
        assert_eq!(deleted["via"], "workbench");
        assert_eq!(deleted["trashId"], "01J");
    }

    #[test]
    fn inventory_and_cleanup_payloads_match_the_ipc_shape() {
        let listed = serde_json::to_value(TrashListDto {
            entries: vec![TrashEntryDto {
                id: "01J".to_string(),
                path: None,
                bytes: 42,
                deleted_at: None,
            }],
        })
        .expect("serialize list");
        assert_eq!(listed["entries"][0]["id"], "01J");
        assert!(listed["entries"][0]["path"].is_null());
        assert_eq!(listed["entries"][0]["bytes"], 42);
        assert!(listed["entries"][0]["deletedAt"].is_null());

        let cleaned = serde_json::to_value(TrashCleanupDto {
            removed_ids: vec!["01J".to_string()],
            errors: vec![TrashCleanupErrorDto {
                id: "bad".to_string(),
                code: "E_INVALID_ARG",
                message: "非法 id".to_string(),
            }],
        })
        .expect("serialize cleanup");
        assert_eq!(cleaned["removedIds"][0], "01J");
        assert_eq!(cleaned["errors"][0]["id"], "bad");
        assert_eq!(cleaned["errors"][0]["code"], "E_INVALID_ARG");
    }
}
