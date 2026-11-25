//! 联网翻译：不依赖 AI Key，首段竞速 Google / MyMemory，单次任务内黏性首选并失败回退。

use std::future::Future;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

#[derive(Debug, Serialize)]
pub struct TranslateErrorPayload {
    pub code: &'static str,
    pub message: String,
}

/// 联网翻译事件（CR-20261121-41/42/43）：`progress` 报进度，`segment` 按段落成对推送
/// （`index` 段落序号、`source` 原文片段、`text` 该段译文）——前端把译文内联到
/// 阅读视图对应段落下方（对照），不再集中成块。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TranslateEvent {
    Progress {
        done: u32,
        total: u32,
    },
    Segment {
        index: u32,
        source: String,
        text: String,
    },
}

/// 进度计数纯逻辑（不含 Channel，便于单测）：`done`/`total` 只增不减，step 不越过 total。
/// `done` 已完成的端点请求数，`total` 当前计划数；Google 段回退 MyMemory 时按子段数上调。
struct ProgressTracker {
    done: u32,
    total: u32,
}

impl ProgressTracker {
    fn new(total: usize) -> Self {
        Self {
            done: 0,
            total: total.max(1) as u32,
        }
    }

    fn grow_total(&mut self, extra: usize) {
        self.total += extra as u32;
    }

    fn step(&mut self) {
        self.done = (self.done + 1).min(self.total);
    }

    #[cfg(test)]
    fn counts(&self) -> (u32, u32) {
        (self.done, self.total)
    }
}

/// 事件发送 best-effort：通道关闭（窗口关闭/取消）只当断连，不影响翻译本身。
fn report_progress(tracker: &ProgressTracker, on_event: &Channel<TranslateEvent>) {
    let _ = on_event.send(TranslateEvent::Progress {
        done: tracker.done,
        total: tracker.total,
    });
}

fn fail(code: &'static str, message: impl Into<String>) -> TranslateErrorPayload {
    TranslateErrorPayload {
        code,
        message: message.into(),
    }
}

/// Google 免费端点单次请求的安全长度（按字符计，中文 URL 编码后约 3 倍字节）。
const GOOGLE_CHUNK_CHARS: usize = 1_800;

/// MyMemory 单次请求上限约 500 字节，中文按字符切得更保守。
const MYMEMORY_CHUNK_CHARS: usize = 450;

/// 总量兜底：超过视为误操作，返回明确错误而不是发上百次请求。
const MAX_TOTAL_CHARS: usize = 200_000;

/// 对照翻译段数上限（CR-20261121-42）：段落级逐段请求，段数过多视为误操作。
const MAX_SEGMENTS: usize = 500;

/// 目标语言名（设置面板展示用）→ 翻译端点语言码。
fn lang_code(target: &str) -> Option<&'static str> {
    match target.trim() {
        "中文" | "zh" | "zh-CN" | "zh-cn" => Some("zh-CN"),
        "英文" | "en" => Some("en"),
        "日文" | "ja" => Some("ja"),
        "韩文" | "ko" => Some("ko"),
        "法文" | "fr" => Some("fr"),
        "德文" | "de" => Some("de"),
        "西班牙文" | "es" => Some("es"),
        _ => None,
    }
}

