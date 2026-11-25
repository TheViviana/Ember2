//! AI 传输层（T5a）：只做网络与密钥逻辑，不依赖 GUI。
//!
//! 模块边界：`endpoint` 负责 URL 静态校验，`dns` 负责解析结果的网段判定与
//! 钉死快照，`sse` / `ndjson` 负责流式响应的字节级分帧与解析，`client`
//! 负责实际 HTTP 收发、取消与门面，`keychain` 负责密钥存取，`commands` 负责 IPC 接线。

pub mod client;
pub mod commands;
pub mod config;
pub mod dns;
pub mod endpoint;
pub mod error;
pub mod keychain;
pub mod ndjson;
pub mod sse;
