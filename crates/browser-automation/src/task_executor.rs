use crate::{BrowserAutomationClient, BrowserMethod, BrowserResponse, BrowserTransport};
use local_first_task_runtime::{
    ExecutorResult, ResourceClass, ResourceRequirement, TaskCheckpoint, TaskExecutor, TaskRecord,
    TaskRuntimeError, TaskRuntimeResult, UserId, WorkspaceId,
};
use serde_json::Value;

pub struct BrowserTaskRuntimeBridge;

impl BrowserTaskRuntimeBridge {
    pub fn new() -> Self {
        Self
    }

    pub fn enqueue_browser_call(
        &self,
        task_id: impl Into<String>,
        user_id: UserId,
        workspace_id: WorkspaceId,
        method: BrowserMethod,
        params: Value,
    ) -> TaskRecord {
        TaskRecord::new(
            task_id,
            user_id,
            workspace_id,
            "browser_automation",
            "Browser automation call",
            serde_json::json!({
                "method": method,
                "params": params,
            }),
        )
        .with_resource(ResourceRequirement::new(ResourceClass::BrowserSession, 1))
    }
}

impl Default for BrowserTaskRuntimeBridge {
    fn default() -> Self {
        Self::new()
    }
}

pub struct BrowserTaskExecutor<T> {
    client: BrowserAutomationClient<T>,
}

impl<T: BrowserTransport> BrowserTaskExecutor<T> {
    pub fn new(transport: T) -> Self {
        Self {
            client: BrowserAutomationClient::new(transport),
        }
    }
}

impl<T: BrowserTransport> TaskExecutor for BrowserTaskExecutor<T> {
    fn executor_id(&self) -> &str {
        "browser-task-executor"
    }

    fn execute_step(
        &mut self,
        task: &TaskRecord,
        _checkpoint: Option<TaskCheckpoint>,
    ) -> TaskRuntimeResult<ExecutorResult> {
        let method: BrowserMethod = serde_json::from_value(task.input_json["method"].clone())?;
        let params = task
            .input_json
            .get("params")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let response = self
            .client
            .call_response(method, params)
            .map_err(|error| TaskRuntimeError::Store(error.to_string()))?;
        match response {
            BrowserResponse::Success {
                ok: true, result, ..
            } if method == BrowserMethod::Snapshot => Ok(ExecutorResult::Checkpoint {
                payload: result.clone(),
                redacted_payload: result,
            }),
            BrowserResponse::Success {
                ok: true, result, ..
            } => Ok(ExecutorResult::Completed { output: result }),
            BrowserResponse::Success { .. } => Ok(ExecutorResult::RetryableFailure {
                reason: "browser returned invalid success envelope".to_string(),
            }),
            BrowserResponse::Error { error, .. } if error.manual_action_required => {
                Ok(ExecutorResult::NeedsApproval {
                    action: "browser.manual_action".to_string(),
                    risk_level: "medium".to_string(),
                    data_boundary: "local_browser".to_string(),
                    explanation: error.message,
                })
            }
            BrowserResponse::Error { error, .. } => Ok(ExecutorResult::RetryableFailure {
                reason: format!("{}:{}", error.code, error.message),
            }),
        }
    }
}
