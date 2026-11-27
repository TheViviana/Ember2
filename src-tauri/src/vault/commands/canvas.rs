use std::path::Path;

use tauri::State;

use crate::ipc::canvas::{CanvasEntryDto, CanvasErrorPayload, ReadCanvasDto, WriteCanvasDto};
use crate::ipc::ErrorPayload;
use crate::vault::{canvas, paths, scan, Session, VaultState};

use super::root_of;

/// `list_canvases` 的会话级实现：只做 DTO 映射，磁盘分类在 `vault::canvas`。
fn list_canvases_inner(session: &Session) -> Result<Vec<CanvasEntryDto>, ErrorPayload> {
    let root = root_of(session)?;
    scan::list_canvases(root)
        .map(|canvases| canvases.into_iter().map(CanvasEntryDto::from).collect())
        .map_err(ErrorPayload::from)
}

#[tauri::command]
pub fn list_canvases(state: State<'_, VaultState>) -> Result<Vec<CanvasEntryDto>, ErrorPayload> {
    let slot = state.read();
    list_canvases_inner(&slot.session)
}

/// 画布命令的入口失败：复用 P1 共享载荷的内容，但换用画布专用形状。
fn root_of_canvas(session: &Session) -> Result<&Path, CanvasErrorPayload> {
    if let Some(failure) = &session.failure {
        return Err(failure.clone().into());
    }
    Ok(session.root.as_path())
}

/// `canvas_read` 的会话级实现；命令包装只负责取 `State`。
fn canvas_read_inner(session: &Session, id: &str) -> Result<ReadCanvasDto, CanvasErrorPayload> {
    let root = root_of_canvas(session)?;
    crate::vault::canvas::read(root, id)
        .map(ReadCanvasDto::from)
        .map_err(CanvasErrorPayload::from)
}

#[tauri::command]
pub fn canvas_read(
    state: State<'_, VaultState>,
    id: String,
) -> Result<ReadCanvasDto, CanvasErrorPayload> {
    let slot = state.read();
    canvas_read_inner(&slot.session, &id)
}

/// 画布改名（CR-20261121-58）：双 id 校验 + gate 拦只读 + 同目录原子 rename。
/// 目标已存在报 `E_INVALID_ARG`；成功后 journal 登记（removed 旧 + write 新）压回环。
fn canvas_rename_inner(
    session: &Session,
    id: &str,
    new_id: &str,
) -> Result<ReadCanvasDto, CanvasErrorPayload> {
    use crate::ipc::canvas::CanvasErrorPayload;
    let root = root_of_canvas(session)?;
    let permit = session.gate.enter().map_err(CanvasErrorPayload::from)?;
    canvas::validate_canvas_id(id).map_err(CanvasErrorPayload::from)?;
    canvas::validate_canvas_id(new_id).map_err(CanvasErrorPayload::from)?;
    if id == new_id {
        return canvas::read(root, id)
            .map(ReadCanvasDto::from)
            .map_err(CanvasErrorPayload::from);
    }
    let old_path = canvas::canvas_path(root, id);
    if !old_path.is_file() {
        return Err(ErrorPayload::new("E_NOT_FOUND", format!("画布不存在：{id}")).into());
    }
    let new_path = canvas::canvas_path(root, new_id);
    if new_path.exists() {
        return Err(ErrorPayload::new("E_INVALID_ARG", format!("目标画布已存在：{new_id}")).into());
    }
    std::fs::rename(&old_path, &new_path).map_err(|error| {
        CanvasErrorPayload::from(ErrorPayload::new(
            "E_IO",
            format!("画布改名失败：{id} → {new_id}：{error}"),
        ))
    })?;
    drop(permit);
    let old_rel = paths::to_rel(root, &old_path).map_err(CanvasErrorPayload::from)?;
    let new_rel = paths::to_rel(root, &new_path).map_err(CanvasErrorPayload::from)?;
    session.writes.note_removed(&old_rel);
    let written = canvas::read(root, new_id).map_err(CanvasErrorPayload::from)?;
    session.writes.note_write(&new_rel, &written.sha256);
    Ok(ReadCanvasDto::from(written))
}

#[tauri::command]
pub fn canvas_rename(
    state: State<'_, VaultState>,
    id: String,
    new_id: String,
) -> Result<ReadCanvasDto, CanvasErrorPayload> {
    let slot = state.read();
    canvas_rename_inner(&slot.session, &id, &new_id)
}

