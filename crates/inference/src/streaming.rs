use serde_json::Value;

/// One step of a streamed chat completion, normalized across backends so the
/// gateway can translate any provider's stream into its own chat events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatStreamEvent {
    /// A text fragment to append to the assistant message.
    Delta(String),
    /// The stream finished.
    Done,
    /// A keep-alive / role-only / unparseable line with no text to emit.
    Ignore,
}

/// Extracts the payload of an SSE `data:` line, or `None` for comment/blank
/// lines. OpenAI-compatible streaming (`/chat/completions` with `stream:true`,
/// including Ollama) sends `data: {...}` lines terminated by `data: [DONE]`.
pub fn sse_data_field(line: &str) -> Option<&str> {
    let line = line.trim_end_matches(['\r', '\n']);
    let rest = line.strip_prefix("data:")?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// Interprets one OpenAI-compatible streaming `data:` payload.
pub fn parse_openai_stream_data(data: &str) -> ChatStreamEvent {
    let data = data.trim();
    if data.is_empty() {
        return ChatStreamEvent::Ignore;
    }
    if data == "[DONE]" {
        return ChatStreamEvent::Done;
    }
    match serde_json::from_str::<Value>(data) {
        Ok(value) => match value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
        {
            Some(content) if !content.is_empty() => ChatStreamEvent::Delta(content.to_string()),
            _ => ChatStreamEvent::Ignore,
        },
        Err(_) => ChatStreamEvent::Ignore,
    }
}

/// Convenience: parse a full SSE line (with the `data:` prefix) in one step.
pub fn parse_openai_sse_line(line: &str) -> ChatStreamEvent {
    match sse_data_field(line) {
        Some(data) => parse_openai_stream_data(data),
        None => ChatStreamEvent::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_data_field() {
        assert_eq!(sse_data_field("data: {\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_field("data:{\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_field(": keep-alive"), None);
        assert_eq!(sse_data_field(""), None);
    }

    #[test]
    fn parses_content_delta() {
        let event = parse_openai_stream_data(
            r#"{"choices":[{"index":0,"delta":{"content":"Ciao"},"finish_reason":null}]}"#,
        );
        assert_eq!(event, ChatStreamEvent::Delta("Ciao".to_string()));
    }

    #[test]
    fn role_only_delta_is_ignored() {
        // First chunk often carries only the role, no text to emit.
        let event = parse_openai_stream_data(
            r#"{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
        );
        assert_eq!(event, ChatStreamEvent::Ignore);
    }

    #[test]
    fn done_sentinel_ends_stream() {
        assert_eq!(parse_openai_stream_data("[DONE]"), ChatStreamEvent::Done);
        assert_eq!(parse_openai_sse_line("data: [DONE]"), ChatStreamEvent::Done);
    }

    #[test]
    fn malformed_and_empty_lines_are_ignored() {
        assert_eq!(
            parse_openai_stream_data("not json"),
            ChatStreamEvent::Ignore
        );
        assert_eq!(parse_openai_stream_data(""), ChatStreamEvent::Ignore);
        assert_eq!(parse_openai_sse_line(": comment"), ChatStreamEvent::Ignore);
    }

    #[test]
    fn full_line_roundtrip() {
        let event =
            parse_openai_sse_line("data: {\"choices\":[{\"delta\":{\"content\":\" mondo\"}}]}\n");
        assert_eq!(event, ChatStreamEvent::Delta(" mondo".to_string()));
    }
}
