//! `media://` 只读协议：仅暴露库内 `media/`，支持单段 Range。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Request, Response, StatusCode};

use crate::vault::constants::MAX_IMAGE_BYTES;
use crate::vault::paths;

/// 单次响应内存上限：图片最大 20 MiB，可整份返回；音视频超过时按分段返回。
const RESPONSE_CAP: u64 = MAX_IMAGE_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RangeSpec {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

/// 处理一次 `media://localhost/<相对路径>` 请求。
pub fn respond(root: &Path, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    respond_with_cap(root, request, RESPONSE_CAP)
}

fn respond_with_cap(root: &Path, request: &Request<Vec<u8>>, cap: u64) -> Response<Vec<u8>> {
    if request.method() != tauri::http::Method::GET && request.method() != tauri::http::Method::HEAD
    {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let raw = request.uri().path().trim_start_matches('/');
    let Some(rel) = percent_decode(raw) else {
        return empty(StatusCode::BAD_REQUEST);
    };
    if !rel.starts_with("media/") {
        return empty(StatusCode::FORBIDDEN);
    }
    let path = match paths::resolve(root, &rel) {
        Ok(path) => path,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    if !metadata.file_type().is_file() {
        return empty(StatusCode::NOT_FOUND);
    }
    let len = metadata.len();
    let range = parse_range(
        request
            .headers()
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        len,
        cap,
    );
    let (status, start, end) = match range {
        RangeSpec::Unsatisfiable => return unsatisfiable(len),
        RangeSpec::Full => {
            if len > cap {
                (StatusCode::PARTIAL_CONTENT, 0, cap.saturating_sub(1))
            } else {
                (StatusCode::OK, 0, len.saturating_sub(1))
            }
        }
        RangeSpec::Partial { start, end } => (StatusCode::PARTIAL_CONTENT, start, end),
    };
    let length = if len == 0 { 0 } else { end - start + 1 };
    let body = if request.method() == tauri::http::Method::HEAD {
        Vec::new()
    } else {
        match read_range(&path, start, length) {
            Ok(bytes) => bytes,
            Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
        }
    };
    let content_type_value = content_type(&path);
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type_value)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string());
    // CR-20261120-26：HTML 附件双保险——nosniff + 沙箱 CSP（无脚本/无外链/无表单）。
    if content_type_value.starts_with("text/html") {
        builder = builder
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .header(
                header::CONTENT_SECURITY_POLICY,
                "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src media: data:",
            );
    }
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    builder
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn read_range(path: &Path, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut out = Vec::new();
    file.take(length).read_to_end(&mut out)?;
    Ok(out)
}

/// 单段 Range 解析；多段或畸形头按整份处理（RFC 允许忽略）。
pub(crate) fn parse_range(value: Option<&str>, len: u64, cap: u64) -> RangeSpec {
    let Some(value) = value else {
        return RangeSpec::Full;
    };
    let Some(spec) = value.strip_prefix("bytes=") else {
        return RangeSpec::Full;
    };
    if spec.contains(',') {
        return RangeSpec::Full;
    }
    let Some((left, right)) = spec.split_once('-') else {
        return RangeSpec::Full;
    };
    let cap = cap.max(1);
    if left.is_empty() {
        let Ok(suffix) = right.parse::<u64>() else {
            return RangeSpec::Full;
        };
        if suffix == 0 || len == 0 {
            return RangeSpec::Unsatisfiable;
        }
        let start = len.saturating_sub(suffix);
        return RangeSpec::Partial {
            start,
            end: (start + cap - 1).min(len - 1),
        };
    }
    let Ok(start) = left.parse::<u64>() else {
        return RangeSpec::Full;
    };
    if len == 0 || start >= len {
        return RangeSpec::Unsatisfiable;
    }
    let end = if right.is_empty() {
        len - 1
    } else {
        match right.parse::<u64>() {
            Ok(end) if end >= start => end.min(len - 1),
            Ok(_) => return RangeSpec::Full,
            Err(_) => return RangeSpec::Full,
        }
    };
    RangeSpec::Partial {
        start,
        end: end.min(start + cap - 1),
    }
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return None;
            }
            let high = hex_value(bytes[index + 1])?;
            let low = hex_value(bytes[index + 2])?;
            let decoded = high * 16 + low;
            if decoded == 0 {
                return None;
            }
            out.push(decoded);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("heic") | Some("heif") => "image/heic",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        Some("webm") => "video/webm",
        Some("pdf") => "application/pdf",
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn unsatisfiable(len: u64) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
        .body(Vec::new())
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use tauri::http::Method;
    use tempfile::tempdir;

    use super::*;

    fn seed(path: impl AsRef<Path>, bytes: &[u8]) {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent");
        }
        fs::write(path, bytes).expect("seed");
    }

    fn request(uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(value) = range {
            builder = builder.header(header::RANGE, value);
        }
        builder.body(Vec::new()).expect("request")
    }

    #[test]
    fn range_parser_handles_common_forms() {
        assert_eq!(parse_range(None, 10, 8), RangeSpec::Full);
        assert_eq!(
            parse_range(Some("bytes=0-3"), 10, 8),
            RangeSpec::Partial { start: 0, end: 3 }
        );
        assert_eq!(
            parse_range(Some("bytes=4-"), 10, 8),
            RangeSpec::Partial { start: 4, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=-2"), 10, 8),
            RangeSpec::Partial { start: 8, end: 9 }
        );
        assert_eq!(
            parse_range(Some("bytes=10-20"), 10, 8),
            RangeSpec::Unsatisfiable
        );
        assert_eq!(parse_range(Some("items=0-1"), 10, 8), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=0-1,3-4"), 10, 8), RangeSpec::Full);
        assert_eq!(parse_range(Some("bytes=5-2"), 10, 8), RangeSpec::Full);
        assert_eq!(
            parse_range(Some("bytes=0-99"), 100, 8),
            RangeSpec::Partial { start: 0, end: 7 },
            "单次响应必须按 cap 收窄"
        );
    }

    #[test]
    fn protocol_serves_media_and_rejects_escapes() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root.join("media/image/ab/cat.png"), b"0123456789");
        seed(root.join("secret.md"), b"top secret");

        let full = respond(
            root,
            &request("media://localhost/media/image/ab/cat.png", None),
        );
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body(), b"0123456789");
        assert_eq!(full.headers()[header::ACCEPT_RANGES], "bytes");

        let ranged = respond(
            root,
            &request(
                "media://localhost/media/image/ab/cat.png",
                Some("bytes=2-4"),
            ),
        );
        assert_eq!(ranged.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(ranged.body(), b"234");
        assert_eq!(ranged.headers()[header::CONTENT_RANGE], "bytes 2-4/10");

        let escaped = respond(root, &request("media://localhost/secret.md", None));
        assert_eq!(escaped.status(), StatusCode::FORBIDDEN);

        let traversal = respond(
            root,
            &request("media://localhost/media/..%2Fsecret.md", None),
        );
        assert_ne!(traversal.status(), StatusCode::OK);
        assert!(traversal.body().is_empty());

        symlink(root.join("secret.md"), root.join("media/link.md")).expect("symlink");
        let linked = respond(root, &request("media://localhost/media/link.md", None));
        assert_eq!(linked.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn large_body_is_clamped_to_one_chunk() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root.join("media/video/ab/clip.mp4"), &[7u8; 32]);

        let capped = respond_with_cap(
            root,
            &request("media://localhost/media/video/ab/clip.mp4", None),
            8,
        );
        assert_eq!(capped.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(capped.body(), &[7u8; 8]);
        assert_eq!(capped.headers()[header::CONTENT_RANGE], "bytes 0-7/32");
    }

    #[test]
    fn percent_decoding_and_content_type() {
        let dir = tempdir().expect("root");
        let root = dir.path();
        seed(root.join("media/旧 图.png"), b"png");
        let ok = respond(
            root,
            &request("media://localhost/media/%E6%97%A7%20%E5%9B%BE.png", None),
        );
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(percent_decode("%zz"), None);
    }
    // CR-24 C3（提示词 A 三）：无 Range 头 + 超 cap 文件 → 合法 206 且带 Content-Range，
    // 总长正确（自洽性回归钉）。
    #[test]
    fn full_response_over_cap_is_valid_partial_with_content_range() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        seed(root.join("media/video/big.mp4"), &[0u8; 100]);
        let response = respond_with_cap(
            root,
            &request("media://localhost/media/video/big.mp4", None),
            10,
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let content_range = response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .expect("超 cap 的 206 必须带 Content-Range");
        assert_eq!(content_range, "bytes 0-9/100");
        assert_eq!(
            response
                .headers()
                .get(header::CONTENT_LENGTH)
                .and_then(|value| value.to_str().ok()),
            Some("10")
        );
        assert_eq!(response.body().len(), 10);
    }
    // CR-20261120-26：HTML 附件必须带 nosniff + 沙箱 CSP（与 pdf 的 application/pdf 同批验证）。
    #[test]
    fn html_response_carries_security_headers_and_pdf_content_type() {
        let dir = tempdir().expect("tempdir");
        let root = dir.path();
        seed(
            root.join("media/doc/page.html"),
            b"<html><body>ok</body></html>",
        );
        seed(root.join("media/doc/report.pdf"), b"%PDF-1.7 rest");
        let html_response = respond(
            root,
            &request("media://localhost/media/doc/page.html", None),
        );
        assert_eq!(html_response.status(), StatusCode::OK);
        assert_eq!(
            html_response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("text/html; charset=utf-8")
        );
        assert_eq!(
            html_response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .and_then(|value| value.to_str().ok()),
            Some("nosniff")
        );
        let csp = html_response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|value| value.to_str().ok())
            .expect("html 必须带 sandbox CSP");
        assert!(csp.starts_with("sandbox;"), "CSP 必须是沙箱形态：{csp}");
        let pdf_response = respond(
            root,
            &request("media://localhost/media/doc/report.pdf", None),
        );
        assert_eq!(
            pdf_response
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok()),
            Some("application/pdf")
        );
        assert!(
            pdf_response
                .headers()
                .get(header::CONTENT_SECURITY_POLICY)
                .is_none(),
            "非 html 不带 CSP"
        );
    }
}
