//! Per-turn resolved configuration (ADR 0024, increment 5, Point 5 / 5.D1c.1).
//!
//! The engine is a leaf library: it must NOT read process env or global config. Every knob the loop
//! needs is resolved ONCE gateway-side (from env / user settings) into this struct and passed in.
//! Resolving once per turn is behavior-preserving: these knobs are env-stable for the turn's duration,
//! so reading them once up front is identical to the loop's current repeated `getter()` calls — and it
//! keeps the moved loop pure (no env access from the crate). The struct grows as later 5.D1c slices
//! relocate helpers that read further getters (e.g. step-verification / auto-advance flags ride along
//! when `try_advance_frontier_from_evidence` moves).

/// The loop's turn-constant configuration. Built by the gateway before the turn from the corresponding
/// config getters; the loop reads these fields instead of calling env-backed functions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserStopReason {
    WallClock,
    FailedNavigations,
    NoProgress,
}

impl BrowserStopReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WallClock => "wall_clock",
            Self::FailedNavigations => "failed_navigations",
            Self::NoProgress => "no_progress",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserBudget {
    pub max_elapsed_ms: u64,
    pub max_failed_navigations: u32,
    pub max_no_progress: u32,
}

impl BrowserBudget {
    pub fn stop_reason(
        self,
        elapsed_ms: u64,
        failed_navigations: u32,
        no_progress: u32,
    ) -> Option<BrowserStopReason> {
        if elapsed_ms >= self.max_elapsed_ms {
            Some(BrowserStopReason::WallClock)
        } else if failed_navigations >= self.max_failed_navigations {
            Some(BrowserStopReason::FailedNavigations)
        } else if no_progress >= self.max_no_progress {
            Some(BrowserStopReason::NoProgress)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone)]
pub struct TurnConfig {
    /// Absolute upper bound on ReAct rounds (the outer `for round in 0..hard_round_ceiling()`).
    pub hard_round_ceiling: usize,
    /// Effective per-step round budget for a NON-browser turn.
    pub max_rounds: usize,
    /// Effective per-step round budget once a browser tool has been used (the larger browsing ceiling).
    pub browser_max_rounds: usize,
    /// Wander-cap: max `browser_navigate` calls for the CURRENT step before forcing synthesis.
    pub browser_nav_cap: usize,
    /// Wall-clock and stagnation limits for browser work inside this turn.
    pub browser_budget: BrowserBudget,
    /// The active model's context window in tokens, if known (catalog `context_window`, Fase 1.1).
    /// Feeds token-budget auto-compaction (`ContextCompactor::compact_for_budget`): `None` → the
    /// window is unknown → fail-open (no budget compaction, only the existing round-based hygiene).
    pub context_window: Option<usize>,
    /// Whether the delivery reconcile pass runs (`plan_reconcile_on_delivery_enabled`).
    pub reconcile_on_delivery: bool,
    /// Whether the mid-turn evidence-driven frontier auto-advance runs (`plan_autoadvance_from_evidence_enabled`).
    pub autoadvance_from_evidence: bool,
    /// Whether the F2 step-verification judge runs at all (`step_verification_enabled`).
    pub step_verification: bool,
    /// Dev-time verbose logging gate.
    pub verbose: bool,
    /// S2 T5 (plugin-owned deterministic routing): the routed tool to FORCE `tool_choice` onto —
    /// belt-and-suspenders on top of the hard-prune (S2 T4), which already narrows the offered
    /// toolset to the routed tool alone. Resolved gateway-side ONCE per turn from (the active
    /// `RoutingBinding`, its `Forcing::Specific`, and the thread's user-message count). `None` on
    /// the workflow's FIRST turn — the model must stay free to ask intake questions instead of
    /// being railroaded into an immediate, likely under-specified tool call — and for every turn
    /// without an active deterministic binding (ordinary chats, browse sub-turns): unchanged
    /// "auto" behavior.
    ///
    /// Final-review fix (C1): this value is a per-TURN constant, but the loop only ever applies
    /// it to round 0 of that turn (`agent_loop::run_turn`'s call site gates on `round == 0`) —
    /// forcing is one-shot, never repeated on later rounds within the same turn. A forced
    /// `tool_choice` contractually MUST come back with a tool call, so re-forcing on every round
    /// would never let the loop terminate: after a successful delivery, the very next round would
    /// force ANOTHER call to the same tool (a duplicate render, and by then the routing binding is
    /// already cleared so it would go through generic/unbound).
    pub forced_tool: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_budget_stops_on_time_or_stagnation() {
        let budget = BrowserBudget {
            max_elapsed_ms: 300_000,
            max_failed_navigations: 8,
            max_no_progress: 5,
        };

        assert_eq!(
            budget.stop_reason(300_001, 0, 0),
            Some(BrowserStopReason::WallClock)
        );
        assert_eq!(
            budget.stop_reason(1_000, 8, 0),
            Some(BrowserStopReason::FailedNavigations)
        );
        assert_eq!(
            budget.stop_reason(1_000, 0, 5),
            Some(BrowserStopReason::NoProgress)
        );
        assert_eq!(budget.stop_reason(1_000, 7, 4), None);
    }
}
