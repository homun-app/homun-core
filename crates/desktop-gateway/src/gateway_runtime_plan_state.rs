//! Runtime-plan state ownership for gateway turns.
//!
//! Tool schemas live in `gateway_plan_tools`; cross-turn stall bookkeeping lives
//! in `gateway_plan_stall`. This owner keeps canonical runtime-plan shape,
//! persistence, memory/graph projection, step outcome recording, and the engine
//! `PlanProgress` port out of the gateway composition root.

use crate::gateway_identity::{
    gateway_memory_user_id, gateway_memory_workspace_id, gateway_user_id, gateway_workspace_id,
};
use crate::gateway_memory_graph::{provenance_key_fragment, upsert_memory_relation};
use crate::gateway_memory_wiki::rebuild_status_wiki;
use crate::gateway_model_routing::verify_step_complete;
use crate::gateway_task_executor::TaskExecutionPresentation;
use crate::{AppState, lock_store, memory_facade};
#[cfg(test)]
use local_first_engine::plan::replace_latest_plan_marker;
use local_first_engine::plan::{
    MIN_DELIVERED_CHARS_TO_CONCLUDE, enforce_monotonic_plan_progress, plan_done_count,
    plan_is_complete, plan_is_settled, plan_next_open, plan_step_id, plan_step_status,
    plan_step_title, plan_value_steps,
};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryCreateRequest, MemoryEntity, MemoryFacade,
    MemoryLifecycleRequest, MemoryRecord, MemoryRef, MemoryRefKind, MemoryStatus,
    MemoryUpdatePatch, PrivacyDomain, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};
use local_first_orchestrator::{
    ExecutionPlan, OrchestratorRoute, PlanStep, PlanStepKind, StepExecutionPolicy,
};
use local_first_task_runtime::TaskRecord;
use serde_json::Value;

// `answer_body_is_empty` folded into `local_first_engine::markers::
// should_force_synthesis_for_empty_visible_answer` (5.D1c) — the empty-answer check now lives with the
// stripper it depends on, in the engine.

/// The plan steps reconciled for delivery: EVERY still-open step forced to `done`, `blocked`
/// preserved. Returns `Some` only when reconciliation is enabled, a substantial answer was
/// delivered, and something actually changed — otherwise `None` (nothing to reconcile).
///
/// This is the single source of truth shared by the displayed ‹‹PLAN›› marker AND the
/// persisted runtime plan, so the two can never diverge (a text-only reconcile would show
/// the user 7/7 while the durable plan stays at 3/7, leaving the NEXT turn to falsely resume
/// an already-delivered plan).
///
/// It runs ONLY on the delivery path (25127/25242) — after the round loop has already DECIDED
/// to stop (nudges spent, round budget hit, or the model concluded). At that instant nothing
/// is "in progress" anymore, so a substantial final answer means the plan's work is delivered.
/// Models routinely answer the whole request but stop calling `step_advance` for the tail
/// (deepseek delivered all 7 markets yet left the plan frozen at 3/7 with a phantom "active"
/// step — the "non so a che punto è arrivato" symptom). `blocked` stays blocked: it's an
/// explicit failure the model recorded, not something to launder into success. The char floor
/// guards the genuinely-truncated case (budget burned, empty/short answer). NOTE: deliberately
/// does NOT reuse `answer_concludes_plan` — that predicate must stay conservative for the
/// *nudge* decision (25001), where many open steps means "keep pushing", the opposite intent.
fn plan_steps_reconciled_on_delivery(
    plan: &ExecutionPlan,
    text: &str,
) -> Option<Vec<serde_json::Value>> {
    let delivered_chars = text.trim().chars().count();
    let mut steps = execution_plan_steps(plan);
    if steps.is_empty() || steps.iter().any(|step| plan_step_status(step) == "blocked") {
        return None;
    }
    let open_steps = steps
        .iter()
        .enumerate()
        .filter(|(_, step)| matches!(plan_step_status(step), "todo" | "doing"))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let [open_index] = open_steps.as_slice() else {
        return None;
    };
    if *open_index + 1 != steps.len() {
        return None;
    }
    if delivered_answer_reports_terminal_failure(text, delivered_chars) {
        steps[*open_index]["status"] = serde_json::json!("blocked");
        steps[*open_index]["detail"] = serde_json::json!("failed in final answer");
        return Some(steps);
    }
    if !plan_step_is_delivery_report(&steps[*open_index]) {
        return None;
    }
    if !delivered_answer_has_result_evidence(text)
        && !delivered_answer_has_verified_short_result(text, delivered_chars)
    {
        return None;
    }
    steps[*open_index]["status"] = serde_json::json!("done");
    steps[*open_index]["detail"] = serde_json::json!("delivered in final answer");
    Some(steps)
}

