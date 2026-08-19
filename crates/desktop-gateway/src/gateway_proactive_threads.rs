//! Thread identity planning for proactive/scheduled task runs.
//!
//! This owner derives the stable visible-thread metadata. It does not start
//! turns, persist task mutations, or execute the proactive agent turn.

use crate::gateway_automation_formatting::{
    scheduled_thread_sender_for_task_id, scheduled_thread_title,
};
use local_first_task_runtime::TaskRecord;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProactiveThreadPlan {
    pub(crate) thread_id: Option<String>,
    pub(crate) workspace_id: String,
    pub(crate) source: String,
    pub(crate) channel: Option<String>,
    pub(crate) title: String,
    pub(crate) scheduled_root: Option<String>,
}

pub(crate) fn proactive_thread_plan(task: &TaskRecord, goal: &str) -> ProactiveThreadPlan {
    let workspace_id = task
        .input_json
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| task.workspace_id.as_str())
        .to_string();
    let thread_id = task
        .input_json
        .get("thread_id")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string);
    let source = task
        .input_json
        .get("thread_source")
        .or_else(|| task.input_json.get("source"))
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("scheduled")
        .to_string();
    let channel = task
        .input_json
        .get("thread_channel")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string);
    let title = task
        .input_json
        .get("thread_title")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| scheduled_thread_title(goal));
    let (derived_root, derived_thread_id) = proactive_thread_scope(task.task_id.as_str(), &source);
    let scheduled_root = (thread_id.is_none()
        || thread_id.as_deref() == Some(derived_thread_id.as_str()))
    .then_some(derived_root);
    ProactiveThreadPlan {
        thread_id,
        workspace_id,
        source,
        channel,
        title,
        scheduled_root,
    }
}

pub(crate) fn proactive_thread_scope(task_id: &str, source: &str) -> (String, String) {
    let root = scheduled_thread_sender_for_task_id(task_id);
    let thread_id = format!("channel_{source}_{root}");
    (root, thread_id)
}
