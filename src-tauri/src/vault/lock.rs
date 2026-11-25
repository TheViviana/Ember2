use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::ipc::{ReadonlyReason, VaultResult};
use crate::vault::{atomic, identity, paths};

/// 失效锁认领的重试上限：每轮都是一次独占创建。
const ACQUIRE_ATTEMPTS: usize = 3;

/// 锁载荷（与旧版同格式）：`machineId` 是旧版判活与 Drop 校验的一部分，
/// 缺了它旧版仍能读（未知字段忽略），但新版写入必须带上，双向才能互相识别。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockPayload {
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    pub pid: u32,
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub app: String,
}

pub enum LockState {
    Writable(VaultLock),
    Readonly(ReadonlyReason),
}

/// 持有的库锁；Drop 时只删除自己写入的锁文件。
pub struct VaultLock {
    path: PathBuf,
    pid: u32,
    machine_id: String,
    vault_id: String,
}

impl Drop for VaultLock {
    fn drop(&mut self) {
        // 三要素都要匹配：pid 相同不代表同一把锁（认领后可能被别人重建）。
        if let Ok(bytes) = fs::read(&self.path) {
            if let Ok(payload) = serde_json::from_slice::<LockPayload>(&bytes) {
                if payload.pid == self.pid
                    && payload.machine_id == self.machine_id
                    && payload.vault_id == self.vault_id
                {
                    let _ = fs::remove_file(&self.path);
                }
            }
        }
    }
}

