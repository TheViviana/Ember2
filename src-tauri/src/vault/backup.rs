//! 备份导出与校验（PLAN.md §2：staging + sha256 双向复核）。
//!
//! 导出只读源库，不碰 `WriteGate`，因此不会阻塞正常编辑。
//! 落盘顺序：同级临时目录 `.tmp_backup-*` → 逐个文件流式复制并双向复核 →
//! `manifest.json` 原子写 + 回读校验 → 原子 rename 成最终目录。
//! 任一步失败都整目录清理，绝不留下半截备份，也绝不覆盖已存在的目标。

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::identity;
use crate::vault::paths;

const MANIFEST_NAME: &str = "manifest.json";
const MANIFEST_VERSION: u32 = 1;
const TEMP_PREFIX: &str = ".tmp_backup";
/// 顶层排除：history/ 与 trash/ 属于可重建的中间态，不参与备份。
const SKIP_TOP_DIRS: [&str; 2] = ["history", "trash"];

static BACKUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// `manifest.json`（版本 1）：备份自身的事实源。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    created_at: String,
    source_root: String,
    files: Vec<ManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone)]
pub struct BackupReport {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct BackupInspect {
    pub path: String,
    pub version: u32,
    pub created_at: String,
    pub source_root: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Debug, Clone)]
pub struct DestinationCheck {
    pub path: String,
}

/// 导出到 `destination`（最终备份目录，必须不存在）。
pub fn export(root: &Path, destination: &Path) -> VaultResult<BackupReport> {
    export_with(root, destination, copy_file)
}

/// 可注入复制步骤的导出实现：测试用它制造「中途失败」。
pub(crate) fn export_with<C>(root: &Path, destination: &Path, copy: C) -> VaultResult<BackupReport>
where
    C: Fn(&Path, &Path) -> VaultResult<(u64, String)>,
{
    let target = prepare_destination(root, destination)?;
    let entries = collect(root)?;
    let expected = checked_total(entries.iter().map(|entry| entry.2))?;
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::InvalidArg("备份目标缺少父目录".to_string()))?;
    atomic::ensure_space(parent, expected)?;

    let created_at = identity::now_iso8601();
    let seq = BACKUP_SEQ.fetch_add(1, Ordering::Relaxed);
    let staging = parent.join(format!("{TEMP_PREFIX}-{}-{seq}", std::process::id()));

    let manifest = match write_backup(root, &staging, &entries, &created_at, copy) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    if let Err(error) = write_manifest(&staging, &manifest) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error.into());
    }
    if let Err(error) = fsync_dir(parent) {
        // 目标已是完整备份，目录 fsync 失败只影响断电可见性，不回滚。
        warn(&format!("备份目录 fsync 失败：{error}"));
    }
    Ok(BackupReport {
        path: target.to_string_lossy().to_string(),
        files: manifest.files.len(),
        bytes: checked_total(manifest.files.iter().map(|entry| entry.bytes))?,
        created_at,
    })
}

/// 累加字节数：溢出返回 `E_INVALID_ARG`，避免 u64 回绕后误判可用空间。
fn checked_total<I: IntoIterator<Item = u64>>(values: I) -> VaultResult<u64> {
    values
        .into_iter()
        .try_fold(0u64, |total, value| total.checked_add(value))
        .ok_or_else(|| VaultError::InvalidArg("备份总字节数溢出".to_string()))
}

/// 校验一个「存放备份的目录」：存在、可写、且不在库内。
pub fn check_destination(root: &Path, destination: &Path) -> VaultResult<DestinationCheck> {
    if !destination.is_absolute() {
        return Err(VaultError::InvalidArg("备份位置必须是绝对路径".to_string()));
    }
    if is_inside(root, destination) {
        return Err(VaultError::InvalidArg("备份位置不能位于库内".to_string()));
    }
    if !destination.is_dir() {
        return Err(VaultError::InvalidArg(
            "备份位置必须是已存在的目录".to_string(),
        ));
    }
    // probe 必须独占创建：预置的同名 symlink 会让 File::create 写穿库外文件。
    let (probe, file) = match atomic::create_temp_file(destination, "ember-probe") {
        Ok(created) => created,
        Err(error) => return Err(VaultError::InvalidArg(format!("备份位置不可写：{error}"))),
    };
    let _ = file.sync_all();
    drop(file);
    let _ = fs::remove_file(&probe);
    Ok(DestinationCheck {
        path: destination.to_string_lossy().to_string(),
    })
}