/// `canvas_write` 的会话级实现；`expected_sha` 三态原样透传给内核。
fn canvas_write_inner(
    session: &Session,
    id: &str,
    text: &str,
    expected_sha: Option<&str>,
    backup_v1: bool,
) -> Result<WriteCanvasDto, CanvasErrorPayload> {
    let root = root_of_canvas(session)?;
    crate::vault::canvas::write(
        &session.gate,
        &session.writes,
        root,
        id,
        text,
        expected_sha,
        backup_v1,
    )
    .map(WriteCanvasDto::from)
    .map_err(CanvasErrorPayload::from)
}

#[tauri::command]
pub fn canvas_write(
    state: State<'_, VaultState>,
    id: String,
    text: String,
    expected_sha: Option<String>,
    backup_v1: Option<bool>,
) -> Result<WriteCanvasDto, CanvasErrorPayload> {
    let slot = state.read();
    canvas_write_inner(
        &slot.session,
        &id,
        &text,
        expected_sha.as_deref(),
        backup_v1.unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::vault::gate::WriteGate;
    use crate::vault::watch::WriteJournal;

    fn session(root: &Path) -> Session {
        Session {
            root: root.to_path_buf(),
            identity: None,
            gate: WriteGate::new(None),
            failure: None,
            writes: WriteJournal::default(),
        }
    }

    fn seed(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, bytes).expect("seed");
    }

    /// 命令层入口校验先于磁盘：非法 id 不创建 `.workbench`。
    #[test]
    fn canvas_read_rejects_bad_id_before_disk() {
        let dir = tempdir().expect("tempdir");
        let session = session(dir.path());
        let error = canvas_read_inner(&session, "../x").expect_err("非法 id");
        assert_eq!(error.code, "E_BAD_ID");
        assert!(
            !dir.path().join(".workbench").exists(),
            "非法 id 不得触碰磁盘"
        );
    }

    /// expectedSha 三态经命令层原样透传，冲突载荷带 currentSha。
    #[test]
    fn canvas_write_expected_sha_tristate() {
        let dir = tempdir().expect("tempdir");
        let session = session(dir.path());

        let first = canvas_write_inner(&session, "c1", "v1", Some(""), false).expect("条件创建");
        assert_eq!(first.id, "c1");

        let exists =
            canvas_write_inner(&session, "c1", "v2", Some(""), false).expect_err("已存在应冲突");
        assert_eq!(exists.code, "E_CONFLICT");
        assert_eq!(exists.current_sha.as_deref(), Some(first.sha256.as_str()));

        let stale = canvas_write_inner(&session, "c1", "v2", Some("deadbeef"), false)
            .expect_err("sha 不匹配");
        assert_eq!(stale.code, "E_CONFLICT");
        assert_eq!(stale.current_sha.as_deref(), Some(first.sha256.as_str()));

        let second = canvas_write_inner(&session, "c1", "v2", Some(first.sha256.as_str()), false)
            .expect("sha 匹配");
        assert_ne!(second.sha256, first.sha256);

        canvas_write_inner(&session, "c1", "v3", None, false).expect("None 不校验");
    }

    /// 备份失败经命令层返回 E_BACKUP_FAILED + cause，主写不发生。
    #[test]
    fn canvas_write_backup_failure_carries_cause() {
        let dir = tempdir().expect("tempdir");
        let session = session(dir.path());
        canvas_write_inner(&session, "c2", "v1", Some(""), false).expect("seed");

        let canvas_dir = dir.path().join(".workbench/canvas");
        fs::create_dir_all(canvas_dir.join("c2.canvas.json.v1.bak")).expect("占用备份路径");

        let error = canvas_write_inner(&session, "c2", "v2", None, true).expect_err("备份失败");
        assert_eq!(error.code, "E_BACKUP_FAILED");
        assert!(error.cause.is_some(), "备份失败必须带 cause");
        assert_eq!(
            fs::read(canvas_dir.join("c2.canvas.json")).expect("main"),
            b"v1",
            "备份失败不得改写主文件"
        );
    }

    /// 合法条目的既有四字段与 P1 形状一致，仅新增 `valid`。
    #[test]
    fn list_canvases_keeps_p1_valid_entry_shape() {
        let dir = tempdir().expect("tempdir");
        let session = session(dir.path());
        seed(dir.path(), ".workbench/canvas/c1.canvas.json", b"{}");

        let entries = list_canvases_inner(&session).expect("list");
        assert_eq!(entries.len(), 1);
        let json = serde_json::to_value(&entries[0]).expect("json");

        let baseline = serde_json::json!({
            "id": "c1",
            "path": ".workbench/canvas/c1.canvas.json",
            "bytes": 2,
        });
        for key in ["id", "path", "bytes"] {
            assert_eq!(json[key], baseline[key], "P1 既有键形状变化：{key}");
        }
        assert!(json["modifiedMs"].is_u64(), "modifiedMs 必须是毫秒数");
        assert_eq!(json["valid"], true);
        assert!(json.get("reason").is_none(), "合法条目不带 reason");

        let mut keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["bytes", "id", "modifiedMs", "path", "valid"],
            "合法条目只允许 P1 四键 + valid"
        );
    }

    /// CR-63：非法条目提供受控删除路径，但仍不出现 bytes/sha256/text。
    #[test]
    fn list_canvases_invalid_entry_stays_within_whitelist() {
        let dir = tempdir().expect("tempdir");
        let session = session(dir.path());
        seed(
            dir.path(),
            ".workbench/canvas/bad.id.canvas.json",
            b"secret",
        );

        let entries = list_canvases_inner(&session).expect("list");
        let invalid = entries.iter().find(|entry| !entry.valid).expect("非法条目");
        let json = serde_json::to_value(invalid).expect("json");

        assert_eq!(json["id"], "bad.id");
        assert_eq!(json["reason"], "bad_id");
        assert_eq!(json["path"], ".workbench/canvas/bad.id.canvas.json");
        for key in ["bytes", "sha256", "text"] {
            assert!(json.get(key).is_none(), "非法条目不得出现 {key} 键");
        }
        let mut keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["id", "modifiedMs", "path", "reason", "valid"]);
    }

    /// `canvas_write` 与 `canvas_read` 的 modifiedMs 同语义（Unix epoch ms UTC）。
    #[test]
    fn canvas_read_and_write_modified_ms_agree() {
        let dir = tempdir().expect("tempdir");
        let session = session(dir.path());

        let written = canvas_write_inner(&session, "c1", "v1", Some(""), false).expect("write");
        let read = canvas_read_inner(&session, "c1").expect("read");

        assert_eq!(read.modified_ms, written.modified_ms);
        assert_eq!(read.sha256, written.sha256);
        assert_eq!(read.bytes, written.bytes);
    }
}

