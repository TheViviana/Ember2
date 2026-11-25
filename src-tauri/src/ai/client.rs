//! AI HTTP 传输层（T5a commit 3）：连接钉死、超时、状态码映射与流式读取。
//!
//! 三条硬约束：
//! 1. 每个请求用独立客户端构建，`resolve_to_addrs` 只放本请求校验过的地址，
//!    并显式关闭重定向，避免跨地址/跨协议跳转绕开钉死快照。
//! 2. 响应总字节在读取循环内逐块累计，超过 [`MAX_RESPONSE_BYTES`] 立即断开
//!    并返回 `ResponseTooLarge`，不把超额数据留在内存里。
//! 3. 取消用 `AtomicBool` + 250ms 轮询实现，每拉取下一块之前先检查一次，
//!    不新增 tokio 特性、不引入额外同步原语。

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::{Client, Method, Response, StatusCode, Url};
use serde_json::{json, Value};

use super::config::{AiConfig, ChatTurn, Provider};
use super::dns::{allows, pin, DnsResolver, Policy, SystemResolver, Target};
use super::endpoint::AiEndpoint;
use super::error::{AiError, AiResult};
use super::keychain::{KeyStorage, KeyStore};
use super::ndjson::NdjsonParser;
use super::sse::{SseEvent, SseParser};

/// 单次响应总字节上限（64 MiB）。超出即视为异常响应，立即断开。
pub const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// 建立连接的超时。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 等待响应头的超时（本地运行时）：模型冷加载可达分钟级。
pub const HEADER_TIMEOUT_LOCAL: Duration = Duration::from_secs(300);

/// 等待响应头的超时（云端端点）：挂起的公网连接不应该长期占住资源。
pub const HEADER_TIMEOUT_PUBLIC: Duration = Duration::from_secs(30);

/// 按提供方选择等待响应头的超时。
fn header_timeout(provider: Provider) -> Duration {
    match provider {
        Provider::Ollama => HEADER_TIMEOUT_LOCAL,
        Provider::OpenAiCompatible => HEADER_TIMEOUT_PUBLIC,
    }
}

/// 单次读取无数据的超时（流式响应每块之间）。
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);

/// 取消轮询间隔。
pub const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// 请求取消令牌：克隆共享同一个标志，置位后所有读取点都会尽快退出。
#[derive(Clone, Debug, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// 两个令牌是否共享同一个取消标志（用于判断是否属于同一条在途请求）。
    pub fn same_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.flag, &other.flag)
    }
}

/// 带取消轮询与停滞超时的等待。
///
/// `future` 固定在栈上反复轮询；每次 250ms 超时先检查取消标志，再判断是否
/// 超过 `stall`。这样既不需要 `Unpin` 约束，也不需要 `Box`。
async fn await_cancellable<F, T>(future: F, cancel: &CancelToken, stall: Duration) -> AiResult<T>
where
    F: Future<Output = T>,
{
    let mut future = std::pin::pin!(future);
    let started = Instant::now();
    loop {
        // 取消优先：即使第一块数据极慢，也不等到下一次轮询才退出。
        if cancel.is_cancelled() {
            return Err(AiError::Cancelled);
        }
        match tokio::time::timeout(CANCEL_POLL_INTERVAL, future.as_mut()).await {
            Ok(value) => return Ok(value),
            Err(_) => {
                if started.elapsed() >= stall {
                    return Err(AiError::Timeout);
                }
            }
        }
    }
}

/// 一次请求使用的 HTTP 客户端。
pub struct HttpTransport {
    client: Client,
    /// 等待响应头的上限；本地运行时与云端端点取值不同。
    header_timeout: Duration,
}

impl HttpTransport {
    /// 用已校验的钉死快照构建客户端。
    pub fn new(endpoint: &AiEndpoint, target: &Target, header_timeout: Duration) -> AiResult<Self> {
        debug_assert_eq!(endpoint.host(), target.host(), "端点与快照必须来自同一主机");
        let mut builder = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(CONNECT_TIMEOUT)
            // 不复用连接：钉死快照只对本次请求有效，连接池会把它带到后续请求。
            .pool_max_idle_per_host(0)
            .user_agent("Ember/1.0");
        // 本地/内网目标绝不走系统代理：macOS 上系统代理会接管 `localhost`，
        // 由代理代为返回 503（127.0.0.1 字面量却可直连），导致本地 Ollama 看似不可用。
        if target
            .addrs()
            .iter()
            .all(|addr| !allows(addr.ip(), Policy::Public))
        {
            builder = builder.no_proxy();
        }
        if !target.is_literal() {
            builder = builder.resolve_to_addrs(target.host(), target.addrs());
        }
        let client = builder.build().map_err(|_| AiError::Network)?;
        Ok(Self {
            client,
            header_timeout,
        })
    }

