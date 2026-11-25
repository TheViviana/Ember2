//! 多库注册表与热切换（T5b commit 3）。
//!
//! `libraries.json` 落在应用级状态目录，库 id 直接复用 `settings.json` 里的
//! vaultId；切库顺序固定为「新建 Slot → 落盘 → 换 Slot → 显式 retire 旧 Slot」，
//! 旧 Slot 先 drop Session（排空写闸门），再 drop resources（停 watcher、放库锁）。
//!
//! 锁序：先 `libs` 后 `slot`。库表读写只在同步命令体内持锁，不跨 `.await`。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ipc::{ErrorPayload, VaultError, VaultIdentityDto, VaultResult};
use crate::vault::identity::VaultIdentity;
use crate::vault::{
    atomic, build_slot, identity, identity_dto, retire, watch, Session, VaultState,
};

/// 注册表文件名（与应用锁同目录）。
const LIBRARIES_FILE: &str = "libraries.json";

/// 注册表 schema 版本；未知版本按损坏处理并改名备份。
const SCHEMA_VERSION: u32 = 1;

/// 单个已注册库。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) path: String,
}

/// `libraries.json` 的落盘形态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFile {
    schema_version: u32,
    current: Option<String>,
    libraries: Vec<LibraryRecord>,
}

/// `library_list` / `library_add` / `library_remove` 的元素。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryDto {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current: bool,
    pub available: bool,
}

/// `library_current` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryCurrentDto {
    pub library: LibraryDto,
    pub identity: VaultIdentityDto,
}

/// 库注册表；`file` 是 `libraries.json` 的绝对路径。
#[derive(Debug)]
pub struct LibraryIndex {
    file: PathBuf,
    current: Option<String>,
    libraries: Vec<LibraryRecord>,
}

impl LibraryIndex {
    /// 读取注册表。缺失视为空表；损坏或版本不认识时改名 `.bak` 后按空表处理。
    pub fn load(base: PathBuf) -> Self {
        let file = base.join(LIBRARIES_FILE);
        let mut index = Self {
            file,
            current: None,
            libraries: Vec::new(),
        };
        let bytes = match fs::read(&index.file) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return index,
            Err(error) => {
                watch::warn(&format!("libraries.json 读取失败：{error}"));
                return index;
            }
        };
        match serde_json::from_slice::<LibraryFile>(&bytes) {
            Ok(file) if file.schema_version == SCHEMA_VERSION => {
                index.current = file.current;
                index.libraries = file.libraries;
                // current 指向不存在的条目时清空，避免"当前库"悬空。
                if let Some(current) = &index.current {
                    if !index.libraries.iter().any(|record| &record.id == current) {
                        index.current = None;
                    }
                }
            }
            Ok(file) => {
                watch::warn(&format!(
                    "libraries.json schemaVersion={} 不受支持，已备份",
                    file.schema_version
                ));
                index.quarantine();
            }
            Err(error) => {
                watch::warn(&format!("libraries.json 解析失败：{error}"));
                index.quarantine();
            }
        }
        index
    }

    fn quarantine(&mut self) {
        let backup = self.file.with_extension("json.bak");
        if let Err(error) = fs::rename(&self.file, &backup) {
            watch::warn(&format!("损坏的 libraries.json 备份失败：{error}"));
        }
        self.current = None;
        self.libraries.clear();
    }

    fn save(&self) -> VaultResult<()> {
        let file = LibraryFile {
            schema_version: SCHEMA_VERSION,
            current: self.current.clone(),
            libraries: self.libraries.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|error| {
            VaultError::InvalidArg(format!("libraries.json 序列化失败：{error}"))
        })?;
        atomic::write_atomic(&self.file, &bytes)?;
        Ok(())
    }

    fn find(&self, id: &str) -> Option<&LibraryRecord> {
        self.libraries.iter().find(|record| record.id == id)
    }

    pub(crate) fn current_record(&self) -> Option<&LibraryRecord> {
        self.current.as_deref().and_then(|id| self.find(id))
    }

    /// 冲突检查：同路径重复，或与任一已注册库互相嵌套。
    fn ensure_no_conflict(&self, root: &Path) -> VaultResult<()> {
        for record in &self.libraries {
            let existing = Path::new(&record.path);
            if existing == root {
                return Err(VaultError::InvalidArg("该目录已在库列表中".to_string()));
            }
            if root.starts_with(existing) || existing.starts_with(root) {
                return Err(VaultError::InvalidArg("库目录不能互相嵌套".to_string()));
            }
        }
        Ok(())
    }

    /// 启动对账：保证当前会话在表内有条目且 `current` 指向它。
    fn upsert(&mut self, identity: &VaultIdentity, root: &Path) -> bool {
        let path = path_text(root);
        let mut changed = false;
        if let Some(record) = self
            .libraries
            .iter_mut()
            .find(|record| record.id == identity.vault_id)
        {
            if record.path != path {
                record.path = path;
                changed = true;
            }
        } else if let Some(record) = self.libraries.iter_mut().find(|record| record.path == path) {
            if record.id != identity.vault_id {
                record.id = identity.vault_id.clone();
                changed = true;
            }
        } else {
            self.libraries.push(LibraryRecord {
                id: identity.vault_id.clone(),
                name: name_of(root),
                path,
            });
            changed = true;
        }
        if self.current.as_deref() != Some(identity.vault_id.as_str()) {
            self.current = Some(identity.vault_id.clone());
            changed = true;
        }
        changed
    }

    fn dtos(&self) -> Vec<LibraryDto> {
        self.libraries
            .iter()
            .map(|record| self.dto(record))
            .collect()
    }

    fn dto(&self, record: &LibraryRecord) -> LibraryDto {
        LibraryDto {
            id: record.id.clone(),
            name: record.name.clone(),
            path: record.path.clone(),
            current: self.current.as_deref() == Some(record.id.as_str()),
            available: Path::new(&record.path).is_dir(),
        }
    }
}

