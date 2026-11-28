//! 库内文件变更监听：notify（macOS 走 FSEvents）→ 500 ms 尾沿防抖 → 批量上报。
//!
//! 三条硬约束：
//! 1. 只监听 `.md`，跳过隐藏项、`media/`、`history/`、`trash/`，并尊重旧库
//!    `settings.json` 的 `watcherIgnoreDirs`；
//! 2. 自己的写入先登记到 [`WriteJournal`]，冲刷时按内容 sha256 比对，命中即丢弃；
//! 3. 监听全程只读，不持 `WriteGate`，不阻塞业务写入。
//!
//! 退出靠 `stop` 标志（接收循环每 200 ms 醒一次），`Drop` 会 join 监听线程。

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use notify::event::{EventKind, ModifyKind, RenameMode};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use tauri::{AppHandle, Emitter};

use crate::ipc::watch::FileChangedDto;
use crate::ipc::{ErrorPayload, VaultError, VaultResult};
use crate::vault::{atomic, constants, doc, paths};

/// 文档变更事件（批量数组，一次冲刷一条）。
pub const FILE_CHANGED_EVENT: &str = "vault://file-changed";
/// 监听启动失败事件；负载与其它命令错误同形（`code` + `message`）。
pub const WATCH_ERROR_EVENT: &str = "vault://watch-error";

/// 连续写入时的最大聚合窗口：防止事件被无限推迟。
const MAX_DELAY_MS: u64 = 2_000;
/// 写登记的有效期；过期未命中的条目在下一次冲刷时惰性清理。
const JOURNAL_TTL_MS: u64 = 10_000;
/// 接收循环的唤醒间隔，同时也是 `Drop` 后线程退出的最大延迟。
const RECV_SLICE_MS: u64 = 200;
/// 顶层目录跳过表（隐藏目录由 `.` 前缀规则覆盖）。
const SKIP_TOP_DIRS: [&str; 3] = ["media", "history", "trash"];

/// 监听线程上抛的消息：正常批量变更，或监听/取哈希失败。
#[derive(Debug)]
pub enum WatchMessage {
    Changed(FileChanged),
    Failed(ErrorPayload),
}

/// 单条变更类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
    Created,
    Updated,
    Removed,
    Renamed,
}

/// 一条待上报的变更；`bytes`/`sha256`/`modified_ms` 在冲刷时补齐。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub kind: ChangeKind,
    pub path: String,
    pub from: Option<String>,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub modified_ms: Option<u64>,
}

/// 一次冲刷的批量结果。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileChanged {
    pub changes: Vec<FileChange>,
}

/// 防抖与登记参数：生产取常量，测试注入更短窗口。
#[derive(Debug, Clone, Copy)]
pub struct WatchConfig {
    pub debounce: Duration,
    pub max_delay: Duration,
    pub journal_ttl: Duration,
}

impl WatchConfig {
    pub fn production() -> Self {
        Self {
            debounce: Duration::from_millis(constants::WATCHER_DEBOUNCE_MS),
            max_delay: Duration::from_millis(MAX_DELAY_MS),
            journal_ttl: Duration::from_millis(JOURNAL_TTL_MS),
        }
    }
}

#[derive(Debug, Clone)]
struct JournalEntry {
    sha256: Option<String>,
    removed: bool,
    at: Instant,
}

/// 自写登记表：记录「刚由我们写入/删除的内容指纹」，用来压掉 notify 回环。
///
/// 只按路径 + 内容 sha256 比对，不看 mtime（原子写必然刷新 mtime，无法区分来源）。
#[derive(Debug, Clone, Default)]
pub struct WriteJournal {
    entries: Arc<Mutex<HashMap<String, JournalEntry>>>,
}

impl WriteJournal {
    /// 记一次成功的写入（`sha256` 来自 `doc::write` 的回执）。
    pub fn note_write(&self, path: &str, sha256: &str) {
        self.lock().insert(
            path.to_string(),
            JournalEntry {
                sha256: Some(sha256.to_string()),
                removed: false,
                at: Instant::now(),
            },
        );
    }

