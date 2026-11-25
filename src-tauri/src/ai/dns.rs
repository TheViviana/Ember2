//! 端点解析结果的网段校验与钉死快照（SSRF 第二段）。
//!
//! 关键时序：解析只发生一次。校验通过的地址快照交给 reqwest 的
//! `resolve_to_addrs`，连接阶段不再查询 DNS，因此 DNS 重绑定（第一次解析
//! 返回公网地址骗过校验、连接时再解析到内网）没有可利用的时间窗。
//!
//! 策略按 provider 分级（`Policy`）：云端端点只允许公网可路由地址；本地
//! 运行时额外允许回环与 RFC1918，但 link-local、CGNAT、保留段两类都拒绝。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

use super::endpoint::AiEndpoint;
use super::error::{AiError, AiResult};

pub trait DnsResolver {
    /// 同步解析（由调用方在进入事件循环前调用）；实现不得做地址过滤，
    /// 过滤统一由 [`validate`] 负责，避免两种策略悄悄漂移。
    fn resolve(&self, host: &str, port: u16) -> AiResult<Vec<SocketAddr>>;
}

/// 系统解析器：`to_socket_addrs` 返回的已是最终地址（CNAME 已展开）。
pub struct SystemResolver;

impl DnsResolver for SystemResolver {
    fn resolve(&self, host: &str, port: u16) -> AiResult<Vec<SocketAddr>> {
        let addrs: Vec<SocketAddr> = (host, port)
            .to_socket_addrs()
            .map_err(|_| AiError::Network)?
            .collect();
        if addrs.is_empty() {
            return Err(AiError::Network);
        }
        Ok(addrs)
    }
}

/// 网段策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    /// 云端兼容端点（携带 API Key）：只允许公网地址。
    Public,
    /// 本地运行时（Ollama）：额外允许回环与 RFC1918 私网。
    Local,
}

/// 校验通过的连接目标。
///
/// `host` 只用于 TLS SNI 与 `Host` 头，`addrs` 只用于钉死连接地址 ——
/// URL 本身不会被改写成 IP，否则 SNI 变成 IP、证书校验必然失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    host: String,
    addrs: Vec<SocketAddr>,
    literal: bool,
}

impl Target {
    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn addrs(&self) -> &[SocketAddr] {
        &self.addrs
    }

    /// URL 本身就是 IP 字面量：连接器直接用该 IP，不应再调用 `resolve_to_addrs`。
    pub fn is_literal(&self) -> bool {
        self.literal
    }
}

/// 解析 + 校验 + 生成钉死快照。IP 字面量端点跳过 DNS，但**同样**走网段校验。
pub fn pin<R: DnsResolver>(
    endpoint: &AiEndpoint,
    policy: Policy,
    resolver: &R,
) -> AiResult<Target> {
    let port = endpoint.port()?;
    let host = endpoint.host().to_string();
    if let Ok(ip) = host.parse::<IpAddr>() {
        let addr = SocketAddr::new(ip, port);
        validate(&[addr], policy)?;
        return Ok(Target {
            host,
            addrs: vec![addr],
            literal: true,
        });
    }
    let addrs = resolver.resolve(&host, port)?;
    validate(&addrs, policy)?;
    Ok(Target {
        host,
        addrs,
        literal: false,
    })
}

/// 任一条地址命中受限网段即整体拒绝：不做"挑一个安全的用"，
/// 否则轮询到受限地址时攻击者仍可命中。
pub fn validate(addrs: &[SocketAddr], policy: Policy) -> AiResult<()> {
    if addrs.is_empty() {
        return Err(AiError::Network);
    }
    for addr in addrs {
        if !allows(addr.ip(), policy) {
            return Err(AiError::InvalidEndpoint("主机解析到受限网段".to_string()));
        }
    }
    Ok(())
}

