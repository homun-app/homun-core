use crate::models::PromptPlanStepRunResult;
use local_first_browser_automation::{
    BrowserAutomationClient, BrowserMethod, BrowserSidecarSession, BrowserSidecarSpawnOptions,
};
use local_first_local_computer_session::{
    ArtifactCreate, ComputerEventCreate, LocalComputerSessionManager, SurfaceKind,
};
use local_first_task_runtime::{
    ResourceGovernor, ResourceLimits, TaskRecord, TaskScheduler, TaskStatus, TaskStore,
    UserId as TaskUserId, WorkspaceId as TaskWorkspaceId,
};
use std::path::Path;
use time::OffsetDateTime;

pub fn run_next_prompt_plan_step(
    store: &TaskStore,
    manager: &LocalComputerSessionManager,
    workspace_root: &Path,
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
    let target_url = prompt_plan_target_url(&task);

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
        let browser_result = if surface_kind == SurfaceKind::Browser {
            Some(execute_browser_read_only_step(
                manager,
                workspace_root,
                session_id,
                &task_id,
                &task.goal,
                target_url,
            )?)
        } else {
            None
        };
        let result_label = if browser_result.is_some() {
            "browser_read_only_completed"
        } else {
            "read_only_step_recorded"
        };
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
                        "result": result_label,
                        "browser": browser_result,
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
        message: if surface_kind == SurfaceKind::Browser {
            "Step browser read-only eseguito dal sidecar locale.".to_string()
        } else {
            "Step prompt_plan eseguito in modalita read-only.".to_string()
        },
    })
}

#[derive(Debug, Clone, serde::Serialize)]
struct BrowserReadOnlyResult {
    url: String,
    artifact_id: String,
    screenshot: String,
    bytes: u64,
}

fn execute_browser_read_only_step(
    manager: &LocalComputerSessionManager,
    workspace_root: &Path,
    session_id: &str,
    task_id: &str,
    title: &str,
    target_url: Option<&str>,
) -> Result<BrowserReadOnlyResult, String> {
    let runtime_dir = workspace_root.join("runtimes/browser-automation");
    let artifact_root = workspace_root.join("target/browser-task-artifacts");
    let transport = BrowserSidecarSession::spawn_with_options(
        "node",
        &["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
        BrowserSidecarSpawnOptions {
            current_dir: Some(runtime_dir),
            env: vec![(
                "BROWSER_AUTOMATION_ARTIFACT_ROOT".to_string(),
                artifact_root.display().to_string(),
            )],
        },
    )
    .map_err(to_string_error)?;
    let client = BrowserAutomationClient::new(transport);
    client
        .call(BrowserMethod::Health, serde_json::json!({}))
        .map_err(to_string_error)?;
    let target_id = format!("task-{}", sanitize_task_id(task_id));
    let start_url = target_url.unwrap_or("about:blank");
    let opened = client
        .call(
            BrowserMethod::Open,
            serde_json::json!({
                "url": start_url,
                "label": target_id
            }),
        )
        .map_err(to_string_error)?;
    let filename = format!("{}.png", sanitize_task_id(task_id));
    let screenshot = client
        .call(
            BrowserMethod::Screenshot,
            serde_json::json!({
                "target_id": target_id,
                "file_name": filename,
                "full_page": false
            }),
        )
        .map_err(to_string_error)?;
    let _ = client.call(BrowserMethod::Stop, serde_json::json!({}));
    let url = opened
        .get("url")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("about:blank")
        .to_string();
    let screenshot_path = screenshot
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "browser screenshot path missing".to_string())?
        .to_string();
    let bytes = screenshot
        .get("bytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "browser screenshot bytes missing".to_string())?;
    let artifact_id = format!("browser_preview_{}", sanitize_task_id(task_id));
    manager.create_artifact(ArtifactCreate {
        session_id: session_id.to_string(),
        artifact_id: artifact_id.clone(),
        title: format!("{}.png", sanitize_task_id(title)),
        kind: "screenshot".to_string(),
        path_ref: screenshot_path.clone(),
        size_bytes: bytes,
        preview_ref: Some(screenshot_path.clone()),
    })?;
    manager.append_event(ComputerEventCreate {
        session_id: session_id.to_string(),
        surface: SurfaceKind::Browser,
        kind: "browser_read_only_artifact_ready".to_string(),
        status: "done".to_string(),
        title: "Browser locale".to_string(),
        subtitle: "Screenshot redatto disponibile".to_string(),
        payload: serde_json::json!({
            "url": url,
            "artifact_id": artifact_id,
            "payload_redacted": true
        }),
        artifact_refs: vec![artifact_id.clone()],
        approval_required: false,
    })?;
    Ok(BrowserReadOnlyResult {
        url,
        artifact_id,
        screenshot: "redacted".to_string(),
        bytes,
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

fn prompt_plan_target_url(task: &TaskRecord) -> Option<&str> {
    task.input_json
        .get("target_url")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
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

fn sanitize_task_id(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn to_string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}
