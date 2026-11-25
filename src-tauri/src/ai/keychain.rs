//! API Key 存储（CR-20261122-67 §1）：本地文件持久化优先，失败时降级到进程内存。
//!
//! 账号键固定为 `{provider}:v1:{origin}`，换端点或换 provider 都不会串 key。
//! 密钥写入 `<app_support_dir>/ai-keys.json`（全量序列化，热路径读内存缓存），
//! 不再触达系统钥匙串，消除保存 Key 时弹出的系统密码框。
//! 文件条目永久有效（`expiresAt` 为 null/省略即不过期）；落盘失败的降级条目
//! 保留 8 小时 TTL（[`MEMORY_TTL`]），并通过 [`KeyStorage::warning_code`] 暴露
//! `E_AI_KEYCHAIN_DENIED`；密钥本身不写日志、不进错误文案。
//!
//! 删除：内存项必删；落盘失败返回 `E_AI_KEYCHAIN_DENIED`，不假装成功。

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::endpoint::AiEndpoint;
use super::error::{AiError, AiResult, E_AI_KEYCHAIN_DENIED};
use crate::vault::paths;

/// 密钥文件名，落在 `app_support_dir()` 下。
const KEYS_FILE_NAME: &str = "ai-keys.json";

/// 内存降级项的存活时间。
pub const MEMORY_TTL: Duration = Duration::from_secs(8 * 60 * 60);

/// 密钥实际落点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStorage {
    /// 本地文件（持久，重启仍在）。
    File,
    /// 进程内存（仅本次运行有效，落盘失败时降级）。
    Memory,
}

impl KeyStorage {
    /// 需要提示用户的非致命错误码。
    pub fn warning_code(self) -> Option<&'static str> {
        match self {
            Self::File => None,
            Self::Memory => Some(E_AI_KEYCHAIN_DENIED),
        }
    }
}

/// 文件中的条目镜像：`expiresAt` 为 null/省略即永不过期。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    key: String,
    expires_at: Option<u64>,
}

/// 进程内缓存条目。`expires_at` 为 `None` 表示永不过期（文件持久条目）；
/// 为 `Some` 表示内存降级项，到点即丢弃，且不写回文件。
#[derive(Debug, Clone)]
struct Entry {
    key: String,
    expires_at: Option<SystemTime>,
}

impl Entry {
    fn is_expired(&self, now: SystemTime) -> bool {
        self.expires_at
            .is_some_and(|at| now.duration_since(at).is_ok())
    }

    fn to_file_entry(&self) -> FileEntry {
        // 写盘条目一律永久有效；内存 TTL 项只在本次进程内有效，不落盘。
        FileEntry {
            key: self.key.clone(),
            expires_at: None,
        }
    }
}

/// Unix 毫秒转 `SystemTime`；溢出或非法时返回 `None`，调用方按缺失处理。
fn system_time_from_unix_ms(ms: u64) -> Option<SystemTime> {
    UNIX_EPOCH.checked_add(Duration::from_millis(ms))
}

/// 密钥存储。`file_path` 为 `None` 表示构造时目录不可用，降级为纯内存模式。
pub struct KeyStore {
    file_path: Option<PathBuf>,
    cache: Mutex<HashMap<String, Entry>>,
}

impl KeyStore {
    /// 使用应用级目录（`~/Library/Application Support/Ember`）。
    pub fn new() -> Self {
        Self::with_dir(paths::app_support_dir())
    }

    /// 注入目录（测试用临时目录，或未来其他配置）。
    ///
    /// 目录创建成功则进入文件模式并尝试加载已有 JSON；失败则纯内存模式。
    pub fn with_dir(dir: PathBuf) -> Self {
        let file_path = dir.join(KEYS_FILE_NAME);
        match std::fs::create_dir_all(&dir) {
            Ok(()) => {
                // 先加载已有内容，再把路径移入结构体（PathBuf 不可 Copy）。
                let cache = load_file(&file_path).unwrap_or_default();
                Self {
                    file_path: Some(file_path),
                    cache: Mutex::new(cache),
                }
            }
            Err(_) => Self {
                file_path: None,
                cache: Mutex::new(HashMap::new()),
            },
        }
    }

