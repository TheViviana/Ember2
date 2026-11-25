//! 画布文件内核（CR-20261116-02 提交 1）。
//!
//! 画布固定存放在 `.workbench/canvas/<id>.canvas.json`，命令只接受 `id`，
//! 不接受路径参数；`.workbench` 的保留路径限制保持不变。
//!
//! 本模块只做字节层：id 白名单、原子读写、大小/编码/权限处理与条目分类。
//! 不解析 JSON，不做 schema 校验（P4-C1 的格式层负责）。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::ipc::{BackupCause, VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::constants::MAX_DOC_BYTES;
use crate::vault::doc::modified_ms;
use crate::vault::gate::{self, WriteGate};
use crate::vault::watch::WriteJournal;

/// 画布目录（相对库根）。
pub const CANVAS_DIR: &str = ".workbench/canvas";
/// 画布文件后缀。
pub const CANVAS_SUFFIX: &str = ".canvas.json";
/// v1 升级备份后缀。
pub const BACKUP_SUFFIX: &str = ".v1.bak";

/// id 长度上限（字符数与字节数一致：白名单只允许 ASCII）。
const MAX_ID_LEN: usize = 64;

/// 读取结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadCanvas {
    pub id: String,
    pub path: String,
    pub text: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// 写入结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteCanvas {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// 列表条目的无效原因（CR-20261116-02 §4.4.1，固定四值）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasEntryReason {
    BadId,
    Symlink,
    NotRegularFile,
    IoError,
}

impl CanvasEntryReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BadId => "bad_id",
            Self::Symlink => "symlink",
            Self::NotRegularFile => "not_regular_file",
            Self::IoError => "io_error",
        }
    }
}

/// 列表条目：只带 metadata 可得字段，绝不读文件内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasEntry {
    pub id: String,
    pub valid: bool,
    pub reason: Option<CanvasEntryReason>,
    pub path: Option<String>,
    pub bytes: Option<u64>,
    pub modified_ms: Option<u64>,
}

/// 画布 id 白名单：`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` + Windows 保留名。
pub fn validate_canvas_id(id: &str) -> VaultResult<()> {
    let bytes = id.as_bytes();
    let shaped = !bytes.is_empty()
        && bytes.len() <= MAX_ID_LEN
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-');
    if !shaped || is_windows_reserved(id) {
        return Err(VaultError::BadId);
    }
    Ok(())
}

fn is_windows_reserved(id: &str) -> bool {
    let upper = id.to_ascii_uppercase();
    if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = upper.as_bytes();
    bytes.len() == 4
        && (upper.starts_with("COM") || upper.starts_with("LPT"))
        && matches!(bytes[3], b'1'..=b'9')
}

/// 画布文件的绝对路径；调用前必须已通过 `validate_canvas_id`。
pub fn canvas_path(root: &Path, id: &str) -> PathBuf {
    root.join(".workbench")
        .join("canvas")
        .join(format!("{id}{CANVAS_SUFFIX}"))
}

fn canvas_rel(id: &str) -> String {
    format!("{CANVAS_DIR}/{id}{CANVAS_SUFFIX}")
}

fn backup_path(path: &Path, id: &str) -> PathBuf {
    path.with_file_name(format!("{id}{CANVAS_SUFFIX}{BACKUP_SUFFIX}"))
}

