//! AI 命令接线（T5b commit 2）：密钥、模型列表与流式对话的 IPC 边界。
//!
//! 取消表用 `Arc<Entry> + ptr_eq` 做归属校验：正常结束、用户取消、窗口销毁
//! 三条路径都会移除条目，且旧流不会误删复用同一 requestId 的新流。
//! `Channel::send` 永不 panic；失败只当作断连信号，取消并交给 RAII 清理。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{State, Window};

use super::client::{AiTransport, CancelToken};
use super::config::{AiConfig, ChatTurn, Provider};
use super::endpoint::AiEndpoint;
use super::error::{AiError, AiResult};
use crate::ipc::error::E_INVALID_ARG;
use crate::ipc::ErrorPayload;

/// requestId 最大长度（`docs/contract.md` §III.1）。
const MAX_REQUEST_ID_BYTES: usize = 128;

impl From<AiError> for ErrorPayload {
    fn from(error: AiError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

/// 单条对话消息。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
}

/// `ai_key_save` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySaveDto {
    /// `"file"` 或 `"memory"`。
    pub storage: &'static str,
    /// 降级到内存时的提示码；文件持久化成功时不出现。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning_code: Option<&'static str>,
}

/// `ai_key_status` 的响应。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatusDto {
    pub configured: bool,
    /// 持久化存储（本地文件）是否可用；字段名保留 `keychainAvailable` 以免破坏契约形状。
    pub keychain_available: bool,
}

/// `ai_list_models` 的响应。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsDto {
    pub models: Vec<String>,
}

/// `ai_test_connection` 的响应：失败走命令错误，成功即 `ok: true`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionDto {
    pub ok: bool,
    pub models: Vec<String>,
}

/// `ai_chat_cancel` 的响应。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelDto {
    pub cancelled: bool,
}

/// `ai_chat_stream` 的请求体：一次调用的完整参数。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamRequest {
    pub request_id: String,
    pub provider: String,
    pub base_url: String,
    pub allow_insecure_http: bool,
    pub model: String,
    pub messages: Vec<ChatMessageDto>,
}

/// 流式事件（`docs/contract.md` §III.1）。
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AiChatEvent {
    Delta {
        request_id: String,
        text: String,
    },
    Done {
        request_id: String,
    },
    Error {
        request_id: String,
        code: &'static str,
        message: String,
    },
}

/// 在途流登记项：取消令牌与所属窗口。
#[derive(Debug)]
struct ChatEntry {
    token: CancelToken,
    window: String,
}

/// 取消表。条目只在同一 `Arc<ChatEntry>` 仍在表内时移除。
#[derive(Debug, Default)]
pub struct ChatRegistry {
    entries: Mutex<HashMap<String, Arc<ChatEntry>>>,
}

impl ChatRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记一条流。requestId 非法或与在途流重复时返回 `E_INVALID_ARG`。
    fn register(&self, request_id: &str, window: &str) -> Result<ChatGuard<'_>, ErrorPayload> {
        validate_request_id(request_id)?;
        let token = CancelToken::new();
        let entry = Arc::new(ChatEntry {
            token: token.clone(),
            window: window.to_string(),
        });
        let mut entries = lock(&self.entries);
        if entries.contains_key(request_id) {
            return Err(invalid_arg("requestId 已被在途请求占用"));
        }
        entries.insert(request_id.to_string(), entry);
        Ok(ChatGuard {
            registry: self,
            request_id: request_id.to_string(),
            token,
        })
    }

    /// 用户取消：置位令牌并立即移除条目，不依赖后续清理兜底。
    fn cancel(&self, request_id: &str) -> bool {
        let entry = lock(&self.entries).remove(request_id);
        match entry {
            Some(entry) => {
                entry.token.cancel();
                true
            }
            None => false,
        }
    }

    /// 窗口销毁：取消该窗口下全部在途流；调用方必须吞掉返回值。
    pub fn cancel_window(&self, window: &str) -> usize {
        let ids: Vec<String> = lock(&self.entries)
            .iter()
            .filter(|(_, entry)| entry.window == window)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter(|id| self.cancel(id)).count()
    }

    #[cfg(test)]
    fn contains(&self, request_id: &str) -> bool {
        lock(&self.entries).contains_key(request_id)
    }
}

