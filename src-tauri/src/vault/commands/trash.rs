use tauri::State;

use crate::ipc::trash::{TrashCleanupDto, TrashListDto};
use crate::ipc::ErrorPayload;
use crate::vault::{trash, VaultState};

use super::root_of;

/// Workbench 暂存清单；系统废纸篓与缺少真实 item 的条目不会混入。
#[tauri::command]
pub fn trash_list(state: State<'_, VaultState>) -> Result<TrashListDto, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    Ok(trash::list(root))
}

/// 仅按合法 ULID 永久清理 Workbench 暂存；单项失败不阻断其余条目。
#[tauri::command]
pub fn trash_cleanup(
    state: State<'_, VaultState>,
    ids: Vec<String>,
) -> Result<TrashCleanupDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    trash::cleanup_by_ids(&session.gate, root, &ids).map_err(ErrorPayload::from)
}
