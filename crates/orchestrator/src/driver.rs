//! In-turn DAG driver: the harness-owned control flow for executing an
//! [`ExecutionPlan`] step by step.
//!
//! This is the convergence target of ADR 0020 (engine #2 — the `OrchestratorBrain`
//! — as the *real* driver of a chat turn, not a dormant task materializer) under
//! the cross-model invariants of ADR 0016. Today's [`OrchestratorBrain::execute_plan`]
//! *enqueues durable background tasks and returns*; it never drives a turn. The
//! driver here is the missing synchronous, in-turn executor.
//!
//! ## Why a standalone unit (not buried in the Brain)
//!
//! The driver owns ONLY control flow — step ordering, dependency gating, the
//! done-after-verify gate, and the three plan invariants. The actual work
//! (calling tools, running a bounded inner model loop) is the injected
//! [`StepExecutor`]'s job, and the done decision is the injected
//! [`StepVerifier`]'s. Keeping the driver free of the Brain's runtime / memory /
//! task-store dependencies makes the control flow exhaustively unit-testable with
//! fakes — no model, no SQLite, no live `~/.homun`. That is precisely what
//! caposaldo #2 demands: orchestration is a property of the *harness*, provable in
//! isolation and independent of the model.
//!
//! ## The three invariants, enforced by construction (ADR 0016 §invarianti)
//!
//! - **Monotonicity** — a step marked [`DriveStepStatus::Done`] is never revisited.
//!   The driver makes a single forward pass over a topologically-ordered plan
//!   (the order is guaranteed upstream by `OrchestratorBrain::validate_plan`, which
//!   rejects any plan whose dependency does not precede its dependent). A verified
//!   `done` therefore can never reopen.
//! - **Boundedness** — the driver NEVER appends steps. It returns exactly one
//!   [`DriveStepResult`] per input step; reporting progress cannot grow the plan.
//! - **Identity not inferred** — every status is keyed by `step_id`. Step titles /
//!   goals are never consulted to decide "which step this is". Two steps with
//!   identical prose but distinct ids are tracked independently.

use crate::{ExecutionPlan, OrchestratorResult, PlanStep};
use std::collections::BTreeMap;

/// What executing a single step produced. Opaque to the driver — it only flows
/// the output of *verified* (Done) steps to their dependents and surfaces the
/// evidence to the verifier; it never interprets the contents.
#[derive(Debug, Clone, PartialEq)]
pub struct StepOutcome {
    /// Whether the executor reached a terminal, successful state for the step's
    /// goal. `false` short-circuits to [`DriveStepStatus::Failed`] *before* the
    /// verifier runs (a self-reported failure is trusted; a self-reported success
    /// is not — that still goes through the verify gate).
    pub succeeded: bool,
    /// The step's product (tool output, gathered text, draft). Passed to
    /// dependents via the `completed` map so data flows along DAG edges.
    pub output: serde_json::Value,
    /// What the verify gate inspects to decide done-vs-not. The runtime decides on
    /// this evidence — never on the model's self-declared "done" (caposaldo #6).
    pub evidence: Vec<String>,
}

impl StepOutcome {
    /// A successful outcome carrying `output` and no evidence. Convenience for
    /// executors whose verifier does not need explicit evidence.
    pub fn succeeded(output: serde_json::Value) -> Self {
        Self {
            succeeded: true,
            output,
            evidence: Vec::new(),
        }
    }

    /// A failed outcome. The driver marks the step [`DriveStepStatus::Failed`]
    /// without consulting the verifier.
    pub fn failed() -> Self {
        Self {
            succeeded: false,
            output: serde_json::Value::Null,
            evidence: Vec::new(),
        }
    }
}

/// The slot-filler: does the actual work of one step. Implementations bridge to
/// real capability/tool dispatch (the chat loop's tool execution) or run a
/// bounded inner model loop. In tests, a fake. This is the seam F3.2 plugs the
/// real per-step tool execution into.
///
/// The `completed` map exposes the outcomes of already-verified upstream steps
/// (keyed by `step_id`) so a step can consume its dependencies' outputs. It
/// contains *only* Done steps — unverified or failed upstream data never flows.
pub trait StepExecutor {
    fn execute_step(
        &mut self,
        step: &PlanStep,
        completed: &BTreeMap<String, StepOutcome>,
    ) -> OrchestratorResult<StepOutcome>;
}

/// The code-owned done gate (ADR 0016 Pilastro 5 / F2 `verify_step_complete`).
/// A step becomes Done ONLY when this returns `true` — never on the model's
/// self-report. Implementations bridge to the LLM judge or apply a deterministic
/// check; in tests, a fake. Kept separate from the executor so the "who decides
/// done" responsibility cannot leak back into the model.
pub trait StepVerifier {
    fn verify(&mut self, step: &PlanStep, outcome: &StepOutcome) -> bool;
}

