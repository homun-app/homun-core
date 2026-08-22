//! Agent turn execution identity owner.
//!
//! Owns the stable identity derived from a chat stream request before the
//! engine loop starts: execution journal handle, effect run/turn identifiers
//! and whether the turn is a canonical broker turn. It does not own stream
//! setup, loop execution, post-loop tail work, browser execution or subagents.

use super::*;

pub(crate) struct AgentTurnExecutionIdentity {
    pub(crate) execution_journal: agent_journal::GatewayJournal,
    pub(crate) effect_run_id: Option<String>,
    pub(crate) effect_turn_id: Option<String>,
    pub(crate) canonical_broker_turn: bool,
}

pub(crate) fn resolve_agent_turn_execution_identity(
    request_id: &str,
    agent_run_id: Option<&str>,
) -> AgentTurnExecutionIdentity {
    let effect_run_id = agent_run_id.map(str::to_string);
    let effect_turn_id =
        agent_run_id.and_then(|_| request_id.strip_prefix("broker-").map(str::to_string));

    AgentTurnExecutionIdentity {
        execution_journal: agent_journal::for_run(agent_run_id),
        canonical_broker_turn: effect_turn_id.is_some(),
        effect_run_id,
        effect_turn_id,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_agent_turn_execution_identity;

    #[test]
    fn broker_request_with_run_id_resolves_effect_turn_identity() {
        let identity = resolve_agent_turn_execution_identity("broker-turn-123", Some("run-123"));

        assert_eq!(identity.effect_run_id.as_deref(), Some("run-123"));
        assert_eq!(identity.effect_turn_id.as_deref(), Some("turn-123"));
        assert!(identity.canonical_broker_turn);
    }

    #[test]
    fn non_broker_request_does_not_fabricate_effect_turn_identity() {
        let identity = resolve_agent_turn_execution_identity("chat-request", Some("run-123"));

        assert_eq!(identity.effect_run_id.as_deref(), Some("run-123"));
        assert_eq!(identity.effect_turn_id, None);
        assert!(!identity.canonical_broker_turn);
    }
}
