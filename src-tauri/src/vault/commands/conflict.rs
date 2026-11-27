use tauri::State;

use crate::ipc::conflict::ConflictCopyDto;
use crate::ipc::ErrorPayload;
use crate::vault::{conflict, VaultState};

use super::root_of;

/// 保存冲突发生时的本地草稿副本（P2-9 A 方案）。
///
/// 只写 `.workbench/conflicts/`，不复制磁盘版本；正文经写闸门与大小上限校验。
#[tauri::command]
pub fn conflict_save(
    state: State<'_, VaultState>,
    path: String,
    text: String,
    stamp: String,
) -> Result<ConflictCopyDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    conflict::save(&session.gate, root, &path, &text, &stamp).map_err(ErrorPayload::from)
}
