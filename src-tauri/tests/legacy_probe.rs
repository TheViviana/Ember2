//! 一次性真旧库实测（`#[ignore]`）：把真实旧库复制到临时目录，
//! 在副本上跑「读 → 写 → 删进回收站 → 备份 → watcher 触发」全链路。
//!
//! 默认读取 `~/Documents/EmberVault`，可用 `EMBER_LEGACY_VAULT` 指定其它库。
//! 运行：
//!
//! ```text
//! cargo test --test legacy_probe -- --ignored --nocapture
//! ```
//!
//! 全程只操作临时副本；临时目录随 `TempDir` 析构删除，系统废纸篓中被本次
//! 删除的条目录完即清。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ember_lib::vault::{backup, doc, gate::WriteGate, media, trash, watch};

/// 1x1 透明 PNG 的最小合法字节（仅用于造平铺媒体样本）。
const PNG_1X1: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xFC, 0xCF, 0xC0, 0xF0,
    0x1F, 0x00, 0x05, 0x01, 0x01, 0x00, 0x5F, 0x1A, 0x2D, 0x5A, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn legacy_root() -> PathBuf {
    if let Some(value) = std::env::var_os("EMBER_LEGACY_VAULT") {
        return PathBuf::from(value);
    }
    let home = std::env::var("HOME").expect("HOME");
    PathBuf::from(home).join("Documents/EmberVault")
}

/// 递归复制（不含符号链接目标，避免拖进库外内容）。
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).expect("创建目标目录");
    for entry in fs::read_dir(from).expect("读取源目录") {
        let entry = entry.expect("目录项");
        let name = entry.file_name();
        let source = entry.path();
        let target = to.join(&name);
        let file_type = entry.file_type().expect("文件类型");
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_tree(&source, &target);
        } else if file_type.is_file() {
            fs::copy(&source, &target).expect("复制文件");
        }
    }
}

fn collect_docs(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                let rel = path.strip_prefix(root).expect("相对路径");
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn trash_snapshot() -> BTreeSet<String> {
    let dir = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".Trash");
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

fn clear_new_trash(before: &BTreeSet<String>) {
    let dir = PathBuf::from(std::env::var("HOME").expect("HOME")).join(".Trash");
    for name in trash_snapshot().difference(before) {
        let path = dir.join(name);
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else {
            let _ = fs::remove_file(&path);
        }
    }
}

#[test]
#[ignore = "一次性真旧库实测：需要本机存在旧库，手动执行 --ignored"]
fn legacy_vault_full_cycle() {
    let source = legacy_root();
    if !source.is_dir() {
        println!("SKIP：旧库不存在：{}", source.display());
        return;
    }
    let temp = tempfile::tempdir().expect("临时目录");
    let root = temp.path().join("EmberVault");
    let started = Instant::now();
    copy_tree(&source, &root);
    let gate = WriteGate::new(None);
    println!(
        "副本：{}（{} ms）",
        root.display(),
        started.elapsed().as_millis()
    );

    // 1. 读
    let docs = collect_docs(&root);
    println!("文档数：{}", docs.len());
    let first = docs.first().expect("旧库至少应有一篇文档");
    let read_started = Instant::now();
    let read = doc::read(&root, first).expect("读文件");
    println!(
        "读：{} bytes={} sha256={}… 耗时={} ms",
        read.path,
        read.bytes,
        &read.sha256[..12],
        read_started.elapsed().as_millis()
    );

    // 2. 写
    let write_started = Instant::now();
    let written =
        doc::write(&gate, &root, "probe/legacy-probe.md", "# 旧库实测\n", None).expect("写文件");
    let written_back = doc::read(&root, "probe/legacy-probe.md").expect("回读");
    println!(
        "写：{} bytes={} sha256={}… 回读一致={} 耗时={} ms",
        written.path,
        written.bytes,
        &written.sha256[..12],
        written_back.text == "# 旧库实测\n",
        write_started.elapsed().as_millis()
    );

    // 3. 平铺媒体：旧库没有样本就造一个 media/a.png
    let flat = root.join("media").join("a.png");
    if !flat.exists() {
        fs::create_dir_all(root.join("media")).expect("创建 media");
        fs::write(&flat, PNG_1X1).expect("写 media/a.png");
    }
    let entries = media::list(&root).expect("列媒体");
    let flat_entry = entries
        .iter()
        .find(|entry| entry.path == "media/a.png")
        .expect("media/a.png 应出现在媒体列表");
    let bytes_back = fs::read(&flat).expect("读媒体");
    println!(
        "媒体：{} kind={:?} bytes={} 回读等于写入={} 列表总数={}",
        flat_entry.path,
        flat_entry.kind,
        flat_entry.bytes,
        bytes_back == PNG_1X1,
        entries.len()
    );

    // 4. 删进回收站
    let trash_before = trash_snapshot();
    let removed = trash::delete(&gate, &root, "probe/legacy-probe.md").expect("删除");
    println!(
        "删：via={} trashId={} 源文件仍存在={}",
        removed.via.as_str(),
        removed.trash_id,
        root.join("probe/legacy-probe.md").exists()
    );

    // 5. 备份
    let destination = temp.path().join("backup-out");
    let backup_started = Instant::now();
    let report = backup::export(&root, &destination).expect("备份");
    let inspect = backup::inspect(&destination).expect("校验备份");
    println!(
        "备份：files={} bytes={} 校验 files={} bytes={} 耗时={} ms",
        report.files,
        report.bytes,
        inspect.files,
        inspect.bytes,
        backup_started.elapsed().as_millis()
    );

    // 6. watcher 触发（外部写入，不经 doc::write，避免被自写抑制）
    let (sender, receiver) = mpsc::channel();
    let config = watch::WatchConfig {
        debounce: Duration::from_millis(200),
        max_delay: Duration::from_millis(1_000),
        journal_ttl: Duration::from_millis(2_000),
    };
    let handle = watch::spawn_with(
        root.clone(),
        watch::WriteJournal::default(),
        config,
        move |message| {
            let _ = sender.send(message);
        },
    )
    .expect("启动 watcher");
    let watch_started = Instant::now();
    fs::write(root.join("probe/watch-probe.md"), "# watcher\n").expect("外部写入");
    let mut latency = None;
    let mut saw_error = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(watch::WatchMessage::Changed(payload)) => {
                if payload
                    .changes
                    .iter()
                    .any(|change| change.path == "probe/watch-probe.md")
                {
                    latency = Some(watch_started.elapsed());
                    break;
                }
            }
            Ok(watch::WatchMessage::Failed(payload)) => saw_error = Some(payload),
            Err(_) => break,
        }
    }
    drop(handle);
    println!(
        "watcher：{}，错误事件={:?}",
        latency.map_or_else(
            || "5s 内未收到（失败）".to_string(),
            |value| format!("{} ms 收到变更", value.as_millis())
        ),
        saw_error.map(|payload| payload.code)
    );

    // 7. 清理
    clear_new_trash(&trash_before);
    println!("清理：临时库随 TempDir 删除，废纸篓新增项已回收");
}
