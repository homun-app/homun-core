//! Local-first context compression contracts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextKind {
    ShellOutput,
    BrowserText,
    ChatHistory,
    ToolJson,
    GenericToolOutput,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextItem {
    pub kind: ContextKind,
    pub text: String,
}

impl ContextItem {
    pub fn new(kind: ContextKind, text: impl Into<String>) -> Self {
        Self {
            kind,
            text: text.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompressionPolicy {
    pub kind: ContextKind,
    pub max_chars: usize,
    pub preserve_head_lines: usize,
    pub preserve_tail_lines: usize,
    pub dedupe_adjacent_lines: bool,
}

impl CompressionPolicy {
    pub fn for_kind(kind: ContextKind) -> Self {
        match kind {
            ContextKind::ShellOutput => Self {
                kind,
                max_chars: 4_000,
                preserve_head_lines: 4,
                preserve_tail_lines: 8,
                dedupe_adjacent_lines: true,
            },
            ContextKind::BrowserText => Self {
                kind,
                max_chars: 5_000,
                preserve_head_lines: 6,
                preserve_tail_lines: 8,
                dedupe_adjacent_lines: true,
            },
            ContextKind::ChatHistory => Self {
                kind,
                max_chars: 6_000,
                preserve_head_lines: 0,
                preserve_tail_lines: 8,
                dedupe_adjacent_lines: false,
            },
            ContextKind::ToolJson => Self {
                kind,
                max_chars: 4_000,
                preserve_head_lines: 4,
                preserve_tail_lines: 6,
                dedupe_adjacent_lines: true,
            },
            ContextKind::GenericToolOutput => Self {
                kind,
                max_chars: 3_000,
                preserve_head_lines: 4,
                preserve_tail_lines: 6,
                dedupe_adjacent_lines: true,
            },
        }
    }

    pub fn with_max_chars(mut self, max_chars: usize) -> Self {
        self.max_chars = max_chars;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompressionResult {
    pub kind: ContextKind,
    pub text: String,
    pub compressed: bool,
    pub redacted: bool,
    pub metrics: CompressionMetrics,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompressionMetrics {
    pub input_chars: usize,
    pub output_chars: usize,
    pub removed_chars: usize,
    pub estimated_input_tokens: usize,
    pub estimated_output_tokens: usize,
    pub compression_ratio: f64,
    pub redaction_count: usize,
}

#[derive(Debug, Clone, Default)]
pub struct ContextCompressor;

impl ContextCompressor {
    pub fn compress(&self, item: &ContextItem, policy: &CompressionPolicy) -> CompressionResult {
        let input_chars = item.text.chars().count();
        let RedactedText {
            text: redacted_text,
            redaction_count,
        } = match item.kind {
            ContextKind::ToolJson => redact_json_or_text(&item.text),
            _ => redact_text(&strip_ansi(&item.text)),
        };
        let normalized = if policy.dedupe_adjacent_lines {
            dedupe_adjacent_lines(&redacted_text)
        } else {
            redacted_text
        };
        let normalized_compressed = normalized.chars().count() < input_chars;
        let (mut text, budget_compressed) = match item.kind {
            ContextKind::ChatHistory => compress_chat_history(&normalized, policy.max_chars),
            _ => compress_text(&normalized, policy),
        };
        if normalized_compressed && !budget_compressed && !text.contains("context compressed") {
            text.push('\n');
            text.push_str(&compression_marker(input_chars, policy.max_chars));
        }
        let compressed = budget_compressed || normalized_compressed;
        let output_chars = text.chars().count();
        let removed_chars = input_chars.saturating_sub(output_chars);
        let estimated_input_tokens = estimate_tokens(input_chars);
        let estimated_output_tokens = estimate_tokens(output_chars);
        let compression_ratio = if input_chars == 0 {
            1.0
        } else {
            output_chars as f64 / input_chars as f64
        };

        CompressionResult {
            kind: item.kind,
            text,
            compressed,
            redacted: redaction_count > 0,
            metrics: CompressionMetrics {
                input_chars,
                output_chars,
                removed_chars,
                estimated_input_tokens,
                estimated_output_tokens,
                compression_ratio,
                redaction_count,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RedactedText {
    text: String,
    redaction_count: usize,
}

fn redact_json_or_text(input: &str) -> RedactedText {
    match serde_json::from_str::<serde_json::Value>(input) {
        Ok(mut value) => {
            let mut count = 0;
            redact_json_value(&mut value, &mut count);
            let text = serde_json::to_string(&value).unwrap_or_else(|_| "[REDACTED]".to_string());
            RedactedText {
                text,
                redaction_count: count,
            }
        }
        Err(_) => redact_text(input),
    }
}

fn redact_json_value(value: &mut serde_json::Value, count: &mut usize) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                if is_sensitive_key(key) {
                    *value = serde_json::Value::String("[REDACTED]".to_string());
                    *count += 1;
                } else {
                    redact_json_value(value, count);
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_json_value(value, count);
            }
        }
        serde_json::Value::String(text) => {
            let redacted = redact_text(text);
            if redacted.redaction_count > 0 {
                *text = redacted.text;
                *count += redacted.redaction_count;
            }
        }
        _ => {}
    }
}

fn redact_text(input: &str) -> RedactedText {
    let mut count = 0;
    let text = input
        .lines()
        .map(|line| {
            line.split_whitespace()
                .map(|token| redact_token(token, &mut count))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n");
    RedactedText {
        text,
        redaction_count: count,
    }
}

fn redact_token(token: &str, count: &mut usize) -> String {
    if token.starts_with("http://") || token.starts_with("https://") {
        let sanitized = token
            .split(['?', '#'])
            .next()
            .unwrap_or(token)
            .trim_end_matches([',', ';', ')', ']']);
        if sanitized != token {
            *count += 1;
        }
        return sanitized.to_string();
    }

    let lower = token.to_ascii_lowercase();
    if is_sensitive_key_value(&lower)
        || lower.contains("bearer")
        || lower.contains("sk-")
        || looks_like_email(token)
    {
        *count += 1;
        "[REDACTED]".to_string()
    } else {
        token.to_string()
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "api_key"
            | "apikey"
            | "password"
            | "secret"
            | "authorization"
            | "email"
    )
}

fn is_sensitive_key_value(lower: &str) -> bool {
    [
        "password=",
        "token=",
        "access_token=",
        "refresh_token=",
        "secret=",
        "api_key=",
        "apikey=",
        "authorization=",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn looks_like_email(token: &str) -> bool {
    let trimmed = token.trim_matches(|character: char| {
        matches!(
            character,
            ',' | ';' | ':' | ')' | '(' | '"' | '\'' | '[' | ']'
        )
    });
    let Some((local, domain)) = trimmed.split_once('@') else {
        return false;
    };
    !local.is_empty() && domain.contains('.') && !domain.ends_with('.')
}

fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn dedupe_adjacent_lines(input: &str) -> String {
    let mut output = Vec::new();
    let mut previous: Option<&str> = None;
    let mut repeated = 0usize;

    for line in input.lines() {
        if Some(line) == previous {
            repeated += 1;
            continue;
        }
        flush_repeated(&mut output, previous, repeated);
        output.push(line.to_string());
        previous = Some(line);
        repeated = 0;
    }
    flush_repeated(&mut output, previous, repeated);
    output.join("\n")
}

fn flush_repeated(output: &mut Vec<String>, previous: Option<&str>, repeated: usize) {
    if repeated > 0 {
        output.push(format!(
            "[... repeated {} more times: {}]",
            repeated,
            previous.unwrap_or_default()
        ));
    }
}

fn compress_text(input: &str, policy: &CompressionPolicy) -> (String, bool) {
    if input.chars().count() <= policy.max_chars || policy.max_chars == 0 {
        return (input.to_string(), false);
    }

    let lines = input.lines().collect::<Vec<_>>();
    let mut selected = Vec::new();
    selected.extend(
        lines
            .iter()
            .take(policy.preserve_head_lines)
            .map(|line| *line),
    );
    selected.extend(lines.iter().copied().filter(|line| is_important_line(line)));
    let tail_start = lines.len().saturating_sub(policy.preserve_tail_lines);
    selected.extend(lines.iter().skip(tail_start).map(|line| *line));
    selected.dedup();

    let marker = compression_marker(input.chars().count(), policy.max_chars);
    let candidate = selected.join("\n");
    let combined = if candidate.is_empty() {
        marker
    } else {
        format!("{candidate}\n{marker}")
    };
    if combined.chars().count() <= policy.max_chars {
        return (combined, true);
    }
    (clamp_middle(&combined, policy.max_chars), true)
}

fn compress_chat_history(input: &str, max_chars: usize) -> (String, bool) {
    if input.chars().count() <= max_chars || max_chars == 0 {
        return (input.to_string(), false);
    }

    let lines = input
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>();
    if lines.len() <= 2 {
        return (clamp_middle(input, max_chars), true);
    }
    let keep = lines.len().min(2);
    let older_count = lines.len().saturating_sub(keep);
    let recent = lines[lines.len() - keep..].join("\n");
    let summary_seed = lines
        .iter()
        .take(older_count)
        .find(|line| line.starts_with("Utente:"))
        .copied()
        .unwrap_or(lines[0]);
    let summary = format!(
        "[Earlier context: {older_count} older turns compressed. Key starting point: {}]",
        clamp_end(summary_seed, 90)
    );
    let candidate = format!("{summary}\n{recent}");
    if candidate.chars().count() <= max_chars {
        (candidate, true)
    } else {
        (
            format!(
                "{}\n{}",
                clamp_end(&summary, max_chars / 2),
                clamp_end(&recent, max_chars / 2)
            ),
            true,
        )
    }
}

fn is_important_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("error")
        || lower.contains("failed")
        || lower.contains("failure")
        || lower.contains("warning")
        || lower.contains("http://")
        || lower.contains("https://")
        || lower.contains("result:")
        || lower.contains("summary")
}

fn compression_marker(input_chars: usize, max_chars: usize) -> String {
    format!(
        "[context compressed: input_chars={input_chars}, budget_chars={max_chars}; rerun with a narrower query for full output]"
    )
}

fn clamp_middle(input: &str, max_chars: usize) -> String {
    let count = input.chars().count();
    if count <= max_chars {
        return input.to_string();
    }
    if max_chars <= 32 {
        return input.chars().take(max_chars).collect();
    }
    let marker = "\n[... context compressed ...]\n";
    let side = max_chars.saturating_sub(marker.chars().count()) / 2;
    let head = input.chars().take(side).collect::<String>();
    let tail = input
        .chars()
        .rev()
        .take(side)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("{head}{marker}{tail}")
}

fn clamp_end(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    if max_chars <= 4 {
        return input.chars().take(max_chars).collect();
    }
    format!(
        "{}...",
        input
            .chars()
            .take(max_chars.saturating_sub(3))
            .collect::<String>()
    )
}

fn estimate_tokens(chars: usize) -> usize {
    chars.div_ceil(4).max(1)
}