fn plan_step_is_delivery_report(step: &serde_json::Value) -> bool {
    let text = format!(
        "{} {}",
        plan_step_title(step),
        step.get("detail")
            .and_then(|value| value.as_str())
            .unwrap_or("")
    )
    .to_ascii_lowercase();
    [
        "deliver",
        "answer",
        "report",
        "result",
        "source",
        "extract",
        "riport",
        "rispond",
        "fonte",
        "fonti",
        "opzion",
        "estrar",
        "sintetizz",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn delivered_answer_has_result_evidence(text: &str) -> bool {
    let source_count = text.matches("http://").count() + text.matches("https://").count();
    text.trim().chars().count() >= MIN_DELIVERED_CHARS_TO_CONCLUDE
        && source_count > 0
        && (delivered_answer_has_markdown_table(text)
            || delivered_answer_has_numbered_result_list(text))
}

fn delivered_answer_has_verified_short_result(text: &str, delivered_chars: usize) -> bool {
    if delivered_chars < 240 {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    let has_source = lower.contains("http://") || lower.contains("https://");
    let claims_verified = [
        "completed and verified",
        "completato e verificato",
        "gia' stato completato e verificato",
        "già stato completato e verificato",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let denies_pending_plan = [
        "non ho passi",
        "nessun passo",
        "no pending",
        "nothing pending",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    has_source && claims_verified && denies_pending_plan
}

fn delivered_answer_reports_terminal_failure(text: &str, delivered_chars: usize) -> bool {
    if delivered_chars < 240 {
        return false;
    }
    let lower = text.to_ascii_lowercase();
    let has_terminal_error = [
        "err_name_not_resolved",
        "dns non",
        "dominio non",
        "browser non",
        "non e' raggiungibile",
        "non è raggiungibile",
        "non disponibile",
        "non posso completare",
        "non ho potuto completare",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    let denies_result = [
        "non posso",
        "non ho potuto",
        "nessun titolo",
        "titolo non disponibile",
        "nessun dato verificabile",
        "non c'e' alcun contenuto",
        "non c'è alcun contenuto",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    has_terminal_error && denies_result
}

fn delivered_answer_has_markdown_table(text: &str) -> bool {
    let mut previous_row = false;
    for line in text.lines() {
        let trimmed = line.trim();
        let is_row = trimmed.starts_with('|') && trimmed.matches('|').count() >= 2;
        if is_row && previous_row {
            return true;
        }
        previous_row = is_row;
    }
    false
}

fn delivered_answer_has_numbered_result_list(text: &str) -> bool {
    let mut found = std::collections::BTreeSet::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        for number in 1..=3 {
            if trimmed.starts_with(&format!("{number}. ")) {
                found.insert(number);
            }
        }
    }
    found.len() == 3
}

/// Thin text-only wrapper over `plan_steps_reconciled_on_delivery` — the delivery call sites
/// need the reconciled steps to ALSO persist the runtime plan, so they use the helper directly;
/// this convenience form (marker replacement only) is kept for the delivery-reconcile tests.
#[cfg(test)]
pub(crate) fn reconcile_final_plan_marker_on_delivery(plan: &ExecutionPlan, text: &str) -> String {
    match plan_steps_reconciled_on_delivery(plan, text) {
        Some(plan_steps) => replace_latest_plan_marker(text, None, &plan_steps),
        None => text.to_string(),
    }
}

fn plan_step_depends_on(step: &serde_json::Value) -> Vec<String> {
    step.get("depends_on")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

// `MIN_DELIVERED_CHARS_TO_CONCLUDE` + `answer_concludes_plan` moved to `engine::plan`
// (ADR 0024 inc 5e.3); imported below.

fn runtime_plan_thread_key(thread_id: Option<&str>) -> String {
    thread_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("__no_thread__")
        .to_string()
}

pub(crate) fn runtime_plan_control_scope(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<(String, String, String)> {
    let thread_id = runtime_plan_thread_key(thread_id);
    let workspace_id = if thread_id == "__no_thread__" {
        gateway_workspace_id().as_str().to_string()
    } else {
        state
            .chat_store
            .lock()
            .ok()?
            .workspace_for_thread(&thread_id)
            .ok()?
    };
    Some((
        gateway_user_id().as_str().to_string(),
        workspace_id,
        thread_id,
    ))
}

fn runtime_plan_memory_text(plan: &[serde_json::Value]) -> Option<String> {
    if plan.is_empty() {
        return None;
    }
    let done = plan_done_count(plan);
    let total = plan.len();
    let next = plan_next_open(plan);
    let mut parts = vec![format!("Runtime plan state: {done}/{total} steps done.")];
    if plan_is_complete(plan) {
        parts.push("Plan is complete.".to_string());
    } else {
        match next {
            Some(step) => parts.push(format!("Next step: {step}.")),
            None => {
                parts.push("Plan is blocked or unfinished with no runnable next step.".to_string())
            }
        }
    }
    Some(parts.join(" "))
}

fn runtime_plan_memory_metadata(
    thread_id: Option<&str>,
    plan: &[serde_json::Value],
) -> serde_json::Value {
    serde_json::json!({
        "source": "runtime_plan",
        "thread_id": runtime_plan_thread_key(thread_id),
        "status": if plan_is_complete(plan) { "complete" } else { "open" },
        "done_count": plan_done_count(plan),
        "total_count": plan.len(),
        "next_step": plan_next_open(plan),
        "steps": plan,
        "execution_plan": runtime_execution_plan(plan),
    })
}

/// THE shape of `LoopState.plan` — the plan the engine reads: canonical steps
/// (`{id,title,status,detail}`) under `steps`, the same language the merge, the F2 verifier, the
/// persistence (`upsert_runtime_plan_memory_from_state`) and the ‹‹PLAN›› marker already speak.
///
/// It must NEVER be the raw `serde_json::to_value(&ExecutionPlan)`: `PlanStep` keeps title/status
/// inside `arguments`, so the engine's readers (`plan_step_status`/`plan_step_title`, which default
/// to `"todo"`/`""` on a missing field) saw an untitled `todo` for EVERY step whatever its real
/// state. That silently disabled every plan-driven control in the loop — the evidence-driven
/// frontier advance and the "keep going, your next step is X" nudge, i.e. exactly the harness nets
/// that must fire when the model stops calling `step_advance` itself. With no step ever closing,
/// the per-step budgets never reset and elapsed time became the only limit the turn had left.
/// Carries the plan's optional `goal` (the user's objective in one sentence) alongside the
/// steps — the same shape persisted in `runtime_plans.plan_json` (`{"goal", "steps"}`).
pub(crate) fn canonical_plan_value(
    goal: Option<&str>,
    steps: &[serde_json::Value],
) -> serde_json::Value {
    serde_json::json!({ "goal": goal, "steps": steps })
}

/// The gateway's typed `ExecutionPlan` from `LoopState.plan` (ADR 0024 inc 5, P5). The loop carries
/// the plan in the canonical shape above; the ExecutionPlan-only helpers (`merge_execution_plan`,
/// `plan_steps_reconciled_on_delivery`) still want the typed form, so rebuild it from those steps.
/// Lossless for the chat plan: every step in `ls.plan` was produced by `runtime_execution_plan`, so
/// the orchestrator-only fields (`kind`, `provider_id`, `tool_name`) are already its defaults. An
/// empty plan is the safe fallback for `Null`/malformed, matching the old seed.
pub(crate) fn plan_value_from(plan: &serde_json::Value) -> ExecutionPlan {
    runtime_execution_plan(&plan_value_steps(plan))
}

pub(crate) fn runtime_execution_plan(plan: &[serde_json::Value]) -> ExecutionPlan {
    ExecutionPlan {
        route: OrchestratorRoute::MixedWorkflow,
        direct_answer: None,
        plan_propose: None,
        steps: plan
            .iter()
            .enumerate()
            .filter_map(|(index, step)| {
                let title = plan_step_title(step).trim();
                if title.is_empty() {
                    return None;
                }
                let step_id = plan_step_id(step)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("s{}", index + 1));
                Some(PlanStep {
                    step_id,
                    kind: PlanStepKind::DirectAnswer,
                    depends_on: plan_step_depends_on(step),
                    provider_id: None,
                    tool_name: None,
                    arguments: serde_json::json!({
                        "title": title,
                        "status": plan_step_status(step),
                        "detail": step.get("detail").cloned().unwrap_or(serde_json::Value::Null),
                        "done_criterion": step
                            .get("done_criterion")
                            .cloned()
                            .unwrap_or(serde_json::Value::Null),
                    }),
                    execution_policy: StepExecutionPolicy::Immediate,
                    risk_level: "low".to_string(),
                    expected_duration_seconds: 0,
                    agent_id: None,
                    goal: Some(title.to_string()),
                    contract: Some("runtime_plan_step".to_string()),
                    allowed_actions: vec![],
                    requires_user_approval: None,
                    timeout_seconds: None,
                    max_tokens: None,
                })
            })
            .collect(),
        needs_more_tools: None,
    }
}

pub(crate) fn execution_plan_steps(plan: &ExecutionPlan) -> Vec<serde_json::Value> {
    plan.steps
        .iter()
        .map(|step| {
            let title = step
                .arguments
                .get("title")
                .and_then(|value| value.as_str())
                .or(step.goal.as_deref())
                .unwrap_or("")
                .to_string();
            serde_json::json!({
                "id": step.step_id,
                "title": title,
                "status": step.arguments
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("todo"),
                "detail": step.arguments
                    .get("detail")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "done_criterion": step.arguments
                    .get("done_criterion")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
                "depends_on": step.depends_on,
            })
        })
        .collect()
}

pub(crate) fn merge_execution_plan(
    plan: &mut ExecutionPlan,
    sent: &[serde_json::Value],
) -> Vec<usize> {
    let mut steps = execution_plan_steps(plan);
    let claims = merge_plan(&mut steps, sent);
    // Derive completion of earlier steps from the current frontier (see helper) so the
    // persisted plan — and thus every surface that renders it — reflects real progress.
    enforce_monotonic_plan_progress(&mut steps);
    let mut previous_steps = std::mem::take(&mut plan.steps);
    plan.steps = steps
        .iter()
        .filter_map(|step_view| {
            let step_id = plan_step_id(step_view)?.to_string();
            if let Some(index) = previous_steps
                .iter()
                .position(|step| step.step_id == step_id)
            {
                let mut step = previous_steps.remove(index);
                apply_execution_plan_step_view(&mut step, step_view);
                Some(step)
            } else {
                runtime_execution_plan(std::slice::from_ref(step_view))
                    .steps
                    .into_iter()
                    .next()
            }
        })
        .collect();
    claims
}

fn apply_execution_plan_step_view(step: &mut PlanStep, step_view: &serde_json::Value) {
    if !plan_step_depends_on(step_view).is_empty() {
        step.depends_on = plan_step_depends_on(step_view);
    }
    if !step.arguments.is_object() {
        step.arguments = serde_json::json!({});
    }
    if let Some(arguments) = step.arguments.as_object_mut() {
        arguments.insert(
            "title".to_string(),
            serde_json::json!(plan_step_title(step_view)),
        );
        arguments.insert(
            "status".to_string(),
            serde_json::json!(plan_step_status(step_view)),
        );
        arguments.insert(
            "detail".to_string(),
            step_view
                .get("detail")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
        arguments.insert(
            "done_criterion".to_string(),
            step_view
                .get("done_criterion")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        );
    }
}

pub(crate) fn runtime_plan_memory_matches(memory: &MemoryRecord, thread_key: &str) -> bool {
    memory.memory_type == "open_loop"
        && !matches!(
            memory.status,
            MemoryStatus::Deleted | MemoryStatus::Rejected | MemoryStatus::Stale
        )
        && memory.metadata.get("source").and_then(|v| v.as_str()) == Some("runtime_plan")
        && memory.metadata.get("thread_id").and_then(|v| v.as_str()) == Some(thread_key)
}

/// Load the thread's CANONICAL plan steps from the durable runtime-plan store (the same
/// per-thread runtime-plan memory represents). This is the authoritative
/// cross-turn state: it's upserted on EVERY `update_plan`/`step_advance` (synchronously,
/// before a turn ends), so a CONTINUATION turn can inherit `{done,doing,…}` even before the
/// prior turn's ‹‹PLAN›› message has been persisted/streamed into the next turn's context.
/// Returns the steps (with verified statuses) or empty if the thread has no open plan.
#[cfg(test)]
pub(crate) fn load_runtime_plan_from_state(
    state: &AppState,
    thread_id: Option<&str>,
) -> Vec<serde_json::Value> {
    runtime_plan_record_from_state(state, thread_id)
        .map(|(_, steps)| steps)
        .unwrap_or_default()
}

/// Shared reader of the thread's open runtime plan: the steps + the optional goal. Tolerates BOTH
/// persistence shapes — the current `{"goal", "steps"}` object and the LEGACY bare step array —
/// so plans written before the goal upgrade keep loading unchanged.
pub(crate) fn runtime_plan_record_from_state(
    state: &AppState,
    thread_id: Option<&str>,
) -> Option<(Option<String>, Vec<serde_json::Value>)> {
    let (user_id, workspace_id, thread_id) = runtime_plan_control_scope(state, thread_id)?;
    let plan = state
        .task_store
        .lock()
        .ok()
        .and_then(|store| {
            store
                .load_runtime_plan(&user_id, &workspace_id, &thread_id)
                .ok()
                .flatten()
        })
        .filter(|plan| plan.status == "open")?;
    let goal = local_first_engine::plan::plan_value_goal(&plan.plan_json);
    let steps = local_first_engine::plan::plan_value_steps(&plan.plan_json);
    Some((goal, steps))
}

fn runtime_plan_step_outcome_matches(
    memory: &MemoryRecord,
    thread_key: &str,
    step_id: &str,
) -> bool {
    memory.memory_type == "fact"
        && !matches!(
            memory.status,
            MemoryStatus::Deleted | MemoryStatus::Rejected | MemoryStatus::Stale
        )
        && memory.metadata.get("source").and_then(|v| v.as_str()) == Some("runtime_plan_step")
        && memory.metadata.get("thread_id").and_then(|v| v.as_str()) == Some(thread_key)
        && memory.metadata.get("step_id").and_then(|v| v.as_str()) == Some(step_id)
}

pub(crate) fn record_runtime_plan_step_outcome(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    lifecycle: &MemoryLifecycleRequest,
    thread_id: Option<&str>,
    step: &serde_json::Value,
    evidence: &[String],
) -> Result<MemoryRef, String> {
    let thread_key = runtime_plan_thread_key(thread_id);
    let title = plan_step_title(step).trim();
    if title.is_empty() {
        return Err("runtime plan step outcome requires a title".to_string());
    }
    let step_id = plan_step_id(step).unwrap_or(title);
    let done_criterion = step
        .get("done_criterion")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim();
    let text = if done_criterion.is_empty() {
        format!("Runtime plan step completed: {title}.")
    } else {
        format!("Runtime plan step completed: {title}. Done criterion: {done_criterion}.")
    };
    let metadata = serde_json::json!({
        "source": "runtime_plan_step",
        "thread_id": thread_key,
        "execution_plan_ref": format!("runtime_plan:{thread_key}"),
        "step_id": step_id,
        "title": title,
        "status": "done",
        "done_criterion": done_criterion,
        "detail": step.get("detail").cloned().unwrap_or(serde_json::Value::Null),
        "evidence": evidence,
    });

    let existing = facade
        .list_memories_for_ui(user, workspace)
        .unwrap_or_default()
        .into_iter()
        .find(|memory| runtime_plan_step_outcome_matches(memory, &thread_key, step_id));

    let record = if let Some(existing) = existing {
        facade
            .update_memory(
                lifecycle,
                &existing.reference,
                MemoryUpdatePatch {
                    text: Some(text),
                    aliases: None,
                    language_hints: None,
                    confidence: Some(1.0),
                    privacy_domain: Some(PrivacyDomain::new("work")),
                    sensitivity: Some(MemoryDataSensitivity::Internal),
                    metadata: Some(metadata),
                    last_seen_at: None,
                },
            )
            .map_err(|error| error.to_string())?
    } else {
        facade
            .create_memory_candidate(MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "fact".to_string(),
                text,
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: PrivacyDomain::new("work"),
                sensitivity: MemoryDataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata,
            })
            .map_err(|error| error.to_string())?
    };
    facade
        .confirm_memory(lifecycle, &record.reference, "runtime plan step verified")
        .map_err(|error| error.to_string())?;
    Ok(record.reference)
}

pub(crate) fn record_runtime_plan_step_outcome_from_state(
    state: &AppState,
    thread_id: Option<&str>,
    step: &serde_json::Value,
    evidence: &[String],
) {
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "runtime-plan".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "runtime_plan_step_verified".to_string(),
    };
    if record_runtime_plan_step_outcome(
        facade, &user, &workspace, &lifecycle, thread_id, step, evidence,
    )
    .is_ok()
    {
        rebuild_status_wiki(facade, &user, &workspace);
    }
}

pub(crate) fn record_subagent_task_step_outcome(
    state: &AppState,
    task: &TaskRecord,
    outcome: &TaskExecutionPresentation,
) {
    let thread_id = lock_store(state)
        .ok()
        .and_then(|store| {
            store
                .thread_by_task_id(task.task_id.as_str())
                .ok()
                .flatten()
        })
        .map(|thread| thread.thread_id);
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "runtime-plan".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "subagent_plan_step_verified".to_string(),
    };
    if record_subagent_task_step_outcome_memory(
        facade,
        &user,
        &workspace,
        &lifecycle,
        thread_id.as_deref(),
        task,
        outcome,
    )
    .is_ok()
    {
        rebuild_status_wiki(facade, &user, &workspace);
    }
}

pub(crate) fn record_subagent_task_step_outcome_memory(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    lifecycle: &MemoryLifecycleRequest,
    thread_id: Option<&str>,
    task: &TaskRecord,
    outcome: &TaskExecutionPresentation,
) -> Result<Option<MemoryRef>, String> {
    if !task.kind.starts_with("subagent.") {
        return Ok(None);
    }
    let title = task
        .input_json
        .get("goal")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(task.kind.as_str());
    let done_criterion = task
        .input_json
        .get("contract")
        .and_then(Value::as_str)
        .unwrap_or("sub-agent task completed");
    let step = serde_json::json!({
        "id": task.task_id.as_str(),
        "title": title,
        "status": "done",
        "detail": {
            "task_kind": task.kind.as_str(),
            "summary": outcome.summary,
        },
        "done_criterion": done_criterion,
    });
    let evidence = vec![
        serde_json::json!({
            "source": "subagent_task",
            "task_id": task.task_id.as_str(),
            "kind": task.kind.as_str(),
            "checkpoint": outcome.checkpoint_redacted,
        })
        .to_string(),
    ];
    record_runtime_plan_step_outcome(
        facade, user, workspace, lifecycle, thread_id, &step, &evidence,
    )
    .map(Some)
}

fn upsert_runtime_plan_graph(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    privacy_domain: &str,
    memory_ref: &MemoryRef,
    thread_key: &str,
    plan: &[serde_json::Value],
) -> Result<(), String> {
    let plan_key = format!("runtime_plan:{thread_key}");
    let plan_ref = MemoryRef::new(
        MemoryRefKind::Entity,
        user.clone(),
        workspace.clone(),
        plan_key.clone(),
    );
    facade
        .upsert_entity(&MemoryEntity {
            reference: plan_ref.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            entity_type: "document".to_string(),
            name: format!("Runtime plan {thread_key}"),
            canonical_key: plan_key,
            aliases: vec![thread_key.to_string()],
            privacy_domain: PrivacyDomain::new(privacy_domain),
            sensitivity: MemoryDataSensitivity::Internal,
            metadata: serde_json::json!({
                "source": "runtime_plan",
                "kind": "runtime_plan",
                "thread_id": thread_key,
                "status": if plan_is_complete(plan) { "complete" } else { "open" },
                "done_count": plan_done_count(plan),
                "total_count": plan.len(),
                "next_step": plan_next_open(plan),
                "execution_plan": runtime_execution_plan(plan),
            }),
        })
        .map_err(|error| error.to_string())?;
    upsert_memory_relation(
        facade,
        user,
        workspace,
        privacy_domain,
        format!(
            "runtime_plan_described_by:{}",
            provenance_key_fragment(thread_key)
        ),
        memory_ref.clone(),
        "describes",
        plan_ref.clone(),
        vec![memory_ref.clone()],
        serde_json::json!({
            "source": "runtime_plan",
            "thread_id": thread_key,
        }),
    )?;

    let step_refs: std::collections::HashMap<String, MemoryRef> = plan
        .iter()
        .filter_map(|step| {
            let id = plan_step_id(step)?;
            Some((
                id.to_string(),
                MemoryRef::new(
                    MemoryRefKind::Entity,
                    user.clone(),
                    workspace.clone(),
                    format!("runtime_plan:{thread_key}:step:{id}"),
                ),
            ))
        })
        .collect();

    for (index, step) in plan.iter().enumerate() {
        let Some(step_id) = plan_step_id(step) else {
            continue;
        };
        let step_ref = step_refs
            .get(step_id)
            .cloned()
            .expect("step ref built from same step id");
        let title = plan_step_title(step);
        facade
            .upsert_entity(&MemoryEntity {
                reference: step_ref.clone(),
                user_id: user.clone(),
                workspace_id: workspace.clone(),
                entity_type: "asset".to_string(),
                name: if title.is_empty() {
                    step_id.to_string()
                } else {
                    title.to_string()
                },
                canonical_key: format!("runtime_plan:{thread_key}:step:{step_id}"),
                aliases: vec![step_id.to_string()],
                privacy_domain: PrivacyDomain::new(privacy_domain),
                sensitivity: MemoryDataSensitivity::Internal,
                metadata: serde_json::json!({
                    "source": "runtime_plan",
                    "kind": "runtime_plan_step",
                    "thread_id": thread_key,
                    "step_id": step_id,
                    "index": index,
                    "title": title,
                    "status": plan_step_status(step),
                    "detail": step.get("detail").cloned().unwrap_or(serde_json::Value::Null),
                    "done_criterion": step.get("done_criterion").cloned().unwrap_or(serde_json::Value::Null),
                }),
            })
            .map_err(|error| error.to_string())?;
        upsert_memory_relation(
            facade,
            user,
            workspace,
            privacy_domain,
            format!(
                "runtime_plan_step:{}:{}",
                provenance_key_fragment(thread_key),
                provenance_key_fragment(step_id)
            ),
            plan_ref.clone(),
            "relates_to",
            step_ref.clone(),
            vec![memory_ref.clone()],
            serde_json::json!({
                "source": "runtime_plan",
                "kind": "has_step",
                "thread_id": thread_key,
                "step_id": step_id,
                "index": index,
            }),
        )?;

        let dependencies = plan_step_depends_on(step);
        for dependency_id in dependencies {
            let Some(dependency_ref) = step_refs.get(&dependency_id) else {
                continue;
            };
            upsert_memory_relation(
                facade,
                user,
                workspace,
                privacy_domain,
                format!(
                    "runtime_plan_step_depends:{}:{}:{}",
                    provenance_key_fragment(thread_key),
                    provenance_key_fragment(step_id),
                    provenance_key_fragment(&dependency_id)
                ),
                step_ref.clone(),
                "depends_on",
                dependency_ref.clone(),
                vec![memory_ref.clone()],
                serde_json::json!({
                    "source": "runtime_plan",
                    "thread_id": thread_key,
                    "step_id": step_id,
                    "depends_on": dependency_id,
                }),
            )?;
        }
    }
    Ok(())
}

pub(crate) fn upsert_runtime_plan_memory(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    lifecycle: &MemoryLifecycleRequest,
    thread_id: Option<&str>,
    plan: &[serde_json::Value],
) -> Result<Option<MemoryRef>, String> {
    let Some(text) = runtime_plan_memory_text(plan) else {
        return Ok(None);
    };
    let thread_key = runtime_plan_thread_key(thread_id);
    // Terminate (stop auto-resuming) when the plan is SETTLED — every step done OR blocked —
    // not only when fully complete. A blocked step is terminal: keeping such a plan "active"
    // is exactly the F4 infinite-resume loop. settled == complete when no step is blocked, so
    // this is behaviour-preserving for ordinary plans.
    let settled = plan_is_settled(plan);
    let mut metadata = runtime_plan_memory_metadata(thread_id, plan);
    let existing = facade
        .list_memories_for_ui(user, workspace)
        .unwrap_or_default()
        .into_iter()
        .find(|memory| runtime_plan_memory_matches(memory, &thread_key));

    match existing {
        Some(existing) => {
            // Carry the F4 cross-turn stall bookkeeping forward: it lives on the plan memory
            // but `runtime_plan_memory_metadata` rebuilds metadata from the steps alone, so a
            // mid-turn upsert would otherwise wipe the counter the turn-start guard wrote.
            if let Some(obj) = metadata.as_object_mut() {
                for key in ["stall_turns", "last_resume_done"] {
                    if let Some(value) = existing.metadata.get(key) {
                        obj.insert(key.to_string(), value.clone());
                    }
                }
            }
            let record = facade
                .update_memory(
                    lifecycle,
                    &existing.reference,
                    MemoryUpdatePatch {
                        text: Some(text),
                        aliases: None,
                        language_hints: None,
                        confidence: Some(1.0),
                        privacy_domain: Some(PrivacyDomain::new("work")),
                        sensitivity: Some(MemoryDataSensitivity::Internal),
                        metadata: Some(metadata),
                        last_seen_at: None,
                    },
                )
                .map_err(|error| error.to_string())?;
            if settled {
                facade
                    .mark_memory_stale(lifecycle, &record.reference, "runtime plan settled")
                    .map_err(|error| error.to_string())?;
            } else {
                facade
                    .confirm_memory(lifecycle, &record.reference, "runtime plan updated")
                    .map_err(|error| error.to_string())?;
            }
            upsert_runtime_plan_graph(
                facade,
                user,
                workspace,
                "work",
                &record.reference,
                &thread_key,
                plan,
            )?;
            Ok(Some(record.reference))
        }
        None if settled => Ok(None),
        None => {
            let record = facade
                .create_memory_candidate(MemoryCreateRequest {
                    request: lifecycle.clone(),
                    memory_type: "open_loop".to_string(),
                    text,
                    aliases: Vec::new(),
                    language_hints: Vec::new(),
                    confidence: 1.0,
                    privacy_domain: PrivacyDomain::new("work"),
                    sensitivity: MemoryDataSensitivity::Internal,
                    evidence_refs: Vec::new(),
                    metadata,
                })
                .map_err(|error| error.to_string())?;
            facade
                .confirm_memory(lifecycle, &record.reference, "runtime plan opened")
                .map_err(|error| error.to_string())?;
            upsert_runtime_plan_graph(
                facade,
                user,
                workspace,
                "work",
                &record.reference,
                &thread_key,
                plan,
            )?;
            Ok(Some(record.reference))
        }
    }
}

pub(crate) fn upsert_runtime_plan_memory_from_state(
    state: &AppState,
    thread_id: Option<&str>,
    goal: Option<&str>,
    plan: &[serde_json::Value],
) {
    let Some((user_id, workspace_id, thread_key)) = runtime_plan_control_scope(state, thread_id)
    else {
        eprintln!("runtime plan skipped: thread scope could not be resolved");
        return;
    };
    let status = if plan_is_settled(plan) {
        "settled"
    } else {
        "open"
    };
    // Canonical persistence shape: `{"goal": <string|null>, "steps": [...]}` (readers tolerate the
    // legacy bare-array form).
    let plan_json = serde_json::json!({ "goal": goal, "steps": plan });
    let canonical_write_ok = state
        .task_store
        .lock()
        .ok()
        .and_then(|store| {
            let objective_revision = store
                .load_objective_contract(&user_id, &workspace_id, &thread_key)
                .ok()
                .flatten()
                .map(|objective| objective.revision)
                .unwrap_or(0);
            store
                .upsert_runtime_plan(
                    &user_id,
                    &workspace_id,
                    &thread_key,
                    objective_revision,
                    &plan_json,
                    status,
                )
                .ok()
        })
        .is_some();
    if !canonical_write_ok {
        eprintln!("runtime plan canonical write failed for thread {thread_key}");
        return;
    }

    // Semantic memory remains a best-effort projection for recall and graph navigation.
    // It is no longer consulted for control flow, resumption or stall bookkeeping.
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "runtime-plan".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "sync_runtime_plan".to_string(),
    };
    if upsert_runtime_plan_memory(facade, &user, &workspace, &lifecycle, thread_id, plan).is_ok() {
        rebuild_status_wiki(facade, &user, &workspace);
    }
}

/// Merge the model's sent steps into the CANONICAL plan (never replace). Match an
/// existing step by title (case-insensitive): a canonical `done` is STICKY — re-sending
/// it as todo/doing can't reopen it (this is what stops the regenerate loop); a NEW
/// `done` claim is held as `doing` and its index returned (pending F2 verification); a
/// new title is appended with a stable id. Returns the canonical indices newly claimed.
pub(crate) fn merge_plan(
    plan: &mut Vec<serde_json::Value>,
    sent: &[serde_json::Value],
) -> Vec<usize> {
    let tkey = |t: &str| t.trim().to_lowercase();
    let mut claims: Vec<usize> = Vec::new();
    for s in sent {
        let title = s.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
        // Identity: prefer the stable `id` the model echoes (shown as (`id`) in the
        // ‹‹PLAN›› marker); fall back to title. Id-first stops ballooning from
        // paraphrased titles, AND lets `step_advance` update a step by id ALONE (no
        // title) — the model reports progress without re-sending the whole plan. (WS1-F2.)
        let sent_id = s
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|x| !x.is_empty());
        if title.is_empty() && sent_id.is_none() {
            continue;
        }
        let new_status = s.get("status").and_then(|v| v.as_str()).unwrap_or("todo");
        let detail = s.get("detail").and_then(|v| v.as_str()).unwrap_or("");
        let pos = sent_id
            .and_then(|id| {
                plan.iter()
                    .position(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
            })
            .or_else(|| {
                if title.is_empty() {
                    None
                } else {
                    plan.iter()
                        .position(|p| tkey(plan_step_title(p)) == tkey(title))
                }
            });
        match pos {
            Some(i) => {
                let current_status = plan_step_status(&plan[i]);
                let harness_blocked = plan[i]
                    .get("detail")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .is_some_and(|detail| detail.starts_with("paused by the harness:"));
                if current_status == "done" {
                    // Sticky: a `done` step never re-opens, which stops regenerate loops.
                } else if current_status == "blocked" {
                    if new_status == "done" && !harness_blocked {
                        plan[i]["status"] = serde_json::json!("doing");
                        claims.push(i);
                    }
                } else if new_status == "done" {
                    plan[i]["status"] = serde_json::json!("doing");
                    claims.push(i);
                } else {
                    plan[i]["status"] = serde_json::json!(new_status);
                }
                if !detail.is_empty() {
                    plan[i]["detail"] = serde_json::json!(detail);
                }
                let depends_on = plan_step_depends_on(s);
                if !depends_on.is_empty() {
                    plan[i]["depends_on"] = serde_json::json!(depends_on);
                }
            }
            None => {
                if title.is_empty() {
                    // id-only update (step_advance) for a step that doesn't exist →
                    // ignore; we never create a titleless step.
                    continue;
                }
                let id = format!("s{}", plan.len() + 1);
                let status = if new_status == "done" {
                    "doing"
                } else {
                    new_status
                };
                plan.push(serde_json::json!({
                    "id": id, "title": title, "status": status, "detail": detail,
                    "done_criterion": s.get("done_criterion").and_then(|v| v.as_str()).unwrap_or(""),
                    "depends_on": plan_step_depends_on(s),
                }));
                if new_status == "done" {
                    claims.push(plan.len() - 1);
                }
            }
        }
    }
    claims
}

pub(crate) fn plan_tool_sent(
    name: &str,
    args_raw: &str,
) -> Result<(Option<String>, Vec<serde_json::Value>), String> {
    let args: serde_json::Value = serde_json::from_str(args_raw)
        .map_err(|_| format!("{name} requires valid JSON arguments"))?;
    if name == "step_advance" {
        let id = ["id", "step_id", "step"]
            .into_iter()
            .find_map(|key| args.get(key).and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "Invalid step_advance: provide the stable step `id` from the current Plan card. The plan was not changed."
                    .to_string()
            })?;
        let status = match args
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("doing")
        {
            "complete" | "completed" => "done",
            "in_progress" | "in-progress" => "doing",
            "pending" => "todo",
            status => status,
        };
        return Ok((
            None,
            vec![serde_json::json!({
                "id": id,
                "status": status,
                "detail": args.get("detail").and_then(serde_json::Value::as_str).unwrap_or(""),
            })],
        ));
    }
    // The optional top-level `goal` (the user's objective in one sentence, set when the plan is
    // created). null/empty/whitespace → None → the canonical plan KEEPS its stored goal.
    let goal = args
        .get("goal")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|goal| {
            let normalized = goal.to_ascii_lowercase();
            !goal.is_empty() && !matches!(normalized.as_str(), "null" | "none" | "n/a")
        })
        .map(str::to_string);
    Ok((
        goal,
        args.get("steps")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
    ))
}

// `extract_source_urls`, `is_low_value_source_url`, `fonti_section` moved to `engine::text`
// (ADR 0024 inc 5e.3, pure loop-delivery helpers); imported below.

/// The engine's runtime-plan progress port (ADR 0024 inc 5c): when the loop moves into the engine it
/// persists/records/verifies plan progress through this seam instead of reaching into `AppState`. Owns
/// a cheap `AppState` clone (all-`Arc` fields) because `persist_plan`/`record_step_outcome` move it into
/// `spawn_blocking` (the memory facade is sync). Delegates verbatim to the three existing helpers, so
/// behavior is unchanged — the loop still calls them directly until inc 5e adopts this adapter.
// Constructed live in run_agent_rounds (5.D1c.4): the loop routes the delivery reconcile through this
// adapter; 5.D1c.5 adds the plan persist + step verification paths.
pub(crate) struct GatewayPlanProgress {
    state: AppState,
}

pub(crate) fn gateway_plan_progress(state: AppState) -> GatewayPlanProgress {
    GatewayPlanProgress { state }
}

impl local_first_engine::PlanProgress for GatewayPlanProgress {
    async fn persist_plan(
        &self,
        thread: Option<&str>,
        goal: Option<&str>,
        steps: &[serde_json::Value],
    ) {
        let st = self.state.clone();
        let thread = thread.map(str::to_string);
        let goal = goal.map(str::to_string);
        let steps = steps.to_vec();
        let _ = tokio::task::spawn_blocking(move || {
            upsert_runtime_plan_memory_from_state(&st, thread.as_deref(), goal.as_deref(), &steps);
        })
        .await;
    }

    async fn record_step_outcome(
        &self,
        thread: Option<&str>,
        step: &serde_json::Value,
        evidence: &[String],
    ) {
        let st = self.state.clone();
        let thread = thread.map(str::to_string);
        let step = step.clone();
        let evidence = evidence.to_vec();
        let _ = tokio::task::spawn_blocking(move || {
            record_runtime_plan_step_outcome_from_state(&st, thread.as_deref(), &step, &evidence);
        })
        .await;
    }

    async fn verify_step_complete(
        &self,
        title: &str,
        criterion: &str,
        evidence: &str,
    ) -> (bool, String) {
        verify_step_complete(&self.state.http, title, criterion, evidence).await
    }

    fn reconcile_on_delivery(
        &self,
        plan: &serde_json::Value,
        delivered: &str,
    ) -> Option<Vec<serde_json::Value>> {
        // The Value↔ExecutionPlan bridge (5.D1c.4): convert the engine's opaque plan `Value` to the
        // typed `ExecutionPlan` and run the delivery reconcile. Pure — no `self.state` needed.
        plan_steps_reconciled_on_delivery(&plan_value_from(plan), delivered)
    }

    fn plan_value_from_steps(
        &self,
        goal: Option<&str>,
        steps: &[serde_json::Value],
    ) -> serde_json::Value {
        // The other half of the bridge (5.D1c.5): a fresh step list as the canonical plan Value —
        // the shape the loop reads back. Pure — no `self.state` needed.
        canonical_plan_value(goal, steps)
    }
}
