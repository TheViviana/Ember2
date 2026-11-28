//! AI 提供方配置（T5a commit 4）。
//!
//! 只描述"用哪个协议、访问哪个基址"，不含密钥与 UI 状态；密钥由
//! `ai::keychain` 按 `{provider}:v1:{origin}` 单独存取。

use super::dns::Policy;

/// 支持的提供方协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// 本地运行时：允许回环与私网，不需要 API Key。
    Ollama,
    /// OpenAI 兼容端点：只允许公网地址，需要 API Key。
    OpenAiCompatible,
    /// 本地 OpenAI 兼容运行时（LM Studio / vLLM / oMLX 等）：允许回环与
    /// 私网，Key 可选（有则随请求携带，无则匿名访问）。
    OpenAiCompatibleLocal,
}

impl Provider {
    /// 凭据账号键与配置里的稳定标识。
    pub fn id(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai-compatible",
            Self::OpenAiCompatibleLocal => "openai-compatible-local",
        }
    }

    /// 端点解析后的网段策略。
    pub fn policy(self) -> Policy {
        match self {
            Self::Ollama | Self::OpenAiCompatibleLocal => Policy::Local,
            Self::OpenAiCompatible => Policy::Public,
        }
    }

    pub fn requires_key(self) -> bool {
        matches!(self, Self::OpenAiCompatible)
    }

    /// 本地 OpenAI 兼容端点：Key 可选。有 Key 就发 Authorization，
    /// 没有也允许访问（oMLX / LM Studio / 部分 vLLM 默认不校验 Key）。
    pub fn key_optional(self) -> bool {
        matches!(self, Self::OpenAiCompatibleLocal)
    }
}

/// 一次调用的目标配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiConfig {
    pub provider: Provider,
    pub base_url: String,
    /// 允许明文 HTTP 指向非回环地址（默认拒绝）。
    pub allow_insecure_http: bool,
}

/// 对话消息（只保留协议需要的两个字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChatTurn<'a> {
    pub role: &'a str,
    pub content: &'a str,
}
