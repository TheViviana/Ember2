use std::path::Path;
use std::process::Command;

use tauri::State;

use crate::ipc::doc::{
    DirEntryDto, EntryKindDto, ImportConflictDto, ImportDocDto, ImportStatusDto, ReadDocDto,
    ReplaceDocDto, ReplaceFailureDto, ReplaceItemDto, ReplaceStatusDto, ScanDocDto, StatDto,
    WriteDocDto,
};
use crate::ipc::trash::TrashResultDto;
use crate::ipc::{ErrorPayload, VaultConstantsDto, VaultError, VaultIdentityDto};
use crate::vault::{
    constants, doc, history, identity_dto, import, paths, replace, scan, trash, Session, VaultState,
};

use super::root_of;

/// 登记「刚被自己删除/改名的路径」，监听线程据此压掉回环事件。
/// 删除后 `resolve` 只做路径运算与 symlink 探测，不会重建任何文件。
fn note_removed(session: &Session, root: &Path, path: &str) {
    if let Ok(resolved) = paths::resolve(root, path) {
        if let Ok(rel) = paths::to_rel(root, &resolved) {
            session.writes.note_removed(&rel);
        }
    }
}

/// 当前库身份：会话可用性由 identity_dto 单源判定（自 vault/mod.rs 归置至此，CR-51）。
#[tauri::command]
pub fn vault_identity(state: State<'_, VaultState>) -> Result<VaultIdentityDto, ErrorPayload> {
    identity_dto(&state.read().session)
}

#[tauri::command]
pub fn vault_constants() -> VaultConstantsDto {
    constants::snapshot()
}

#[tauri::command]
pub fn vault_read(state: State<'_, VaultState>, path: String) -> Result<ReadDocDto, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    doc::read(root, &path)
        .map(ReadDocDto::from)
        .map_err(ErrorPayload::from)
}

/// `vault_write` 的会话级实现：覆盖前把旧内容快照进 history（CR-20261119-21）。
fn vault_write_inner(
    session: &Session,
    path: &str,
    text: &str,
    expected_sha: Option<&str>,
) -> Result<WriteDocDto, ErrorPayload> {
    let root = root_of(session)?;
    snapshot_current(session, root, path);
    let written =
        doc::write(&session.gate, root, path, text, expected_sha).map_err(ErrorPayload::from)?;
    session.writes.note_write(&written.path, &written.sha256);
    Ok(WriteDocDto::from(written))
}

#[tauri::command]
pub fn vault_write(
    state: State<'_, VaultState>,
    path: String,
    text: String,
    expected_sha: Option<String>,
) -> Result<WriteDocDto, ErrorPayload> {
    let slot = state.read();
    vault_write_inner(&slot.session, &path, &text, expected_sha.as_deref())
}

#[tauri::command]
pub fn vault_replace(
    state: State<'_, VaultState>,
    items: Vec<ReplaceItemDto>,
) -> Result<ReplaceDocDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    let items = items
        .into_iter()
        .map(|item| replace::ReplaceItem {
            path: item.path,
            expected_sha: item.expected_sha,
            text: item.text,
        })
        .collect();
    replace::replace(&session.gate, &session.writes, root, items)
        .map(ReplaceDocDto::from)
        .map_err(ErrorPayload::from)
}

#[tauri::command]
pub fn vault_import(
    state: State<'_, VaultState>,
    source_path: String,
    target_dir: String,
    conflict: ImportConflictDto,
) -> Result<ImportDocDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    let conflict = match conflict {
        ImportConflictDto::Skip => import::Conflict::Skip,
        ImportConflictDto::Rename => import::Conflict::Rename,
    };
    let outcome = import::import(
        &session.gate,
        root,
        Path::new(&source_path),
        &target_dir,
        conflict,
    )
    .map_err(ErrorPayload::from)?;
    if let import::ImportOutcome::Imported(written) = &outcome {
        session.writes.note_write(&written.path, &written.sha256);
    }
    Ok(ImportDocDto::from(outcome))
}

