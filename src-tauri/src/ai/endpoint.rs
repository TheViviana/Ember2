//! AI 端点的 URL 静态校验（SSRF 第一段）。
//!
//! 这里只做与网络无关的文本与 URL 判断：协议、凭据、查询串、主机名黑名单、
//! 明文 HTTP 门槛。端点实际指向哪个 IP 由 `ai::dns` 在解析后判定（第二段），
//! 两段都通过才允许建立连接。
//!
//! 校验必须发生在 `Url::parse` 之后：`url` 会按 WHATWG 规范把
//! `http://2130706433/`、`http://0x7f000001/`、`http://[::ffff:127.0.0.1]/`
//! 这类变形统一规范化成 IP 字面量，先解析再判才拦得住。

use std::net::IpAddr;

use reqwest::Url;

use super::dns::unwrap_embedded;
use super::error::AiError;

/// 旧版本地 Ollama 默认基址（旧库配置迁移时用于回填）。
pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";

/// 通过静态校验的端点。`host` 存裸主机名（IPv6 不带方括号、已小写、无尾点）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiEndpoint {
    origin: String,
    host: String,
    base_url: Url,
}

impl AiEndpoint {
    pub fn parse(raw: &str, allow_insecure_http: bool) -> Result<Self, AiError> {
        let text = raw.trim();
        if text.is_empty() {
            return Err(invalid("地址为空"));
        }
        // `Url::parse` 会静默剔除制表/换行并把边角空格当空白，先自己拒掉，
        // 避免 `http://host\n/` 这类输入被"修好"后放行。
        if text.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
            return Err(invalid("地址含有空白或控制字符"));
        }
        let mut url = Url::parse(text).map_err(|_| invalid("无法解析为合法 URL"))?;
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(invalid("只允许 http 或 https"));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(invalid("地址不允许携带用户名或密码"));
        }
        if url.query().is_some() || url.fragment().is_some() {
            return Err(invalid("地址不允许携带查询串或片段"));
        }
        let raw_host = url.host_str().ok_or_else(|| invalid("缺少主机名"))?;
        let host = normalize_host(raw_host)?;
        if is_blocked_name(&host) {
            return Err(invalid("主机地址被安全策略禁止"));
        }
        if url.scheme() == "http" && !is_loopback_host(&host) && !allow_insecure_http {
            return Err(invalid("非回环地址必须使用 https，或显式允许明文 HTTP"));
        }
        let path = url.path().trim_end_matches('/').to_string();
        url.set_path(if path.is_empty() { "/" } else { &path });
        let origin = origin_of(&url, &host);
        Ok(Self {
            origin,
            host,
            base_url: url,
        })
    }

    /// 凭据账号键：`{provider}:v1:{origin}`。换端点即换账号，内存降级的
    /// key 不会被带到另一个端点。
    pub fn account(&self, provider: &str) -> String {
        format!("{provider}:v1:{}", self.origin)
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn base_url(&self) -> &Url {
        &self.base_url
    }

    /// 裸主机名：IPv6 已去掉方括号，可直接交给解析器与 `resolve_to_addrs`。
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> Result<u16, AiError> {
        self.base_url
            .port_or_known_default()
            .ok_or_else(|| invalid("缺少可用端口"))
    }

    pub fn is_ip_host(&self) -> bool {
        self.host.parse::<IpAddr>().is_ok()
    }

    pub fn request_url(&self, path: &str) -> Result<Url, AiError> {
        let joined = format!(
            "{}/{}",
            self.base_url.as_str().trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        Url::parse(&joined).map_err(|_| invalid("请求地址无法组装"))
    }
}

fn invalid(message: &str) -> AiError {
    AiError::InvalidEndpoint(message.to_string())
}

fn normalize_host(raw: &str) -> Result<String, AiError> {
    // IPv6 字面量在 URL 里带方括号；尾点（`localhost.`）在 DNS 里等价于不带点，
    // 两者都先归一，黑名单与回环判断才不会被绕过。
    let bare = raw.trim_start_matches('[').trim_end_matches(']');
    let trimmed = bare.trim_end_matches('.');
    if trimmed.is_empty() {
        return Err(invalid("主机名为空"));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn is_blocked_name(host: &str) -> bool {
    // 云厂商元数据端点：即便解析结果落在公网也不允许。
    host == "metadata" || host == "metadata.google.internal"
}

fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(ip) => match unwrap_embedded(ip) {
            IpAddr::V4(v4) => v4.is_loopback(),
            IpAddr::V6(v6) => v6.is_loopback(),
        },
        Err(_) => false,
    }
}

fn origin_of(url: &Url, host: &str) -> String {
    // IPv6 在 origin 里必须带方括号才是合法文本；端口取 URL 的显式端口
    // （默认端口已被 `url` 归一成 None，所以 `:443` 写法不会产生两个 origin）。
    let authority = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    match url.port() {
        Some(port) => format!("{}://{}:{}", url.scheme(), authority, port),
        None => format!("{}://{}", url.scheme(), authority),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_ok(raw: &str, allow_insecure_http: bool) -> AiEndpoint {
        AiEndpoint::parse(raw, allow_insecure_http).expect("应通过静态校验")
    }

    #[test]
    fn accepts_https_endpoint_and_normalizes_base_path() {
        let endpoint = parse_ok("https://api.openai.com/v1/", false);
        assert_eq!(endpoint.host(), "api.openai.com");
        assert_eq!(endpoint.origin(), "https://api.openai.com");
        assert_eq!(endpoint.port().expect("端口"), 443);
        assert_eq!(endpoint.base_url().path(), "/v1");
        assert!(!endpoint.is_ip_host());
        assert_eq!(
            endpoint
                .request_url("chat/completions")
                .expect("组装")
                .as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn default_port_does_not_split_origin() {
        let explicit = parse_ok("https://api.test:443/v1", false);
        let implicit = parse_ok("https://api.test/v1", false);
        assert_eq!(explicit.origin(), implicit.origin());
    }

    #[test]
    fn legacy_ipv4_forms_are_normalized_to_dotted_quad() {
        for raw in [
            "http://2130706433/",
            "http://0x7f000001/",
            "http://0x7f.1/",
            "http://127.1/",
            "http://0177.0.0.1/",
        ] {
            let endpoint = parse_ok(raw, false);
            assert_eq!(endpoint.host(), "127.0.0.1", "{raw} 未归一");
            assert!(endpoint.is_ip_host(), "{raw} 应识别为 IP 字面量");
        }
    }

    #[test]
    fn ipv6_literal_is_stored_without_brackets() {
        let endpoint = parse_ok("http://[::1]:11434/", false);
        assert_eq!(endpoint.host(), "::1");
        assert_eq!(endpoint.origin(), "http://[::1]:11434");
        assert_eq!(endpoint.port().expect("端口"), 11434);
        assert!(endpoint.is_ip_host());
    }

    #[test]
    fn mapped_loopback_counts_as_loopback_for_insecure_http() {
        // 明文 HTTP 未显式开启仍能解析，说明解析层的回环判定认出这是回环。
        let endpoint = parse_ok("http://[::ffff:127.0.0.1]:11434/", false);
        // `url` 会把 IPv4-mapped 规范化成 `::ffff:7f00:1`，判定必须先还原成 IPv4。
        let mapped = endpoint.host().parse::<IpAddr>().expect("IP 字面量");
        assert!(matches!(unwrap_embedded(mapped), IpAddr::V4(v4) if v4.is_loopback()));
    }

    #[test]
    fn plain_http_requires_flag_except_loopback() {
        let _ = AiEndpoint::parse("http://127.0.0.1:11434", false).expect("回环允许明文");
        let _ = AiEndpoint::parse("http://localhost:11434", false).expect("回环允许明文");
        assert!(AiEndpoint::parse("http://api.test/v1", false).is_err());
        let _ = AiEndpoint::parse("http://192.168.1.9:11434/v1", true).expect("显式允许明文");
    }

    #[test]
    fn rejects_credentials_query_fragment_and_bad_scheme() {
        for raw in [
            "http://user:pass@api.test/v1",
            "http://token@api.test/v1",
            "https://api.test/v1?key=1",
            "https://api.test/v1#frag",
            "ftp://api.test/v1",
            "file:///etc/passwd",
        ] {
            assert!(AiEndpoint::parse(raw, true).is_err(), "{raw} 应被拒绝");
        }
    }

    #[test]
    fn rejects_blank_and_whitespace_addresses() {
        for raw in ["", "   ", "https://api.test /v1", "https://api.test\n/v1"] {
            assert!(AiEndpoint::parse(raw, true).is_err(), "{raw:?} 应被拒绝");
        }
    }

    #[test]
    fn rejects_metadata_host_names() {
        for raw in [
            "http://metadata/v1",
            "http://metadata.google.internal/v1",
            "http://METADATA./v1",
        ] {
            assert!(AiEndpoint::parse(raw, true).is_err(), "{raw} 应被拒绝");
        }
    }

    #[test]
    fn account_binds_provider_and_origin() {
        let endpoint = parse_ok("https://api.test:8443/v1", false);
        assert_eq!(
            endpoint.account("openai-compatible"),
            "openai-compatible:v1:https://api.test:8443"
        );
        assert_ne!(
            endpoint.account("ollama"),
            endpoint.account("openai-compatible")
        );
    }
}
