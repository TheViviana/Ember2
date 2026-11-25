use std::io;
#[cfg(test)]
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use crate::ipc::{ReadonlyReason, VaultError, VaultResult};

/// 写闸门：单写队列 + 只读闩锁。
///
/// 同一库的所有写操作串行化到一条队列，避免并发写互相踩目录 fsync 与临时文件；
/// 只读闩锁一旦点亮，进程内不再解除（重启复位），避免半写状态被"假恢复"掩盖。
pub struct WriteGate {
    queue: Mutex<()>,
    initial: Option<ReadonlyReason>,
    latched: AtomicBool,
    /// 测试注入的并发峰值统计（每个闸门独立，避免并行测试互相污染）。
    #[cfg(test)]
    in_flight: AtomicUsize,
    #[cfg(test)]
    max_in_flight: AtomicUsize,
}

impl WriteGate {
    /// `initial` 是启动时已经确定的只读原因（锁被他人持有等）。
    pub fn new(initial: Option<ReadonlyReason>) -> Self {
        Self {
            queue: Mutex::new(()),
            initial,
            latched: AtomicBool::new(false),
            #[cfg(test)]
            in_flight: AtomicUsize::new(0),
            #[cfg(test)]
            max_in_flight: AtomicUsize::new(0),
        }
    }

    /// 当前只读原因：闩锁优先，`FilesystemReadonly` 覆盖启动时的锁原因。
    pub fn readonly_reason(&self) -> Option<ReadonlyReason> {
        if self.latched.load(Ordering::Acquire) {
            return Some(ReadonlyReason::FilesystemReadonly);
        }
        self.initial
    }

    /// 写路径遇到 EACCES/EROFS 时点亮；幂等。
    pub fn latch_filesystem_readonly(&self) {
        self.latched.store(true, Ordering::Release);
    }

    /// 进入写队列；只读态直接拒绝，不接触磁盘。
    pub fn enter(&self) -> VaultResult<WritePermit<'_>> {
        if self.readonly_reason().is_some() {
            return Err(VaultError::Readonly);
        }
        let guard = self
            .queue
            .lock()
            .map_err(|_| VaultError::Io(io::Error::other("写队列已毒化")))?;
        // 排队期间可能被闩成只读：拿到 permit 前再判一次
        if self.readonly_reason().is_some() {
            return Err(VaultError::Readonly);
        }
        #[cfg(test)]
        self.track_enter();
        Ok(WritePermit {
            _guard: guard,
            #[cfg(test)]
            gate: self,
        })
    }

    /// 非阻塞进入写队列：只读、队列被占用或毒化都返回 `None`。
    ///
    /// 供启动清扫等后台任务使用：拿不到写锁就跳过本轮，绝不排队阻塞。
    pub fn try_enter(&self) -> Option<WritePermit<'_>> {
        if self.readonly_reason().is_some() {
            return None;
        }
        let guard = self.queue.try_lock().ok()?;
        if self.readonly_reason().is_some() {
            return None;
        }
        #[cfg(test)]
        self.track_enter();
        Some(WritePermit {
            _guard: guard,
            #[cfg(test)]
            gate: self,
        })
    }

    #[cfg(test)]
    fn track_enter(&self) {
        let current = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        self.max_in_flight.fetch_max(current, Ordering::AcqRel);
    }

    /// 测试读取并发峰值并归零。
    #[cfg(test)]
    pub(crate) fn take_max_in_flight(&self) -> usize {
        self.max_in_flight.swap(0, Ordering::AcqRel)
    }
}

/// 写许可：存在期间独占写队列，Drop 即释放。
pub struct WritePermit<'a> {
    _guard: MutexGuard<'a, ()>,
    #[cfg(test)]
    gate: &'a WriteGate,
}

impl Drop for WritePermit<'_> {
    fn drop(&mut self) {
        #[cfg(test)]
        self.gate.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}

