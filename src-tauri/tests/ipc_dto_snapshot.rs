//! IPC DTO 快照：`src/types/ipc.ts` 与 Rust `*Dto` 字段级一致性的锚点（ADR 0003 决策一）。
//!
//! 每个 DTO 用「完整结构体字面量」构造样本：Rust 新增字段时这里编译失败，这是强制的同步点。
//! 序列化结果与 `tests/fixtures/ipc/<Name>.json` 比对；TS 侧 `tests/contract/ipc-dto.test.ts`
//! 读同一批快照并做双侧键集合校验，两侧同时通过才放行。
//!
//! 更新快照（仅在三侧字段都同步改完后执行）：
//!
//! ```text
//! UPDATE_IPC_SNAPSHOTS=1 cargo test --test ipc_dto_snapshot
//! ```

use std::fs;
use std::path::{Path, PathBuf};

use ember_lib::ipc::conflict::ConflictCopyDto;
use ember_lib::ipc::doc::{
    DirEntryDto, EntryKindDto, ReadDocDto, ScanDocDto, StatDto, WriteDocDto,
};
use ember_lib::ipc::trash::{TrashResultDto, TrashViaDto};
use ember_lib::ipc::watch::{FileChangeDto, FileChangeKindDto, FileChangedDto};
use ember_lib::ipc::{ErrorPayload, ReadonlyReason, VaultConstantsDto, VaultIdentityDto};
use serde::Serialize;
use serde_json::Value;

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const MODIFIED_MS: u64 = 1_763_000_000_000;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("ipc")
}

/// 序列化样本并与快照比对；`UPDATE_IPC_SNAPSHOTS=1` 时改为写入快照。
fn snapshot(name: &str, sample: impl Serialize) {
    let actual = serde_json::to_value(sample).expect("DTO 序列化失败");
    let path = fixtures_dir().join(format!("{name}.json"));
    if std::env::var("UPDATE_IPC_SNAPSHOTS").as_deref() == Ok("1") {
        fs::create_dir_all(fixtures_dir()).expect("创建快照目录失败");
        let mut text = serde_json::to_string_pretty(&actual).expect("快照格式化失败");
        text.push('\n');
        fs::write(&path, text).expect("写入快照失败");
        return;
    }
    let expected_text = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "读不到快照 {}：{error}；先运行 UPDATE_IPC_SNAPSHOTS=1 cargo test --test ipc_dto_snapshot",
            path.display()
        )
    });
    let expected: Value = serde_json::from_str(&expected_text).expect("快照不是合法 JSON");
    assert_eq!(actual, expected, "{name} 的 Rust 序列化结果与快照不一致");
}

#[test]
fn vault_identity_dto() {
    snapshot(
        "VaultIdentityDto",
        VaultIdentityDto {
            vault_id: "01J8Z9K3Q7V5N2M4X6C8B0D1F2".to_string(),
            root: "/Users/zero/EmberVault".to_string(),
            schema_version: 2,
            readonly: false,
            readonly_reason: Some(ReadonlyReason::FilesystemReadonly),
        },
    );
}

#[test]
fn vault_constants_dto() {
    snapshot(
        "VaultConstantsDto",
        VaultConstantsDto {
            max_doc_bytes: 16_777_216,
            max_image_bytes: 33_554_432,
            max_media_bytes: 209_715_200,
            history_keep: 50,
            history_budget_bytes: 52_428_800,
            trash_retention_days: 7,
            watcher_debounce_ms: 200,
            max_scan_depth: 32,
        },
    );
}

#[test]
fn read_doc_dto() {
    snapshot(
        "ReadDocDto",
        ReadDocDto {
            path: "documents/note.md".to_string(),
            text: "# 标题\n正文\n".to_string(),
            bytes: 24,
            sha256: SHA.to_string(),
            modified_ms: MODIFIED_MS,
        },
    );
}

#[test]
fn write_doc_dto() {
    snapshot(
        "WriteDocDto",
        WriteDocDto {
            path: "documents/note.md".to_string(),
            bytes: 24,
            sha256: SHA.to_string(),
        },
    );
}

#[test]
fn conflict_copy_dto() {
    snapshot(
        "ConflictCopyDto",
        ConflictCopyDto {
            path: ".workbench/conflicts/documents/note.conflict-20261127-101530-123.md".to_string(),
            bytes: 24,
            sha256: SHA.to_string(),
        },
    );
}

#[test]
fn stat_dto() {
    snapshot(
        "StatDto",
        StatDto {
            path: "documents/note.md".to_string(),
            bytes: 24,
            sha256: SHA.to_string(),
            modified_ms: MODIFIED_MS,
        },
    );
}

#[test]
fn dir_entry_dto() {
    snapshot(
        "DirEntryDto",
        DirEntryDto {
            name: "note.md".to_string(),
            path: "documents/note.md".to_string(),
            kind: EntryKindDto::File,
            bytes: 24,
            modified_ms: MODIFIED_MS,
        },
    );
}

#[test]
fn scan_doc_dto() {
    snapshot(
        "ScanDocDto",
        ScanDocDto {
            path: "documents/note.md".to_string(),
            bytes: 24,
            sha256: SHA.to_string(),
            modified_ms: MODIFIED_MS,
        },
    );
}

#[test]
fn trash_result_dto() {
    snapshot(
        "TrashResultDto",
        TrashResultDto {
            via: TrashViaDto::Workbench,
            trash_id: "01J8Z9K3Q7V5N2M4X6C8B0D1F2".to_string(),
        },
    );
}

#[test]
fn file_changed_dto() {
    snapshot(
        "FileChangedDto",
        FileChangedDto {
            changes: vec![
                FileChangeDto {
                    kind: FileChangeKindDto::Renamed,
                    path: "documents/b.md".to_string(),
                    from: Some("documents/a.md".to_string()),
                    bytes: Some(24),
                    sha256: Some(SHA.to_string()),
                    modified_ms: Some(MODIFIED_MS),
                },
                FileChangeDto {
                    kind: FileChangeKindDto::Removed,
                    path: "documents/c.md".to_string(),
                    from: None,
                    bytes: None,
                    sha256: None,
                    modified_ms: None,
                },
            ],
        },
    );
}

#[test]
fn watch_error_payload() {
    snapshot(
        "WatchErrorPayload",
        ErrorPayload {
            code: "E_IO",
            message: "I/O 失败：permission denied".to_string(),
        },
    );
}
