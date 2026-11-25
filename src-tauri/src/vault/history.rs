//! history 后端（CR-20261119-21）：文档版本快照与配额。
//!
//! 存储：`.workbench/history/documents/<docId>/<ulid>.md`，无 sidecar——
//! `version` = 文件名去 `.md`，`createdAt` 由 ULID 时间戳解码，`bytes` 取 stat，
//! `sha256` 仅在 `history_read` 时计算。`docId` / `version` 一律 ULID
//! （`Ulid::from_string` 一票否决；复核修订）。
//!
//! 快照纪律（复核修订）：
//! - `vault_write` 覆盖前把旧内容快照（best-effort：失败记日志、不闩锁、不阻塞主写入）；
//! - 距最新快照（ULID 时间戳）不足 `SNAPSHOT_MIN_INTERVAL_SECS` 秒则跳过常规快照；
//! - `history_restore` 的强制快照不受合并限制。
//! - 快照写失败不得点亮全库只读闩锁（与 `doc::write` 的 `map_write_error` 相反）：
//!   历史是辅助数据，为它闩锁会让用户保存失败，得不偿失。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use ulid::Ulid;

use crate::ipc::history::{HistoryDeleteDto, HistoryPurgeDto, HistoryReadDto, HistoryVersionDto};
use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::constants::{HISTORY_BUDGET_BYTES, HISTORY_KEEP};
use crate::vault::doc;
use crate::vault::gate::{self, WriteGate, WritePermit};

/// 快照最小间隔（复核修订）：距最新快照不足 300 秒则跳过常规快照。
pub(crate) const SNAPSHOT_MIN_INTERVAL_SECS: u64 = 300;

// ─── 路径与校验 ──────────────────────────────────────────────────────────────

fn history_dir(root: &Path) -> PathBuf {
    root.join(".workbench/history/documents")
}

fn doc_dir(root: &Path, doc_id: &str) -> PathBuf {
    history_dir(root).join(doc_id)
}

/// docId 一票否决：非 ULID（含空 / `/` / `\` / `:` / `..` / 保留名形态 / 非 26 位）全拒。
fn validate_doc_id(doc_id: &str) -> VaultResult<Ulid> {
    Ulid::from_string(doc_id)
        .map_err(|_| VaultError::InvalidArg(format!("docId 必须是 26 位合法 ULID：{doc_id}")))
}

fn validate_version(version: &str) -> VaultResult<Ulid> {
    Ulid::from_string(version)
        .map_err(|_| VaultError::InvalidArg(format!("version 必须是 26 位合法 ULID：{version}")))
}

fn ulid_ms(ulid: &Ulid) -> u64 {
    ulid.datetime()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

// ─── docId 提取（零依赖）────────────────────────────────────────────────────

/// 从文档原文提取 frontmatter `id`；仅当其为合法 ULID 时返回 Some（复核修订）。
/// 定位开头 `---\n…\n---` 块，块内首个行首 `id:` 取值、去 YAML 引号；
/// id 缺失 / 非 ULID → None（该文档不产生历史，可接受降级）。
pub(crate) fn extract_doc_id(text: &str) -> Option<String> {
    let (interior, _) = split_frontmatter(text)?;
    for line in interior.lines() {
        if let Some(value) = line.strip_prefix("id:") {
            let cleaned = strip_yaml_quotes(value.trim());
            return if Ulid::from_string(cleaned).is_ok() {
                Some(cleaned.to_string())
            } else {
                None
            };
        }
    }
    None
}

/// 返回 (frontmatter 内部文本, 去块后的正文)；无合法开头块 → None。
fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    let interior_start = match text.strip_prefix("---\r\n") {
        Some(rest) => rest,
        None => text.strip_prefix("---\n")?,
    };
    let mut offset = 0;
    for line in interior_start.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\n', '\r']);
        offset += line.len();
        if trimmed == "---" {
            return Some((
                &interior_start[..offset - line.len()],
                &interior_start[offset..],
            ));
        }
    }
    None
}

fn strip_yaml_quotes(value: &str) -> &str {
    if let Some(inner) = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
        return inner;
    }
    if let Some(inner) = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')) {
        return inner;
    }
    value
}