/// 读画布：只接受普通文件，符号链接一律按不存在处理（不写穿、不跟随）。
pub fn read(root: &Path, id: &str) -> VaultResult<ReadCanvas> {
    validate_canvas_id(id)?;
    reject_directory_symlink(root, false)?;
    let path = canvas_path(root, id);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => return Err(map_read_io(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(VaultError::NotFound);
    }
    if metadata.len() > MAX_DOC_BYTES {
        return Err(VaultError::TooLarge);
    }
    let bytes = fs::read(&path).map_err(map_read_io)?;
    if bytes.len() as u64 > MAX_DOC_BYTES {
        return Err(VaultError::TooLarge);
    }
    let text = String::from_utf8(bytes).map_err(|_| VaultError::Encoding)?;
    Ok(ReadCanvas {
        id: id.to_string(),
        path: canvas_rel(id),
        sha256: atomic::hex_sha256(text.as_bytes()),
        bytes: text.len() as u64,
        text,
        modified_ms: modified_ms(&metadata),
    })
}

/// 写画布：锁内顺序为「expectedSha 复核 → 备份 → 原子写主文件」。
///
/// `expected_sha` 三态：`None` 不校验；`Some("")` 期望不存在；`Some(hex)` 期望精确相等。
pub fn write(
    gate: &WriteGate,
    writes: &WriteJournal,
    root: &Path,
    id: &str,
    text: &str,
    expected_sha: Option<&str>,
    backup_v1: bool,
) -> VaultResult<WriteCanvas> {
    validate_canvas_id(id)?;
    if text.len() as u64 > MAX_DOC_BYTES {
        return Err(VaultError::TooLarge);
    }
    let path = canvas_path(root, id);
    let _permit = gate.enter()?;
    reject_directory_symlink(root, true)?;
    reject_target_symlink(&path)?;
    verify_expected(&path, expected_sha)?;
    if backup_v1 {
        backup_once(&path, id)?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| map_write_io(gate, error))?;
    }
    let written = atomic::write_atomic(&path, text.as_bytes())
        .map_err(|error| map_write_vault(gate, error))?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| map_write_io(gate, error))?;
    let rel = canvas_rel(id);
    writes.note_write(&rel, &written.sha256);
    Ok(WriteCanvas {
        id: id.to_string(),
        path: rel,
        bytes: written.bytes,
        sha256: written.sha256,
        modified_ms: modified_ms(&metadata),
    })
}

/// 列出画布目录单层条目；非法 id / 符号链接 / 特殊文件分类为 `valid:false`。
///
/// 只调用一次 `symlink_metadata`，不 `open`、不读内容、不计算 sha256。
pub fn list_entries(root: &Path) -> VaultResult<Vec<CanvasEntry>> {
    let dir = root.join(".workbench").join("canvas");
    reject_directory_symlink(root, false)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let reader = match fs::read_dir(&dir) {
        Ok(reader) => reader,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(map_read_io(error)),
    };
    let mut entries = Vec::new();
    for item in reader {
        let item = item.map_err(map_read_io)?;
        let file_name = item.file_name();
        let Some(name) = file_name.to_str() else {
            // 非 UTF-8 文件名按既有策略跳过。
            continue;
        };
        let metadata = fs::symlink_metadata(item.path());
        if let Some(entry) = classify_canvas_entry(name, metadata) {
            entries.push(entry);
        }
    }
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(entries)
}

/// 纯分类函数：文件名 + `symlink_metadata` 结果 → 条目（或跳过）。
///
/// 判定顺序（K1）：后缀/隐藏过滤 → `bad_id`（纯字符串）→ `symlink` →
/// `not_regular_file` → `io_error`。`bad_id` 优先于磁盘结果。
pub fn classify_canvas_entry(
    name: &str,
    metadata: io::Result<fs::Metadata>,
) -> Option<CanvasEntry> {
    let id = name.strip_suffix(CANVAS_SUFFIX)?;
    if id.is_empty() || name.starts_with('.') {
        return None;
    }
    let path = Some(canvas_rel(id));
    let (modified, metadata) = match metadata {
        Ok(metadata) => (Some(modified_ms(&metadata)), Some(metadata)),
        Err(_) => (None, None),
    };
    if validate_canvas_id(id).is_err() {
        return Some(CanvasEntry {
            id: id.to_string(),
            valid: false,
            reason: Some(CanvasEntryReason::BadId),
            path,
            bytes: None,
            modified_ms: modified,
        });
    }
    let Some(metadata) = metadata else {
        return Some(CanvasEntry {
            id: id.to_string(),
            valid: false,
            reason: Some(CanvasEntryReason::IoError),
            path,
            bytes: None,
            modified_ms: None,
        });
    };
    let reason = if metadata.file_type().is_symlink() {
        Some(CanvasEntryReason::Symlink)
    } else if !metadata.file_type().is_file() {
        Some(CanvasEntryReason::NotRegularFile)
    } else {
        None
    };
    Some(match reason {
        Some(reason) => CanvasEntry {
            id: id.to_string(),
            valid: false,
            reason: Some(reason),
            path,
            bytes: None,
            modified_ms: modified,
        },
        None => CanvasEntry {
            id: id.to_string(),
            valid: true,
            reason: None,
            path,
            bytes: Some(metadata.len()),
            modified_ms: modified,
        },
    })
}

