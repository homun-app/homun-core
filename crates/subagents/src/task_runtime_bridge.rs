use crate::{
    AgentId, AllowedAction, JsonRuntime, SubagentResult, SubagentRunner, SubagentStatus,
    SubagentTask, WorkflowTaskSpec,
};
use local_first_task_runtime::{
    ExecutorResult, ResourceClass, ResourceRequirement, RetryPolicy, TaskCheckpoint, TaskExecutor,
    TaskId, TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskStore, UserId, WorkflowId,
    WorkspaceId,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnqueuedSubagentWorkflow {
    pub task_ids: Vec<TaskId>,
}

pub struct SubagentTaskRuntimeBridge {
    retry_policy: RetryPolicy,
}

impl SubagentTaskRuntimeBridge {
    pub fn new() -> Self {
        Self {
            retry_policy: RetryPolicy {
                max_attempts: 2,
                backoff_seconds: 30,
            },
        }
    }

    pub fn enqueue_workflow(
        &self,
        store: &TaskStore,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        workflow_id: &WorkflowId,
        specs: &[WorkflowTaskSpec],
    ) -> TaskRuntimeResult<EnqueuedSubagentWorkflow> {
        let mut task_ids = Vec::new();
        for spec in specs {
            let record = self.task_record(&spec.task, user_id, workspace_id, workflow_id)?;
            task_ids.push(record.task_id.clone());
            store.insert_task(&record)?;
        }

        for spec in specs {
            let task_id = TaskId::new(spec.task.task_id.clone());
            for dependency in &spec.depends_on {
                store.add_dependency(
                    &task_id,
                    &TaskId::new(dependency.clone()),
                    user_id,
                    workspace_id,
                )?;
            }
        }

        Ok(EnqueuedSubagentWorkflow { task_ids })
    }

    pub fn task_record(
        &self,
        task: &SubagentTask,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        workflow_id: &WorkflowId,
    ) -> TaskRuntimeResult<TaskRecord> {
        let mut record = TaskRecord::new(
            task.task_id.clone(),
            user_id.clone(),
            workspace_id.clone(),
            format!("subagent.{}", agent_id_label(&task.agent_id)),
            task.goal.clone(),
            serde_json::to_value(task)?,
        )
        .with_workflow(workflow_id.clone())
        .with_resource(ResourceRequirement::new(ResourceClass::LlmInference, 1))
        .with_retry_policy(self.retry_policy.clone());
        record.permission_context = serde_json::to_value(&task.permission_envelope)?;
        record.risk_level = risk_level_for_actions(&task.permission_envelope.allowed_actions);
        Ok(record)
    }
}

impl Default for SubagentTaskRuntimeBridge {
    fn default() -> Self {
        Self::new()
    }
}

fn agent_id_label(agent_id: &AgentId) -> &'static str {
    match agent_id {
        AgentId::Planner => "PlannerAgent",
        AgentId::Memory => "MemoryAgent",
        AgentId::Tool => "ToolAgent",
        AgentId::Vision => "VisionAgent",
        AgentId::Risk => "RiskAgent",
        AgentId::Automation => "AutomationAgent",
        AgentId::Review => "ReviewAgent",
    }
}

fn risk_level_for_actions(actions: &[AllowedAction]) -> String {
    if actions
        .iter()
        .any(|action| matches!(action, AllowedAction::ApprovedAutomation))
    {
        "high".to_string()
    } else if actions
        .iter()
        .any(|action| matches!(action, AllowedAction::WriteWithConfirmation))
    {
        "medium".to_string()
    } else {
        "low".to_string()
    }
}

pub struct SubagentTaskExecutor<R> {
    runner: SubagentRunner<R>,
}

impl<R: JsonRuntime> SubagentTaskExecutor<R> {
    pub fn new(runtime: R) -> Self {
        Self {
            runner: SubagentRunner::new(runtime, "local-model"),
        }
    }

    pub fn with_runner(runner: SubagentRunner<R>) -> Self {
        Self { runner }
    }
}

impl<R: JsonRuntime> TaskExecutor for SubagentTaskExecutor<R> {
    fn executor_id(&self) -> &str {
        "subagent-task-executor"
    }

    fn execute_step(
        &mut self,
        task: &TaskRecord,
        _checkpoint: Option<TaskCheckpoint>,
    ) -> TaskRuntimeResult<ExecutorResult> {
        let subagent_task: SubagentTask = serde_json::from_value(task.input_json.clone())
            .map_err(|error| TaskRuntimeError::Store(error.to_string()))?;
        let result = self.runner.run_generate_json(&subagent_task);
        map_subagent_result(result)
    }
}

fn map_subagent_result(result: SubagentResult) -> TaskRuntimeResult<ExecutorResult> {
    match result.status {
        SubagentStatus::Succeeded => Ok(ExecutorResult::Completed {
            output: serde_json::to_value(result)?,
        }),
        SubagentStatus::Failed | SubagentStatus::TimedOut | SubagentStatus::Cancelled => {
            Ok(ExecutorResult::RetryableFailure {
                reason: failure_reason(&result),
            })
        }
    }
}

fn failure_reason(result: &SubagentResult) -> String {
    if result.errors.is_empty() {
        format!(
            "subagent {:?} returned {:?}",
            result.agent_id, result.status
        )
    } else {
        result.errors.join("; ")
    }
}
