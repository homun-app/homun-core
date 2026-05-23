use crate::{
    AuditStore, ExecutionGraph, JsonRuntime, SubagentResult, SubagentRunner, SubagentStatus,
    SubagentTask, TaskNode, TaskState, WorkflowTaskSpec,
};
use std::collections::BTreeMap;

pub struct SubagentOrchestrator<R> {
    runner: SubagentRunner<R>,
    graph: ExecutionGraph,
    tasks: BTreeMap<String, SubagentTask>,
}

impl<R: JsonRuntime> SubagentOrchestrator<R> {
    pub fn new(runner: SubagentRunner<R>) -> Self {
        Self {
            runner,
            graph: ExecutionGraph::new(),
            tasks: BTreeMap::new(),
        }
    }

    pub fn add_task(&mut self, task: SubagentTask, depends_on: Vec<String>) -> Result<(), String> {
        let node = TaskNode::new(task.task_id.clone(), task.agent_id.clone(), depends_on);
        self.graph.add_node(node)?;
        self.tasks.insert(task.task_id.clone(), task);
        Ok(())
    }

    pub fn add_workflow(&mut self, specs: Vec<WorkflowTaskSpec>) -> Result<(), String> {
        for spec in specs {
            self.add_task(spec.task, spec.depends_on)?;
        }
        Ok(())
    }

    pub fn run_ready_once(&mut self) -> Vec<SubagentResult> {
        let ready_task_ids: Vec<String> = self
            .graph
            .ready_task_ids()
            .into_iter()
            .map(ToString::to_string)
            .collect();

        let mut results = Vec::new();
        for task_id in ready_task_ids {
            if self.graph.set_state(&task_id, TaskState::Running).is_err() {
                continue;
            }
            let Some(task) = self.tasks.get(&task_id) else {
                let _ = self.graph.set_state(&task_id, TaskState::Failed);
                continue;
            };

            let result = self.runner.run_generate_json(task);
            let state = match result.status {
                SubagentStatus::Succeeded => TaskState::Succeeded,
                SubagentStatus::Cancelled => TaskState::Cancelled,
                SubagentStatus::Failed | SubagentStatus::TimedOut => TaskState::Failed,
            };
            let _ = self.graph.set_state(&task_id, state);
            results.push(result);
        }

        results
    }

    pub fn run_until_blocked(&mut self) -> Vec<SubagentResult> {
        let mut all_results = Vec::new();
        loop {
            let results = self.run_ready_once();
            if results.is_empty() {
                break;
            }
            all_results.extend(results);
        }
        all_results
    }

    pub fn run_until_blocked_recording(
        &mut self,
        audit_store: &AuditStore,
    ) -> Result<Vec<SubagentResult>, String> {
        let mut all_results = Vec::new();
        loop {
            let results = self.run_ready_once();
            if results.is_empty() {
                break;
            }
            for result in &results {
                audit_store.record_result(result)?;
            }
            all_results.extend(results);
        }
        Ok(all_results)
    }

    pub fn state(&self, task_id: &str) -> Option<&TaskState> {
        self.graph.state(task_id)
    }

    pub fn blocked_task_ids(&self) -> Vec<&str> {
        self.graph.blocked_task_ids()
    }

    pub fn ready_task_ids(&self) -> Vec<&str> {
        self.graph.ready_task_ids()
    }
}
