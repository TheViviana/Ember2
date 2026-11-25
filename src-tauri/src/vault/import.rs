use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;

use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic::{self, CreateNewResult};
use crate::vault::constants::MAX_DOC_BYTES;
use crate::vault::doc::{self, WriteDoc};
use crate::vault::gate::{self, WriteGate};
use crate::vault::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    Skip,
    Rename,
}

#[derive(Debug)]
pub enum ImportOutcome {
    Imported(WriteDoc),
    Skipped,
}

/// 导入一份外部 Markdown：只复制字节，不解析或补写 frontmatter。
pub fn import(
    gate: &WriteGate,
    root: &Path,
    source: &Path,
    target_dir: &str,
    conflict: Conflict,
) -> VaultResult<ImportOutcome> {
    import_with_writer(
        gate,
        root,
        source,
        target_dir,
        conflict,
        atomic::write_atomic_create_new,
    )
}

fn import_with_writer<F>(
    gate: &WriteGate,
    root: &Path,
    source: &Path,
    target_dir: &str,
    conflict: Conflict,
    mut write: F,
) -> VaultResult<ImportOutcome>
where
    F: FnMut(&Path, &[u8]) -> VaultResult<CreateNewResult>,
{
    let file_name = validate_source(source)?;
    if target_dir.contains('\\') {
        return Err(VaultError::PathEscape);
    }
    // 与文档列表的目录口径一致：空串表示库根；其它路径统一走库内边界校验。
    if !target_dir.is_empty() {
        paths::resolve(root, target_dir)?;
    }
    let bytes = read_source(source)?;
    let _permit = gate.enter()?;
    let mut sequence = 1u64;
    loop {
        let candidate_name = if sequence == 1 {
            file_name.clone()
        } else {
            let (stem, extension) = file_name
                .rsplit_once('.')
                .ok_or_else(|| VaultError::InvalidArg("导入源必须是 .md 文件".to_string()))?;
            format!("{stem} {sequence}.{extension}")
        };
        let rel = if target_dir.is_empty() {
            candidate_name
        } else {
            format!("{}/{}", target_dir.trim_end_matches('/'), candidate_name)
        };
        let target = paths::resolve(root, &rel)?;
        if path_exists(&target)? {
            if conflict == Conflict::Skip {
                return Ok(ImportOutcome::Skipped);
            }
        } else {
            match write(&target, &bytes) {
                Ok(CreateNewResult::Created(written)) => {
                    return Ok(ImportOutcome::Imported(WriteDoc {
                        path: paths::to_rel(root, &target)?,
                        bytes: written.bytes,
                        sha256: written.sha256,
                    }));
                }
                Ok(CreateNewResult::AlreadyExists) => {
                    if conflict == Conflict::Skip {
                        return Ok(ImportOutcome::Skipped);
                    }
                    // rename 竞争：原候选已被抢先创建，继续下一个序号。
                }
                Err(error) => return Err(gate::map_write_result(gate, error)),
            }
        }
        sequence = sequence
            .checked_add(1)
            .ok_or_else(|| VaultError::InvalidArg("无法分配导入文件名".to_string()))?;
    }
}

fn validate_source(source: &Path) -> VaultResult<String> {
    if !source.is_absolute() {
        return Err(VaultError::InvalidArg("导入源必须是绝对路径".to_string()));
    }
    let file_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| VaultError::InvalidArg("导入源文件名不是合法 UTF-8".to_string()))?
        .to_string();
    if file_name.contains('\\') {
        return Err(VaultError::InvalidArg(
            "导入源文件名不能包含路径分隔符".to_string(),
        ));
    }
    let markdown = source
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"));
    if !markdown {
        return Err(VaultError::InvalidArg("导入源必须是 .md 文件".to_string()));
    }
    let metadata = fs::symlink_metadata(source).map_err(doc::not_found_or)?;
    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
        return Err(VaultError::InvalidArg("导入源必须是普通文件".to_string()));
    }
    if metadata.len() > MAX_DOC_BYTES {
        return Err(VaultError::InvalidArg(format!(
            "导入源超过 {MAX_DOC_BYTES} 字节上限"
        )));
    }
    Ok(file_name)
}

