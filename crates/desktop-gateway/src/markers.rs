//! The ONE control-marker toolkit for the backend — the single source of truth for the
//! `‹‹NAME››…‹‹/NAME››` protocol the model uses to carry structured side-channels (reasoning
//! traces, plan cards, activity, artifacts, confirm cards, …) inside a plain text stream.
//!
//! Lives in the LIB so BOTH the library (`strip_display_markers`) and the binary (the stream
//! collectors, chat store, agent loop) share it — the mirror of the frontend's single
//! `lib/markers.ts`. Before this, the same delimiters and strip/parse loops were re-implemented
//! across `main.rs`, `chat_store.rs`, `model_normalize.rs`, and `lib.rs`.

/// The control-marker names, one place. Delimiters are derived (`open`/`close`) so a delimiter
/// string is never hand-written twice. Domain builders (plan/vault/payment cards) reference
/// these instead of inlining `"‹‹PLAN››"` etc.
pub mod name {
    pub const REASONING: &str = "REASONING";
    pub const PLAN: &str = "PLAN";
    pub const ACT: &str = "ACT";
    pub const ARTIFACT: &str = "ARTIFACT";
    pub const DIFF: &str = "DIFF";
    pub const CHOICES: &str = "CHOICES";
}

/// The opening delimiter for a marker name, e.g. `open("PLAN") == "‹‹PLAN››"`.
pub fn open(marker: &str) -> String {
    format!("‹‹{marker}››")
}

/// The closing delimiter for a marker name, e.g. `close("PLAN") == "‹‹/PLAN››"`.
pub fn close(marker: &str) -> String {
    format!("‹‹/{marker}››")
}

/// The body of a delta whose ENTIRE trimmed text IS one `open…close` block, else `None`. This
/// is the strict, whole-text contract the per-delta stream expander needs (a streamed marker
/// delta is exactly `‹‹ACT››…‹‹/ACT››`, nothing around it) — not a "find a marker anywhere". For
/// the anywhere/all-occurrences case in persisted messages, use `bodies` / `strip_blocks`.
pub fn body<'a>(text: &'a str, open_tag: &str, close_tag: &str) -> Option<&'a str> {
    let trimmed = text.trim();
    if trimmed.starts_with(open_tag) && trimmed.ends_with(close_tag) {
        Some(&trimmed[open_tag.len()..trimmed.len() - close_tag.len()])
    } else {
        None
    }
}

/// The whole-text block body parsed as JSON, or `None`.
pub fn json_body(text: &str, open_tag: &str, close_tag: &str) -> Option<serde_json::Value> {
    body(text, open_tag, close_tag).and_then(|b| serde_json::from_str(b).ok())
}

/// Every block body for a marker NAME (by `‹‹NAME››…‹‹/NAME››`), in order.
pub fn bodies(text: &str, marker: &str) -> Vec<String> {
    let (open_tag, close_tag) = (open(marker), close(marker));
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(open_rel) = text[cursor..].find(&open_tag) {
        let body_start = cursor + open_rel + open_tag.len();
        let Some(close_rel) = text[body_start..].find(&close_tag) else {
            break;
        };
        let body_end = body_start + close_rel;
        out.push(text[body_start..body_end].to_string());
        cursor = body_end + close_tag.len();
    }
    out
}

/// Remove every `‹‹NAME››…‹‹/NAME››` block for a marker NAME. An unterminated final block is
/// removed to end-of-string (a truncated stream never leaves a dangling open marker visible).
pub fn strip_blocks(text: &str, marker: &str) -> String {
    let (open_tag, close_tag) = (open(marker), close(marker));
    let mut out = text.to_string();
    while let Some(start) = out.find(&open_tag) {
        let end = match out[start..].find(&close_tag) {
            Some(rel) => start + rel + close_tag.len(),
            None => out.len(),
        };
        out.replace_range(start..end, "");
    }
    out
}

