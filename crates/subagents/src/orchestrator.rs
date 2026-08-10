use crate::{
    AuditStore, CircuitBreaker, CircuitState, ExecutionGraph, JsonRuntime, RetryConfig,
    SubagentError, SubagentResult, SubagentRunner, SubagentStatus, SubagentTask, TaskNode,
    TaskState, TokenMetrics, WorkflowRunStatus, WorkflowTaskSpec,
};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

pub struct SubagentOrchestrator<R> {
    runner: SubagentRunner<R>,
    graph: ExecutionGraph,
    tasks: BTreeMap<String, SubagentTask>,
    retry_config: RetryConfig,
    circuit: CircuitBreaker,
}

impl<R: JsonRuntime> SubagentOrchestrator<R> {
    pub fn new(runner: SubagentRunner<R>) -> Self {
        Self {
            runner,
            graph: ExecutionGraph::new(),
            tasks: BTreeMap::new(),
            retry_config: RetryConfig::default(),
            circuit: CircuitBreaker::default(),
        }
    }

    pub fn with_retry_config(mut self, config: RetryConfig) -> Self {
        self.retry_config = config;
        self
    }

    pub fn with_circuit_breaker(mut self, circuit: CircuitBreaker) -> Self {
        self.circuit = circuit;
        self
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

    /// Run all currently ready tasks sequentially with retry and circuit breaker.
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

            let result = self.execute_task_with_resilience(task);
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

    /// Run all currently ready tasks in parallel using scoped threads.
    ///
    /// Independent DAG nodes are dispatched concurrently; results are sorted
    /// deterministically by task ID before being returned. If `cancel_on_failure`
    /// is `true`, remaining parallel tasks are signalled to stop as soon as any
    /// sibling fails.
    pub fn run_ready_once_parallel(&mut self, cancel_on_failure: bool) -> Vec<SubagentResult>
    where
        R: Send + Sync,
    {
        let ready_task_ids: Vec<String> = self
            .graph
            .ready_task_ids()
            .into_iter()
            .map(ToString::to_string)
            .collect();

        if ready_task_ids.is_empty() {
            return Vec::new();
        }

        // Mark all ready tasks as Running before spawning threads.
        for task_id in &ready_task_ids {
            if self.graph.set_state(task_id, TaskState::Running).is_err() {
                continue;
            }
        }

        // Extract shared references before entering the thread scope so the
        // mutable borrows of `self.graph` after the scope don't conflict.
        let runner = &self.runner;
        let circuit = &self.circuit;
        let model: &str = self.runner.model();
        let retry_config = &self.retry_config;

        let cancel_flag = Arc::new(AtomicBool::new(false));

        let results: Vec<SubagentResult> = thread::scope(|s| {
            let mut handles = Vec::new();
            for task_id in &ready_task_ids {
                let Some(task) = self.tasks.get(task_id) else {
                    continue;
                };
                let cancel = Arc::clone(&cancel_flag);
                handles.push((
                    task_id.clone(),
                    s.spawn(move || {
                        if cancel.load(Ordering::Relaxed) {
                            return cancelled_result(task);
                        }
                        let result =
                            execute_task_resilience(runner, circuit, model, retry_config, task);
                        if cancel_on_failure && result.status != SubagentStatus::Succeeded {
                            cancel.store(true, Ordering::Relaxed);
                        }
                        result
                    }),
                ));
            }

            let mut collected: Vec<SubagentResult> = handles
                .into_iter()
                .map(|(task_id, handle)| {
                    handle.join().unwrap_or_else(|_| SubagentResult {
                        task_id: task_id.clone(),
                        agent_id: crate::AgentId::Planner,
                        status: SubagentStatus::Failed,
                        output: serde_json::Value::Null,
                        errors: vec!["thread panicked".to_string()],
                        metrics: TokenMetrics::zero(),
                        audit: crate::AgentAudit {
                            model: model.to_string(),
                            contract: String::new(),
                            started_at: String::new(),
                            finished_at: String::new(),
                        },
                    })
                })
                .collect();

            // Deterministic ordering by task ID.
            collected.sort_by(|a, b| a.task_id.cmp(&b.task_id));
            collected
        });

        // Update graph states after all threads have joined.
        for result in &results {
            let state = match result.status {
                SubagentStatus::Succeeded => TaskState::Succeeded,
                SubagentStatus::Cancelled => TaskState::Cancelled,
                SubagentStatus::Failed | SubagentStatus::TimedOut => TaskState::Failed,
            };
            let _ = self.graph.set_state(&result.task_id, state);
        }

        // Handle tasks that were missing from the task map.
        for task_id in &ready_task_ids {
            if !self.tasks.contains_key(task_id) {
                let _ = self.graph.set_state(task_id, TaskState::Failed);
            }
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

    /// Run until blocked, dispatching independent nodes in parallel each wave.
    pub fn run_until_blocked_parallel(&mut self, cancel_on_failure: bool) -> Vec<SubagentResult>
    where
        R: Send + Sync,
    {
        let mut all_results = Vec::new();
        loop {
            let results = self.run_ready_once_parallel(cancel_on_failure);
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

    pub fn run_workflow_recording(
        &mut self,
        run_id: &str,
        workflow_name: &str,
        audit_store: &AuditStore,
    ) -> Result<Vec<SubagentResult>, String> {
        audit_store.start_workflow_run(run_id, workflow_name, self.tasks.len() as u32)?;
        let mut results = Vec::new();
        loop {
            let batch = self.run_ready_once();
            if batch.is_empty() {
                break;
            }
            for result in &batch {
                audit_store.record_result_for_workflow(run_id, result)?;
            }
            results.extend(batch);
        }
        let status = if results
            .iter()
            .any(|result| result.status == SubagentStatus::Cancelled)
        {
            WorkflowRunStatus::Cancelled
        } else if results.iter().any(|result| {
            matches!(
                result.status,
                SubagentStatus::Failed | SubagentStatus::TimedOut
            )
        }) {
            WorkflowRunStatus::Failed
        } else if !self.blocked_task_ids().is_empty() {
            WorkflowRunStatus::Blocked
        } else {
            WorkflowRunStatus::Succeeded
        };
        audit_store.finish_workflow_run(run_id, status)?;
        Ok(results)
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

    pub fn circuit_state(&self, provider: &str) -> CircuitState {
        self.circuit.state(provider)
    }

    pub fn retry_config(&self) -> &RetryConfig {
        &self.retry_config
    }

    pub fn circuit_breaker(&self) -> &CircuitBreaker {
        &self.circuit
    }

    // ── private helpers ─────────────────────────────────────────────

    fn execute_task_with_resilience(&self, task: &SubagentTask) -> SubagentResult {
        execute_task_resilience(
            &self.runner,
            &self.circuit,
            self.runner.model(),
            &self.retry_config,
            task,
        )
    }
}

/// Stateless retry + circuit-breaker loop, shared between sequential and
/// parallel dispatch paths.
fn execute_task_resilience<R: JsonRuntime>(
    runner: &SubagentRunner<R>,
    circuit: &CircuitBreaker,
    model: &str,
    retry_config: &RetryConfig,
    task: &SubagentTask,
) -> SubagentResult {
    let max_attempts = retry_config.max_retries + 1;
    let mut last_result = None;

    for attempt in 0..max_attempts {
        // Circuit breaker gate.
        if !circuit.allow_request(model) {
            let result = runner.run_generate_json(task);
            return SubagentResult {
                status: SubagentStatus::Failed,
                errors: vec![format!("circuit open for provider {model}")],
                ..result
            };
        }

        let result = runner.run_generate_json(task);

        match result.status {
            SubagentStatus::Succeeded => {
                circuit.record_success(model);
                return result;
            }
            _ => {
                let is_transient = result.errors.iter().any(|e| parse_error(e).is_transient());

                if is_transient {
                    circuit.record_failure(model);
                    last_result = Some(result);
                    if attempt + 1 < max_attempts {
                        thread::sleep(retry_config.backoff(attempt));
                    }
                } else {
                    circuit.record_failure(model);
                    return result;
                }
            }
        }
    }

    // Retry budget exhausted — annotate the last result.
    last_result
        .map(|mut r| {
            r.errors.push(format!(
                "retry budget exhausted after {max_attempts} attempts"
            ));
            r
        })
        .unwrap_or_else(|| runner.run_generate_json(task))
}

/// Build a cancelled result without running the task.
fn cancelled_result(task: &SubagentTask) -> SubagentResult {
    SubagentResult {
        task_id: task.task_id.clone(),
        agent_id: task.agent_id.clone(),
        status: SubagentStatus::Cancelled,
        output: serde_json::Value::Null,
        errors: vec!["cancelled by sibling failure".to_string()],
        metrics: TokenMetrics::zero(),
        audit: crate::AgentAudit {
            model: String::new(),
            contract: task.contract.clone(),
            started_at: String::new(),
            finished_at: String::new(),
        },
    }
}

/// Best-effort parse of an error string into a [`SubagentError`] for
/// transient classification.
fn parse_error(msg: &str) -> SubagentError {
    if msg.contains("circuit open") {
        SubagentError::CircuitOpen(msg.to_string())
    } else if msg.contains("timeout") || msg.contains("timed out") {
        SubagentError::Timeout(msg.to_string())
    } else {
        SubagentError::Runtime(msg.to_string())
    }
}