/// 启动对账：把当前会话写回注册表；写盘失败只告警，不阻塞启动。
pub(crate) fn reconcile(index: &mut LibraryIndex, session: &Session) {
    let Some(identity) = &session.identity else {
        return;
    };
    if !index.upsert(identity, &session.root) {
        return;
    }
    if let Err(error) = index.save() {
        watch::warn(&format!(
            "libraries.json 写入失败：{}",
            ErrorPayload::from(error).message
        ));
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn name_of(root: &Path) -> String {
    root.file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Ember Vault".to_string())
}

/// 库路径必须是已存在的绝对目录，比较与落盘都用规范化路径。
fn canonical_dir(raw: &str) -> Result<PathBuf, ErrorPayload> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(VaultError::InvalidArg("库路径必须是绝对路径".to_string()).into());
    }
    let canonical = match fs::canonicalize(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(VaultError::NotFound.into());
        }
        Err(error) => return Err(VaultError::from(error).into()),
    };
    if !canonical.is_dir() {
        return Err(VaultError::NotFound.into());
    }
    Ok(canonical)
}

#[tauri::command]
pub fn library_list(state: State<'_, VaultState>) -> Result<Vec<LibraryDto>, ErrorPayload> {
    Ok(state.libraries().dtos())
}

#[tauri::command]
pub fn library_add(
    state: State<'_, VaultState>,
    path: String,
    name: Option<String>,
) -> Result<LibraryDto, ErrorPayload> {
    let root = canonical_dir(&path)?;
    let mut index = state.libraries();
    index.ensure_no_conflict(&root)?;
    let identity = identity::ensure_identity(&root)?;
    if index.find(&identity.vault_id).is_some() {
        return Err(VaultError::InvalidArg("该库已注册（vaultId 重复）".to_string()).into());
    }
    let record = LibraryRecord {
        id: identity.vault_id,
        name: name
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| name_of(&root)),
        path: path_text(&root),
    };
    let dto = index.dto(&record);
    index.libraries.push(record);
    if let Err(error) = index.save() {
        index.libraries.pop();
        return Err(error.into());
    }
    Ok(dto)
}

