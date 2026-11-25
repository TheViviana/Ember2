use tauri::State;

use crate::ipc::doc::WriteDocDto;
use crate::ipc::history::{HistoryDeleteDto, HistoryPurgeDto, HistoryReadDto, HistoryVersionDto};
use crate::ipc::ErrorPayload;
use crate::vault::{history, VaultState};

use super::root_of;

/// 版本元数据列表（时间升序）；只读，不持写闸门。
#[tauri::command]
pub fn history_list(
    state: State<'_, VaultState>,
    doc_id: String,
) -> Result<Vec<HistoryVersionDto>, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    history::list(root, &doc_id).map_err(ErrorPayload::from)
}

/// 读版本全文并计算 sha256；只读，不持写闸门。
#[tauri::command]
pub fn history_read(
    state: State<'_, VaultState>,
    doc_id: String,
    version: String,
) -> Result<HistoryReadDto, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    history::read(root, &doc_id, &version).map_err(ErrorPayload::from)
}

/// 恢复版本：path↔docId 一致性 → 强制快照当前 → 条件写（冲突 E_INVALID_ARG，当前不动）。
/// `expected_sha` 必填（收口后修补）：漏传会导致无条件覆盖，Rust 边界直接挡住。
#[tauri::command]
pub fn history_restore(
    state: State<'_, VaultState>,
    path: String,
    doc_id: String,
    version: String,
    expected_sha: String,
) -> Result<WriteDocDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    let written = history::restore(&session.gate, root, &path, &doc_id, &version, &expected_sha)
        .map_err(ErrorPayload::from)?;
    session.writes.note_write(&written.path, &written.sha256);
    Ok(WriteDocDto::from(written))
}

/// 删除单个版本；不存在 → E_NOT_FOUND。持写闸门。
#[tauri::command]
pub fn history_delete(
    state: State<'_, VaultState>,
    doc_id: String,
    version: String,
) -> Result<HistoryDeleteDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    history::delete(&session.gate, root, &doc_id, &version).map_err(ErrorPayload::from)
}

/// 清空某篇的全部历史；无目录 → deleted: 0（非错误）。持写闸门。
#[tauri::command]
pub fn history_purge(
    state: State<'_, VaultState>,
    doc_id: String,
) -> Result<HistoryPurgeDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    history::purge(&session.gate, root, &doc_id).map_err(ErrorPayload::from)
}
