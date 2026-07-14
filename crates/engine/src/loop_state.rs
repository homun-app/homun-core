//! The agent loop's turn-carried state (ADR 0024, increment 5, Point 4).
//!
//! The single guarded ReAct loop (motore #1) owns a `&mut LoopState` and mutates these
//! fields directly across rounds. The struct bundles every loop-carried local so the
//! engine's control-flow state is one typed value rather than a fistful of parameters.
//!
//! Scope discipline: this holds ONLY state that survives across rounds (turn-carried).
//! Per-round locals (e.g. the approval `pending_confirm` flag, reset each iteration)
//! stay in the loop. This grows across slices — Point 4a lands the pure accumulators,
//! Point 4b adds `messages`/`plan` (as `serde_json::Value`, since `ExecutionPlan` lives
//! in a downstream crate the leaf `engine` can't reference) and the provider binding;
//! browser state stays gateway-side behind the temporary seam until ADR 0025.

use crate::contract::{ProviderBinding, ToolEffects};
use serde_json::Value;
use std::collections::BTreeSet;

/// Turn-carried state of the single guarded loop. Fields are `pub` because the loop
/// that mutates them still lives in the gateway; once the loop body moves into this
/// crate (Point 5) the mutation is local and this can encapsulate if useful.
///
/// `Default` gives the loop's start-of-turn zero value. Most fields start at their
/// default; the gateway constructs it with [`LoopState::new`] and then SEEDS the fields
/// that carry pre-loop setup — `messages` (the initial system+user context, built
/// gateway-side) is the first such field. `Send` (all fields are `Send`) because the
/// loop runs inside `tokio::spawn`.
/// `Clone` so a turn can be REPLAYED from its pristine seed: the vision fallback re-runs a turn whose
/// images the model refused to look at, from a conversation where they've been swapped for a vision
/// model's description. Only ever cloned before the loop starts (a 2-message state), and only for a
/// turn that carries images — never mid-loop, where a copy would mean two divergent histories.
#[derive(Debug, Default, Clone)]
pub struct LoopState {
    /// The OpenAI-compat conversation array the model sees: seeded gateway-side with the
    /// system+user messages, then grown by the loop (assistant turns, tool results,
    /// F3 compaction). `Value` (not a typed message) because the loop builds these as
    /// raw JSON and the crate stays serde-only.
    pub messages: Vec<Value>,
    /// Index into `messages` where the CURRENT plan step's work begins; once the step is
    /// verified, that slice is compacted into one note (F3) so a long multi-step turn
    /// stays within the context window.
    pub step_messages_start: usize,
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
    /// The tool schemas exposed to the model this turn: seeded gateway-side with the base
    /// toolset (trimmed by policy), then extended as capabilities load (see `loaded_tools`).
    pub tool_schemas: Vec<Value>,
    /// Sensitive domains armed by a `use_skill` this turn (ADR 0023 Step 5): kebab-case
    /// tokens (`financial`/`medical`/…) carried across rounds so a skill loaded in an early
    /// round keeps forcing confirms on effectful actions in later rounds. `String` (not the
    /// gateway's `SensitiveCategory` enum) because the leaf engine can't reference that type;
    /// the gateway re-hydrates the enum per call. Non-empty → the harness force-confirms
    /// effectful actions regardless of approval policy (`skill_policy_forces_confirm`).
    pub active_sensitive: Vec<String>,
    /// The canonical runtime plan, carried as an opaque `Value` (the serialized `ExecutionPlan`)
    /// because that type lives in a downstream crate the leaf `engine` can't reference. The gateway
    /// seeds it (resume) and round-trips it faithfully via serde at the plan-helper boundaries; the
    /// pure step queries live in `engine::plan` (which already operates on `Value` steps).
    pub plan: Value,
    /// The effective provider for the CURRENT round (model + base_url + api_key). Seeded from the
    /// turn's model, then REPLACED wholesale by a mid-turn fallback swap (`ls.provider = out.provider`).
    /// Lives here (not turn-constant) because a tool's own model call and the next round read it, and
    /// the swap changes it per-round — so it must travel with the per-call state (ADR 0026).
    pub provider: ProviderBinding,
    /// Browser-turn state the LOOP itself reads (ADR 0024 inc 5, 5.D1b slice 5a). Only the fields the
    /// loop body touches OUTSIDE the browser branch live here: `browser_used` drives the round budget
    /// (a browsing turn earns the larger ceiling) and the final-answer assembly; `pending_browser_image`
    /// is consumed by the loop to inject the latest screenshot as a vision message and reported in the
    /// trace-dump; `browser_tool_call_ids` drives `prune_browser_history` (keep only the newest browser
    /// result). The browser-PRIVATE state (last snapshot, target/tab bookkeeping, per-URL nav failures)
    /// and the gateway-typed `browser_session` stay OWNED BY the browser executor, not here — the
    /// engine-safe `LoopState` carries only what the engine loop must see (ADR 0025 seam boundary).
    pub browser_used: bool,
    /// A screenshot data-URL captured this round, pending injection into `messages` as a vision turn.
    pub pending_browser_image: Option<String>,
    /// The tool-call ids of browser results, so `prune_browser_history` keeps only the freshest one.
    pub browser_tool_call_ids: BTreeSet<String>,
}