fn parse_google(value: &serde_json::Value) -> Option<String> {
    let segments = value.get(0)?.as_array()?;
    let mut output = String::new();
    for segment in segments {
        if let Some(part) = segment.get(0).and_then(|item| item.as_str()) {
            output.push_str(part);
        }
    }
    let trimmed = output.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn parse_mymemory(value: &serde_json::Value) -> Option<String> {
    // CR-20261121-45：responseStatus != 200 时 translatedText 是错误文案（如源语言非法），
    // 若不校验会把错误提示当译文写入文档（数据污染）。status 缺失视为成功（向前兼容）。
    let status = value
        .get("responseStatus")
        .and_then(|v| v.as_i64())
        .unwrap_or(200);
    if status != 200 {
        return None;
    }
    let text = value.get("responseData")?.get("translatedText")?.as_str()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// CR-20261121-45：MyMemory 不接受 `auto` 源语言（HTTP 200 + 错误文案），
/// 其专有的 `Autodetect` 源语言实测可用（返回 detectedLanguage）。
fn mymemory_langpair(code: &str) -> String {
    format!("Autodetect|{code}")
}

/// CR-20261121-45：网络请求单次重试（500ms 退避）——两个端点均偶发瞬断，
/// 双双失败即整段报错；重试覆盖瞬时抖动。第二连失败返回首错误。
async fn get_with_retry(
    client: &reqwest::Client,
    url: &str,
    query: &[(&str, &str)],
) -> Result<reqwest::Response, reqwest::Error> {
    match client.get(url).query(query).send().await {
        Ok(response) => Ok(response),
        Err(first) => {
            tokio::time::sleep(Duration::from_millis(500)).await;
            client.get(url).query(query).send().await.map_err(|_| first)
        }
    }
}

async fn google_translate(
    client: &reqwest::Client,
    text: &str,
    code: &str,
) -> Result<String, TranslateErrorPayload> {
    let response = get_with_retry(
        client,
        "https://translate.googleapis.com/translate_a/single",
        &[
            ("client", "gtx"),
            ("sl", "auto"),
            ("tl", code),
            ("dt", "t"),
            ("q", text),
        ],
    )
    .await
    .map_err(|_| fail("E_TRANSLATE_NETWORK", "联网翻译网络请求失败"))?;
    if !response.status().is_success() {
        return Err(fail("E_TRANSLATE_HTTP", "联网翻译服务返回错误状态"));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|_| fail("E_TRANSLATE_INVALID_RESPONSE", "联网翻译响应格式非法"))?;
    parse_google(&payload).ok_or_else(|| fail("E_TRANSLATE_INVALID_RESPONSE", "联网翻译未返回译文"))
}

async fn mymemory_translate(
    client: &reqwest::Client,
    text: &str,
    code: &str,
) -> Result<String, TranslateErrorPayload> {
    let pair = mymemory_langpair(code);
    let response = get_with_retry(
        client,
        "https://api.mymemory.translated.net/get",
        &[("q", text), ("langpair", pair.as_str())],
    )
    .await
    .map_err(|_| fail("E_TRANSLATE_NETWORK", "联网翻译网络请求失败"))?;
    if !response.status().is_success() {
        return Err(fail("E_TRANSLATE_HTTP", "联网翻译服务返回错误状态"));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|_| fail("E_TRANSLATE_INVALID_RESPONSE", "联网翻译响应格式非法"))?;
    parse_mymemory(&payload)
        .ok_or_else(|| fail("E_TRANSLATE_INVALID_RESPONSE", "联网翻译未返回译文"))
}

/// 按句末标点/换行切句，保留标点本身；返回的片段拼回去等于原文。
fn split_sentences(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        if matches!(ch, '\n' | '。' | '！' | '？' | '.' | '!' | '?' | '；' | ';') {
            let end = index + ch.len_utf8();
            parts.push(&text[start..end]);
            start = end;
        }
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

/// 第 `count` 个字符的字节偏移（越界返回文本长度）。
fn char_boundary(text: &str, count: usize) -> usize {
    text.char_indices()
        .nth(count)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

/// 把长文切成不超过 `limit` 个字符的片段：优先在句末断开，单句超长时按字符硬切。
///
/// 免费端点的长度限制只针对"单次请求"，切成多段后逐段翻译即可覆盖整篇文档。
fn split_chunks(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(1);
    let mut chunks: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_chars = 0usize;
    for sentence in split_sentences(text) {
        let mut rest = sentence;
        while !rest.is_empty() {
            let rest_chars = rest.chars().count();
            if current_chars + rest_chars <= limit {
                current.push_str(rest);
                current_chars += rest_chars;
                rest = "";
            } else if current_chars == 0 {
                let cut = char_boundary(rest, limit);
                chunks.push(rest[..cut].to_string());
                rest = &rest[cut..];
            } else {
                chunks.push(std::mem::take(&mut current));
                current_chars = 0;
            }
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks.retain(|chunk| !chunk.trim().is_empty());
    chunks
}

/// 按空行分段（CR-20261121-43，对照内联的段落口径）：段内保留单换行，返回非空段落。
///
/// 围栏感知：``` / ~~~ 代码围栏与独占一行的 `$$` 公式围栏内部的空行**不**切断段落，
/// 与前端展示层 `splitTranslateParagraphs` 必须逐字节一致（同一测试向量双侧钉住）。
fn split_paragraphs(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n");
    let mut paragraphs: Vec<String> = Vec::new();
    let mut buffer: Vec<&str> = Vec::new();
    let mut in_code_fence = false;
    let mut in_math_fence = false;
    for line in normalized.split('\n') {
        let trimmed = line.trim();
        if !in_math_fence && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            in_code_fence = !in_code_fence;
        }
        if !in_code_fence && trimmed == "$$" {
            in_math_fence = !in_math_fence;
        }
        if !in_code_fence && !in_math_fence && trimmed.is_empty() {
            let paragraph = buffer.join("\n");
            let paragraph = paragraph.trim();
            if !paragraph.is_empty() {
                paragraphs.push(paragraph.to_string());
            }
            buffer.clear();
        } else {
            buffer.push(line);
        }
    }
    let paragraph = buffer.join("\n");
    let paragraph = paragraph.trim();
    if !paragraph.is_empty() {
        paragraphs.push(paragraph.to_string());
    }
    paragraphs
}

/// 对照翻译段规划结果：`paragraph_index` 是所属段落序号（从 0 起，超长切分的
/// 多个子段共享同一序号），`source` 是实际请求翻译的原文片段。
#[derive(Debug)]
struct PlannedSegment {
    paragraph_index: u32,
    source: String,
}

/// 把整篇文本规划为对照翻译段（CR-20261121-42/43）：按段落切分，超长段落按句切到
/// `GOOGLE_CHUNK_CHARS`（子段共享段落序号）。段数超上限返回 `E_TRANSLATE_TOO_LONG`。
fn plan_segments(text: &str) -> Result<Vec<PlannedSegment>, TranslateErrorPayload> {
    let mut segments: Vec<PlannedSegment> = Vec::new();
    for (paragraph_index, paragraph) in split_paragraphs(text).into_iter().enumerate() {
        let paragraph_index = paragraph_index as u32;
        if paragraph.chars().count() <= GOOGLE_CHUNK_CHARS {
            segments.push(PlannedSegment {
                paragraph_index,
                source: paragraph,
            });
        } else {
            for piece in split_chunks(&paragraph, GOOGLE_CHUNK_CHARS) {
                segments.push(PlannedSegment {
                    paragraph_index,
                    source: piece,
                });
            }
        }
    }
    if segments.len() > MAX_SEGMENTS {
        return Err(fail(
            "E_TRANSLATE_TOO_LONG",
            format!("单次对照翻译最多 {} 段，请分次翻译", MAX_SEGMENTS),
        ));
    }
    Ok(segments)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Provider {
    Google,
    MyMemory,
}

impl Provider {
    fn other(self) -> Self {
        match self {
            Self::Google => Self::MyMemory,
            Self::MyMemory => Self::Google,
        }
    }
}

/// 单个对照片段：Google 一段一个，MyMemory 按请求上限拆成多个。
#[derive(Debug)]
struct TranslatedPiece {
    source: String,
    text: String,
}

/// 一条线路完整译完一个规划段后的结果；未完整成功前不向 UI 提交任何片段。
#[derive(Debug)]
struct SegmentOutput {
    provider: Provider,
    pieces: Vec<TranslatedPiece>,
}

impl SegmentOutput {
    fn full_text(&self) -> String {
        self.pieces
            .iter()
            .map(|piece| piece.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

async fn translate_with_provider(
    client: &reqwest::Client,
    provider: Provider,
    source: &str,
    code: &str,
) -> Result<SegmentOutput, TranslateErrorPayload> {
    match provider {
        Provider::Google => {
            let text = google_translate(client, source, code).await?;
            Ok(SegmentOutput {
                provider,
                pieces: vec![TranslatedPiece {
                    source: source.to_string(),
                    text,
                }],
            })
        }
        Provider::MyMemory => {
            let parts = split_chunks(source, MYMEMORY_CHUNK_CHARS);
            let mut pieces = Vec::with_capacity(parts.len());
            for part in parts {
                let text = mymemory_translate(client, &part, code).await?;
                pieces.push(TranslatedPiece { source: part, text });
            }
            Ok(SegmentOutput { provider, pieces })
        }
    }
}

/// 首个实际翻译段双线路竞速：完整成功者胜出；先失败则等待另一路。
/// 任一路先成功时另一 Future 随本函数返回被丢弃，不会产生 UI 事件。
async fn race_providers(
    google: impl Future<Output = Result<SegmentOutput, TranslateErrorPayload>>,
    mymemory: impl Future<Output = Result<SegmentOutput, TranslateErrorPayload>>,
) -> Result<SegmentOutput, TranslateErrorPayload> {
    tokio::pin!(google);
    tokio::pin!(mymemory);
    tokio::select! {
        result = &mut google => match result {
            Ok(output) => Ok(output),
            Err(google_error) => match mymemory.await {
                Ok(output) => Ok(output),
                Err(_) => Err(google_error),
            },
        },
        result = &mut mymemory => match result {
            Ok(output) => Ok(output),
            Err(_) => google.await,
        },
    }
}

/// 后续段只跑首选；失败再跑另一路。双败仍返回 Google 错误。
async fn translate_with_fallback<F, Fut>(
    preferred: Provider,
    mut run: F,
) -> Result<SegmentOutput, TranslateErrorPayload>
where
    F: FnMut(Provider) -> Fut,
    Fut: Future<Output = Result<SegmentOutput, TranslateErrorPayload>>,
{
    match run(preferred).await {
        Ok(output) => Ok(output),
        Err(primary_error) => match run(preferred.other()).await {
            Ok(output) => Ok(output),
            Err(fallback_error) => Err(match preferred {
                Provider::Google => primary_error,
                Provider::MyMemory => fallback_error,
            }),
        },
    }
}

/// 只提交完整胜线结果。泛型事件出口让进度与顺序可在无 Tauri 运行时下单测。
fn emit_success(
    output: &SegmentOutput,
    paragraph_index: u32,
    tracker: &mut ProgressTracker,
    mut emit: impl FnMut(TranslateEvent),
) {
    if output.pieces.len() > 1 {
        tracker.grow_total(output.pieces.len() - 1);
        emit(TranslateEvent::Progress {
            done: tracker.done,
            total: tracker.total,
        });
    }
    for piece in &output.pieces {
        tracker.step();
        emit(TranslateEvent::Progress {
            done: tracker.done,
            total: tracker.total,
        });
        emit(TranslateEvent::Segment {
            index: paragraph_index,
            source: piece.source.clone(),
            text: piece.text.clone(),
        });
    }
}

#[tauri::command]
pub async fn translate_online(
    text: String,
    target_lang: String,
    on_event: Channel<TranslateEvent>,
) -> Result<String, TranslateErrorPayload> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(fail("E_TRANSLATE_EMPTY", "没有可翻译的内容"));
    }
    if text.chars().count() > MAX_TOTAL_CHARS {
        return Err(fail(
            "E_TRANSLATE_TOO_LONG",
            format!("单次联网翻译最多 {} 字符", MAX_TOTAL_CHARS),
        ));
    }
    let code =
        lang_code(&target_lang).ok_or_else(|| fail("E_TRANSLATE_LANGUAGE", "不支持的目标语言"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36")
        .build()
        .map_err(|_| fail("E_TRANSLATE_NETWORK", "联网翻译客户端初始化失败"))?;

    let segments = plan_segments(&text)?;
    if segments.is_empty() {
        return Err(fail("E_TRANSLATE_EMPTY", "没有可翻译的内容"));
    }
    let mut tracker = ProgressTracker::new(segments.len());
    report_progress(&tracker, &on_event);
    let mut outputs = Vec::with_capacity(segments.len());

    let first = &segments[0];
    let output = race_providers(
        translate_with_provider(&client, Provider::Google, &first.source, code),
        translate_with_provider(&client, Provider::MyMemory, &first.source, code),
    )
    .await?;
    let mut preferred = output.provider;
    emit_success(&output, first.paragraph_index, &mut tracker, |event| {
        let _ = on_event.send(event);
    });
    outputs.push(output.full_text());

    for segment in &segments[1..] {
        let output = translate_with_fallback(preferred, |provider| {
            translate_with_provider(&client, provider, &segment.source, code)
        })
        .await?;
        preferred = output.provider;
        emit_success(&output, segment.paragraph_index, &mut tracker, |event| {
            let _ = on_event.send(event);
        });
        outputs.push(output.full_text());
    }
    Ok(outputs.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, rc::Rc};

    use super::*;

    fn successful_output(provider: Provider, text: &str) -> SegmentOutput {
        SegmentOutput {
            provider,
            pieces: vec![TranslatedPiece {
                source: format!("原文-{text}"),
                text: text.to_string(),
            }],
        }
    }

    struct DropSignal(Rc<Cell<bool>>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            self.0.set(true);
        }
    }

    #[test]
    fn language_codes_cover_supported_names() {
        assert_eq!(lang_code("中文"), Some("zh-CN"));
        assert_eq!(lang_code("英文"), Some("en"));
        assert_eq!(lang_code("日文"), Some("ja"));
        assert_eq!(lang_code("未知"), None);
    }

    #[test]
    fn parses_google_segments() {
        let payload: serde_json::Value = serde_json::json!([
            [
                ["你好", "Hello", null, null, 1],
                ["世界", " world", null, null, 1]
            ],
            null,
            "en"
        ]);
        assert_eq!(parse_google(&payload).as_deref(), Some("你好世界"));
    }

    #[test]
    fn mymemory_langpair_uses_autodetect() {
        // CR-20261121-45：`auto` 被 MyMemory 判为非法源语言（HTTP 200 + 错误文案）
        assert_eq!(mymemory_langpair("zh-CN"), "Autodetect|zh-CN");
    }

    #[test]
    fn rejects_mymemory_error_payload_as_translation() {
        // responseStatus != 200 时 translatedText 是错误文案，必须拒绝（防注入文档）
        let payload: serde_json::Value = serde_json::json!({
            "responseData": { "translatedText": "'AUTO' IS AN INVALID SOURCE LANGUAGE" },
            "responseStatus": 429,
        });
        assert_eq!(parse_mymemory(&payload), None);
    }

    #[test]
    fn accepts_mymemory_response_without_status_field() {
        let payload: serde_json::Value = serde_json::json!({
            "responseData": { "translatedText": "你好" },
        });
        assert_eq!(parse_mymemory(&payload).as_deref(), Some("你好"));
    }

    #[test]
    fn parses_mymemory_response() {
        let payload = serde_json::json!({
            "responseData": { "translatedText": " 你好 " }
        });
        assert_eq!(parse_mymemory(&payload).as_deref(), Some("你好"));
    }

    #[test]
    fn chunks_respect_limit_and_keep_text() {
        let text = "第一句话。第二句话！第三句话？";
        let chunks = split_chunks(text, 8);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 8));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn oversized_sentence_is_hard_split_by_chars() {
        let text = "无标点长句".repeat(20);
        let chunks = split_chunks(&text, 30);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 30));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn blank_texts_are_dropped() {
        let chunks = split_chunks("你好。\n\n  \n世界。", 100);
        assert_eq!(chunks, vec!["你好。\n\n  \n世界。"]);
        assert!(split_chunks("   \n ", 100).is_empty());
    }

    #[test]
    fn progress_tracker_is_monotonic_and_clamped() {
        // 空 total 钳到 1：保证前端 done/total 永不除零。
        let mut tracker = ProgressTracker::new(0);
        assert_eq!(tracker.counts().1, 1);
        tracker.step();
        assert_eq!(tracker.counts().0, 1);

        // 正常序列：3 个规划段，其中 1 段由 2 个 MyMemory 子段完成。
        let mut tracker = ProgressTracker::new(3);
        assert_eq!(tracker.counts(), (0, 3));
        tracker.grow_total(2);
        tracker.step();
        tracker.step();
        assert_eq!(tracker.counts(), (2, 5));
        for _ in 0..4 {
            tracker.step();
        }
        assert_eq!(tracker.counts(), (5, 5));
    }

    #[test]
    fn translate_event_serializes_tagged() {
        // 契约钉子：tagged union 形状（与 AiChatEvent 的 type 判别一致）。
        let progress =
            serde_json::to_value(TranslateEvent::Progress { done: 1, total: 3 }).unwrap();
        assert_eq!(
            progress,
            serde_json::json!({ "type": "progress", "done": 1, "total": 3 })
        );
        let segment = serde_json::to_value(TranslateEvent::Segment {
            index: 2,
            source: "Hello".to_string(),
            text: "你好".to_string(),
        })
        .unwrap();
        assert_eq!(
            segment,
            serde_json::json!({ "type": "segment", "index": 2, "source": "Hello", "text": "你好" })
        );
    }

    #[test]
    fn paragraphs_split_on_blank_lines() {
        let text = "第一段第一行\n第一段第二行。\n\n第二段！\n\n\n\n第三段；";
        assert_eq!(
            split_paragraphs(text),
            vec!["第一段第一行\n第一段第二行。", "第二段！", "第三段；"]
        );
        assert!(split_paragraphs(" \n \n\n  ").is_empty());
    }

    #[test]
    fn paragraphs_are_fence_aware() {
        // 代码围栏内部的空行不切断段落（与前端 splitTranslateParagraphs 同向量钉住）。
        let text = "```py\ncode1\n\ncode2\n```\n\n围栏后段落。";
        assert_eq!(
            split_paragraphs(text),
            vec!["```py\ncode1\n\ncode2\n```", "围栏后段落。"]
        );
        // 公式围栏同理。
        let math = "$$\nG\n\nH\n$$\n\n公式后段落。";
        assert_eq!(
            split_paragraphs(math),
            vec!["$$\nG\n\nH\n$$", "公式后段落。"]
        );
    }

    #[test]
    fn plan_segments_keeps_paragraph_granularity_and_index() {
        let text = "短段一。\n\n短段二。";
        let segments = plan_segments(text).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].paragraph_index, 0);
        assert_eq!(segments[0].source, "短段一。");
        assert_eq!(segments[1].paragraph_index, 1);
        assert_eq!(segments[1].source, "短段二。");
    }

    #[test]
    fn plan_segments_hard_splits_oversized_paragraph_sharing_index() {
        let paragraph = "无标点长句".repeat(400); // 2000 字符 > 1800
        let text = format!("{paragraph}\n\n短段。");
        let segments = plan_segments(&text).unwrap();
        assert!(segments.len() >= 3);
        assert_eq!(segments.last().unwrap().source, "短段。");
        assert_eq!(segments.last().unwrap().paragraph_index, 1);
        for segment in &segments[..segments.len() - 1] {
            assert_eq!(segment.paragraph_index, 0);
            assert!(segment.source.chars().count() <= GOOGLE_CHUNK_CHARS);
        }
    }

    #[test]
    fn plan_segments_rejects_excessive_count() {
        let text: String = (0..600).map(|index| format!("段{index}。\n\n")).collect();
        let error = plan_segments(&text).unwrap_err();
        assert_eq!(error.code, "E_TRANSLATE_TOO_LONG");
        assert!(error.message.contains("500"));
    }

    #[tokio::test(start_paused = true)]
    async fn race_returns_first_complete_success_from_either_provider() {
        let google = race_providers(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(successful_output(Provider::Google, "Google 译文"))
            },
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(successful_output(Provider::MyMemory, "MyMemory 译文"))
            },
        )
        .await
        .unwrap();
        assert_eq!(google.provider, Provider::Google);
        assert_eq!(google.full_text(), "Google 译文");

        let mymemory = race_providers(
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                Ok(successful_output(Provider::Google, "Google 译文"))
            },
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(successful_output(Provider::MyMemory, "MyMemory 译文"))
            },
        )
        .await
        .unwrap();
        assert_eq!(mymemory.provider, Provider::MyMemory);
        assert_eq!(mymemory.full_text(), "MyMemory 译文");
    }

    #[tokio::test(start_paused = true)]
    async fn race_waits_for_other_provider_after_fast_failure() {
        let mymemory = race_providers(
            async { Err(fail("E_TRANSLATE_NETWORK", "Google 失败")) },
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(successful_output(Provider::MyMemory, "MyMemory 成功"))
            },
        )
        .await
        .unwrap();
        assert_eq!(mymemory.provider, Provider::MyMemory);

        let google = race_providers(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(successful_output(Provider::Google, "Google 成功"))
            },
            async { Err(fail("E_TRANSLATE_HTTP", "MyMemory 失败")) },
        )
        .await
        .unwrap();
        assert_eq!(google.provider, Provider::Google);
    }

    #[tokio::test(start_paused = true)]
    async fn race_double_failure_returns_google_error() {
        let error = race_providers(
            async {
                tokio::time::sleep(Duration::from_secs(2)).await;
                Err(fail("E_TRANSLATE_NETWORK", "Google 失败"))
            },
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Err(fail("E_TRANSLATE_HTTP", "MyMemory 失败"))
            },
        )
        .await
        .unwrap_err();
        assert_eq!(error.code, "E_TRANSLATE_NETWORK");
        assert_eq!(error.message, "Google 失败");
    }

    #[tokio::test(start_paused = true)]
    async fn race_cancels_losing_future_after_success() {
        let cancelled = Rc::new(Cell::new(false));
        let losing_cancelled = Rc::clone(&cancelled);
        let output = race_providers(
            async {
                tokio::time::sleep(Duration::from_secs(1)).await;
                Ok(successful_output(Provider::Google, "胜线"))
            },
            async move {
                let _signal = DropSignal(losing_cancelled);
                tokio::time::sleep(Duration::from_secs(30)).await;
                Ok(successful_output(Provider::MyMemory, "败者不应完成"))
            },
        )
        .await
        .unwrap();
        assert_eq!(output.full_text(), "胜线");
        assert!(cancelled.get(), "胜线返回后必须丢弃败者 Future");
    }

    #[tokio::test]
    async fn fallback_success_becomes_preferred_for_next_segment() {
        let mut calls = Vec::new();
        let output = translate_with_fallback(Provider::Google, |provider| {
            calls.push(provider);
            std::future::ready(match provider {
                Provider::Google => Err(fail("E_TRANSLATE_NETWORK", "Google 失败")),
                Provider::MyMemory => Ok(successful_output(Provider::MyMemory, "回退成功")),
            })
        })
        .await
        .unwrap();
        assert_eq!(calls, vec![Provider::Google, Provider::MyMemory]);
        assert_eq!(output.provider, Provider::MyMemory);

        let preferred = output.provider;
        let mut next_calls = Vec::new();
        let next = translate_with_fallback(preferred, |provider| {
            next_calls.push(provider);
            std::future::ready(Ok(successful_output(provider, "下一段")))
        })
        .await
        .unwrap();
        assert_eq!(next_calls, vec![Provider::MyMemory]);
        assert_eq!(next.full_text(), "下一段");

        let reverse = translate_with_fallback(Provider::MyMemory, |provider| {
            std::future::ready(match provider {
                Provider::MyMemory => Err(fail("E_TRANSLATE_HTTP", "MyMemory 失败")),
                Provider::Google => Ok(successful_output(Provider::Google, "反向回退")),
            })
        })
        .await
        .unwrap();
        assert_eq!(reverse.provider, Provider::Google);
    }

    #[tokio::test]
    async fn fallback_double_failure_returns_google_error() {
        let error = translate_with_fallback(Provider::MyMemory, |provider| {
            std::future::ready(Err(match provider {
                Provider::Google => fail("E_TRANSLATE_NETWORK", "Google 失败"),
                Provider::MyMemory => fail("E_TRANSLATE_HTTP", "MyMemory 失败"),
            }))
        })
        .await
        .unwrap_err();
        assert_eq!(error.code, "E_TRANSLATE_NETWORK");
        assert_eq!(error.message, "Google 失败");
    }

    #[test]
    fn mymemory_success_emits_ordered_events_once_and_preserves_joins() {
        let output = SegmentOutput {
            provider: Provider::MyMemory,
            pieces: vec![
                TranslatedPiece {
                    source: "原文甲".to_string(),
                    text: "译文甲".to_string(),
                },
                TranslatedPiece {
                    source: "原文乙".to_string(),
                    text: "译文乙".to_string(),
                },
            ],
        };
        let mut tracker = ProgressTracker::new(3);
        let mut events = Vec::new();
        emit_success(&output, 4, &mut tracker, |event| events.push(event));

        assert_eq!(tracker.counts(), (2, 4));
        assert_eq!(events.len(), 5, "总量调整一次，每个胜线子段各两条事件");
        assert!(matches!(
            &events[0],
            TranslateEvent::Progress { done: 0, total: 4 }
        ));
        assert!(matches!(
            &events[1],
            TranslateEvent::Progress { done: 1, total: 4 }
        ));
        match &events[2] {
            TranslateEvent::Segment {
                index,
                source,
                text,
            } => {
                assert_eq!(*index, 4);
                assert_eq!(source, "原文甲");
                assert_eq!(text, "译文甲");
            }
            other => panic!("预期首个对照事件，实际为 {other:?}"),
        }
        assert!(matches!(
            &events[3],
            TranslateEvent::Progress { done: 2, total: 4 }
        ));
        match &events[4] {
            TranslateEvent::Segment {
                index,
                source,
                text,
            } => {
                assert_eq!(*index, 4);
                assert_eq!(source, "原文乙");
                assert_eq!(text, "译文乙");
            }
            other => panic!("预期第二个对照事件，实际为 {other:?}"),
        }

        assert_eq!(output.full_text(), "译文甲\n译文乙");
        let next = successful_output(Provider::Google, "后段");
        assert_eq!(
            [output.full_text(), next.full_text()].join("\n\n"),
            "译文甲\n译文乙\n\n后段"
        );
    }
}