/// 读取并核对一份备份：逐文件比对大小与 sha256，任一不符即失败。
pub fn inspect(destination: &Path) -> VaultResult<BackupInspect> {
    if !destination.is_absolute() {
        return Err(VaultError::InvalidArg("备份路径必须是绝对路径".to_string()));
    }
    let manifest_path = destination.join(MANIFEST_NAME);
    let bytes = match fs::read(&manifest_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(VaultError::NotFound),
        Err(error) => return Err(error.into()),
    };
    let text = String::from_utf8(bytes)
        .map_err(|_| VaultError::InvalidArg("manifest.json 不是 UTF-8".to_string()))?;
    let manifest: Manifest = serde_json::from_str(&text)
        .map_err(|error| VaultError::InvalidArg(format!("manifest.json 解析失败：{error}")))?;
    if manifest.version != MANIFEST_VERSION {
        return Err(VaultError::InvalidArg(format!(
            "不支持的备份版本：{}",
            manifest.version
        )));
    }

    let mut total = 0u64;
    for entry in &manifest.files {
        let path = paths::resolve(destination, &entry.path)?;
        let metadata = fs::metadata(&path).map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                VaultError::NotFound
            } else {
                error.into()
            }
        })?;
        if metadata.len() != entry.bytes {
            return Err(VaultError::Io(io::Error::other(format!(
                "备份文件大小不符：{}（记录 {}，实际 {}）",
                entry.path,
                entry.bytes,
                metadata.len()
            ))));
        }
        if atomic::hash_file(&path)? != entry.sha256 {
            return Err(VaultError::Io(io::Error::other(format!(
                "备份文件哈希不符：{}",
                entry.path
            ))));
        }
        total = total.saturating_add(metadata.len());
    }
    Ok(BackupInspect {
        path: destination.to_string_lossy().to_string(),
        version: manifest.version,
        created_at: manifest.created_at,
        source_root: manifest.source_root,
        files: manifest.files.len(),
        bytes: total,
    })
}

