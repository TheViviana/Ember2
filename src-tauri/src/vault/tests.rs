//! 跨模块集成测试：旧库副本走读 / 写 / 扫描全链路，以及只读会话的可观察性。

use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime};

use tempfile::tempdir;

use super::gate::WriteGate;
use super::{atomic, backup, doc, identity_dto, scan, test_state, trash};
use crate::ipc::{ReadonlyReason, VaultError};
use crate::vault::constants::TRASH_RETENTION_DAYS;

fn seed(root: &Path, rel: &str, bytes: &[u8]) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("parent");
    }
    fs::write(path, bytes).expect("seed");
}

fn legacy_vault() -> tempfile::TempDir {
    let dir = tempdir().expect("root");
    let root = dir.path();
    seed(
        root,
        ".workbench/settings.json",
        r#"{"schemaVersion":1,"vault":{"id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","name":"旧库"}}"#
            .as_bytes(),
    );
    seed(
        root,
        ".workbench/canvas/01H8XYZABCDEF.canvas.json",
        br#"{"nodes":[]}"#,
    );
    seed(root, "a.md", "# A\n".as_bytes());
    seed(root, "notes/b.md", "# B\n".as_bytes());
    seed(root, "media/ab/cat.png", &[0x89, 0x50, 0x4e, 0x47]);
    dir
}

#[test]
fn legacy_vault_pipeline_read_write_scan_and_latch() {
    let dir = legacy_vault();
    let root = dir.path();
    let gate = WriteGate::new(None);

    // 旧库原文件可读，read 与 stat 的 hash 同源
    let read = doc::read(root, "a.md").expect("读旧库");
    assert_eq!(read.text, "# A\n");
    assert_eq!(doc::stat(root, "a.md").expect("stat").sha256, read.sha256);

    // 写入后 scan 能看到新旧文档，hash 与写入回执一致
    let written = doc::write(&gate, root, "notes/new.md", "# 新\n", None).expect("写");
    let docs = scan::scan(root).expect("scan");
    let paths: Vec<&str> = docs.iter().map(|doc| doc.path.as_str()).collect();
    assert_eq!(paths, vec!["a.md", "notes/b.md", "notes/new.md"]);
    for path in &paths {
        assert!(!path.contains('\\'), "scan 路径必须是正斜杠：{path}");
    }
    let new = docs
        .iter()
        .find(|doc| doc.path == "notes/new.md")
        .expect("新文档");
    assert_eq!(new.sha256, written.sha256);

    // list 的路径同样强制正斜杠
    for entry in scan::list(root, None).expect("list 根") {
        assert!(!entry.path.contains('\\'), "list 路径必须是正斜杠");
    }
    let notes = scan::list(root, Some("notes")).expect("list notes");
    let note_paths: Vec<&str> = notes.iter().map(|entry| entry.path.as_str()).collect();
    assert_eq!(note_paths, vec!["notes/b.md", "notes/new.md"]);

    // 画布路径保持正斜杠且只认 *.canvas.json
    let canvases = scan::list_canvases(root).expect("canvases");
    assert_eq!(canvases.len(), 1);
    assert_eq!(
        canvases[0].path.as_deref(),
        Some(".workbench/canvas/01H8XYZABCDEF.canvas.json")
    );

    // 旧库其余文件一字节不动
    assert_eq!(
        fs::read(root.join("media/ab/cat.png")).expect("media"),
        [0x89, 0x50, 0x4e, 0x47]
    );
    let settings = fs::read_to_string(root.join(".workbench/settings.json")).expect("settings");
    assert!(settings.contains("旧库"), "settings.json 不得被改写");
}

#[test]
fn locked_session_is_observable_but_not_writable() {
    let dir = legacy_vault();
    let root = dir.path().to_path_buf();
    let state = test_state(
        root.clone(),
        WriteGate::new(Some(ReadonlyReason::LockedByOther)),
    );

    // 只读原因通过身份 DTO 可观察
    let dto = identity_dto(&state.read().session).expect("identity dto");
    assert!(dto.readonly);
    assert_eq!(dto.readonly_reason, Some(ReadonlyReason::LockedByOther));

    // 读与扫描不受只读影响
    assert_eq!(doc::read(&root, "a.md").expect("读").text, "# A\n");
    assert!(!scan::scan(&root).expect("scan").is_empty());

    // 写 / 改名 / 删除统一 E_READONLY，磁盘保持原样
    let before = fs::read(root.join("a.md")).expect("before");
    let slot = state.read();
    let gate = &slot.session.gate;
    for error in [
        doc::write(gate, &root, "a.md", "# changed", None).expect_err("write"),
        doc::rename(gate, &root, "a.md", "b.md").expect_err("rename"),
        trash::delete(gate, &root, "a.md").expect_err("remove"),
    ] {
        assert_eq!(error.code(), "E_READONLY");
    }
    assert_eq!(fs::read(root.join("a.md")).expect("after"), before);

    // 只读闩锁进程内不解除：点亮后 `FilesystemReadonly` 覆盖启动原因
    gate.latch_filesystem_readonly();
    assert_eq!(
        gate.readonly_reason(),
        Some(ReadonlyReason::FilesystemReadonly)
    );
    assert_eq!(
        doc::write(gate, &root, "a.md", "x", None)
            .expect_err("闩锁")
            .code(),
        "E_READONLY"
    );
}