fn read_source(source: &Path) -> VaultResult<Vec<u8>> {
    let file = File::open(source).map_err(doc::not_found_or)?;
    let mut bytes = Vec::new();
    file.take(MAX_DOC_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(doc::not_found_or)?;
    if bytes.len() as u64 > MAX_DOC_BYTES {
        return Err(VaultError::InvalidArg(format!(
            "导入源超过 {MAX_DOC_BYTES} 字节上限"
        )));
    }
    std::str::from_utf8(&bytes)
        .map_err(|_| VaultError::InvalidArg("导入源不是合法 UTF-8".to_string()))?;
    Ok(bytes)
}

fn path_exists(path: &Path) -> VaultResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    fn source(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).expect("source");
        path
    }

    #[test]
    fn imports_regular_utf8_markdown_without_changing_bytes() {
        let vault = tempdir().expect("vault");
        let external = tempdir().expect("external");
        let bytes = b"\xef\xbb\xbf# \xe6\xa0\x87\xe9\xa2\x98\r\n\r\nplain body\r\n";
        let source = source(external.path(), "note.md", bytes);
        let gate = WriteGate::new(None);

        let outcome =
            import(&gate, vault.path(), &source, "documents", Conflict::Skip).expect("import");
        let ImportOutcome::Imported(written) = outcome else {
            panic!("首次导入必须成功");
        };

        assert_eq!(written.path, "documents/note.md");
        assert_eq!(written.bytes, bytes.len() as u64);
        assert_eq!(written.sha256, atomic::hex_sha256(bytes));
        assert_eq!(
            fs::read(vault.path().join("documents/note.md")).expect("target"),
            bytes,
            "不得换行转换、去 BOM 或注入 frontmatter"
        );
        assert_eq!(fs::read(source).expect("source"), bytes, "源文件不得改动");
    }

    #[test]
    fn rejects_non_markdown_directory_bad_utf8_oversize_and_symlink() {
        let vault = tempdir().expect("vault");
        let external = tempdir().expect("external");
        let gate = WriteGate::new(None);
        let cases = vec![
            source(external.path(), "note.txt", b"text"),
            external.path().join("folder.md"),
            source(external.path(), "bad.md", &[0xff, 0xfe]),
        ];
        fs::create_dir(&cases[1]).expect("directory source");

        for source in cases {
            let error = import(&gate, vault.path(), &source, "documents", Conflict::Skip)
                .expect_err("非法源必须拒绝");
            assert_eq!(error.code(), "E_INVALID_ARG");
        }

        let huge = external.path().join("huge.md");
        File::create(&huge)
            .expect("huge")
            .set_len(MAX_DOC_BYTES + 1)
            .expect("sparse huge");
        let error = import(&gate, vault.path(), &huge, "documents", Conflict::Skip)
            .expect_err("超大文件必须拒绝");
        assert_eq!(error.code(), "E_INVALID_ARG");

        let real = source(external.path(), "real.md", b"real");
        let linked = external.path().join("linked.md");
        std::os::unix::fs::symlink(real, &linked).expect("symlink");
        let error = import(&gate, vault.path(), &linked, "documents", Conflict::Skip)
            .expect_err("symlink 不是常规文件");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(!vault.path().join("documents").exists(), "拒绝时不得落盘");
    }

    #[test]
    fn rejects_target_escape_reserved_paths_and_symlinked_directory() {
        let vault = tempdir().expect("vault");
        let external = tempdir().expect("external");
        let outside = tempdir().expect("outside");
        let source = source(external.path(), "note.md", b"note");
        let gate = WriteGate::new(None);

        for (target_dir, code) in [
            ("../escape", "E_PATH_ESCAPE"),
            ("documents/../../escape", "E_PATH_ESCAPE"),
            ("/tmp", "E_PATH_ESCAPE"),
            ("documents\\..\\escape", "E_PATH_ESCAPE"),
            (".workbench", "E_RESERVED_PATH"),
        ] {
            let error = import(&gate, vault.path(), &source, target_dir, Conflict::Rename)
                .expect_err(target_dir);
            assert_eq!(error.code(), code, "目标目录：{target_dir}");
        }

        std::os::unix::fs::symlink(outside.path(), vault.path().join("linked")).expect("symlink");
        let error = import(&gate, vault.path(), &source, "linked", Conflict::Rename)
            .expect_err("目标目录 symlink 必须拒绝");
        assert_eq!(error.code(), "E_PATH_ESCAPE");
        assert_eq!(fs::read_dir(outside.path()).expect("outside").count(), 0);
    }

    #[test]
    fn skip_preserves_existing_and_rename_uses_first_available_sequence() {
        let vault = tempdir().expect("vault");
        let external = tempdir().expect("external");
        let source = source(external.path(), "note.md", b"imported\r\n");
        let gate = WriteGate::new(None);
        fs::create_dir(vault.path().join("documents")).expect("documents");
        fs::write(vault.path().join("documents/note.md"), b"original").expect("original");
        fs::write(vault.path().join("documents/note 2.md"), b"second").expect("second");

        let skipped =
            import(&gate, vault.path(), &source, "documents", Conflict::Skip).expect("skip");
        assert!(matches!(skipped, ImportOutcome::Skipped));
        assert_eq!(
            fs::read(vault.path().join("documents/note.md")).expect("original"),
            b"original"
        );

        let renamed =
            import(&gate, vault.path(), &source, "documents", Conflict::Rename).expect("rename");
        let ImportOutcome::Imported(written) = renamed else {
            panic!("rename 必须导入");
        };
        assert_eq!(written.path, "documents/note 3.md");
        assert_eq!(
            fs::read(vault.path().join("documents/note 3.md")).expect("renamed"),
            b"imported\r\n"
        );
        assert_eq!(
            fs::read(vault.path().join("documents/note 2.md")).expect("second"),
            b"second"
        );
    }

    #[test]
    fn rename_race_continues_to_next_sequence_without_overwriting() {
        let vault = tempdir().expect("vault");
        let external = tempdir().expect("external");
        let source = source(external.path(), "race.md", b"imported");
        let gate = WriteGate::new(None);
        let mut first_attempt = true;

        let outcome = import_with_writer(
            &gate,
            vault.path(),
            &source,
            "documents",
            Conflict::Rename,
            |target, bytes| {
                if std::mem::take(&mut first_attempt) {
                    fs::create_dir_all(target.parent().expect("parent")).expect("parent");
                    fs::write(target, b"external").expect("simulate race");
                }
                atomic::write_atomic_create_new(target, bytes)
            },
        )
        .expect("race rename");

        let ImportOutcome::Imported(written) = outcome else {
            panic!("竞争后必须选择下一序号");
        };
        assert_eq!(written.path, "documents/race 2.md");
        assert_eq!(
            fs::read(vault.path().join("documents/race.md")).expect("raced target"),
            b"external"
        );
        assert_eq!(
            fs::read(vault.path().join("documents/race 2.md")).expect("imported target"),
            b"imported"
        );
    }
}
