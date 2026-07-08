//! The agent loop's turn-carried state (ADR 0024, increment 5, Point 4).
//!
//! The single guarded ReAct loop (motore #1) still runs inline in the gateway
//! (`stream_chat_via_openai`), but its loop-carried locals are bundled here so the
//! struct is defined at its eventual destination: when the loop body relocates into
//! this crate (Point 5, behind `HOMUN_ENGINE_CRATE`) it will own a `&mut LoopState`
//! and mutate these fields directly — no second move. Adopting it in-place first
//! (gateway constructs it, the inline loop mutates it) keeps every slice
//! behavior-preserving and lets the compiler prove the field set is complete.
//!
//! Scope discipline: this holds ONLY state that survives across rounds (turn-carried).
//! Per-round locals (e.g. the approval `pending_confirm` flag, reset each iteration)
//! stay in the loop. This grows across slices — Point 4a lands the pure accumulators,
//! Point 4b adds `messages`/`plan` (as `serde_json::Value`, since `ExecutionPlan` lives
//! in a downstream crate the leaf `engine` can't reference) and the provider binding;
//! browser state stays gateway-side behind the temporary seam until ADR 0025.

use std::collections::BTreeSet;

/// Turn-carried state of the single guarded loop. Fields are `pub` because the loop
/// that mutates them still lives in the gateway; once the loop body moves into this
/// crate (Point 5) the mutation is local and this can encapsulate if useful.
///
/// `Default` gives the loop's start-of-turn zero value; every field currently starts
/// at its default, so the gateway constructs it with [`LoopState::new`] and seeds
/// nothing. `Send` (all fields are `Send`) because the loop runs inside `tokio::spawn`.
#[derive(Debug, Default)]
pub struct LoopState {
    /// The authoritative, SANITIZED answer text accumulated this turn — the payload the
    /// `Done` event delivers (the raw text already streamed live via the collectors).
    pub accumulated: String,
    /// A deferred vault-reveal marker to append to the final answer if the turn produced
    /// one but never emitted it inline.
    pub pending_vault_reveal_marker: Option<String>,
    /// Consequential actions performed this turn (any domain) → fed to the memory
    /// extractor so the "why" of each mutation is remembered.
    pub tool_trace: Vec<String>,
    /// No-progress guard (F1): signature of the last round's tool calls; a repeat means
    /// the model is stuck (see `repeat_count`).
    pub last_round_sig: String,
    /// How many consecutive rounds produced the identical tool-call signature.
    pub repeat_count: u32,
    /// F1 long-horizon budget anchor: the round at which the last plan step closed. The
    /// per-step round budget is measured from here, not from round 0.
    pub progress_anchor_round: usize,
    /// Evidence-count at the last harness-driven plan auto-advance attempt — the stride
    /// gate so the (cheap) verifier doesn't run on every single tool result.
    pub progress_verify_anchor: usize,
    /// Evidence gathered for the current frontier plan step (drives F2 verification).
    pub step_evidence: Vec<String>,
    /// F3 flag: a completed step's context should be compacted at the next round boundary.
    pub pending_compaction: bool,
    /// The set of dynamically-loaded tool keys already live in the turn's toolset (so a
    /// second load of the same capability is a no-op).
    pub loaded_tools: BTreeSet<String>,
}

impl LoopState {
    /// The start-of-turn value (all fields at their default zero). A named constructor
    /// (over bare `Default::default()`) so the gateway call site reads intentionally and
    /// so future seeded fields have one place to land.
    pub fn new() -> Self {
        Self::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Guards the "start-of-turn zero" contract: the gateway constructs `LoopState::new()`
    // and seeds nothing, so every field must begin empty. If a field ever gains a non-default
    // start value this test forces it to be an explicit, tested choice rather than a surprise.
    #[test]
    fn new_is_all_empty() {
        let ls = LoopState::new();
        assert!(ls.accumulated.is_empty());
        assert!(ls.pending_vault_reveal_marker.is_none());
        assert!(ls.tool_trace.is_empty());
        assert!(ls.last_round_sig.is_empty());
        assert_eq!(ls.repeat_count, 0);
        assert_eq!(ls.progress_anchor_round, 0);
        assert_eq!(ls.progress_verify_anchor, 0);
        assert!(ls.step_evidence.is_empty());
        assert!(!ls.pending_compaction);
        assert!(ls.loaded_tools.is_empty());
    }
}
