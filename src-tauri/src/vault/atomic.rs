use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use crate::ipc::{VaultError, VaultResult};

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 写盘结果：字节数与内容哈希（T2 的 stat/冲突判定复用同一算法）。
#[derive(Debug, Clone)]
pub struct WriteResult {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug)]
pub enum CreateNewResult {
    Created(WriteResult),
    AlreadyExists,
}

#[cfg(test)]
thread_local! {
    /// 测试注入的调用顺序日志；不引第三方 Mock，也不改生产分支。
    static FS_OPS: std::cell::RefCell<Vec<&'static str>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn record(op: &'static str) {
    #[cfg(test)]
    FS_OPS.with(|log| log.borrow_mut().push(op));
    #[cfg(not(test))]
    let _ = op;
}

#[cfg(test)]
fn take_ops() -> Vec<&'static str> {
    FS_OPS.with(|log| std::mem::take(&mut *log.borrow_mut()))
}

/// 原子写：temp → fsync(file) → rename → fsync(dir)。
///
/// 任一步失败都清理 temp，原文件保持原样；目标父目录不存在时创建。
pub fn write_atomic(target: &Path, bytes: &[u8]) -> VaultResult<WriteResult> {
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::InvalidArg("目标路径缺少父目录".to_string()))?;
    fs::create_dir_all(parent)?;
    ensure_space(parent, bytes.len() as u64)?;

    let sha256 = hex_sha256(bytes);
    let (temp, mut file) = create_temp_file(parent, &temp_stem(target))?;
    let written = write_temp(&mut file, bytes);
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    record("rename");
    fsync_dir(parent)?;
    Ok(WriteResult {
        bytes: bytes.len() as u64,
        sha256,
    })
}

/// create-only 原子写：同目录 temp 完整落盘后通过 hard_link 发布。
/// 目标已存在（含 symlink）时链接原子失败，返回 `AlreadyExists`，绝不覆盖。
pub fn write_atomic_create_new(target: &Path, bytes: &[u8]) -> VaultResult<CreateNewResult> {
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::InvalidArg("目标路径缺少父目录".to_string()))?;
    fs::create_dir_all(parent)?;
    ensure_space(parent, bytes.len() as u64)?;

    let sha256 = hex_sha256(bytes);
    let (temp, mut file) = create_temp_file(parent, &temp_stem(target))?;
    let written = write_temp(&mut file, bytes);
    drop(file);
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let linked = fs::hard_link(&temp, target);
    let _ = fs::remove_file(&temp);
    match linked {
        Ok(()) => {
            record("link");
            fsync_dir(parent)?;
            Ok(CreateNewResult::Created(WriteResult {
                bytes: bytes.len() as u64,
                sha256,
            }))
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            Ok(CreateNewResult::AlreadyExists)
        }
        Err(error) => Err(error.into()),
    }
}

/// 流式临时写的结果：临时文件路径、字节数与内容哈希。
#[derive(Debug)]
pub(crate) struct TempWrite {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

/// 流式写入临时文件：边读边算 sha256，不把整份内容读进内存。
///
/// 失败时保证清理临时文件；调用方负责在成功后 `publish_temp` 或删除。
pub(crate) fn write_stream_to_temp(dir: &Path, reader: &mut dyn Read) -> VaultResult<TempWrite> {
    fs::create_dir_all(dir)?;
    let (temp, mut file) = create_temp_file(dir, "stream")?;
    let written = stream_into(&mut file, reader);
    drop(file);
    match written {
        Ok((bytes, sha256)) => Ok(TempWrite {
            path: temp,
            bytes,
            sha256,
        }),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error)
        }
    }
}

fn stream_into(file: &mut File, reader: &mut dyn Read) -> VaultResult<(u64, String)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])?;
    }
    file.sync_all()?;
    record("fsync_file");
    Ok((total, hex_digest(hasher.finalize())))
}

/// 把已 fsync 的临时文件发布到目标：rename + 目录 fsync。
/// 调用方负责保证目标不存在（内容寻址路径由 hash 唯一确定）。
pub(crate) fn publish_temp(temp: &Path, target: &Path) -> VaultResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| VaultError::InvalidArg("目标路径缺少父目录".to_string()))?;
    fs::create_dir_all(parent)?;
    fs::rename(temp, target)?;
    record("rename");
    fsync_dir(parent)
}

fn write_temp(file: &mut File, bytes: &[u8]) -> VaultResult<()> {
    file.write_all(bytes)?;
    file.sync_all()?;
    record("fsync_file");
    Ok(())
}

