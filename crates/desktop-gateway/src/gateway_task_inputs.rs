//! Shared task input helpers.

use local_first_task_runtime::TaskRecord;

pub(crate) fn task_effective_goal(task: &TaskRecord) -> String {
    task.input_json
        .get("prompt_redacted")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(task.goal.as_str())
        .to_string()
}
