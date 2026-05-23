use local_first_local_computer_session::{
    ComputerEventCreate, ComputerSessionSnapshot, LocalComputerSessionManager, SurfaceKind,
};
use serde::Serialize;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub struct PromptSubmissionResult {
    pub user_message: PromptMessage,
    pub assistant_message: PromptMessage,
    pub computer_session: ComputerSessionSnapshot,
}

#[derive(Debug, Clone, Serialize)]
pub struct PromptMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: String,
    pub metadata: Option<String>,
}

pub fn submit_user_prompt(
    manager: &LocalComputerSessionManager,
    user_id: &str,
    workspace_id: &str,
    session_id: &str,
    prompt: &str,
) -> Result<PromptSubmissionResult, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt is empty".to_string());
    }
    if prompt.chars().count() > 4_000 {
        return Err("prompt is too long".to_string());
    }

    manager.append_event(ComputerEventCreate {
        session_id: session_id.to_string(),
        surface: SurfaceKind::Logs,
        kind: "user_prompt_received".to_string(),
        status: "done".to_string(),
        title: "Prompt utente ricevuto".to_string(),
        subtitle: format!("Prompt redatto, {} caratteri", prompt.chars().count()),
        payload: serde_json::json!({
            "raw_prompt_stored": false,
            "prompt_chars": prompt.chars().count()
        }),
        artifact_refs: vec![],
        approval_required: false,
    })?;

    let assistant_text = if requests_local_time(prompt) {
        manager.start_surface(session_id, SurfaceKind::Shell, "Terminale locale")?;
        manager.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Shell,
            kind: "computer_action_started".to_string(),
            status: "running".to_string(),
            title: "Verificare ora locale".to_string(),
            subtitle: "Esecuzione read-only tramite comando date".to_string(),
            payload: serde_json::json!({ "command": "date" }),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        let date_output = run_date_command()?;
        manager.append_terminal_output(
            session_id,
            user_id,
            workspace_id,
            &date_output.transcript,
        )?;
        manager.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Shell,
            kind: "computer_action_completed".to_string(),
            status: "done".to_string(),
            title: "Ora locale verificata".to_string(),
            subtitle: "Risultato ottenuto localmente dalla shell".to_string(),
            payload: serde_json::json!({ "command": "date", "output": "redacted" }),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        format!(
            "Ho verificato localmente dalla shell: {}.",
            date_output.value
        )
    } else {
        manager.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Logs,
            kind: "prompt_pending_brain".to_string(),
            status: "waiting".to_string(),
            title: "Prompt pronto per il Brain".to_string(),
            subtitle: "Il composer e' cablato; il planner operativo sara' il prossimo layer."
                .to_string(),
            payload: serde_json::json!({
                "raw_prompt_stored": false,
                "needs_brain": true
            }),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        "Ho ricevuto il prompt nel core locale. Il prossimo passaggio e' collegarlo al Brain per decidere strumenti, task e browser.".to_string()
    };

    let computer_session = manager
        .read_model()
        .snapshot(session_id, user_id, workspace_id)?
        .ok_or_else(|| format!("session not found: {session_id}"))?;

    Ok(PromptSubmissionResult {
        user_message: PromptMessage {
            id: format!("user_{}", timestamp_nanos()),
            role: "user".to_string(),
            text: "[prompt redatto nel core locale]".to_string(),
            timestamp: "ora".to_string(),
            metadata: Some("Non salvato come payload raw".to_string()),
        },
        assistant_message: PromptMessage {
            id: format!("assistant_{}", timestamp_nanos()),
            role: "assistant".to_string(),
            text: assistant_text,
            timestamp: "ora".to_string(),
            metadata: Some("Tauri core locale".to_string()),
        },
        computer_session,
    })
}

struct DateCommandOutput {
    value: String,
    transcript: String,
}

fn run_date_command() -> Result<DateCommandOutput, String> {
    let output = Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S %Z")
        .output()
        .map_err(|error| format!("date command failed: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(format!(
            "date command exited with {}: {stderr}",
            output.status
        ));
    }
    Ok(DateCommandOutput {
        value: stdout.clone(),
        transcript: format!("prompt % date '+%Y-%m-%d %H:%M:%S %Z'\n{stdout}"),
    })
}

fn requests_local_time(prompt: &str) -> bool {
    let normalized = prompt.to_lowercase();
    ["ore", "ora", "orario", "time", "date", "data"]
        .iter()
        .any(|needle| normalized.contains(needle))
}

fn timestamp_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}