    /// 记一次成功的删除或改名的源端。
    pub fn note_removed(&self, path: &str) {
        self.lock().insert(
            path.to_string(),
            JournalEntry {
                sha256: None,
                removed: true,
                at: Instant::now(),
            },
        );
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, JournalEntry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// 惰性清理过期项；只在冲刷时调用，不额外起定时器。
    fn purge(&self, ttl: Duration) {
        self.lock().retain(|_, entry| entry.at.elapsed() <= ttl);
    }

    /// 判断一条变更是否是我们自己造成的；命中后该条目立即失效。
    fn suppresses(&self, change: &FileChange, ttl: Duration) -> bool {
        let mut entries = self.lock();
        let Some(entry) = entries.get(&change.path).cloned() else {
            return false;
        };
        if entry.at.elapsed() > ttl {
            entries.remove(&change.path);
            return false;
        }
        let suppress = if entry.removed {
            change.kind == ChangeKind::Removed
        } else {
            change.kind != ChangeKind::Removed
                && entry.sha256.is_some()
                && entry.sha256.as_deref() == change.sha256.as_deref()
        };
        // 墓碑命中即消耗；写入登记在命中时保留，用来压掉一次写入被切成多批的残余事件。
        if entry.removed || !suppress {
            entries.remove(&change.path);
        }
        suppress
    }
}

/// 监听句柄：持有线程与停止标志，`Drop` 时退出监听。
#[derive(Debug)]
pub struct WatchHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for WatchHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// 生产装配：事件经 Tauri 发到前端。
pub fn spawn(app: &AppHandle, root: PathBuf, journal: WriteJournal) -> VaultResult<WatchHandle> {
    let handle = app.clone();
    spawn_with(
        root,
        journal,
        WatchConfig::production(),
        move |message| match message {
            WatchMessage::Changed(payload) => {
                if let Err(error) = handle.emit(FILE_CHANGED_EVENT, FileChangedDto::from(payload)) {
                    warn(&format!("file-changed 上报失败：{error}"));
                }
            }
            WatchMessage::Failed(payload) => {
                warn(&format!("监听降级：{} {}", payload.code, payload.message));
                if let Err(error) = handle.emit(WATCH_ERROR_EVENT, payload) {
                    warn(&format!("watch-error 上报失败：{error}"));
                }
            }
        },
    )
}

/// 可注入装配：`sink` 收到批量结果，测试用它替代 Tauri 事件。
pub fn spawn_with<F>(
    root: PathBuf,
    journal: WriteJournal,
    config: WatchConfig,
    sink: F,
) -> VaultResult<WatchHandle>
where
    F: Fn(WatchMessage) + Send + 'static,
{
    // FSEvents 回报的是规范化路径（/var → /private/var），根必须同样规范化。
    let root = root.canonicalize()?;
    let ignores = legacy_ignore_dirs(&root);
    let (sender, receiver) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
        // 错误与事件走同一条通道，统一由监听线程上报，避免回调里静默丢弃。
        let _ = sender.send(result);
    })
    .map_err(|error| VaultError::Io(io::Error::other(error)))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| VaultError::Io(io::Error::other(error)))?;

    let stop = Arc::new(AtomicBool::new(false));
    let runtime = Runtime {
        root,
        journal,
        config,
        ignores,
        stop: Arc::clone(&stop),
    };
    let thread = thread::Builder::new()
        .name("vault-watch".to_string())
        .spawn(move || run(runtime, receiver, sink, watcher))
        .map_err(VaultError::Io)?;
    Ok(WatchHandle {
        stop,
        thread: Some(thread),
    })
}

