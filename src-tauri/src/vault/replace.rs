use std::collections::BTreeSet;
use std::path::Path;

use crate::ipc::{VaultError, VaultResult};
use crate::vault::doc::{self, WriteDoc};
use crate::vault::gate::{WriteGate, WritePermit};
use crate::vault::watch::WriteJournal;
use crate::vault::{history, paths};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceItem {
    pub path: String,
    pub expected_sha: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaceStatus {
    Applied,
    RolledBack,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceFailure {
    pub path: String,
    pub code: &'static str,
    pub message: String,
}

impl ReplaceFailure {
    fn new(path: &str, error: VaultError) -> Self {
        Self {
            path: path.to_string(),
            code: error.code(),
            message: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceOutcome {
    pub status: ReplaceStatus,
    pub written: Vec<String>,
    pub restored: Vec<String>,
    pub failure: Option<ReplaceFailure>,
    pub rollback_errors: Vec<ReplaceFailure>,
}

struct PreparedItem {
    path: String,
    expected_sha: String,
    text: String,
    original_text: String,
}

struct WrittenItem {
    path: String,
    original_text: String,
    new_sha: String,
}

/// 运行期批量替换：预检全部通过后逐文件原子写，失败时尽力逆序恢复。
/// 不提供持久化崩溃日志，也不保证进程崩溃或断电时的跨文件原子性。
pub fn replace(
    gate: &WriteGate,
    writes: &WriteJournal,
    root: &Path,
    items: Vec<ReplaceItem>,
) -> VaultResult<ReplaceOutcome> {
    replace_inner(gate, writes, root, items, doc::write_with_permit)
}

#[cfg(test)]
fn replace_with_writer<F>(
    gate: &WriteGate,
    writes: &WriteJournal,
    root: &Path,
    items: Vec<ReplaceItem>,
    write: F,
) -> VaultResult<ReplaceOutcome>
where
    F: FnMut(
        &WriteGate,
        &Path,
        &str,
        &str,
        Option<&str>,
        &WritePermit<'_>,
    ) -> VaultResult<WriteDoc>,
{
    replace_inner(gate, writes, root, items, write)
}

fn replace_inner<F>(
    gate: &WriteGate,
    writes: &WriteJournal,
    root: &Path,
    items: Vec<ReplaceItem>,
    mut write: F,
) -> VaultResult<ReplaceOutcome>
where
    F: FnMut(
        &WriteGate,
        &Path,
        &str,
        &str,
        Option<&str>,
        &WritePermit<'_>,
    ) -> VaultResult<WriteDoc>,
{
    let permit = gate.enter()?;
    if items.is_empty() {
        return Err(VaultError::InvalidArg(
            "替换批次至少需要一个文档".to_string(),
        ));
    }

    let mut seen = BTreeSet::new();
    let mut prepared = Vec::with_capacity(items.len());
    for item in items {
        let absolute = doc::prepare_write(root, &item.path, &item.text)?;
        let path = paths::to_rel(root, &absolute)?;
        if !seen.insert(path.clone()) {
            return Err(VaultError::InvalidArg(format!(
                "替换批次包含重复路径：{path}"
            )));
        }
        let current = match doc::read(root, &path) {
            Ok(current) => current,
            Err(VaultError::NotFound) => return Err(stale_expected_sha()),
            Err(error) => return Err(error),
        };
        if current.sha256 != item.expected_sha {
            return Err(stale_expected_sha());
        }
        prepared.push(PreparedItem {
            path,
            expected_sha: item.expected_sha,
            text: item.text,
            original_text: current.text,
        });
    }

    let mut completed: Vec<WrittenItem> = Vec::with_capacity(prepared.len());
    for item in &prepared {
        snapshot_original(root, item, &permit);
        match write(
            gate,
            root,
            &item.path,
            &item.text,
            Some(&item.expected_sha),
            &permit,
        ) {
            Ok(written) => {
                writes.note_write(&written.path, &written.sha256);
                completed.push(WrittenItem {
                    path: item.path.clone(),
                    original_text: item.original_text.clone(),
                    new_sha: written.sha256,
                });
            }
            Err(error) => {
                let failure = ReplaceFailure::new(&item.path, error);
                let mut restored = Vec::new();
                let mut restored_paths = BTreeSet::new();
                let mut rollback_errors = Vec::new();
                for previous in completed.iter().rev() {
                    match write(
                        gate,
                        root,
                        &previous.path,
                        &previous.original_text,
                        Some(&previous.new_sha),
                        &permit,
                    ) {
                        Ok(restored_write) => {
                            writes.note_write(&restored_write.path, &restored_write.sha256);
                            restored.push(previous.path.clone());
                            restored_paths.insert(previous.path.clone());
                        }
                        Err(error) => {
                            rollback_errors.push(ReplaceFailure::new(&previous.path, error))
                        }
                    }
                }
                let status = if rollback_errors.is_empty() {
                    ReplaceStatus::RolledBack
                } else {
                    ReplaceStatus::Partial
                };
                let written = completed
                    .iter()
                    .filter(|entry| !restored_paths.contains(&entry.path))
                    .map(|entry| entry.path.clone())
                    .collect();
                return Ok(ReplaceOutcome {
                    status,
                    written,
                    restored,
                    failure: Some(failure),
                    rollback_errors,
                });
            }
        }
    }

    Ok(ReplaceOutcome {
        status: ReplaceStatus::Applied,
        written: completed.into_iter().map(|entry| entry.path).collect(),
        restored: Vec::new(),
        failure: None,
        rollback_errors: Vec::new(),
    })
}

fn stale_expected_sha() -> VaultError {
    VaultError::InvalidArg("文档已在写入前发生变化".to_string())
}

fn snapshot_original(root: &Path, item: &PreparedItem, permit: &WritePermit<'_>) {
    let Some(doc_id) = history::extract_doc_id(&item.original_text) else {
        return;
    };
    if let Err(error) = history::snapshot_with_permit(root, &doc_id, &item.original_text, permit) {
        tracing::warn!(
            target: "vault::history",
            "批量替换快照失败（不阻塞写入）：docId={doc_id} path={}：{} {}",
            item.path,
            error.code(),
            error
        );
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::sync::mpsc;
    use std::time::Duration;

    use tempfile::tempdir;

    use super::*;
    use crate::vault::atomic;
    use crate::vault::constants::MAX_DOC_BYTES;

    const DOC_ID_A: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const DOC_ID_B: &str = "01BBBZNDEKTSV4RRFFQ69G5FAV";

    fn seed(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, text).expect("seed");
    }

    fn item(root: &Path, path: &str, text: &str) -> ReplaceItem {
        ReplaceItem {
            path: path.to_string(),
            expected_sha: doc::read(root, path).expect("preflight seed").sha256,
            text: text.to_string(),
        }
    }

    fn three_file_batch(root: &Path) -> Vec<ReplaceItem> {
        vec![
            item(root, "a.md", "new-a"),
            item(root, "b.md", "new-b"),
            item(root, "c.md", "new-c"),
        ]
    }

    fn document(doc_id: &str, body: &str) -> String {
        format!("---\nid: {doc_id}\n---\n\n{body}\n")
    }

    #[test]
    fn any_stale_expected_sha_fails_preflight_with_zero_writes() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", "old-a");
        seed(root, "b.md", "old-b");
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();
        let mut items = vec![item(root, "a.md", "new-a"), item(root, "b.md", "new-b")];
        items[1].expected_sha = "00".repeat(32);
        let mut write_calls = 0;

        let error = replace_with_writer(&gate, &journal, root, items, |_, _, _, _, _, _| {
            write_calls += 1;
            unreachable!("预检失败不得进入写入")
        })
        .expect_err("任一 expectedSha 失配都必须拒绝整批");

        assert_eq!(error.code(), "E_INVALID_ARG");
        assert_eq!(write_calls, 0);
        assert_eq!(fs::read_to_string(root.join("a.md")).expect("a"), "old-a");
        assert_eq!(fs::read_to_string(root.join("b.md")).expect("b"), "old-b");
    }

    #[test]
    fn empty_invalid_path_non_markdown_and_oversize_never_call_writer() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", "old-a");
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();
        let mut write_calls = 0;

        let empty = replace_with_writer(&gate, &journal, root, Vec::new(), |_, _, _, _, _, _| {
            write_calls += 1;
            unreachable!("空批次不得写入")
        })
        .expect_err("空批次");
        assert_eq!(empty.code(), "E_INVALID_ARG");

        for (path, code) in [
            ("../escape.md", "E_PATH_ESCAPE"),
            ("a.txt", "E_INVALID_ARG"),
        ] {
            let request = ReplaceItem {
                path: path.to_string(),
                expected_sha: "00".repeat(32),
                text: "new".to_string(),
            };
            let error =
                replace_with_writer(&gate, &journal, root, vec![request], |_, _, _, _, _, _| {
                    write_calls += 1;
                    unreachable!("非法请求不得写入")
                })
                .expect_err(path);
            assert_eq!(error.code(), code);
        }

        let oversize = ReplaceItem {
            path: "a.md".to_string(),
            expected_sha: doc::read(root, "a.md").expect("read").sha256,
            text: "x".repeat(MAX_DOC_BYTES as usize + 1),
        };
        let error =
            replace_with_writer(&gate, &journal, root, vec![oversize], |_, _, _, _, _, _| {
                write_calls += 1;
                unreachable!("超限请求不得写入")
            })
            .expect_err("正文超限");
        assert_eq!(error.code(), "E_INVALID_ARG");
        assert_eq!(write_calls, 0);
        assert_eq!(fs::read_to_string(root.join("a.md")).expect("a"), "old-a");
    }

    #[test]
    fn nth_write_failure_rolls_back_in_reverse_order_with_new_sha() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", "old-a");
        seed(root, "b.md", "old-b");
        seed(root, "c.md", "old-c");
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();
        let mut calls = Vec::new();

        let outcome = replace_with_writer(
            &gate,
            &journal,
            root,
            three_file_batch(root),
            |gate, root, path, text, expected_sha, permit| {
                calls.push((
                    path.to_string(),
                    text.to_string(),
                    expected_sha.expect("conditional").to_string(),
                ));
                if path == "c.md" && text == "new-c" {
                    return Err(VaultError::Io(io::Error::other("injected write failure")));
                }
                doc::write_with_permit(gate, root, path, text, expected_sha, permit)
            },
        )
        .expect("运行期失败应返回事务结果");

        assert_eq!(outcome.status, ReplaceStatus::RolledBack);
        assert!(outcome.written.is_empty());
        assert_eq!(outcome.restored, ["b.md", "a.md"]);
        assert!(outcome.rollback_errors.is_empty());
        assert_eq!(outcome.failure.expect("failure").path, "c.md");
        let paths: Vec<&str> = calls.iter().map(|call| call.0.as_str()).collect();
        assert_eq!(paths, ["a.md", "b.md", "c.md", "b.md", "a.md"]);
        assert_eq!(calls[3].1, "old-b");
        assert_eq!(calls[3].2, atomic::hex_sha256(b"new-b"));
        assert_eq!(calls[4].1, "old-a");
        assert_eq!(calls[4].2, atomic::hex_sha256(b"new-a"));
        for (path, original) in [("a.md", "old-a"), ("b.md", "old-b"), ("c.md", "old-c")] {
            assert_eq!(fs::read_to_string(root.join(path)).expect(path), original);
        }
    }

    #[test]
    fn rollback_sha_mismatch_returns_partial_and_preserves_external_change() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", "old-a");
        seed(root, "b.md", "old-b");
        seed(root, "c.md", "old-c");
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();

        let outcome = replace_with_writer(
            &gate,
            &journal,
            root,
            three_file_batch(root),
            |gate, root, path, text, expected_sha, permit| {
                if path == "c.md" && text == "new-c" {
                    return Err(VaultError::Io(io::Error::other("injected write failure")));
                }
                if path == "b.md" && text == "old-b" {
                    fs::write(root.join("b.md"), "external-change").expect("external change");
                }
                doc::write_with_permit(gate, root, path, text, expected_sha, permit)
            },
        )
        .expect("回滚冲突应返回 partial");

        assert_eq!(outcome.status, ReplaceStatus::Partial);
        assert_eq!(outcome.written, ["b.md"]);
        assert_eq!(outcome.restored, ["a.md"]);
        assert_eq!(outcome.rollback_errors.len(), 1);
        assert_eq!(outcome.rollback_errors[0].path, "b.md");
        assert_eq!(outcome.rollback_errors[0].code, "E_INVALID_ARG");
        assert_eq!(
            fs::read_to_string(root.join("b.md")).expect("b"),
            "external-change"
        );
        assert_eq!(fs::read_to_string(root.join("a.md")).expect("a"), "old-a");
    }

    #[test]
    fn rollback_write_failure_returns_partial_with_remaining_new_content() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", "old-a");
        seed(root, "b.md", "old-b");
        seed(root, "c.md", "old-c");
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();

        let outcome = replace_with_writer(
            &gate,
            &journal,
            root,
            three_file_batch(root),
            |gate, root, path, text, expected_sha, permit| {
                if path == "c.md" && text == "new-c" {
                    return Err(VaultError::Io(io::Error::other("injected write failure")));
                }
                if path == "b.md" && text == "old-b" {
                    return Err(VaultError::DiskFull);
                }
                doc::write_with_permit(gate, root, path, text, expected_sha, permit)
            },
        )
        .expect("回滚写失败应返回 partial");

        assert_eq!(outcome.status, ReplaceStatus::Partial);
        assert_eq!(outcome.written, ["b.md"]);
        assert_eq!(outcome.restored, ["a.md"]);
        assert_eq!(outcome.rollback_errors.len(), 1);
        assert_eq!(outcome.rollback_errors[0].path, "b.md");
        assert_eq!(outcome.rollback_errors[0].code, "E_DISK_FULL");
        assert_eq!(fs::read_to_string(root.join("b.md")).expect("b"), "new-b");
        assert_eq!(fs::read_to_string(root.join("a.md")).expect("a"), "old-a");
    }

    #[test]
    fn applied_batch_snapshots_each_original_before_writing() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        let original_a = document(DOC_ID_A, "old-a");
        let original_b = document(DOC_ID_B, "old-b");
        seed(root, "a.md", &original_a);
        seed(root, "b.md", &original_b);
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();
        let items = vec![
            item(root, "a.md", &document(DOC_ID_A, "new-a")),
            item(root, "b.md", &document(DOC_ID_B, "new-b")),
        ];

        let outcome = replace(&gate, &journal, root, items).expect("applied");

        assert_eq!(outcome.status, ReplaceStatus::Applied);
        assert_eq!(outcome.written, ["a.md", "b.md"]);
        assert!(outcome.restored.is_empty());
        assert!(outcome.failure.is_none());
        for (doc_id, original) in [(DOC_ID_A, original_a), (DOC_ID_B, original_b)] {
            let versions = history::list(root, doc_id).expect("history list");
            assert_eq!(versions.len(), 1, "{doc_id} 必须快照一次原文");
            let snapshot = history::read(root, doc_id, &versions[0].version).expect("history read");
            assert_eq!(snapshot.text, original);
        }
    }

    #[test]
    fn batch_and_regular_write_share_one_permit() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root, "a.md", "old-a");
        seed(root, "b.md", "old-b");
        let gate = WriteGate::new(None);
        let journal = WriteJournal::default();
        gate.take_max_in_flight();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (normal_started_tx, normal_started_rx) = mpsc::channel();
        let (normal_done_tx, normal_done_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let batch_gate = &gate;
            let batch_journal = &journal;
            let batch = scope.spawn(move || {
                replace_with_writer(
                    batch_gate,
                    batch_journal,
                    root,
                    vec![item(root, "a.md", "new-a"), item(root, "b.md", "new-b")],
                    |gate, root, path, text, expected_sha, permit| {
                        if path == "a.md" && text == "new-a" {
                            entered_tx.send(()).expect("entered");
                            release_rx.recv().expect("release");
                        }
                        doc::write_with_permit(gate, root, path, text, expected_sha, permit)
                    },
                )
            });
            entered_rx.recv().expect("batch entered");

            let normal_gate = &gate;
            let normal = scope.spawn(move || {
                normal_started_tx.send(()).expect("normal started");
                let result = doc::write(normal_gate, root, "ordinary.md", "ordinary", None);
                normal_done_tx.send(()).expect("normal done");
                result
            });
            normal_started_rx.recv().expect("normal started");
            assert!(
                normal_done_rx
                    .recv_timeout(Duration::from_millis(30))
                    .is_err(),
                "批次持锁期间普通写入不得完成"
            );
            release_tx.send(()).expect("release batch");

            let outcome = batch.join().expect("batch join").expect("batch result");
            assert_eq!(outcome.status, ReplaceStatus::Applied);
            normal.join().expect("normal join").expect("normal write");
        });

        assert_eq!(gate.take_max_in_flight(), 1);
        assert_eq!(
            fs::read_to_string(root.join("ordinary.md")).expect("ordinary"),
            "ordinary"
        );
    }
}