/// 覆盖前快照旧内容（best-effort，CR-20261119-21 §3.2）：
/// 目标新建（NotFound）→ 无旧版本，跳过；docId 缺失 / 非 ULID → 跳过；
/// 快照失败仅记日志——不闩锁全库、不阻塞主写入（红线⑧：日志含上下文，非静默吞错）。
fn snapshot_current(session: &Session, root: &Path, path: &str) {
    if session.gate.readonly_reason().is_some() {
        return;
    }
    let current = match doc::read(root, path) {
        Ok(value) => value,
        Err(VaultError::NotFound) => return,
        Err(error) => {
            let payload = ErrorPayload::from(error);
            eprintln!(
                "[history] 旧内容读取失败，跳过快照：{path}：{} {}",
                payload.code, payload.message
            );
            return;
        }
    };
    let Some(doc_id) = history::extract_doc_id(&current.text) else {
        return;
    };
    if let Err(error) = history::snapshot(&session.gate, root, &doc_id, &current.text) {
        let payload = ErrorPayload::from(error);
        eprintln!(
            "[history] 快照失败（不阻塞写入）：docId={doc_id} path={path}：{} {}",
            payload.code, payload.message
        );
    }
}

#[tauri::command]
pub fn vault_rename(
    state: State<'_, VaultState>,
    from: String,
    to: String,
) -> Result<WriteDocDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    let written = doc::rename(&session.gate, root, &from, &to).map_err(ErrorPayload::from)?;
    note_removed(session, root, &from);
    // 目录改名没有单文件 sha（CR-20261122-64），不写入自写日志，避免伪装成文件事件。
    if !written.sha256.is_empty() {
        session.writes.note_write(&written.path, &written.sha256);
    }
    Ok(WriteDocDto::from(written))
}

#[tauri::command]
pub fn vault_list(
    state: State<'_, VaultState>,
    path: Option<String>,
) -> Result<Vec<DirEntryDto>, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    scan::list(root, path.as_deref())
        .map(|entries| entries.into_iter().map(DirEntryDto::from).collect())
        .map_err(ErrorPayload::from)
}

/// 构造文件管理器定位命令：只接受当前库内已经存在的普通 Markdown 文件。
fn reveal_command(root: &Path, rel: &str) -> Result<Command, ErrorPayload> {
    let absolute = paths::resolve(root, rel).map_err(ErrorPayload::from)?;
    if !rel.to_ascii_lowercase().ends_with(".md") {
        return Err(ErrorPayload {
            code: "E_INVALID_ARG",
            message: format!("在访达中查看只接受 .md 文章：{rel}"),
        });
    }
    let metadata = std::fs::symlink_metadata(&absolute)
        .map_err(doc::not_found_or)
        .map_err(ErrorPayload::from)?;
    if !metadata.file_type().is_file() {
        return Err(ErrorPayload::from(VaultError::NotFound));
    }
    #[cfg(target_os = "macos")]
    let command = {
        let mut command = Command::new("/usr/bin/open");
        command.arg("-R").arg(&absolute);
        command
    };
    #[cfg(target_os = "windows")]
    let command = {
        let mut command = Command::new("explorer");
        command.arg(format!("/select,{}", absolute.display()));
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let command = {
        let mut command = Command::new("xdg-open");
        command.arg(absolute.parent().unwrap_or(&absolute));
        command
    };
    Ok(command)
}

fn run_reveal(command: &mut Command, rel: &str) -> Result<(), ErrorPayload> {
    // Windows 的 explorer 成功选中文件时也可能返回非 0，且可能等待 Shell 进程，
    // 因此只确认派生成功，不读取退出状态。
    #[cfg(target_os = "windows")]
    {
        command.spawn().map_err(|error| ErrorPayload {
            code: "E_IO",
            message: format!("无法打开资源管理器：{rel}：{error}"),
        })?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let status = command.status().map_err(|error| ErrorPayload {
            code: "E_IO",
            message: format!("无法启动文件管理器：{rel}：{error}"),
        })?;
        if status.success() {
            return Ok(());
        }
        Err(ErrorPayload {
            code: "E_IO",
            message: format!("文件管理器未能显示文章：{rel}（退出状态 {status}）"),
        })
    }
}

/// 在访达中选中文章；只读操作，不取得 WriteGate，因此只读库也可用。
#[tauri::command]
pub fn vault_reveal(state: State<'_, VaultState>, path: String) -> Result<(), ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    run_reveal(&mut reveal_command(root, &path)?, &path)
}

#[tauri::command]
pub fn vault_scan(state: State<'_, VaultState>) -> Result<Vec<ScanDocDto>, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    scan::scan(root)
        .map(|docs| docs.into_iter().map(ScanDocDto::from).collect())
        .map_err(ErrorPayload::from)
}

#[tauri::command]
pub fn vault_stat(state: State<'_, VaultState>, path: String) -> Result<StatDto, ErrorPayload> {
    let slot = state.read();
    let root = root_of(&slot.session)?;
    doc::stat(root, &path)
        .map(StatDto::from)
        .map_err(ErrorPayload::from)
}

/// 删除文档：`trash::delete` 内部先 `paths::resolve` 防越界，再 `gate.enter()`
/// 拦住只读态，任何磁盘动作都发生在两道校验之后。
#[tauri::command]
pub fn vault_remove(
    state: State<'_, VaultState>,
    path: String,
) -> Result<TrashResultDto, ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    let removed = trash::delete(&session.gate, root, &path).map_err(ErrorPayload::from)?;
    note_removed(session, root, &path);
    Ok(TrashResultDto::from(removed))
}

