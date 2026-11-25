use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use crate::ipc::{VaultError, VaultResult};
use crate::vault::atomic;
use crate::vault::constants::{MAX_IMAGE_BYTES, MAX_MEDIA_BYTES};
use crate::vault::doc::modified_ms;
use crate::vault::gate::{self, WriteGate};
use crate::vault::paths;

/// 判型读取的前缀长度：足够覆盖 ISO-BMFF 的 brand 列表与常见容器头。
const PREFIX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    Audio,
    Video,
    /// CR-20261120-26：只读附件（PDF/HTML），存 `media/doc/`，不进 Markdown 文档树。
    Doc,
}

impl MediaKind {
    /// 类型分目录（vault-format §4）。
    pub fn dir(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Audio => "audio",
            MediaKind::Video => "video",
            MediaKind::Doc => "doc",
        }
    }

    fn max_bytes(self) -> u64 {
        match self {
            MediaKind::Image => MAX_IMAGE_BYTES,
            // CR-20261120-26：Doc 复用 MAX_MEDIA_BYTES（500 MiB）——PDF 实际远小于此，
            // 上限只是防御；与音视频同级，不静默另立数值。
            MediaKind::Audio | MediaKind::Video | MediaKind::Doc => MAX_MEDIA_BYTES,
        }
    }
}

/// 判型结果：类型 + 规范化扩展名（以内容为准，忽略源文件扩展名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Sniffed {
    pub kind: MediaKind,
    pub ext: &'static str,
}

#[derive(Debug, Clone)]
pub struct SavedMedia {
    pub path: String,
    pub hash: String,
    pub kind: MediaKind,
    pub bytes: u64,
    pub deduped: bool,
}

#[derive(Debug, Clone)]
pub struct MediaEntry {
    pub path: String,
    pub hash: String,
    pub kind: MediaKind,
    pub bytes: u64,
    pub modified_ms: u64,
}

/// 导入媒体：流式复制 + 内容寻址 + 去重。
///
/// 全程不把源文件读进内存；临时文件与最终文件同卷，失败必清理。
pub fn save(gate: &WriteGate, root: &Path, source: &Path) -> VaultResult<SavedMedia> {
    if !source.is_absolute() {
        return Err(VaultError::InvalidArg("媒体源必须是绝对路径".to_string()));
    }
    if gate.readonly_reason().is_some() {
        return Err(VaultError::Readonly);
    }
    let metadata = fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(VaultError::InvalidArg("媒体源必须是普通文件".to_string()));
    }
    let mut file = File::open(source)?;
    let mut prefix = vec![0u8; PREFIX_BYTES];
    let read = file.read(&mut prefix)?;
    let sniffed = sniff(&prefix[..read]).ok_or(VaultError::MediaType)?;
    let max_bytes = sniffed.kind.max_bytes();
    if metadata.len() > max_bytes {
        return Err(VaultError::MediaTooLarge);
    }

    let staging = root.join("media").join(sniffed.kind.dir());
    atomic::ensure_space(&staging, metadata.len())?;
    file.seek(SeekFrom::Start(0))?;
    let mut limited = file.take(max_bytes.saturating_add(1));
    let temp = atomic::write_stream_to_temp(&staging, &mut limited)
        .map_err(|error| gate::map_write_result(gate, error))?;
    if temp.bytes > max_bytes {
        let _ = fs::remove_file(&temp.path);
        return Err(VaultError::MediaTooLarge);
    }

    let hash = temp.sha256.clone();
    let target = staging
        .join(&hash[..2])
        .join(format!("{hash}.{}", sniffed.ext));
    let _permit = match gate.enter() {
        Ok(permit) => permit,
        Err(error) => {
            let _ = fs::remove_file(&temp.path);
            return Err(error);
        }
    };

    if target.exists() {
        if let Err(error) = fs::remove_file(&temp.path) {
            return Err(gate::map_write_error(gate, error));
        }
        return Ok(SavedMedia {
            path: paths::to_rel(root, &target)?,
            hash,
            kind: sniffed.kind,
            bytes: temp.bytes,
            deduped: true,
        });
    }

    if let Err(error) = atomic::publish_temp(&temp.path, &target) {
        let _ = fs::remove_file(&temp.path);
        return Err(gate::map_write_result(gate, error));
    }
    Ok(SavedMedia {
        path: paths::to_rel(root, &target)?,
        hash,
        kind: sniffed.kind,
        bytes: temp.bytes,
        deduped: false,
    })
}

