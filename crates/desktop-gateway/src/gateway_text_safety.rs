//! Shared text redaction, truncation, and task-title safety helpers.
//!
//! This module owns generic text safety primitives used across gateway owners.
//! It intentionally does not own task execution, JSON checkpoint shaping, agent
//! streaming, browser handling, or memory recall.

use crate::compact_thread_title;

pub(crate) fn truncate_chars(value: &str, max_chars: usize) -> String {
    let mut truncated = value.chars().take(max_chars).collect::<String>();
    if value.chars().count() > max_chars {
        truncated.push_str("\n...");
    }
    truncated
}

pub(crate) fn task_goal_summary(goal: &str) -> String {
    let redacted = redact_sensitive_text(goal)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let compact = if redacted.contains("[REDACTED]") {
        compact_redacted_task_goal_summary(&redacted)
    } else {
        compact_thread_title(&redacted)
    };
    if compact.is_empty() {
        "Local task from chat".to_string()
    } else {
        compact
    }
}

pub(crate) fn compact_redacted_task_goal_summary(redacted: &str) -> String {
    const MAX_CHARS: usize = 44;

    let marker_segment = redacted
        .split_whitespace()
        .find(|word| word.contains("[REDACTED]"))
        .unwrap_or("[REDACTED]");
    if marker_segment.chars().count() >= MAX_CHARS {
        return marker_segment.chars().take(MAX_CHARS).collect();
    }

    let prefix = redacted
        .find(marker_segment)
        .map(|index| redacted[..index].trim())
        .unwrap_or_default();
    let compact_prefix = compact_thread_title(prefix);
    let separator_chars = usize::from(!compact_prefix.is_empty());
    let prefix_budget = MAX_CHARS
        .saturating_sub(marker_segment.chars().count())
        .saturating_sub(separator_chars);
    let prefix = compact_prefix
        .chars()
        .take(prefix_budget)
        .collect::<String>()
        .trim()
        .to_string();

    if prefix.is_empty() {
        marker_segment.to_string()
    } else {
        format!("{prefix} {marker_segment}")
    }
}

pub(crate) fn redact_sensitive_text(input: &str) -> String {
    let mut output = strip_terminal_control_sequences(input);
    for marker in [
        "sk-",
        "sk_proj_",
        "token=",
        "Authorization:",
        "Bearer ",
        "password=",
        "secret=",
    ] {
        if let Some(index) = output.to_lowercase().find(&marker.to_lowercase()) {
            output.truncate(index + marker.len());
            output.push_str("[REDACTED]");
            return output;
        }
    }
    let classified = local_first_vault::classify_sensitive_text(&output);
    if classified.has_critical {
        return classified.redacted_text;
    }
    output
}

pub(crate) fn strip_terminal_control_sequences(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(char) = chars.next() {
        if char == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        if char.is_control() && char != '\n' && char != '\t' {
            continue;
        }
        output.push(char);
    }
    output
}