    pub async fn get_json(
        &self,
        url: Url,
        bearer: Option<&str>,
        cancel: &CancelToken,
    ) -> AiResult<Value> {
        self.get_json_limited(url, bearer, cancel, MAX_RESPONSE_BYTES)
            .await
    }

    pub async fn post_json(
        &self,
        url: Url,
        bearer: Option<&str>,
        body: &Value,
        cancel: &CancelToken,
    ) -> AiResult<Value> {
        self.post_json_limited(url, bearer, body, cancel, MAX_RESPONSE_BYTES)
            .await
    }

    pub async fn post_sse<F>(
        &self,
        url: Url,
        bearer: Option<&str>,
        body: &Value,
        cancel: &CancelToken,
        on_event: F,
    ) -> AiResult<()>
    where
        F: FnMut(SseEvent) -> AiResult<()>,
    {
        self.post_sse_limited(url, bearer, body, cancel, MAX_RESPONSE_BYTES, on_event)
            .await
    }

    pub async fn post_ndjson<F>(
        &self,
        url: Url,
        bearer: Option<&str>,
        body: &Value,
        cancel: &CancelToken,
        on_value: F,
    ) -> AiResult<()>
    where
        F: FnMut(Value) -> AiResult<()>,
    {
        self.post_ndjson_limited(url, bearer, body, cancel, MAX_RESPONSE_BYTES, on_value)
            .await
    }

    async fn get_json_limited(
        &self,
        url: Url,
        bearer: Option<&str>,
        cancel: &CancelToken,
        limit: u64,
    ) -> AiResult<Value> {
        let request = self.build(Method::GET, url, bearer)?;
        let response = self.send(request, cancel).await?;
        let mut response = ensure_success(response)?;
        let bytes = read_body_limited(&mut response, limit, cancel).await?;
        serde_json::from_slice(&bytes).map_err(|_| AiError::InvalidResponse)
    }

    async fn post_json_limited(
        &self,
        url: Url,
        bearer: Option<&str>,
        body: &Value,
        cancel: &CancelToken,
        limit: u64,
    ) -> AiResult<Value> {
        let request = self.build(Method::POST, url, bearer)?.json(body);
        let response = self.send(request, cancel).await?;
        let mut response = ensure_success(response)?;
        let bytes = read_body_limited(&mut response, limit, cancel).await?;
        serde_json::from_slice(&bytes).map_err(|_| AiError::InvalidResponse)
    }

    async fn post_sse_limited<F>(
        &self,
        url: Url,
        bearer: Option<&str>,
        body: &Value,
        cancel: &CancelToken,
        limit: u64,
        mut on_event: F,
    ) -> AiResult<()>
    where
        F: FnMut(SseEvent) -> AiResult<()>,
    {
        let request = self.build(Method::POST, url, bearer)?.json(body);
        let response = self.send(request, cancel).await?;
        let mut response = ensure_success(response)?;
        let mut parser = SseParser::new();
        stream_body(&mut response, limit, cancel, |chunk| {
            for event in parser.push(chunk)? {
                on_event(event)?;
            }
            Ok(())
        })
        .await?;
        // 规范：没有空行结尾的未完成事件丢弃。
        parser.finish();
        Ok(())
    }

    async fn post_ndjson_limited<F>(
        &self,
        url: Url,
        bearer: Option<&str>,
        body: &Value,
        cancel: &CancelToken,
        limit: u64,
        mut on_value: F,
    ) -> AiResult<()>
    where
        F: FnMut(Value) -> AiResult<()>,
    {
        let request = self.build(Method::POST, url, bearer)?.json(body);
        let response = self.send(request, cancel).await?;
        let mut response = ensure_success(response)?;
        let mut parser = NdjsonParser::new();
        stream_body(&mut response, limit, cancel, |chunk| {
            for value in parser.push(chunk)? {
                on_value(value)?;
            }
            Ok(())
        })
        .await?;
        // 最后一行可能没有换行符。
        for value in parser.finish()? {
            on_value(value)?;
        }
        Ok(())
    }

