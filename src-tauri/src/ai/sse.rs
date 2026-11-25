//! SSE 字节级解析（T5a commit 2）：只做分帧与协议语义，不碰 HTTP。
//!
//! 三条硬规则：
//! 1. 不提前解码字符串。`LineFramer` 只缓冲字节，凑齐一整行后才做 UTF-8
//!    校验；多字节字符被 chunk 边界切开时，剩余字节留在缓冲里等下一段数据。
//! 2. 单行有硬上限 [`MAX_LINE_BYTES`]。超限立刻返回 `ResponseTooLarge`，
//!    且检查发生在写入缓冲之前，不会先把整段数据塞进 `Vec` 再判断。
//! 3. 换行兼容 `\n` 与 `\r\n`：产出完整行前剔除行尾 `\r`，避免下游 JSON
//!    解析因多余的回车报错。

use super::error::{AiError, AiResult};

/// 单行字节上限（1 MiB）。超过即视为异常响应，防止上游一直不发换行把内存撑爆。
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

/// 按 `\n` / `\r\n` 切行的增量缓冲。
#[derive(Debug, Default)]
pub struct LineFramer {
    buf: Vec<u8>,
}

impl LineFramer {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段字节，返回本次凑齐的完整行（已去除行尾 `\r`）。
    ///
    /// 未以换行结束的残余字节留在内部缓冲，等下一次 `push` 拼成完整行；
    /// 此时**不做** UTF-8 解码，因此切开多字节字符不会 panic。
    pub fn push(&mut self, chunk: &[u8]) -> AiResult<Vec<String>> {
        let mut lines = Vec::new();
        let mut cursor = 0usize;
        while cursor < chunk.len() {
            let Some(offset) = chunk[cursor..].iter().position(|byte| *byte == b'\n') else {
                let rest = &chunk[cursor..];
                // 先判上限再拷贝：即使上游一次塞进上百 MB 也不会有超额分配。
                if self.buf.len() + rest.len() > MAX_LINE_BYTES {
                    self.buf.clear();
                    return Err(AiError::ResponseTooLarge);
                }
                self.buf.extend_from_slice(rest);
                return Ok(lines);
            };
            let end = cursor + offset;
            let segment = &chunk[cursor..end];
            if self.buf.len() + segment.len() > MAX_LINE_BYTES {
                self.buf.clear();
                return Err(AiError::ResponseTooLarge);
            }
            self.buf.extend_from_slice(segment);
            lines.push(self.take_line()?);
            cursor = end + 1;
        }
        Ok(lines)
    }

    /// 流结束时冲刷没有换行符的最后一行；正常以 `\n` 结尾的流返回 `None`。
    pub fn finish(&mut self) -> AiResult<Option<String>> {
        if self.buf.is_empty() {
            return Ok(None);
        }
        self.take_line().map(Some)
    }

    /// 取出一整行：先剔除 CRLF 的 `\r`，再整体做 UTF-8 校验。
    fn take_line(&mut self) -> AiResult<String> {
        let bytes = if self.buf.last() == Some(&b'\r') {
            &self.buf[..self.buf.len() - 1]
        } else {
            &self.buf
        };
        let decoded = std::str::from_utf8(bytes)
            .map(str::to_string)
            .map_err(|_| AiError::InvalidResponse);
        self.buf.clear();
        decoded
    }
}

/// 一个已 dispatch 的 SSE 事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    event: Option<String>,
    data: String,
    id: Option<String>,
}

impl SseEvent {
    /// 事件名；`None` 表示规范里的默认类型 `message`。
    pub fn event(&self) -> Option<&str> {
        self.event.as_deref()
    }

    /// 多行 `data:` 已按规范用 `\n` 连接，且不含末尾换行。
    pub fn data(&self) -> &str {
        &self.data
    }

    pub fn id(&self) -> Option<&str> {
        self.id.as_deref()
    }

