pub mod atomic;
pub mod backup;
pub mod canvas;
pub mod commands;
pub mod conflict;
pub mod constants;
pub mod doc;
pub mod gate;
pub mod history;
pub mod identity;
pub mod import;
pub mod library;
pub mod lock;
#[cfg(target_os = "macos")]
pub mod macos;
pub mod media;
pub mod paths;
pub mod protocol;
pub mod replace;
pub mod scan;
pub mod trash;
pub mod watch;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(test)]
#[path = "tests.rs"]
mod integration_tests;

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};

use tauri::{AppHandle, Emitter, Manager};

use crate::ipc::trash::SweepReportDto;
use crate::ipc::{ErrorPayload, VaultError, VaultIdentityDto, VaultResult};

/// 宿主进程持有的库容器：当前 Slot 可热切换，库表串行化增删。
pub struct VaultState {
    slot: RwLock<Slot>,
    libs: Mutex<library::LibraryIndex>,
}

/// 一个库的会话与其物理资源。
pub struct Slot {
    pub session: Session,
    pub(crate) resources: Resources,
}

/// 会话数据（不含需要按序释放的资源）。
pub struct Session {
    pub root: PathBuf,
    pub identity: Option<identity::VaultIdentity>,
    pub gate: gate::WriteGate,
    pub failure: Option<ErrorPayload>,
    /// 自写登记表：监听线程据此压掉自己的写入回环。
    pub writes: watch::WriteJournal,
}

/// Watcher 与库锁；只在 retire 时按序释放。
#[derive(Default)]
pub(crate) struct Resources {
    watcher: Option<watch::WatchHandle>,
    lock: Option<lock::VaultLock>,
}

impl VaultState {
    /// 读当前 Slot。锁中毒只可能来自持有期间的 panic，这里按继续用处理。
    pub fn read(&self) -> RwLockReadGuard<'_, Slot> {
        self.slot
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn write(&self) -> RwLockWriteGuard<'_, Slot> {
        self.slot
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 库表的独占访问；锁序固定为 `libs → slot`。
    pub(crate) fn libraries(&self) -> MutexGuard<'_, library::LibraryIndex> {
        self.libs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `media://` 协议用：每次请求读当前库根，切库后立即生效。
    pub fn current_root(&self) -> PathBuf {
        self.read().session.root.clone()
    }
}

/// 默认库位置：`~/Documents/EmberVault`。
fn default_root(app: &AppHandle) -> VaultResult<PathBuf> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| VaultError::Io(std::io::Error::other(error.to_string())))?;
    Ok(documents.join("EmberVault"))
}

/// 启动时装配会话：优先恢复注册表里的当前库；失败不 panic，转成可上报的 failure。
pub fn bootstrap(app: &AppHandle) -> VaultState {
    let mut index = library::LibraryIndex::load(paths::app_support_dir());
    let slot = match index.current_record().cloned() {
        Some(record) => {
            let root = PathBuf::from(&record.path);
            if root.is_dir() {
                build_slot(app, root)
            } else {
                // 当前库被移走 / 外置盘未挂载：保持失败态，等用户切库。
                failed_slot(
                    root,
                    watch::WriteJournal::default(),
                    VaultError::NotFound.into(),
                )
            }
        }
        None => match default_root(app) {
            Ok(root) => build_slot(app, root),
            Err(error) => failed_slot(PathBuf::new(), watch::WriteJournal::default(), error.into()),
        },
    };
    library::reconcile(&mut index, &slot.session);
    VaultState {
        slot: RwLock::new(slot),
        libs: Mutex::new(index),
    }
}

/// 装配一个新 Slot：身份 → 库锁 → 监听。监听失败只上报，不影响库可用性。
pub(crate) fn build_slot(app: &AppHandle, root: PathBuf) -> Slot {
    let writes = watch::WriteJournal::default();
    let identity = match identity::ensure_identity(&root) {
        Ok(value) => value,
        Err(error) => return failed_slot(root, writes, error.into()),
    };
    let (gate, guard, failure) =
        match lock::acquire(&paths::app_support_dir(), &root, &identity.vault_id) {
            Ok(lock::LockState::Writable(guard)) => (gate::WriteGate::new(None), Some(guard), None),
            Ok(lock::LockState::Readonly(reason)) => {
                (gate::WriteGate::new(Some(reason)), None, None)
            }
            Err(error) => {
                let gate = gate::WriteGate::new(None);
                if gate::is_readonly_error(&error) {
                    gate.latch_filesystem_readonly();
                }
                (gate, None, Some(error.into()))
            }
        };
    let watcher = if failure.is_some() {
        None
    } else {
        match watch::spawn(app, root.clone(), writes.clone()) {
            Ok(handle) => Some(handle),
            Err(error) => {
                let payload = ErrorPayload::from(error);
                watch::warn(&format!("启动失败：{}", payload.message));
                if let Err(error) = app.emit(watch::WATCH_ERROR_EVENT, payload) {
                    watch::warn(&format!("watch-error 上报失败：{error}"));
                }
                None
            }
        }
    };
    Slot {
        session: Session {
            root,
            identity: Some(identity),
            gate,
            failure,
            writes,
        },
        resources: Resources {
            watcher,
            lock: guard,
        },
    }
}

