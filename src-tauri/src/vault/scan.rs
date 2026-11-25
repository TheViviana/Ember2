use std::fs;
use std::io;
use std::path::Path;

use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::canvas;
use crate::vault::constants::MAX_SCAN_DEPTH;
use crate::vault::doc::modified_ms;
use crate::vault::paths;

/// 目录项类型（IPC 层映射为 `"dir" | "file"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Dir,
    File,
}

/// 单层目录项。
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// 全库扫描到的文档。
#[derive(Debug, Clone)]
pub struct ScanDoc {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub modified_ms: u64,
}

/// 画布文件（`.workbench/canvas/*.canvas.json`）。
///
/// 单源在 [`crate::vault::canvas`]；这里保留旧名，供既有调用点与测试使用。
pub use crate::vault::canvas::CanvasEntry;

/// 列单层目录。`rel` 为空表示库根；隐藏项与符号链接一律不返回。
pub fn list(root: &Path, rel: Option<&str>) -> VaultResult<Vec<DirEntry>> {
    let rel = rel.filter(|value| !value.trim().is_empty());
    let dir = match rel {
        Some(value) => paths::resolve(root, value)?,
        None => root.to_path_buf(),
    };
    let dir_label = rel.unwrap_or(".");
    let metadata = fs::symlink_metadata(&dir).map_err(|error| not_found_at(dir_label, error))?;
    if !metadata.file_type().is_dir() {
        return Err(VaultError::NotFound);
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|error| not_found_at(dir_label, error))? {
        let item = item.map_err(|error| io_at(dir_label, error))?;
        let name = item.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        let item_rel = paths::to_rel(root, &item.path())?;
        let file_type = item.file_type().map_err(|error| io_at(&item_rel, error))?;
        if file_type.is_symlink() {
            continue;
        }
        let metadata = item.metadata().map_err(|error| io_at(&item_rel, error))?;
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        };
        entries.push(DirEntry {
            name,
            path: item_rel,
            kind,
            bytes: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
            modified_ms: modified_ms(&metadata),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}

/// 递归扫描库内文档：仅 `.md`，跳过隐藏项、符号链接与顶层 `media/`。
pub fn scan(root: &Path) -> VaultResult<Vec<ScanDoc>> {
    let mut docs = Vec::new();
    walk(root, root, 0, &mut docs)?;
    docs.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(docs)
}

fn walk(root: &Path, dir: &Path, depth: u32, out: &mut Vec<ScanDoc>) -> VaultResult<()> {
    if depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    let dir_rel = paths::to_rel(root, dir)?;
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // 扫描期间目录被外部删除：视为空，不算错误
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_at(&dir_rel, error)),
    };
    for item in entries {
        let item = item.map_err(|error| io_at(&dir_rel, error))?;
        let name = item.file_name().to_string_lossy().to_string();
        if is_hidden(&name) {
            continue;
        }
        let path = item.path();
        let item_rel = paths::to_rel(root, &path)?;
        let file_type = item.file_type().map_err(|error| io_at(&item_rel, error))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            // 媒体目录按 vault-format 约定与文档分开，不进入文档扫描
            if depth == 0 && name == "media" {
                continue;
            }
            walk(root, &path, depth + 1, out)?;
        } else if file_type.is_file() && is_markdown(&name) {
            let metadata = item.metadata().map_err(|error| io_at(&item_rel, error))?;
            let bytes = fs::read(&path).map_err(|error| io_at(&item_rel, error))?;
            out.push(ScanDoc {
                path: item_rel,
                bytes: bytes.len() as u64,
                sha256: atomic::hex_sha256(&bytes),
                modified_ms: modified_ms(&metadata),
            });
        }
    }
    Ok(())
}

/// 给 I/O 错误附上相对库根的路径：前端据此定位到具体文件。
fn io_at(rel: &str, error: io::Error) -> VaultError {
    let label = if rel.is_empty() { "." } else { rel };
    VaultError::Io(io::Error::new(error.kind(), format!("{label}: {error}")))
}

/// 缺失仍报 `E_NOT_FOUND`，其余 I/O 错误带路径上抛。
fn not_found_at(rel: &str, error: io::Error) -> VaultError {
    if error.kind() == io::ErrorKind::NotFound {
        VaultError::NotFound
    } else {
        io_at(rel, error)
    }
}

