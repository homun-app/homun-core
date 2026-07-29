//! What a turn produces for the gateway's post-turn tail (ADR 0024, increment 5, Point 5 / 5.D1c.8).
//!
//! The round loop + forced synthesis run in the engine; the post-turn side-effects — mining the
//! exchange for durable memory (the `learn` extractor) and refreshing the project code-graph — are
//! GATEWAY concerns (they need `AppState`/stores/spawn), so they run in the caller AFTER the turn
//! returns, driven by this outcome. Splitting them out is what lets the loop body move into this leaf
//! crate without dragging the memory/graph subsystems along.

use local_first_execution_protocol::ExecutionFailure;

/// Engine-level reason the guarded loop stopped.
///
/// These variants intentionally describe no task, run, message, or transport
/// state. The execution runtime is the sole owner of that lifecycle projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnStop {
    Completed,
    SuspendedUser,
    SuspendedApproval,
    /// One effect may have completed remotely and needs typed resolution before resume.
    SuspendedEffect {
        /// Receipt that must be resolved before execution may continue.
        receipt_ref: local_first_execution_protocol::EffectReceiptRef,
    },
    SuspendedModel { role: String },
    Failed { failure: ExecutionFailure },
}

impl Default for TurnStop {
    fn default() -> Self {
        Self::Failed {
            failure: ExecutionFailure::permanent("no_reply", "The turn produced no final reply"),
        }
    }
}

pub(crate) fn classify_turn_stop(
    visible_answer: bool,
    awaiting_user: Option<&crate::hitl::HitlEnvelope>,
    suspended_model_role: Option<&str>,
) -> TurnStop {
    if let Some(wait) = awaiting_user {
        return if wait.is_free() {
            TurnStop::SuspendedUser
        } else {
            TurnStop::SuspendedApproval
        };
    }
    if visible_answer {
        return TurnStop::Completed;
    }
    if let Some(role) = suspended_model_role {
        return TurnStop::SuspendedModel {
            role: role.to_string(),
        };
    }
    TurnStop::default()
}

/// The turn's result the gateway tail consumes. Kept minimal — only what the tail can't already see
/// (everything else, like `read_only` / `thread_id` / the memory scope, the caller still holds).
#[derive(Debug, Default, Clone)]
pub struct TurnOutcome {
    /// Exhaustive engine-level stop classification consumed by the execution runtime.
    pub stop: TurnStop,
    /// The committed final answer text (the `Done` payload). Fed to the memory learn extractor; empty
    /// means the turn produced no answer (the tail then skips learning).
    pub memory_answer: String,
    /// The turn's consequential tool actions, newline-joined — the "why" the learn extractor records
    /// alongside the answer.
    pub tool_actions: String,
    /// Provenance delle letture collegate che hanno informato la risposta.
    pub memory_reads: crate::events::TurnMemoryReadSet,
    /// The source URLs actually visited this turn (the browser_navigate targets), in first-seen order.
    /// The MAIN path already folds these into the answer's "Fonti" section and ignores this field; it
    /// exists for ADR 0025's `browse(goal)` recursion, where the sub-turn's `BrowseResult.sources` is
    /// these URLs (the answer itself stays clean, the manager owns source presentation).
    pub browse_sources: Vec<String>,
    /// The turn's FINAL runtime plan (opaque serialized `ExecutionPlan`, `Null` when the turn had no
    /// plan). Carried out so the gateway's `turn_trace` `TurnEnd` can report per-step final status +
    /// the derived "claimed done without artifact" flag — the plan lives in the consumed `LoopState`,
    /// so it can only reach the caller through the outcome. Observability-only; no path reads it for
    /// control flow (the `browse` recursion ignores it).
    pub final_plan: serde_json::Value,
    /// Set when the turn died because the model cannot look at the images it was sent, and NOTHING was
    /// streamed or committed for it (the loop returns before the final answer). Carries the provider's
    /// message. The gateway either recovers — describe the images on the `vision` role, re-seed, re-run
    /// — or, if it has no vision model to fall back on, surfaces this as the turn's answer.
    ///
    /// Only ever set on a turn that has not yet executed a tool: a replayed turn must not re-run side
    /// effects, so a rejection arriving after the model has already acted takes the ordinary (fatal,
    /// user-visible) error path instead.
    pub image_rejection: Option<String>,
    /// Structured HITL wait the harness entered (Turn Contract). When `Some`, the gateway MUST
    /// persist a Free wait / hold Confirm and MUST NOT treat the next user message as a fresh
    /// objective without ResumeBinding. Prose-only asks never set this.
    pub awaiting_user: Option<crate::hitl::HitlEnvelope>,
}

#[cfg(test)]
mod tests {
    use super::{TurnStop, classify_turn_stop};
    use crate::hitl::{HitlEnvelope, HitlKind, HoldPolicy};
    use local_first_execution_protocol::{ExecutionFailure, FailureClass};

    fn wait(kind: HitlKind, hold_policy: HoldPolicy) -> HitlEnvelope {
        HitlEnvelope {
            kind,
            hold_policy,
            payload: serde_json::json!({"prompt": "continue?"}),
            source_marker: "test".to_string(),
        }
    }

    #[test]
    fn visible_answer_completes_without_a_wait() {
        assert_eq!(classify_turn_stop(true, None, None), TurnStop::Completed);
    }

    #[test]
    fn free_and_hold_waits_have_distinct_stops() {
        let choice = wait(HitlKind::Choice, HoldPolicy::Free);
        let approval = wait(HitlKind::Confirm, HoldPolicy::Hold);

        assert_eq!(
            classify_turn_stop(true, Some(&choice), None),
            TurnStop::SuspendedUser
        );
        assert_eq!(
            classify_turn_stop(true, Some(&approval), None),
            TurnStop::SuspendedApproval
        );
    }

    #[test]
    fn model_suspension_wins_only_without_a_visible_answer() {
        assert_eq!(
            classify_turn_stop(false, None, Some("primary")),
            TurnStop::SuspendedModel {
                role: "primary".to_string()
            }
        );
        assert_eq!(
            classify_turn_stop(true, None, Some("primary")),
            TurnStop::Completed
        );
    }

    #[test]
    fn missing_final_answer_is_a_permanent_failure() {
        let TurnStop::Failed { failure } = classify_turn_stop(false, None, None) else {
            panic!("missing answer must fail");
        };
        assert_eq!(failure.class, FailureClass::Permanent);
        assert_eq!(failure.code, "no_reply");
        assert_eq!(
            failure,
            ExecutionFailure::permanent("no_reply", "The turn produced no final reply")
        );
    }
}