/// 地址是否在策略允许范围内（网络顺序无副作用，可直接单测）。
pub fn allows(ip: IpAddr, policy: Policy) -> bool {
    match scope(ip) {
        Scope::Public => true,
        Scope::Private => policy == Policy::Local,
        Scope::Blocked => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    Public,
    /// 回环与 RFC1918 / IPv6 unique-local：只有本地运行时可用。
    Private,
    /// 无论哪种策略都拒绝：未指定、组播、link-local、广播、CGNAT、保留段。
    Blocked,
}

fn scope(ip: IpAddr) -> Scope {
    match unwrap_embedded(ip) {
        IpAddr::V4(v4) => scope_v4(v4),
        IpAddr::V6(v6) => scope_v6(v6),
    }
}

fn scope_v4(ip: Ipv4Addr) -> Scope {
    if ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_link_local()
        || ip.is_broadcast()
        || is_cgnat(ip)
        || is_documentation_v4(ip)
        || is_reserved_v4(ip)
    {
        return Scope::Blocked;
    }
    if ip.is_loopback() || ip.is_private() {
        return Scope::Private;
    }
    Scope::Public
}

fn scope_v6(ip: Ipv6Addr) -> Scope {
    if ip.is_unspecified() || ip.is_multicast() || is_link_local_v6(ip) || is_documentation_v6(ip) {
        return Scope::Blocked;
    }
    if ip.is_loopback() || is_unique_local_v6(ip) {
        return Scope::Private;
    }
    Scope::Public
}

/// 把内嵌 IPv4 的 IPv6 还原成 IPv4 再判定。
///
/// `::ffff:a.b.c.d` 与 NAT64 `64:ff9b::/96` 都是"看起来是 v6、实际打通到 v4"
/// 的形式，不还原就会让 `::ffff:169.254.169.254` 绕过 link-local 黑名单。
pub(crate) fn unwrap_embedded(ip: IpAddr) -> IpAddr {
    let IpAddr::V6(v6) = ip else {
        return ip;
    };
    if let Some(v4) = v6.to_ipv4_mapped() {
        return IpAddr::V4(v4);
    }
    if let Some(v4) = nat64_target(v6) {
        return IpAddr::V4(v4);
    }
    ip
}

fn nat64_target(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let segments = ip.segments();
    if segments[0] != 0x0064 || segments[1] != 0xff9b {
        return None;
    }
    if segments[2..6].iter().any(|segment| *segment != 0) {
        return None;
    }
    let octets = ip.octets();
    Some(Ipv4Addr::new(
        octets[12], octets[13], octets[14], octets[15],
    ))
}

/// 100.64.0.0/10（运营商级 NAT，不属于 RFC1918，但同样不是公网）。
fn is_cgnat(ip: Ipv4Addr) -> bool {
    (u32::from(ip) & 0xffff_ffc0) == 0x6440_0000
}

/// 192.0.2.0/24、198.51.100.0/24、203.0.113.0/24（文档示例段，不可路由）。
fn is_documentation_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
}

/// 240.0.0.0/4（保留段，含 255.255.255.255 之外的广播外沿）。
fn is_reserved_v4(ip: Ipv4Addr) -> bool {
    ip.octets()[0] >= 240
}

/// fe80::/10。
fn is_link_local_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