/// 列画布文件。目录不存在返回空数组；不做内容解析（schema 校验属 P4）。
///
/// 单源委托 [`canvas::list_entries`]：非法 id / 符号链接 / 特殊文件按
/// `valid:false` 条目返回，合法条目保持既有四字段。
pub fn list_canvases(root: &Path) -> VaultResult<Vec<CanvasEntry>> {
    canvas::list_entries(root)
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn is_markdown(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".md")
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    use tempfile::tempdir;

    use super::*;

    fn seed(root: &Path, rel: &str, bytes: &[u8]) {
        let path: PathBuf = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, bytes).expect("seed");
    }

    #[test]
    fn scan_skips_hidden_symlinks_media_and_deep_entries() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", b"# A\n");
        seed(root, "notes/b.md", b"# B\n");
        seed(root, ".hidden.md", b"hidden");
        seed(root, ".workbench/settings.json", b"{}");
        seed(root, ".workbench/notes/c.md", b"hidden dir");
        seed(root, "media/shot.md", b"media");
        seed(root, "notes/skip.txt", b"not doc");

        let outside = tempdir().expect("outside");
        fs::write(outside.path().join("outside.md"), b"outside").expect("outside file");
        symlink(outside.path(), root.join("linked")).expect("dir symlink");
        symlink(outside.path().join("outside.md"), root.join("linked.md")).expect("file symlink");

        // 超过 32 层的文档不进入扫描
        let mut deep = root.to_path_buf();
        for index in 0..40 {
            deep = deep.join(format!("d{index}"));
        }
        fs::create_dir_all(&deep).expect("deep");
        fs::write(deep.join("too-deep.md"), b"deep").expect("deep file");

        let docs = scan(root).expect("scan");
        let paths: Vec<&str> = docs.iter().map(|doc| doc.path.as_str()).collect();
        assert_eq!(paths, vec!["a.md", "notes/b.md"]);
        assert_eq!(docs[0].sha256.len(), 64);
    }

    #[test]
    fn list_returns_sorted_visible_children_only() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", b"a");
        seed(root, "notes/b.md", b"b");
        seed(root, ".hidden/x.md", b"h");
        seed(root, "media/cat.png", b"p");

        let entries = list(root, None).expect("list root");
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["a.md", "media", "notes"]);
        assert_eq!(entries[0].kind, EntryKind::File);
        assert_eq!(entries[1].kind, EntryKind::Dir);
        assert_eq!(entries[0].path, "a.md");

        let notes = list(root, Some("notes")).expect("list notes");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].path, "notes/b.md");

        assert_eq!(
            list(root, Some("missing")).expect_err("缺失").code(),
            "E_NOT_FOUND"
        );
        assert_eq!(
            list(root, Some(".workbench")).expect_err("保留名").code(),
            "E_RESERVED_PATH"
        );
        assert_eq!(
            list(root, Some("a.md")).expect_err("非目录").code(),
            "E_NOT_FOUND"
        );
    }

    #[test]
    fn list_canvases_returns_only_canvas_files() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, ".workbench/canvas/01H8XYZ.canvas.json", b"{}");
        seed(root, ".workbench/canvas/backup.canvas.json.v1", b"{}");
        seed(root, ".workbench/canvas/.hidden.canvas.json", b"{}");
        seed(root, ".workbench/canvas/notes.md", b"x");

        let canvases = list_canvases(root).expect("list");
        assert_eq!(canvases.len(), 1);
        assert_eq!(canvases[0].id, "01H8XYZ");
        assert!(canvases[0].valid);
        assert_eq!(
            canvases[0].path.as_deref(),
            Some(".workbench/canvas/01H8XYZ.canvas.json")
        );
        assert_eq!(canvases[0].bytes, Some(2));
    }

    /// S2 / CR-63：合法条目 `path` / `bytes` 均为 `Some`；非法条目保留定位
    /// `path` 以便受控删除，但 `bytes` 仍为 `None`。
    #[test]
    fn list_canvases_option_semantics_are_explicit() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, ".workbench/canvas/good.canvas.json", b"{}");
        seed(root, ".workbench/canvas/bad.id.canvas.json", b"{}");

        let canvases = list_canvases(root).expect("list");
        let good = canvases
            .iter()
            .find(|entry| entry.id == "good")
            .expect("good");
        assert!(good.valid);
        assert_eq!(
            good.path.as_deref(),
            Some(".workbench/canvas/good.canvas.json")
        );
        assert_eq!(good.bytes, Some(2));

        let bad = canvases
            .iter()
            .find(|entry| entry.id == "bad.id")
            .expect("bad");
        assert!(!bad.valid);
        assert_eq!(bad.reason, Some(canvas::CanvasEntryReason::BadId));
        assert_eq!(
            bad.path.as_deref(),
            Some(".workbench/canvas/bad.id.canvas.json"),
            "非法条目仍需真实相对路径供受控删除"
        );
        assert!(bad.bytes.is_none(), "非法条目不得有 bytes");
    }

    #[test]
    fn list_canvases_allows_missing_directory() {
        let dir = tempdir().expect("root");
        assert!(list_canvases(dir.path()).expect("empty").is_empty());
    }

    #[test]
    fn io_errors_carry_the_relative_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "locked/secret.md", b"x");
        seed(root, "open.md", b"y");

        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).expect("chmod");
        let scan_error = scan(root).expect_err("scan 应整体失败");
        let list_error = list(root, Some("locked")).expect_err("list 应失败");
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o700))
            .expect("restore");

        assert_eq!(scan_error.code(), "E_IO");
        assert!(
            scan_error.to_string().contains("locked"),
            "message 必须含相对路径：{scan_error}"
        );
        assert_eq!(list_error.code(), "E_IO");
        assert!(
            list_error.to_string().contains("locked"),
            "message 必须含相对路径：{list_error}"
        );
    }
}
