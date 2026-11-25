use std::fs;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::ipc::{VaultError, VaultResult};

/// 工作区目录名（保留名，文档不可占用）。
pub const WORKBENCH_DIR: &str = ".workbench";

pub fn workbench(root: &Path) -> PathBuf {
    root.join(WORKBENCH_DIR)
}

/// 库身份与设置：`.workbench/settings.json`（与旧库同址，只读不改写）。
pub fn settings_file(root: &Path) -> PathBuf {
    workbench(root).join("settings.json")
}

/// 应用级状态目录：`~/Library/Application Support/Ember`（与旧版同址）。
///
/// 锁与 `machine-id` 必须落在同一位置，旧版才能感知新版持有的锁；
/// `HOME` 缺失时退回临时目录，保证仍可启动。
pub fn app_support_dir() -> PathBuf {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() => PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("Ember"),
        _ => std::env::temp_dir().join("Ember"),
    }
}

/// 规范化根路径文本：能解析就解析（软链、`..`、尾斜杠），失败退回字面值。
/// 锁目录的键以它为准，保证同一库的不同写法落到同一条锁。
pub fn normalized_root(root: &Path) -> String {
    let resolved = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let text = resolved.to_string_lossy();
    text.trim_end_matches('/').to_string()
}

/// 仅由根路径派生（不看 `settings.json`）：建库前就必须稳定，
/// 否则首次建库写身份后锁目录会漂移，两个实例各锁一处。
pub fn derived_key(root: &Path) -> String {
    let digest = Sha256::digest(normalized_root(root).as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 库锁目录：`<base>/locks/<sha256(normalized_root)>/`（与旧版 D7 落点一致）。
///
/// 锁在库外：库可能位于 iCloud 或只读卷，锁的创建不能依赖库内目录。
pub fn lock_dir(base: &Path, root: &Path) -> PathBuf {
    base.join("locks").join(derived_key(root))
}

/// 单实例锁文件（与旧版同址同格式）。
pub fn lock_file(base: &Path, root: &Path) -> PathBuf {
    lock_dir(base, root).join("lock")
}

/// 把相对路径解析为库内绝对路径，并在此处拒绝一切越界。
///
/// 规则：空串/绝对路径/`..`/盘符 → `E_PATH_ESCAPE`；任一组件以 `.` 开头
/// （含 `.workbench`）→ `E_RESERVED_PATH`；逐段探测 symlink，命中即拒绝。
pub fn resolve(root: &Path, rel: &str) -> VaultResult<PathBuf> {
    if rel.trim().is_empty() {
        return Err(VaultError::InvalidArg("路径不能为空".to_string()));
    }
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(VaultError::PathEscape);
    }
    let mut resolved = root.to_path_buf();
    let mut components = candidate.components().peekable();
    if components.peek().is_none() {
        return Err(VaultError::InvalidArg("路径不能为空".to_string()));
    }
    for component in components {
        let Component::Normal(name) = component else {
            return Err(VaultError::PathEscape);
        };
        let text = name.to_string_lossy();
        if text.starts_with('.') {
            return Err(VaultError::ReservedPath);
        }
        resolved.push(name);
        if let Ok(metadata) = fs::symlink_metadata(&resolved) {
            if metadata.file_type().is_symlink() {
                return Err(VaultError::PathEscape);
            }
        }
    }
    Ok(resolved)
}

/// 绝对路径转库内相对路径（正向斜杠）。
pub fn to_rel(root: &Path, absolute: &Path) -> VaultResult<String> {
    let rel = absolute
        .strip_prefix(root)
        .map_err(|_| VaultError::PathEscape)?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tempfile::tempdir;

    use super::*;
    use crate::ipc::error::{E_PATH_ESCAPE, E_RESERVED_PATH};

    #[test]
    fn rejects_escape_and_reserved() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        for (rel, code) in [
            ("../x.md", E_PATH_ESCAPE),
            ("a/../../x.md", E_PATH_ESCAPE),
            ("/etc/passwd", E_PATH_ESCAPE),
            ("", "E_INVALID_ARG"),
            (".workbench/settings.json", E_RESERVED_PATH),
            (".hidden.md", E_RESERVED_PATH),
        ] {
            let error = resolve(root, rel).expect_err(rel);
            assert_eq!(error.code(), code, "路径 {rel} 判定漂移");
        }
    }

    #[test]
    fn accepts_normal_and_blocks_symlink_escape() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let resolved = resolve(root, "notes/a.md").expect("普通路径应通过");
        assert_eq!(resolved, root.join("notes/a.md"));

        let outside = tempdir().expect("outside");
        symlink(outside.path(), root.join("linked")).expect("symlink");
        let error = resolve(root, "linked/x.md").expect_err("库外 symlink 必须拒绝");
        assert_eq!(error.code(), E_PATH_ESCAPE);
    }

    #[test]
    fn lock_lives_outside_vault_under_base() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        let lock = lock_file(base.path(), dir.path());
        assert!(
            lock.starts_with(base.path().join("locks")),
            "锁必须落在库外基目录"
        );
        assert!(!lock.starts_with(dir.path()), "锁不得写进库内");
        assert_eq!(lock.file_name().expect("file name"), "lock");
        assert_eq!(derived_key(dir.path()).len(), 64, "键应为 sha256 十六进制");
    }

    #[test]
    fn derived_key_ignores_path_spelling_and_differs_per_vault() {
        let dir = tempdir().expect("root");
        let with_slash = format!("{}/", dir.path().display());
        assert_eq!(
            derived_key(Path::new(&with_slash)),
            derived_key(dir.path()),
            "尾斜杠不应派生出不同的锁目录"
        );
        let other = tempdir().expect("other");
        assert_ne!(derived_key(dir.path()), derived_key(other.path()));
    }

    #[test]
    fn to_rel_roundtrip() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let absolute = resolve(root, "a/b.md").expect("resolve");
        assert_eq!(to_rel(root, &absolute).expect("to_rel"), "a/b.md");
        assert_eq!(
            to_rel(root, Path::new("/tmp/elsewhere.md"))
                .expect_err("库外路径")
                .code(),
            E_PATH_ESCAPE
        );
    }
}