/// 校验最终备份目录：绝对、不在库内、父目录存在、目标尚不存在。
fn prepare_destination(root: &Path, destination: &Path) -> VaultResult<PathBuf> {
    if !destination.is_absolute() {
        return Err(VaultError::InvalidArg("备份目标必须是绝对路径".to_string()));
    }
    if is_inside(root, destination) {
        return Err(VaultError::InvalidArg("备份目标不能位于库内".to_string()));
    }
    if destination.exists() {
        return Err(VaultError::InvalidArg(
            "备份目标已存在，拒绝覆盖".to_string(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| VaultError::InvalidArg("备份目标缺少父目录".to_string()))?;
    if !parent.is_dir() {
        return Err(VaultError::InvalidArg("备份目标的父目录不存在".to_string()));
    }
    Ok(destination.to_path_buf())
}

fn write_backup<C>(
    root: &Path,
    staging: &Path,
    entries: &[(String, PathBuf, u64)],
    created_at: &str,
    copy: C,
) -> VaultResult<Manifest>
where
    C: Fn(&Path, &Path) -> VaultResult<(u64, String)>,
{
    let mut files = Vec::with_capacity(entries.len());
    for (rel, source, _) in entries {
        let target = paths::resolve(staging, rel)?;
        let (bytes, sha256) = copy(source, &target)?;
        files.push(ManifestEntry {
            path: rel.clone(),
            bytes,
            sha256,
        });
    }
    Ok(Manifest {
        version: MANIFEST_VERSION,
        created_at: created_at.to_string(),
        source_root: root.to_string_lossy().to_string(),
        files,
    })
}

/// 默认复制实现：流式写 temp → 发布 → 从目标回读 sha256 复核。
fn copy_file(source: &Path, target: &Path) -> VaultResult<(u64, String)> {
    let staging = target
        .parent()
        .ok_or_else(|| VaultError::InvalidArg("备份目标缺少父目录".to_string()))?;
    let mut reader = File::open(source)?;
    let temp = atomic::write_stream_to_temp(staging, &mut reader)?;
    if let Err(error) = atomic::publish_temp(&temp.path, target) {
        let _ = fs::remove_file(&temp.path);
        return Err(error);
    }
    // 双向复核：内容确实落到目标文件，而不只是「写请求成功」。
    if atomic::hash_file(target)? != temp.sha256 {
        return Err(VaultError::Io(io::Error::other(format!(
            "备份写入后哈希不一致：{}",
            target.to_string_lossy()
        ))));
    }
    Ok((temp.bytes, temp.sha256))
}

fn write_manifest(dir: &Path, manifest: &Manifest) -> VaultResult<()> {
    let bytes = serde_json::to_vec_pretty(manifest)
        .map_err(|error| VaultError::InvalidArg(format!("manifest.json 序列化失败：{error}")))?;
    let target = dir.join(MANIFEST_NAME);
    let written = atomic::write_atomic(&target, &bytes)?;
    let read_back = fs::read(&target)?;
    if atomic::hex_sha256(&read_back) != written.sha256 {
        return Err(VaultError::Io(io::Error::other(
            "manifest.json 回读校验失败",
        )));
    }
    Ok(())
}

/// 收集源库待备份文件：跳过隐藏项、符号链接，以及顶层 `history/`、`trash/`。
fn collect(root: &Path) -> VaultResult<Vec<(String, PathBuf, u64)>> {
    let mut out = Vec::new();
    walk(root, root, true, &mut out)?;
    out.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(out)
}

fn walk(
    root: &Path,
    dir: &Path,
    top: bool,
    out: &mut Vec<(String, PathBuf, u64)>,
) -> VaultResult<()> {
    let mut items: Vec<_> = fs::read_dir(dir)?.collect::<Result<_, _>>()?;
    items.sort_by_key(|item| item.file_name());
    for item in items {
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = item.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            if top && SKIP_TOP_DIRS.contains(&name.as_str()) {
                continue;
            }
            walk(root, &item.path(), false, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = item.metadata()?;
        out.push((
            paths::to_rel(root, &item.path())?,
            item.path(),
            metadata.len(),
        ));
    }
    Ok(())
}

fn is_inside(root: &Path, candidate: &Path) -> bool {
    normalize(candidate).starts_with(normalize(root))
}

fn normalize(path: &Path) -> PathBuf {
    if let Ok(value) = path.canonicalize() {
        return value;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => normalize(parent).join(name),
        _ => path.to_path_buf(),
    }
}

/// 目录 fsync 复用 `atomic` 实现：Windows 上为 no-op（对目录 `File::open` 会返回 os error 5）。
fn fsync_dir(dir: &Path) -> io::Result<()> {
    atomic::fsync_dir(dir).map_err(|error| match error {
        VaultError::Io(inner) => inner,
        other => io::Error::other(other.to_string()),
    })
}

fn warn(detail: &str) {
    tracing::warn!(target: "vault::backup", "{}", detail);
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::*;

    fn seed(root: &Path, rel: &str, bytes: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, bytes).expect("seed");
    }

    fn vault() -> tempfile::TempDir {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", b"# A\n");
        seed(root, "notes/b.md", b"# B\n");
        seed(root, "media/image/ab/cat.png", b"\x89PNG");
        seed(root, ".workbench/settings.json", b"{}");
        seed(root, ".DS_Store", b"junk");
        seed(root, "history/old.md", b"old");
        seed(root, "trash/x/item", b"x");
        dir
    }

    #[test]
    fn export_copies_content_and_skips_internal_dirs() {
        let source = vault();
        let output = tempdir().expect("out");
        let target = output.path().join("EmberBackup");

        let report = export(source.path(), &target).expect("export");

        assert_eq!(report.files, 3, "只应备份 a.md / notes/b.md / media");
        assert!(target.join("a.md").exists());
        assert!(target.join("notes/b.md").exists());
        assert!(target.join("media/image/ab/cat.png").exists());
        assert!(!target.join(".workbench").exists());
        assert!(!target.join(".DS_Store").exists());
        assert!(!target.join("history").exists());
        assert!(!target.join("trash").exists());

        let manifest: Manifest =
            serde_json::from_slice(&fs::read(target.join(MANIFEST_NAME)).expect("manifest"))
                .expect("json");
        assert_eq!(manifest.version, MANIFEST_VERSION);
        assert_eq!(manifest.source_root, source.path().to_string_lossy());
        assert_eq!(manifest.files.len(), 3);
        assert_eq!(manifest.files[0].path, "a.md");
        assert_eq!(manifest.files[0].sha256.len(), 64);

        let checked = inspect(&target).expect("inspect");
        assert_eq!(checked.files, 3);
        assert_eq!(checked.bytes, report.bytes);
    }

    #[test]
    fn destination_must_be_absolute_fresh_and_outside_vault() {
        let source = vault();
        let output = tempdir().expect("out");

        let relative = export(source.path(), Path::new("backup")).expect_err("相对路径");
        assert_eq!(relative.code(), VaultError::InvalidArg("x".into()).code());

        let inside = export(source.path(), &source.path().join("backup")).expect_err("库内");
        assert_eq!(inside.code(), VaultError::InvalidArg("x".into()).code());

        let existing = output.path().join("EmberBackup");
        fs::create_dir_all(&existing).expect("existing");
        let error = export(source.path(), &existing).expect_err("已存在");
        assert_eq!(error.code(), VaultError::InvalidArg("x".into()).code());
        assert_eq!(
            fs::read_dir(&existing).expect("read").count(),
            0,
            "已存在的目标不得被写入"
        );
    }

    #[test]
    fn check_destination_probes_writability() {
        let source = vault();
        let output = tempdir().expect("out");
        let checked = check_destination(source.path(), output.path()).expect("可写");
        assert_eq!(checked.path, output.path().to_string_lossy());
        assert_eq!(fs::read_dir(output.path()).expect("read").count(), 0);

        fs::set_permissions(output.path(), fs::Permissions::from_mode(0o500)).expect("chmod");
        let error = check_destination(source.path(), output.path()).expect_err("只读");
        fs::set_permissions(output.path(), fs::Permissions::from_mode(0o700)).expect("restore");
        assert_eq!(error.code(), VaultError::InvalidArg("x".into()).code());
    }

    /// 备份目录可写性检查绝不能跟随预置 symlink 写穿库外文件。
    #[test]
    fn check_destination_never_writes_through_preseeded_symlink() {
        let source = vault();
        let output = tempdir().expect("out");
        let outside = tempdir().expect("outside");
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, b"keep").expect("seed victim");
        // 旧 probe 名是 `.ember-probe-{pid}-{seq}`；把常见序号都预先占成链接。
        for seq in 0..64 {
            let name = format!(".ember-probe-{}-{seq}", std::process::id());
            std::os::unix::fs::symlink(&victim, output.path().join(name)).expect("symlink");
        }

        check_destination(source.path(), output.path()).expect("可写");

        assert_eq!(fs::read(&victim).expect("victim"), b"keep");
    }

    #[test]
    fn inspect_rejects_tampered_manifest_and_missing_manifest() {
        let source = vault();
        let output = tempdir().expect("out");
        let target = output.path().join("EmberBackup");
        export(source.path(), &target).expect("export");

        let manifest_path = target.join(MANIFEST_NAME);
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest_path).expect("read")).expect("json");
        manifest["files"][0]["sha256"] = serde_json::Value::String("0".repeat(64));
        fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).expect("json"),
        )
        .expect("tamper");
        assert_eq!(
            inspect(&target).expect_err("哈希不符").code(),
            VaultError::Io(io::Error::other("x")).code()
        );

        fs::remove_file(&manifest_path).expect("remove manifest");
        assert_eq!(
            inspect(&target).expect_err("缺 manifest").code(),
            VaultError::NotFound.code()
        );
    }

    #[test]
    fn failed_copy_leaves_no_partial_backup() {
        let source = vault();
        let output = tempdir().expect("out");
        let target = output.path().join("EmberBackup");
        let calls = std::cell::Cell::new(0usize);

        let error = export_with(source.path(), &target, |source, target| {
            let index = calls.get() + 1;
            calls.set(index);
            if index == 2 {
                return Err(VaultError::Io(io::Error::other("模拟中途失败")));
            }
            copy_file(source, target)
        })
        .expect_err("中途失败必须上报");

        assert_eq!(error.code(), VaultError::Io(io::Error::other("x")).code());
        assert!(!target.exists(), "失败不得留下最终备份目录");
        let leftovers: Vec<_> = fs::read_dir(output.path())
            .expect("read")
            .filter_map(|item| item.ok())
            .map(|item| item.file_name().to_string_lossy().to_string())
            .collect();
        assert!(leftovers.is_empty(), "失败不得残留暂存目录：{leftovers:?}");
    }

    #[test]
    fn byte_total_overflow_is_invalid_arg() {
        assert_eq!(checked_total([1u64, 2, 3]).expect("正常累加"), 6);
        let error = checked_total([u64::MAX, 1]).expect_err("溢出必须上报");
        assert_eq!(error.code(), "E_INVALID_ARG");
    }
}