/// RAII 清理：离开命令体时只移除自己登记的那一条。
struct ChatGuard<'a> {
    registry: &'a ChatRegistry,
    request_id: String,
    token: CancelToken,
}

impl ChatGuard<'_> {
    fn token(&self) -> CancelToken {
        self.token.clone()
    }
}

impl Drop for ChatGuard<'_> {
    fn drop(&mut self) {
        let mut entries = lock(&self.registry.entries);
        let owned = entries
            .get(&self.request_id)
            .is_some_and(|current| current.token.same_as(&self.token));
        if owned {
            entries.remove(&self.request_id);
        }
    }
}

/// 锁中毒只可能来自持有期间的 panic；这里按「继续用」处理，命令路径不 panic。
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn invalid_arg(message: &str) -> ErrorPayload {
    ErrorPayload::new(E_INVALID_ARG, message)
}

/// requestId：非空、≤128 字节、仅 `[A-Za-z0-9_-]`。
fn validate_request_id(request_id: &str) -> Result<(), ErrorPayload> {
    if request_id.is_empty() {
        return Err(invalid_arg("requestId 不能为空"));
    }
    if request_id.len() > MAX_REQUEST_ID_BYTES {
        return Err(invalid_arg("requestId 超过 128 字节"));
    }
    if !request_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(invalid_arg("requestId 只允许字母、数字、下划线与短横线"));
    }
    Ok(())
}

fn provider_of(raw: &str) -> Result<Provider, ErrorPayload> {
    match raw {
        "ollama" => Ok(Provider::Ollama),
        "openai-compatible" => Ok(Provider::OpenAiCompatible),
        _ => Err(AiError::UnsupportedProvider.into()),
    }
}

#[tauri::command]
pub fn ai_key_save(
    transport: State<'_, AiTransport>,
    provider: String,
    base_url: String,
    allow_insecure_http: bool,
    key: String,
) -> Result<KeySaveDto, ErrorPayload> {
    let provider = provider_of(&provider)?;
    let storage = transport.save_key(provider, &base_url, allow_insecure_http, &key)?;
    Ok(KeySaveDto {
        storage: match storage {
            super::keychain::KeyStorage::File => "file",
            super::keychain::KeyStorage::Memory => "memory",
        },
        warning_code: storage.warning_code(),
    })
}

#[tauri::command]
pub fn ai_key_status(
    transport: State<'_, AiTransport>,
    provider: String,
    base_url: String,
    allow_insecure_http: bool,
) -> Result<KeyStatusDto, ErrorPayload> {
    let provider = provider_of(&provider)?;
    let endpoint = AiEndpoint::parse(&base_url, allow_insecure_http)?;
    let configured = transport.keys().load(provider.id(), &endpoint)?.is_some();
    Ok(KeyStatusDto {
        configured,
        keychain_available: transport.keys().keychain_available(),
    })
}

#[tauri::command]
pub fn ai_key_delete(
    transport: State<'_, AiTransport>,
    provider: String,
    base_url: String,
    allow_insecure_http: bool,
) -> Result<(), ErrorPayload> {
    let provider = provider_of(&provider)?;
    let endpoint = AiEndpoint::parse(&base_url, allow_insecure_http)?;
    transport.keys().delete(provider.id(), &endpoint)?;
    Ok(())
}

#[tauri::command]
pub async fn ai_test_connection(
    transport: State<'_, AiTransport>,
    provider: String,
    base_url: String,
    allow_insecure_http: bool,
) -> Result<TestConnectionDto, ErrorPayload> {
    let models = list_models(transport.inner(), provider, base_url, allow_insecure_http).await?;
    Ok(TestConnectionDto { ok: true, models })
}

#[tauri::command]
pub async fn ai_list_models(
    transport: State<'_, AiTransport>,
    provider: String,
    base_url: String,
    allow_insecure_http: bool,
) -> Result<ModelsDto, ErrorPayload> {
    let models = list_models(transport.inner(), provider, base_url, allow_insecure_http).await?;
    Ok(ModelsDto { models })
}

