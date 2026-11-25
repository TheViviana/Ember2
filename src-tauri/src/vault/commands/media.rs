use std::path::Path;

use tauri::State;

use crate::ipc::media::{MediaEntryDto, MediaSaveDto};
use crate::ipc::trash::TrashResultDto;
use crate::ipc::{ErrorPayload, VaultError};
use crate::vault::{media, trash, VaultState};

use super::root_of;

#[tauri::command]
pub fn media_save(
    state: State<'_, VaultState>,
    source_path: String,
) -> Result<MediaSaveDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    media::save(&session.gate, root, Path::new(&source_path))
        .map(MediaSaveDto::from)
        .map_err(ErrorPayload::from)
}

#[tauri::command]
pub fn media_list(state: State<'_, VaultState>) -> Result<Vec<MediaEntryDto>, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    media::list(root)
        .map(|entries| entries.into_iter().map(MediaEntryDto::from).collect())
        .map_err(ErrorPayload::from)
}

/// 删除媒体：额外限定 `media/` 前缀，避免用媒体入口删文档。
#[tauri::command]
pub fn media_delete(
    state: State<'_, VaultState>,
    path: String,
) -> Result<TrashResultDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    if !path.replace('\\', "/").starts_with("media/") {
        return Err(ErrorPayload::from(VaultError::InvalidArg(
            "media_delete 只接受 media/ 下的相对路径".to_string(),
        )));
    }
    trash::delete(&session.gate, root, &path)
        .map(TrashResultDto::from)
        .map_err(ErrorPayload::from)
}