/// 目录 fsync：POSIX 用「打开目录句柄再 sync」。
///
/// Windows 无法以普通句柄打开目录（`CreateFileW` 缺 `FILE_FLAG_BACKUP_SEMANTICS`
/// 会返回 `ERROR_ACCESS_DENIED`，即 os error 5），也没有等价的目录落盘语义，
/// 故在该平台跳过；文件本身的 `sync_all` 与 `rename` 已保证数据先于元数据可见。
pub(crate) fn fsync_dir(dir: &Path) -> VaultResult<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()?;
        record("fsync_dir");
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

/// temp 与目标同目录，保证 rename 在同一文件系统内原子完成。
fn temp_stem(target: &Path) -> String {
    target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".to_string())
}

/// 在 `dir` 下独占创建一个临时文件。
///
/// 使用 `O_CREAT|O_EXCL`：路径已存在（含悬空 symlink）时直接失败，绝不跟随链接写入
/// 库外文件；名字冲突（含被预置）就换名重试，最多 8 次。
pub(crate) fn create_temp_file(dir: &Path, stem: &str) -> VaultResult<(PathBuf, File)> {
    for _ in 0..8 {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let name = format!(".{stem}.tmp-{}-{}-{seq}", std::process::id(), nonce());
        let path = dir.join(name);
        match create_exclusive(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(VaultError::Io(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法创建独占临时文件",
    )))
}

/// `O_CREAT|O_EXCL`：路径已存在（含悬空 symlink）时返回 `AlreadyExists`，绝不跟随链接。
fn create_exclusive(path: &Path) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// 纳秒时间戳：既拉开名字空间，也让预置静态名难以命中（真正的防线是 `O_EXCL`）。
fn nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0)
}

/// 写入前空间预检：余量不足 1 MiB 即拒绝。取不到数值时不阻断写入。
pub(crate) fn ensure_space(dir: &Path, needed: u64) -> VaultResult<()> {
    if let Some(available) = available_bytes(dir) {
        if available < needed.saturating_add(1024 * 1024) {
            return Err(VaultError::DiskFull);
        }
    }
    Ok(())
}

fn available_bytes(dir: &Path) -> Option<u64> {
    let output = std::process::Command::new("df")
        .arg("-k")
        .arg(dir)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    parse_df_kib(&text).map(|kib| kib.saturating_mul(1024))
}

/// `df -k` 第二行第四列是可用 KiB。
fn parse_df_kib(text: &str) -> Option<u64> {
    let line = text.lines().nth(1)?;
    let mut columns = line.split_whitespace();
    columns.next()?;
    columns.next()?;
    columns.next()?;
    columns.next()?.parse().ok()
}

