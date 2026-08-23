//! Agent turn loop seed owner.
//!
//! Owns the gateway-side initialization of the engine `LoopState` and the
//! per-turn terminal buffers before the specialized pre-loop seed owners run.
//! The stream, round loop, browser executor, tool execution, and subagents stay
//! in their existing owners.

use super::*;

pub(crate) struct AgentTurnLoopSeed {
    pub(crate) loop_state: local_first_engine::LoopState,
    pub(crate) memory_answer: String,
    pub(crate) last_model_error: Option<String>,
    pub(crate) browse_sources: Vec<String>,
}

pub(crate) fn prepare_agent_turn_initial_messages(
    system: &str,
    user_content: impl Into<serde_json::Value>,
) -> Vec<serde_json::Value> {
    let user_content = user_content.into();

    vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": user_content }),
    ]
}

pub(crate) fn seed_agent_turn_loop_state(
    prompt_packets: Vec<local_first_engine::PromptPacketMetadata>,
    messages: Vec<serde_json::Value>,
) -> AgentTurnLoopSeed {
    let mut loop_state = local_first_engine::LoopState::new();
    loop_state.prompt_packets = prompt_packets;
    loop_state.messages = messages;

    AgentTurnLoopSeed {
        loop_state,
        last_model_error: None,
        memory_answer: String::new(),
        browse_sources: Vec::new(),
    }
}

pub(crate) fn reset_agent_turn_terminal_buffer(thread_id: Option<String>) {
    sandbox_clear(thread_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_messages_preserve_system_and_user_order() {
        let messages = prepare_agent_turn_initial_messages("system text", "user text");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "system text");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "user text");
    }
}