/// Runtime-owned status of a step during an in-turn drive. Typed (not the
/// stringly `"todo"/"doing"/"done"` of the canonical chat steps) because this is
/// the engine's own state, where caposaldo #6 wants the strongest typing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveStepStatus {
    /// Executed and verified. Terminal and monotonic: never revisited.
    Done,
    /// The executor errored or returned `succeeded == false`.
    Failed,
    /// Executed successfully but the verify gate rejected it — NOT done. Treated
    /// as unmet for the purpose of gating dependents.
    Unverified,
    /// Not run because a dependency did not reach Done (failed, unverified, or
    /// itself skipped). Keeps a broken branch from cascading bad data downstream.
    Skipped,
}

impl DriveStepStatus {
    /// Whether this status satisfies a dependent's prerequisite. Only a verified
    /// `Done` unblocks dependents — the conservative choice that stops unverified
    /// or failed work from flowing along the DAG.
    fn unblocks_dependents(self) -> bool {
        matches!(self, DriveStepStatus::Done)
    }
}

/// Per-step result of a drive, in plan order. Exactly one per input step.
#[derive(Debug, Clone)]
pub struct DriveStepResult {
    pub step_id: String,
    pub status: DriveStepStatus,
    /// The executor's outcome, when it ran. `None` for `Skipped` (never executed)
    /// and for `Failed` due to an executor error.
    pub outcome: Option<StepOutcome>,
    /// Human-readable note for a non-Done terminal status (executor error string,
    /// or why it was skipped). For diagnostics / progress streaming.
    pub error: Option<String>,
}

/// The result of driving a whole plan: one [`DriveStepResult`] per input step, in
/// plan order.
#[derive(Debug, Clone)]
pub struct DriveOutcome {
    pub results: Vec<DriveStepResult>,
}

impl DriveOutcome {
    /// Whether every step reached Done. The natural "plan tracks the work 1:1"
    /// success criterion of ADR 0020.
    pub fn all_done(&self) -> bool {
        self.results
            .iter()
            .all(|result| result.status == DriveStepStatus::Done)
    }

    /// The ids of steps that reached Done, in plan order.
    pub fn done_step_ids(&self) -> Vec<&str> {
        self.results
            .iter()
            .filter(|result| result.status == DriveStepStatus::Done)
            .map(|result| result.step_id.as_str())
            .collect()
    }
}