    /// 保存密钥。落盘失败不视为保存失败，而是写入内存并返回 [`KeyStorage::Memory`]。
    pub fn save(&self, provider: &str, endpoint: &AiEndpoint, key: &str) -> AiResult<KeyStorage> {
        let key = key.trim();
        if key.is_empty() {
            return Err(AiError::KeyMissing);
        }
        let account = endpoint.account(provider);
        let now = SystemTime::now();
        if let Some(path) = &self.file_path {
            let persisted = Entry {
                key: key.to_string(),
                expires_at: None,
            };
            // 先在快照上落盘，成功再提交缓存，避免写失败污染缓存里的旧值。
            let mut snapshot = self.cache_lock().clone();
            snapshot.insert(account.clone(), persisted.clone());
            if write_file(path, &snapshot).is_ok() {
                self.cache_lock().insert(account, persisted);
                return Ok(KeyStorage::File);
            }
            // 落盘失败：降级为内存 TTL（不假装已持久化），并清掉同 account 的持久尝试。
            self.cache_lock().insert(
                account,
                Entry {
                    key: key.to_string(),
                    expires_at: Some(now + MEMORY_TTL),
                },
            );
            return Ok(KeyStorage::Memory);
        }
        // 纯内存模式。
        self.cache_lock().insert(
            account,
            Entry {
                key: key.to_string(),
                expires_at: Some(now + MEMORY_TTL),
            },
        );
        Ok(KeyStorage::Memory)
    }

    /// 读取密钥：未过期的缓存项优先，其次直接读文件兜底。
    pub fn load(&self, provider: &str, endpoint: &AiEndpoint) -> AiResult<Option<String>> {
        let account = endpoint.account(provider);
        let now = SystemTime::now();
        {
            let mut cache = self.cache_lock();
            if let Some(entry) = cache.get(&account) {
                if entry.is_expired(now) {
                    cache.remove(&account);
                } else {
                    return Ok(Some(entry.key.clone()));
                }
            }
        }
        // 文件模式下缓存已在构造时加载；这里兜底处理缓存被清空或项过期的情况。
        let Some(path) = &self.file_path else {
            return Ok(None);
        };
        match read_file_key(path, &account, now) {
            Some(key) => {
                self.cache_lock().insert(
                    account,
                    Entry {
                        key: key.clone(),
                        expires_at: None,
                    },
                );
                Ok(Some(key))
            }
            None => Ok(None),
        }
    }

    /// 删除密钥：内存项必清；落盘失败必须如实上报。
    ///
    /// 失败时返回 [`AiError::KeychainDenied`]，由 IPC 层转成 `E_AI_KEYCHAIN_DENIED`，
    /// 免得前端显示「已删除」而旧 Key 仍留在文件里、下次读取复活。
    pub fn delete(&self, provider: &str, endpoint: &AiEndpoint) -> AiResult<()> {
        let account = endpoint.account(provider);
        // 先从缓存移除（清内存）；再拿快照全量写回文件。
        let snapshot = {
            let mut cache = self.cache_lock();
            cache.remove(&account);
            cache.clone()
        };
        let Some(path) = &self.file_path else {
            return Ok(());
        };
        // 删除是幂等的：本来就没有条目时写回不变的文件仍算成功。
        write_file(path, &snapshot).map_err(|_| AiError::KeychainDenied)
    }

    /// 持久化存储（本地文件）是否可用。为 `false` 时密钥只在进程内存里。
    ///
    /// 方法名保留 `keychain_available` 以免破坏 commands.rs 与 DTO 形状；
    /// 语义现为「持久化存储可用」（文件模式），不再指系统钥匙串。
    pub fn keychain_available(&self) -> bool {
        self.file_path.is_some()
    }

