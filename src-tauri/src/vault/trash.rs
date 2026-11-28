//! 回收站（PLAN.md §9.6）：系统废纸篓优先，失败才落库内暂存。
//!
//! 三条路径，优先级从高到低：
//! 1. 系统废纸篓（`vault/macos.rs`）：成功即最终态，后续记账失败只打日志；
//! 2. 库内 `rename`：同卷原子，降级主路径；
//! 3. 复制 + 删除：`rename` 遇 EXDEV（跨卷）时使用，
//!    复制到 temp → fsync → 校验 sha256 → rename 成 item → unlink 源。
//!
//! 不变式：2、3 任一步失败，源文件必须原封不动；失败后不残留暂存目录。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use ulid::Ulid;

use crate::ipc::trash::{TrashCleanupDto, TrashCleanupErrorDto, TrashEntryDto, TrashListDto};
use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::canvas;
use crate::vault::doc::not_found_or;
use crate::vault::gate::{self, WriteGate};
use crate::vault::identity;
use crate::vault::paths;

/// 库内暂存根：`.workbench/trash/<ULID>/`（vault-format §1）。
const TRASH_DIR: &str = "trash";
/// 暂存文件固定名；原始相对路径与大小记在 `meta.json`。
const ITEM_NAME: &str = "item";
const META_NAME: &str = "meta.json";
/// 复制中间文件：与 `item` 同目录，rename 才是原子的。
const COPY_TEMP: &str = ".copy.tmp";
/// EXDEV：跨卷 rename 失败，需退回复制 + 删除。
const EXDEV: i32 = 18;
/// 复制缓冲：不把整份文件读进内存。
const COPY_BUFFER: usize = 1024 * 1024;

/// 删除实际走到了哪条路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashVia {
    System,
    Workbench,
}

