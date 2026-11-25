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
}

impl Provider {
    /// 凭据账号键与配置里的稳定标识。
    pub fn id(self) -> &'static str {
        match self {
            Self::Ollama => "ollama",
            Self::OpenAiCompatible => "openai-compatible",
        }
    }

    /// 端点解析后的网段策略。
    pub fn policy(self) -> Policy {
        match self {
            Self::Ollama => Policy::Local,
            Self::OpenAiCompatible => Policy::Public,
        }
    }

    pub fn requires_key(self) -> bool {
        matches!(self, Self::OpenAiCompatible)
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
