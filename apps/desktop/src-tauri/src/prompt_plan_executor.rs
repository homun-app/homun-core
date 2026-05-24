use crate::models::PromptPlanStepRunResult;
use local_first_local_computer_session::{
    ComputerEventCreate, LocalComputerSessionManager, SurfaceKind,
};
use local_first_task_runtime::{
    ResourceGovernor, ResourceLimits, TaskRecord, TaskScheduler, TaskStatus, TaskStore,
    UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use time::OffsetDateTime;

pub fn run_next_prompt_plan_step(
    store: &TaskStore,
    manager: &LocalComputerSessionManager,
    user_id: &str,
    workspace_id: &str,
    session_id: &str,
) -> Result<PromptPlanStepRunResult, String> {
    let user_id = TaskUserId::new(user_id);
    let workspace_id = TaskWorkspaceId::new(workspace_id);
    let scheduler = TaskScheduler::new();
    let resources = ResourceGovernor::new(ResourceLimits::conservative_defaults());
    let ready_tasks = scheduler
        .ready_tasks(
            store,
            &user_id,
            &workspace_id,
            OffsetDateTime::now_utc(),
            usize::MAX,
        )
        .map_err(to_string_error)?;
    let Some(task) = ready_tasks
        .into_iter()
        .find(|task| is_prompt_plan_task_for_session(task, session_id))
    else {
        return Ok(PromptPlanStepRunResult {
            status: "idle".to_string(),
            task_id: None,
            message: "Nessuno step prompt_plan pronto per questa chat.".to_string(),
        });
    };

    let task_id = task.task_id.as_str().to_string();
    let surface = prompt_plan_surface(&task);
    let surface_kind = surface_kind_for_prompt_plan(surface);
    let action_kind = prompt_plan_action_kind(&task);

    if resources
        .mark_waiting_if_unavailable(store, &task)
        .map_err(to_string_error)?
    {
        store
            .append_checkpoint(
                &task.task_id,
                &user_id,
                &workspace_id,
                serde_json::json!({
                    "prompt_plan_executor": {
                        "state": "waiting_resource",
                        "raw_payload_stored": false
                    }
                }),
                serde_json::json!({
                    "prompt_plan_executor": {
                        "state": "waiting_resource",
                        "surface": surface,
                        "action_kind": action_kind,
                        "payload_redacted": true
                    }
                }),
            )
            .map_err(to_string_error)?;
        append_prompt_plan_computer_event(
            manager,
            session_id,
            surface_kind,
            "prompt_plan_step_waiting_resource",
            "waiting",
            &task.goal,
            "In attesa di risorse locali disponibili",
            false,
        )?;
        return Ok(PromptPlanStepRunResult {
            status: "waiting_resource".to_string(),
            task_id: Some(task_id),
            message: "Step pronto ma risorsa locale non disponibile.".to_string(),
        });
    }

    store
        .update_task_status(
            &task.task_id,
            &user_id,
            &workspace_id,
            TaskStatus::Running,
            None,
        )
        .map_err(to_string_error)?;
    resources
        .reserve(store, &task, "desktop-prompt-plan-executor")
        .map_err(to_string_error)?;
    store
        .append_checkpoint(
            &task.task_id,
            &user_id,
            &workspace_id,
            serde_json::json!({
                "prompt_plan_executor": {
                    "state": "started",
                    "raw_payload_stored": false
                }
            }),
            serde_json::json!({
                "prompt_plan_executor": {
                    "state": "started",
                    "surface": surface,
                    "action_kind": action_kind,
                    "payload_redacted": true
                }
            }),
        )
        .map_err(to_string_error)?;
    let execution_result = (|| -> Result<(), String> {
        manager.start_surface(
            session_id,
            surface_kind,
            prompt_plan_surface_label(surface_kind),
        )?;
        manager.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: surface_kind,
            kind: "prompt_plan_step_started".to_string(),
            status: "running".to_string(),
            title: task.goal.clone(),
            subtitle: "Esecuzione governata da Task Runtime".to_string(),
            payload: serde_json::json!({
                "task_id": task_id,
                "payload_redacted": true
            }),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        store
            .append_checkpoint(
                &task.task_id,
                &user_id,
                &workspace_id,
                serde_json::json!({
                    "prompt_plan_executor": {
                        "state": "completed",
                        "raw_payload_stored": false
                    }
                }),
                serde_json::json!({
                    "prompt_plan_executor": {
                        "state": "completed",
                        "surface": surface,
                        "action_kind": action_kind,
                        "result": "read_only_step_recorded",
                        "payload_redacted": true
                    }
                }),
            )
            .map_err(to_string_error)?;
        store
            .update_task_status(
                &task.task_id,
                &user_id,
                &workspace_id,
                TaskStatus::Completed,
                None,
            )
            .map_err(to_string_error)?;
        append_prompt_plan_computer_event(
            manager,
            session_id,
            surface_kind,
            "prompt_plan_step_completed",
            "done",
            &task.goal,
            "Checkpoint redatto disponibile",
            false,
        )?;
        Ok(())
    })();
    let release_result = resources.release(store, &task).map_err(to_string_error);
    if let Err(error) = execution_result {
        let _ = store.update_task_status(
            &task.task_id,
            &user_id,
            &workspace_id,
            TaskStatus::Failed,
            Some(&error),
        );
        release_result?;
        return Err(error);
    }
    release_result?;

    Ok(PromptPlanStepRunResult {
        status: "completed".to_string(),
        task_id: Some(task_id),
        message: "Step prompt_plan eseguito in modalita read-only.".to_string(),
    })
}

fn append_prompt_plan_computer_event(
    manager: &LocalComputerSessionManager,
    session_id: &str,
    surface: SurfaceKind,
    kind: &str,
    status: &str,
    title: &str,
    subtitle: &str,
    approval_required: bool,
) -> Result<(), String> {
    manager.append_event(ComputerEventCreate {
        session_id: session_id.to_string(),
        surface,
        kind: kind.to_string(),
        status: status.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        payload: serde_json::json!({
            "payload_redacted": true
        }),
        artifact_refs: vec![],
        approval_required,
    })?;
    Ok(())
}

fn is_prompt_plan_task_for_session(task: &TaskRecord, session_id: &str) -> bool {
    task.kind.starts_with("prompt_plan.")
        && task
            .input_json
            .get("source")
            .and_then(|value| value.as_str())
            == Some("prompt_plan")
        && task
            .input_json
            .get("session_id")
            .and_then(|value| value.as_str())
            == Some(session_id)
}

fn prompt_plan_surface(task: &TaskRecord) -> &str {
    task.input_json
        .get("surface")
        .and_then(|value| value.as_str())
        .unwrap_or("logs")
}

fn prompt_plan_action_kind(task: &TaskRecord) -> &str {
    task.input_json
        .get("action_kind")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
}

fn surface_kind_for_prompt_plan(surface: &str) -> SurfaceKind {
    match surface {
        "browser" => SurfaceKind::Browser,
        "shell" => SurfaceKind::Shell,
        "files" => SurfaceKind::Files,
        _ => SurfaceKind::Logs,
    }
}

fn prompt_plan_surface_label(surface: SurfaceKind) -> &'static str {
    match surface {
        SurfaceKind::Browser => "Browser locale",
        SurfaceKind::Shell => "Terminale locale",
        SurfaceKind::Files => "File locali",
        SurfaceKind::Logs => "Log locali",
    }
}

fn to_string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
