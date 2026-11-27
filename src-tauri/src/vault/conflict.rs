//! 冲突副本：把「冲突发生那一刻的本地草稿」另存到 `.workbench/conflicts/`。
//!
//! 只做本地草稿快照（A 方案），不复制磁盘版本；磁盘版本仍在原路径。
//! 目标目录是保留路径：scan/watch 均跳过点目录，副本不会进入索引。
//!
//! 安全边界：
//! - 源路径经 `paths::resolve`/`doc::prepare_write` 校验，拒绝越界与点目录；
//! - `.workbench`、`conflicts` 与镜像目录逐级校验，符号链接或非目录一律拒绝；
//! - 写入使用 create-only 原子写，绝不覆盖既有文件。

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::ipc::conflict::ConflictCopyDto;
use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic::{self, CreateNewResult};
use crate::vault::doc;
use crate::vault::gate::{self, WriteGate};
use crate::vault::paths;

/// 冲突副本目录（相对库根）。
pub const CONFLICTS_DIR: &str = ".workbench/conflicts";

/// 同一毫秒内的重名重试上限；超出按参数错误处理。
const MAX_REVISION: u32 = 100;

/// 时间戳形状：`YYYYMMDD-HHmmss-SSS`（19 字节）。
///
/// 只做形状与范围校验；不判断日期是否真实存在（只用于命名，不参与语义）。
pub fn validate_stamp(stamp: &str) -> bool {
    let bytes = stamp.as_bytes();
    if bytes.len() != 19 {
        return false;
    }
    if bytes[8] != b'-' || bytes[15] != b'-' {
        return false;
    }
    if bytes
        .iter()
        .enumerate()
        .any(|(index, byte)| index != 8 && index != 15 && !byte.is_ascii_digit())
    {
        return false;
    }
    let parsed = (|| {
        Some((
            stamp[0..4].parse::<u32>().ok()?,
            stamp[4..6].parse::<u32>().ok()?,
            stamp[6..8].parse::<u32>().ok()?,
            stamp[9..11].parse::<u32>().ok()?,
            stamp[11..13].parse::<u32>().ok()?,
            stamp[13..15].parse::<u32>().ok()?,
            stamp[16..19].parse::<u32>().ok()?,
        ))
    })();
    let Some((year, month, day, hour, minute, second, millis)) = parsed else {
        return false;
    };
    (1970..=9999).contains(&year)
        && (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 59
        && millis <= 999
}

/// 保存冲突副本；返回副本的库内相对路径与内容指纹。
pub fn save(
    gate: &WriteGate,
    root: &Path,
    rel: &str,
    text: &str,
    stamp: &str,
) -> VaultResult<ConflictCopyDto> {
    if !validate_stamp(stamp) {
        return Err(VaultError::InvalidArg(format!(
            "冲突副本时间戳非法：{stamp}"
        )));
    }
    // 复用文档写入的校验：仅 .md、正文不超上限、路径不越界。
    let source = doc::prepare_write(root, rel, text)?;
    let _permit = gate.enter()?;
    let source_rel = paths::to_rel(root, &source)?;
    let dir = prepare_conflict_dir(gate, root, &source_rel)?;

    for revision in 1..=MAX_REVISION {
        let name = conflict_file_name(&source_rel, stamp, revision)?;
        let target = dir.join(&name);
        let created = atomic::write_atomic_create_new(&target, text.as_bytes())
            .map_err(|error| gate::map_write_result(gate, error))?;
        match created {
            CreateNewResult::Created(written) => {
                return Ok(ConflictCopyDto {
                    path: paths::to_rel(root, &target)?,
                    bytes: written.bytes,
                    sha256: written.sha256,
                });
            }
            CreateNewResult::AlreadyExists => continue,
        }
    }
    Err(VaultError::InvalidArg(format!(
        "冲突副本重名过多：{source_rel}"
    )))
}

/// 逐级准备 `.workbench/conflicts/<源目录镜像>`，任何一级是符号链接即拒绝。
fn prepare_conflict_dir(gate: &WriteGate, root: &Path, source_rel: &str) -> VaultResult<PathBuf> {
    let workbench = paths::workbench(root);
    ensure_real_dir(gate, &workbench)?;
    let mut dir = workbench.join("conflicts");
    ensure_real_dir(gate, &dir)?;
    let source = Path::new(source_rel);
    if let Some(parent) = source.parent() {
        for component in parent.components() {
            if let Component::Normal(name) = component {
                dir = dir.join(name);
                ensure_real_dir(gate, &dir)?;
            }
        }
    }
    Ok(dir)
}

/// 已存在必须是普通目录；不存在则只创建当前这一级（不跟随中间链接）。
fn ensure_real_dir(gate: &WriteGate, dir: &Path) -> VaultResult<()> {
    match fs::symlink_metadata(dir) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
                return Err(VaultError::PathEscape);
            }
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => match fs::create_dir(dir) {
            Ok(()) => Ok(()),
            // 竞争：别处刚创建；重新确认它不是链接且仍是目录。
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                match fs::symlink_metadata(dir) {
                    Ok(metadata)
                        if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() =>
                    {
                        Ok(())
                    }
                    Ok(_) => Err(VaultError::PathEscape),
                    Err(error) => Err(gate::map_write_error(gate, error)),
                }
            }
            Err(error) => Err(gate::map_write_error(gate, error)),
        },
        Err(error) => Err(gate::map_write_error(gate, error)),
    }
}

