use crate::TaskId;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct TaskDependencyOutput {
    pub task_id: TaskId,
    pub output: Value,
    pub redacted_output: Value,
}
