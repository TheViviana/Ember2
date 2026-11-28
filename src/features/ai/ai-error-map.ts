/**
 * T1-AI-A：AI 端点与错误码（Rust E_AI_*）到前端中文文案的映射。
 *
 * 与 src-tauri/src/ai/error.rs 严格对齐（15 个码）。
 */

export interface AiErrorMessage {
  readonly text: string;
  readonly tone: 'info' | 'warning' | 'error';
}

/**
 * 将 Rust error.rs 中的 E_AI_* 码映射到中文文案。
 * 未知码回退为通用错误 + tone=error。
 *
 * Rust 定义（src-tauri/src/ai/error.rs）：
 *   E_AI_NOT_CONFIGURED / E_AI_INVALID_ENDPOINT / E_AI_KEY_MISSING /
 *   E_AI_KEYCHAIN_DENIED / E_AI_UNAUTHORIZED / E_AI_RATE_LIMITED /
 *   E_AI_TIMEOUT / E_AI_CONNECT_TIMEOUT / E_AI_NETWORK /
 *   E_AI_MODEL_UNAVAILABLE / E_AI_BAD_REQUEST / E_AI_UNSUPPORTED_PROVIDER /
 *   E_AI_INVALID_RESPONSE / E_AI_RESPONSE_TOO_LARGE / E_AI_CANCELLED
 */
export function mapAiErrorCode(code: string | undefined, rawMessage?: string): AiErrorMessage {
  if (code === undefined || code === '') {
    return { text: '操作失败：' + (rawMessage ?? '未知错误'), tone: 'error' };
  }

  switch (code) {
    case 'E_AI_NOT_CONFIGURED':
      return { text: '尚未配置 AI 端点，请填写 Provider / Base URL / Key', tone: 'warning' };
    case 'E_AI_INVALID_ENDPOINT':
      return {
        text: '端点地址无效：公网提供方不能访问本机/局域网；本地模型请选「本地模型（OpenAI 兼容）」并填写 http://127.0.0.1:8000/v1 这类地址（非回环 http 需勾选「允许不安全 HTTP」）',
        tone: 'error',
      };
    case 'E_AI_KEY_MISSING':
      return { text: '缺少 API Key，请填写后保存', tone: 'error' };
    case 'E_AI_KEYCHAIN_DENIED':
      return { text: '写入本地失败；已自动降级为内存（重启后需重填）', tone: 'warning' };
    case 'E_AI_UNAUTHORIZED':
      return { text: 'API Key 无效或已过期（401/403）', tone: 'error' };
    case 'E_AI_RATE_LIMITED':
      return { text: '请求频率过高，请稍后再试', tone: 'warning' };
    case 'E_AI_TIMEOUT':
      return { text: '请求超时，请检查网络或重试', tone: 'warning' };
    case 'E_AI_CONNECT_TIMEOUT':
      return { text: '连接超时，请检查 Base URL 是否可达', tone: 'error' };
    case 'E_AI_NETWORK':
      return { text: '网络连接失败，请检查网络或 Base URL', tone: 'error' };
    case 'E_AI_MODEL_UNAVAILABLE':
      // Rust 文案已带「模型不可用：<提供方原因>」；有原因就直接展示。
      return {
        text: rawMessage !== undefined && rawMessage.length > 0
          ? rawMessage
          : '模型不可用：可能未下载、名称不对或内存不足',
        tone: 'warning',
      };
    case 'E_AI_BAD_REQUEST':
      return {
        text: rawMessage !== undefined && rawMessage.length > 0
          ? rawMessage
          : '提供方拒绝了请求，请检查 Base URL、模型与参数',
        tone: 'error',
      };
    case 'E_AI_UNSUPPORTED_PROVIDER':
      return { text: '不支持的 Provider 类型（应用内部错误）', tone: 'error' };
    case 'E_AI_INVALID_RESPONSE':
      return { text: '服务返回无法解析的响应，请换 Provider 或重试', tone: 'error' };
    case 'E_AI_RESPONSE_TOO_LARGE':
      return { text: '响应过大，请换小模型或缩短上下文', tone: 'warning' };
    case 'E_AI_CANCELLED':
      return { text: '请求已取消', tone: 'info' };
    default: {
      // 未知码：同时保留原始码 + rawMessage（若提供）
      const suffix = rawMessage && rawMessage.length > 0
        ? `${code}：${rawMessage}`
        : code;
      return { text: '操作失败：' + suffix, tone: 'error' };
    }
  }
}

/**
 * 模型列表拉取失败的专用文案。
 *
 * 设置页拉模型时，503 等错误不应复用「请在聊天时选择其他模型」——
 * 此时列表为空，用户需要的是真实原因与手动填写模型的出口。
 */
export function describeModelListError(
  code: string | undefined,
  rawMessage?: string,
): AiErrorMessage {
  if (code === 'E_AI_MODEL_UNAVAILABLE') {
    return {
      text: '拉取模型失败：模型服务暂不可用（HTTP 503）。请确认服务已启动，或直接在下方的「模型 ID」手动填写。',
      tone: 'warning',
    };
  }
  const mapped = mapAiErrorCode(code, rawMessage);
  return { text: '拉取模型失败：' + mapped.text, tone: mapped.tone };
}
