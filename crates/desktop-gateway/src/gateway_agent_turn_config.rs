//! Agent turn loop config owner.
//!
//! Owns the gateway-side construction of the turn-constant engine config.
//! Routing, HITL resume resolution, browser execution, and the agent loop stay
//! in their existing owners; this module only consumes their resolved values.

use super::*;

pub(crate) struct AgentTurnConfigInput {
    pub(crate) context_window: Option<usize>,
    pub(crate) forced_tool: Option<String>,
    pub(crate) resolved_hitl: Option<local_first_engine::hitl::ResolvedHitlGuard>,
}

pub(crate) struct AgentTurnConfigRuntimeScope {
    pub(crate) turn_config: local_first_engine::TurnConfig,
}

pub(crate) fn resolve_agent_turn_config(
    input: AgentTurnConfigInput,
) -> AgentTurnConfigRuntimeScope {
    AgentTurnConfigRuntimeScope {
        turn_config: local_first_engine::TurnConfig {
            hard_round_ceiling: hard_round_ceiling(),
            max_rounds: chat_max_rounds(),
            browser_max_rounds: chat_browser_max_rounds(),
            browser_nav_cap: chat_browser_nav_cap(),
            browser_budget: chat_manager_browser_budget(),
            context_window: input.context_window,
            reconcile_on_delivery: plan_reconcile_on_delivery_enabled(),
            autoadvance_from_evidence: plan_autoadvance_from_evidence_enabled(),
            step_verification: step_verification_enabled(),
            verbose: verbose_debug(),
            forced_tool: input.forced_tool,
            browser_subturn: false,
            resolved_hitl: input.resolved_hitl,
        },
    }
}