/// `<stem>.conflict-<stamp>[-N].md`；stem 由源文件名去掉 `.md`（大小写不敏感）。
fn conflict_file_name(source_rel: &str, stamp: &str, revision: u32) -> VaultResult<String> {
    let base = source_rel.rsplit('/').next().unwrap_or(source_rel);
    let lower = base.to_ascii_lowercase();
    let Some(stem) = lower
        .strip_suffix(".md")
        .map(|prefix| &base[..prefix.len()])
    else {
        return Err(VaultError::InvalidArg(format!(
            "冲突副本只接受 .md 文档：{source_rel}"
        )));
    };
    let suffix = if revision <= 1 {
        String::new()
    } else {
        format!("-{revision}")
    };
    Ok(format!("{stem}.conflict-{stamp}{suffix}.md"))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::ipc::ReadonlyReason;
    use crate::vault::constants::MAX_DOC_BYTES;

    fn gate() -> WriteGate {
        WriteGate::new(None)
    }

    fn error_code(result: VaultResult<impl std::fmt::Debug>) -> &'static str {
        result.expect_err("应失败").code()
    }

    #[test]
    fn stamp_shape_and_range() {
        for good in [
            "20261127-101530-123",
            "19700101-000000-000",
            "99991231-235959-999",
        ] {
            assert!(validate_stamp(good), "应接受：{good}");
        }
        for bad in [
            "",
            "20261127-101530-12",
            "20261127-101530-1234",
            "20261127_101530-123",
            "20261127-101530-12x",
            "20261327-101530-123",
            "20261100-101530-123",
            "20261127-241530-123",
            "20261127-106030-123",
            "20261127-101560-123",
            "99991231-235959-1000",
        ] {
            assert!(!validate_stamp(bad), "应拒绝：{bad}");
        }
    }

    #[test]
    fn saves_mirrored_path_with_content_hash() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        let text = "# 本地草稿\n";

        let saved =
            save(&gate, root, "notes/daily/a.md", text, "20261127-101530-123").expect("save");

        assert_eq!(
            saved.path,
            ".workbench/conflicts/notes/daily/a.conflict-20261127-101530-123.md"
        );
        assert_eq!(saved.bytes, text.len() as u64);
        assert_eq!(saved.sha256, atomic::hex_sha256(text.as_bytes()));
        assert_eq!(
            fs::read(root.join(&saved.path)).expect("read"),
            text.as_bytes()
        );
    }

    #[test]
    fn same_stamp_falls_back_to_numbered_copies() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        let stamp = "20261127-101530-123";

        let first = save(&gate, root, "a.md", "first", stamp).expect("first");
        let second = save(&gate, root, "a.md", "second", stamp).expect("second");
        let third = save(&gate, root, "a.md", "third", stamp).expect("third");

        assert_eq!(
            first.path,
            ".workbench/conflicts/a.conflict-20261127-101530-123.md"
        );
        assert_eq!(
            second.path,
            ".workbench/conflicts/a.conflict-20261127-101530-123-2.md"
        );
        assert_eq!(
            third.path,
            ".workbench/conflicts/a.conflict-20261127-101530-123-3.md"
        );
        assert_eq!(fs::read(root.join(&first.path)).expect("first"), b"first");
        assert_eq!(
            fs::read(root.join(&second.path)).expect("second"),
            b"second"
        );
    }

    #[test]
    fn rejects_invalid_stamp_before_touching_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        assert_eq!(
            error_code(save(&gate(), root, "a.md", "x", "2026-11-27")),
            "E_INVALID_ARG"
        );
        assert!(!root.join(".workbench").exists(), "非法 stamp 不得触盘");
    }

    #[test]
    fn rejects_non_markdown_escape_and_reserved_paths() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        for (rel, code) in [
            ("a.txt", "E_INVALID_ARG"),
            ("../outside.md", "E_PATH_ESCAPE"),
            (".workbench/a.md", "E_RESERVED_PATH"),
            (".hidden/a.md", "E_RESERVED_PATH"),
        ] {
            assert_eq!(
                error_code(save(&gate(), root, rel, "x", "20261127-101530-123")),
                code,
                "{rel}"
            );
        }
        assert!(!root.join(".workbench").exists(), "校验失败不得建目录");
    }

    #[test]
    fn rejects_oversize_text_without_writing() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let oversize = "a".repeat(MAX_DOC_BYTES as usize + 1);
        assert_eq!(
            error_code(save(
                &gate(),
                root,
                "big.md",
                &oversize,
                "20261127-101530-123"
            )),
            "E_INVALID_ARG"
        );
        assert!(!root.join(".workbench").exists());
    }

    #[test]
    fn readonly_gate_rejects_before_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let readonly = WriteGate::new(Some(ReadonlyReason::LockedByOther));
        assert_eq!(
            error_code(save(&readonly, root, "a.md", "x", "20261127-101530-123")),
            "E_READONLY"
        );
        assert!(!root.join(".workbench").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_workbench_dir() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().expect("root");
        let outside = tempdir().expect("outside");
        let root = dir.path();
        symlink(outside.path(), root.join(".workbench")).expect("symlink");

        assert_eq!(
            error_code(save(&gate(), root, "a.md", "x", "20261127-101530-123")),
            "E_PATH_ESCAPE"
        );
        assert!(
            fs::read_dir(outside.path())
                .expect("outside")
                .next()
                .is_none(),
            "不得写穿符号链接目录"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_mirror_dir() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().expect("root");
        let outside = tempdir().expect("outside");
        let root = dir.path();
        let conflicts = root.join(".workbench").join("conflicts");
        fs::create_dir_all(&conflicts).expect("conflicts");
        symlink(outside.path(), conflicts.join("notes")).expect("symlink");

        assert_eq!(
            error_code(save(
                &gate(),
                root,
                "notes/a.md",
                "x",
                "20261127-101530-123"
            )),
            "E_PATH_ESCAPE"
        );
        assert!(
            fs::read_dir(outside.path())
                .expect("outside")
                .next()
                .is_none(),
            "镜像目录不得写穿"
        );
    }

    #[test]
    fn conflict_file_name_strips_markdown_extension_case_insensitively() {
        assert_eq!(
            conflict_file_name("notes/DOC.MD", "20261127-101530-123", 1).expect("name"),
            "DOC.conflict-20261127-101530-123.md"
        );
        assert_eq!(
            conflict_file_name("a.md", "20261127-101530-123", 3).expect("name"),
            "a.conflict-20261127-101530-123-3.md"
        );
        assert_eq!(
            conflict_file_name("a.txt", "20261127-101530-123", 1)
                .expect_err("非 md")
                .code(),
            "E_INVALID_ARG"
        );
    }
}