/// `vault_remove` 专用的单层画布路径解析；其它路径返回 `None`，继续走通用规则。
///
/// 这里只做字符串与路径形状校验，不触碰磁盘。bad-id 普通文件也可定位，但隐藏名、
/// 额外路径段、非 `.canvas.json` 文件和其它 `.workbench` 内容均不获得保留路径例外。
pub(crate) fn canvas_removal_path(root: &Path, rel: &str) -> VaultResult<Option<PathBuf>> {
    let prefix = format!("{CANVAS_DIR}/");
    let Some(name) = rel.strip_prefix(&prefix) else {
        return Ok(None);
    };
    if name.contains('/') || name.contains('\\') {
        return Err(VaultError::PathEscape);
    }
    let Some(id) = name.strip_suffix(CANVAS_SUFFIX) else {
        return Err(VaultError::ReservedPath);
    };
    if id.is_empty() || name.starts_with('.') {
        return Err(VaultError::ReservedPath);
    }
    Ok(Some(root.join(CANVAS_DIR).join(name)))
}

/// 删除前复核两级父目录，符号链接和非目录一律 fail closed。
pub(crate) fn reject_canvas_removal_directory_symlink(root: &Path) -> VaultResult<()> {
    reject_directory_symlink(root, true)
}

/// `.workbench` / `.workbench/canvas` 命中符号链接或非目录时拒绝。
///
/// 写路径是**策略拒绝**（不跟随、不写穿），统一 `E_PERM`，与底层 I/O 故障区分；
/// 读路径按「目标不存在」处理（`E_NOT_FOUND`，CR §3.4）。
fn reject_directory_symlink(root: &Path, for_write: bool) -> VaultResult<()> {
    let base = root.join(".workbench");
    let dir = base.join("canvas");
    for path in [&base, &dir] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(if for_write {
                    VaultError::Perm
                } else {
                    VaultError::NotFound
                });
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(if for_write {
                    VaultError::Perm
                } else {
                    VaultError::NotFound
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(if for_write {
                    map_write_io_detached(error)
                } else {
                    map_read_io(error)
                });
            }
        }
    }
    Ok(())
}

/// 写入口目标：符号链接或非普通文件一律拒绝，绝不写穿。
///
/// 这是**策略拒绝**，返回 `E_PERM`（CR §8.2），使前端能把它与真正的
/// `E_IO` 故障区分开。
fn reject_target_symlink(path: &Path) -> VaultResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(VaultError::Perm),
        Ok(metadata) if !metadata.file_type().is_file() => Err(VaultError::Perm),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(map_write_io_detached(error)),
    }
}

/// expectedSha 三态复核：在备份与主写之前读取当前内容并比对。
fn verify_expected(path: &Path, expected_sha: Option<&str>) -> VaultResult<()> {
    let Some(expected) = expected_sha else {
        return Ok(());
    };
    // expectedSha 复核是验证性读取：单文件权限错误只报 E_IO，不闩锁全库。
    let current = match fs::symlink_metadata(path) {
        Ok(_) => {
            let bytes = fs::read(path).map_err(VaultError::Io)?;
            Some(atomic::hex_sha256(&bytes))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(VaultError::Io(error)),
    };
    let mismatch = match (expected.is_empty(), &current) {
        (true, None) => false,
        (true, Some(_)) => true,
        (false, None) => true,
        (false, Some(sha)) => sha != expected,
    };
    if mismatch {
        return Err(VaultError::Conflict {
            current_sha: current,
        });
    }
    Ok(())
}

/// `.v1.bak` 只增不删：首次备份旧内容，已存在则保留首份。
fn backup_once(path: &Path, id: &str) -> VaultResult<()> {
    let backup = backup_path(path, id);
    match fs::symlink_metadata(&backup) {
        Ok(metadata) if metadata.file_type().is_file() => return Ok(()),
        Ok(_) => {
            return Err(VaultError::BackupFailed {
                cause: BackupCause::Io,
            });
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(VaultError::BackupFailed {
                cause: BackupCause::from_io(&error),
            });
        }
    }
    let current = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => fs::read(path),
        Ok(_) => {
            return Err(VaultError::BackupFailed {
                cause: BackupCause::Io,
            });
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(VaultError::BackupFailed {
                cause: BackupCause::from_io(&error),
            });
        }
    };
    let bytes = current.map_err(|error| VaultError::BackupFailed {
        cause: BackupCause::from_io(&error),
    })?;
    atomic::write_atomic(&backup, &bytes).map_err(|error| {
        let cause = match error {
            VaultError::Io(error) => BackupCause::from_io(&error),
            VaultError::DiskFull => BackupCause::NoSpace,
            _ => BackupCause::Io,
        };
        VaultError::BackupFailed { cause }
    })?;
    Ok(())
}

