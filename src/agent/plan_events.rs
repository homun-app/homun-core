use tokio::sync::mpsc;

use crate::provider::StreamChunk;

use super::browser_task_plan::BrowserTaskPlanState;
use super::execution_plan::{ExecutionPlanSnapshot, ExecutionPlanState};

pub(super) async fn emit_plan_update(
    stream_tx: Option<&mpsc::Sender<StreamChunk>>,
    plan: &ExecutionPlanSnapshot,
    last_payload: &mut Option<String>,
) {
    let Some(tx) = stream_tx else {
        return;
    };
    let Ok(payload) = serde_json::to_string(plan) else {
        return;
    };
    if last_payload.as_deref() == Some(payload.as_str()) {
        return;
    }
    *last_payload = Some(payload.clone());
    let _ = tx
        .send(StreamChunk {
            delta: payload,
            done: false,
            event_type: Some("plan".to_string()),
            tool_call_data: None,
        })
        .await;
}

pub(super) fn merged_execution_snapshot(
    execution_plan: &ExecutionPlanState,
    browser_task_plan: &BrowserTaskPlanState,
) -> ExecutionPlanSnapshot {
    browser_task_plan.merged_snapshot(execution_plan.snapshot())
}
