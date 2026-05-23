use crate::{
    AgentAudit, GenerateJsonRequest, JsonRuntime, PromptGuardVerdict, SubagentResult,
    SubagentStatus, SubagentTask, TokenMetrics, guard_prompt, validate_task_permissions,
};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct SubagentRunner<R> {
    runtime: R,
    model: String,
}

impl<R: JsonRuntime> SubagentRunner<R> {
    pub fn new(runtime: R, model: impl Into<String>) -> Self {
        Self {
            runtime,
            model: model.into(),
        }
    }

    pub fn runtime(&self) -> &R {
        &self.runtime
    }

    pub fn run_generate_json(&self, task: &SubagentTask) -> SubagentResult {
        let started_at = audit_timestamp();
        let permission_errors = validate_task_permissions(task);
        if !permission_errors.is_empty() {
            return self.failed_result(task, permission_errors, started_at);
        }

        let request = generate_json_request_from_task(task);
        let guard = guard_prompt(&request.prompt);
        if guard.verdict == PromptGuardVerdict::Block {
            return self.failed_result(
                task,
                vec![format!(
                    "prompt injection blocked: {}",
                    guard.reasons.join(", ")
                )],
                started_at,
            );
        }
        match self.runtime.generate_json(&request) {
            Ok(response) if response.valid => SubagentResult {
                task_id: task.task_id.clone(),
                agent_id: task.agent_id.clone(),
                status: SubagentStatus::Succeeded,
                output: response.json,
                errors: vec![],
                metrics: response.metrics,
                audit: AgentAudit {
                    model: self.model.clone(),
                    contract: task.contract.clone(),
                    started_at,
                    finished_at: audit_timestamp(),
                },
            },
            Ok(response) => SubagentResult {
                task_id: task.task_id.clone(),
                agent_id: task.agent_id.clone(),
                status: SubagentStatus::Failed,
                output: response.json,
                errors: response.errors,
                metrics: response.metrics,
                audit: AgentAudit {
                    model: self.model.clone(),
                    contract: task.contract.clone(),
                    started_at,
                    finished_at: audit_timestamp(),
                },
            },
            Err(error) => self.failed_result(task, vec![format!("{error:?}")], started_at),
        }
    }

    fn failed_result(
        &self,
        task: &SubagentTask,
        errors: Vec<String>,
        started_at: String,
    ) -> SubagentResult {
        SubagentResult {
            task_id: task.task_id.clone(),
            agent_id: task.agent_id.clone(),
            status: SubagentStatus::Failed,
            output: serde_json::Value::Null,
            errors,
            metrics: TokenMetrics::zero(),
            audit: AgentAudit {
                model: self.model.clone(),
                contract: task.contract.clone(),
                started_at,
                finished_at: audit_timestamp(),
            },
        }
    }
}

pub fn generate_json_request_from_task(task: &SubagentTask) -> GenerateJsonRequest {
    GenerateJsonRequest {
        prompt: task
            .input
            .get("prompt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&task.goal)
            .to_string(),
        max_tokens: task.budgets.max_tokens,
        temperature: task
            .input
            .get("temperature")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0) as f32,
        json_schema: task.input.get("schema").cloned(),
        required_keys: task
            .input
            .get("required_keys")
            .and_then(serde_json::Value::as_array)
            .map(|keys| {
                keys.iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default(),
        repair: task
            .input
            .get("repair")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
    }
}

fn audit_timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format!("unix:{seconds}")
}