/// 读路径错误映射（§8.2）：权限类分别落到 `E_READONLY` / `E_PERM`。
fn map_read_io(error: io::Error) -> VaultError {
    if error.kind() == io::ErrorKind::NotFound {
        VaultError::NotFound
    } else if gate::is_readonly_io(&error) {
        VaultError::Readonly
    } else if error.kind() == io::ErrorKind::PermissionDenied {
        VaultError::Perm
    } else {
        VaultError::Io(error)
    }
}

fn map_write_io(gate: &WriteGate, error: io::Error) -> VaultError {
    downgrade_perm(gate::map_write_error(gate, error))
}

fn map_write_vault(gate: &WriteGate, error: VaultError) -> VaultError {
    downgrade_perm(gate::map_write_result(gate, error))
}

fn map_write_io_detached(error: io::Error) -> VaultError {
    downgrade_perm(if gate::is_readonly_io(&error) {
        VaultError::Readonly
    } else {
        error.into()
    })
}

/// `EPERM` 等剩余权限错误 → `E_PERM`；`EACCES`/`EROFS` 已在上游转为 `E_READONLY`。
fn downgrade_perm(error: VaultError) -> VaultError {
    match error {
        VaultError::Io(io_error) if io_error.kind() == io::ErrorKind::PermissionDenied => {
            VaultError::Perm
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[cfg(unix)]
    use std::time::Instant;

    use tempfile::tempdir;

    use super::*;
    use crate::ipc::ReadonlyReason;

    fn gate() -> WriteGate {
        WriteGate::new(None)
    }

    fn journal() -> WriteJournal {
        WriteJournal::default()
    }

    fn seed_canvas(root: &Path, id: &str, bytes: &[u8]) {
        let path = canvas_path(root, id);
        fs::create_dir_all(path.parent().expect("canvas dir")).expect("canvas dir");
        fs::write(path, bytes).expect("seed");
    }

    fn error_code(result: VaultResult<impl std::fmt::Debug>) -> &'static str {
        result.expect_err("应失败").code()
    }

    #[test]
    fn accepts_whitelisted_ids() {
        for id in ["a", "A0", "0", "01H8XYZ", "canvas_1", "a-b-c", "Z9_z-"] {
            assert!(validate_canvas_id(id).is_ok(), "应接受：{id}");
        }
        let longest = "a".repeat(64);
        assert!(validate_canvas_id(&longest).is_ok(), "64 字符应接受");
    }

    #[test]
    fn rejects_invalid_ids() {
        let too_long = "a".repeat(65);
        let cases = [
            "", ".", "..", "../x", "..\\x", "/abs", "a/b", "a\\b", ".hidden", "-leading", "trail ",
            "trail.", "a b", "a.b", "a?b", "a%b", "a:b", "a\0b", "a\nb", "CON", "con", "PRN",
            "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9",
        ];
        for id in cases {
            assert_eq!(
                validate_canvas_id(id).expect_err(id).code(),
                "E_BAD_ID",
                "应拒绝：{id:?}"
            );
        }
        assert_eq!(
            validate_canvas_id(&too_long).expect_err("65 字符").code(),
            "E_BAD_ID"
        );
    }

    /// S1：长度上限是**闭区间**，63 与 64 合法，65 非法。
    #[test]
    fn id_length_is_closed_interval() {
        for len in [1, 63, 64] {
            let id = "a".repeat(len);
            assert!(
                validate_canvas_id(&id).is_ok(),
                "{len} 字符应接受（上限含 64）"
            );
        }
        let over = "a".repeat(65);
        assert_eq!(
            validate_canvas_id(&over).expect_err("65 字符").code(),
            "E_BAD_ID",
            "65 字符必须拒绝，证明上限是闭区间"
        );
    }

    #[test]
    fn read_and_write_reject_bad_id_before_touching_disk() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        assert_eq!(
            error_code(read(dir.path(), "a.b")),
            "E_BAD_ID",
            "读取入口必须先校验 id"
        );
        assert_eq!(
            error_code(write(&gate, &writes, dir.path(), "../x", "{}", None, false)),
            "E_BAD_ID"
        );
        assert!(!dir.path().join(".workbench").exists(), "非法 id 不得触盘");
    }

    #[test]
    fn roundtrip_writes_and_reads_same_bytes() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        let text = r#"{"version":1}"#;
        let written =
            write(&gate, &writes, dir.path(), "01H8XYZ", text, Some(""), false).expect("write");
        assert_eq!(written.path, ".workbench/canvas/01H8XYZ.canvas.json");
        assert_eq!(written.bytes, text.len() as u64);
        assert_eq!(written.sha256, atomic::hex_sha256(text.as_bytes()));

        let read_back = read(dir.path(), "01H8XYZ").expect("read");
        assert_eq!(read_back.text, text);
        assert_eq!(read_back.sha256, written.sha256);
        assert_eq!(read_back.bytes, written.bytes);
        assert_eq!(read_back.path, written.path);
        assert!(read_back.modified_ms > 0);
    }

    #[test]
    fn expected_sha_tristate() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();

        // None：不校验，可创建也可覆盖
        write(&gate, &writes, dir.path(), "one", "v1", None, false).expect("create");
        write(&gate, &writes, dir.path(), "one", "v2", None, false).expect("overwrite");

        // Some("")：期望不存在
        let conflict = write(&gate, &writes, dir.path(), "one", "v3", Some(""), false)
            .expect_err("已存在应冲突");
        assert_eq!(conflict.code(), "E_CONFLICT");
        let payload = crate::ipc::canvas::CanvasErrorPayload::from(conflict);
        assert!(payload.current_sha.is_some(), "冲突需回传当前 sha");

        // Some(hex)：精确匹配才允许
        let current = atomic::hex_sha256(b"v2");
        write(
            &gate,
            &writes,
            dir.path(),
            "one",
            "v4",
            Some(&current),
            false,
        )
        .expect("匹配");

        // Some(hex) 但文件已变
        let stale = atomic::hex_sha256(b"v2");
        let conflict = write(&gate, &writes, dir.path(), "one", "v5", Some(&stale), false)
            .expect_err("sha 不等应冲突");
        assert_eq!(conflict.code(), "E_CONFLICT");

        // Some(hex) 但文件不存在
        let conflict = write(
            &gate,
            &writes,
            dir.path(),
            "missing",
            "v1",
            Some(&current),
            false,
        )
        .expect_err("不存在应冲突");
        let payload = crate::ipc::canvas::CanvasErrorPayload::from(conflict);
        assert_eq!(payload.code, "E_CONFLICT");
        assert!(payload.current_sha.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn conditional_write_verification_io_does_not_latch_gate() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let gate = gate();
        let writes = journal();
        seed_canvas(root, "locked", b"old");
        let expected = atomic::hex_sha256(b"old");
        let locked = canvas_path(root, "locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod 000");

        let result = write(
            &gate,
            &writes,
            root,
            "locked",
            "new",
            Some(&expected),
            false,
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).expect("restore");
        let error = result.expect_err("验证性读取失败");
        let other = write(&gate, &writes, root, "other", "writable", None, false);

        assert_eq!(error.code(), "E_IO");
        assert!(gate.readonly_reason().is_none(), "单画布不可读不得闩锁全库");
        other.expect("另一画布必须仍可写");
        assert_eq!(read(root, "other").expect("read").text, "writable");
    }

    #[test]
    fn backup_keeps_first_copy_only() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        write(&gate, &writes, dir.path(), "c1", "v1", Some(""), false).expect("v1");
        write(&gate, &writes, dir.path(), "c1", "v2", None, true).expect("v2");
        let backup = dir
            .path()
            .join(format!("{CANVAS_DIR}/c1{CANVAS_SUFFIX}{BACKUP_SUFFIX}"));
        assert_eq!(fs::read(&backup).expect("bak"), b"v1");

        write(&gate, &writes, dir.path(), "c1", "v3", None, true).expect("v3");
        assert_eq!(fs::read(&backup).expect("bak"), b"v1", "首份备份不被覆盖");
    }

    #[test]
    fn backup_failure_leaves_main_untouched() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        write(&gate, &writes, dir.path(), "c2", "v1", Some(""), false).expect("v1");
        let backup = dir
            .path()
            .join(format!("{CANVAS_DIR}/c2{CANVAS_SUFFIX}{BACKUP_SUFFIX}"));
        fs::create_dir_all(&backup).expect("占用备份路径");

        let error =
            write(&gate, &writes, dir.path(), "c2", "v2", None, true).expect_err("备份失败应拒绝");
        assert_eq!(error.code(), "E_BACKUP_FAILED");
        let payload = crate::ipc::canvas::CanvasErrorPayload::from(error);
        assert!(payload.cause.is_some(), "备份失败需带 cause");
        assert_eq!(
            fs::read(canvas_path(dir.path(), "c2")).expect("main"),
            b"v1"
        );
    }

    #[test]
    fn enforces_document_size_boundary() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        let exact = "a".repeat(MAX_DOC_BYTES as usize);
        write(&gate, &writes, dir.path(), "exact", &exact, Some(""), false).expect("16 MiB");

        let over = "a".repeat(MAX_DOC_BYTES as usize + 1);
        let error = write(&gate, &writes, dir.path(), "over", &over, Some(""), false)
            .expect_err("超限应拒绝");
        assert_eq!(error.code(), "E_TOO_LARGE");
        assert!(!canvas_path(dir.path(), "over").exists(), "超限不得落盘");

        let read_over = read(dir.path(), "exact");
        assert!(read_over.is_ok());
        seed_canvas(dir.path(), "huge", &vec![b'x'; MAX_DOC_BYTES as usize + 1]);
        assert_eq!(error_code(read(dir.path(), "huge")), "E_TOO_LARGE");
    }

    #[test]
    fn non_utf8_reads_as_encoding_error() {
        let dir = tempdir().expect("tempdir");
        seed_canvas(dir.path(), "raw", &[0xff, 0xfe, 0x00, 0x01]);
        assert_eq!(error_code(read(dir.path(), "raw")), "E_ENCODING");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_target_is_never_followed() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        let canvas_dir = dir.path().join(CANVAS_DIR);
        fs::create_dir_all(&canvas_dir).expect("canvas dir");
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, b"secret").expect("outside");
        symlink(&outside, canvas_dir.join("link.canvas.json")).expect("symlink");

        assert_eq!(error_code(read(dir.path(), "link")), "E_NOT_FOUND");
        assert_eq!(
            error_code(write(&gate, &writes, dir.path(), "link", "{}", None, false)),
            "E_PERM",
            "写目标为符号链接是策略拒绝，不得与 E_IO 混淆"
        );
        assert_eq!(fs::read(&outside).expect("outside"), b"secret", "不得写穿");
    }

    /// M2：画布目录本身是符号链接时，写路径拒绝且返回 `E_PERM`，读路径按不存在处理。
    #[cfg(unix)]
    #[test]
    fn symlink_canvas_dir_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let gate = gate();
        let writes = journal();
        let outside = dir.path().join("outside_dir");
        fs::create_dir_all(&outside).expect("outside dir");
        fs::create_dir_all(dir.path().join(".workbench")).expect(".workbench");
        symlink(&outside, dir.path().join(".workbench").join("canvas")).expect("symlink");

        assert_eq!(error_code(read(dir.path(), "c1")), "E_NOT_FOUND");
        assert_eq!(
            error_code(write(&gate, &writes, dir.path(), "c1", "{}", None, false)),
            "E_PERM"
        );
        assert!(
            fs::read_dir(&outside)
                .expect("outside dir")
                .next()
                .is_none(),
            "不得写穿符号链接目录"
        );
    }

    /// S2：只读闩锁在**磁盘之前**拒绝，与 `WriteGate` 全局互斥门无关。
    #[test]
    fn readonly_library_rejects_write_before_disk() {
        let dir = tempdir().expect("tempdir");
        let gate = WriteGate::new(Some(ReadonlyReason::LockedByOther));
        let writes = journal();
        assert_eq!(
            error_code(write(&gate, &writes, dir.path(), "c1", "{}", None, false)),
            "E_READONLY"
        );
        assert!(!canvas_path(dir.path(), "c1").exists());
    }

    #[test]
    fn list_classifies_entries_without_reading_content() {
        let dir = tempdir().expect("tempdir");
        let canvas_dir = dir.path().join(CANVAS_DIR);
        fs::create_dir_all(&canvas_dir).expect("canvas dir");
        fs::write(dir.path().join("notes.md"), b"x").expect("md");
        fs::write(canvas_dir.join(".hidden.canvas.json"), b"{}").expect("hidden");
        fs::write(canvas_dir.join("01H8XYZ.canvas.json"), b"{}").expect("ok");
        fs::write(canvas_dir.join("a.b.canvas.json"), b"{}").expect("bad");
        fs::write(canvas_dir.join("01H8XYZ.canvas.json.v1.bak"), b"{}").expect("bak");

        let entries = list_entries(dir.path()).expect("list");
        assert_eq!(entries.len(), 2, "隐藏项与 .v1.bak 必须跳过");
        let valid = &entries[0];
        assert_eq!(valid.id, "01H8XYZ");
        assert!(valid.valid);
        assert_eq!(
            valid.path.as_deref(),
            Some(".workbench/canvas/01H8XYZ.canvas.json")
        );
        assert!(valid.bytes.is_some());
        assert!(valid.modified_ms.is_some());

        let bad = &entries[1];
        assert_eq!(bad.id, "a.b");
        assert!(!bad.valid);
        assert_eq!(bad.reason, Some(CanvasEntryReason::BadId));
        assert_eq!(
            bad.path.as_deref(),
            Some(".workbench/canvas/a.b.canvas.json"),
            "bad-id 普通文件仍提供专用删除路径"
        );
        assert!(bad.bytes.is_none(), "非法条目不得带 bytes");
        assert!(bad.modified_ms.is_some(), "metadata 可得时带 modifiedMs");
    }

    #[cfg(unix)]
    #[test]
    fn twenty_megabyte_bad_id_is_not_read() {
        let dir = tempdir().expect("tempdir");
        let canvas_dir = dir.path().join(CANVAS_DIR);
        fs::create_dir_all(&canvas_dir).expect("canvas dir");
        let path = canvas_dir.join("a.b.canvas.json");
        fs::write(&path, vec![b'r'; 20 * 1024 * 1024]).expect("seed 20 MiB");
        let locked = fs::Permissions::from_mode(0o000);
        fs::set_permissions(&path, locked).expect("chmod");

        // 主断言：分类阶段未 open —— 内容不可读时仍返回 bad_id 而非 io_error。
        let entries = list_entries(dir.path()).expect("list");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("restore");
        let entry = entries
            .iter()
            .find(|item| item.id == "a.b")
            .expect("bad entry");
        assert_eq!(entry.reason, Some(CanvasEntryReason::BadId));
        assert!(entry.modified_ms.is_some(), "metadata 不读内容");
        assert_eq!(
            entry.path.as_deref(),
            Some(".workbench/canvas/a.b.canvas.json")
        );
        assert!(entry.bytes.is_none());

        // 软时间断言：慢盘只告警，不 fail（K3）。
        let started = Instant::now();
        let entries = list_entries(dir.path()).expect("list again");
        let elapsed = started.elapsed();
        assert!(entries.iter().any(|item| item.id == "a.b"));
        if elapsed.as_millis() > 100 {
            eprintln!("warning: list_entries 超过 100ms（软断言）：{elapsed:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn list_classifies_symlinks_and_non_regular_files() {
        let dir = tempdir().expect("tempdir");
        let canvas_dir = dir.path().join(CANVAS_DIR);
        fs::create_dir_all(&canvas_dir).expect("canvas dir");
        fs::write(canvas_dir.join("ok.canvas.json"), b"{}").expect("ok");
        let outside = dir.path().join("outside.canvas.json");
        fs::write(&outside, vec![b'x'; 1024]).expect("outside");
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o000)).expect("chmod outside");
        let target_dir = dir.path().join("target_dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        // 场景 1：指向画布目录外文件
        symlink(&outside, canvas_dir.join("outside.canvas.json")).expect("link outside");
        // 场景 2：指向目录
        symlink(&target_dir, canvas_dir.join("dir.canvas.json")).expect("link dir");
        // 场景 3：损坏链接
        symlink(
            dir.path().join("missing"),
            canvas_dir.join("broken.canvas.json"),
        )
        .expect("link");
        // 场景 4：真实目录
        fs::create_dir_all(canvas_dir.join("x.canvas.json")).expect("dir entry");
        // FIFO
        let fifo = canvas_dir.join("pipe.canvas.json");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo");
        assert!(status.success(), "mkfifo 应成功");

        let entries = list_entries(dir.path()).expect("list");
        fs::set_permissions(&outside, fs::Permissions::from_mode(0o600)).expect("restore");

        let reason = |id: &str| {
            entries
                .iter()
                .find(|item| item.id == id)
                .unwrap_or_else(|| panic!("缺少条目 {id}"))
                .reason
        };
        assert_eq!(reason("outside"), Some(CanvasEntryReason::Symlink));
        assert_eq!(reason("dir"), Some(CanvasEntryReason::Symlink));
        assert_eq!(reason("broken"), Some(CanvasEntryReason::Symlink));
        assert_eq!(
            reason("x"),
            Some(CanvasEntryReason::NotRegularFile),
            "目录不得判为 symlink"
        );
        assert_eq!(reason("pipe"), Some(CanvasEntryReason::NotRegularFile));
        assert!(
            entries.iter().any(|item| item.id == "ok" && item.valid),
            "合法条目不受影响"
        );
        assert!(entries
            .iter()
            .filter(|item| item.id != "ok")
            .all(|item| !item.valid));
        assert!(entries
            .iter()
            .filter(|item| item.id != "ok")
            .all(|item| item.path.is_some() && item.bytes.is_none()));
        let _ = fs::remove_file(&fifo);
    }

    #[test]
    fn classify_io_error_is_pure_and_bad_id_wins() {
        let entry = classify_canvas_entry(
            "ok.canvas.json",
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "denied")),
        )
        .expect("条目");
        assert!(!entry.valid);
        assert_eq!(entry.reason, Some(CanvasEntryReason::IoError));
        assert!(entry.modified_ms.is_none());

        let entry =
            classify_canvas_entry("a.b.canvas.json", Err(io::Error::other("boom"))).expect("条目");
        assert_eq!(
            entry.reason,
            Some(CanvasEntryReason::BadId),
            "K1：bad_id 优先于磁盘结果"
        );

        assert!(classify_canvas_entry("notes.md", Err(io::Error::other("x"))).is_none());
        assert!(classify_canvas_entry(".hidden.canvas.json", Err(io::Error::other("x"))).is_none());
        assert!(classify_canvas_entry(".canvas.json", Err(io::Error::other("x"))).is_none());
        assert_eq!(
            entry.path.as_deref(),
            Some(".workbench/canvas/a.b.canvas.json"),
            "metadata 失败也保留条目真实路径，但不伪造 bytes"
        );
    }

    #[test]
    fn removal_path_only_accepts_exact_single_level_canvas_files() {
        let root = Path::new("/vault");
        assert_eq!(
            canvas_removal_path(root, ".workbench/canvas/bad.id.canvas.json")
                .expect("bad-id 普通文件可定位"),
            Some(root.join(".workbench/canvas/bad.id.canvas.json"))
        );
        assert_eq!(
            canvas_removal_path(root, "notes/a.md").expect("普通文档走通用解析"),
            None
        );
        assert_eq!(
            canvas_removal_path(root, ".workbench/settings.json").expect("其它保留路径走通用解析"),
            None
        );

        for (rel, code) in [
            (".workbench/canvas/nested/a.canvas.json", "E_PATH_ESCAPE"),
            (".workbench/canvas/../settings.json", "E_PATH_ESCAPE"),
            (".workbench/canvas/a\\b.canvas.json", "E_PATH_ESCAPE"),
            (".workbench/canvas/.hidden.canvas.json", "E_RESERVED_PATH"),
            (".workbench/canvas/not-canvas.json", "E_RESERVED_PATH"),
        ] {
            let error = canvas_removal_path(root, rel).expect_err(rel);
            assert_eq!(error.code(), code, "路径 {rel} 判定漂移");
        }
    }
}
