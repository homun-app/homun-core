//! Token-budget auto-compaction decisions for the agent loop (Fase 1.1, extracted from
//! the gateway monolith in ADR 0024 Inc-0). These are the loop's WHOLE-CONVERSATION
//! context-window management — distinct from the per-item char compression in
//! `local-first-context-compression` (shell/browser output). All pure + testable: no
//! tokenizer (would be wrong for non-OpenAI local models), no IO, no runtime.

/// Minimum number of messages a compaction span must cover to be worth a summarizer
/// round-trip (mirrors the `< 6` guard in the plan-step compaction).
const CONTEXT_COMPACTION_MIN_SPAN: usize = 4;

/// Estimate the token footprint of the messages we're about to send. No tokenizer exists
/// (and `tiktoken` would be wrong for non-OpenAI local models), so we use the universal
/// char/4 heuristic over each message's serialized JSON — a SAFETY VALVE for the budget
/// check, not a billing meter.
pub fn estimate_tokens(messages: &[serde_json::Value]) -> usize {
    messages.iter().map(|m| m.to_string().len()).sum::<usize>() / 4
}

/// Should we compact before sending? True iff the model's context window is KNOWN and the
/// estimate exceeds `threshold` of it. Unknown window (`None`) or degenerate (`0`) → false
/// (fail-open to the existing round-based hygiene; the catalog auto-fills the window for
/// Ollama/cloud so unknown is rare).
pub fn needs_context_compaction(
    estimated_tokens: usize,
    context_window: Option<usize>,
    threshold: f64,
) -> bool {
    match context_window {
        Some(w) if w > 0 => estimated_tokens as f64 > threshold * w as f64,
        _ => false,
    }
}

/// Pick the `[from, to)` span to collapse, preserving the head (`system` + first `user`,
/// the task anchor) and at least `keep_tail_min` recent messages. The tail boundary is
/// moved EARLIER past any `tool` result so a kept tool-result is never orphaned from its
/// `assistant` tool_calls (OpenAI-compat valid). Returns `None` if the resulting span is
/// too small to be worth a summarizer round-trip.
pub fn context_compaction_span(
    roles: &[&str],
    keep_head: usize,
    keep_tail_min: usize,
) -> Option<(usize, usize)> {
    let len = roles.len();
    if len <= keep_head + keep_tail_min {
        return None;
    }
    let from = keep_head;
    let mut to = len - keep_tail_min;
    // Keep more in the tail until it starts at a non-`tool` message (a clean group
    // boundary), so collapsing [from, to) can't strand a tool result.
    while to > from && roles[to] == "tool" {
        to -= 1;
    }
    if to <= from || to - from < CONTEXT_COMPACTION_MIN_SPAN {
        return None;
    }
    Some((from, to))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_counts_serialized_chars_over_four() {
        let messages = vec![
            serde_json::json!({"role": "system", "content": "You are helpful."}),
            serde_json::json!({"role": "user", "content": "Summarize this."}),
        ];
        let expected: usize = messages.iter().map(|m| m.to_string().len()).sum::<usize>() / 4;
        assert_eq!(estimate_tokens(&messages), expected);
        assert!(estimate_tokens(&messages) > 0);
    }

    #[test]
    fn needs_context_compaction_respects_threshold_and_unknown_window() {
        assert!(needs_context_compaction(800, Some(1000), 0.75)); // > 750
        assert!(!needs_context_compaction(700, Some(1000), 0.75)); // < 750
        assert!(!needs_context_compaction(999_999, None, 0.75)); // unknown window → never
        assert!(!needs_context_compaction(800, Some(0), 0.75)); // degenerate window → never
    }

    #[test]
    fn context_compaction_span_preserves_head_tail_and_avoids_orphan_tool() {
        // Too short (len <= keep_head + keep_tail_min) → None.
        assert_eq!(
            context_compaction_span(&["system", "user", "assistant", "user"], 2, 2),
            None
        );
        // Normal: collapse the middle, keep head(2) + tail(>=2).
        let roles = ["system", "user", "a", "tool", "a", "tool", "a", "user"];
        assert_eq!(context_compaction_span(&roles, 2, 2), Some((2, 6)));
        // Tail boundary lands on a `tool` result → move earlier so a kept tool result
        // is never orphaned from its assistant tool_calls.
        let roles2 = ["system", "user", "a", "tool", "a", "tool", "a", "tool", "a", "user"];
        assert_eq!(context_compaction_span(&roles2, 2, 3), Some((2, 6)));
    }
}