    /// OpenAI 兼容流以 `data: [DONE]` 收尾。
    pub fn is_done(&self) -> bool {
        self.data.trim() == "[DONE]"
    }
}

/// SSE 事件解析器：把字节流变成已 dispatch 的事件。
///
/// 只有空行才 dispatch；空行包括只含空白字符的行（上游偶尔带尾随空格）。
/// `data:` 后面没有任何内容时不产生事件，避免向下游推送空片段。
#[derive(Debug, Default)]
pub struct SseParser {
    framer: LineFramer,
    event: Option<String>,
    data: Option<String>,
    id: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段字节，返回本次凑齐的完整行。半行会留在内部缓冲。
    pub fn push(&mut self, chunk: &[u8]) -> AiResult<Vec<SseEvent>> {
        let lines = self.framer.push(chunk)?;
        let mut events = Vec::new();
        for line in lines {
            if let Some(event) = self.consume_line(&line) {
                events.push(event);
            }
        }
        Ok(events)
    }

    /// 流结束：按 SSE 规范丢弃未以空行结尾的未完成事件。
    pub fn finish(&mut self) {
        self.event = None;
        self.data = None;
        self.id = None;
    }

    fn consume_line(&mut self, line: &str) -> Option<SseEvent> {
        // ` " "` 这类只含空白的行视作空行：不能 panic，也不能让已收到的事件
        // 一直悬着和下一个事件的数据粘在一起。
        if line.trim().is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            // 注释 / keepalive。
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(index) => {
                let raw = &line[index + 1..];
                // 规范只允许 `:` 后有一个可选的单个空格。
                (&line[..index], raw.strip_prefix(' ').unwrap_or(raw))
            }
            None => (line, ""),
        };
        match field {
            "data" => {
                let buffer = self.data.get_or_insert_with(String::new);
                buffer.push_str(value);
                buffer.push('\n');
            }
            // 空事件名按默认 `message` 处理。
            "event" => self.event = (!value.is_empty()).then(|| value.to_string()),
            "id" => self.id = Some(value.to_string()),
            // 其余字段（含 retry）对当前传输层无意义，忽略。
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event = self.event.take();
        let data = self.data.take();
        let buffer = data?;
        // 去掉每行追加的末尾换行；空内容不产生事件。
        let payload = buffer.strip_suffix('\n').unwrap_or(&buffer);
        if payload.is_empty() {
            return None;
        }
        Some(SseEvent {
            event,
            data: payload.to_string(),
            id: self.id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按 chunk 序列喂数据，收集全部事件。
    fn parse(chunks: &[&[u8]]) -> AiResult<Vec<SseEvent>> {
        let mut parser = SseParser::new();
        let mut events = Vec::new();
        for chunk in chunks {
            events.extend(parser.push(chunk)?);
        }
        Ok(events)
    }

    #[test]
    fn dispatches_on_blank_line_for_both_newline_styles() {
        let events = parse(&[b"data: lf\n\ndata: crlf\r\n\r\n"]).expect("解析");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data(), "lf");
        assert_eq!(events[1].data(), "crlf");
        // CRLF 的 `\r` 必须在切行时剔除，不能漏到 data 里。
        assert!(!events.iter().any(|event| event.data().contains('\r')));
    }

    #[test]
    fn keeps_partial_line_and_crlf_boundary_across_chunks() {
        // 半包：行内容、CRLF 的 \r 与 \n、空行都被切成两段。
        let events = parse(&[b"data: hel", b"lo\r", b"\n\r", b"\n"]).expect("解析");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data(), "hello");
    }

    #[test]
    fn emits_multiple_events_within_one_chunk() {
        let events = parse(&[b"data: a\n\ndata: b\n\ndata: c\n\n"]).expect("解析");
        let data: Vec<&str> = events.iter().map(SseEvent::data).collect();
        assert_eq!(data, ["a", "b", "c"]);
    }

    #[test]
    fn joins_multiline_data_with_newline() {
        let events = parse(&[b"data: {\"a\":\ndata: 1}\n\n"]).expect("解析");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data(), "{\"a\":\n1}");
    }