/// EACCES(13) / EROFS(30)：不是普通 I/O 故障，而是「库所在位置不可写」。
pub fn is_readonly_io(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(13) | Some(30))
}

/// 只读文件系统错误（已转成 `VaultError` 的形态），供启动路径判定。
pub(crate) fn is_readonly_error(error: &VaultError) -> bool {
    matches!(error, VaultError::Io(io_error) if is_readonly_io(io_error))
}

/// 写路径的统一错误映射：只读文件系统 → `E_READONLY` 并点亮闩锁；
/// 其余保持 `From<io::Error>` 的既有映射（ENOSPC → `E_DISK_FULL` 等）。
pub(crate) fn map_write_error(gate: &WriteGate, error: io::Error) -> VaultError {
    if is_readonly_io(&error) {
        gate.latch_filesystem_readonly();
        VaultError::Readonly
    } else {
        error.into()
    }
}

/// 已转成 `VaultError` 的写错误（如 `atomic` 内部）：补只读判定。
pub(crate) fn map_write_result(gate: &WriteGate, error: VaultError) -> VaultError {
    match &error {
        VaultError::Io(io_error) if is_readonly_io(io_error) => {
            gate.latch_filesystem_readonly();
            VaultError::Readonly
        }
        _ => error,
    }
}

/// 测试注入的并发峰值统计；生产构建不产生任何代码。
#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn serializes_concurrent_writers() {
        let gate = WriteGate::new(None);
        std::thread::scope(|scope| {
            for _ in 0..10 {
                scope.spawn(|| {
                    let _permit = gate.enter().expect("可写态应能进入");
                    std::thread::sleep(Duration::from_millis(1));
                });
            }
        });
        assert_eq!(gate.take_max_in_flight(), 1, "写队列必须严格串行");
    }

    #[test]
    fn latched_gate_rejects_immediately() {
        let gate = WriteGate::new(None);
        assert!(gate.readonly_reason().is_none());
        assert!(gate.enter().is_ok());

        gate.latch_filesystem_readonly();
        assert_eq!(
            gate.readonly_reason(),
            Some(ReadonlyReason::FilesystemReadonly)
        );
        let error = match gate.enter() {
            Ok(_) => panic!("闩锁后不得再进入写队列"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "E_READONLY");
    }

    #[test]
    fn initial_lock_reason_blocks_writes() {
        let gate = WriteGate::new(Some(ReadonlyReason::LockedByOther));
        assert_eq!(gate.readonly_reason(), Some(ReadonlyReason::LockedByOther));
        let error = match gate.enter() {
            Ok(_) => panic!("启动即只读时不得进入写队列"),
            Err(error) => error,
        };
        assert_eq!(error.code(), "E_READONLY");
    }

    #[test]
    fn readonly_errno_classification() {
        assert!(is_readonly_io(&io::Error::from_raw_os_error(13)), "EACCES");
        assert!(is_readonly_io(&io::Error::from_raw_os_error(30)), "EROFS");
        assert!(!is_readonly_io(&io::Error::from_raw_os_error(28)), "ENOSPC");
        assert!(!is_readonly_io(&io::Error::from_raw_os_error(2)), "ENOENT");
        assert!(!is_readonly_io(&io::Error::other("boom")));
    }

    #[test]
    fn write_error_mapping_latches_only_for_readonly_errno() {
        let gate = WriteGate::new(None);
        let readonly = map_write_error(&gate, io::Error::from_raw_os_error(30));
        assert_eq!(readonly.code(), "E_READONLY");
        assert_eq!(
            gate.readonly_reason(),
            Some(ReadonlyReason::FilesystemReadonly)
        );

        let fresh = WriteGate::new(None);
        let full = map_write_error(&fresh, io::Error::from_raw_os_error(28));
        assert_eq!(full.code(), "E_DISK_FULL");
        assert!(fresh.readonly_reason().is_none(), "磁盘满不等于只读");
    }
}
