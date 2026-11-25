use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::constants::MAX_DOC_BYTES;
use crate::vault::gate::{self, WriteGate, WritePermit};
use crate::vault::paths;

/// 读取结果：正文 + 元数据（hash 与 stat 同源）。
#[derive(Debug, Clone)]
pub struct ReadDoc {
    pub path: String,
    pub text: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// 写入/改名结果。
#[derive(Debug, Clone)]
pub struct WriteDoc {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// 文件元数据。
#[derive(Debug, Clone)]
pub struct StatDoc {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// 读文档。只接受库内普通文件；非 UTF-8 报 `E_INVALID_ARG`，不做替换降级。
pub fn read(root: &Path, rel: &str) -> VaultResult<ReadDoc> {
    let path = paths::resolve(root, rel)?;
    let metadata = fs::symlink_metadata(&path).map_err(not_found_or)?;
    if !metadata.file_type().is_file() {
        return Err(VaultError::NotFound);
    }
    let bytes = fs::read(&path).map_err(not_found_or)?;
    let length = bytes.len() as u64;
    let text = String::from_utf8(bytes)
        .map_err(|_| VaultError::InvalidArg(format!("不是合法 UTF-8：{rel}")))?;
    Ok(ReadDoc {
        path: paths::to_rel(root, &path)?,
        sha256: atomic::hex_sha256(text.as_bytes()),
        text,
        bytes: length,
        modified_ms: modified_ms(&metadata),
    })
}

/// 写文档。只接受 `.md`（忽略大小写），超 16 MiB 不落盘；
/// 写权限经由 `WriteGate`，只读态直接 `E_READONLY`。
/// `expected_sha` 非空时，取得写许可后先复核当前文件，避免覆盖裁决后的外部变更。
pub fn write(
    gate: &WriteGate,
    root: &Path,
    rel: &str,
    text: &str,
    expected_sha: Option<&str>,
) -> VaultResult<WriteDoc> {
    let path = prepare_write(root, rel, text)?;
    let permit = gate.enter()?;
    write_prepared(gate, root, rel, &path, text, expected_sha, &permit)
}

/// 批量事务使用的写入口：调用者必须已经持有同一个 permit，避免重入写闸门。
pub(crate) fn write_with_permit(
    gate: &WriteGate,
    root: &Path,
    rel: &str,
    text: &str,
    expected_sha: Option<&str>,
    permit: &WritePermit<'_>,
) -> VaultResult<WriteDoc> {
    let path = prepare_write(root, rel, text)?;
    write_prepared(gate, root, rel, &path, text, expected_sha, permit)
}

pub(crate) fn prepare_write(root: &Path, rel: &str, text: &str) -> VaultResult<PathBuf> {
    ensure_markdown(rel)?;
    if text.len() as u64 > MAX_DOC_BYTES {
        return Err(VaultError::InvalidArg(format!(
            "正文超过 {MAX_DOC_BYTES} 字节上限"
        )));
    }
    paths::resolve(root, rel)
}

fn write_prepared(
    gate: &WriteGate,
    root: &Path,
    rel: &str,
    path: &Path,
    text: &str,
    expected_sha: Option<&str>,
    _permit: &WritePermit<'_>,
) -> VaultResult<WriteDoc> {
    if let Some(expected) = expected_sha {
        match stat(root, rel) {
            Ok(current) => {
                if expected.is_empty() || current.sha256 != expected {
                    return Err(VaultError::InvalidArg("文档已在写入前发生变化".to_string()));
                }
            }
            Err(VaultError::NotFound) => {
                if !expected.is_empty() {
                    return Err(VaultError::InvalidArg("文档已在写入前发生变化".to_string()));
                }
            }
            // expectedSha 复核是验证性读取：单文件 EACCES 只报 E_IO，不闩锁全库。
            Err(VaultError::Io(error)) => return Err(VaultError::Io(error)),
            Err(error) => return Err(error),
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| gate::map_write_error(gate, error))?;
    }
    let written = atomic::write_atomic(path, text.as_bytes())
        .map_err(|error| gate::map_write_result(gate, error))?;
    Ok(WriteDoc {
        path: paths::to_rel(root, path)?,
        bytes: written.bytes,
        sha256: written.sha256,
    })
}

/// 改名（同库内移动）。普通文件用 `hard_link` + `unlink`，目标已存在时原子失败，
/// 绝不静默覆盖外部编辑器新建的文件；目录（CR-20261122-64）用 `rename`，移动前
/// 显式确认目标不存在，跨卷失败时保留源目录、不做递归复制。
pub fn rename(gate: &WriteGate, root: &Path, from: &str, to: &str) -> VaultResult<WriteDoc> {
    let source = paths::resolve(root, from)?;
    let target = paths::resolve(root, to)?;
    let _permit = gate.enter()?;
    let metadata = fs::symlink_metadata(&source).map_err(not_found_or)?;
    let file_type = metadata.file_type();
    if file_type.is_dir() {
        return rename_directory(gate, root, &source, &target, to);
    }
    ensure_markdown(to)?;
    if !file_type.is_file() {
        return Err(VaultError::NotFound);
    }
    if source == target {
        return stat(root, to).map(|value| WriteDoc {
            path: value.path,
            bytes: value.bytes,
            sha256: value.sha256,
        });
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| gate::map_write_error(gate, error))?;
    }
    match fs::hard_link(&source, &target) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(VaultError::InvalidArg(format!("目标已存在：{to}")));
        }
        Err(error) => return Err(gate::map_write_error(gate, error)),
    }
    if let Err(error) = fs::remove_file(&source) {
        // 回滚：不能留下两份同名内容
        let _ = fs::remove_file(&target);
        return Err(gate::map_write_error(gate, error));
    }
    stat(root, to).map(|value| WriteDoc {
        path: value.path,
        bytes: value.bytes,
        sha256: value.sha256,
    })
}