/// 监听线程的运行参数（打包传参，避免超长参数表）。
struct Runtime {
    root: PathBuf,
    journal: WriteJournal,
    config: WatchConfig,
    ignores: Vec<String>,
    stop: Arc<AtomicBool>,
}

fn run<F>(
    runtime: Runtime,
    receiver: Receiver<notify::Result<Event>>,
    sink: F,
    _watcher: RecommendedWatcher,
) where
    F: Fn(WatchMessage),
{
    let Runtime {
        root,
        journal,
        config,
        ignores,
        stop,
    } = runtime;
    let mut pending: BTreeMap<String, FileChange> = BTreeMap::new();
    let mut deadline: Option<Instant> = None;
    let mut window_start: Option<Instant> = None;
    let slice = Duration::from_millis(RECV_SLICE_MS);
    while !stop.load(Ordering::Relaxed) {
        let wait = deadline
            .map(|value| value.saturating_duration_since(Instant::now()))
            .unwrap_or(slice)
            .min(slice);
        match receiver.recv_timeout(wait) {
            Ok(Ok(event)) => {
                for change in normalize(&root, &ignores, event) {
                    merge_into(&mut pending, change);
                }
                if !pending.is_empty() {
                    let now = Instant::now();
                    let start = *window_start.get_or_insert(now);
                    deadline = Some(now + config.debounce);
                    if now.duration_since(start) >= config.max_delay {
                        flush(&mut pending, &root, &journal, config, &sink);
                        deadline = None;
                        window_start = None;
                    }
                }
            }
            Ok(Err(error)) => {
                // notify 自身的失败（队列溢出、句柄失效）必须外报，不能静默丢事件。
                sink(WatchMessage::Failed(ErrorPayload::from(VaultError::Io(
                    io::Error::other(format!("文件监听错误：{error}")),
                ))));
            }
            Err(RecvTimeoutError::Timeout) => {
                if deadline.is_some_and(|value| Instant::now() >= value) {
                    flush(&mut pending, &root, &journal, config, &sink);
                    deadline = None;
                    window_start = None;
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

/// 冲刷：补齐元数据 → 登记表过滤 → 一次性上报。
/// 取哈希失败的文件从本批次剔除并单独上报，绝不发出没有 sha256 的变更。
fn flush<F>(
    pending: &mut BTreeMap<String, FileChange>,
    root: &Path,
    journal: &WriteJournal,
    config: WatchConfig,
    sink: &F,
) where
    F: Fn(WatchMessage),
{
    journal.purge(config.journal_ttl);
    let mut changes = Vec::with_capacity(pending.len());
    let mut failures = Vec::new();
    for (_, mut change) in std::mem::take(pending) {
        if let Err(error) = hydrate(root, &mut change) {
            failures.push(ErrorPayload::from(error));
            continue;
        }
        if journal.suppresses(&change, config.journal_ttl) {
            continue;
        }
        changes.push(change);
    }
    for payload in failures {
        sink(WatchMessage::Failed(payload));
    }
    if !changes.is_empty() {
        sink(WatchMessage::Changed(FileChanged { changes }));
    }
}

/// 把 notify 事件翻译成库内相对路径变更；不产生任何写操作。
fn normalize(root: &Path, ignores: &[String], event: Event) -> Vec<FileChange> {
    match event.kind {
        EventKind::Access(_) => Vec::new(),
        EventKind::Create(_) => event
            .paths
            .iter()
            .filter_map(|path| qualify(root, ignores, path, ChangeKind::Created))
            .collect(),
        EventKind::Remove(_) => event
            .paths
            .iter()
            .filter_map(|path| qualify(root, ignores, path, ChangeKind::Removed))
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            let from = rel_of(root, ignores, &event.paths[0]);
            let to = rel_of(root, ignores, &event.paths[1]);
            match (from, to) {
                (Some(from), Some(to)) => vec![FileChange {
                    kind: ChangeKind::Renamed,
                    path: to,
                    from: Some(from),
                    bytes: None,
                    sha256: None,
                    modified_ms: None,
                }],
                _ => Vec::new(),
            }
        }
        // macOS FSEvents 无法关联改名两端，只能给出一端：按 created / removed 兜底。
        EventKind::Modify(ModifyKind::Name(_)) => event
            .paths
            .iter()
            .filter_map(|path| qualify(root, ignores, path, ChangeKind::Renamed))
            .collect(),
        EventKind::Modify(_) => event
            .paths
            .iter()
            .filter_map(|path| qualify(root, ignores, path, ChangeKind::Updated))
            .collect(),
        EventKind::Any | EventKind::Other => event
            .paths
            .iter()
            .filter_map(|path| qualify(root, ignores, path, ChangeKind::Updated))
            .collect(),
    }
}

/// 过滤库外/隐藏/非 `.md` 路径，并按文件当前是否存在修正事件类型。
fn qualify(root: &Path, ignores: &[String], path: &Path, hint: ChangeKind) -> Option<FileChange> {
    let rel = rel_of(root, ignores, path)?;
    let metadata = fs::symlink_metadata(path).ok();
    if metadata
        .as_ref()
        .is_some_and(|value| value.file_type().is_symlink())
    {
        return None;
    }
    let is_file = metadata
        .as_ref()
        .is_some_and(|value| value.file_type().is_file());
    let kind = match hint {
        ChangeKind::Created | ChangeKind::Renamed if is_file => ChangeKind::Created,
        ChangeKind::Created | ChangeKind::Renamed => ChangeKind::Removed,
        ChangeKind::Updated if is_file => ChangeKind::Updated,
        // 事件说删除但文件仍在：回退成修改，避免把外部「另存」误报为删除。
        ChangeKind::Removed if is_file => ChangeKind::Updated,
        ChangeKind::Updated | ChangeKind::Removed => ChangeKind::Removed,
    };
    Some(FileChange {
        kind,
        path: rel,
        from: None,
        bytes: None,
        sha256: None,
        modified_ms: None,
    })
}

/// 相对路径过滤：隐藏段、忽略目录、`media|history|trash` 顶层、非 `.md` 一律丢弃。
fn rel_of(root: &Path, ignores: &[String], path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let text = rel.to_string_lossy().replace('\\', "/");
    if text.is_empty() {
        return None;
    }
    for component in text.split('/') {
        if component.starts_with('.') {
            return None;
        }
        if ignores.iter().any(|dir| dir == component) {
            return None;
        }
    }
    if !text.to_ascii_lowercase().ends_with(".md") {
        return None;
    }
    if text
        .split('/')
        .next()
        .is_some_and(|first| SKIP_TOP_DIRS.contains(&first))
    {
        return None;
    }
    Some(text)
}

/// 补齐大小、mtime 与 sha256；文件已消失时降级为 removed。
/// 取哈希失败要返回错误，由调用方剔除该变更并上报 watch-error。
fn hydrate(root: &Path, change: &mut FileChange) -> VaultResult<()> {
    if change.kind == ChangeKind::Removed {
        return Ok(());
    }
    let path = root.join(&change.path);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        change.kind = ChangeKind::Removed;
        return Ok(());
    };
    if !metadata.file_type().is_file() {
        change.kind = ChangeKind::Removed;
        return Ok(());
    }
    change.bytes = Some(metadata.len());
    change.modified_ms = Some(doc::modified_ms(&metadata));
    change.sha256 = Some(atomic::hash_file(&path)?);
    Ok(())
}

/// 同一路径在窗口内合并：created+removed 互相抵消，其余保留最新一次。
fn merge_into(pending: &mut BTreeMap<String, FileChange>, incoming: FileChange) {
    let key = incoming.path.clone();
    let Some(previous) = pending.get(&key).cloned() else {
        pending.insert(key, incoming);
        return;
    };
    match merge(&previous, incoming) {
        Some(merged) => {
            pending.insert(key, merged);
        }
        None => {
            pending.remove(&key);
        }
    }
}

fn merge(previous: &FileChange, incoming: FileChange) -> Option<FileChange> {
    let kind = match (previous.kind, incoming.kind) {
        (ChangeKind::Created, ChangeKind::Removed) => return None,
        (ChangeKind::Created, ChangeKind::Updated) => ChangeKind::Created,
        (ChangeKind::Removed, ChangeKind::Created | ChangeKind::Updated) => ChangeKind::Updated,
        (_, kind) => kind,
    };
    let from = incoming.from.clone().or_else(|| previous.from.clone());
    Some(FileChange {
        kind,
        from,
        ..incoming
    })
}

/// 读旧库 `settings.json` 的 `watcherIgnoreDirs`；缺失/损坏一律退回空表，绝不回写。
fn legacy_ignore_dirs(root: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(paths::settings_file(root)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .get("watcherIgnoreDirs")
        .and_then(|item| item.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter(|item| !item.is_empty() && !item.starts_with('.') && !item.contains('/'))
                .map(|item| item.to_string())
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn warn(detail: &str) {
    tracing::warn!(target: "vault::watch", "{}", detail);
}

#[cfg(test)]
mod tests {
    use std::thread;

    use tempfile::tempdir;

    use super::*;

    /// 测试窗口：短防抖让断言快，但不改生产逻辑。
    fn config() -> WatchConfig {
        WatchConfig {
            debounce: Duration::from_millis(120),
            max_delay: Duration::from_millis(400),
            journal_ttl: Duration::from_secs(10),
        }
    }

    fn start(root: &Path) -> (WatchHandle, Receiver<WatchMessage>) {
        start_with(root, WriteJournal::default())
    }

    fn start_with(root: &Path, journal: WriteJournal) -> (WatchHandle, Receiver<WatchMessage>) {
        let (sender, receiver) = mpsc::channel();
        let handle = spawn_with(root.to_path_buf(), journal, config(), move |message| {
            let _ = sender.send(message);
        })
        .expect("启动监听");
        // 给 FSEvents 一点挂载时间，避免写入早于监听生效。
        thread::sleep(Duration::from_millis(100));
        (handle, receiver)
    }

    /// 收集一段窗口内的全部批次；没有事件时返回空表。
    fn collect(receiver: &Receiver<WatchMessage>, wait: Duration) -> Vec<FileChanged> {
        let deadline = Instant::now() + wait;
        let mut out = Vec::new();
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(WatchMessage::Changed(payload)) => out.push(payload),
                Ok(WatchMessage::Failed(payload)) => {
                    panic!("常规场景不应出现监听失败：{payload:?}")
                }
                Err(_) => break,
            }
        }
        out
    }

    /// 等待第一条变更批次，并忽略失败消息（由专项测试断言失败路径）。
    fn next_changed(receiver: &Receiver<WatchMessage>, wait: Duration) -> Option<FileChanged> {
        let deadline = Instant::now() + wait;
        while let Some(remaining) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(WatchMessage::Changed(payload)) => return Some(payload),
                Ok(WatchMessage::Failed(_)) => continue,
                Err(_) => break,
            }
        }
        None
    }

    #[test]
    fn external_write_emits_within_one_second() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let (_handle, receiver) = start(root);

        let started = Instant::now();
        fs::write(root.join("a.md"), b"# hello\n").expect("write");
        let payload = next_changed(&receiver, Duration::from_secs(2)).expect("应收到变更事件");
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "外部改动必须在 1s 内上报，实际 {:?}",
            started.elapsed()
        );

        assert_eq!(payload.changes.len(), 1);
        let change = &payload.changes[0];
        assert_eq!(change.kind, ChangeKind::Created);
        assert_eq!(change.path, "a.md");
        let expected = atomic::hex_sha256(b"# hello\n");
        assert_eq!(change.sha256.as_deref(), Some(expected.as_str()));
        assert_eq!(change.bytes, Some(8));
    }

    #[test]
    fn burst_writes_collapse_into_hash_of_last_content() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let (_handle, receiver) = start(root);

        for index in 0..5 {
            fs::write(root.join("burst.md"), format!("v{index}")).expect("write");
            thread::sleep(Duration::from_millis(30));
        }

        let batches = collect(&receiver, Duration::from_millis(1_200));
        assert!(!batches.is_empty(), "至少应上报一次");
        // CI 偏慢时允许窗口被切成 2 条，但每条批次内同一路径只能出现一次。
        assert!(
            batches.len() <= 2,
            "防抖失效：切出了 {} 条批次",
            batches.len()
        );
        for batch in &batches {
            assert_eq!(batch.changes.len(), 1, "同一路径必须去重为 1 条");
            assert_eq!(batch.changes[0].path, "burst.md");
        }
        let last = batches
            .last()
            .and_then(|batch| batch.changes.last())
            .expect("最后一次变更");
        let expected = atomic::hex_sha256(b"v4");
        assert_eq!(
            last.sha256.as_deref(),
            Some(expected.as_str()),
            "最终 hash 必须对应最后一次写入的内容"
        );
    }

    #[test]
    fn hidden_internal_media_and_legacy_ignore_dirs_are_skipped() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join(".workbench")).expect("workbench");
        fs::write(
            root.join(".workbench/settings.json"),
            br#"{"watcherIgnoreDirs":["vendor"]}"#,
        )
        .expect("settings");
        let (_handle, receiver) = start(root);

        fs::write(root.join(".hidden.md"), b"x").expect("hidden");
        fs::write(root.join(".workbench/note.md"), b"x").expect("workbench");
        fs::create_dir_all(root.join("media")).expect("media");
        fs::write(root.join("media/pic.md"), b"x").expect("media");
        fs::create_dir_all(root.join("vendor")).expect("vendor");
        fs::write(root.join("vendor/dep.md"), b"x").expect("vendor doc");

        let batches = collect(&receiver, Duration::from_millis(500));
        assert!(
            batches.is_empty(),
            "隐藏项 / media / 旧版忽略目录必须静默：{batches:?}"
        );
    }

    #[test]
    fn journal_suppresses_own_write_but_keeps_external_change() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let journal = WriteJournal::default();
        let (_handle, receiver) = start_with(root, journal.clone());

        let own = atomic::hex_sha256(b"# same\n");
        journal.note_write("own.md", &own);
        fs::write(root.join("own.md"), b"# same\n").expect("write");
        assert!(
            collect(&receiver, Duration::from_millis(500)).is_empty(),
            "自己写入的内容必须被登记表抑制"
        );

        fs::write(root.join("own.md"), b"# external\n").expect("write");
        let batches = collect(&receiver, Duration::from_millis(1_200));
        let change = batches
            .last()
            .and_then(|batch| batch.changes.last())
            .expect("外部改动必须上报");
        let expected = atomic::hex_sha256(b"# external\n");
        assert_eq!(change.sha256.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn remove_and_rename_are_reported() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        fs::write(root.join("a.md"), b"alpha").expect("seed");
        let (_handle, receiver) = start(root);
        let _ = collect(&receiver, Duration::from_millis(400));

        fs::rename(root.join("a.md"), root.join("b.md")).expect("rename");
        let renamed = collect(&receiver, Duration::from_millis(1_200));
        let changes: Vec<&FileChange> = renamed.iter().flat_map(|batch| &batch.changes).collect();
        assert!(
            changes.iter().any(|change| {
                (change.kind == ChangeKind::Renamed && change.from.as_deref() == Some("a.md"))
                    || (change.path == "b.md" && change.kind == ChangeKind::Created)
                    || (change.path == "a.md" && change.kind == ChangeKind::Removed)
            }),
            "改名应按 renamed 或 removed/created 兜底上报：{changes:?}"
        );

        fs::remove_file(root.join("b.md")).expect("remove");
        let removed = collect(&receiver, Duration::from_millis(1_200));
        let changes: Vec<&FileChange> = removed.iter().flat_map(|batch| &batch.changes).collect();
        assert!(
            changes
                .iter()
                .any(|change| change.path == "b.md" && change.kind == ChangeKind::Removed),
            "删除必须上报 removed：{changes:?}"
        );
    }

    #[test]
    fn window_merge_cancels_create_then_remove() {
        let created = FileChange {
            kind: ChangeKind::Created,
            path: "a.md".to_string(),
            from: None,
            bytes: None,
            sha256: None,
            modified_ms: None,
        };
        let mut pending = BTreeMap::new();
        merge_into(&mut pending, created.clone());
        assert_eq!(pending.len(), 1);

        merge_into(
            &mut pending,
            FileChange {
                kind: ChangeKind::Removed,
                ..created.clone()
            },
        );
        assert!(pending.is_empty(), "窗口内建了又删应互相抵消");

        merge_into(
            &mut pending,
            FileChange {
                kind: ChangeKind::Removed,
                ..created.clone()
            },
        );
        merge_into(
            &mut pending,
            FileChange {
                kind: ChangeKind::Created,
                ..created
            },
        );
        assert_eq!(
            pending["a.md"].kind,
            ChangeKind::Updated,
            "先删后建应合并成一次修改"
        );
    }

    #[cfg(unix)]
    #[test]
    fn hash_failure_reports_error_and_drops_change() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        let path = root.join("secret.md");
        fs::write(&path, b"x").expect("seed");
        fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).expect("chmod");

        let mut pending = BTreeMap::new();
        pending.insert(
            "secret.md".to_string(),
            FileChange {
                kind: ChangeKind::Updated,
                path: "secret.md".to_string(),
                from: None,
                bytes: None,
                sha256: None,
                modified_ms: None,
            },
        );
        let messages = std::cell::RefCell::new(Vec::new());
        flush(
            &mut pending,
            root,
            &WriteJournal::default(),
            config(),
            &|message| messages.borrow_mut().push(message),
        );
        let messages = messages.into_inner();
        fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("restore");

        assert!(
            messages.iter().any(
                |message| matches!(message, WatchMessage::Failed(payload) if payload.code == "E_IO")
            ),
            "取哈希失败必须上报 E_IO：{messages:?}"
        );
        assert!(
            !messages.iter().any(|message| matches!(
                message,
                WatchMessage::Changed(batch) if batch.changes.iter().any(|change| change.path == "secret.md")
            )),
            "禁止发出没有 sha256 的变更：{messages:?}"
        );
    }

    #[test]
    fn notify_error_is_reported() {
        let dir = tempdir().expect("tempdir");
        let (sender, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let (out, messages) = mpsc::channel();
        let runtime = Runtime {
            root: dir.path().to_path_buf(),
            journal: WriteJournal::default(),
            config: config(),
            ignores: Vec::new(),
            stop: Arc::clone(&stop),
        };
        let watcher = notify::recommended_watcher(|_: notify::Result<Event>| {}).expect("watcher");
        let thread = thread::spawn(move || {
            run(
                runtime,
                receiver,
                move |message| {
                    let _ = out.send(message);
                },
                watcher,
            )
        });

        sender
            .send(Err(notify::Error::new(notify::ErrorKind::Generic(
                "boom".to_string(),
            ))))
            .expect("send error");
        let message = messages
            .recv_timeout(Duration::from_secs(1))
            .expect("应上报失败");
        assert!(
            matches!(&message, WatchMessage::Failed(payload) if payload.code == "E_IO"
                && payload.message.contains("文件监听错误")),
            "notify 错误必须以 E_IO 上报：{message:?}"
        );

        stop.store(true, Ordering::Relaxed);
        thread.join().expect("join");
    }
}
