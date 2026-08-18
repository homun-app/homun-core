//! Gateway brain runtime configuration.
//!
//! This owner keeps the Brain's enablement flag, context-window budget policy
//! and gateway memory adapter together. Durable task materialization and the
//! agent loop remain outside this module.

use std::env;

use crate::gateway_paths::gateway_memory_database_path;
use local_first_memory::{MemoryFacade, SQLiteMemoryStore};
use local_first_orchestrator::{
    MemoryContextProvider, MemoryContextSnippet, OrchestratorBudgets, OrchestratorRequest,
    OrchestratorResult,
};

pub(crate) fn brain_materialize_enabled() -> bool {
    match env::var("HOMUN_BRAIN_MATERIALIZE") {
        // Explicit override always wins.
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "on"
        ),
        // A1.6: default ON. The only backends are capable cloud/router providers
        // (the weak local MLX/gemma path that this used to disable is gone), so
        // every configured setup plans through the Brain without a flag.
        Err(_) => true,
    }
}

/// P3 (read): the Brain's memory context provider, backed by a second handle on
/// the gateway's memory SQLite DB (same pattern as the shared task store). Holds
/// an `Option` so a memory-DB hiccup degrades to "no memory context" rather than
/// failing planning. `MemoryFacade` already implements the orchestrator's
/// `MemoryContextProvider` (policy-filtered `context_pack` -> snippets), so this
/// just delegates.
pub(crate) struct GatewayBrainMemory(pub(crate) Option<MemoryFacade>);

impl MemoryContextProvider for GatewayBrainMemory {
    fn load_context(
        &self,
        request: &OrchestratorRequest,
    ) -> OrchestratorResult<Vec<MemoryContextSnippet>> {
        match &self.0 {
            Some(facade) => facade.load_context(request),
            None => Ok(Vec::new()),
        }
    }
}

pub(crate) fn open_brain_memory() -> GatewayBrainMemory {
    GatewayBrainMemory(
        gateway_memory_database_path()
            .ok()
            .and_then(|path| SQLiteMemoryStore::open(path).ok())
            .map(MemoryFacade::new),
    )
}

/// Context window (tokens) at/above which we treat the model as "capable" and
/// stop clamping its context: promptjuice becomes a no-op rather than a gate.
pub(crate) const CAPABLE_MODEL_CONTEXT_WINDOW: u32 = 32_000;

/// Budgets scaled to the active model's context window.
///
/// promptjuice (context compression) was built to optimize tokens for cost/time,
/// not to block: under budget it passes content through untouched, and a
/// `max_chars` of 0 means "unlimited". The earlier small-model hard-coded
/// defaults are tiny (1.2-3.2K chars, 768 planner tokens), which makes the
/// compressor clamp essential context away even when a capable model has room to
/// spare. So scale by the window: a big-context model gets generous/unlimited
/// budgets (passthrough); a small or unknown model keeps the cheap defaults.
pub(crate) fn brain_budgets_for_context_window(context_window: Option<u32>) -> OrchestratorBudgets {
    let mut budgets = OrchestratorBudgets::default();
    if context_window.is_some_and(|window| window >= CAPABLE_MODEL_CONTEXT_WINDOW) {
        budgets.max_planner_tokens = 8_000;
        budgets.max_loaded_tools = 16;
        budgets.max_tool_search_rounds = 2;
        // 0 = unlimited: let the compressor pass context through instead of
        // clamping the middle out from under a model that can read it all.
        budgets.max_conversation_summary_chars = 0;
        budgets.max_memory_context_chars = 0;
        budgets.max_tool_cards_context_chars = 0;
        budgets.max_loaded_tool_context_chars = 0;
    }
    budgets
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_brain_runtime_defaults_materialization_on() {
        let previous = env::var("HOMUN_BRAIN_MATERIALIZE").ok();
        unsafe {
            env::remove_var("HOMUN_BRAIN_MATERIALIZE");
        }

        assert!(brain_materialize_enabled());

        unsafe {
            match previous {
                Some(value) => env::set_var("HOMUN_BRAIN_MATERIALIZE", value),
                None => env::remove_var("HOMUN_BRAIN_MATERIALIZE"),
            }
        }
    }

    #[test]
    fn gateway_brain_runtime_scales_budget_for_capable_context_window() {
        let small = brain_budgets_for_context_window(Some(8_192));
        let unknown = brain_budgets_for_context_window(None);
        let capable = brain_budgets_for_context_window(Some(CAPABLE_MODEL_CONTEXT_WINDOW));

        assert_eq!(
            small.max_planner_tokens,
            OrchestratorBudgets::default().max_planner_tokens
        );
        assert_eq!(
            unknown.max_planner_tokens,
            OrchestratorBudgets::default().max_planner_tokens
        );
        assert_eq!(capable.max_planner_tokens, 8_000);
        assert_eq!(capable.max_conversation_summary_chars, 0);
        assert_eq!(capable.max_memory_context_chars, 0);
        assert_eq!(capable.max_tool_cards_context_chars, 0);
        assert_eq!(capable.max_loaded_tool_context_chars, 0);
        assert!(capable.max_loaded_tools > small.max_loaded_tools);
    }
}