async fn list_models(
    transport: &AiTransport,
    provider: String,
    base_url: String,
    allow_insecure_http: bool,
) -> Result<Vec<String>, ErrorPayload> {
    let config = AiConfig {
        provider: provider_of(&provider)?,
        base_url,
        allow_insecure_http,
    };
    transport
        .list_models(&config, &CancelToken::new())
        .await
        .map_err(ErrorPayload::from)
}

#[tauri::command]
pub async fn ai_chat_stream(
    window: Window,
    transport: State<'_, AiTransport>,
    registry: State<'_, Arc<ChatRegistry>>,
    request: ChatStreamRequest,
    on_event: Channel<AiChatEvent>,
) -> Result<(), ErrorPayload> {
    let ChatStreamRequest {
        request_id,
        provider,
        base_url,
        allow_insecure_http,
        model,
        messages,
    } = request;
    let config = AiConfig {
        provider: provider_of(&provider)?,
        base_url,
        allow_insecure_http,
    };
    let guard = registry.register(&request_id, window.label())?;
    let token = guard.token();
    run_stream(
        transport.inner(),
        &request_id,
        &config,
        &model,
        &messages,
        &token,
        &on_event,
    )
    .await?;
    drop(guard);
    Ok(())
}

/// 首 delta 之前失败走命令错误；之后失败用 `error` 事件收尾并返回成功。
async fn run_stream(
    transport: &AiTransport,
    request_id: &str,
    config: &AiConfig,
    model: &str,
    messages: &[ChatMessageDto],
    token: &CancelToken,
    channel: &Channel<AiChatEvent>,
) -> Result<(), ErrorPayload> {
    let turns: Vec<ChatTurn<'_>> = messages
        .iter()
        .map(|message| ChatTurn {
            role: message.role.as_str(),
            content: message.content.as_str(),
        })
        .collect();
    let mut started = false;
    let outcome: AiResult<()> = transport
        .stream_chat(config, model, &turns, token, |delta| {
            started = true;
            let sent = channel.send(AiChatEvent::Delta {
                request_id: request_id.to_string(),
                text: delta.to_string(),
            });
            if sent.is_err() {
                // 通道已断：取消本流，由 guard 负责清理，不把 send 结果当存活证明。
                token.cancel();
                return Err(AiError::Cancelled);
            }
            Ok(())
        })
        .await;
    match outcome {
        Ok(()) => {
            let _ = channel.send(AiChatEvent::Done {
                request_id: request_id.to_string(),
            });
            Ok(())
        }
        Err(error) if started => {
            let _ = channel.send(AiChatEvent::Error {
                request_id: request_id.to_string(),
                code: error.code(),
                message: error.to_string(),
            });
            Ok(())
        }
        Err(error) => Err(ErrorPayload::from(error)),
    }
}

