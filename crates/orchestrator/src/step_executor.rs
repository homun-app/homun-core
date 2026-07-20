//! The concrete [`StepExecutor`] behind the F3.1 driver seam.
//!
//! [`CapabilityStepExecutor`] runs `CapabilityCall` steps synchronously through
//! the shared [`CapabilityFacade`] — the *canonical* capability execution path
//! (policy gate → argument validation → provider dispatch → audit). It is the
//! per-step engine of ADR 0020: the model fills the slot, the harness owns the
//! control flow and the execution.
//!
//! ## Model-fills-slot argument filling (ADR 0016 Pilastro 3)
//!
//! The planner produces the plan SHAPE — `step_id`, `tool_name`, `goal`,
//! `depends_on` — but deliberately leaves `arguments` EMPTY (it owns the plan, not
//! the per-call arguments). So before executing a capability step whose arguments
//! are missing, the executor asks the model to fill them, **constrained to the
//! tool's input schema**. Constrained decoding is what makes a weak model emit
//! schema-valid arguments (the same lever the planner uses). When the caller
//! already supplied concrete arguments (static/declarative plans, or a turn that
//! pre-filled them), the model call is skipped.
//!
//! ## SubagentTask steps
//!
//! Dispatched to [`crate::agentic::run_agentic_step`] — a bounded inner loop where
//! the model steers (chooses the next read/gather tool, or finishes) while the
//! harness owns the round budget and forced synthesis (ADR 0016 Pilastro 2 *agent*
//! mode). Read/gather scope only; writes are out of scope (they need the
//! single-threaded + approval machinery).

use crate::driver::{StepExecutor, StepOutcome, StepVerifier};
use crate::execution::tool_for_step;
use crate::{OrchestratorError, OrchestratorResult, PlanStep, PlanStepKind};
use local_first_capabilities::{
    ActionClass, CapabilityCall, CapabilityFacade, CapabilityTool, PolicyContext,
};
use local_first_subagents::{GenerateJsonRequest, JsonRuntime};
use std::collections::BTreeMap;

/// Default token ceiling for an argument-fill model call. Arguments are small;
/// keep this tight so a step's slot-fill cannot run away.
const ARG_FILL_MAX_TOKENS: u32 = 512;
/// Default per-call timeout (seconds) for an argument-fill model call.
const ARG_FILL_TIMEOUT_SECONDS: u64 = 60;
/// Cap on how much of an upstream step's output is fed into the arg-fill prompt,
/// so a large snapshot does not blow the context.
const UPSTREAM_DIGEST_CHARS: usize = 400;

/// Executes `CapabilityCall` steps through the shared capability facade, filling
/// missing arguments via the model (constrained to the tool schema). Generic over
/// the [`JsonRuntime`] so the same executor serves the gateway (Ollama/cloud) and
/// tests (a stub).
///
/// `loaded_tools` are the policy-visible tools the plan was validated against. The
/// executor resolves each step's tool through `tool_for_step` — the SAME tolerant
/// resolution `validate_plan` uses — so a weak model that crammed arguments into
/// the `tool_name` field (caposaldo #11) is resolved identically at execution and
/// at validation. Without this, a plan could validate yet fail to execute.
pub struct CapabilityStepExecutor<'a, R> {
    runtime: &'a R,
    facade: &'a mut CapabilityFacade,
    context: &'a PolicyContext,
    loaded_tools: &'a [CapabilityTool],
}

impl<'a, R: JsonRuntime> CapabilityStepExecutor<'a, R> {
    pub fn new(
        runtime: &'a R,
        facade: &'a mut CapabilityFacade,
        context: &'a PolicyContext,
        loaded_tools: &'a [CapabilityTool],
    ) -> Self {
        Self {
            runtime,
            facade,
            context,
            loaded_tools,
        }
    }
}

impl<R: JsonRuntime> StepExecutor for CapabilityStepExecutor<'_, R> {
    fn execute_step(
        &mut self,
        step: &PlanStep,
        completed: &BTreeMap<String, StepOutcome>,
    ) -> OrchestratorResult<StepOutcome> {
        match step.kind {
            PlanStepKind::CapabilityCall => {
                // Resolve the tool the same tolerant way validate_plan does (caposaldo
                // #11). `tool` borrows loaded_tools (lifetime 'a), not self → no clash
                // with the mutable facade borrow below.
                let tool = tool_for_step(step, self.loaded_tools)?;
                // Model fills the arguments slot, constrained to the tool schema —
                // unless the caller already provided concrete ones.
                let arguments = fill_arguments(self.runtime, step, tool, completed, "")?;
                call_capability_tool(self.facade, self.context, tool, arguments)
            }
            // No tool to call: a no-op the driver treats as trivially done. The
            // gateway executor may override these (surface the direct answer, or
            // perform a real memory recall); here they simply do not block.
            PlanStepKind::MemoryLookup | PlanStepKind::DirectAnswer => {
                Ok(StepOutcome::succeeded(serde_json::Value::Null))
            }
            // Agentic step: run the bounded inner loop (read/gather scope) where
            // the model steers and the harness owns the envelope (ADR 0016
            // Pilastro 2 agent mode). The capability path offers Read/Draft tools
            // and executes through the facade; the loop itself is shared with the
            // gateway's browser path (caposaldo #5).
            PlanStepKind::SubagentTask => {
                let gather: Vec<CapabilityTool> = self
                    .loaded_tools
                    .iter()
                    .filter(|tool| matches!(tool.action, ActionClass::Read | ActionClass::Draft))
                    .cloned()
                    .collect();
                let facade = &mut *self.facade;
                let context = self.context;
                crate::agentic::run_agentic_step(
                    self.runtime,
                    &gather,
                    step,
                    completed,
                    |tool, arguments| {
                        let result = facade.call_tool(
                            context,
                            CapabilityCall {
                                provider_id: tool.provider_id.clone(),
                                tool_name: tool.name.clone(),
                                arguments,
                            },
                        )?;
                        Ok(result.output)
                    },
                )
            }
        }
    }
}