/// Split streamed text at a control-marker boundary so a `‹‹NAME››` / `‹‹/NAME››` delimiter is
/// never cut across two Delta events. Reasoning/coding models put our markers in `content` and
/// their tokenizer splits `‹‹REASONING››` into `‹‹REASONING›` + `›`; a split delimiter otherwise
/// leaks to the UI as literal text. Returns `(emit_now, hold_back)`: everything up to a trailing
/// partial delimiter is safe to emit; the partial is held until the next fragment completes it.
pub fn marker_safe_split(buf: &str) -> (&str, &str) {
    if let Some(pos) = buf.rfind("‹‹") {
        let after = &buf[pos + "‹‹".len()..];
        let looks_like_delimiter = after.chars().count() <= 32
            && after
                .chars()
                .all(|c| c == '/' || c == '›' || c == '_' || c.is_ascii_alphabetic());
        if !after.contains("››") && looks_like_delimiter {
            return buf.split_at(pos);
        }
    }
    // A lone trailing '‹' is the first half of a '‹‹' about to arrive — hold it.
    if buf.ends_with('‹') {
        return buf.split_at(buf.len() - '‹'.len_utf8());
    }
    (buf, "")
}

/// Balance ‹‹REASONING›› markers in a stream of text, carrying open/closed state across calls
/// via `open`. Keeps ONE well-formed pair, DROPS duplicate opens and orphan closes, and
/// normalizes the split single-`›` variant (`‹‹REASONING›`) to the canonical `‹‹REASONING››`.
/// Weak browser models (MiniMax) degenerate into a flood of bare `‹‹/REASONING›` closings that
/// otherwise leak to the UI as literal text — this collapses that noise while preserving a real
/// reasoning block. Other markers (‹‹PLAN››, ‹‹ACT››, …) pass through untouched. Appends to `out`.
pub fn balance_reasoning_markers(s: &str, open_state: &mut bool, out: &mut String) {
    const CLOSE2: &str = "‹‹/REASONING››";
    const CLOSE1: &str = "‹‹/REASONING›";
    const OPEN2: &str = "‹‹REASONING››";
    const OPEN1: &str = "‹‹REASONING›";
    let mut rest = s;
    while !rest.is_empty() {
        let Some(pos) = rest.find("‹‹") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..pos]);
        let at = &rest[pos..];
        // Longest-match first so `‹‹/REASONING››` wins over `‹‹/REASONING›`, etc.
        let close_tok = at
            .starts_with(CLOSE2)
            .then_some(CLOSE2.len())
            .or_else(|| at.starts_with(CLOSE1).then_some(CLOSE1.len()));
        let open_tok = at
            .starts_with(OPEN2)
            .then_some(OPEN2.len())
            .or_else(|| at.starts_with(OPEN1).then_some(OPEN1.len()));
        if let Some(len) = close_tok {
            if *open_state {
                out.push_str(CLOSE2);
                *open_state = false;
            } // else: orphan close → drop
            rest = &at[len..];
        } else if let Some(len) = open_tok {
            if !*open_state {
                out.push_str(OPEN2);
                *open_state = true;
            } // else: duplicate open → drop
            rest = &at[len..];
        } else {
            // A `‹‹` that isn't a REASONING marker (‹‹PLAN››, ‹‹ACT››, …) — emit and move past it.
            out.push_str("‹‹");
            rest = &at["‹‹".len()..];
        }
    }
}

/// One-shot balance for a complete text (final/persisted content): a fresh block state, and any
/// left-open reasoning is closed so the marker never dangles into the visible answer.
pub fn normalize_reasoning_markers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut open_state = false;
    balance_reasoning_markers(s, &mut open_state, &mut out);
    if open_state {
        out.push_str("‹‹/REASONING››");
    }
    out
}

/// The ONE streaming marker filter every model-stream collector feeds through (OpenAI SSE and
/// Ollama native alike) — the single place that turns raw model content fragments into UI-safe
/// Delta text. Stateful across fragments: `marker_safe_split` never lets a `‹‹NAME››` delimiter
/// be cut in half, and `balance_reasoning_markers` drops a weak model's flood of orphan
/// ‹‹/REASONING›› closings + dedups opens. Feed each fragment through `push`, emit the result;
/// call `flush` once at stream end to drain the held tail and close a dangling block.
#[derive(Default)]
pub struct StreamMarkerFilter {
    hold: String,
    reasoning_open: bool,
}