    #[test]
    fn records_event_name_id_and_ignores_comments() {
        let events = parse(&[b": keepalive\nevent: delta\nid: 42\ndata: hi\n\n"]).expect("解析");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event(), Some("delta"));
        assert_eq!(events[0].id(), Some("42"));
        assert_eq!(events[0].data(), "hi");
    }

    #[test]
    fn recognizes_done_sentinel() {
        let events = parse(&[b"data: [DONE]\n\n"]).expect("解析");
        assert_eq!(events.len(), 1);
        assert!(events[0].is_done());
        assert!(!events[0].data().contains('\n'));
    }

    #[test]
    fn empty_data_never_panics_or_emits_event() {
        for chunk in [
            b"data:\n\n".as_slice(),
            b"data: \n\n".as_slice(),
            b"data:\r\n\r\n".as_slice(),
        ] {
            let events = parse(&[chunk]).expect("解析");
            assert!(events.is_empty(), "{chunk:?} 不应产生事件");
        }
    }

    #[test]
    fn whitespace_only_line_acts_as_blank_line() {
        // 带空格的空行必须 dispatch 已收到的事件，而不是继续攒着。
        let events = parse(&[b"data: x\n \n"]).expect("解析");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data(), "x");
        assert!(parse(&[b" \n"]).expect("解析").is_empty());
    }

    #[test]
    fn comment_only_stream_yields_no_event() {
        assert!(parse(&[b": ping\n\n: ping\n\n"]).expect("解析").is_empty());
    }

    #[test]
    fn multibyte_character_split_across_chunks_waits_for_rest() {
        // "你" = E4 BD A0，故意在三个字节之间切开。
        let events = parse(&[b"data: \xe4", b"\xbd", b"\xa0\n\n"]).expect("解析");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data(), "你");
    }

    #[test]
    fn invalid_utf8_is_invalid_response() {
        let error = parse(&[b"data: \xff\n\n"]).expect_err("非法 UTF-8");
        assert_eq!(error.code(), "E_AI_INVALID_RESPONSE");
    }

    #[test]
    fn overlong_line_without_newline_fails_at_limit() {
        let mut parser = SseParser::new();
        let half = vec![b'a'; MAX_LINE_BYTES];
        assert!(parser.push(&half).expect("恰好到上限仍可缓冲").is_empty());
        let error = parser.push(b"a").expect_err("超过上限立即失败");
        assert_eq!(error.code(), "E_AI_RESPONSE_TOO_LARGE");
    }

    #[test]
    fn overlong_line_inside_single_chunk_fails_before_buffering() {
        let mut parser = SseParser::new();
        let mut chunk = vec![b'a'; MAX_LINE_BYTES + 1];
        chunk.push(b'\n');
        let error = parser.push(&chunk).expect_err("带换行的超长行也要失败");
        assert_eq!(error.code(), "E_AI_RESPONSE_TOO_LARGE");
    }

    #[test]
    fn line_exactly_at_limit_is_accepted() {
        let mut line = vec![b'a'; MAX_LINE_BYTES];
        line.push(b'\n');
        let mut parser = SseParser::new();
        // 这里只验证分帧不误杀，不构造完整事件（没有空行）。
        let framer_lines = LineFramer::new().push(&line).expect("边界行应放行");
        assert_eq!(framer_lines.len(), 1);
        assert_eq!(framer_lines[0].len(), MAX_LINE_BYTES);
        assert!(parser.push(&line).expect("解析").is_empty());
    }

    #[test]
    fn finish_discards_unterminated_event() {
        let mut parser = SseParser::new();
        assert!(parser.push(b"data: tail\n").expect("解析").is_empty());
        parser.finish();
        // 规范：没有空行结尾的事件不 dispatch，且不能和后续事件粘连。
        assert_eq!(parser.push(b"data: next\n\n").expect("解析").len(), 1);
    }
}
