//! Adaptive scaffolding floor (ADR 0018).
//!
//! The harness keeps everything AROUND the agent loop uniform for every model
//! (memory, context, tool registry, valid tool-call envelope, stop conditions —
//! the "Pavimento"). What scales INVERSE to model capability is how tightly the
//! IN-loop reasoning is constrained — the "Manopole". This module is the single
//! pure mapping from a model's [`ModelTier`] to those knobs, so the policy lives
//! in one tested place instead of scattered `if tier == Fast` checks.
//!
//! Three orthogonal axes, do not conflate:
//! - capability (this module): how much scaffolding.
//! - risk/approval: gated on the ACTION, never on model capability.
//! - role selection (`model_registry`): which model serves a role.
//!
//! Staged rollout (ADR 0018): this slice ships the pure types only. They are
//! wired into the turn behind a `shadow` flag in the next phase, at which point
//! the module-level `allow(dead_code)` below is removed.
#![allow(dead_code)]

use crate::model_registry::ModelTier;

/// How the model is asked to emit structured output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    /// Force a grammar/JSON-schema on every orchestration-critical emission: weak
    /// models can't be trusted to tool-call cleanly. The cross-model floor.
    ForcedGrammar,
    /// Let a capable model use native tool-calling (more freedom, less fragile on
    /// models that genuinely support it). Tolerant parsing stays as the safety net.
    NativeToolCalling,
}

/// How strongly the runtime biases toward declared workflows vs free agentic tools.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkflowBias {
    /// Weak: route deliverables through one-shot workflows (`make_deck`) and
    /// withhold the granular construction tools — nothing for the model to get
    /// wrong beyond filling the brief slot.
    ForceWorkflow,
    /// Middle: offer both, nudge toward workflows in the system prompt.
    Prefer,
    /// Capable: offer the granular/agentic tools and let the model plan.
    AllowAgentic,
}

/// Granularity of the slots the model fills per turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// One task = one node, tight slots.
    OneShot,
    /// Per-step slots.
    PerStep,
    /// Free planning, wide slots.
    Free,
}

/// How aggressively the runtime verifies a step before marking it done.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyDepth {
    /// Verify every step (weak models over-claim "done").
    Always,
    /// Verify only steps that performed a mutating (non-`Read`) action.
    OnRisk,
    /// Trust the step without a verification round (reserved; not a default).
    Off,
}

/// The "Manopole" of [ADR 0018], derived purely from a model's [`ModelTier`].
/// The "Pavimento" (memory, context, tool envelope, stop conditions) is NOT here:
/// it stays uniform for every tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScaffoldProfile {
    pub format: Format,
    pub workflow_bias: WorkflowBias,
    pub slot: Slot,
    pub verify_depth: VerifyDepth,
}

/// The single source of truth mapping tier → scaffolding knobs. Pure and total.
///
/// Invariant we rely on elsewhere: constraint scales inverse to capability, so as
/// local models improve and get reclassified UP a tier, the harness sheds
/// scaffolding automatically (it rides model improvement instead of fighting it).
pub fn scaffold_for(tier: ModelTier) -> ScaffoldProfile {
    match tier {
        ModelTier::Fast => ScaffoldProfile {
            format: Format::ForcedGrammar,
            workflow_bias: WorkflowBias::ForceWorkflow,
            slot: Slot::OneShot,
            verify_depth: VerifyDepth::Always,
        },
        ModelTier::Balanced => ScaffoldProfile {
            format: Format::ForcedGrammar,
            workflow_bias: WorkflowBias::Prefer,
            slot: Slot::PerStep,
            verify_depth: VerifyDepth::OnRisk,
        },
        ModelTier::Reasoning => ScaffoldProfile {
            format: Format::NativeToolCalling,
            workflow_bias: WorkflowBias::AllowAgentic,
            slot: Slot::Free,
            // Capable models still verify risky steps: risk is orthogonal to
            // capability (ADR 0018). Capability buys freedom of FORM, not a pass
            // on irreversible-action verification.
            verify_depth: VerifyDepth::OnRisk,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fast_tier_is_maximally_constrained() {
        let p = scaffold_for(ModelTier::Fast);
        assert_eq!(p.format, Format::ForcedGrammar);
        assert_eq!(p.workflow_bias, WorkflowBias::ForceWorkflow);
        assert_eq!(p.slot, Slot::OneShot);
        assert_eq!(p.verify_depth, VerifyDepth::Always);
    }

    #[test]
    fn reasoning_tier_is_freed() {
        let p = scaffold_for(ModelTier::Reasoning);
        assert_eq!(p.format, Format::NativeToolCalling);
        assert_eq!(p.workflow_bias, WorkflowBias::AllowAgentic);
        assert_eq!(p.slot, Slot::Free);
        assert_eq!(p.verify_depth, VerifyDepth::OnRisk);
    }

    #[test]
    fn balanced_tier_is_in_between() {
        let p = scaffold_for(ModelTier::Balanced);
        assert_eq!(p.workflow_bias, WorkflowBias::Prefer);
        assert_eq!(p.slot, Slot::PerStep);
    }

    #[test]
    fn constraint_is_monotonic_in_tier() {
        // Slot freedom and workflow freedom never DECREASE as the tier rises:
        // the whole point of the adaptive floor.
        let order = [ModelTier::Fast, ModelTier::Balanced, ModelTier::Reasoning];
        let slot_rank = |s: Slot| match s {
            Slot::OneShot => 0,
            Slot::PerStep => 1,
            Slot::Free => 2,
        };
        let bias_rank = |b: WorkflowBias| match b {
            WorkflowBias::ForceWorkflow => 0,
            WorkflowBias::Prefer => 1,
            WorkflowBias::AllowAgentic => 2,
        };
        for w in order.windows(2) {
            let a = scaffold_for(w[0]);
            let b = scaffold_for(w[1]);
            assert!(slot_rank(a.slot) <= slot_rank(b.slot));
            assert!(bias_rank(a.workflow_bias) <= bias_rank(b.workflow_bias));
        }
    }
}