/// 新建目录的会话级实现（CR-20261121-57）：resolve 防越界、已存在报 E_IO、父目录级联创建。
fn mkdir_dir(
    gate: &crate::vault::gate::WriteGate,
    root: &Path,
    rel: &str,
) -> Result<(), ErrorPayload> {
    let _permit = gate.enter().map_err(ErrorPayload::from)?;
    let resolved = paths::resolve(root, rel).map_err(ErrorPayload::from)?;
    if resolved.exists() {
        return Err(ErrorPayload {
            code: "E_IO",
            message: format!("目录或文件已存在：{rel}"),
        });
    }
    std::fs::create_dir_all(&resolved).map_err(|error| ErrorPayload {
        code: "E_IO",
        message: format!("创建目录失败：{rel}：{error}"),
    })?;
    Ok(())
}

/// 新建目录命令（CR-20261121-57）：空目录不进扫描索引（前端 pendingDirs 兜底展示）。
#[tauri::command]
pub fn vault_mkdir(state: State<'_, VaultState>, path: String) -> Result<(), ErrorPayload> {
    let slot = state.read();
    let session = &slot.session;
    let root = root_of(session)?;
    mkdir_dir(&session.gate, root, &path)
}

impl From<doc::ReadDoc> for ReadDocDto {
    fn from(value: doc::ReadDoc) -> Self {
        Self {
            path: value.path,
            text: value.text,
            bytes: value.bytes,
            sha256: value.sha256,
            modified_ms: value.modified_ms,
        }
    }
}

impl From<doc::WriteDoc> for WriteDocDto {
    fn from(value: doc::WriteDoc) -> Self {
        Self {
            path: value.path,
            bytes: value.bytes,
            sha256: value.sha256,
        }
    }
}

impl From<import::ImportOutcome> for ImportDocDto {
    fn from(value: import::ImportOutcome) -> Self {
        match value {
            import::ImportOutcome::Imported(written) => Self {
                status: ImportStatusDto::Imported,
                path: Some(written.path),
                bytes: written.bytes,
                sha: Some(written.sha256),
            },
            import::ImportOutcome::Skipped => Self {
                status: ImportStatusDto::Skipped,
                path: None,
                bytes: 0,
                sha: None,
            },
        }
    }
}

impl From<replace::ReplaceFailure> for ReplaceFailureDto {
    fn from(value: replace::ReplaceFailure) -> Self {
        Self {
            path: value.path,
            code: value.code,
            message: value.message,
        }
    }
}