    fn build(
        &self,
        method: Method,
        url: Url,
        bearer: Option<&str>,
    ) -> AiResult<reqwest::RequestBuilder> {
        let mut request = self.client.request(method, url);
        if let Some(key) = bearer {
            let value = HeaderValue::from_str(&format!("Bearer {key}"))
                .map_err(|_| AiError::Unauthorized)?;
            request = request.header(AUTHORIZATION, value);
        }
        Ok(request)
    }

    async fn send(
        &self,
        request: reqwest::RequestBuilder,
        cancel: &CancelToken,
    ) -> AiResult<Response> {
        await_cancellable(request.send(), cancel, self.header_timeout)
            .await?
            .map_err(map_reqwest)
    }
}

/// 2xx 放行，其余按固定表映射。
fn ensure_success(response: Response) -> AiResult<Response> {
    let status = response.status();
    if status.is_success() {
        Ok(response)
    } else {
        Err(map_status(status))
    }
}

/// 状态码映射：503 单独识别为模型不可用，其余 5xx 归网络错误。
fn map_status(status: StatusCode) -> AiError {
    match status.as_u16() {
        401 | 403 => AiError::Unauthorized,
        429 => AiError::RateLimited,
        503 => AiError::ModelUnavailable,
        500..=599 => AiError::Network,
        _ => AiError::InvalidResponse,
    }
}

fn map_reqwest(error: reqwest::Error) -> AiError {
    if error.is_timeout() {
        if error.is_connect() {
            AiError::ConnectTimeout
        } else {
            AiError::Timeout
        }
    } else {
        AiError::Network
    }
}

/// 逐块读取并累计总字节；超限立即返回，不再读取后续数据。
async fn read_body_limited(
    response: &mut Response,
    limit: u64,
    cancel: &CancelToken,
) -> AiResult<Vec<u8>> {
    if let Some(length) = response.content_length() {
        if length > limit {
            return Err(AiError::ResponseTooLarge);
        }
    }
    let mut body = Vec::new();
    stream_body(response, limit, cancel, |chunk| {
        body.extend_from_slice(chunk);
        Ok(())
    })
    .await?;
    Ok(body)
}

/// 流式读取：每块先检查取消，再累计总字节，最后交给下游解析。
async fn stream_body<F>(
    response: &mut Response,
    limit: u64,
    cancel: &CancelToken,
    mut sink: F,
) -> AiResult<()>
where
    F: FnMut(&[u8]) -> AiResult<()>,
{
    let mut total = 0u64;
    loop {
        // 拉取下一块之前先看取消：首块极慢时也能立刻退出。
        if cancel.is_cancelled() {
            return Err(AiError::Cancelled);
        }
        let next = await_cancellable(response.chunk(), cancel, READ_TIMEOUT).await?;
        let Some(chunk) = next.map_err(map_reqwest)? else {
            return Ok(());
        };
        total = total.saturating_add(chunk.len() as u64);
        if total > limit {
            return Err(AiError::ResponseTooLarge);
        }
        sink(&chunk)?;
    }
}

/// AI 门面：把配置、密钥、端点校验、DNS 钉死与 HTTP 收发串起来。
///
/// 本 commit 不注册任何命令；T5b 再把它接到 IPC 与取消通道上。
pub struct AiTransport<R: DnsResolver = SystemResolver> {
    keys: KeyStore,
    resolver: R,
}

impl AiTransport<SystemResolver> {
    pub fn new() -> Self {
        Self::with_parts(KeyStore::new(), SystemResolver)
    }
}

impl Default for AiTransport<SystemResolver> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: DnsResolver> AiTransport<R> {
    pub fn with_parts(keys: KeyStore, resolver: R) -> Self {
        Self { keys, resolver }
    }

    pub fn keys(&self) -> &KeyStore {
        &self.keys
    }

    /// 按 provider + origin 保存密钥，返回实际落点供 UI 决定是否提示。
    pub fn save_key(
        &self,
        provider: Provider,
        base_url: &str,
        allow_insecure_http: bool,
        key: &str,
    ) -> AiResult<KeyStorage> {
        let endpoint = AiEndpoint::parse(base_url, allow_insecure_http)?;
        self.keys.save(provider.id(), &endpoint, key)
    }