// ─── 版本清单 ────────────────────────────────────────────────────────────────

struct VersionEntry {
    ulid: Ulid,
    bytes: u64,
}

/// 列 `<docId>/` 下可解析 ULID 的 `.md`（stray 文件忽略），按 ULID 升序（= 时间升序）。
/// 目录不存在 → 空表。
fn read_versions(dir: &Path) -> Vec<VersionEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<VersionEntry> = entries
        .flatten()
        .filter(|entry| entry.path().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".md")?;
            let ulid = Ulid::from_string(stem).ok()?;
            let bytes = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            Some(VersionEntry { ulid, bytes })
        })
        .collect();
    out.sort_by_key(|entry| entry.ulid);
    out
}

fn latest_snapshot_ms(root: &Path, doc_id: &str) -> Option<u64> {
    read_versions(&doc_dir(root, doc_id))
        .last()
        .map(|entry| ulid_ms(&entry.ulid))
}

// ─── 快照 ────────────────────────────────────────────────────────────────────

/// 常规快照（`vault_write` 覆盖前调用）：5 分钟内已有快照则跳过（合并）。
pub(crate) fn snapshot(gate: &WriteGate, root: &Path, doc_id: &str, text: &str) -> VaultResult<()> {
    snapshot_at(gate, root, doc_id, text, now_ms())
}

/// 批量事务使用的快照入口；调用者持有覆盖整个批次的 permit。
pub(crate) fn snapshot_with_permit(
    root: &Path,
    doc_id: &str,
    text: &str,
    permit: &WritePermit<'_>,
) -> VaultResult<()> {
    validate_doc_id(doc_id)?;
    if let Some(latest) = latest_snapshot_ms(root, doc_id) {
        if now_ms().saturating_sub(latest) < SNAPSHOT_MIN_INTERVAL_SECS * 1000 {
            return Ok(());
        }
    }
    write_snapshot_with_permit(root, doc_id, text, permit)
}

/// 注入时钟的核心实现；测试用小间隔验证合并（T14）。
pub(crate) fn snapshot_at(
    gate: &WriteGate,
    root: &Path,
    doc_id: &str,
    text: &str,
    now: u64,
) -> VaultResult<()> {
    validate_doc_id(doc_id)?;
    if let Some(latest) = latest_snapshot_ms(root, doc_id) {
        if now.saturating_sub(latest) < SNAPSHOT_MIN_INTERVAL_SECS * 1000 {
            return Ok(());
        }
    }
    write_snapshot(gate, root, doc_id, text)
}

/// 强制快照（`history_restore` 前调用）：不受 5 分钟合并限制（复核修订）。
pub(crate) fn snapshot_forced(
    gate: &WriteGate,
    root: &Path,
    doc_id: &str,
    text: &str,
) -> VaultResult<()> {
    validate_doc_id(doc_id)?;
    write_snapshot(gate, root, doc_id, text)
}

/// 持写闸门原子写快照，随后做本篇配额淘汰。
/// 错误映射刻意**不走** `gate::map_write_error`：快照失败不得闩锁全库（best-effort）。
fn write_snapshot(gate: &WriteGate, root: &Path, doc_id: &str, text: &str) -> VaultResult<()> {
    let permit = gate.enter()?;
    write_snapshot_with_permit(root, doc_id, text, &permit)
}

fn write_snapshot_with_permit(
    root: &Path,
    doc_id: &str,
    text: &str,
    _permit: &WritePermit<'_>,
) -> VaultResult<()> {
    let dir = doc_dir(root, doc_id);
    fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{}.md", Ulid::generate()));
    atomic::write_atomic(&target, text.as_bytes())?;
    enforce_quota(root, doc_id, HISTORY_KEEP, HISTORY_BUDGET_BYTES)?;
    Ok(())
}

// ─── 配额淘汰（每篇独立）────────────────────────────────────────────────────

