use super::*;

/// Typed TurnOutcome projection: this is the gateway's source of truth for opening
/// Free HITL waits. Marker/event-part persistence remains only as stream compatibility.
pub(crate) fn persist_hitl_wait_from_outcome(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    outcome: &local_first_engine::TurnOutcome,
) -> Result<(), String> {
    let Some(envelope) = outcome.awaiting_user.as_ref() else {
        return Ok(());
    };
    if !envelope.is_free() {
        return Ok(());
    }
    let wait_kind = match envelope.kind {
        local_first_engine::hitl::HitlKind::Choice
        | local_first_engine::hitl::HitlKind::Clarify
        | local_first_engine::hitl::HitlKind::PlanPropose => envelope.wait_kind_key(),
        local_first_engine::hitl::HitlKind::Confirm
        | local_first_engine::hitl::HitlKind::Vault
        | local_first_engine::hitl::HitlKind::Payment => return Ok(()),
    };
    let store = lock_store(state).map_err(|error| error.message)?;
    persist_hitl_wait_payload(
        &store,
        state,
        thread_id,
        message_id,
        wait_kind,
        envelope.payload.clone(),
    )
}

pub(crate) fn persist_hitl_wait_payload(
    store: &chat_store::ChatStore,
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    wait_kind: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let browser_live = state
        .browser_thread_sessions
        .lock()
        .map_err(|error| format!("browser session store unavailable: {error}"))?
        .get(thread_id)
        .is_some_and(|session| thread_browser_session_is_live(session.last_used));
    // `store` is already held by both callers. Resolve the workspace through that
    // guard and read task state directly; calling `runtime_plan_control_scope` here
    // would try to acquire the same chat-store mutex again and self-deadlock.
    let workspace_id = store
        .workspace_for_thread(thread_id)
        .map_err(|error| format!("HITL workspace lookup failed: {error}"))?;
    let task_store = state
        .task_store
        .lock()
        .map_err(|error| format!("task store unavailable while persisting HITL wait: {error}"))?;
    let user_id = gateway_user_id();
    let contract = task_store
        .load_objective_contract(user_id.as_str(), &workspace_id, thread_id)
        .map_err(|error| format!("HITL objective lookup failed: {error}"))?
        .as_ref()
        .map(hitl_resume::ResumeContractSnapshot::from_objective);
    let plan = task_store
        .load_runtime_plan(user_id.as_str(), &workspace_id, thread_id)
        .map_err(|error| format!("HITL runtime plan lookup failed: {error}"))?
        .filter(|plan| plan.status == "open")
        // Tolerates both persistence shapes: `{"goal", "steps"}` and the legacy bare step array.
        .map(|plan| local_first_engine::plan::plan_value_steps(&plan.plan_json))
        .unwrap_or_default();
    let remaining_plan = hitl_resume::bounded_remaining_plan(plan);
    let browser_checkpoint_generation = task_store
        .load_active_browser_checkpoint_for_thread(user_id.as_str(), &workspace_id, thread_id)
        .map_err(|error| format!("HITL browser checkpoint lookup failed: {error}"))?
        .map(|checkpoint| checkpoint.generation);
    drop(task_store);
    let open_work = hitl_resume::OpenWorkSnapshot {
        schema_version: hitl_resume::OPEN_WORK_SCHEMA_VERSION,
        browser_session_live: browser_live,
        browser_checkpoint_available: browser_checkpoint_generation.is_some(),
        browser_checkpoint_generation,
        last_url: None,
        capability_hint: (browser_live || browser_checkpoint_generation.is_some())
            .then(|| "browse".to_string()),
        contract,
        remaining_plan,
    };
    let wait_id = format!("hitl_{wait_kind}_{message_id}");
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("HITL payload serialization failed: {error}"))?;
    let open_work_json = serde_json::to_string(&open_work)
        .map_err(|error| format!("HITL open-work serialization failed: {error}"))?;
    store
        .set_open_hitl_wait(
            &wait_id,
            thread_id,
            message_id,
            wait_kind,
            &payload_json,
            &open_work_json,
        )
        .map_err(|error| format!("HITL wait persistence failed: {error}"))
}
