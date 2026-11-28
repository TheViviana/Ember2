//! AI 层错误：只输出安全文案，不携带请求头、密钥、URL 查询串或响应正文。

use thiserror::Error;

/// 契约错误码（`docs/contract.md` §II）。T5a 定义，T5b 随命令注册接线。
pub const E_AI_NOT_CONFIGURED: &str = "E_AI_NOT_CONFIGURED";
pub const E_AI_INVALID_ENDPOINT: &str = "E_AI_INVALID_ENDPOINT";
pub const E_AI_KEY_MISSING: &str = "E_AI_KEY_MISSING";
pub const E_AI_KEYCHAIN_DENIED: &str = "E_AI_KEYCHAIN_DENIED";
pub const E_AI_UNAUTHORIZED: &str = "E_AI_UNAUTHORIZED";
pub const E_AI_RATE_LIMITED: &str = "E_AI_RATE_LIMITED";
pub const E_AI_TIMEOUT: &str = "E_AI_TIMEOUT";
pub const E_AI_CONNECT_TIMEOUT: &str = "E_AI_CONNECT_TIMEOUT";
pub const E_AI_NETWORK: &str = "E_AI_NETWORK";
pub const E_AI_MODEL_UNAVAILABLE: &str = "E_AI_MODEL_UNAVAILABLE";
pub const E_AI_BAD_REQUEST: &str = "E_AI_BAD_REQUEST";
pub const E_AI_UNSUPPORTED_PROVIDER: &str = "E_AI_UNSUPPORTED_PROVIDER";
pub const E_AI_INVALID_RESPONSE: &str = "E_AI_INVALID_RESPONSE";
pub const E_AI_RESPONSE_TOO_LARGE: &str = "E_AI_RESPONSE_TOO_LARGE";
pub const E_AI_CANCELLED: &str = "E_AI_CANCELLED";

/// AI 传输层错误。`code()` 是 IPC 契约的一部分，改动必须同步 CR。
#[derive(Debug, Error)]
pub enum AiError {
    #[error("尚未配置 AI 提供方")]
    NotConfigured,
    #[error("AI 端点非法：{0}")]
    InvalidEndpoint(String),
    #[error("缺少 API Key")]
    KeyMissing,
    #[error("本地存储不可用：API Key 仅在本次运行内有效，重启后需重填")]
    KeychainDenied,
    #[error("提供方拒绝了凭据")]
    Unauthorized,
    #[error("提供方限流")]
    RateLimited,
    #[error("请求超时")]
    Timeout,
    #[error("连接服务超时")]
    ConnectTimeout,
    #[error("网络请求失败")]
    Network,
    /// 模型不可用：`detail` 来自提供方（如未下载、内存不足、上限过低）。
    #[error("模型不可用：{0}")]
    ModelUnavailable(String),
    /// 提供方拒绝了请求（其余 4xx）：`detail` 为提供方返回的可读原因。
    #[error("提供方拒绝了请求：{0}")]
    BadRequest(String),
    #[error("该提供方不支持获取模型列表")]
    UnsupportedProvider,
    #[error("提供方响应格式非法")]
    InvalidResponse,
    #[error("响应超出大小上限")]
    ResponseTooLarge,
    #[error("请求已取消")]
    Cancelled,
}

impl AiError {
    /// 稳定错误码：前端只认这里，不解析 message 文案。
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotConfigured => E_AI_NOT_CONFIGURED,
            Self::InvalidEndpoint(_) => E_AI_INVALID_ENDPOINT,
            Self::KeyMissing => E_AI_KEY_MISSING,
            Self::KeychainDenied => E_AI_KEYCHAIN_DENIED,
            Self::Unauthorized => E_AI_UNAUTHORIZED,
            Self::RateLimited => E_AI_RATE_LIMITED,
            Self::Timeout => E_AI_TIMEOUT,
            Self::ConnectTimeout => E_AI_CONNECT_TIMEOUT,
            Self::Network => E_AI_NETWORK,
            Self::ModelUnavailable(_) => E_AI_MODEL_UNAVAILABLE,
            Self::BadRequest(_) => E_AI_BAD_REQUEST,
            Self::UnsupportedProvider => E_AI_UNSUPPORTED_PROVIDER,
            Self::InvalidResponse => E_AI_INVALID_RESPONSE,
            Self::ResponseTooLarge => E_AI_RESPONSE_TOO_LARGE,
            Self::Cancelled => E_AI_CANCELLED,
        }
    }
}

pub type AiResult<T> = Result<T, AiError>;

#[cfg(test)]
mod tests {
    use super::*;

    /// 覆盖全部已定义变体：新增变体而漏映射时此表会先红。
    #[test]
    fn every_variant_has_stable_code() {
        let cases: Vec<(AiError, &str)> = vec![
            (AiError::NotConfigured, E_AI_NOT_CONFIGURED),
            (
                AiError::InvalidEndpoint("bad".into()),
                E_AI_INVALID_ENDPOINT,
            ),
            (AiError::KeyMissing, E_AI_KEY_MISSING),
            (AiError::KeychainDenied, E_AI_KEYCHAIN_DENIED),
            (AiError::Unauthorized, E_AI_UNAUTHORIZED),
            (AiError::RateLimited, E_AI_RATE_LIMITED),
            (AiError::Timeout, E_AI_TIMEOUT),
            (AiError::ConnectTimeout, E_AI_CONNECT_TIMEOUT),
            (AiError::Network, E_AI_NETWORK),
            (
                AiError::ModelUnavailable("内存不足".into()),
                E_AI_MODEL_UNAVAILABLE,
            ),
            (AiError::BadRequest("prefill 超限".into()), E_AI_BAD_REQUEST),
            (AiError::UnsupportedProvider, E_AI_UNSUPPORTED_PROVIDER),
            (AiError::InvalidResponse, E_AI_INVALID_RESPONSE),
            (AiError::ResponseTooLarge, E_AI_RESPONSE_TOO_LARGE),
            (AiError::Cancelled, E_AI_CANCELLED),
        ];
        for (error, expected) in cases {
            assert_eq!(error.code(), expected, "错误码映射漂移");
            assert!(!error.to_string().is_empty());
        }
    }
}