impl TrashVia {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Workbench => "workbench",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TrashResult {
    pub via: TrashVia,
    /// 本次删除的暂存 id：系统路径也生成，便于日志与「已删除」提示关联。
    pub trash_id: String,
}

/// 删除（移入回收站）。
pub fn delete(gate: &WriteGate, root: &Path, rel: &str) -> VaultResult<TrashResult> {
    delete_with(
        gate,
        root,
        rel,
        system_trash,
        rename_within_vault,
        copy_into_temp,
    )
}

/// 可注入的三段实现，测试用它覆盖各条降级路径：
/// - `native`：系统回收站（真实实现只在 macOS 编译）；
/// - `rename`：库内同卷移动（测试可注入 EXDEV 强制走复制）；
/// - `copy`：跨卷退化的复制（测试可注入中途失败 / 内容损坏）。
pub(crate) fn delete_with<F, R, C>(
    gate: &WriteGate,
    root: &Path,
    rel: &str,
    native: F,
    rename: R,
    copy: C,
) -> VaultResult<TrashResult>
where
    F: Fn(&Path) -> Result<(), String>,
    R: Fn(&Path, &Path) -> io::Result<()>,
    C: Fn(&Path, &Path) -> VaultResult<()>,
{
    let canvas_path = canvas::canvas_removal_path(root, rel)?;
    let path = match canvas_path.as_ref() {
        Some(path) => path.clone(),
        None => paths::resolve(root, rel)?,
    };
    let _permit = gate.enter()?;
    if canvas_path.is_some() {
        canvas::reject_canvas_removal_directory_symlink(root)?;
    }
    let metadata = fs::symlink_metadata(&path).map_err(not_found_or)?;
    let file_type = metadata.file_type();
    if canvas_path.is_some() {
        if file_type.is_symlink() {
            return Err(VaultError::PathEscape);
        }
        if !file_type.is_file() {
            return Err(VaultError::Perm);
        }
    } else if !file_type.is_file() && !file_type.is_dir() {
        return Err(VaultError::NotFound);
    }
    // 在系统回收或 rename 之前完整走查：根/后代 symlink 与特殊文件都 fail closed。
    let bytes = item_bytes(&path)?;
    let source_is_dir = file_type.is_dir();
    let archive_path = paths::to_rel(root, &path)?;
    let meta = Meta {
        id: Ulid::generate().to_string(),
        via: TrashVia::System,
        path: archive_path.clone(),
        bytes,
        deleted_at: identity::now_iso8601(),
    };

    match native(&path) {
        Ok(()) => {
            // 系统废纸篓已是最终态：记账失败只打日志，绝不回头删/恢复文件。
            record_best_effort(root, &meta);
            Ok(TrashResult {
                via: TrashVia::System,
                trash_id: meta.id,
            })
        }
        Err(reason) => {
            warn(&format!(
                "系统回收站失败（{reason}），降级到库内暂存：{archive_path}"
            ));
            place_in_vault(gate, root, &path, source_is_dir, meta, rename, copy)
        }
    }
}

/// 库内暂存：rename 优先，EXDEV 时退回复制 + 校验 + 删除。
fn place_in_vault<R, C>(
    gate: &WriteGate,
    root: &Path,
    source: &Path,
    source_is_dir: bool,
    mut meta: Meta,
    rename: R,
    copy: C,
) -> VaultResult<TrashResult>
where
    R: Fn(&Path, &Path) -> io::Result<()>,
    C: Fn(&Path, &Path) -> VaultResult<()>,
{
    meta.via = TrashVia::Workbench;
    let dir = paths::workbench(root).join(TRASH_DIR).join(&meta.id);
    let item = dir.join(ITEM_NAME);
    fs::create_dir_all(&dir).map_err(|error| map_fallback(gate, error.into()))?;

    match rename(source, &item) {
        Ok(()) => {
            if let Err(error) = fsync_dir(&dir) {
                // 移动已完成，目录 fsync 失败不改变结果。
                warn(&format!("暂存目录 fsync 失败：{error}"));
            }
            record_best_effort(root, &meta);
            return Ok(TrashResult {
                via: TrashVia::Workbench,
                trash_id: meta.id,
            });
        }
        Err(error) if error.raw_os_error() == Some(EXDEV) => {
            if source_is_dir {
                // 当前复制降级只校验单个普通文件；目录跨卷必须保留源并安全失败。
                let _ = fs::remove_dir_all(&dir);
                warn(&format!(
                    "目录跨卷 rename（EXDEV），不支持递归复制，源目录保留：{}",
                    meta.path
                ));
                return Err(VaultError::TrashFailed);
            }
            warn(&format!(
                "跨卷 rename（EXDEV），退回复制+删除：{}",
                meta.path
            ));
        }
        Err(error) => {
            let _ = fs::remove_dir_all(&dir);
            return Err(map_fallback(gate, error.into()));
        }
    }

    let temp = dir.join(COPY_TEMP);
    match apply_copy(copy, source, &temp, &item, &dir) {
        Ok(()) => {
            if let Some(parent) = source.parent() {
                if let Err(error) = fsync_dir(parent) {
                    warn(&format!("源目录 fsync 失败：{error}"));
                }
            }
            record_best_effort(root, &meta);
            Ok(TrashResult {
                via: TrashVia::Workbench,
                trash_id: meta.id,
            })
        }
        Err(error) => {
            // 源文件未动；暂存目录内可能留有半截 temp，整目录清掉。
            let _ = fs::remove_dir_all(&dir);
            Err(map_fallback(gate, error))
        }
    }
}

/// 复制 → fsync → 校验 sha256 → rename 成 item → unlink 源。
///
/// 顺序写死：只有副本已落盘且哈希与源一致，才允许删除源文件。
/// 任一步失败都只污染 `dir` 内内容，由调用方清理，源文件保持原样。
fn apply_copy<C>(copy: C, source: &Path, temp: &Path, item: &Path, dir: &Path) -> VaultResult<()>
where
    C: Fn(&Path, &Path) -> VaultResult<()>,
{
    copy(source, temp)?;
    fsync_dir(dir)?;
    if atomic::hash_file(source)? != atomic::hash_file(temp)? {
        return Err(VaultError::Io(io::Error::other(
            "复制内容与源文件哈希不一致",
        )));
    }
    fs::rename(temp, item)?;
    fsync_dir(dir)?;
    fs::remove_file(source)?;
    Ok(())
}

/// 单次删除的记账内容；只用于日志与健康面板，不参与数据恢复。
struct Meta {
    id: String,
    via: TrashVia,
    path: String,
    bytes: u64,
    deleted_at: String,
}

/// 记账失败一律只打日志：此时文件要么已在系统废纸篓，要么已在库内暂存，
/// 两种终态都不允许因为一个 json 而回滚。
fn record_best_effort(root: &Path, meta: &Meta) {
    if let Err(error) = write_meta(root, meta) {
        warn(&format!(
            "meta.json 写入失败（{}），不影响已完成的删除：{}",
            error.code(),
            meta.path
        ));
    }
}

fn write_meta(root: &Path, meta: &Meta) -> VaultResult<()> {
    let dir = paths::workbench(root).join(TRASH_DIR).join(&meta.id);
    fs::create_dir_all(&dir)?;
    let value = serde_json::json!({
        "schemaVersion": 1,
        "id": meta.id,
        "via": meta.via.as_str(),
        "path": meta.path,
        "bytes": meta.bytes,
        "deletedAt": meta.deleted_at,
    });
    let bytes = serde_json::to_vec_pretty(&value)
        .map_err(|error| VaultError::InvalidArg(format!("meta.json 序列化失败：{error}")))?;
    atomic::write_atomic(&dir.join(META_NAME), &bytes).map(|_| ())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryMeta {
    schema_version: u32,
    id: String,
    via: String,
    path: Option<String>,
    #[serde(rename = "bytes")]
    _bytes: u64,
    deleted_at: Option<String>,
}

fn require_real_dir(path: &Path) -> VaultResult<()> {
    let metadata = fs::symlink_metadata(path).map_err(not_found_or)?;
    if metadata.file_type().is_symlink() {
        return Err(VaultError::PathEscape);
    }
    if !metadata.is_dir() {
        return Err(VaultError::NotFound);
    }
    Ok(())
}

fn checked_trash_root(root: &Path) -> VaultResult<PathBuf> {
    let workbench = paths::workbench(root);
    require_real_dir(&workbench)?;
    let trash = workbench.join(TRASH_DIR);
    require_real_dir(&trash)?;
    Ok(trash)
}

fn checked_entry_dir(root: &Path, id: &str) -> VaultResult<PathBuf> {
    Ulid::from_string(id)
        .map_err(|_| VaultError::InvalidArg(format!("trash id 必须是合法 ULID：{id}")))?;
    let trash = checked_trash_root(root)?;
    let dir = trash.join(id);
    if dir.parent() != Some(trash.as_path()) {
        return Err(VaultError::PathEscape);
    }
    require_real_dir(&dir)?;
    Ok(dir)
}

/// 只汇总 item 自身的普通文件；任何 symlink / 特殊文件都使条目不可安全识别。
fn item_bytes(item: &Path) -> VaultResult<u64> {
    let mut pending = vec![item.to_path_buf()];
    let mut total = 0u64;
    while let Some(path) = pending.pop() {
        let metadata = fs::symlink_metadata(&path).map_err(not_found_or)?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Err(VaultError::PathEscape);
        }
        if file_type.is_file() {
            total = total.checked_add(metadata.len()).ok_or_else(|| {
                VaultError::InvalidArg("trash item 字节数超出 u64 范围".to_string())
            })?;
        } else if file_type.is_dir() {
            for entry in fs::read_dir(&path)? {
                pending.push(entry?.path());
            }
        } else {
            return Err(VaultError::InvalidArg(
                "trash item 只支持普通文件或目录".to_string(),
            ));
        }
    }
    Ok(total)
}

fn inspect_entry(root: &Path, id: &str) -> VaultResult<TrashEntryDto> {
    let dir = checked_entry_dir(root, id)?;
    let meta_path = dir.join(META_NAME);
    let meta_file = fs::symlink_metadata(&meta_path).map_err(not_found_or)?;
    if meta_file.file_type().is_symlink() {
        return Err(VaultError::PathEscape);
    }
    if !meta_file.is_file() {
        return Err(VaultError::InvalidArg(format!(
            "trash metadata 不是普通文件：{id}"
        )));
    }
    let bytes = fs::read(&meta_path).map_err(not_found_or)?;
    let meta: InventoryMeta = serde_json::from_slice(&bytes)
        .map_err(|error| VaultError::InvalidArg(format!("trash metadata 无效：{id}：{error}")))?;
    if meta.schema_version != 1 || meta.id != id {
        return Err(VaultError::InvalidArg(format!(
            "trash metadata 与目录不匹配：{id}"
        )));
    }
    if meta.via != TrashVia::Workbench.as_str() {
        return Err(VaultError::InvalidArg(format!(
            "系统回收站条目不属于 Workbench inventory：{id}"
        )));
    }
    if let Some(path) = meta.path.as_deref() {
        // metadata 只用于展示；校验原始路径格式，但绝不把它作为清理目标。
        paths::resolve(root, path)?;
    }
    let bytes = item_bytes(&dir.join(ITEM_NAME))?;
    Ok(TrashEntryDto {
        id: id.to_string(),
        path: meta.path,
        bytes,
        deleted_at: meta.deleted_at,
    })
}

/// Workbench trash 全量清单；不按 retention 过滤，无法安全识别的条目直接忽略。
pub(crate) fn list(root: &Path) -> TrashListDto {
    let Ok(trash) = checked_trash_root(root) else {
        return TrashListDto::default();
    };
    let Ok(entries) = fs::read_dir(trash) else {
        return TrashListDto::default();
    };
    let mut inventory: Vec<TrashEntryDto> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_type()
                .map(|file_type| file_type.is_dir())
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            let id = entry.file_name().into_string().ok()?;
            inspect_entry(root, &id).ok()
        })
        .collect();
    inventory.sort_by(|left, right| {
        let by_date = match (&left.deleted_at, &right.deleted_at) {
            (Some(left), Some(right)) => right.cmp(left),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        };
        by_date.then_with(|| left.id.cmp(&right.id))
    });
    TrashListDto { entries: inventory }
}