/// Executes one capability call through the facade and wraps the result. Shared by
/// the executor so the canonical "call_tool → StepOutcome" mapping lives once.
fn call_capability_tool(
    facade: &mut CapabilityFacade,
    context: &PolicyContext,
    tool: &CapabilityTool,
    arguments: serde_json::Value,
) -> OrchestratorResult<StepOutcome> {
    let evidence = format!("capability:{}", tool.name);
    // The facade is the single canonical execution path: it re-checks policy
    // (fail-closed — a write needing confirmation the context did not grant is
    // denied here, NOT silently performed), validates arguments against the tool
    // schema, dispatches to the provider, and audits. A denial / tool error
    // becomes Err → the driver marks the step Failed with the message.
    let result = facade.call_tool(
        context,
        CapabilityCall {
            provider_id: tool.provider_id.clone(),
            tool_name: tool.name.clone(),
            arguments,
        },
    )?;
    Ok(StepOutcome {
        succeeded: true,
        output: result.output,
        evidence: vec![evidence],
    })
}

/// Resolves the arguments for a capability call. Concrete non-empty object
/// arguments (static plans / pre-filled turns) are used as-is; otherwise the model
/// fills them constrained to the tool's input schema (ADR 0016 Pilastro 3). Shared
/// with the agentic loop (`agentic.rs`) so tool-choice and arg-fill use the SAME
/// schema-constrained mechanism (caposaldo #5) — there the model picks the tool
/// from an enum, then this fills its args. Public so a host (the desktop gateway's
/// drive executor, F3.3) that executes tools through its own surface (e.g. the
/// browser sidecar) can reuse the exact same schema-constrained arg-fill.
pub fn fill_arguments<R: JsonRuntime>(
    runtime: &R,
    step: &PlanStep,
    tool: &CapabilityTool,
    completed: &BTreeMap<String, StepOutcome>,
    extra_context: &str,
) -> OrchestratorResult<serde_json::Value> {
    if let Some(object) = step.arguments.as_object() {
        if !object.is_empty() {
            return Ok(step.arguments.clone());
        }
    }

    // `extra_context` carries live state the schema alone can't: e.g. the agentic
    // browse loop passes the latest page snapshot, so filling a `browser_act`
    // call can pick the right element "ref" (which only exists in that snapshot).
    let context_block = if extra_context.trim().is_empty() {
        String::new()
    } else {
        format!("Current context (use it to choose values like element refs):\n{extra_context}\n")
    };
    let prompt = format!(
        "Fill the arguments for a single tool call.\n\
         Tool: {name}\n\
         Tool description: {description}\n\
         Step goal: {goal}\n\
         {upstream}{context_block}\
         Return ONLY a JSON object of arguments valid for the tool's input schema. \
         Use values that achieve the step goal; do not invent unrelated fields.",
        name = tool.name,
        description = tool.description,
        goal = step
            .goal
            .as_deref()
            .unwrap_or("(use the tool to advance the task)"),
        upstream = upstream_digest(step, completed),
    );
    let request = GenerateJsonRequest {
        usage: {
            let mut usage = local_first_inference_usage::UsageContext::new(
                uuid::Uuid::new_v4().to_string(),
                local_first_inference_usage::InferencePurpose::Planning,
                "local",
            );
            usage.purpose_detail = Some("argument_fill".to_string());
            usage.task_id = Some(step.step_id.clone());
            usage
        },
        prompt,
        max_tokens: step.max_tokens.unwrap_or(ARG_FILL_MAX_TOKENS),
        temperature: 0.0,
        wait_if_busy: true,
        request_timeout_seconds: Some(step.timeout_seconds.unwrap_or(ARG_FILL_TIMEOUT_SECONDS) as f64),
        // Constrained decoding to the tool's own input schema — the lever that
        // makes even a weak model emit valid arguments.
        json_schema: Some(tool.input_schema.clone()),
        required_keys: Vec::new(),
        repair: true,
    };
    let response = runtime
        .generate_json(&request)
        .map_err(|error| OrchestratorError::Capability(format!("arg_fill_failed:{error:?}")))?;
    Ok(response.json)
}

/// Compact digest of the outputs of this step's (verified) dependencies, so the
/// arg-fill model can thread data along DAG edges (e.g. a snapshot ref from a
/// prior step). Bounded per dependency to keep the prompt small.
fn upstream_digest(step: &PlanStep, completed: &BTreeMap<String, StepOutcome>) -> String {
    let mut digest = String::new();
    for dependency in &step.depends_on {
        if let Some(outcome) = completed.get(dependency) {
            let compact: String = outcome
                .output
                .to_string()
                .chars()
                .take(UPSTREAM_DIGEST_CHARS)
                .collect();
            digest.push_str(&format!("Upstream {dependency} output: {compact}\n"));
        }
    }
    digest
}

/// Deterministic verify gate for capability steps: a step is "verified" exactly
/// when the facade returned success — policy, argument validation and the
/// provider all passed. For capability tools that IS the real gate; there is no
/// separate judgment to make, so introducing an LLM here would only add nondeterminism.
///
/// Agentic (`SubagentTask`) steps need a real judgment over their evidence — that
/// is the gateway's LLM `verify_step_complete` (F3.2b agentic path), not this verifier.
pub struct PassThroughVerifier;

impl StepVerifier for PassThroughVerifier {
    fn verify(&mut self, _step: &PlanStep, outcome: &StepOutcome) -> bool {
        outcome.succeeded
    }
}
