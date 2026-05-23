use crate::AgentId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskNode {
    pub task_id: String,
    pub agent_id: AgentId,
    pub depends_on: Vec<String>,
    pub state: TaskState,
}

impl TaskNode {
    pub fn new(task_id: impl Into<String>, agent_id: AgentId, depends_on: Vec<String>) -> Self {
        Self {
            task_id: task_id.into(),
            agent_id,
            depends_on,
            state: TaskState::Pending,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionGraph {
    nodes: BTreeMap<String, TaskNode>,
}

impl ExecutionGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, node: TaskNode) -> Result<(), String> {
        if self.nodes.contains_key(&node.task_id) {
            return Err(format!("task {} already exists", node.task_id));
        }

        for dependency in &node.depends_on {
            if !self.nodes.contains_key(dependency) {
                return Err(format!(
                    "task {} depends on missing task {}",
                    node.task_id, dependency
                ));
            }
        }

        self.nodes.insert(node.task_id.clone(), node);
        Ok(())
    }

    pub fn set_state(&mut self, task_id: &str, state: TaskState) -> Result<(), String> {
        let node = self
            .nodes
            .get_mut(task_id)
            .ok_or_else(|| format!("task {} does not exist", task_id))?;
        node.state = state;
        Ok(())
    }

    pub fn state(&self, task_id: &str) -> Option<&TaskState> {
        self.nodes.get(task_id).map(|node| &node.state)
    }

    pub fn ready_task_ids(&self) -> Vec<&str> {
        self.nodes
            .values()
            .filter(|node| {
                node.state == TaskState::Pending
                    && node.depends_on.iter().all(|dependency| {
                        self.nodes.get(dependency).is_some_and(|dependency_node| {
                            dependency_node.state == TaskState::Succeeded
                        })
                    })
            })
            .map(|node| node.task_id.as_str())
            .collect()
    }

    pub fn blocked_task_ids(&self) -> Vec<&str> {
        self.nodes
            .values()
            .filter(|node| {
                node.state == TaskState::Pending
                    && node.depends_on.iter().any(|dependency| {
                        self.nodes.get(dependency).is_some_and(|dependency_node| {
                            matches!(
                                dependency_node.state,
                                TaskState::Failed | TaskState::Cancelled
                            )
                        })
                    })
            })
            .map(|node| node.task_id.as_str())
            .collect()
    }
}