impl From<replace::ReplaceOutcome> for ReplaceDocDto {
    fn from(value: replace::ReplaceOutcome) -> Self {
        Self {
            status: match value.status {
                replace::ReplaceStatus::Applied => ReplaceStatusDto::Applied,
                replace::ReplaceStatus::RolledBack => ReplaceStatusDto::RolledBack,
                replace::ReplaceStatus::Partial => ReplaceStatusDto::Partial,
            },
            written: value.written,
            restored: value.restored,
            failure: value.failure.map(ReplaceFailureDto::from),
            rollback_errors: value
                .rollback_errors
                .into_iter()
                .map(ReplaceFailureDto::from)
                .collect(),
        }
    }
}

impl From<doc::StatDoc> for StatDto {
    fn from(value: doc::StatDoc) -> Self {
        Self {
            path: value.path,
            bytes: value.bytes,
            sha256: value.sha256,
            modified_ms: value.modified_ms,
        }
    }
}

impl From<scan::DirEntry> for DirEntryDto {
    fn from(value: scan::DirEntry) -> Self {
        Self {
            name: value.name,
            path: value.path,
            kind: EntryKindDto::from(value.kind),
            bytes: value.bytes,
            modified_ms: value.modified_ms,
        }
    }
}

impl From<scan::EntryKind> for EntryKindDto {
    fn from(value: scan::EntryKind) -> Self {
        match value {
            scan::EntryKind::Dir => Self::Dir,
            scan::EntryKind::File => Self::File,
        }
    }
}

impl From<scan::ScanDoc> for ScanDocDto {
    fn from(value: scan::ScanDoc) -> Self {
        Self {
            path: value.path,
            bytes: value.bytes,
            sha256: value.sha256,
            modified_ms: value.modified_ms,
        }
    }
}

#[cfg(test)]
mod reveal_tests {
    use std::ffi::OsStr;
    use std::fs;

    use super::*;

    #[test]
    fn reveal_uses_open_argument_array_without_shell() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let rel = "notes/中文 空格;$HOME.md";
        fs::create_dir(root.join("notes")).unwrap();
        fs::write(root.join(rel), "正文").unwrap();

        let command = reveal_command(root, rel).unwrap();
        let absolute = root.join(rel);
        assert_eq!(command.get_program(), OsStr::new("/usr/bin/open"));
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![OsStr::new("-R"), absolute.as_os_str()]
        );
    }

    #[test]
    fn reveal_rejects_escape_reserved_missing_non_markdown_and_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("note.txt"), "正文").unwrap();
        fs::create_dir(root.join("folder.md")).unwrap();

        for (rel, code) in [
            ("../outside.md", "E_PATH_ESCAPE"),
            (".workbench/secret.md", "E_RESERVED_PATH"),
            ("missing.md", "E_NOT_FOUND"),
            ("note.txt", "E_INVALID_ARG"),
            ("folder.md", "E_NOT_FOUND"),
        ] {
            assert_eq!(reveal_command(root, rel).unwrap_err().code, code, "{rel}");
        }
    }

    #[test]
    fn reveal_checks_child_exit_status() {
        run_reveal(&mut Command::new("/usr/bin/true"), "ok.md").unwrap();
        let error = run_reveal(&mut Command::new("/usr/bin/false"), "bad.md").unwrap_err();
        assert_eq!(error.code, "E_IO");
        assert!(error.message.contains("退出状态"));
    }
}

#[cfg(test)]
mod mkdir_tests {
    use super::*;
    use crate::vault::gate::WriteGate;

    #[test]
    fn mkdir_creates_nested_and_rejects_existing_and_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let gate = WriteGate::new(None);

        mkdir_dir(&gate, &root, "notes/未命名文件夹").unwrap();
        assert!(root.join("notes/未命名文件夹").is_dir());

        let err = mkdir_dir(&gate, &root, "notes/未命名文件夹").unwrap_err();
        assert_eq!(err.code, "E_IO", "重复创建报 E_IO");

        let err = mkdir_dir(&gate, &root, "../escape").unwrap_err();
        assert_ne!(err.code, "E_IO", "越界路径必须被 paths::resolve 拒绝");

        let err = mkdir_dir(&gate, &root, "").unwrap_err();
        assert_eq!(err.code, "E_INVALID_ARG", "空路径拒绝");
    }
}