/// 认领副本与新建临时文件的进程内序号：并发线程不能共用同一路径。
static CLAIM_SEQ: AtomicU64 = AtomicU64::new(0);
static CREATE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 同进程内串行化 acquire。
///
/// POSIX 没有「比较并替换目录项」原语：多个线程同时认领同一把失效锁时，
/// 一方可能把另一方刚建立的活锁 rename 走，而硬链接放回又因第三方抢先创建
/// 而失败，留下两个自认可写的持有者。进程内先排成一条队即可消除该窗口；
/// 跨进程仍走 rename 认领协议（与旧版行为一致）。
static ACQUIRE_QUEUE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 获取库锁。`base` 是应用级状态目录（测试注入临时目录，生产传
/// `paths::app_support_dir()`），锁与 `machine-id` 都落在它下面，与旧版同址。
///
/// 语义：独占创建 → 已存在则判活 → pid 存活即只读；pid 已死或载荷损坏则以
/// rename 认领（见 `claim_stale`），绝不先删后建。
pub fn acquire(base: &Path, root: &Path, vault_id: &str) -> VaultResult<LockState> {
    let _serialized = ACQUIRE_QUEUE
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let path = paths::lock_file(base, root);
    fs::create_dir_all(paths::lock_dir(base, root))?;
    let machine_id = machine_id(base)?;

    for _ in 0..ACQUIRE_ATTEMPTS {
        match create(&path, vault_id, &machine_id) {
            Ok(lock) => return Ok(LockState::Writable(lock)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                match probe(&path) {
                    LockProbe::Alive => {
                        return Ok(LockState::Readonly(ReadonlyReason::LockedByOther));
                    }
                    // 判定与认领之间锁被移走：下一轮直接尝试创建
                    LockProbe::Missing => continue,
                    LockProbe::Stale(claimed_bytes) => {
                        match claim_stale(&path, &claimed_bytes, vault_id, &machine_id)? {
                            Claim::Acquired(lock) => return Ok(LockState::Writable(lock)),
                            Claim::Replaced => {
                                return Ok(LockState::Readonly(ReadonlyReason::LockedByOther));
                            }
                            Claim::Contended => continue,
                        }
                    }
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(LockState::Readonly(ReadonlyReason::LockedByOther))
}

enum Claim {
    /// 认领成功并已创建新锁
    Acquired(VaultLock),
    /// 锁在判定后被替换成活锁（已原位放回）
    Replaced,
    /// 认领窗口内被别人抢先（原位空或竞态），可重试
    Contended,
}

/// 原子认领失效锁：rename 到唯一副本 → 字节校验 → 原位独占创建。
///
/// 不能「先删后建」：两步之间别人可以插入一把新锁，无条件删除会误删它，
/// 造成双持有者。
fn claim_stale(
    path: &Path,
    claimed_bytes: &[u8],
    vault_id: &str,
    machine_id: &str,
) -> VaultResult<Claim> {
    let claim = path.with_file_name(format!(
        "lock.claim.{}.{}",
        std::process::id(),
        CLAIM_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    match fs::rename(path, &claim) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Claim::Contended),
        Err(error) => return Err(error.into()),
    }
    // 拿到的必须仍是判定时那份死锁；变了说明期间有人写入了新锁——
    // 硬链接原位放回（目标存在则原子失败，不覆盖新锁），副本丢弃。
    let same = fs::read(&claim)
        .map(|bytes| bytes == claimed_bytes)
        .unwrap_or(false);
    if !same {
        let _ = fs::hard_link(&claim, path);
        let _ = fs::remove_file(&claim);
        return Ok(Claim::Replaced);
    }
    // 原位已空：尝试独占创建
    let created = create(path, vault_id, machine_id);
    let _ = fs::remove_file(&claim);
    match created {
        Ok(lock) => Ok(Claim::Acquired(lock)),
        // 极端并发：验证与创建之间又被别人占了 → 下一轮重读重判
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(Claim::Contended),
        Err(error) => Err(error.into()),
    }
}

/// 建锁：先写完整载荷到同目录临时文件，再 `hard_link` 到锁路径。
///
/// `link(2)` 在目标已存在时原子失败，因此并发者读到的永远是完整载荷，
/// 不会把「刚创建、还没写完」的空文件误判成失效锁而抢走。
fn create(path: &Path, vault_id: &str, machine_id: &str) -> std::io::Result<VaultLock> {
    let pid = std::process::id();
    let payload = LockPayload {
        vault_id: vault_id.to_string(),
        pid,
        machine_id: machine_id.to_string(),
        started_at: identity::now_iso8601(),
        app: env!("CARGO_PKG_NAME").to_string(),
    };
    let bytes = serde_json::to_vec(&payload).map_err(std::io::Error::other)?;
    let temp = path.with_file_name(format!(
        "lock.new.{pid}.{}",
        CREATE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let linked = fs::hard_link(&temp, path);
    let _ = fs::remove_file(&temp);
    linked?;
    Ok(VaultLock {
        path: path.to_path_buf(),
        pid,
        machine_id: machine_id.to_string(),
        vault_id: vault_id.to_string(),
    })
}

enum LockProbe {
    /// 载荷可解析且 pid 存活：锁被占用
    Alive,
    /// 载荷损坏或 pid 已死：崩溃遗留，可认领（携带判定时的字节，认领后校验）
    Stale(Vec<u8>),
    /// 文件已不存在：直接重试创建
    Missing,
}

fn probe(path: &Path) -> LockProbe {
    let bytes = match fs::read(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LockProbe::Missing,
        // 读不出来（权限等）时无法证明已失效，保守视为被占用
        Err(_) => return LockProbe::Alive,
    };
    match serde_json::from_slice::<LockPayload>(&bytes) {
        Ok(payload) if pid_alive(payload.pid) => LockProbe::Alive,
        Ok(_) => LockProbe::Stale(bytes),
        // 半截或损坏的锁文件无法证明持有者存活，按失效处理以恢复可用性
        Err(_) => LockProbe::Stale(bytes),
    }
}

/// pid 探测三态：`Some(true/false)` 是确定结果，`None` 表示命令不可用。
///
/// 路径硬编码 `/bin/kill`：`PATH` 可能被启动环境或用户配置污染，
/// 解析到同名脚本会给出错误结论。
fn pid_state(pid: u32) -> Option<bool> {
    if pid == 0 {
        // `kill -0 0` 探测的是「自己的进程组」，恒成功，不能当存活凭据
        return Some(false);
    }
    std::process::Command::new("/bin/kill")
        .arg("-0")
        .arg(pid.to_string())
        // 吞掉 stderr：死 pid 的探测会把 "No such process" 打进应用日志
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
        .map(|status| status.success())
}

/// 探测不可用时保守视为存活，避免误抢锁造成双写者。
fn alive_from_probe(state: Option<bool>) -> bool {
    state.unwrap_or(true)
}

fn pid_alive(pid: u32) -> bool {
    alive_from_probe(pid_state(pid))
}

/// 机器标识：与旧版共用同一文件（`<base>/machine-id`）。
///
/// 读旧版文件必须 `trim` 后再校验：手工写入或编辑器保存常带换行，
/// 直接校验会判成非法并生成新 ID，导致同一台机器上两版互相不认锁。
pub(crate) fn machine_id(base: &Path) -> VaultResult<String> {
    let file = base.join("machine-id");
    if let Ok(text) = fs::read_to_string(&file) {
        let trimmed = text.trim();
        if trimmed.parse::<Ulid>().is_ok() {
            return Ok(trimmed.to_string());
        }
    }
    fs::create_dir_all(base)?;
    let id = Ulid::generate().to_string();
    atomic::write_atomic(&file, id.as_bytes())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    const VAULT: &str = "vault-a";
    const DEAD_PID: u32 = 999_999_999;

    fn legacy_payload(pid: u32) -> String {
        format!(
            r#"{{"vaultId":"{VAULT}","pid":{pid},"machineId":"01ARZ3NDEKTSV4RRFFQ69G5FAV","startedAt":"2026-01-01T00:00:00Z","app":"0.1.0"}}"#
        )
    }

    /// 旧版格式的锁文件：字段名与顺序都是旧版实际写出的形态。
    fn seed_legacy_lock(base: &Path, root: &Path, pid: u32) {
        fs::create_dir_all(paths::lock_dir(base, root)).expect("lock dir");
        fs::write(paths::lock_file(base, root), legacy_payload(pid)).expect("seed lock");
    }

    #[test]
    fn second_acquire_is_readonly_until_first_drops() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        let first = acquire(base.path(), dir.path(), VAULT).expect("first");
        assert!(matches!(first, LockState::Writable(_)));

        match acquire(base.path(), dir.path(), VAULT).expect("second") {
            LockState::Readonly(reason) => assert_eq!(reason, ReadonlyReason::LockedByOther),
            LockState::Writable(_) => panic!("同一进程二次获取不应同时可写"),
        }

        drop(first);
        assert!(matches!(
            acquire(base.path(), dir.path(), VAULT).expect("third"),
            LockState::Writable(_)
        ));
    }

    #[test]
    fn legacy_lock_with_live_pid_is_readonly_and_untouched() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        let seeded = legacy_payload(std::process::id());
        fs::create_dir_all(paths::lock_dir(base.path(), dir.path())).expect("lock dir");
        fs::write(paths::lock_file(base.path(), dir.path()), &seeded).expect("seed");

        match acquire(base.path(), dir.path(), VAULT).expect("acquire") {
            LockState::Readonly(reason) => assert_eq!(reason, ReadonlyReason::LockedByOther),
            LockState::Writable(_) => panic!("旧版活锁不得被新版抢走"),
        }
        assert_eq!(
            fs::read_to_string(paths::lock_file(base.path(), dir.path())).expect("read"),
            seeded,
            "判定为被占用时不得改写旧版锁文件"
        );
    }

    #[test]
    fn legacy_lock_with_dead_pid_is_claimed() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        seed_legacy_lock(base.path(), dir.path(), DEAD_PID);

        let lock = match acquire(base.path(), dir.path(), VAULT).expect("claim") {
            LockState::Writable(lock) => lock,
            LockState::Readonly(_) => panic!("旧版死锁应被认领"),
        };
        let payload: LockPayload = serde_json::from_slice(
            &fs::read(paths::lock_file(base.path(), dir.path())).expect("read"),
        )
        .expect("new payload");
        assert_eq!(payload.pid, std::process::id());
        assert_eq!(payload.vault_id, VAULT);
        assert_eq!(
            payload.machine_id,
            machine_id(base.path()).expect("machine id")
        );
        drop(lock);
        assert!(!paths::lock_file(base.path(), dir.path()).exists());
    }

    #[test]
    fn ten_threads_claim_stale_lock_and_exactly_one_wins() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        seed_legacy_lock(base.path(), dir.path(), DEAD_PID);
        // 预置机器标识：否则 10 个线程会各自生成一份，最终文件的 machineId
        // 未必等于获胜线程写进锁里的那份，断言会变成随机失败。
        machine_id(base.path()).expect("machine id");
        let base_path = base.path();
        let root = dir.path();
        // 所有线程都拿到自己的结果后才统一断言：Writable 里持有锁，
        // 提前 drop 会让后来者合法拿到写锁。
        let results: Vec<LockState> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..10)
                .map(|_| scope.spawn(|| acquire(base_path, root, VAULT)))
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().expect("线程不应 panic").expect("acquire"))
                .collect()
        });

        let writable = results
            .iter()
            .filter(|state| matches!(state, LockState::Writable(_)))
            .count();
        let readonly = results
            .iter()
            .filter(|state| matches!(state, LockState::Readonly(ReadonlyReason::LockedByOther)))
            .count();
        assert_eq!(writable, 1, "必须有且只有一个线程拿到写锁");
        assert_eq!(readonly, 9, "其余线程必须全部只读");

        // 最终文件必须是完整可解析的锁，而不是被并发认领撕碎的空壳
        let path = paths::lock_file(base_path, root);
        let payload: LockPayload =
            serde_json::from_slice(&fs::read(&path).expect("lock file")).expect("payload");
        assert_eq!(payload.pid, std::process::id());
        assert_eq!(payload.vault_id, VAULT);

        drop(results);
        assert!(!path.exists(), "持有者退出后锁文件必须被清理");
    }

    #[test]
    fn corrupt_lock_is_claimed() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        fs::create_dir_all(paths::lock_dir(base.path(), dir.path())).expect("lock dir");
        fs::write(
            paths::lock_file(base.path(), dir.path()),
            b"garbage-not-json",
        )
        .expect("seed");

        assert!(matches!(
            acquire(base.path(), dir.path(), VAULT).expect("claim"),
            LockState::Writable(_)
        ));
    }

    #[test]
    fn drop_does_not_delete_foreign_lock() {
        let base = tempdir().expect("base");
        let dir = tempdir().expect("root");
        let lock = match acquire(base.path(), dir.path(), VAULT).expect("acquire") {
            LockState::Writable(lock) => lock,
            LockState::Readonly(_) => panic!("首次应为可写"),
        };
        fs::write(paths::lock_file(base.path(), dir.path()), legacy_payload(1)).expect("replace");

        drop(lock);
        assert!(
            paths::lock_file(base.path(), dir.path()).is_file(),
            "不得删除他人锁文件"
        );
    }

    #[test]
    fn machine_id_trims_legacy_whitespace_before_validating() {
        let base = tempdir().expect("base");
        let legacy = "01ARZ3NDEKTSV4RRFFQ69G5FAV\r\n";
        fs::write(base.path().join("machine-id"), legacy).expect("seed");

        let id = machine_id(base.path()).expect("machine id");
        assert_eq!(
            id, "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "读旧版 machine-id 必须先 trim，否则会误判为非法并生成新 ID"
        );
        assert_eq!(
            machine_id(base.path()).expect("again"),
            id,
            "同一文件必须复用"
        );
        assert_eq!(
            fs::read_to_string(base.path().join("machine-id")).expect("read"),
            legacy,
            "复用旧 ID 时不得改写文件"
        );
    }

    #[test]
    fn machine_id_regenerates_only_for_invalid_content() {
        let base = tempdir().expect("base");
        fs::write(base.path().join("machine-id"), "not-a-ulid\n").expect("seed");

        let id = machine_id(base.path()).expect("machine id");
        assert_eq!(id.len(), 26);
        assert!(id.parse::<Ulid>().is_ok());
        assert_eq!(machine_id(base.path()).expect("stable"), id);
    }

    #[test]
    fn pid_probe_uses_absolute_kill_and_conservative_fallback() {
        assert_eq!(
            pid_state(std::process::id()),
            Some(true),
            "自身进程必须探测为存活"
        );
        assert_eq!(
            pid_state(DEAD_PID),
            Some(false),
            "明显不存在的 pid 必须判死"
        );
        assert_eq!(pid_state(0), Some(false), "pid 0 不能当作存活凭据");
        assert!(alive_from_probe(None), "探测命令不可用时必须保守视为存活");
    }
}