    /// 拉取模型列表。
    pub async fn list_models(
        &self,
        config: &AiConfig,
        cancel: &CancelToken,
    ) -> AiResult<Vec<String>> {
        let (endpoint, transport, bearer) = self.prepare(config)?;
        let path = match config.provider {
            Provider::Ollama => "api/tags",
            Provider::OpenAiCompatible => "models",
        };
        let value = transport
            .get_json(endpoint.request_url(path)?, bearer.as_deref(), cancel)
            .await?;
        parse_models(config.provider, &value)
    }

    /// 流式对话：增量文本逐段交给 `on_delta`。
    pub async fn stream_chat<F>(
        &self,
        config: &AiConfig,
        model: &str,
        messages: &[ChatTurn<'_>],
        cancel: &CancelToken,
        mut on_delta: F,
    ) -> AiResult<()>
    where
        F: FnMut(&str) -> AiResult<()>,
    {
        let (endpoint, transport, bearer) = self.prepare(config)?;
        let payload = chat_payload(model, messages);
        match config.provider {
            Provider::Ollama => {
                let url = endpoint.request_url("api/chat")?;
                transport
                    .post_ndjson(url, bearer.as_deref(), &payload, cancel, |value| {
                        if let Some(delta) = ollama_delta(&value) {
                            on_delta(delta)?;
                        }
                        Ok(())
                    })
                    .await
            }
            Provider::OpenAiCompatible => {
                let url = endpoint.request_url("chat/completions")?;
                transport
                    .post_sse(url, bearer.as_deref(), &payload, cancel, |event| {
                        if event.is_done() {
                            return Ok(());
                        }
                        let value: Value = serde_json::from_str(event.data())
                            .map_err(|_| AiError::InvalidResponse)?;
                        if let Some(delta) = openai_delta(&value) {
                            on_delta(delta)?;
                        }
                        Ok(())
                    })
                    .await
            }
        }
    }

    /// 解析端点、取密钥、钉死地址，再建本次请求的客户端。
    fn prepare(&self, config: &AiConfig) -> AiResult<(AiEndpoint, HttpTransport, Option<String>)> {
        let endpoint = AiEndpoint::parse(&config.base_url, config.allow_insecure_http)?;
        // 先取密钥再解析 DNS：缺 key 时不必触网，也不暴露端点解析行为。
        let bearer = if config.provider.requires_key() {
            Some(
                self.keys
                    .load(config.provider.id(), &endpoint)?
                    .ok_or(AiError::KeyMissing)?,
            )
        } else {
            None
        };
        let target = pin(&endpoint, config.provider.policy(), &self.resolver)?;
        let transport = HttpTransport::new(&endpoint, &target, header_timeout(config.provider))?;
        Ok((endpoint, transport, bearer))
    }
}

fn chat_payload(model: &str, messages: &[ChatTurn<'_>]) -> Value {
    let messages: Vec<Value> = messages
        .iter()
        .map(|turn| json!({"role": turn.role, "content": turn.content}))
        .collect();
    json!({"model": model, "messages": messages, "stream": true})
}

fn parse_models(provider: Provider, value: &Value) -> AiResult<Vec<String>> {
    let (list_key, name_key) = match provider {
        Provider::Ollama => ("models", "name"),
        Provider::OpenAiCompatible => ("data", "id"),
    };
    let items = value
        .get(list_key)
        .and_then(Value::as_array)
        .ok_or(AiError::InvalidResponse)?;
    Ok(items
        .iter()
        .filter_map(|item| item.get(name_key).and_then(Value::as_str))
        .map(str::to_string)
        .collect())
}

/// OpenAI 兼容 SSE 的增量字段：`choices[0].delta.content`。
pub fn openai_delta(value: &Value) -> Option<&str> {
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
}

/// Ollama NDJSON 的增量字段：`message.content`。
pub fn ollama_delta(value: &Value) -> Option<&str> {
    value.get("message")?.get("content")?.as_str()
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::thread::{self, JoinHandle};

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::ai::dns::{pin, Policy, SystemResolver};
    use crate::ai::keychain::KeyStore;

    /// 本地 HTTP stub：只接受一个连接，处理完即退出。
    struct StubServer {
        addr: SocketAddr,
        handle: Option<JoinHandle<()>>,
    }

    impl StubServer {
        fn spawn<F>(handler: F) -> Self
        where
            F: FnOnce(&mut TcpStream) + Send + 'static,
        {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("绑定回环端口");
            let addr = listener.local_addr().expect("读取本地地址");
            let handle = thread::spawn(move || {
                if let Ok((mut stream, _)) = listener.accept() {
                    read_request(&mut stream);
                    handler(&mut stream);
                }
            });
            Self {
                addr,
                handle: Some(handle),
            }
        }

        fn url(&self, path: &str) -> Url {
            Url::parse(&format!("http://{}{path}", self.addr)).expect("测试 URL")
        }

        fn join(mut self) {
            if let Some(handle) = self.handle.take() {
                handle.join().expect("stub 线程不应 panic");
            }
        }
    }

    fn read_request(stream: &mut TcpStream) {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("读超时");
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 2048];
        let mut body_start = None;
        let mut body_len = 0usize;
        loop {
            if let Some(start) = body_start {
                if buffer.len() >= start + body_len {
                    return;
                }
            }
            let read = match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(read) => read,
            };
            buffer.extend_from_slice(&chunk[..read]);
            if body_start.is_none() {
                if let Some(position) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
                    body_start = Some(position + 4);
                    body_len = content_length(&buffer[..position]);
                }
            }
        }
    }

    fn content_length(head: &[u8]) -> usize {
        String::from_utf8_lossy(head)
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().ok())
                    .flatten()
            })
            .unwrap_or(0)
    }

    fn write_head(stream: &mut TcpStream, status: &str, extra: &str) {
        let head = format!("HTTP/1.1 {status}\r\n{extra}Connection: close\r\n\r\n");
        stream.write_all(head.as_bytes()).expect("写响应头");
        stream.flush().expect("冲刷响应头");
    }

    fn respond(stream: &mut TcpStream, status: &str, body: &[u8]) {
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).expect("写响应头");
        stream.write_all(body).expect("写响应体");
        stream.flush().expect("冲刷响应");
    }

    fn transport(server: &StubServer) -> HttpTransport {
        let endpoint =
            AiEndpoint::parse(&format!("http://{}", server.addr), true).expect("测试端点");
        let target = pin(&endpoint, Policy::Local, &SystemResolver).expect("钉死快照");
        HttpTransport::new(&endpoint, &target, HEADER_TIMEOUT_LOCAL).expect("构建客户端")
    }

    async fn status_error(status: &str) -> String {
        let status = status.to_string();
        let server = StubServer::spawn(move |stream| respond(stream, &status, b"{}"));
        let client = transport(&server);
        let error = client
            .get_json(server.url("/v1/models"), None, &CancelToken::new())
            .await
            .expect_err("非 2xx 应失败");
        server.join();
        error.code().to_string()
    }

    #[test]
    fn maps_status_codes_to_contract_errors() {
        let runtime = tokio::runtime::Runtime::new().expect("测试运行时");
        let cases = [
            ("401 Unauthorized", "E_AI_UNAUTHORIZED"),
            ("403 Forbidden", "E_AI_UNAUTHORIZED"),
            ("429 Too Many Requests", "E_AI_RATE_LIMITED"),
            ("503 Service Unavailable", "E_AI_MODEL_UNAVAILABLE"),
            ("500 Internal Server Error", "E_AI_NETWORK"),
            ("404 Not Found", "E_AI_INVALID_RESPONSE"),
        ];
        for (status, expected) in cases {
            assert_eq!(runtime.block_on(status_error(status)), expected, "{status}");
        }
    }

    #[test]
    fn does_not_follow_redirects() {
        let server = StubServer::spawn(|stream| {
            write_head(
                stream,
                "302 Found",
                "Location: http://169.254.169.254/latest/meta-data\r\n",
            );
        });
        let client = transport(&server);
        let error = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(client.get_json(server.url("/v1/models"), None, &CancelToken::new()))
            .expect_err("重定向应被拒绝");
        server.join();
        assert_eq!(error.code(), "E_AI_INVALID_RESPONSE");
    }

    #[test]
    fn streams_sse_across_chunks() {
        let server = StubServer::spawn(|stream| {
            write_head(stream, "200 OK", "Content-Type: text/event-stream\r\n");
            for piece in [
                b"data: hel".as_slice(),
                b"lo\n".as_slice(),
                b"\ndata: [DONE]\n\n".as_slice(),
            ] {
                stream.write_all(piece).expect("写事件");
                stream.flush().expect("冲刷");
                thread::sleep(Duration::from_millis(10));
            }
        });
        let client = transport(&server);
        let mut events = Vec::new();
        tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(client.post_sse(
                server.url("/v1/chat/completions"),
                Some("test-key"),
                &json!({"stream": true}),
                &CancelToken::new(),
                |event| {
                    events.push((event.data().to_string(), event.is_done()));
                    Ok(())
                },
            ))
            .expect("SSE 解析");
        server.join();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].0, "hello");
        assert!(events[1].1);
    }

    #[test]
    fn streams_ndjson_across_chunks() {
        let server = StubServer::spawn(|stream| {
            write_head(stream, "200 OK", "Content-Type: application/x-ndjson\r\n");
            for piece in [
                b"{\"message\":{\"content\":\"he".as_slice(),
                b"llo\"}}\n".as_slice(),
                b"{\"done\":true}\n".as_slice(),
            ] {
                stream.write_all(piece).expect("写事件");
                stream.flush().expect("冲刷");
                thread::sleep(Duration::from_millis(10));
            }
        });
        let client = transport(&server);
        let mut values = Vec::new();
        tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(client.post_ndjson(
                server.url("/api/chat"),
                None,
                &json!({"stream": true}),
                &CancelToken::new(),
                |value| {
                    values.push(value);
                    Ok(())
                },
            ))
            .expect("NDJSON 解析");
        server.join();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["message"]["content"], "hello");
        assert!(values[1]["done"].as_bool().expect("布尔字段"));
    }

    #[test]
    fn over_limit_stream_fails_before_reading_everything() {
        let server = StubServer::spawn(|stream| {
            write_head(stream, "200 OK", "");
            // 超过测试上限后继续写：客户端必须在累计超限时立即返回。
            let block = vec![b'a'; 256];
            for _ in 0..8 {
                if stream.write_all(&block).is_err() {
                    return;
                }
            }
        });
        let client = transport(&server);
        let error = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(client.get_json_limited(
                server.url("/v1/models"),
                None,
                &CancelToken::new(),
                64,
            ))
            .expect_err("超限应失败");
        server.join();
        assert_eq!(error.code(), "E_AI_RESPONSE_TOO_LARGE");
    }

    #[test]
    fn truncated_body_maps_to_network() {
        let server = StubServer::spawn(|stream| {
            let head = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n";
            stream.write_all(head.as_bytes()).expect("写响应头");
            stream.write_all(b"short").expect("写部分响应体");
            stream.flush().expect("冲刷");
        });
        let client = transport(&server);
        let error = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(client.get_json(server.url("/v1/models"), None, &CancelToken::new()))
            .expect_err("截断应失败");
        server.join();
        assert_eq!(error.code(), "E_AI_NETWORK");
    }

    #[test]
    fn cancel_unblocks_slow_stream() {
        let server = StubServer::spawn(|stream| {
            write_head(stream, "200 OK", "Content-Type: text/event-stream\r\n");
            let _ = stream.write_all(b"data: first\n\n");
            let _ = stream.flush();
            thread::sleep(Duration::from_secs(3));
        });
        let client = transport(&server);
        let cancel = CancelToken::new();
        let canceller = cancel.clone();
        tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(async {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    canceller.cancel();
                });
                let error = client
                    .post_sse(
                        server.url("/v1/chat/completions"),
                        None,
                        &json!({}),
                        &cancel,
                        |_| Ok(()),
                    )
                    .await
                    .expect_err("取消应中断读取");
                assert_eq!(error.code(), "E_AI_CANCELLED");
            });
        // stub 仍在睡眠，等它自然结束，确保线程无 panic。
        server.join();
    }

    #[test]
    fn header_timeout_follows_provider() {
        assert_eq!(HEADER_TIMEOUT_LOCAL, Duration::from_secs(300));
        assert_eq!(HEADER_TIMEOUT_PUBLIC, Duration::from_secs(30));
        assert_eq!(header_timeout(Provider::Ollama), Duration::from_secs(300));
        assert_eq!(
            header_timeout(Provider::OpenAiCompatible),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn cancel_before_send_returns_immediately() {
        let endpoint = AiEndpoint::parse("http://127.0.0.1:9/v1", true).expect("测试端点");
        let target = pin(&endpoint, Policy::Local, &SystemResolver).expect("钉死快照");
        let client =
            HttpTransport::new(&endpoint, &target, HEADER_TIMEOUT_LOCAL).expect("构建客户端");
        let cancel = CancelToken::new();
        cancel.cancel();
        let error = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(client.get_json(endpoint.request_url("models").expect("URL"), None, &cancel))
            .expect_err("已取消应直接失败");
        assert_eq!(error.code(), "E_AI_CANCELLED");
    }

    #[test]
    fn await_cancellable_times_out_on_stall() {
        let cancel = CancelToken::new();
        let result: AiResult<()> = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(await_cancellable(
                std::future::pending(),
                &cancel,
                Duration::from_millis(400),
            ));
        assert!(matches!(result, Err(AiError::Timeout)));
    }

    fn test_keys(dir: &tempfile::TempDir) -> KeyStore {
        KeyStore::with_dir(dir.path().to_path_buf())
    }

    #[test]
    fn list_models_parses_ollama_tags() {
        let server = StubServer::spawn(|stream| {
            respond(
                stream,
                "200 OK",
                br#"{"models":[{"name":"llama3:latest"},{"name":"qwen2.5:7b"}]}"#,
            );
        });
        let dir = tempdir().expect("tempdir");
        let transport = AiTransport::with_parts(test_keys(&dir), SystemResolver);
        let config = AiConfig {
            provider: Provider::Ollama,
            base_url: format!("http://{}", server.addr),
            allow_insecure_http: false,
        };
        let models = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(transport.list_models(&config, &CancelToken::new()))
            .expect("模型列表");
        server.join();
        assert_eq!(models, vec!["llama3:latest", "qwen2.5:7b"]);
    }

    #[test]
    fn chat_stream_emits_ollama_deltas() {
        let server = StubServer::spawn(|stream| {
            write_head(stream, "200 OK", "Content-Type: application/x-ndjson\r\n");
            let body = concat!(
                "{\"message\":{\"content\":\"\\u4f60\"},\"done\":false}\n",
                "{\"message\":{\"content\":\"\\u597d\"},\"done\":true}\n"
            );
            stream.write_all(body.as_bytes()).expect("写增量");
            stream.flush().expect("冲刷");
        });
        let dir = tempdir().expect("tempdir");
        let transport = AiTransport::with_parts(test_keys(&dir), SystemResolver);
        let config = AiConfig {
            provider: Provider::Ollama,
            base_url: format!("http://{}", server.addr),
            allow_insecure_http: false,
        };
        let mut text = String::new();
        tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(transport.stream_chat(
                &config,
                "llama3",
                &[ChatTurn {
                    role: "user",
                    content: "你好",
                }],
                &CancelToken::new(),
                |delta| {
                    text.push_str(delta);
                    Ok(())
                },
            ))
            .expect("流式对话");
        server.join();
        assert_eq!(text, "你好");
    }

    #[test]
    fn openai_requires_key_before_network() {
        let dir = tempdir().expect("tempdir");
        let transport = AiTransport::with_parts(test_keys(&dir), SystemResolver);
        let config = AiConfig {
            provider: Provider::OpenAiCompatible,
            base_url: "https://api.test/v1".to_string(),
            allow_insecure_http: false,
        };
        let error = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(transport.list_models(&config, &CancelToken::new()))
            .expect_err("缺 key 应失败");
        assert_eq!(error.code(), "E_AI_KEY_MISSING");
    }

    #[test]
    fn save_key_binds_provider_and_origin() {
        let dir = tempdir().expect("tempdir");
        let transport = AiTransport::with_parts(test_keys(&dir), SystemResolver);
        let storage = transport
            .save_key(
                Provider::OpenAiCompatible,
                "https://api.test/v1",
                false,
                "  sk-test  ",
            )
            .expect("保存密钥");
        assert_eq!(storage, KeyStorage::File);
        let endpoint = AiEndpoint::parse("https://api.test/v1", false).expect("端点");
        assert_eq!(
            transport
                .keys()
                .load("openai-compatible", &endpoint)
                .expect("读取")
                .as_deref(),
            Some("sk-test")
        );
    }

    #[test]
    fn extracts_provider_deltas() {
        assert_eq!(
            openai_delta(&json!({"choices": [{"delta": {"content": "hi"}}]})),
            Some("hi")
        );
        assert_eq!(openai_delta(&json!({"choices": []})), None);
        assert_eq!(openai_delta(&json!({"choices": [{"delta": {}}]})), None);
        assert_eq!(
            ollama_delta(&json!({"message": {"content": "yo"}})),
            Some("yo")
        );
        assert_eq!(ollama_delta(&json!({"done": true})), None);
    }
}