    /// 锁中毒只可能来自持锁期间的 panic；继续用残留数据优于再 panic。
    fn cache_lock(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 测试注入：直接放入一条带指定过期时间的内存项。
    #[cfg(test)]
    fn seed_memory(&self, account: &str, key: &str, expires_at: SystemTime) {
        self.cache_lock().insert(
            account.to_string(),
            Entry {
                key: key.to_string(),
                expires_at: Some(expires_at),
            },
        );
    }
}

impl Default for KeyStore {
    fn default() -> Self {
        Self::new()
    }
}

/// 构造时加载已有 JSON；文件不存在或解析失败时返回空表（不阻断启动）。
fn load_file(path: &Path) -> Option<HashMap<String, Entry>> {
    let bytes = std::fs::read(path).ok()?;
    let parsed: HashMap<String, FileEntry> = serde_json::from_slice(&bytes).ok()?;
    let now = SystemTime::now();
    let mut out = HashMap::with_capacity(parsed.len());
    for (account, file_entry) in parsed {
        let expires_at = match file_entry.expires_at {
            None => None,
            Some(ms) => match system_time_from_unix_ms(ms) {
                Some(at) if at > now => Some(at),
                _ => continue,
            },
        };
        out.insert(
            account,
            Entry {
                key: file_entry.key,
                expires_at,
            },
        );
    }
    Some(out)
}

/// `load` 兜底：直接读文件取指定账号的未过期 key。
fn read_file_key(path: &Path, account: &str, now: SystemTime) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let parsed: HashMap<String, FileEntry> = serde_json::from_slice(&bytes).ok()?;
    let entry = parsed.get(account)?;
    match entry.expires_at {
        None => Some(entry.key.clone()),
        Some(ms) => system_time_from_unix_ms(ms)
            .filter(|at| *at > now)
            .map(|_| entry.key.clone()),
    }
}

/// 全量序列化写回：temp + rename，避免崩溃留下半写文件。
/// 只写持久条目（`expires_at == None`），内存 TTL 项不进文件。
fn write_file(path: &Path, cache: &HashMap<String, Entry>) -> std::io::Result<()> {
    let persisted: HashMap<String, FileEntry> = cache
        .iter()
        .filter(|(_, entry)| entry.expires_at.is_none())
        .map(|(account, entry)| (account.clone(), entry.to_file_entry()))
        .collect();
    let json =
        serde_json::to_vec(&persisted).map_err(|error| std::io::Error::other(error.to_string()))?;
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("密钥文件缺少父目录"))?;
    let temp = parent.join(format!(
        ".{KEYS_FILE_NAME}.tmp-{}-{}",
        std::process::id(),
        nonce()
    ));
    let mut file = std::fs::File::create(&temp)?;
    file.write_all(&json)?;
    file.sync_all()?;
    drop(file);
    match std::fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// 纳秒时间戳：拉开临时文件名空间，避免多进程同名冲突。
fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::time::{Duration, SystemTime};

    use tempfile::tempdir;

    use super::*;

    fn endpoint(raw: &str) -> AiEndpoint {
        AiEndpoint::parse(raw, true).expect("测试端点")
    }

    fn store(dir: &tempfile::TempDir) -> KeyStore {
        KeyStore::with_dir(dir.path().to_path_buf())
    }

    #[test]
    fn save_load_delete_roundtrip() {
        let dir = tempdir().expect("tempdir");
        let keys = store(&dir);
        let endpoint = endpoint("https://api.test/v1");
        let storage = keys
            .save("openai-compatible", &endpoint, "sk-test")
            .expect("保存");
        assert_eq!(storage, KeyStorage::File);
        assert!(keys.keychain_available(), "文件模式应可用");
        assert_eq!(
            keys.load("openai-compatible", &endpoint)
                .expect("读取")
                .as_deref(),
            Some("sk-test")
        );
        keys.delete("openai-compatible", &endpoint).expect("删除");
        assert!(keys
            .load("openai-compatible", &endpoint)
            .expect("读取")
            .is_none());
    }

    #[test]
    fn persists_across_keystore_instances() {
        let dir = tempdir().expect("tempdir");
        let endpoint = endpoint("https://api.test/v1");
        let a = store(&dir);
        assert_eq!(
            a.save("openai-compatible", &endpoint, "sk-persist")
                .expect("保存 A"),
            KeyStorage::File
        );
        // 新建 B 实例指向同一文件，应读到 A 写入的 key（重启仍在）。
        let b = store(&dir);
        assert_eq!(
            b.load("openai-compatible", &endpoint)
                .expect("读取 B")
                .as_deref(),
            Some("sk-persist")
        );
    }

    #[test]
    fn empty_key_is_rejected() {
        let dir = tempdir().expect("tempdir");
        let keys = store(&dir);
        let endpoint = endpoint("https://api.test/v1");
        for key in ["", "   ", "\n\t"] {
            let error = keys
                .save("openai-compatible", &endpoint, key)
                .expect_err("空 key 应失败");
            assert_eq!(error.code(), "E_AI_KEY_MISSING");
        }
    }

    #[test]
    fn delete_missing_key_is_idempotent() {
        let dir = tempdir().expect("tempdir");
        let keys = store(&dir);
        let endpoint = endpoint("https://api.test/v1");
        // 从未保存过：删除视为成功，且不报持久化错误。
        keys.delete("openai-compatible", &endpoint)
            .expect("删除不存在的 key 应成功");
        keys.save("openai-compatible", &endpoint, "sk-test")
            .expect("保存");
        keys.delete("openai-compatible", &endpoint).expect("删除");
        keys.delete("openai-compatible", &endpoint)
            .expect("重复删除应成功");
    }

    #[test]
    fn accounts_are_scoped_by_provider_and_origin() {
        let dir = tempdir().expect("tempdir");
        let keys = store(&dir);
        let base = endpoint("https://api.test/v1");
        let other_port = endpoint("https://api.test:8443/v1");
        keys.save("openai-compatible", &base, "key-a")
            .expect("保存 A");
        keys.save("openai-compatible", &other_port, "key-b")
            .expect("保存 B");
        keys.save("ollama", &base, "key-c").expect("保存 C");
        assert_eq!(
            keys.load("openai-compatible", &base).expect("A").as_deref(),
            Some("key-a")
        );
        assert_eq!(
            keys.load("openai-compatible", &other_port)
                .expect("B")
                .as_deref(),
            Some("key-b")
        );
        assert_eq!(
            keys.load("ollama", &base).expect("C").as_deref(),
            Some("key-c")
        );
    }

    #[test]
    fn unwritable_dir_falls_back_to_memory() {
        let dir = tempdir().expect("tempdir");
        std::fs::set_permissions(dir.path(), PermissionsExt::from_mode(0o500)).expect("chmod 只读");
        let keys = KeyStore::with_dir(dir.path().to_path_buf());
        let endpoint = endpoint("https://api.test/v1");
        let storage = keys
            .save("openai-compatible", &endpoint, "sk-memory")
            .expect("降级保存");
        assert_eq!(storage, KeyStorage::Memory);
        assert_eq!(storage.warning_code(), Some(E_AI_KEYCHAIN_DENIED));
        assert_eq!(
            keys.load("openai-compatible", &endpoint)
                .expect("读取")
                .as_deref(),
            Some("sk-memory")
        );
        // 恢复权限以便 tempdir 清理。
        std::fs::set_permissions(dir.path(), PermissionsExt::from_mode(0o700)).expect("恢复权限");
    }

    #[test]
    fn expired_memory_entry_is_dropped() {
        let dir = tempdir().expect("tempdir");
        let keys = store(&dir);
        let endpoint = endpoint("https://api.test/v1");
        let account = endpoint.account("openai-compatible");
        keys.seed_memory(
            &account,
            "stale",
            SystemTime::now() - Duration::from_secs(1),
        );
        assert!(keys
            .load("openai-compatible", &endpoint)
            .expect("读取")
            .is_none());
    }

    #[test]
    fn delete_reports_file_failure_but_still_clears_memory() {
        // 目录从一开始就只读：save 落盘失败降级内存，delete 落盘失败必须上报，
        // 且内存项已清掉（无文件可兜底，load 返回 None）。
        let dir = tempdir().expect("tempdir");
        std::fs::set_permissions(dir.path(), PermissionsExt::from_mode(0o500)).expect("chmod 只读");
        let keys = KeyStore::with_dir(dir.path().to_path_buf());
        let endpoint = endpoint("https://api.test/v1");
        assert_eq!(
            keys.save("openai-compatible", &endpoint, "sk-memory")
                .expect("降级保存"),
            KeyStorage::Memory
        );
        let error = keys
            .delete("openai-compatible", &endpoint)
            .expect_err("删除失败应上报");
        assert_eq!(error.code(), E_AI_KEYCHAIN_DENIED);
        assert!(
            keys.load("openai-compatible", &endpoint)
                .expect("读取")
                .is_none(),
            "内存项必须已清掉，且无文件可兜底复活"
        );
        // 恢复权限以便 tempdir 清理。
        std::fs::set_permissions(dir.path(), PermissionsExt::from_mode(0o700)).expect("恢复权限");
    }
}