/// Drive an [`ExecutionPlan`] to completion in a single forward pass, the harness
/// owning every control-flow decision. See the module docs for the invariants.
///
/// Preconditions (guaranteed by `OrchestratorBrain::validate_plan` before a plan
/// reaches here): step ids are unique and every dependency precedes its dependent
/// (topological order). The driver does not re-validate; it relies on that gate so
/// that a plain forward iteration *is* a valid topological execution.
pub fn drive_plan<E: StepExecutor, V: StepVerifier>(
    plan: &ExecutionPlan,
    executor: &mut E,
    verifier: &mut V,
) -> DriveOutcome {
    // Runtime-owned state, keyed by step_id (never by title — caposaldo #6).
    let mut status: BTreeMap<String, DriveStepStatus> = BTreeMap::new();
    // Outputs of verified (Done) steps only, for dependents to consume.
    let mut completed: BTreeMap<String, StepOutcome> = BTreeMap::new();
    let mut results: Vec<DriveStepResult> = Vec::with_capacity(plan.steps.len());

    for step in &plan.steps {
        // Dependency gate. Topological order means every dependency already has a
        // final status here; a step runs only if ALL of them reached Done.
        let blocking = step
            .depends_on
            .iter()
            .find(|dep| !status.get(*dep).copied().is_some_and(DriveStepStatus::unblocks_dependents));
        if let Some(dep) = blocking {
            status.insert(step.step_id.clone(), DriveStepStatus::Skipped);
            results.push(DriveStepResult {
                step_id: step.step_id.clone(),
                status: DriveStepStatus::Skipped,
                outcome: None,
                error: Some(format!("dependency_not_satisfied:{dep}")),
            });
            continue;
        }

        let outcome = match executor.execute_step(step, &completed) {
            Ok(outcome) => outcome,
            Err(error) => {
                status.insert(step.step_id.clone(), DriveStepStatus::Failed);
                results.push(DriveStepResult {
                    step_id: step.step_id.clone(),
                    status: DriveStepStatus::Failed,
                    outcome: None,
                    error: Some(error.to_string()),
                });
                continue;
            }
        };

        let (new_status, error) = if !outcome.succeeded {
            (DriveStepStatus::Failed, Some("executor_reported_failure".to_string()))
        } else if verifier.verify(step, &outcome) {
            // The RUNTIME marks done — and only after the verify gate passes. This
            // is the line ADR 0016 draws: the model fills the slot, the harness
            // decides the step is complete.
            completed.insert(step.step_id.clone(), outcome.clone());
            (DriveStepStatus::Done, None)
        } else {
            (DriveStepStatus::Unverified, Some("verify_gate_rejected".to_string()))
        };

        status.insert(step.step_id.clone(), new_status);
        results.push(DriveStepResult {
            step_id: step.step_id.clone(),
            status: new_status,
            outcome: Some(outcome),
            error,
        });
    }

    DriveOutcome { results }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{OrchestratorError, OrchestratorRoute, PlanStepKind, StepExecutionPolicy};

    /// Builds a minimal capability-call step with the given id and dependencies.
    /// Goal defaults to the id; tests that probe identity-vs-title override it.
    fn step(id: &str, depends_on: &[&str]) -> PlanStep {
        PlanStep {
            step_id: id.to_string(),
            kind: PlanStepKind::CapabilityCall,
            depends_on: depends_on.iter().map(|d| d.to_string()).collect(),
            provider_id: Some("p".to_string()),
            tool_name: Some("t".to_string()),
            arguments: serde_json::Value::Null,
            execution_policy: StepExecutionPolicy::Immediate,
            risk_level: "low".to_string(),
            expected_duration_seconds: 1,
            agent_id: None,
            goal: Some(id.to_string()),
            contract: None,
            allowed_actions: Vec::new(),
            requires_user_approval: None,
            timeout_seconds: None,
            max_tokens: None,
        }
    }

    fn plan(steps: Vec<PlanStep>) -> ExecutionPlan {
        ExecutionPlan {
            route: OrchestratorRoute::CapabilityCall,
            direct_answer: None,
            plan_propose: None,
            steps,
            needs_more_tools: None,
        }
    }

    /// Executor that records how many times each step ran (to prove monotonicity:
    /// each step executes at most once) and lets a test fail specific steps.
    struct RecordingExecutor {
        runs: Vec<String>,
        fail: Vec<String>,
    }
    impl RecordingExecutor {
        fn new() -> Self {
            Self {
                runs: Vec::new(),
                fail: Vec::new(),
            }
        }
        fn failing(fail: &[&str]) -> Self {
            Self {
                runs: Vec::new(),
                fail: fail.iter().map(|s| s.to_string()).collect(),
            }
        }
    }
    impl StepExecutor for RecordingExecutor {
        fn execute_step(
            &mut self,
            step: &PlanStep,
            completed: &BTreeMap<String, StepOutcome>,
        ) -> OrchestratorResult<StepOutcome> {
            self.runs.push(step.step_id.clone());
            if self.fail.contains(&step.step_id) {
                return Ok(StepOutcome::failed());
            }
            // Echo back which upstream outputs were visible, so a test can assert
            // data flows along edges.
            let seen: Vec<&str> = completed.keys().map(|k| k.as_str()).collect();
            Ok(StepOutcome::succeeded(serde_json::json!({
                "id": step.step_id,
                "saw": seen,
            })))
        }
    }

    /// Verifier that passes everything, or rejects a chosen set of step ids.
    struct FakeVerifier {
        reject: Vec<String>,
    }
    impl FakeVerifier {
        fn pass_all() -> Self {
            Self { reject: Vec::new() }
        }
        fn rejecting(reject: &[&str]) -> Self {
            Self {
                reject: reject.iter().map(|s| s.to_string()).collect(),
            }
        }
    }
    impl StepVerifier for FakeVerifier {
        fn verify(&mut self, step: &PlanStep, _outcome: &StepOutcome) -> bool {
            !self.reject.contains(&step.step_id)
        }
    }

    fn status_of<'a>(outcome: &'a DriveOutcome, id: &str) -> DriveStepStatus {
        outcome
            .results
            .iter()
            .find(|r| r.step_id == id)
            .unwrap_or_else(|| panic!("no result for {id}"))
            .status
    }

    #[test]
    fn linear_plan_all_done_in_order_with_data_flow() {
        let mut exec = RecordingExecutor::new();
        let mut ver = FakeVerifier::pass_all();
        let p = plan(vec![step("s1", &[]), step("s2", &["s1"]), step("s3", &["s2"])]);

        let out = drive_plan(&p, &mut exec, &mut ver);

        assert!(out.all_done());
        assert_eq!(out.done_step_ids(), vec!["s1", "s2", "s3"]);
        // Order: executor saw steps in plan order.
        assert_eq!(exec.runs, vec!["s1", "s2", "s3"]);
        // Data flows along edges: s3 saw the verified outputs of s1 and s2.
        let s3 = out.results.iter().find(|r| r.step_id == "s3").unwrap();
        let saw = s3.outcome.as_ref().unwrap().output["saw"]
            .as_array()
            .unwrap();
        assert_eq!(saw.len(), 2);
    }

    #[test]
    fn verify_failure_blocks_dependents_but_not_siblings() {
        // s2 executes fine but the verify gate rejects it → Unverified.
        // s3 depends on s2 → Skipped. s4 is independent → still Done.
        let mut exec = RecordingExecutor::new();
        let mut ver = FakeVerifier::rejecting(&["s2"]);
        let p = plan(vec![
            step("s1", &[]),
            step("s2", &["s1"]),
            step("s3", &["s2"]),
            step("s4", &[]),
        ]);

        let out = drive_plan(&p, &mut exec, &mut ver);

        assert_eq!(status_of(&out, "s1"), DriveStepStatus::Done);
        assert_eq!(status_of(&out, "s2"), DriveStepStatus::Unverified);
        assert_eq!(status_of(&out, "s3"), DriveStepStatus::Skipped);
        assert_eq!(status_of(&out, "s4"), DriveStepStatus::Done);
        // s3 was never executed (its prerequisite was unmet).
        assert!(!exec.runs.contains(&"s3".to_string()));
    }

    #[test]
    fn executor_failure_is_isolated_to_the_failed_branch() {
        let mut exec = RecordingExecutor::failing(&["s1"]);
        let mut ver = FakeVerifier::pass_all();
        let p = plan(vec![
            step("s1", &[]),
            step("s2", &["s1"]),
            step("s3", &[]),
        ]);

        let out = drive_plan(&p, &mut exec, &mut ver);

        assert_eq!(status_of(&out, "s1"), DriveStepStatus::Failed);
        assert_eq!(status_of(&out, "s2"), DriveStepStatus::Skipped);
        assert_eq!(status_of(&out, "s3"), DriveStepStatus::Done);
    }

    #[test]
    fn each_step_runs_at_most_once_on_a_diamond_dag() {
        // Diamond: s1 → {s2, s3} → s4. Monotonicity: every step executes exactly
        // once; nothing reopens.
        let mut exec = RecordingExecutor::new();
        let mut ver = FakeVerifier::pass_all();
        let p = plan(vec![
            step("s1", &[]),
            step("s2", &["s1"]),
            step("s3", &["s1"]),
            step("s4", &["s2", "s3"]),
        ]);

        let out = drive_plan(&p, &mut exec, &mut ver);

        assert!(out.all_done());
        assert_eq!(exec.runs.len(), 4);
        for id in ["s1", "s2", "s3", "s4"] {
            assert_eq!(exec.runs.iter().filter(|r| *r == id).count(), 1);
        }
    }

    #[test]
    fn boundedness_one_result_per_step_never_grows() {
        let mut exec = RecordingExecutor::new();
        let mut ver = FakeVerifier::pass_all();
        let p = plan(vec![step("s1", &[]), step("s2", &["s1"])]);

        let out = drive_plan(&p, &mut exec, &mut ver);

        // The driver returns exactly one result per input step — reporting
        // progress can never inflate the plan.
        assert_eq!(out.results.len(), p.steps.len());
    }

    #[test]
    fn identity_keyed_by_step_id_not_by_title() {
        // Two steps share the SAME goal/title but have distinct ids. Rejecting
        // "a1" must not touch "a2" — proving the driver keys on step_id, never on
        // the prose (caposaldo #6: identity not inferred from text).
        let mut a1 = step("a1", &[]);
        let mut a2 = step("a2", &[]);
        a1.goal = Some("Gather the sources".to_string());
        a2.goal = Some("Gather the sources".to_string());
        let mut exec = RecordingExecutor::new();
        let mut ver = FakeVerifier::rejecting(&["a1"]);
        let p = plan(vec![a1, a2]);

        let out = drive_plan(&p, &mut exec, &mut ver);

        assert_eq!(status_of(&out, "a1"), DriveStepStatus::Unverified);
        assert_eq!(status_of(&out, "a2"), DriveStepStatus::Done);
    }

    #[test]
    fn executor_error_surfaces_as_failed_with_note() {
        struct ErrExec;
        impl StepExecutor for ErrExec {
            fn execute_step(
                &mut self,
                _step: &PlanStep,
                _completed: &BTreeMap<String, StepOutcome>,
            ) -> OrchestratorResult<StepOutcome> {
                Err(OrchestratorError::Capability("boom".to_string()))
            }
        }
        let mut ver = FakeVerifier::pass_all();
        let p = plan(vec![step("s1", &[])]);

        let out = drive_plan(&p, &mut ErrExec, &mut ver);

        let s1 = &out.results[0];
        assert_eq!(s1.status, DriveStepStatus::Failed);
        assert!(s1.error.as_ref().unwrap().contains("boom"));
        assert!(s1.outcome.is_none());
    }
}