fn failed_slot(root: PathBuf, writes: watch::WriteJournal, failure: ErrorPayload) -> Slot {
    Slot {
        session: Session {
            root,
            identity: None,
            gate: gate::WriteGate::new(None),
            failure: Some(failure),
            writes,
        },
        resources: Resources::default(),
    }
}

/// 显式拆解旧 Slot：先 drop Session（排空写闸门），再 drop resources
/// （停 watcher、放库锁）。顺序不能交给字段隐式析构，否则 macOS 下锁文件
/// 可能残留，重启后旧库仍显示被占用。
pub(crate) fn retire(slot: Slot) {
    let Slot { session, resources } = slot;
    drop(session);
    let Resources { watcher, lock } = resources;
    drop(watcher);
    drop(lock);
}

/// 启动时一次后台清扫（PLAN.md §9.6）：`std::thread::spawn` 脱离主线程，
/// 失败只上报不阻塞启动；只读或写队列被占用时直接跳过。
pub fn spawn_trash_sweep(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<VaultState>();
        let slot = state.read();
        let session = &slot.session;
        if let Some(failure) = &session.failure {
            trash::warn(&format!(
                "skippedReadonly：会话不可用（{}），跳过本次清扫",
                failure.code
            ));
            return;
        }
        let report = trash::sweep(
            &session.gate,
            &session.root,
            constants::TRASH_RETENTION_DAYS,
            std::time::SystemTime::now(),
        );
        trash::warn(&format!(
            "清扫完成：扫描 {}，删除 {}，失败 {}，跳过 {:?}",
            report.scanned,
            report.removed.len(),
            report.errors.len(),
            report.skipped
        ));
        if let Err(error) = app.emit(trash::SWEEP_EVENT, SweepReportDto::from(report)) {
            trash::warn(&format!("清扫事件上报失败：{error}"));
        }
    });
}

pub(crate) fn identity_dto(session: &Session) -> Result<VaultIdentityDto, ErrorPayload> {
    if let Some(failure) = &session.failure {
        return Err(failure.clone());
    }
    let identity = session
        .identity
        .as_ref()
        .ok_or_else(|| ErrorPayload::from(VaultError::NotFound))?;
    let readonly = session.gate.readonly_reason();
    Ok(VaultIdentityDto {
        vault_id: identity.vault_id.clone(),
        root: session.root.to_string_lossy().to_string(),
        schema_version: identity.schema_version,
        readonly: readonly.is_some(),
        readonly_reason: readonly,
    })
}

#[cfg(test)]
pub(crate) fn test_state(root: PathBuf, gate: gate::WriteGate) -> VaultState {
    let identity = identity::ensure_identity(&root).expect("identity");
    VaultState {
        slot: RwLock::new(Slot {
            session: Session {
                root: root.clone(),
                identity: Some(identity),
                gate,
                failure: None,
                writes: watch::WriteJournal::default(),
            },
            resources: Resources::default(),
        }),
        libs: Mutex::new(library::LibraryIndex::load(root.join(".ember-test-state"))),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::ipc::ReadonlyReason;

    fn session(root: PathBuf) -> VaultState {
        test_state(root, gate::WriteGate::new(None))
    }

    #[test]
    fn identity_dto_is_camel_case() {
        let dir = tempdir().expect("tempdir");
        let state = session(dir.path().to_path_buf());
        let dto = identity_dto(&state.read().session).expect("dto");
        let value = serde_json::to_value(&dto).expect("json");
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["readonly"], false);
        assert!(
            value.get("readonlyReason").is_none(),
            "可写态不应带只读原因"
        );
        assert_eq!(value["vaultId"].as_str().expect("vaultId").len(), 26);
    }

    #[test]
    fn readonly_reason_is_reported() {
        let dir = tempdir().expect("tempdir");
        let state = test_state(
            dir.path().to_path_buf(),
            gate::WriteGate::new(Some(ReadonlyReason::LockedByOther)),
        );
        let dto = identity_dto(&state.read().session).expect("dto");
        assert!(dto.readonly);
        assert_eq!(dto.readonly_reason, Some(ReadonlyReason::LockedByOther));
    }

    #[test]
    fn filesystem_readonly_latch_is_reported() {
        let dir = tempdir().expect("tempdir");
        let state = session(dir.path().to_path_buf());
        state.read().session.gate.latch_filesystem_readonly();
        let dto = identity_dto(&state.read().session).expect("dto");
        assert!(dto.readonly);
        assert_eq!(
            dto.readonly_reason,
            Some(ReadonlyReason::FilesystemReadonly)
        );
    }
}