impl LoopState {
    /// The start-of-turn value (all fields at their default zero). A named constructor
    /// (over bare `Default::default()`) so the gateway call site reads intentionally and
    /// so future seeded fields have one place to land.
    pub fn new() -> Self {
        Self::default()
    }

    /// Apply a tool's returned loop-state effects (ADR 0024 inc 5d.1b; relocated to a method in
    /// 5.D1c.2). The executor stopped mutating a `ctx` inline; the loop calls this right after the
    /// call so the net state matches the old inline mutation exactly. Each branch mirrors one former
    /// `ctx.<field>` write. `pending_confirm` is the per-ROUND approval flag (reset each iteration, so
    /// it stays a loop local, not a field); `round` is the F1 progress anchor.
    pub fn apply_effects(&mut self, pending_confirm: &mut bool, round: usize, effects: ToolEffects) {
        for line in &effects.append_output {
            self.accumulated.push_str(line);
        }
        // P5: `plan` is the opaque `Value`, so the effect (already the whole plan serialized by the
        // update_plan arm) is assigned directly — no deserialize round-trip, same whole-plan result.
        if let Some(plan_val) = effects.plan {
            self.plan = plan_val;
        }
        for tool in effects.load_tools {
            // Same dedup-then-add as inline: `insert` returns false if already loaded → skip; add a
            // schema only when present (a connector key can be marked loaded with no schema).
            if self.loaded_tools.insert(tool.key) {
                if let Some(schema) = tool.schema {
                    self.tool_schemas.push(schema);
                }
            }
        }
        for line in effects.trace {
            if self.tool_trace.len() < 20 {
                self.tool_trace.push(line);
            }
        }
        if effects.clear_evidence {
            self.step_evidence.clear();
        }
        if effects.request_confirm {
            *pending_confirm = true;
        }
        for cat in effects.arm_sensitive {
            // ADR 0023 Step 5: dedup so repeated `use_skill` of the same (or overlapping)
            // sensitive skills doesn't grow the armed set across rounds.
            if !self.active_sensitive.contains(&cat) {
                self.active_sensitive.push(cat);
            }
        }
        if effects.request_compaction {
            self.pending_compaction = true;
        }
        if effects.reset_stall_guards {
            // F1: real progress → anchor this round, zero the repeat counter, clear the last-round sig.
            self.progress_anchor_round = round;
            self.repeat_count = 0;
            self.last_round_sig.clear();
        }
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
        assert!(ls.messages.is_empty());
        assert_eq!(ls.step_messages_start, 0);
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
        assert!(ls.tool_schemas.is_empty());
        assert!(ls.active_sensitive.is_empty());
        assert!(ls.plan.is_null(), "plan starts as Null until the gateway seeds it");
        assert!(ls.provider.model.is_empty() && ls.provider.base_url.is_empty());
        assert!(!ls.browser_used);
        assert!(ls.pending_browser_image.is_none());
        assert!(ls.browser_tool_call_ids.is_empty());
    }
}