fn checked_cleanup_target(root: &Path, id: &str) -> VaultResult<PathBuf> {
    let dir = checked_entry_dir(root, id)?;
    inspect_entry(root, id)?;
    Ok(dir)
}

/// 单条失败只归入响应，不把辅助清理故障闩锁成全库只读；错误码沿用写路径口径。
fn map_cleanup_write_error(error: io::Error) -> VaultError {
    if gate::is_readonly_io(&error) {
        VaultError::Readonly
    } else {
        error.into()
    }
}

/// 永久清理指定 Workbench 暂存；目标只由合法 id 推导，绝不使用 metadata.path。
pub(crate) fn cleanup_by_ids(
    gate: &WriteGate,
    root: &Path,
    ids: &[String],
) -> VaultResult<TrashCleanupDto> {
    if ids.is_empty() {
        return Err(VaultError::InvalidArg(
            "trash cleanup ids 不能为空".to_string(),
        ));
    }
    let _permit = gate.enter()?;
    let mut report = TrashCleanupDto::default();
    for id in ids {
        let result = checked_cleanup_target(root, id).and_then(|dir| {
            fs::remove_dir_all(dir).map_err(|error| {
                if error.kind() == io::ErrorKind::NotFound {
                    VaultError::NotFound
                } else {
                    map_cleanup_write_error(error)
                }
            })
        });
        match result {
            Ok(()) => report.removed_ids.push(id.clone()),
            Err(error) => report.errors.push(TrashCleanupErrorDto {
                id: id.clone(),
                code: error.code(),
                message: error.to_string(),
            }),
        }
    }
    Ok(report)
}

/// 清扫完成事件（前端订阅）。
pub const SWEEP_EVENT: &str = "vault://trash-sweep";

/// 本轮清扫为何没做。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SweepSkip {
    /// 只读态（锁被其它实例持有或文件系统只读）。
    Readonly,
    /// 写队列正被其它写操作占用。
    Busy,
}

#[derive(Debug, Clone)]
pub struct SweepError {
    pub id: String,
    pub message: String,
}

/// 一次清扫的结果：单条失败进 `errors`，不打断后续目录。
#[derive(Debug, Clone, Default)]
pub struct SweepReport {
    pub scanned: usize,
    pub removed: Vec<String>,
    pub errors: Vec<SweepError>,
    pub skipped: Option<SweepSkip>,
}

/// 清扫超过保留期的暂存目录（PLAN.md §9.6：启动时一次，不循环）。
///
/// 只读或拿不到写锁时立即返回 `skipped`，绝不排队阻塞调用方；
/// 单条目录删除失败只记入 `errors`，继续清理后续目录。
/// 目录年龄以 mtime 为准：把条目 rename 进目录会刷新它的 mtime，
/// 比 meta.json 更可靠（记账失败时依然有年龄可循）。
pub fn sweep(gate: &WriteGate, root: &Path, retention_days: u32, now: SystemTime) -> SweepReport {
    if gate.readonly_reason().is_some() {
        warn("skippedReadonly：库处于只读态，跳过本次清扫");
        return SweepReport {
            skipped: Some(SweepSkip::Readonly),
            ..SweepReport::default()
        };
    }
    let Some(_permit) = gate.try_enter() else {
        warn("skippedBusy：写队列被占用，跳过本次清扫");
        return SweepReport {
            skipped: Some(SweepSkip::Busy),
            ..SweepReport::default()
        };
    };
    sweep_locked(root, retention_days, now)
}

