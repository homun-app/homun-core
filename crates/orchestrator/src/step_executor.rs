//! Concrete [`StepExecutor`]s behind the F3.1 driver seam.
//!
//! [`CapabilityStepExecutor`] runs `CapabilityCall` steps synchronously through
//! the shared [`CapabilityFacade`] — the *canonical* capability execution path
//! (policy gate → argument validation → provider dispatch → audit). It is the
//! first concrete executor behind [`crate::drive_plan`]: it proves the vertical
//! slice plan → in-turn driver → real tool call → done-after-verify with no model
//! and no chat loop, so the control flow is testable against an in-memory
//! provider.
//!
//! What it deliberately does NOT do: run a bounded inner *model* loop for
//! `SubagentTask` steps. Those need the model plus the chat loop's richer tool
//! dispatch (the gateway-side executor, F3.2b). Such a step FAILS here rather than
//! silently passing — a plan that needs agentic execution must never be mistaken
//! for complete (caposaldo #2: a plan not followed is a design bug, not a silent
//! success).

use crate::driver::{StepExecutor, StepOutcome, StepVerifier};
use crate::execution::{provider_id_for_step, tool_name_for_step};
use crate::{OrchestratorError, OrchestratorResult, PlanStep, PlanStepKind};
use local_first_capabilities::{CapabilityCall, CapabilityFacade, PolicyContext};
use std::collections::BTreeMap;

/// Executes `CapabilityCall` steps through the shared capability facade. Borrows
/// the facade mutably for the duration of a drive (the facade records an audit
/// event per call, so it needs `&mut`).
pub struct CapabilityStepExecutor<'a> {
    facade: &'a mut CapabilityFacade,
    context: &'a PolicyContext,
}

impl<'a> CapabilityStepExecutor<'a> {
    pub fn new(facade: &'a mut CapabilityFacade, context: &'a PolicyContext) -> Self {
        Self { facade, context }
    }
}

impl StepExecutor for CapabilityStepExecutor<'_> {
    fn execute_step(
        &mut self,
        step: &PlanStep,
        _completed: &BTreeMap<String, StepOutcome>,
    ) -> OrchestratorResult<StepOutcome> {
        match step.kind {
            PlanStepKind::CapabilityCall => {
                let provider_id = provider_id_for_step(step)?;
                let tool_name = tool_name_for_step(step)?.to_string();
                // The facade is the single canonical execution path: it re-checks
                // policy (fail-closed — e.g. a write needing confirmation the
                // context did not grant is denied here, NOT silently performed),
                // validates arguments against the tool schema, dispatches to the
                // provider, and audits. A denial / tool error becomes Err → the
                // driver marks the step Failed with the message.
                let result = self.facade.call_tool(
                    self.context,
                    CapabilityCall {
                        provider_id,
                        tool_name: tool_name.clone(),
                        arguments: step.arguments.clone(),
                    },
                )?;
                Ok(StepOutcome {
                    succeeded: true,
                    output: result.output,
                    evidence: vec![format!("capability:{tool_name}")],
                })
            }
            // No tool to call: a no-op the driver treats as trivially done. The
            // gateway executor may override these (e.g. surface the direct answer
            // or perform a real memory recall); here they simply do not block.
            PlanStepKind::MemoryLookup | PlanStepKind::DirectAnswer => {
                Ok(StepOutcome::succeeded(serde_json::Value::Null))
            }
            // Agentic steps require the model + chat-loop tool dispatch. Fail
            // loudly so the plan is not reported complete without doing the work.
            PlanStepKind::SubagentTask => Err(OrchestratorError::Planner(format!(
                "subagent_step_needs_agentic_executor:{}",
                step.step_id
            ))),
        }
    }
}

/// Deterministic verify gate for capability steps: a step is "verified" exactly
/// when the facade returned success — policy, argument validation and the
/// provider all passed. For capability tools that IS the real gate; there is no
/// separate judgment to make, so introducing an LLM here would only add nondeterminism.
///
/// Agentic (`SubagentTask`) steps need a real judgment over their evidence — that
/// is the gateway's LLM `verify_step_complete` (F3.2b), not this verifier.
pub struct PassThroughVerifier;

impl StepVerifier for PassThroughVerifier {
    fn verify(&mut self, _step: &PlanStep, outcome: &StepOutcome) -> bool {
        outcome.succeeded
    }
}