/// 从最旧淘汰，直到 `count <= keep` 且 `total <= budget`；至少保留最新 1 个。
/// stray（非 ULID 命名）不计数、不淘汰；删除失败记日志继续，不回滚已淘汰项。
pub(crate) fn enforce_quota(root: &Path, doc_id: &str, keep: u32, budget: u64) -> VaultResult<()> {
    let dir = doc_dir(root, doc_id);
    let versions = read_versions(&dir);
    let mut count = versions.len() as u32;
    let mut total: u64 = versions.iter().map(|entry| entry.bytes).sum();
    for entry in &versions {
        if (count <= keep && total <= budget) || count <= 1 {
            break;
        }
        let path = dir.join(format!("{}.md", entry.ulid));
        if let Err(error) = fs::remove_file(&path) {
            eprintln!(
                "[history] 配额淘汰失败（继续）：{}：{error}",
                path.display()
            );
            continue;
        }
        count -= 1;
        total -= entry.bytes;
    }
    Ok(())
}

// ─── list / read / delete / purge ────────────────────────────────────────────

/// 版本元数据列表（时间升序）；空目录 → `[]`（非错误）。只读，不持闸门。
pub(crate) fn list(root: &Path, doc_id: &str) -> VaultResult<Vec<HistoryVersionDto>> {
    validate_doc_id(doc_id)?;
    Ok(read_versions(&doc_dir(root, doc_id))
        .into_iter()
        .map(|entry| HistoryVersionDto {
            version: entry.ulid.to_string(),
            created_at: iso8601_from_ms(ulid_ms(&entry.ulid)),
            bytes: entry.bytes,
        })
        .collect())
}

/// 读版本全文并计算 sha256（list 不预哈希）。只读，不持闸门。
pub(crate) fn read(root: &Path, doc_id: &str, version: &str) -> VaultResult<HistoryReadDto> {
    validate_doc_id(doc_id)?;
    let ulid = validate_version(version)?;
    let path = doc_dir(root, doc_id).join(format!("{ulid}.md"));
    let bytes = fs::read(&path).map_err(doc::not_found_or)?;
    let text = String::from_utf8(bytes).map_err(|_| {
        VaultError::InvalidArg(format!("历史版本内容不是合法 UTF-8：{doc_id}/{ulid}"))
    })?;
    Ok(HistoryReadDto {
        doc_id: doc_id.to_string(),
        version: ulid.to_string(),
        sha256: atomic::hex_sha256(text.as_bytes()),
        bytes: text.len() as u64,
        created_at: iso8601_from_ms(ulid_ms(&ulid)),
        text,
    })
}

/// 删除单个版本；不存在 → `E_NOT_FOUND`。持写闸门。
pub(crate) fn delete(
    gate: &WriteGate,
    root: &Path,
    doc_id: &str,
    version: &str,
) -> VaultResult<HistoryDeleteDto> {
    validate_doc_id(doc_id)?;
    let ulid = validate_version(version)?;
    let _permit = gate.enter()?;
    let path = doc_dir(root, doc_id).join(format!("{ulid}.md"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(HistoryDeleteDto { deleted: true }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Err(VaultError::NotFound),
        Err(error) => Err(gate::map_write_error(gate, error)),
    }
}

/// 清空 `<docId>/` 整个目录；无目录 → `{ deleted: 0 }`（非错误）。持写闸门。
pub(crate) fn purge(gate: &WriteGate, root: &Path, doc_id: &str) -> VaultResult<HistoryPurgeDto> {
    validate_doc_id(doc_id)?;
    let dir = doc_dir(root, doc_id);
    if !dir.is_dir() {
        return Ok(HistoryPurgeDto { deleted: 0 });
    }
    let _permit = gate.enter()?;
    let deleted = count_files(&dir);
    fs::remove_dir_all(&dir).map_err(|error| gate::map_write_error(gate, error))?;
    Ok(HistoryPurgeDto { deleted })
}

fn count_files(dir: &Path) -> u32 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            if entry.path().is_dir() {
                count_files(&entry.path())
            } else {
                1
            }
        })
        .sum()
}

// ─── 恢复 ────────────────────────────────────────────────────────────────────