fn sweep_locked(root: &Path, retention_days: u32, now: SystemTime) -> SweepReport {
    let mut report = SweepReport::default();
    let entries = match fs::read_dir(paths::workbench(root).join(TRASH_DIR)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return report,
        Err(error) => {
            warn(&format!("清扫无法读取暂存目录：{error}"));
            report.errors.push(SweepError {
                id: TRASH_DIR.to_string(),
                message: error.to_string(),
            });
            return report;
        }
    };
    let cutoff = now
        .checked_sub(Duration::from_secs(u64::from(retention_days) * 86_400))
        .unwrap_or(UNIX_EPOCH);

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                report.errors.push(SweepError {
                    id: TRASH_DIR.to_string(),
                    message: error.to_string(),
                });
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        match entry.file_type() {
            Ok(file_type) if file_type.is_dir() => {}
            Ok(_) => continue,
            Err(error) => {
                report.errors.push(SweepError {
                    id: name,
                    message: error.to_string(),
                });
                continue;
            }
        }
        report.scanned += 1;
        // `DirEntry::metadata` 不跟随 symlink；取不到年龄就不删，宁可留到下一轮。
        let modified = match entry.metadata().and_then(|metadata| metadata.modified()) {
            Ok(modified) => modified,
            Err(error) => {
                report.errors.push(SweepError {
                    id: name,
                    message: error.to_string(),
                });
                continue;
            }
        };
        if modified >= cutoff {
            continue;
        }
        match fs::remove_dir_all(entry.path()) {
            Ok(()) => {
                warn(&format!("已清扫过期暂存：{name}"));
                report.removed.push(name);
            }
            Err(error) => {
                warn(&format!("清扫失败（继续后续目录）：{name}：{error}"));
                report.errors.push(SweepError {
                    id: name,
                    message: error.to_string(),
                });
            }
        }
    }
    report
}

/// 库内同卷移动；抽成函数以便测试注入 EXDEV。
fn rename_within_vault(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

/// 跨卷退化：流式复制到 temp 并 fsync，不把整份内容读进内存。
fn copy_into_temp(source: &Path, temp: &Path) -> VaultResult<()> {
    let mut reader = File::open(source)?;
    let mut writer = File::create(temp)?;
    let mut buffer = vec![0u8; COPY_BUFFER];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        writer.write_all(&buffer[..read])?;
    }
    writer.sync_all()?;
    Ok(())
}

/// 目录 fsync 复用 `atomic` 实现：Windows 上为 no-op（对目录 `File::open` 会返回 os error 5）。
fn fsync_dir(dir: &Path) -> io::Result<()> {
    atomic::fsync_dir(dir).map_err(|error| match error {
        VaultError::Io(inner) => inner,
        other => io::Error::other(other.to_string()),
    })
}

/// 库内路径失败：保留只读/磁盘满这两个可恢复语义，其余收敛为 `E_TRASH_FAILED`。
fn map_fallback(gate: &WriteGate, error: VaultError) -> VaultError {
    let mapped = gate::map_write_result(gate, error);
    if matches!(&mapped, VaultError::Readonly | VaultError::DiskFull) {
        return mapped;
    }
    warn(&format!("库内暂存失败：{mapped}"));
    VaultError::TrashFailed
}

/// 系统回收站入口：真实 FFI 按平台分文件实现，其它平台直接走库内降级。
#[cfg(target_os = "macos")]
fn system_trash(path: &Path) -> Result<(), String> {
    crate::vault::macos::trash_item(path)
}

