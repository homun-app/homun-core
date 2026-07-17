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
    /// S2 T5 (plugin-owned deterministic routing): the routed tool to FORCE `tool_choice` onto
    /// for the turn's main per-round model call — belt-and-suspenders on top of the hard-prune
    /// (S2 T4), which already narrows the offered toolset to the routed tool alone. Resolved
    /// gateway-side ONCE per turn from (the active `RoutingBinding`, its `Forcing::Specific`, and
    /// the thread's user-message count). `None` on the workflow's FIRST turn — the model must
    /// stay free to ask intake questions instead of being railroaded into an immediate, likely
    /// under-specified tool call — and for every turn without an active deterministic binding
    /// (ordinary chats, browse sub-turns): unchanged "auto" behavior.
    pub forced_tool: Option<String>,
}