fn seed_trash(root: &Path, id: &str, age_days: u64) -> std::path::PathBuf {
    let dir = root.join(".workbench/trash").join(id);
    fs::create_dir_all(&dir).expect("trash dir");
    fs::write(dir.join("item"), b"gone").expect("item");
    let modified = SystemTime::now() - Duration::from_secs(age_days * 86_400);
    fs::File::open(&dir)
        .expect("open dir")
        .set_times(fs::FileTimes::new().set_modified(modified))
        .expect("set mtime");
    dir
}

/// 启动清扫的端到端语义：只清超过保留期的目录，新目录原样保留。
#[test]
fn startup_sweep_removes_expired_trash_and_keeps_fresh() {
    let dir = legacy_vault();
    let root = dir.path();
    let gate = WriteGate::new(None);
    let old = seed_trash(root, "01OLDDIR", 9);
    let fresh = seed_trash(root, "01NEWDIR", 1);

    let report = trash::sweep(&gate, root, TRASH_RETENTION_DAYS, SystemTime::now());

    assert_eq!(report.removed, vec!["01OLDDIR".to_string()]);
    assert!(report.errors.is_empty(), "不应有失败项");
    assert!(!old.exists(), "超过 7 天的暂存必须清除");
    assert!(fresh.exists(), "未过期的暂存必须保留");
}

/// 备份端到端：导出后 `inspect` 逐文件复核通过，且隐藏项被排除。
#[test]
fn backup_export_then_inspect_verifies_every_file() {
    let dir = legacy_vault();
    let root = dir.path();
    let output = tempdir().expect("out");
    let target = output.path().join("EmberBackup");

    let report = backup::export(root, &target).expect("export");
    assert!(report.files >= 3, "至少覆盖文档与媒体");
    assert!(target.join("a.md").exists());
    assert!(target.join("notes/b.md").exists());
    assert!(target.join("media/ab/cat.png").exists());
    assert!(!target.join(".workbench").exists(), "隐藏目录必须排除");

    let checked = backup::inspect(&target).expect("inspect");
    assert_eq!(checked.files, report.files);
    assert_eq!(checked.bytes, report.bytes);
    assert_eq!(checked.source_root, root.to_string_lossy());
}

#[test]
fn backup_export_refuses_existing_destination() {
    let dir = legacy_vault();
    let root = dir.path();
    let output = tempdir().expect("out");
    let target = output.path().join("EmberBackup");
    fs::create_dir_all(&target).expect("existing");
    fs::write(target.join("keep.txt"), b"keep").expect("keep");

    let error = backup::export(root, &target).expect_err("已存在必须拒绝");

    assert_eq!(error.code(), VaultError::InvalidArg("x".into()).code());
    assert_eq!(
        fs::read(target.join("keep.txt")).expect("keep"),
        b"keep",
        "旧备份不得被覆盖"
    );
}

#[test]
fn backup_inspect_detects_tampered_manifest() {
    let dir = legacy_vault();
    let root = dir.path();
    let output = tempdir().expect("out");
    let target = output.path().join("EmberBackup");
    backup::export(root, &target).expect("export");

    let manifest_path = target.join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).expect("read")).expect("json");
    manifest["files"][0]["bytes"] = serde_json::Value::from(999_999);
    fs::write(
        &manifest_path,
        serde_json::to_vec_pretty(&manifest).expect("json"),
    )
    .expect("tamper");

    assert_eq!(
        backup::inspect(&target).expect_err("篡改必须被发现").code(),
        VaultError::Io(std::io::Error::other("x")).code()
    );
}

#[test]
fn backup_export_failure_leaves_no_partial_directory() {
    let dir = legacy_vault();
    let root = dir.path();
    let output = tempdir().expect("out");
    let target = output.path().join("EmberBackup");
    let calls = std::cell::Cell::new(0usize);

    let error = backup::export_with(root, &target, |source, destination| {
        let index = calls.get() + 1;
        calls.set(index);
        if index == 2 {
            return Err(VaultError::Io(std::io::Error::other("模拟中途失败")));
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        let bytes = fs::copy(source, destination).expect("copy");
        Ok((
            bytes,
            atomic::hex_sha256(&fs::read(destination).expect("read")),
        ))
    })
    .expect_err("中途失败必须上报");

    assert_eq!(
        error.code(),
        VaultError::Io(std::io::Error::other("x")).code()
    );
    assert!(!target.exists(), "失败不得留下最终备份目录");
    assert_eq!(
        fs::read_dir(output.path()).expect("read").count(),
        0,
        "失败不得残留暂存目录"
    );
}