#[tauri::command]
pub fn ai_chat_cancel(registry: State<'_, Arc<ChatRegistry>>, request_id: String) -> CancelDto {
    CancelDto {
        cancelled: registry.cancel(&request_id),
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener, TcpStream};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    use serde_json::{json, Value};
    use tauri::ipc::InvokeResponseBody;
    use tempfile::tempdir;

    use super::*;
    use crate::ai::dns::SystemResolver;
    use crate::ai::keychain::KeyStore;

    fn registry() -> ChatRegistry {
        ChatRegistry::new()
    }

    #[test]
    fn rejects_invalid_request_ids() {
        let registry = registry();
        let too_long = "a".repeat(MAX_REQUEST_ID_BYTES + 1);
        for bad in ["", "a b", "a/b", "中文", too_long.as_str()] {
            let error = registry
                .register(bad, "main")
                .err()
                .expect("非法 requestId 应被拒绝");
            assert_eq!(error.code, E_INVALID_ARG, "{bad:?}");
        }
        assert!(registry.register("abc-123_XYZ", "main").is_ok());
    }

    #[test]
    fn duplicate_request_id_is_rejected_while_in_flight() {
        let registry = registry();
        let _first = registry.register("req-1", "main").expect("首次登记");
        let error = registry
            .register("req-1", "main")
            .err()
            .expect("重复 requestId 应被拒绝");
        assert_eq!(error.code, E_INVALID_ARG);
    }

    #[test]
    fn guard_drop_removes_entry() {
        let registry = registry();
        {
            let _guard = registry.register("req-1", "main").expect("登记");
            assert!(registry.contains("req-1"));
        }
        assert!(!registry.contains("req-1"), "离开作用域必须清理");
    }

    #[test]
    fn cancel_removes_entry_immediately_and_cancels_token() {
        let registry = registry();
        let guard = registry.register("req-1", "main").expect("登记");
        let token = guard.token();
        assert!(registry.cancel("req-1"));
        assert!(token.is_cancelled());
        assert!(!registry.contains("req-1"), "取消必须立刻移除条目");
        assert!(!registry.cancel("req-1"), "重复取消返回 false");
        // guard 在条目已被移除后 drop，不应影响后续登记。
        drop(guard);
        assert!(!registry.contains("req-1"));
    }

    #[test]
    fn stale_guard_does_not_remove_new_entry() {
        let registry = registry();
        let old = registry.register("req-1", "main").expect("旧流登记");
        assert!(registry.cancel("req-1"));
        let fresh = registry.register("req-1", "main").expect("复用同一 id");
        drop(old);
        assert!(registry.contains("req-1"), "旧 guard 不得误删新流");
        drop(fresh);
        assert!(!registry.contains("req-1"));
    }

    #[test]
    fn cancel_window_only_touches_its_own_streams() {
        let registry = registry();
        let _a = registry.register("req-a", "main").expect("A");
        let _b = registry.register("req-b", "main").expect("B");
        let _c = registry.register("req-c", "settings").expect("C");
        assert_eq!(registry.cancel_window("main"), 2);
        assert!(!registry.contains("req-a"));
        assert!(!registry.contains("req-b"));
        assert!(registry.contains("req-c"));
        assert_eq!(registry.cancel_window("main"), 0, "重复清理无副作用");
    }

    #[test]
    fn event_payloads_use_contract_shape() {
        assert_eq!(
            serde_json::to_value(AiChatEvent::Delta {
                request_id: "r1".into(),
                text: "hi".into(),
            })
            .expect("序列化 delta"),
            json!({"type": "delta", "requestId": "r1", "text": "hi"})
        );
        assert_eq!(
            serde_json::to_value(AiChatEvent::Done {
                request_id: "r1".into(),
            })
            .expect("序列化 done"),
            json!({"type": "done", "requestId": "r1"})
        );
        assert_eq!(
            serde_json::to_value(AiChatEvent::Error {
                request_id: "r1".into(),
                code: "E_AI_NETWORK",
                message: "网络请求失败".into(),
            })
            .expect("序列化 error"),
            json!({
                "type": "error",
                "requestId": "r1",
                "code": "E_AI_NETWORK",
                "message": "网络请求失败",
            })
        );
    }

    #[test]
    fn provider_mapping_is_stable() {
        assert_eq!(provider_of("ollama").expect("ollama"), Provider::Ollama);
        assert_eq!(
            provider_of("openai-compatible").expect("openai"),
            Provider::OpenAiCompatible
        );
        assert_eq!(
            provider_of("other").expect_err("未知提供方").code,
            "E_AI_UNSUPPORTED_PROVIDER"
        );
    }

    /// 本地 HTTP stub：读完整请求后一次性写出响应。
    struct Stub {
        addr: SocketAddr,
        handle: Option<JoinHandle<()>>,
    }

    impl Stub {
        fn reply(status: &str, content_type: &str, body: &[u8]) -> Self {
            Self::parts(status, content_type, vec![body.to_vec()])
        }

        /// 分段写响应体；段之间留出间隔，让客户端按块读取。
        fn parts(status: &str, content_type: &str, parts: Vec<Vec<u8>>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("绑定回环端口");
            let addr = listener.local_addr().expect("读取本地地址");
            let status = status.to_string();
            let content_type = content_type.to_string();
            let handle = thread::spawn(move || {
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                read_request(&mut stream);
                let total: usize = parts.iter().map(Vec::len).sum();
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(head.as_bytes());
                for part in parts {
                    let _ = stream.write_all(&part);
                    let _ = stream.flush();
                    thread::sleep(Duration::from_millis(20));
                }
            });
            Self {
                addr,
                handle: Some(handle),
            }
        }

        fn base_url(&self) -> String {
            format!("http://{}", self.addr)
        }

        fn join(mut self) {
            if let Some(handle) = self.handle.take() {
                handle.join().expect("stub 线程不应 panic");
            }
        }
    }

    fn read_request(stream: &mut TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 1024];
        let mut need = None;
        loop {
            if let Some(total) = need {
                if buffer.len() >= total {
                    return;
                }
            }
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
            }
            if need.is_none() {
                if let Some(position) = buffer.windows(4).position(|part| part == b"\r\n\r\n") {
                    need = Some(position + 4 + content_length(&buffer[..position]));
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

    fn event_channel() -> (Channel<AiChatEvent>, Arc<Mutex<Vec<Value>>>) {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&captured);
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    lock(&sink).push(value);
                }
            }
            Ok(())
        });
        (channel, captured)
    }

    fn transport(dir: &tempfile::TempDir) -> AiTransport {
        AiTransport::with_parts(KeyStore::with_dir(dir.path().to_path_buf()), SystemResolver)
    }

    fn config(base_url: String) -> AiConfig {
        AiConfig {
            provider: Provider::Ollama,
            base_url,
            allow_insecure_http: false,
        }
    }

    fn messages() -> Vec<ChatMessageDto> {
        vec![ChatMessageDto {
            role: "user".into(),
            content: "你好".into(),
        }]
    }

    #[test]
    fn stream_emits_deltas_then_done_and_cleans_registry() {
        let stub = Stub::reply(
            "200 OK",
            "application/x-ndjson",
            concat!(
                "{\"message\":{\"content\":\"\\u4f60\"},\"done\":false}\n",
                "{\"message\":{\"content\":\"\\u597d\"},\"done\":true}\n"
            )
            .as_bytes(),
        );
        let registry = registry();
        let dir = tempdir().expect("tempdir");
        let transport = transport(&dir);
        let (channel, events) = event_channel();
        let guard = registry.register("req-1", "main").expect("登记");
        let token = guard.token();
        let result = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(run_stream(
                &transport,
                "req-1",
                &config(stub.base_url()),
                "llama3",
                &messages(),
                &token,
                &channel,
            ));
        stub.join();
        result.expect("流应成功");
        drop(guard);
        assert!(!registry.contains("req-1"), "正常结束必须清理条目");
        let events = lock(&events).clone();
        assert_eq!(
            events,
            vec![
                json!({"type": "delta", "requestId": "req-1", "text": "你"}),
                json!({"type": "delta", "requestId": "req-1", "text": "好"}),
                json!({"type": "done", "requestId": "req-1"}),
            ]
        );
    }

    #[test]
    fn failure_before_first_delta_returns_command_error() {
        let stub = Stub::reply("401 Unauthorized", "application/json", b"{}");
        let dir = tempdir().expect("tempdir");
        let transport = transport(&dir);
        let (channel, events) = event_channel();
        let token = CancelToken::new();
        let error = tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(run_stream(
                &transport,
                "req-1",
                &config(stub.base_url()),
                "llama3",
                &messages(),
                &token,
                &channel,
            ))
            .expect_err("首 delta 前失败应走命令错误");
        stub.join();
        assert_eq!(error.code, "E_AI_UNAUTHORIZED");
        assert!(lock(&events).is_empty(), "不应发出任何事件");
    }

    #[test]
    fn failure_after_first_delta_ends_with_error_event() {
        let stub = Stub::parts(
            "200 OK",
            "application/x-ndjson",
            vec![
                b"{\"message\":{\"content\":\"a\"},\"done\":false}\n".to_vec(),
                b"not-json\n".to_vec(),
            ],
        );
        let dir = tempdir().expect("tempdir");
        let transport = transport(&dir);
        let (channel, events) = event_channel();
        let token = CancelToken::new();
        tokio::runtime::Runtime::new()
            .expect("测试运行时")
            .block_on(run_stream(
                &transport,
                "req-1",
                &config(stub.base_url()),
                "llama3",
                &messages(),
                &token,
                &channel,
            ))
            .expect("已有增量后应以事件收尾");
        stub.join();
        let events = lock(&events).clone();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "delta");
        assert_eq!(events[1]["type"], "error");
        assert_eq!(events[1]["code"], "E_AI_INVALID_RESPONSE");
        assert_eq!(events[1]["requestId"], "req-1");
    }
}
