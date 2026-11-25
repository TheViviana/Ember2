use std::path::Path;

use tauri::State;

use crate::ipc::backup::{BackupDestinationDto, BackupInspectDto, BackupReportDto};
use crate::ipc::ErrorPayload;
use crate::vault::{backup, VaultState};

use super::root_of;

/// 校验备份位置（只校验，不持久化）。
#[tauri::command]
pub fn backup_destination(
    state: State<'_, VaultState>,
    destination: String,
) -> Result<BackupDestinationDto, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    backup::check_destination(root, Path::new(&destination))
        .map(BackupDestinationDto::from)
        .map_err(ErrorPayload::from)
}

/// 导出备份；目标必须不存在，导出全程只读源库、不持写锁。
#[tauri::command]
pub fn backup_export(
    state: State<'_, VaultState>,
    destination: String,
) -> Result<BackupReportDto, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    backup::export(root, Path::new(&destination))
        .map(BackupReportDto::from)
        .map_err(ErrorPayload::from)
}

/// 校验备份：解析 manifest.json 并逐文件核对大小与 sha256。
#[tauri::command]
pub fn backup_inspect(destination: String) -> Result<BackupInspectDto, ErrorPayload> {
    backup::inspect(Path::new(&destination))
        .map(BackupInspectDto::from)
        .map_err(ErrorPayload::from)
}
