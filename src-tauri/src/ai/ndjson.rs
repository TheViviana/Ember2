//! NDJSON（Ollama 等本地运行时的流式响应）按行解析。
//!
//! 复用 [`LineFramer`] 的半包缓冲与单行上限，只把完整行交给 `serde_json`；
//! 空行不是 JSON 对象，直接跳过。

use serde_json::Value;

use super::error::{AiError, AiResult};
use super::sse::LineFramer;

#[derive(Debug, Default)]
pub struct NdjsonParser {
    framer: LineFramer,
}

impl NdjsonParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段字节，返回本次凑齐的 JSON 行。
    pub fn push(&mut self, chunk: &[u8]) -> AiResult<Vec<Value>> {
        let lines = self.framer.push(chunk)?;
        self.decode(lines)
    }

    /// 流结束：最后一行可能没有换行符，这里补做一次解析。
    pub fn finish(&mut self) -> AiResult<Vec<Value>> {
        match self.framer.finish()? {
            Some(line) => self.decode(vec![line]),
            None => Ok(Vec::new()),
        }
    }

    fn decode(&self, lines: Vec<String>) -> AiResult<Vec<Value>> {
        let mut values = Vec::with_capacity(lines.len());
        for line in lines {
            if line.trim().is_empty() {
                continue;
            }
            values.push(serde_json::from_str(&line).map_err(|_| AiError::InvalidResponse)?);
        }
        Ok(values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_lines_across_chunk_boundaries() {
        let mut parser = NdjsonParser::new();
        assert!(parser
            .push(b"{\"message\":{\"content\":\"hel")
            .expect("解析")
            .is_empty());
        let values = parser
            .push(b"lo\"},\"done\":false}\n{\"done\":true}\n")
            .expect("解析");
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["message"]["content"], "hello");
        assert!(values[1]["done"].as_bool().expect("布尔字段"));
    }

    #[test]
    fn crlf_lines_are_parsed_without_stray_carriage_return() {
        let mut parser = NdjsonParser::new();
        let values = parser
            .push(b"{\"done\":false}\r\n{\"done\":true}\r\n")
            .expect("解析");
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn blank_lines_are_skipped() {
        let mut parser = NdjsonParser::new();
        let values = parser.push(b"\n  \n{\"done\":true}\n\n").expect("解析");
        assert_eq!(values.len(), 1);
    }

    #[test]
    fn finish_parses_last_line_without_newline() {
        let mut parser = NdjsonParser::new();
        assert!(parser.push(b"{\"done\":true}").expect("解析").is_empty());
        let values = parser.finish().expect("冲刷");
        assert_eq!(values.len(), 1);
        assert!(values[0]["done"].as_bool().expect("布尔字段"));
    }

    #[test]
    fn invalid_json_maps_to_invalid_response() {
        let mut parser = NdjsonParser::new();
        let error = parser.push(b"not-json\n").expect_err("非法 JSON");
        assert_eq!(error.code(), "E_AI_INVALID_RESPONSE");
    }

    #[test]
    fn overlong_line_shares_sse_limit() {
        let mut parser = NdjsonParser::new();
        let chunk = vec![b'{'; super::super::sse::MAX_LINE_BYTES + 1];
        let error = parser.push(&chunk).expect_err("超长行");
        assert_eq!(error.code(), "E_AI_RESPONSE_TOO_LARGE");
    }
}
