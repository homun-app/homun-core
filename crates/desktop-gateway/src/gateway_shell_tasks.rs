//! Local read-only shell task execution.
//!
//! This owner keeps the tiny legacy shell adapter isolated from the gateway
//! monolith. It only permits the existing read-only date command path.

use crate::gateway_text_safety::{redact_sensitive_text, truncate_chars};
use crate::{
    AppState, LocalTaskExecutionError, SurfaceKind, TaskExecutionPresentation, TaskResultSurfacing,
    execution_runtime,
};
use local_first_task_runtime::TaskRecord;
use serde_json::Value;
use std::process::Command;

pub(crate) fn redact_json_for_task_output(output: &Value) -> Value {
    match output {
        Value::String(text) => Value::String(redact_sensitive_text(&truncate_chars(text, 2_000))),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .take(100)
                .map(redact_json_for_task_output)
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), redact_json_for_task_output(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

pub(crate) fn execute_shell_read_only_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    let normalized = task.goal.to_lowercase();
    let output = if normalized.contains("ora")
        || normalized.contains("orario")
        || normalized.contains("date")
        || normalized.contains("tempo")
    {
        run_read_only_command("date", &["+%Y-%m-%d %H:%M:%S %Z"])
    } else {
        Err(LocalTaskExecutionError {
            message: "The shell task does not contain an allowed read-only command.".to_string(),
        })
    }?;
    execution_runtime::complete_task_execution(
        state,
        task,
        TaskExecutionPresentation {
            pending_approval: None,
            summary: "Read-only shell command completed.".to_string(),
            checkpoint_payload: serde_json::json!({ "kind": "shell_read_only", "command": "date", "output": output }),
            checkpoint_redacted: serde_json::json!({ "kind": "shell_read_only", "command": "date", "output": output }),
            chat_message: format!(
                "I ran a local read-only check:\n\n```text\n{}\n```",
                output.trim()
            ),
            result_surfacing: TaskResultSurfacing::AppendToChat,
            surface: SurfaceKind::Shell,
            event_kind: "computer_terminal_output".to_string(),
            event_title: "Terminal output".to_string(),
            event_subtitle: "Read-only command completed.".to_string(),
            event_payload: serde_json::json!({ "command": "date", "output": output }),
            artifacts: vec![],
        },
    )
}

pub(crate) fn run_read_only_command(
    command: &str,
    args: &[&str],
) -> Result<String, LocalTaskExecutionError> {
    let output =
        Command::new(command)
            .args(args)
            .output()
            .map_err(|error| LocalTaskExecutionError {
                message: format!("Read-only command not started: {error}"),
            })?;
    if !output.status.success() {
        return Err(LocalTaskExecutionError {
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