#[cfg(target_os = "windows")]
fn system_trash(path: &Path) -> Result<(), String> {
    crate::vault::windows::trash_item(path)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_trash(_path: &Path) -> Result<(), String> {
    Err("当前平台未实现系统回收站".to_string())
}

/// 回收站清扫报告：走结构化日志落盘到 ember.log（打包后 stderr 不可见）。
pub(crate) fn warn(detail: &str) {
    tracing::warn!(target: "vault::trash", "{}", detail);
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tempfile::tempdir;

    use super::*;
    use crate::ipc::ReadonlyReason;
    use crate::vault::constants::TRASH_RETENTION_DAYS;

    fn seed(root: &Path, rel: &str, bytes: &[u8]) -> PathBuf {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(&path, bytes).expect("seed");
        path
    }

    fn trash_dir(root: &Path) -> PathBuf {
        paths::workbench(root).join(TRASH_DIR)
    }

    fn meta_of(root: &Path, id: &str) -> serde_json::Value {
        let text = fs::read_to_string(trash_dir(root).join(id).join(META_NAME)).expect("meta.json");
        serde_json::from_str(&text).expect("meta json")
    }

    fn assert_no_leftovers(root: &Path) {
        let dir = trash_dir(root);
        if dir.exists() {
            assert_eq!(
                fs::read_dir(&dir).expect("read_dir").count(),
                0,
                "失败后不得残留暂存目录"
            );
        }
    }

    fn native_ok(path: &Path) -> Result<(), String> {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.is_dir() {
            fs::remove_dir_all(path).map_err(|error| error.to_string())
        } else {
            fs::remove_file(path).map_err(|error| error.to_string())
        }
    }

    fn native_err(_path: &Path) -> Result<(), String> {
        Err("TCC 拒绝".to_string())
    }

    fn make_trash_dir(root: &Path, id: &str, age_days: u64) -> PathBuf {
        let dir = paths::workbench(root).join(TRASH_DIR).join(id);
        fs::create_dir_all(&dir).expect("trash dir");
        fs::write(dir.join(ITEM_NAME), b"x").expect("item");
        let modified = SystemTime::now() - Duration::from_secs(age_days * 86_400);
        File::open(&dir)
            .expect("open dir")
            .set_times(fs::FileTimes::new().set_modified(modified))
            .expect("set times");
        dir
    }

    fn make_inventory_entry(
        root: &Path,
        id: &str,
        via: &str,
        path: Option<&str>,
        deleted_at: Option<&str>,
        content: &[u8],
    ) -> PathBuf {
        let dir = trash_dir(root).join(id);
        fs::create_dir_all(&dir).expect("inventory dir");
        fs::write(dir.join(ITEM_NAME), content).expect("inventory item");
        let meta = serde_json::json!({
            "schemaVersion": 1,
            "id": id,
            "via": via,
            "path": path,
            "bytes": 999_999,
            "deletedAt": deleted_at,
        });
        fs::write(
            dir.join(META_NAME),
            serde_json::to_vec(&meta).expect("inventory meta"),
        )
        .expect("write inventory meta");
        dir
    }

    fn crosses_device(_from: &Path, _to: &Path) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(EXDEV))
    }

    #[test]
    fn native_success_is_final_and_skips_vault_trash() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "notes/a.md", b"alpha");

        let result = delete_with(
            &gate,
            root,
            "notes/a.md",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect("delete");

        assert_eq!(result.via, TrashVia::System);
        assert!(!path.exists());
        let meta = meta_of(root, &result.trash_id);
        assert_eq!(meta["via"], "system");
        assert_eq!(meta["path"], "notes/a.md");
        assert_eq!(meta["bytes"], 5);
        assert!(
            !trash_dir(root)
                .join(&result.trash_id)
                .join(ITEM_NAME)
                .exists(),
            "系统路径不得再往库内写副本"
        );
    }

    #[test]
    fn native_success_survives_meta_write_failure() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "a.md", b"alpha");
        // 用同名文件堵住 `.workbench/trash`，让记账必然失败。
        fs::create_dir_all(paths::workbench(root)).expect("workbench");
        fs::write(paths::workbench(root).join(TRASH_DIR), b"blocker").expect("blocker");

        let result = delete_with(
            &gate,
            root,
            "a.md",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect("系统回收站成功不得被记账失败拖垮");

        assert_eq!(result.via, TrashVia::System);
        assert!(!path.exists(), "系统废纸篓是最终态，绝不回滚");
    }

    #[test]
    fn native_success_supports_nonempty_directories_and_sums_bytes() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        seed(root, "folder/nested/a.md", b"a");
        seed(root, "folder/b.md", b"bb");

        let result = delete_with(
            &gate,
            root,
            "folder",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect("目录系统回收");

        assert_eq!(result.via, TrashVia::System);
        assert!(!root.join("folder").exists());
        let meta = meta_of(root, &result.trash_id);
        assert_eq!(meta["path"], "folder");
        assert_eq!(meta["bytes"], 3);
    }

    #[test]
    fn native_failure_moves_empty_directory_by_rename() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        fs::create_dir_all(root.join("empty/nested")).expect("directory");

        let result = delete_with(
            &gate,
            root,
            "empty",
            native_err,
            rename_within_vault,
            copy_into_temp,
        )
        .expect("目录同卷移动");

        assert_eq!(result.via, TrashVia::Workbench);
        assert!(!root.join("empty").exists());
        let item = trash_dir(root).join(&result.trash_id).join(ITEM_NAME);
        assert!(item.join("nested").is_dir());
        assert_eq!(meta_of(root, &result.trash_id)["bytes"], 0);
    }

    #[test]
    fn cross_device_directory_failure_preserves_source_and_skips_copy() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let source = seed(root, "folder/nested/a.md", b"alpha");

        let error = delete_with(
            &gate,
            root,
            "folder",
            native_err,
            crosses_device,
            |_source: &Path, _temp: &Path| -> VaultResult<()> {
                panic!("目录 EXDEV 不得进入单文件复制降级")
            },
        )
        .expect_err("目录跨卷必须安全失败");

        assert_eq!(error.code(), VaultError::TrashFailed.code());
        assert_eq!(fs::read(source).expect("source"), b"alpha");
        assert!(root.join("folder/nested").is_dir());
        assert_no_leftovers(root);
    }

    #[test]
    fn bad_id_canvas_file_can_be_removed_but_canvas_directory_cannot() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, ".workbench/canvas/bad.id.canvas.json", b"{}");

        let result = delete_with(
            &gate,
            root,
            ".workbench/canvas/bad.id.canvas.json",
            native_err,
            rename_within_vault,
            copy_into_temp,
        )
        .expect("bad-id 普通文件可删除");

        assert_eq!(result.via, TrashVia::Workbench);
        assert!(!path.exists());
        assert_eq!(
            fs::read(trash_dir(root).join(&result.trash_id).join(ITEM_NAME)).expect("item"),
            b"{}"
        );

        fs::create_dir_all(root.join(".workbench/canvas/not-file.canvas.json"))
            .expect("canvas directory entry");
        let error = delete_with(
            &gate,
            root,
            ".workbench/canvas/not-file.canvas.json",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect_err("画布路径例外只允许普通文件");
        assert_eq!(error.code(), VaultError::Perm.code());
        assert!(root.join(".workbench/canvas/not-file.canvas.json").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn directory_and_canvas_symlinks_or_special_files_fail_before_native() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let outside = seed(root, "outside.md", b"safe");
        fs::create_dir_all(root.join("folder")).expect("folder");
        symlink(&outside, root.join("folder/link")).expect("nested symlink");

        let error = delete_with(
            &gate,
            root,
            "folder",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect_err("嵌套 symlink 必须拒绝");
        assert_eq!(error.code(), VaultError::PathEscape.code());
        assert_eq!(fs::read(&outside).expect("outside"), b"safe");
        fs::remove_file(root.join("folder/link")).expect("remove nested symlink");

        let fifo = root.join("folder/pipe");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .expect("mkfifo")
            .success());
        let error = delete_with(
            &gate,
            root,
            "folder",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect_err("嵌套特殊文件必须拒绝");
        assert_eq!(error.code(), VaultError::InvalidArg("".into()).code());
        assert!(fifo.exists());
        fs::remove_file(fifo).expect("remove fifo");

        let canvas_dir = root.join(".workbench/canvas");
        fs::create_dir_all(&canvas_dir).expect("canvas dir");
        symlink(&outside, canvas_dir.join("bad.id.canvas.json")).expect("canvas target symlink");
        let error = delete_with(
            &gate,
            root,
            ".workbench/canvas/bad.id.canvas.json",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect_err("画布目标 symlink 必须拒绝");
        assert_eq!(error.code(), VaultError::PathEscape.code());
        assert_eq!(fs::read(&outside).expect("outside"), b"safe");
        fs::remove_file(canvas_dir.join("bad.id.canvas.json")).expect("remove target symlink");

        let linked_canvas_root = tempdir().expect("linked canvas root");
        let linked_root = linked_canvas_root.path();
        let outside_canvas = tempdir().expect("outside canvas");
        let outside_file = seed(outside_canvas.path(), "bad.id.canvas.json", b"safe");
        fs::create_dir_all(linked_root.join(".workbench")).expect("workbench");
        symlink(outside_canvas.path(), linked_root.join(".workbench/canvas"))
            .expect("canvas parent symlink");
        let error = delete_with(
            &gate,
            linked_root,
            ".workbench/canvas/bad.id.canvas.json",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect_err("画布父目录 symlink 必须拒绝");
        assert_eq!(error.code(), VaultError::Perm.code());
        assert_eq!(
            fs::read(outside_file).expect("outside canvas file"),
            b"safe"
        );
    }

    #[test]
    fn native_failure_falls_back_to_vault_rename() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "notes/a.md", b"alpha");

        let result = delete_with(
            &gate,
            root,
            "notes/a.md",
            native_err,
            rename_within_vault,
            copy_into_temp,
        )
        .expect("fallback");

        assert_eq!(result.via, TrashVia::Workbench);
        assert!(!path.exists());
        let item = trash_dir(root).join(&result.trash_id).join(ITEM_NAME);
        assert_eq!(fs::read(&item).expect("item"), b"alpha");
        let meta = meta_of(root, &result.trash_id);
        assert_eq!(meta["via"], "workbench");
        assert_eq!(meta["path"], "notes/a.md");
        assert!(meta["deletedAt"]
            .as_str()
            .expect("deletedAt")
            .ends_with('Z'));
    }

    #[test]
    fn cross_device_rename_copies_verifies_then_unlinks() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "a.md", b"alpha");

        let result = delete_with(
            &gate,
            root,
            "a.md",
            native_err,
            crosses_device,
            copy_into_temp,
        )
        .expect("复制降级");

        assert_eq!(result.via, TrashVia::Workbench);
        assert!(!path.exists());
        assert_eq!(
            fs::read(trash_dir(root).join(&result.trash_id).join(ITEM_NAME)).expect("item"),
            b"alpha"
        );
    }

    #[test]
    fn copy_failure_keeps_source_and_leaves_no_temp() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "a.md", b"alpha");

        let error = delete_with(
            &gate,
            root,
            "a.md",
            native_err,
            crosses_device,
            |_source: &Path, temp: &Path| {
                fs::write(temp, b"partial").expect("partial");
                Err(VaultError::Io(io::Error::other("模拟复制中途失败")))
            },
        )
        .expect_err("复制失败必须上报");

        assert_eq!(error.code(), VaultError::TrashFailed.code());
        assert_eq!(
            fs::read(&path).expect("source"),
            b"alpha",
            "源文件必须原封不动"
        );
        assert_no_leftovers(root);
    }

    #[test]
    fn copy_hash_mismatch_keeps_source_and_discards_copy() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "a.md", b"alpha");

        // 字节数相同但内容不同：只能靠 sha256 拦住。
        let error = delete_with(
            &gate,
            root,
            "a.md",
            native_err,
            crosses_device,
            |_source: &Path, temp: &Path| {
                fs::write(temp, b"ALPHA").expect("corrupt");
                Ok(())
            },
        )
        .expect_err("哈希不一致必须上报");

        assert_eq!(error.code(), VaultError::TrashFailed.code());
        assert_eq!(fs::read(&path).expect("source"), b"alpha");
        assert_no_leftovers(root);
    }

    #[test]
    fn rename_failure_without_exdev_keeps_source() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let path = seed(root, "a.md", b"alpha");

        let error = delete_with(
            &gate,
            root,
            "a.md",
            native_err,
            |_from: &Path, _to: &Path| Err(io::Error::from_raw_os_error(13)),
            copy_into_temp,
        )
        .expect_err("EACCES 应上报只读");

        assert_eq!(error.code(), VaultError::Readonly.code());
        assert!(gate.readonly_reason().is_some(), "只读闩锁必须点亮");
        assert_eq!(fs::read(&path).expect("source"), b"alpha");
        assert_no_leftovers(root);
    }

    #[test]
    fn readonly_gate_rejects_delete_without_touching_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let path = seed(root, "a.md", b"alpha");
        let gate = WriteGate::new(Some(ReadonlyReason::LockedByOther));

        let error = delete_with(
            &gate,
            root,
            "a.md",
            native_ok,
            rename_within_vault,
            copy_into_temp,
        )
        .expect_err("只读态必须拒绝");

        assert_eq!(error.code(), VaultError::Readonly.code());
        assert_eq!(fs::read(&path).expect("source"), b"alpha");
        assert!(!trash_dir(root).exists(), "只读态不得创建暂存目录");
    }

    #[test]
    fn missing_and_escapes_are_rejected_before_ffi() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);

        for (rel, code) in [
            ("missing.md", VaultError::NotFound.code()),
            ("../outside.md", VaultError::PathEscape.code()),
            (".workbench/settings.json", VaultError::ReservedPath.code()),
        ] {
            let error = delete_with(
                &gate,
                root,
                rel,
                native_err,
                rename_within_vault,
                copy_into_temp,
            )
            .expect_err(rel);
            assert_eq!(error.code(), code, "路径 {rel} 判定漂移");
        }
    }

    #[test]
    fn inventory_lists_real_items_by_date_and_actual_bytes_without_retention_filter() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let newest_a = Ulid::generate().to_string();
        let newest_b = Ulid::generate().to_string();
        let older = Ulid::generate().to_string();
        let undated = Ulid::generate().to_string();

        let newest_a_dir = make_inventory_entry(
            root,
            &newest_a,
            "workbench",
            Some("notes/directory.md"),
            Some("2026-11-20T12:00:00Z"),
            b"ignored",
        );
        fs::remove_file(newest_a_dir.join(ITEM_NAME)).expect("replace file item");
        fs::create_dir_all(newest_a_dir.join(ITEM_NAME).join("nested")).expect("item dir");
        fs::write(newest_a_dir.join(ITEM_NAME).join("a.bin"), b"ab").expect("item a");
        fs::write(newest_a_dir.join(ITEM_NAME).join("nested/b.bin"), b"cde").expect("item b");
        make_inventory_entry(
            root,
            &newest_b,
            "workbench",
            Some("notes/newest.md"),
            Some("2026-11-20T12:00:00Z"),
            b"four",
        );
        let older_dir = make_inventory_entry(
            root,
            &older,
            "workbench",
            Some("notes/older.md"),
            Some("2026-11-19T12:00:00Z"),
            b"old",
        );
        File::open(&older_dir)
            .expect("open old dir")
            .set_times(
                fs::FileTimes::new()
                    .set_modified(SystemTime::now() - Duration::from_secs(30 * 86_400)),
            )
            .expect("age beyond retention");
        make_inventory_entry(root, &undated, "workbench", None, None, b"");

        let entries = list(root).entries;
        assert_eq!(entries.len(), 4);
        let mut newest_ids = [newest_a.clone(), newest_b.clone()];
        newest_ids.sort();
        assert_eq!(entries[0].id, newest_ids[0]);
        assert_eq!(entries[1].id, newest_ids[1]);
        assert_eq!(entries[2].id, older, "超过 retention 仍须列出");
        assert_eq!(entries[3].id, undated, "无日期的条目排在最后");
        assert_eq!(entries[2].bytes, 3, "不得信任 metadata.bytes");
        assert_eq!(entries[3].path, None);
        assert_eq!(entries[3].deleted_at, None);
        assert_eq!(entries[3].bytes, 0);
        let directory_entry = entries
            .iter()
            .find(|entry| entry.id == newest_a)
            .expect("directory item");
        assert_eq!(directory_entry.bytes, 5, "目录递归汇总普通文件");
    }

    #[test]
    fn inventory_ignores_meta_only_bad_ids_metadata_escapes_and_system_records() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let meta_only = Ulid::generate().to_string();
        let meta_only_dir =
            make_inventory_entry(root, &meta_only, "workbench", Some("a.md"), None, b"x");
        fs::remove_file(meta_only_dir.join(ITEM_NAME)).expect("meta only");
        make_inventory_entry(root, "not-a-ulid", "workbench", Some("a.md"), None, b"x");
        make_inventory_entry(
            root,
            &Ulid::generate().to_string(),
            "workbench",
            Some("../outside.md"),
            None,
            b"x",
        );
        make_inventory_entry(
            root,
            &Ulid::generate().to_string(),
            "system",
            Some("a.md"),
            None,
            b"x",
        );
        let mismatched = Ulid::generate().to_string();
        let mismatched_dir =
            make_inventory_entry(root, &mismatched, "workbench", Some("a.md"), None, b"x");
        let mut meta = meta_of(root, &mismatched);
        meta["id"] = serde_json::json!(Ulid::generate().to_string());
        fs::write(
            mismatched_dir.join(META_NAME),
            serde_json::to_vec(&meta).expect("mismatched meta"),
        )
        .expect("write mismatched meta");
        let malformed = Ulid::generate().to_string();
        let malformed_dir =
            make_inventory_entry(root, &malformed, "workbench", Some("a.md"), None, b"x");
        fs::write(malformed_dir.join(META_NAME), b"{").expect("malformed meta");
        let no_meta = trash_dir(root).join(Ulid::generate().to_string());
        fs::create_dir_all(&no_meta).expect("no meta dir");
        fs::write(no_meta.join(ITEM_NAME), b"x").expect("no meta item");

        assert!(list(root).entries.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn inventory_and_cleanup_reject_directory_and_item_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().expect("root");
        let root = dir.path();
        let outside = tempdir().expect("outside");
        let outside_file = seed(outside.path(), "victim", b"safe");
        let linked_id = Ulid::generate().to_string();
        let linked_dir = trash_dir(root).join(&linked_id);
        fs::create_dir_all(trash_dir(root)).expect("trash root");
        symlink(outside.path(), &linked_dir).expect("dir symlink");

        assert!(list(root).entries.is_empty());
        let report = cleanup_by_ids(&WriteGate::new(None), root, &[linked_id]).expect("report");
        assert_eq!(report.errors[0].code, "E_PATH_ESCAPE");
        assert_eq!(fs::read(&outside_file).expect("outside"), b"safe");

        let item_id = Ulid::generate().to_string();
        let item_dir = make_inventory_entry(root, &item_id, "workbench", Some("a.md"), None, b"x");
        fs::remove_file(item_dir.join(ITEM_NAME)).expect("replace with symlink");
        symlink(&outside_file, item_dir.join(ITEM_NAME)).expect("item symlink");

        assert!(list(root).entries.is_empty());
        let report = cleanup_by_ids(&WriteGate::new(None), root, &[item_id]).expect("report");
        assert_eq!(report.errors[0].code, "E_PATH_ESCAPE");
        assert_eq!(fs::read(outside_file).expect("outside"), b"safe");
    }

    #[test]
    fn cleanup_rejects_empty_ids_without_touching_disk() {
        let dir = tempdir().expect("root");
        let error =
            cleanup_by_ids(&WriteGate::new(None), dir.path(), &[]).expect_err("空 ids 必须拒绝");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert!(!trash_dir(dir.path()).exists());
    }

    #[test]
    fn cleanup_deletes_only_requested_valid_ids_and_continues_after_failures() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = WriteGate::new(None);
        let first = Ulid::generate().to_string();
        let second = Ulid::generate().to_string();
        let meta_only = Ulid::generate().to_string();
        let unrequested = Ulid::generate().to_string();
        let first_dir = make_inventory_entry(
            root,
            &first,
            "workbench",
            Some("notes/source.md"),
            None,
            b"first",
        );
        let second_dir = make_inventory_entry(
            root,
            &second,
            "workbench",
            Some("notes/second.md"),
            None,
            b"second",
        );
        let meta_only_dir = make_inventory_entry(
            root,
            &meta_only,
            "workbench",
            Some("notes/meta-only.md"),
            None,
            b"x",
        );
        fs::remove_file(meta_only_dir.join(ITEM_NAME)).expect("meta only");
        let unrequested_dir = make_inventory_entry(
            root,
            &unrequested,
            "workbench",
            Some("notes/unrequested.md"),
            None,
            b"keep",
        );
        let decoy = seed(root, "notes/source.md", b"not a deletion target");

        let report = cleanup_by_ids(
            &gate,
            root,
            &[
                "bad id".to_string(),
                first.clone(),
                meta_only.clone(),
                second.clone(),
            ],
        )
        .expect("partial report");

        assert_eq!(report.removed_ids, vec![first, second]);
        assert_eq!(report.errors.len(), 2);
        assert_eq!(report.errors[0].id, "bad id");
        assert_eq!(report.errors[0].code, "E_INVALID_ARG");
        assert_eq!(report.errors[1].id, meta_only);
        assert_eq!(report.errors[1].code, "E_NOT_FOUND");
        assert!(!first_dir.exists());
        assert!(!second_dir.exists());
        assert!(meta_only_dir.exists(), "无效 item 不得被清理");
        assert!(unrequested_dir.exists(), "请求范围外目录不得删除");
        assert_eq!(
            fs::read(decoy).expect("decoy"),
            b"not a deletion target",
            "metadata.path 绝不得成为删除目标"
        );
        assert_eq!(gate.take_max_in_flight(), 1, "批次必须持有单写许可");
        assert!(gate.readonly_reason().is_none(), "逐项失败不得闩锁全库");
    }

    #[test]
    fn cleanup_never_lists_or_deletes_system_trash_records() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let system_id = Ulid::generate().to_string();
        let system_dir = make_inventory_entry(
            root,
            &system_id,
            "system",
            Some("notes/system.md"),
            None,
            b"system content",
        );

        assert!(list(root).entries.is_empty());
        let report = cleanup_by_ids(&WriteGate::new(None), root, &[system_id]).expect("report");
        assert!(report.removed_ids.is_empty());
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].code, "E_INVALID_ARG");
        assert_eq!(
            fs::read(system_dir.join(ITEM_NAME)).expect("system item"),
            b"system content"
        );
    }

    #[test]
    fn sweep_skips_readonly_without_touching_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let old = make_trash_dir(root, "OLD", 30);
        let gate = WriteGate::new(Some(ReadonlyReason::LockedByOther));

        let report = sweep(&gate, root, TRASH_RETENTION_DAYS, SystemTime::now());

        assert_eq!(report.skipped, Some(SweepSkip::Readonly));
        assert!(report.removed.is_empty());
        assert!(old.exists());
    }

    #[test]
    fn sweep_skips_when_write_queue_is_busy() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let old = make_trash_dir(root, "OLD", 30);
        let gate = WriteGate::new(None);
        let permit = gate.enter().expect("permit");

        let report = sweep(&gate, root, TRASH_RETENTION_DAYS, SystemTime::now());
        drop(permit);

        assert_eq!(report.skipped, Some(SweepSkip::Busy));
        assert!(old.exists());
    }

    #[test]
    fn sweep_continues_after_a_single_failure() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("root");
        let root = dir.path();
        let locked = make_trash_dir(root, "LOCKED", 30);
        let removable = make_trash_dir(root, "OLD", 30);
        let fresh = make_trash_dir(root, "NEW", 1);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).expect("chmod");

        let report = sweep(
            &WriteGate::new(None),
            root,
            TRASH_RETENTION_DAYS,
            SystemTime::now(),
        );
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).expect("restore");

        assert_eq!(report.scanned, 3);
        assert!(report.removed.contains(&"OLD".to_string()));
        assert!(
            report.errors.iter().any(|error| error.id == "LOCKED"),
            "单条失败必须进 errors"
        );
        assert!(locked.exists(), "删除失败的目录必须保留");
        assert!(!removable.exists());
        assert!(fresh.exists(), "未过期目录必须保留");
    }
}