#[cfg(test)]
mod canvas_rename_tests {
    use super::*;
    use crate::vault::gate::WriteGate;
    use crate::vault::watch::WriteJournal;

    fn session_at(root: &Path) -> Session {
        Session {
            root: root.to_path_buf(),
            identity: None,
            gate: WriteGate::new(None),
            failure: None,
            writes: WriteJournal::default(),
        }
    }

    #[test]
    fn canvas_rename_renames_and_rejects_missing_target_and_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let session = session_at(&root);
        let old_rel = canvas::canvas_path(&root, "alpha");
        std::fs::create_dir_all(old_rel.parent().unwrap()).unwrap();
        std::fs::write(&old_rel, "{\"schemaVersion\":2,\"nodes\":[],\"edges\":[]}").unwrap();

        let renamed = canvas_rename_inner(&session, "alpha", "beta").unwrap();
        assert_eq!(renamed.id, "beta");
        assert!(!old_rel.exists());
        assert!(canvas::canvas_path(&root, "beta").is_file());

        let err = canvas_rename_inner(&session, "alpha", "beta").unwrap_err();
        assert_eq!(err.code, "E_NOT_FOUND", "旧画布不存在");

        let same = canvas_rename_inner(&session, "beta", "beta").unwrap();
        assert_eq!(same.id, "beta", "同名改名按幂等读取返回");
    }

    #[test]
    fn canvas_rename_rejects_bad_id_and_existing_target() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let session = session_at(&root);
        for id in ["alpha", "beta"] {
            let path = canvas::canvas_path(&root, id);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "{}").unwrap();
        }
        let err = canvas_rename_inner(&session, "alpha", "beta").unwrap_err();
        assert_eq!(err.code, "E_INVALID_ARG", "目标已存在");
        let err = canvas_rename_inner(&session, "alpha", "中文id").unwrap_err();
        assert_eq!(err.code, "E_BAD_ID", "非法 id");
    }
}