/// fc00::/7。
fn is_unique_local_v6(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

/// 2001:db8::/32（文档示例段）。
fn is_documentation_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0x2001 && segments[1] == 0x0db8
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;

    struct StubResolver {
        addrs: Vec<SocketAddr>,
        fail: bool,
        calls: AtomicUsize,
        seen: Mutex<Option<(String, u16)>>,
    }

    impl StubResolver {
        fn new(addrs: Vec<SocketAddr>) -> Self {
            Self {
                addrs,
                fail: false,
                calls: AtomicUsize::new(0),
                seen: Mutex::new(None),
            }
        }

        fn failing() -> Self {
            Self {
                fail: true,
                ..Self::new(Vec::new())
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn seen(&self) -> Option<(String, u16)> {
            self.seen.lock().expect("锁").clone()
        }
    }

    impl DnsResolver for StubResolver {
        fn resolve(&self, host: &str, port: u16) -> AiResult<Vec<SocketAddr>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            *self.seen.lock().expect("锁") = Some((host.to_string(), port));
            if self.fail {
                return Err(AiError::Network);
            }
            Ok(self.addrs.clone())
        }
    }

    fn ip(raw: &str) -> IpAddr {
        raw.parse().expect("测试地址")
    }

    fn endpoint(raw: &str) -> AiEndpoint {
        AiEndpoint::parse(raw, true).expect("测试端点")
    }

    #[test]
    fn public_policy_rejects_every_non_public_range() {
        for raw in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
            "100.64.0.1",
            "192.0.2.10",
            "240.0.0.1",
            "::1",
            "::",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
        ] {
            assert!(!allows(ip(raw), Policy::Public), "{raw} 不应被公网策略放行");
        }
        for raw in ["93.184.216.34", "2606:4700::1111", "64:ff9b::5db8:d822"] {
            assert!(allows(ip(raw), Policy::Public), "{raw} 应被公网策略放行");
        }
    }

    #[test]
    fn local_policy_adds_loopback_and_private_only() {
        for raw in [
            "127.0.0.1",
            "10.1.2.3",
            "172.20.1.1",
            "192.168.1.9",
            "::1",
            "::ffff:7f00:1",
            "fd00::1",
        ] {
            assert!(allows(ip(raw), Policy::Local), "{raw} 应被本地策略放行");
        }
        for raw in [
            "169.254.169.254",
            "100.64.0.1",
            "fe80::1",
            "224.0.0.1",
            "0.0.0.0",
        ] {
            assert!(!allows(ip(raw), Policy::Local), "{raw} 任何策略都不应放行");
        }
    }

    #[test]
    fn empty_resolution_is_network_error() {
        let error = validate(&[], Policy::Public).expect_err("空解析应失败");
        assert!(matches!(error, AiError::Network));
    }

    #[test]
    fn mixed_resolution_rejects_whole_endpoint() {
        let addrs = [
            SocketAddr::new(ip("93.184.216.34"), 443),
            SocketAddr::new(ip("10.0.0.7"), 443),
        ];
        let error = validate(&addrs, Policy::Public).expect_err("混入内网应整体拒绝");
        assert!(matches!(error, AiError::InvalidEndpoint(_)));
    }

    #[test]
    fn direct_ip_endpoint_is_validated_without_dns() {
        let resolver = StubResolver::new(vec![SocketAddr::new(ip("127.0.0.1"), 80)]);
        for raw in [
            "http://169.254.169.254/latest/meta-data",
            "http://2852039166/latest/meta-data",
            "http://0xa9fea9fe/latest/meta-data",
        ] {
            let error =
                pin(&endpoint(raw), Policy::Public, &resolver).expect_err("IP 端点也要过校验");
            assert!(matches!(error, AiError::InvalidEndpoint(_)), "{raw}");
        }
        assert_eq!(resolver.calls(), 0, "IP 字面量不应触发 DNS 解析");
    }

    #[test]
    fn loopback_literal_is_accepted_by_local_policy() {
        let resolver = StubResolver::new(Vec::new());
        let target =
            pin(&endpoint("http://[::1]:11434/"), Policy::Local, &resolver).expect("本地策略");
        assert_eq!(target.host(), "::1");
        assert!(target.is_literal());
        assert_eq!(target.addrs()[0].port(), 11434);
        assert_eq!(resolver.calls(), 0);
        assert!(matches!(
            pin(&endpoint("http://[::1]:11434/"), Policy::Public, &resolver),
            Err(AiError::InvalidEndpoint(_))
        ));
    }

    #[test]
    fn dns_failure_maps_to_network() {
        let resolver = StubResolver::failing();
        let error =
            pin(&endpoint("https://api.test/v1"), Policy::Public, &resolver).expect_err("解析失败");
        assert!(matches!(error, AiError::Network));
        assert_eq!(resolver.calls(), 1);
    }

    #[test]
    fn pinned_target_keeps_hostname_for_sni_and_host_header() {
        let resolver = StubResolver::new(vec![SocketAddr::new(ip("127.0.0.1"), 8080)]);
        let target = pin(
            &endpoint("https://pinned.test:8443/v1"),
            Policy::Local,
            &resolver,
        )
        .expect("钉死快照");
        // host 必须是原始域名（SNI / Host 头来源），不能是解析后的 IP。
        assert_eq!(target.host(), "pinned.test");
        assert!(!target.is_literal());
        assert_eq!(target.addrs(), &[SocketAddr::new(ip("127.0.0.1"), 8080)]);
        assert_eq!(resolver.seen(), Some(("pinned.test".to_string(), 8443)));
    }
}