/// 列媒体：类型分目录（`media/image|audio|video`）与旧版平铺 `media/*` 都返回。
pub fn list(root: &Path) -> VaultResult<Vec<MediaEntry>> {
    let media_root = root.join("media");
    let mut entries = Vec::new();
    for (dir, kind) in [
        ("image", MediaKind::Image),
        ("audio", MediaKind::Audio),
        ("video", MediaKind::Video),
        ("doc", MediaKind::Doc),
    ] {
        collect_typed(root, &media_root.join(dir), kind, 0, &mut entries)?;
    }
    collect_legacy(root, &media_root, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(entries)
}

fn collect_typed(
    root: &Path,
    dir: &Path,
    kind: MediaKind,
    depth: u32,
    out: &mut Vec<MediaEntry>,
) -> VaultResult<()> {
    if depth > 2 {
        return Ok(());
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for item in entries {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = item.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            collect_typed(root, &item.path(), kind, depth + 1, out)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let metadata = item.metadata()?;
        out.push(MediaEntry {
            path: paths::to_rel(root, &item.path())?,
            hash: file_stem(&item.path()),
            kind,
            bytes: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }
    Ok(())
}

/// 旧版平铺布局：按 magic bytes 判型，判不出来的一律忽略。
fn collect_legacy(root: &Path, media_root: &Path, out: &mut Vec<MediaEntry>) -> VaultResult<()> {
    let entries = match fs::read_dir(media_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for item in entries {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let file_type = item.file_type()?;
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        let path = item.path();
        let mut file = File::open(&path)?;
        let mut prefix = vec![0u8; PREFIX_BYTES];
        let read = file.read(&mut prefix)?;
        let Some(sniffed) = sniff(&prefix[..read]) else {
            continue;
        };
        let metadata = item.metadata()?;
        out.push(MediaEntry {
            path: paths::to_rel(root, &path)?,
            hash: file_stem(&path),
            kind: sniffed.kind,
            bytes: metadata.len(),
            modified_ms: modified_ms(&metadata),
        });
    }
    Ok(())
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// magic bytes 判型；不认扩展名，SVG 等文本格式一律拒绝。
pub(crate) fn sniff(prefix: &[u8]) -> Option<Sniffed> {
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    if prefix.starts_with(PNG) {
        return Some(Sniffed {
            kind: MediaKind::Image,
            ext: "png",
        });
    }
    if prefix.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(Sniffed {
            kind: MediaKind::Image,
            ext: "jpg",
        });
    }
    if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        return Some(Sniffed {
            kind: MediaKind::Image,
            ext: "gif",
        });
    }
    if prefix.len() >= 12 && &prefix[..4] == b"RIFF" {
        if &prefix[8..12] == b"WEBP" {
            return Some(Sniffed {
                kind: MediaKind::Image,
                ext: "webp",
            });
        }
        if &prefix[8..12] == b"WAVE" {
            return Some(Sniffed {
                kind: MediaKind::Audio,
                ext: "wav",
            });
        }
    }
    if prefix.starts_with(b"fLaC") {
        return Some(Sniffed {
            kind: MediaKind::Audio,
            ext: "flac",
        });
    }
    if prefix.starts_with(b"OggS") {
        return Some(Sniffed {
            kind: MediaKind::Audio,
            ext: "ogg",
        });
    }
    if prefix.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(Sniffed {
            kind: MediaKind::Video,
            ext: "webm",
        });
    }
    if prefix.starts_with(b"ID3")
        || (prefix.len() >= 2 && prefix[0] == 0xFF && (prefix[1] & 0xE0) == 0xE0)
    {
        return Some(Sniffed {
            kind: MediaKind::Audio,
            ext: "mp3",
        });
    }
    // CR-20261120-26：Doc 附件判型（PDF / HTML）。
    if prefix.starts_with(b"%PDF-") {
        return Some(Sniffed {
            kind: MediaKind::Doc,
            ext: "pdf",
        });
    }
    // HTML：忽略 BOM 与前导空白，大小写不敏感匹配 `<!doctype html` / `<html` 开头。
    let probe = if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &prefix[3..]
    } else {
        prefix
    };
    let mut start = 0;
    while start < probe.len() && matches!(probe[start], b' ' | b'\t' | b'\r' | b'\n') {
        start += 1;
    }
    let probe = &probe[start..];
    let head: Vec<u8> = probe
        .iter()
        .take(32)
        .map(|byte| byte.to_ascii_lowercase())
        .collect();
    if head.starts_with(b"<!doctype html") || head.starts_with(b"<html") {
        return Some(Sniffed {
            kind: MediaKind::Doc,
            ext: "html",
        });
    }
    sniff_ftyp(prefix)
}

/// ISO-BMFF 家族：读 `ftyp` box 的 major brand 与兼容 brand 列表。
fn sniff_ftyp(prefix: &[u8]) -> Option<Sniffed> {
    if prefix.len() < 12 || &prefix[4..8] != b"ftyp" {
        return None;
    }
    let mut brands: Vec<&[u8]> = vec![&prefix[8..12]];
    let mut offset = 16;
    while offset + 4 <= prefix.len() {
        brands.push(&prefix[offset..offset + 4]);
        offset += 4;
    }
    for brand in brands {
        if brand == b"avif" || brand == b"avis" {
            return Some(Sniffed {
                kind: MediaKind::Image,
                ext: "avif",
            });
        }
        if brand == b"heic"
            || brand == b"heix"
            || brand == b"hevc"
            || brand == b"hevx"
            || brand == b"mif1"
            || brand == b"msf1"
        {
            return Some(Sniffed {
                kind: MediaKind::Image,
                ext: "heic",
            });
        }
        if brand == b"qt  " {
            return Some(Sniffed {
                kind: MediaKind::Video,
                ext: "mov",
            });
        }
        if brand == b"M4V " || brand == b"M4VH" || brand == b"M4VP" {
            return Some(Sniffed {
                kind: MediaKind::Video,
                ext: "m4v",
            });
        }
        if brand == b"M4A " || brand == b"M4B " {
            return Some(Sniffed {
                kind: MediaKind::Audio,
                ext: "m4a",
            });
        }
        if brand == b"mp41"
            || brand == b"mp42"
            || brand == b"isom"
            || brand == b"iso2"
            || brand == b"iso5"
            || brand == b"iso6"
            || brand == b"avc1"
            || brand == b"dash"
        {
            return Some(Sniffed {
                kind: MediaKind::Video,
                ext: "mp4",
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    #[test]
    fn sniff_detects_doc_attachments() {
        let pdf = b"%PDF-1.7\nrest";
        let sniffed = sniff(&pdf[..]).expect("pdf");
        assert_eq!(sniffed.kind, MediaKind::Doc);
        assert_eq!(sniffed.ext, "pdf");

        let html = b"<!doctype html><html><body>x</body></html>";
        let sniffed = sniff(&html[..]).expect("html doctype");
        assert_eq!(sniffed.kind, MediaKind::Doc);
        assert_eq!(sniffed.ext, "html");

        let upper = b"\n\r\t <!DOCTYPE HTML><html>";
        let sniffed = sniff(&upper[..]).expect("大写 DOCTYPE + 前导空白");
        assert_eq!(sniffed.kind, MediaKind::Doc);
        assert_eq!(sniffed.ext, "html");

        let bom = [0xEF, 0xBB, 0xBF]
            .iter()
            .chain(b"<html>".iter())
            .copied()
            .collect::<Vec<u8>>();
        let sniffed = sniff(&bom).expect("BOM + html");
        assert_eq!(sniffed.kind, MediaKind::Doc);
        assert_eq!(sniffed.ext, "html");

        assert_eq!(sniff(b"plain text file"), None, "非判型内容仍拒绝");
    }

    use tempfile::tempdir;

    use super::*;
    use crate::ipc::ReadonlyReason;

    fn seed(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, bytes).expect("seed");
    }

    fn png_prefix() -> Vec<u8> {
        vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]
    }

    fn ftyp(brand: &[u8; 4]) -> Vec<u8> {
        let mut bytes = vec![0, 0, 0, 0x18, b'f', b't', b'y', b'p'];
        bytes.extend_from_slice(brand);
        bytes.extend_from_slice(&[0, 0, 0, 0]);
        bytes.extend_from_slice(brand);
        bytes
    }

    fn all_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        let Ok(entries) = fs::read_dir(dir) else {
            return out;
        };
        for item in entries.flatten() {
            let path = item.path();
            if path.is_dir() {
                out.extend(all_files(&path));
            } else {
                out.push(path);
            }
        }
        out
    }

    #[test]
    fn sniff_covers_the_whole_whitelist() {
        let cases: Vec<(Vec<u8>, MediaKind, &str)> = vec![
            (png_prefix(), MediaKind::Image, "png"),
            (vec![0xFF, 0xD8, 0xFF, 0xE0], MediaKind::Image, "jpg"),
            (b"GIF89a....".to_vec(), MediaKind::Image, "gif"),
            (
                [b"RIFF".as_slice(), &[0, 0, 0, 0], b"WEBP"].concat(),
                MediaKind::Image,
                "webp",
            ),
            (ftyp(b"avif"), MediaKind::Image, "avif"),
            (ftyp(b"heic"), MediaKind::Image, "heic"),
            (ftyp(b"M4A "), MediaKind::Audio, "m4a"),
            (
                [b"RIFF".as_slice(), &[0, 0, 0, 0], b"WAVE"].concat(),
                MediaKind::Audio,
                "wav",
            ),
            (b"fLaC....".to_vec(), MediaKind::Audio, "flac"),
            (b"OggS....".to_vec(), MediaKind::Audio, "ogg"),
            (b"ID3\x04....".to_vec(), MediaKind::Audio, "mp3"),
            (vec![0xFF, 0xFB, 0x90, 0x64], MediaKind::Audio, "mp3"),
            (ftyp(b"mp42"), MediaKind::Video, "mp4"),
            (ftyp(b"qt  "), MediaKind::Video, "mov"),
            (ftyp(b"M4V "), MediaKind::Video, "m4v"),
            (vec![0x1A, 0x45, 0xDF, 0xA3, 0x01], MediaKind::Video, "webm"),
        ];
        for (prefix, kind, ext) in cases {
            let sniffed = sniff(&prefix).unwrap_or_else(|| panic!("未识别：{prefix:?}"));
            assert_eq!(sniffed.kind, kind, "前缀 {prefix:?}");
            assert_eq!(sniffed.ext, ext, "前缀 {prefix:?}");
        }

        assert!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").is_none());
        assert!(sniff(b"plain text").is_none());
    }

    #[test]
    fn save_streams_hashes_and_dedups() {
        let vault = tempdir().expect("vault");
        let source_dir = tempdir().expect("source");
        let source = source_dir.path().join("photo.PNG");
        let mut bytes = png_prefix();
        bytes.extend(vec![7u8; 4096]);
        fs::write(&source, &bytes).expect("seed source");

        let gate = WriteGate::new(None);
        let first = save(&gate, vault.path(), &source).expect("首次导入");
        assert!(!first.deduped);
        assert_eq!(first.kind, MediaKind::Image);
        assert_eq!(first.bytes, bytes.len() as u64);
        assert_eq!(first.hash, atomic::hex_sha256(&bytes));
        assert_eq!(
            fs::read(vault.path().join(&first.path)).expect("读回"),
            bytes,
            "内容必须与源一致"
        );

        let second = save(&gate, vault.path(), &source).expect("重复导入");
        assert!(second.deduped, "同 hash 必须命中去重");
        assert_eq!(second.path, first.path);
        assert_eq!(second.bytes, first.bytes);

        let files = all_files(vault.path());
        assert_eq!(files.len(), 1, "去重后只应保留一个内容文件：{files:?}");
        assert!(
            files
                .iter()
                .all(|path| !path.to_string_lossy().contains(".stream-")),
            "不得残留临时文件"
        );
    }

    #[test]
    fn save_rejects_svg_and_oversize_without_touching_media() {
        let vault = tempdir().expect("vault");
        let source_dir = tempdir().expect("source");
        let gate = WriteGate::new(None);

        let svg = source_dir.path().join("icon.png");
        fs::write(&svg, b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").expect("svg");
        let error = save(&gate, vault.path(), &svg).expect_err("SVG 应拒绝");
        assert_eq!(error.code(), "E_MEDIA_TYPE");

        let huge = source_dir.path().join("huge.png");
        {
            use std::io::Write;
            let mut file = File::create(&huge).expect("create");
            file.write_all(&png_prefix()).expect("prefix");
            file.set_len(MAX_IMAGE_BYTES + 1).expect("sparse");
        }
        let error = save(&gate, vault.path(), &huge).expect_err("超限应拒绝");
        assert_eq!(error.code(), "E_MEDIA_TOO_LARGE");
        assert!(!vault.path().join("media").exists(), "拒绝时不得建媒体目录");
    }

    #[test]
    fn readonly_gate_blocks_media_save() {
        let vault = tempdir().expect("vault");
        let source_dir = tempdir().expect("source");
        let source = source_dir.path().join("a.png");
        fs::write(&source, png_prefix()).expect("source");

        let gate = WriteGate::new(Some(ReadonlyReason::LockedByOther));
        let error = save(&gate, vault.path(), &source).expect_err("只读应拒绝");
        assert_eq!(error.code(), "E_READONLY");
        assert!(!vault.path().join("media").exists(), "只读不得接触磁盘");
    }

    #[test]
    fn list_returns_typed_and_legacy_entries() {
        let vault = tempdir().expect("vault");
        let root = vault.path();
        let image_bytes = png_prefix();
        let image_hash = atomic::hex_sha256(&image_bytes);
        seed(
            &root.join(format!("media/image/{}/{image_hash}.png", &image_hash[..2])),
            &image_bytes,
        );
        seed(&root.join("media/video/ab/clip.mp4"), &ftyp(b"mp42"));
        let mut webp = Vec::from(b"RIFF");
        webp.extend_from_slice(&[0, 0, 0, 0]);
        webp.extend_from_slice(b"WEBP");
        webp.extend_from_slice(&[0u8; 16]);
        seed(&root.join("media/legacy.webp"), &webp);
        seed(&root.join("media/.hidden.png"), &image_bytes);
        seed(&root.join("media/unknown.bin"), b"not media");
        symlink(
            image_bytes_path(root, &image_hash),
            root.join("media/image/link.png"),
        )
        .expect("symlink");

        let entries = list(root).expect("list");
        let paths: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
        assert_eq!(
            paths,
            vec![
                format!("media/image/{}/{image_hash}.png", &image_hash[..2]),
                "media/legacy.webp".to_string(),
                "media/video/ab/clip.mp4".to_string(),
            ]
        );
        assert_eq!(entries[0].kind, MediaKind::Image);
        assert_eq!(entries[0].hash, image_hash);
        assert_eq!(entries[1].kind, MediaKind::Image);
        assert_eq!(entries[1].hash, "legacy");
        assert_eq!(entries[2].kind, MediaKind::Video);
        assert!(entries.iter().all(|entry| entry.bytes > 0));
    }

    fn image_bytes_path(root: &Path, hash: &str) -> PathBuf {
        root.join(format!("media/image/{}/{hash}.png", &hash[..2]))
    }
}