/// 恢复：path↔docId 一致性 → 读版本 → 强制快照当前 → `doc::write` 带条件 SHA。
/// `expected_sha` 必填（收口后修补）：无条件覆盖不是恢复的合法语义。
/// 冲突（expectedSha 不符）→ `E_INVALID_ARG`，当前文件不动（复用 `vault_write` 口径）。
pub(crate) fn restore(
    gate: &WriteGate,
    root: &Path,
    path: &str,
    doc_id: &str,
    version: &str,
    expected_sha: &str,
) -> VaultResult<doc::WriteDoc> {
    validate_doc_id(doc_id)?;
    let version_ulid = validate_version(version)?;
    if !path.to_ascii_lowercase().ends_with(".md") {
        return Err(VaultError::InvalidArg(format!(
            "vault 只接受 .md 文档：{path}"
        )));
    }
    if gate.readonly_reason().is_some() {
        return Err(VaultError::Readonly);
    }
    // path↔docId 一致性（T13，复核修订）：防止把 A 的版本写进 B 的文档。
    let current = doc::read(root, path)?;
    let current_id = extract_doc_id(&current.text).ok_or_else(|| {
        VaultError::InvalidArg(format!("目标文档 frontmatter id 缺失或非 ULID：{path}"))
    })?;
    if current_id != doc_id {
        return Err(VaultError::InvalidArg(format!(
            "path↔docId 不一致：{path} 的 id 是 {current_id}，请求恢复 {doc_id} 的版本"
        )));
    }
    let version_path = doc_dir(root, doc_id).join(format!("{version_ulid}.md"));
    let version_bytes = fs::read(&version_path).map_err(doc::not_found_or)?;
    let version_text = String::from_utf8(version_bytes).map_err(|_| {
        VaultError::InvalidArg(format!(
            "历史版本内容不是合法 UTF-8：{doc_id}/{version_ulid}"
        ))
    })?;
    // 强制快照当前内容（保证恢复可撤销，不受 5 分钟合并限制）；失败中止恢复，当前文件不动。
    snapshot_forced(gate, root, doc_id, &current.text)?;
    // expectedSha 必填（收口后修补）：漏传会导致无条件覆盖，编译期即挡住。
    doc::write(gate, root, path, &version_text, Some(expected_sha))
}

// ─── ISO 8601（ULID 时间戳 → UTC 串；identity.rs 同款算法的毫秒版）───────────