pub(crate) fn hex_sha256(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

/// 文件内容 sha256：流式读取，不把整份文件读进内存（回收站复制复核、T3c 备份复用）。
pub(crate) fn hash_file(path: &Path) -> VaultResult<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(hasher.finalize()))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    let mut out = String::with_capacity(64);
    for byte in digest.as_ref() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn writes_bytes_and_hashes_them() {
        let dir = tempdir().expect("tempdir");
        let target = dir.path().join("a.md");
        let result = write_atomic(&target, b"abc").expect("write");
        assert_eq!(result.bytes, 3);
        assert_eq!(
            result.sha256,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(fs::read(&target).expect("read"), b"abc");
    }

    #[test]
    fn create_new_atomic_never_overwrites_existing_target() {
        let dir = tempdir().expect("tempdir");
        let target = dir.path().join("a.md");
        let CreateNewResult::Created(created) =
            write_atomic_create_new(&target, b"first").expect("create")
        else {
            panic!("首次 create-only 写必须成功");
        };
        assert_eq!(created.bytes, 5);
        assert_eq!(created.sha256, hex_sha256(b"first"));

        let existing =
            write_atomic_create_new(&target, b"second").expect("existing is not io error");
        assert!(matches!(existing, CreateNewResult::AlreadyExists));
        assert_eq!(fs::read(&target).expect("target"), b"first");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|item| item.ok())
            .filter(|item| item.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "竞争失败后不得残留 temp");
    }

    #[test]
    fn fsync_sequence_is_temp_then_rename_then_dir() {
        let _ = take_ops();
        let dir = tempdir().expect("tempdir");
        write_atomic(&dir.path().join("a.md"), b"x").expect("write");
        assert_eq!(take_ops(), vec!["fsync_file", "rename", "fsync_dir"]);
    }

    #[test]
    fn failed_write_keeps_original_and_leaves_no_temp() {
        let dir = tempdir().expect("tempdir");
        let locked = dir.path().join("notes");
        fs::create_dir_all(&locked).expect("notes");
        let target = locked.join("a.md");
        fs::write(&target, b"original").expect("seed");

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o500)).expect("chmod");
        let error = write_atomic(&target, b"new").expect_err("只读目录应失败");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).expect("restore");

        assert_eq!(error.code(), "E_IO");
        assert_eq!(fs::read(&target).expect("read"), b"original");
        let leftovers: Vec<_> = fs::read_dir(&locked)
            .expect("read_dir")
            .filter_map(|item| item.ok())
            .filter(|item| item.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(leftovers.is_empty(), "失败后不得残留 temp");
    }

    struct FailingReader {
        remaining: usize,
    }

    impl Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.remaining == 0 {
                return Err(std::io::Error::other("模拟写盘失败"));
            }
            let filled = buf.len().min(self.remaining);
            buf[..filled].fill(b'x');
            self.remaining -= filled;
            Ok(filled)
        }
    }

    #[test]
    fn stream_write_hashes_and_publishes() {
        let dir = tempdir().expect("tempdir");
        let mut source = std::io::Cursor::new(b"abc".to_vec());
        let temp = write_stream_to_temp(dir.path(), &mut source).expect("stream");
        assert_eq!(temp.bytes, 3);
        assert_eq!(temp.sha256, hex_sha256(b"abc"));

        let target = dir.path().join("ab").join("abc.png");
        publish_temp(&temp.path, &target).expect("publish");
        assert_eq!(fs::read(&target).expect("read"), b"abc");
        assert!(!temp.path.exists(), "发布后临时文件应消失");
    }

    #[test]
    fn stream_write_failure_leaves_no_temp() {
        let dir = tempdir().expect("tempdir");
        let mut source = FailingReader { remaining: 4 };
        let error = write_stream_to_temp(dir.path(), &mut source).expect_err("应失败");
        assert_eq!(error.code(), "E_IO");
        let leftovers: Vec<_> = fs::read_dir(dir.path()).expect("read_dir").collect();
        assert!(leftovers.is_empty(), "失败后不得残留 temp");
    }

    #[test]
    fn df_output_parsing() {
        let sample = "Filesystem   1024-blocks      Used Available Capacity  Mounted on\n/dev/disk3s5  482797652  28746760 452709080     6%  /\n";
        assert_eq!(parse_df_kib(sample), Some(452_709_080));
        assert_eq!(parse_df_kib("garbage"), None);
    }

    /// 预置 symlink 的临时路径必须创建失败，且链接目标一个字节都不能变。
    #[test]
    fn exclusive_create_refuses_preseeded_symlink() {
        let outside = tempdir().expect("outside");
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, b"keep").expect("seed victim");
        let dir = tempdir().expect("tempdir");
        let planted = dir.path().join(".a.md.tmp-planted");
        std::os::unix::fs::symlink(&victim, &planted).expect("symlink");

        let error = create_exclusive(&planted).expect_err("symlink 路径必须失败");
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&victim).expect("victim"), b"keep");
        assert_eq!(
            fs::read_link(&planted).expect("link"),
            victim,
            "失败的创建不得改动既有链接"
        );
    }

    /// 端到端：正式路径是 symlink 时，rename 替换链接本身，不跟随到库外文件。
    #[test]
    fn write_atomic_does_not_follow_target_symlink() {
        let outside = tempdir().expect("outside");
        let victim = outside.path().join("victim.txt");
        fs::write(&victim, b"keep").expect("seed victim");
        let dir = tempdir().expect("tempdir");
        let target = dir.path().join("a.md");
        std::os::unix::fs::symlink(&victim, &target).expect("symlink");

        write_atomic(&target, b"new").expect("write");

        assert_eq!(fs::read(&victim).expect("victim"), b"keep");
        assert_eq!(fs::read(&target).expect("target"), b"new");
        assert!(
            fs::symlink_metadata(&target)
                .expect("metadata")
                .file_type()
                .is_file(),
            "正式路径必须是普通文件"
        );
    }

    /// 临时名彼此不同、都是普通文件；被占用的名字只是换名重试，不写坏既有文件。
    #[test]
    fn temp_names_are_unique_regular_files() {
        let dir = tempdir().expect("tempdir");
        let (first, first_file) = create_temp_file(dir.path(), "a.md").expect("first");
        drop(first_file);
        let (second, second_file) = create_temp_file(dir.path(), "a.md").expect("second");
        drop(second_file);

        assert_ne!(first, second);
        for path in [&first, &second] {
            let metadata = fs::symlink_metadata(path).expect("metadata");
            assert!(metadata.file_type().is_file(), "临时文件必须是普通文件");
            fs::remove_file(path).expect("cleanup");
        }
    }
}
