use std::collections::HashMap;

use anyhow::Error;

use crate::provider::ChatMessage;

/// Loop guard: returns `true` when the same skill was already activated with
/// the same query during the current turn.
pub(super) fn should_redirect_skill_activation(
    activated_skills: &HashMap<String, String>,
    skill_name: &str,
    query: &str,
) -> bool {
    activated_skills
        .get(skill_name)
        .is_some_and(|prev| prev == query)
}

/// Count tool-result messages carrying a shell SIGKILL diagnostic.
///
/// The shell tool appends a diagnostic line whenever a child process is
/// terminated by a signal. We scan the conversation so fallback messages can
/// surface repeated silent sandbox denials.
pub(super) fn count_sigkill_diagnostics(messages: &[ChatMessage]) -> usize {
    messages
        .iter()
        .filter(|m| m.role == "tool")
        .filter(|m| {
            m.content
                .as_deref()
                .is_some_and(|c| c.contains("[diagnostic]") && c.contains("signal 9"))
        })
        .count()
}

/// Check if an error indicates a context window overflow from the LLM provider.
///
/// Matches common error patterns from Anthropic, OpenAI, and OpenRouter APIs
/// that indicate the request exceeded the model's context window.
pub(super) fn is_context_overflow_error(e: &Error) -> bool {
    let s = e.to_string().to_lowercase();
    s.contains("context_length_exceeded")
        || s.contains("context window")
        || s.contains("request body too large")
        || s.contains("payload too large")
        || s.contains("content too large")
        || s.contains("entity too large")
        || s.contains("maximum context length")
        || (s.contains("413") && (s.contains("too large") || s.contains("payload")))
}

#[cfg(test)]
mod tests {
    use crate::provider::ChatMessage;

    fn tool_msg(content: &str) -> ChatMessage {
        let mut m = ChatMessage::user(content);
        m.role = "tool".to_string();
        m
    }

    #[test]
    fn skill_loop_guard_redirects_same_query_only() {
        use std::collections::HashMap;

        let mut activated: HashMap<String, String> = HashMap::new();

        assert!(
            !super::should_redirect_skill_activation(&activated, "weather", "Roma oggi"),
            "first activation must NOT redirect"
        );

        activated.insert("weather".to_string(), "Roma oggi".to_string());

        assert!(
            super::should_redirect_skill_activation(&activated, "weather", "Roma oggi"),
            "same skill + same query must redirect (loop guard)"
        );

        assert!(
            !super::should_redirect_skill_activation(&activated, "weather", "Milano oggi"),
            "same skill + different query must allow re-activation"
        );

        assert!(
            !super::should_redirect_skill_activation(&activated, "translate", "Roma oggi"),
            "different skill must never redirect"
        );

        activated.insert("idle".to_string(), String::new());
        assert!(
            super::should_redirect_skill_activation(&activated, "idle", ""),
            "empty query, same skill, must redirect (exact match)"
        );
        assert!(
            !super::should_redirect_skill_activation(&activated, "idle", "x"),
            "empty stored vs non-empty new query must NOT redirect"
        );
    }

    #[test]
    fn sigkill_diagnostic_counter_counts_only_tool_role_hits() {
        let msgs = vec![
            ChatMessage::user("elimina i csv"),
            tool_msg("[exit code: -1]\n[diagnostic] Process killed by signal 9 (SIGKILL). Sandbox backend 'macos_seatbelt'..."),
            tool_msg("ok output, no diagnostic"),
            tool_msg("[exit code: -1]\n[diagnostic] Process killed by signal 9 (SIGKILL). Sandbox is not active..."),
            tool_msg("[diagnostic] Process killed by signal 15 (SIGTERM). Sandbox..."),
            ChatMessage::user("[diagnostic] signal 9 SIGKILL fake from user"),
        ];
        assert_eq!(super::count_sigkill_diagnostics(&msgs), 2);
    }

    #[test]
    fn sigkill_diagnostic_counter_empty_messages() {
        assert_eq!(super::count_sigkill_diagnostics(&[]), 0);
    }
}