fn iso8601_from_ms(ms: u64) -> String {
    let seconds = ms / 1000;
    let millis = ms % 1000;
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

/// Howard Hinnant 的 civil_from_days：1970-01-01 起的天数 → 公历年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tempfile::tempdir;

    use super::*;

    /// 合法 26 位 Crockford ULID（与 doc.rs 测试同源常量）。
    const DOC_ID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    fn gate() -> WriteGate {
        WriteGate::new(None)
    }

    fn test_now_ms() -> u64 {
        now_ms()
    }

    fn seed_doc(root: &Path, rel: &str, doc_id: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().expect("parent")).expect("seed parent");
        fs::write(path, format!("---\nid: {doc_id}\n---\n\n{text}\n")).expect("seed doc");
    }

    fn ulid_at(ms: u64) -> Ulid {
        Ulid::from_datetime(UNIX_EPOCH + Duration::from_millis(ms))
    }

    fn snapshot_names(root: &Path, doc_id: &str) -> Vec<String> {
        read_versions(&doc_dir(root, doc_id))
            .into_iter()
            .map(|entry| entry.ulid.to_string())
            .collect()
    }

    // ── T1：配额数量淘汰 ────────────────────────────────────────────────────

    #[test]
    fn quota_evicts_oldest_beyond_keep() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let docs = doc_dir(root, DOC_ID);
        fs::create_dir_all(&docs).expect("docs dir");
        // from_datetime 的随机位每次调用都不同：写与断言必须共用同一批 ULID 实例。
        let ulids: Vec<Ulid> = (0..25u64).map(|index| ulid_at(index * 1_000)).collect();
        for (index, ulid) in ulids.iter().enumerate() {
            fs::write(docs.join(format!("{ulid}.md")), format!("v{index}")).expect("snapshot");
        }
        enforce_quota(root, DOC_ID, 20, u64::MAX).expect("quota");
        let remaining = snapshot_names(root, DOC_ID);
        assert_eq!(remaining.len(), 20, "只保留最新 20 个");
        for (index, ulid) in ulids.iter().enumerate() {
            let exists = docs.join(format!("{ulid}.md")).exists();
            if index < 5 {
                assert!(!exists, "最旧 v{index} 应被淘汰");
            } else {
                assert!(exists, "v{index} 应保留");
            }
        }
    }

    // ── T2：配额字节淘汰 ────────────────────────────────────────────────────

    #[test]
    fn quota_evicts_oldest_beyond_budget() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let docs = doc_dir(root, DOC_ID);
        fs::create_dir_all(&docs).expect("docs dir");
        let ulids: Vec<Ulid> = (0..8u64).map(|index| ulid_at(index * 1_000)).collect();
        for ulid in &ulids {
            fs::write(docs.join(format!("{ulid}.md")), "x".repeat(1_000)).expect("snapshot");
        }
        // keep 放开、只按字节：8×1000 = 8000 → 淘汰到 ≤ 5000（删 3 个最旧）
        enforce_quota(root, DOC_ID, u32::MAX, 5_000).expect("quota");
        let remaining = snapshot_names(root, DOC_ID);
        assert_eq!(remaining.len(), 5, "字节预算淘汰到 5000/1000 = 5 个");
        let total: u64 = remaining
            .iter()
            .map(|name| {
                fs::metadata(docs.join(format!("{name}.md")))
                    .expect("meta")
                    .len()
            })
            .sum();
        assert!(total <= 5_000, "总字节不得超过预算：{total}");
        let newest = ulids[7].to_string();
        assert!(remaining.contains(&newest), "最新版本必须保留");
        assert!(
            docs.join(format!("{newest}.md")).exists(),
            "最新版本必须保留"
        );
    }

    // ── T3：恢复主路径 ──────────────────────────────────────────────────────

    #[test]
    fn restore_reverts_content_and_snapshots_current() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        seed_doc(root, "a.md", DOC_ID, "v1 当前内容");
        let old = "v0 原始内容";
        snapshot_forced(&gate, root, DOC_ID, old).expect("seed history");
        let version = snapshot_names(root, DOC_ID)[0].clone();

        let expected = doc::read(root, "a.md").expect("read").sha256;
        let restored = restore(&gate, root, "a.md", DOC_ID, &version, &expected).expect("restore");

        assert_eq!(doc::read(root, "a.md").expect("read").text, old);
        assert_eq!(restored.sha256, atomic::hex_sha256(old.as_bytes()));
        assert_eq!(restored.path, "a.md");
        assert_eq!(
            snapshot_names(root, DOC_ID).len(),
            2,
            "恢复前的当前内容必须已入史"
        );
        let listed = list(root, DOC_ID).expect("list");
        assert_eq!(listed.len(), 2);
    }

    // ── T4：冲突检测 ────────────────────────────────────────────────────────

    #[test]
    fn restore_rejects_stale_expected_sha_and_keeps_current() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        seed_doc(root, "a.md", DOC_ID, "v1 当前内容");
        snapshot_forced(&gate, root, DOC_ID, "v0 原始内容").expect("seed history");
        let version = snapshot_names(root, DOC_ID)[0].clone();

        let stale = restore(&gate, root, "a.md", DOC_ID, &version, &"ab".repeat(32))
            .expect_err("SHA 不符必须拒绝");
        assert_eq!(stale.code(), "E_INVALID_ARG");
        assert!(
            doc::read(root, "a.md")
                .expect("read")
                .text
                .contains("v1 当前内容"),
            "当前文件必须未被改动"
        );
        // 强制快照发生在冲突检测之前（设计如此：恢复前的当前内容入史），冲突后保留。
        assert_eq!(snapshot_names(root, DOC_ID).len(), 2, "强制快照已入史");
    }

    // ── T5：路径校验复用 ────────────────────────────────────────────────────

    #[test]
    fn restore_rejects_non_markdown_escape_and_readonly() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed_doc(root, "a.md", DOC_ID, "v1");
        snapshot_forced(&gate(), root, DOC_ID, "v0").expect("seed history");
        let version = snapshot_names(root, DOC_ID)[0].clone();

        // 三处都在 expectedSha 复核之前被拒（.md 检查 / 路径解析 / 只读闸门）。
        let wrong_sha = &"ab".repeat(32);
        let non_md = restore(&gate(), root, "a.txt", DOC_ID, &version, wrong_sha)
            .expect_err("非 .md 必须拒绝");
        assert_eq!(non_md.code(), "E_INVALID_ARG");

        let escape = restore(&gate(), root, "../evil.md", DOC_ID, &version, wrong_sha)
            .expect_err("越界必须拒绝");
        assert_eq!(escape.code(), "E_PATH_ESCAPE");

        let readonly_gate = WriteGate::new(Some(crate::ipc::ReadonlyReason::LockedByOther));
        let readonly = restore(&readonly_gate, root, "a.md", DOC_ID, &version, wrong_sha)
            .expect_err("只读必须拒绝");
        assert_eq!(readonly.code(), "E_READONLY");
    }

    // ── T6：删除 ────────────────────────────────────────────────────────────

    #[test]
    fn delete_removes_version_and_reports_missing() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        snapshot_forced(&gate, root, DOC_ID, "v0").expect("seed history");
        snapshot_forced(&gate, root, DOC_ID, "v1").expect("seed history");
        let names = snapshot_names(root, DOC_ID);
        assert_eq!(names.len(), 2);

        let removed = delete(&gate, root, DOC_ID, &names[0]).expect("delete");
        assert!(removed.deleted);
        let after = list(root, DOC_ID).expect("list");
        assert_eq!(after.len(), 1);
        assert_ne!(after[0].version, names[0]);

        let missing = delete(&gate, root, DOC_ID, &names[0]).expect_err("已删不得重复删");
        assert_eq!(missing.code(), "E_NOT_FOUND");
    }

    // ── T7：purge ───────────────────────────────────────────────────────────

    #[test]
    fn purge_clears_directory_and_tolerates_missing() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        snapshot_forced(&gate, root, DOC_ID, "v0").expect("seed history");
        snapshot_forced(&gate, root, DOC_ID, "v1").expect("seed history");

        let purged = purge(&gate, root, DOC_ID).expect("purge");
        assert_eq!(purged.deleted, 2);
        assert!(!doc_dir(root, DOC_ID).exists(), "目录应被清空移除");

        let again = purge(&gate, root, DOC_ID).expect("再次 purge");
        assert_eq!(again.deleted, 0, "无目录是 0 而非错误");
    }

    // ── T8：docId 一票否决 ──────────────────────────────────────────────────

    #[test]
    fn invalid_doc_ids_rejected_before_disk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        let bad_ids = [
            "",
            "with/slash",
            "with\\backslash",
            "with:colon",
            "..",
            ".",
            "01ARZ3NDEKTSV4RRFFQ69G5FA",   // 25 位
            "01ARZ3NDEKTSV4RRFFQ69G5FAVX", // 27 位
            "!!!!!!!!!!!!!!!!!!!!!!!!!!",  // 非法字符
        ];
        for doc_id in bad_ids {
            assert_eq!(
                list(root, doc_id).expect_err("list").code(),
                "E_INVALID_ARG",
                "docId={doc_id:?}"
            );
            assert_eq!(
                read(root, doc_id, DOC_ID).expect_err("read").code(),
                "E_INVALID_ARG",
                "docId={doc_id:?}"
            );
            assert_eq!(
                delete(&gate, root, doc_id, DOC_ID)
                    .expect_err("delete")
                    .code(),
                "E_INVALID_ARG",
                "docId={doc_id:?}"
            );
            assert_eq!(
                purge(&gate, root, doc_id).expect_err("purge").code(),
                "E_INVALID_ARG",
                "docId={doc_id:?}"
            );
        }
        assert!(
            !root.join(".workbench").exists(),
            "非法 docId 不得创建任何目录"
        );
    }

    // ── T9：extract_doc_id 降级 ─────────────────────────────────────────────

    #[test]
    fn extract_doc_id_only_accepts_valid_ulids() {
        assert_eq!(
            extract_doc_id("---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n---\n正文").as_deref(),
            Some(DOC_ID)
        );
        assert_eq!(
            extract_doc_id("---\nid: \"01ARZ3NDEKTSV4RRFFQ69G5FAV\"\n---\n正文").as_deref(),
            Some(DOC_ID)
        );
        assert_eq!(
            extract_doc_id("---\nid: '01ARZ3NDEKTSV4RRFFQ69G5FAV'\n---\n正文").as_deref(),
            Some(DOC_ID)
        );
        assert!(extract_doc_id("无 frontmatter").is_none());
        assert!(extract_doc_id("---\ntitle: 无 id 行\n---\n正文").is_none());
        assert!(
            extract_doc_id("---\nid: my-doc\n---\n正文").is_none(),
            "非 ULID id 必须被拒"
        );
        assert!(
            extract_doc_id("---\nid: 123\n---\n正文").is_none(),
            "非 26 位 id 必须被拒"
        );
        assert!(
            extract_doc_id("---\nid: 01ARZ3NDEKTSV4RRFFQ69G5FA:bad\n---\n正文").is_none(),
            "含冒号的 id 必须被拒"
        );
    }

    // ── T10：stray 文件防御 ─────────────────────────────────────────────────

    #[test]
    fn stray_files_are_ignored_by_list_and_quota() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let docs = doc_dir(root, DOC_ID);
        fs::create_dir_all(&docs).expect("docs dir");
        let oldest = ulid_at(0);
        let newest = ulid_at(60_000);
        fs::write(docs.join("stray.md"), "stray").expect("stray");
        fs::write(docs.join("01ABC.md"), "short ulid").expect("invalid name");
        fs::write(docs.join(format!("{oldest}.md")), "oldest").expect("oldest");
        fs::write(docs.join(format!("{newest}.md")), "newest").expect("newest");

        let listed = list(root, DOC_ID).expect("list");
        assert_eq!(listed.len(), 2, "stray 不进列表");

        enforce_quota(root, DOC_ID, 1, 1).expect("quota");
        assert!(docs.join("stray.md").exists(), "stray 不得被配额误删");
        assert!(docs.join("01ABC.md").exists(), "非法命名不得被配额误删");
        assert!(
            docs.join(format!("{newest}.md")).exists(),
            "最新版本必须保留"
        );
        assert!(
            !docs.join(format!("{oldest}.md")).exists(),
            "最旧合法版本被淘汰"
        );
    }

    // ── T11：快照失败不阻塞主写入 ───────────────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn snapshot_failure_does_not_block_main_write() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        seed_doc(root, "a.md", DOC_ID, "v1");
        // 占住 history 目录：让快照写入必然失败
        let history_root = root.join(".workbench/history");
        fs::create_dir_all(&history_root).expect("history dir");
        fs::set_permissions(&history_root, fs::Permissions::from_mode(0o000)).expect("chmod 000");

        let snapshot_result = snapshot(&gate, root, DOC_ID, "v1 旧内容");
        fs::set_permissions(&history_root, fs::Permissions::from_mode(0o755))
            .expect("restore perm");

        assert!(snapshot_result.is_err(), "快照应当失败");
        assert!(gate.readonly_reason().is_none(), "快照失败不得闩锁全库只读");
        // 主写入照常成功（快照失败被记录日志但不阻塞）
        doc::write(&gate, root, "a.md", "v2", None).expect("主写入必须成功");
        assert_eq!(doc::read(root, "a.md").expect("read").text, "v2");
    }

    // ── T12：原子写纪律 ─────────────────────────────────────────────────────

    #[test]
    fn snapshot_leaves_no_temp_residue() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        snapshot_forced(&gate, root, DOC_ID, "内容").expect("snapshot");
        let docs = doc_dir(root, DOC_ID);
        let entries: Vec<String> = fs::read_dir(&docs)
            .expect("read dir")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(entries.len(), 1, "只有快照本体");
        assert!(entries[0].ends_with(".md"));
        assert!(!entries[0].contains(".tmp-"), "不得残留临时文件");
    }

    // ── T13：path↔docId 一致性（复核修订）───────────────────────────────────

    #[test]
    fn restore_enforces_path_doc_id_consistency() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        const OTHER_ID: &str = "01BBBZNDEKTSV4RRFFQ69G5FAV";
        seed_doc(root, "a.md", DOC_ID, "A 的当前内容");
        seed_doc(root, "b.md", OTHER_ID, "B 的当前内容");
        // B 的历史版本
        snapshot_forced(&gate, root, OTHER_ID, "B 的历史版本").expect("seed history");
        let b_version = snapshot_names(root, OTHER_ID)[0].clone();
        let expected = doc::read(root, "a.md").expect("read").sha256;

        let mismatch = restore(&gate, root, "a.md", OTHER_ID, &b_version, &expected)
            .expect_err("把 B 的版本写进 A 必须拒绝");
        assert_eq!(mismatch.code(), "E_INVALID_ARG");
        assert!(
            doc::read(root, "a.md")
                .expect("read")
                .text
                .contains("A 的当前内容"),
            "A 文件必须未被改动"
        );

        // 目标缺 id：恢复请求仍被拒
        fs::write(root.join("no-id.md"), "没有 frontmatter 的文档\n").expect("seed");
        let missing_id = restore(&gate, root, "no-id.md", DOC_ID, &b_version, &expected)
            .expect_err("缺 id 必须拒绝");
        assert_eq!(missing_id.code(), "E_INVALID_ARG");

        // 目标文件不存在 → E_NOT_FOUND
        let missing_target = restore(&gate, root, "missing.md", DOC_ID, &b_version, &expected)
            .expect_err("缺失目标");
        assert_eq!(missing_target.code(), "E_NOT_FOUND");

        // 匹配时正常恢复（T3 已覆盖主路径，这里补一致性的正向例）
        snapshot_forced(&gate, root, DOC_ID, "A 的历史版本").expect("seed A history");
        let a_version = snapshot_names(root, DOC_ID)[0].clone();
        restore(&gate, root, "a.md", DOC_ID, &a_version, &expected).expect("一致即恢复");
        assert_eq!(doc::read(root, "a.md").expect("read").text, "A 的历史版本");
    }

    // ── T14：5 分钟合并 + restore 强制快照（复核修订）───────────────────────

    #[test]
    fn snapshot_merges_within_interval_and_restore_forces() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        seed_doc(root, "a.md", DOC_ID, "v1 当前内容");
        let t0 = test_now_ms();

        snapshot_at(&gate, root, DOC_ID, "s1", t0).expect("s1");
        assert_eq!(snapshot_names(root, DOC_ID).len(), 1);
        snapshot_at(&gate, root, DOC_ID, "s2", t0 + 60_000).expect("s2 被合并跳过");
        assert_eq!(
            snapshot_names(root, DOC_ID).len(),
            1,
            "60 秒内的快照必须合并"
        );
        snapshot_at(&gate, root, DOC_ID, "s3", t0 + 301_000).expect("s3 落盘");
        assert_eq!(
            snapshot_names(root, DOC_ID).len(),
            2,
            "超过 300 秒的快照必须落盘"
        );

        // restore 的强制快照不受合并限制：距 s1/s3 不足 5 分钟也要入史
        let expected = doc::read(root, "a.md").expect("read").sha256;
        let version = snapshot_names(root, DOC_ID)[0].clone();
        restore(&gate, root, "a.md", DOC_ID, &version, &expected).expect("restore");
        assert_eq!(
            snapshot_names(root, DOC_ID).len(),
            3,
            "恢复前的强制快照不受 5 分钟限制"
        );
    }

    // ── 附加：list/read 的 createdAt 为 ISO 8601 且 bytes 同源 ──────────────

    #[test]
    fn list_and_read_metadata_agree() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let gate = gate();
        snapshot_forced(&gate, root, DOC_ID, "内容").expect("snapshot");
        let listed = list(root, DOC_ID).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].bytes, "内容".len() as u64);
        assert!(
            listed[0].created_at.ends_with('Z') && listed[0].created_at.contains('T'),
            "createdAt 必须是 ISO 8601 UTC：{}",
            listed[0].created_at
        );
        let read = crate::vault::history::read(root, DOC_ID, &listed[0].version).expect("read");
        assert_eq!(read.text, "内容");
        assert_eq!(read.sha256, atomic::hex_sha256("内容".as_bytes()));
        assert_eq!(read.created_at, listed[0].created_at);
    }
}