#[tauri::command]
pub fn library_remove(
    state: State<'_, VaultState>,
    id: String,
) -> Result<Vec<LibraryDto>, ErrorPayload> {
    let mut index = state.libraries();
    if index.current.as_deref() == Some(id.as_str()) {
        return Err(VaultError::InvalidArg("不能移除当前库".to_string()).into());
    }
    let position = index
        .libraries
        .iter()
        .position(|record| record.id == id)
        .ok_or_else(|| ErrorPayload::from(VaultError::NotFound))?;
    let removed = index.libraries.remove(position);
    if let Err(error) = index.save() {
        index.libraries.insert(position, removed);
        return Err(error.into());
    }
    Ok(index.dtos())
}

/// 切库：新 Slot 就绪 → 落盘 → 换 Slot → 显式 retire 旧 Slot。
#[tauri::command]
pub fn library_current(
    app: AppHandle,
    state: State<'_, VaultState>,
    id: String,
) -> Result<LibraryCurrentDto, ErrorPayload> {
    let mut index = state.libraries();
    let record = index
        .find(&id)
        .cloned()
        .ok_or_else(|| ErrorPayload::from(VaultError::NotFound))?;
    if index.current.as_deref() == Some(id.as_str()) {
        // 已指向当前库：直接回报，避免对同一目录重复 acquire 被自己判成只读。
        let slot = state.read();
        return Ok(LibraryCurrentDto {
            library: index.dto(&record),
            identity: identity_dto(&slot.session)?,
        });
    }
    let root = PathBuf::from(&record.path);
    if !root.is_dir() {
        return Err(VaultError::NotFound.into());
    }
    let slot = build_slot(&app, root);
    if let Some(failure) = slot.session.failure.clone() {
        retire(slot);
        return Err(failure);
    }
    let identity = match identity_dto(&slot.session) {
        Ok(dto) => dto,
        Err(error) => {
            retire(slot);
            return Err(error);
        }
    };
    let previous = index.current.replace(id.clone());
    if let Err(error) = index.save() {
        index.current = previous;
        retire(slot);
        return Err(error.into());
    }
    drop(index);
    let old = {
        let mut guard = state.write();
        std::mem::replace(&mut *guard, slot)
    };
    retire(old);
    Ok(LibraryCurrentDto {
        library: LibraryDto {
            id: record.id,
            name: record.name,
            path: record.path,
            current: true,
            available: true,
        },
        identity,
    })
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::vault::gate::WriteGate;

    fn record(id: &str, path: &Path) -> LibraryRecord {
        LibraryRecord {
            id: id.to_string(),
            name: name_of(path),
            path: path_text(path),
        }
    }

    #[test]
    fn roundtrip_persists_current_and_records() {
        let base = tempdir().expect("state");
        let vault = tempdir().expect("vault");
        let mut index = LibraryIndex::load(base.path().to_path_buf());
        let record = record("01ARZ3NDEKTSV4RRFFQ69G5FAV", vault.path());
        index.libraries.push(record.clone());
        index.current = Some(record.id.clone());
        index.save().expect("落盘");

        let reloaded = LibraryIndex::load(base.path().to_path_buf());
        assert_eq!(reloaded.current.as_deref(), Some(record.id.as_str()));
        assert_eq!(reloaded.libraries, vec![record]);
    }

    #[test]
    fn corrupt_file_is_quarantined_not_deleted_silently() {
        let base = tempdir().expect("state");
        let file = base.path().join(LIBRARIES_FILE);
        fs::write(&file, b"{not json").expect("seed");
        let index = LibraryIndex::load(base.path().to_path_buf());
        assert!(index.libraries.is_empty());
        assert!(index.current.is_none());
        assert!(!file.exists(), "损坏文件应被移走");
        assert!(
            file.with_extension("json.bak").is_file(),
            "必须留下 .bak 备份"
        );
    }

    #[test]
    fn unknown_schema_version_is_quarantined() {
        let base = tempdir().expect("state");
        let file = base.path().join(LIBRARIES_FILE);
        fs::write(&file, br#"{"schemaVersion":99,"libraries":[]}"#).expect("seed");
        let index = LibraryIndex::load(base.path().to_path_buf());
        assert!(index.libraries.is_empty());
        assert!(file.with_extension("json.bak").is_file());
    }

    #[test]
    fn conflicting_paths_are_rejected() {
        let base = tempdir().expect("state");
        let outer = tempdir().expect("outer");
        let inner = outer.path().join("nested");
        fs::create_dir_all(&inner).expect("nested");
        let mut index = LibraryIndex::load(base.path().to_path_buf());
        index.libraries.push(record("A", outer.path()));

        assert_eq!(
            index
                .ensure_no_conflict(&inner)
                .expect_err("嵌套应拒绝")
                .code(),
            "E_INVALID_ARG"
        );
        assert_eq!(
            index
                .ensure_no_conflict(outer.path())
                .expect_err("重复应拒绝")
                .code(),
            "E_INVALID_ARG"
        );
        let sibling = tempdir().expect("sibling");
        assert!(index.ensure_no_conflict(sibling.path()).is_ok());
    }

    #[test]
    fn upsert_updates_path_and_current() {
        let base = tempdir().expect("state");
        let first = tempdir().expect("first");
        let second = tempdir().expect("second");
        let mut index = LibraryIndex::load(base.path().to_path_buf());
        let identity = VaultIdentity {
            vault_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".to_string(),
            schema_version: 1,
        };

        assert!(index.upsert(&identity, first.path()), "首次必须写回");
        assert!(!index.upsert(&identity, first.path()), "无变化不得写盘");
        assert!(index.upsert(&identity, second.path()), "换路径必须写回");
        assert_eq!(index.libraries.len(), 1, "不得重复登记");
        assert_eq!(index.current.as_deref(), Some(identity.vault_id.as_str()));
    }

    #[test]
    fn dtos_flag_current_and_missing_paths() {
        let base = tempdir().expect("state");
        let present = tempdir().expect("present");
        let mut index = LibraryIndex::load(base.path().to_path_buf());
        index.libraries.push(record("A", present.path()));
        index
            .libraries
            .push(record("B", &present.path().join("gone")));
        index.current = Some("A".to_string());

        let dtos = index.dtos();
        assert!(dtos[0].current && dtos[0].available);
        assert!(!dtos[1].current);
        assert!(!dtos[1].available, "目录不存在应标记不可用");
    }

    #[test]
    fn current_record_is_resolved_from_index() {
        let base = tempdir().expect("state");
        let vault = tempdir().expect("vault");
        let mut index = LibraryIndex::load(base.path().to_path_buf());
        index.libraries.push(record("A", vault.path()));
        index.current = Some("A".to_string());
        assert_eq!(index.current_record().map(|r| r.id.as_str()), Some("A"));
        index.current = Some("missing".to_string());
        assert!(index.current_record().is_none());
    }

    /// 静态断言：报告型 DTO 必须序列化成契约里的 camelCase。
    #[test]
    fn library_dto_is_camel_case() {
        let dto = LibraryDto {
            id: "A".into(),
            name: "库".into(),
            path: "/tmp/a".into(),
            current: true,
            available: true,
        };
        assert_eq!(
            serde_json::to_value(dto).expect("json"),
            serde_json::json!({
                "id": "A",
                "name": "库",
                "path": "/tmp/a",
                "current": true,
                "available": true,
            })
        );
    }

    /// 确认构造测试会话不会触碰真实应用目录。
    #[test]
    fn retire_releases_slot_without_panic() {
        let base = tempdir().expect("state");
        let vault = tempdir().expect("vault");
        let index = LibraryIndex::load(base.path().to_path_buf());
        let identity = identity::ensure_identity(vault.path()).expect("identity");
        let slot = crate::vault::Slot {
            session: Session {
                root: vault.path().to_path_buf(),
                identity: Some(identity),
                gate: WriteGate::new(None),
                failure: None,
                writes: watch::WriteJournal::default(),
            },
            resources: crate::vault::Resources::default(),
        };
        assert!(index.libraries.is_empty());
        retire(slot);
    }
}
