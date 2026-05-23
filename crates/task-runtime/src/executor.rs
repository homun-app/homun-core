use crate::{TaskCheckpoint, TaskRecord, TaskRuntimeResult};
use serde_json::Value;
use std::collections::VecDeque;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq)]
pub enum ExecutorResult {
    Completed {
        output: Value,
    },
    Checkpoint {
        payload: Value,
        redacted_payload: Value,
    },
    WaitUntil {
        not_before: OffsetDateTime,
        reason: String,
    },
    NeedsApproval {
        action: String,
        risk_level: String,
        data_boundary: String,
        explanation: String,
    },
    RetryableFailure {
        reason: String,
    },
}

pub trait TaskExecutor {
    fn executor_id(&self) -> &str;

    fn execute_step(
        &mut self,
        task: &TaskRecord,
        checkpoint: Option<TaskCheckpoint>,
    ) -> TaskRuntimeResult<ExecutorResult>;
}

pub struct FakeTaskExecutor {
    executor_id: String,
    results: VecDeque<ExecutorResult>,
}

impl FakeTaskExecutor {
    pub fn new(results: Vec<ExecutorResult>) -> Self {
        Self {
            executor_id: "fake-task-executor".to_string(),
            results: VecDeque::from(results),
        }
    }
}

impl TaskExecutor for FakeTaskExecutor {
    fn executor_id(&self) -> &str {
        &self.executor_id
    }

    fn execute_step(
        &mut self,
        _task: &TaskRecord,
        _checkpoint: Option<TaskCheckpoint>,
    ) -> TaskRuntimeResult<ExecutorResult> {
        Ok(self
            .results
            .pop_front()
            .unwrap_or(ExecutorResult::Completed {
                output: Value::Null,
            }))
    }
}