impl StreamMarkerFilter {
    pub fn push(&mut self, fragment: &str) -> String {
        self.hold.push_str(fragment);
        let (emit, rest) = marker_safe_split(&self.hold);
        let mut out = String::with_capacity(emit.len());
        balance_reasoning_markers(emit, &mut self.reasoning_open, &mut out);
        self.hold = rest.to_string();
        out
    }

    pub fn flush(&mut self) -> String {
        let mut out = String::new();
        balance_reasoning_markers(&self.hold, &mut self.reasoning_open, &mut out);
        self.hold.clear();
        if self.reasoning_open {
            out.push_str("‹‹/REASONING››");
            self.reasoning_open = false;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_close_derive_delimiters() {
        assert_eq!(open(name::PLAN), "‹‹PLAN››");
        assert_eq!(close(name::REASONING), "‹‹/REASONING››");
    }

    #[test]
    fn body_and_bodies_and_strip() {
        let t = "a‹‹ACT››one‹‹/ACT›› b ‹‹ACT››two‹‹/ACT›› c";
        // `body` is whole-text-only (a single-delta marker) — no mid-text match.
        assert_eq!(body(t, "‹‹ACT››", "‹‹/ACT››"), None);
        assert_eq!(body("‹‹PLAN››only‹‹/PLAN››", "‹‹PLAN››", "‹‹/PLAN››"), Some("only"));
        assert_eq!(body("  ‹‹ACT››x‹‹/ACT››  ", "‹‹ACT››", "‹‹/ACT››"), Some("x"));
        // `bodies` / `strip_blocks` DO find every block in a full message.
        assert_eq!(bodies(t, name::ACT), vec!["one".to_string(), "two".to_string()]);
        assert_eq!(strip_blocks(t, name::ACT), "a b  c");
        // Unterminated final block → stripped to end.
        assert_eq!(strip_blocks("x‹‹ACT››oops", name::ACT), "x");
    }

    #[test]
    fn marker_safe_split_never_cuts_a_delimiter() {
        assert_eq!(marker_safe_split("hello ‹‹PLAN››x"), ("hello ‹‹PLAN››x", ""));
        assert_eq!(marker_safe_split("done.‹‹REASONING›"), ("done.", "‹‹REASONING›"));
        assert_eq!(
            marker_safe_split("‹‹REASONING›› thinking ‹‹/REASONING››"),
            ("‹‹REASONING›› thinking ‹‹/REASONING››", "")
        );
        assert_eq!(marker_safe_split("text‹"), ("text", "‹"));
        let prose = "he said ‹‹ and then continued";
        assert_eq!(marker_safe_split(prose), (prose, ""));
    }

    #[test]
    fn stream_filter_is_the_one_streaming_tool() {
        let mut f = StreamMarkerFilter::default();
        let mut out = String::new();
        out.push_str(&f.push("Opening page.‹‹REASONING›"));
        out.push_str(&f.push("›Bene, trovato il mercato.‹‹/REASONING›"));
        out.push_str(&f.push("‹‹/REASONING›".repeat(50).as_str()));
        out.push_str(&f.push("\nRisposta finale."));
        out.push_str(&f.flush());
        assert_eq!(
            out,
            "Opening page.‹‹REASONING››Bene, trovato il mercato.‹‹/REASONING››\nRisposta finale."
        );
    }

    #[test]
    fn normalize_collapses_flood_and_closes_dangling() {
        let flood = "‹‹/REASONING›".repeat(200);
        assert_eq!(normalize_reasoning_markers(&format!("Answer.{flood}")), "Answer.");
        assert_eq!(
            normalize_reasoning_markers("‹‹REASONING››‹‹REASONING››still"),
            "‹‹REASONING››still‹‹/REASONING››"
        );
    }
}