/// 目录改名：只允许普通目录，目标必须不存在，不能移动到自身内部。
///
/// 目录结果没有单文件 sha，`bytes` / `sha256` 固定为零值；前端不使用这两个字段。
fn rename_directory(
    gate: &WriteGate,
    root: &Path,
    source: &Path,
    target: &Path,
    to: &str,
) -> VaultResult<WriteDoc> {
    if source == target {
        return Ok(WriteDoc {
            path: paths::to_rel(root, target)?,
            bytes: 0,
            sha256: String::new(),
        });
    }
    if target.starts_with(source) {
        return Err(VaultError::InvalidArg(
            "不能把文件夹移动到自身内部".to_string(),
        ));
    }
    match fs::symlink_metadata(target) {
        Ok(_) => return Err(VaultError::InvalidArg(format!("目标已存在：{to}"))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(gate::map_write_error(gate, error)),
    }
    if target.parent().is_some_and(|parent| !parent.is_dir()) {
        return Err(VaultError::NotFound);
    }
    fs::rename(source, target).map_err(|error| gate::map_write_error(gate, error))?;
    Ok(WriteDoc {
        path: paths::to_rel(root, target)?,
        bytes: 0,
        sha256: String::new(),
    })
}

/// stat：只接受普通文件，返回与 `write` 同源的 sha256。
pub fn stat(root: &Path, rel: &str) -> VaultResult<StatDoc> {
    let path = paths::resolve(root, rel)?;
    let metadata = fs::symlink_metadata(&path).map_err(not_found_or)?;
    if !metadata.file_type().is_file() {
        return Err(VaultError::NotFound);
    }
    let bytes = fs::read(&path).map_err(not_found_or)?;
    Ok(StatDoc {
        path: paths::to_rel(root, &path)?,
        bytes: bytes.len() as u64,
        sha256: atomic::hex_sha256(&bytes),
        modified_ms: modified_ms(&metadata),
    })
}

fn ensure_markdown(rel: &str) -> VaultResult<()> {
    if rel.to_ascii_lowercase().ends_with(".md") {
        Ok(())
    } else {
        Err(VaultError::InvalidArg(format!(
            "vault 只接受 .md 文档：{rel}"
        )))
    }
}

pub(crate) fn not_found_or(error: io::Error) -> VaultError {
    if error.kind() == io::ErrorKind::NotFound {
        VaultError::NotFound
    } else {
        error.into()
    }
}

pub(crate) fn modified_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use tempfile::tempdir;

    use super::*;
    use crate::ipc::ReadonlyReason;
    use crate::vault::trash;

    fn write_file(root: &Path, rel: &str, bytes: &[u8]) {
        let path: PathBuf = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, bytes).expect("seed");
    }

    fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
            for entry in fs::read_dir(dir).expect("read_dir") {
                let entry = entry.expect("entry");
                let path = entry.path();
                if entry.file_type().expect("file type").is_dir() {
                    walk(&path, root, out);
                } else {
                    let rel = path
                        .strip_prefix(root)
                        .expect("strip prefix")
                        .to_string_lossy()
                        .replace('\\', "/");
                    out.insert(rel, fs::read(&path).expect("read"));
                }
            }
        }
        let mut out = BTreeMap::new();
        walk(root, root, &mut out);
        out
    }

    fn legacy_vault() -> tempfile::TempDir {
        let dir = tempdir().expect("root");
        let root = dir.path();
        write_file(
            root,
            ".workbench/settings.json",
            r#"{"version":1,"vault":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","name":"旧库"}}"#.as_bytes(),
        );
        write_file(
            root,
            ".workbench/canvas/01H8XYZABCDEF.canvas.json",
            br#"{"nodes":[]}"#,
        );
        write_file(root, "a.md", b"# A\n");
        write_file(root, "notes/b.md", b"# B\n");
        write_file(root, "media/ab/cat.png", &[0x89, 0x50, 0x4e, 0x47]);
        dir
    }

    #[test]
    fn write_then_read_roundtrip_and_hash_agrees_with_stat() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);

        let written = write(&gate, root, "notes/a.md", "# 标题\n正文\n", None).expect("write");
        assert_eq!(written.path, "notes/a.md");
        assert_eq!(written.bytes, "# 标题\n正文\n".len() as u64);

        let read_back = read(root, "notes/a.md").expect("read");
        assert_eq!(read_back.text, "# 标题\n正文\n");
        assert_eq!(read_back.sha256, written.sha256);

        let stat_back = stat(root, "notes/a.md").expect("stat");
        assert_eq!(stat_back.sha256, written.sha256);
        assert_eq!(stat_back.bytes, written.bytes);
        assert!(stat_back.modified_ms > 0);
    }

    #[test]
    fn conditional_write_accepts_matching_sha() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        write_file(root, "a.md", b"external-1");
        let expected = stat(root, "a.md").expect("stat").sha256;

        let written = write(&gate, root, "a.md", "local", Some(&expected)).expect("条件写");

        assert_eq!(written.sha256, atomic::hex_sha256(b"local"));
        assert_eq!(read(root, "a.md").expect("read").text, "local");
    }

    #[cfg(unix)]
    #[test]
    fn conditional_write_verification_io_does_not_latch_gate() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        write_file(root, "locked.md", b"external");
        let expected = stat(root, "locked.md").expect("stat").sha256;
        let locked = root.join("locked.md");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).expect("chmod 000");

        let result = write(&gate, root, "locked.md", "local", Some(&expected));
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o600)).expect("restore");
        let error = result.expect_err("验证性读取失败");
        let other = write(&gate, root, "other.md", "writable", None);

        assert_eq!(error.code(), "E_IO");
        assert!(gate.readonly_reason().is_none(), "单文件不可读不得闩锁全库");
        other.expect("另一文档必须仍可写");
        assert_eq!(read(root, "other.md").expect("read").text, "writable");
    }

    #[test]
    fn conditional_write_rejects_external_change_after_stat() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        write_file(root, "a.md", b"external-1");
        let expected = stat(root, "a.md").expect("前端 stat").sha256;
        write_file(root, "a.md", b"external-2");

        let error = write(&gate, root, "a.md", "local", Some(&expected))
            .expect_err("stat 后的外部修改必须拒绝旧裁决");

        assert_eq!(error.code(), "E_INVALID_ARG");
        assert_eq!(fs::read(root.join("a.md")).expect("read"), b"external-2");
    }

    #[test]
    fn conditional_write_rejects_missing_target_and_none_keeps_legacy_behavior() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let expected = "00".repeat(32);

        let error = write(&gate, root, "nested/a.md", "local", Some(&expected))
            .expect_err("条件写不得创建缺失目标");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(!root.join("nested/a.md").exists());

        write(&gate, root, "nested/a.md", "v1", None).expect("None 仍允许创建");
        write(&gate, root, "nested/a.md", "v2", None).expect("None 仍允许覆盖");
        assert_eq!(read(root, "nested/a.md").expect("read").text, "v2");
    }

    #[test]
    fn conditional_write_empty_sha_requires_missing_target() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);

        write(&gate, root, "new.md", "local", Some("")).expect("缺失目标允许创建");
        assert_eq!(read(root, "new.md").expect("read").text, "local");

        write_file(root, "recreated.md", b"external");
        let error = write(&gate, root, "recreated.md", "local", Some(""))
            .expect_err("外部抢先创建必须拒绝");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert_eq!(read(root, "recreated.md").expect("read").text, "external");
    }

    #[test]
    fn write_accepts_uppercase_extension_and_creates_parents() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let written = write(&gate, root, "deep/nested/DOC.MD", "x", None).expect("write");
        assert_eq!(written.path, "deep/nested/DOC.MD");
        assert_eq!(read(root, "deep/nested/DOC.MD").expect("read").text, "x");
    }

    #[test]
    fn write_rejects_non_markdown_and_oversize_without_touching_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);

        let error = write(&gate, root, "a.txt", "x", None).expect_err("非 md");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(!root.join("a.txt").exists());

        let oversize = "a".repeat(MAX_DOC_BYTES as usize + 1);
        let error = write(&gate, root, "big.md", &oversize, None).expect_err("超限");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(!root.join("big.md").exists());
    }

    #[test]
    fn read_rejects_non_utf8_and_directories() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        write_file(root, "bad.md", &[0xff, 0xfe, 0x00]);
        fs::create_dir_all(root.join("folder")).expect("dir");

        assert_eq!(
            read(root, "bad.md").expect_err("非 UTF-8").code(),
            "E_INVALID_ARG"
        );
        assert_eq!(
            read(root, "folder").expect_err("目录").code(),
            "E_NOT_FOUND"
        );
        assert_eq!(
            stat(root, "folder").expect_err("目录").code(),
            "E_NOT_FOUND"
        );
        assert_eq!(
            stat(root, "missing.md").expect_err("缺失").code(),
            "E_NOT_FOUND"
        );
    }

    #[test]
    fn rename_moves_content_and_refuses_to_overwrite() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        write(&gate, root, "a.md", "alpha", None).expect("a");
        write(&gate, root, "b.md", "beta", None).expect("b");

        let moved = rename(&gate, root, "a.md", "notes/a.md").expect("move");
        assert_eq!(moved.path, "notes/a.md");
        assert_eq!(read(root, "notes/a.md").expect("read").text, "alpha");
        assert!(!root.join("a.md").exists());

        let error = rename(&gate, root, "notes/a.md", "b.md").expect_err("不覆盖");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert_eq!(read(root, "b.md").expect("b").text, "beta");
        assert_eq!(read(root, "notes/a.md").expect("a").text, "alpha");
    }

    #[test]
    fn rename_moves_directory_and_refuses_overwrite() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        write(&gate, root, "notes/child/a.md", "alpha", None).expect("a");
        write(&gate, root, "taken/b.md", "beta", None).expect("b");

        let moved = rename(&gate, root, "notes", "journal").expect("目录改名");
        assert_eq!(moved.path, "journal");
        assert_eq!(moved.bytes, 0);
        assert!(moved.sha256.is_empty());
        assert_eq!(
            read(root, "journal/child/a.md").expect("read").text,
            "alpha"
        );
        assert!(!root.join("notes").exists());

        let error = rename(&gate, root, "journal", "taken").expect_err("不覆盖目录");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(root.join("journal/child/a.md").is_file());
        assert!(root.join("taken/b.md").is_file());

        let error = rename(&gate, root, "journal", "journal/inner").expect_err("不能移入自身");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(root.join("journal/child/a.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn rename_refuses_symlinked_directory() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().expect("root");
        let root = dir.path();
        let outside = tempdir().expect("outside");
        write_file(outside.path(), "keep.md", b"safe");
        symlink(outside.path(), root.join("linked")).expect("symlink");

        let gate = WriteGate::new(None);
        let error = rename(&gate, root, "linked", "moved").expect_err("symlink 不是目录");
        assert_eq!(error.code(), "E_PATH_ESCAPE");
        assert!(root.join("linked").is_symlink());
        assert!(outside.path().join("keep.md").is_file());
    }

    #[test]
    fn readonly_gate_blocks_write_without_touching_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        write_file(root, "a.md", b"keep");

        let gate = WriteGate::new(Some(ReadonlyReason::LockedByOther));
        let error = write(&gate, root, "a.md", "changed", None).expect_err("只读");
        assert_eq!(error.code(), "E_READONLY");
        assert_eq!(fs::read(root.join("a.md")).expect("read"), b"keep");
    }

    #[test]
    fn legacy_vault_operations_preserve_other_files() {
        let dir = legacy_vault();
        let root = dir.path();
        let gate = WriteGate::new(None);
        let before = snapshot(root);

        write(&gate, root, "a.md", "# A v2\n", None).expect("write");
        rename(&gate, root, "a.md", "notes/a.md").expect("rename");
        trash::delete(&gate, root, "notes/b.md").expect("delete");

        let after = snapshot(root);
        for rel in [
            ".workbench/settings.json",
            ".workbench/canvas/01H8XYZABCDEF.canvas.json",
            "media/ab/cat.png",
        ] {
            assert_eq!(before.get(rel), after.get(rel), "{rel} 不应被改动");
        }
        assert_eq!(
            after.get("notes/a.md").expect("moved").as_slice(),
            b"# A v2\n"
        );
        assert!(!after.contains_key("notes/b.md"));
    }

    #[test]
    fn ten_threads_write_same_path_and_file_stays_whole() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let payloads: Vec<String> = (0..10)
            .map(|index| format!("writer-{index}\n{}", "x".repeat(64 * 1024)))
            .collect();

        std::thread::scope(|scope| {
            let shared_gate = &gate;
            let shared_root = root;
            for payload in &payloads {
                let payload = payload.as_str();
                scope.spawn(move || {
                    write(shared_gate, shared_root, "same.md", payload, None)
                        .expect("并发写应成功");
                });
            }
        });

        let text = read(root, "same.md").expect("read").text;
        assert!(
            payloads.iter().any(|payload| payload == &text),
            "最终内容必须精确等于某一次写入，不能是半截或拼接"
        );
        assert_eq!(gate.take_max_in_flight(), 1, "写队列必须严格串行");
    }
}
