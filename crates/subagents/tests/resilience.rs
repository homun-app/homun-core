use std::cell::RefCell;
use std::collections::{HashSet, VecDeque};

use local_first_subagents::{
    AgentId, AllowedAction, CircuitBreaker, CircuitState, GenerateJsonRequest,
    GenerateJsonResponse, JsonRuntime, PermissionEnvelope, RetryConfig, RuntimeClientError,
    SubagentOrchestrator, SubagentRunner, SubagentStatus, SubagentTask, TaskBudgets, TaskState,
    TokenMetrics,
};

// ── Fake runtimes ──────────────────────────────────────────────────

/// Single-threaded fake runtime for sequential tests.
struct FakeRuntime {
    responses: RefCell<VecDeque<Result<GenerateJsonResponse, RuntimeClientError>>>,
}

impl JsonRuntime for FakeRuntime {
    fn generate_json(
        &self,
        _request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        self.responses.borrow_mut().pop_front().unwrap()
    }
}

/// Thread-safe fake runtime that returns valid responses, with optional
/// per-task failures (non-transient: invalid JSON).
struct SyncFakeRuntime {
    fail_task_ids: HashSet<String>,
}

impl SyncFakeRuntime {
    fn all_valid() -> Self {
        Self {
            fail_task_ids: HashSet::new(),
        }
    }

    fn with_failures(fail_ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            fail_task_ids: fail_ids.into_iter().map(Into::into).collect(),
        }
    }
}

impl JsonRuntime for SyncFakeRuntime {
    fn generate_json(
        &self,
        request: &GenerateJsonRequest,
    ) -> Result<GenerateJsonResponse, RuntimeClientError> {
        let task_id = request.usage.task_id.as_deref().unwrap_or("");
        if self.fail_task_ids.contains(task_id) {
            Ok(GenerateJsonResponse {
                valid: false,
                errors: vec!["missing required key: ok".to_string()],
                json: serde_json::Value::Null,
                raw_output: "{}".to_string(),
                repaired: false,
                metrics: metrics(),
            })
        } else {
            Ok(GenerateJsonResponse {
                valid: true,
                errors: vec![],
                json: serde_json::json!({"ok": true}),
                raw_output: "{\"ok\": true}".to_string(),
                repaired: false,
                metrics: metrics(),
            })
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────

fn task(task_id: &str, agent_id: AgentId) -> SubagentTask {
    SubagentTask {
        task_id: task_id.to_string(),
        parent_task_id: None,
        agent_id,
        goal: format!("Run {task_id}"),
        input: serde_json::json!({"prompt": "Return JSON", "required_keys": ["ok"]}),
        contract: "TestContract".to_string(),
        permission_envelope: PermissionEnvelope {
            connectors: vec![],
            max_autonomy_level: 2,
            allowed_actions: vec![AllowedAction::Draft],
            requires_user_approval: true,
        },
        budgets: TaskBudgets {
            timeout_seconds: 30,
            max_tokens: 64,
        },
    }
}

fn valid_response() -> Result<GenerateJsonResponse, RuntimeClientError> {
    Ok(GenerateJsonResponse {
        valid: true,
        errors: vec![],
        json: serde_json::json!({"ok": true}),
        raw_output: "{\"ok\": true}".to_string(),
        repaired: false,
        metrics: metrics(),
    })
}

fn invalid_response() -> Result<GenerateJsonResponse, RuntimeClientError> {
    Ok(GenerateJsonResponse {
        valid: false,
        errors: vec!["missing required key: ok".to_string()],
        json: serde_json::Value::Null,
        raw_output: "{}".to_string(),
        repaired: false,
        metrics: metrics(),
    })
}

fn server_error() -> Result<GenerateJsonResponse, RuntimeClientError> {
    Err(RuntimeClientError::Status(503))
}

fn metrics() -> TokenMetrics {
    TokenMetrics {
        prompt_tokens: 1,
        generation_tokens: 1,
        prompt_tps: 1.0,
        generation_tps: 1.0,
        peak_memory_gb: 1.0,
        elapsed_seconds: 1.0,
    }
}

fn fast_retry() -> RetryConfig {
    RetryConfig {
        max_retries: 3,
        base_backoff_ms: 1,
        max_backoff_ms: 10,
        jitter_factor: 0.0,
    }
}

// ── Retry tests ────────────────────────────────────────────────────

#[test]
fn retry_succeeds_on_transient_failure() {
    // First call: 503 server error (transient), second: valid.
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([server_error(), valid_response()])),
        },
        "test-model",
    );
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("t1", AgentId::Planner), vec![]).unwrap();

    let results = orch.run_ready_once();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, SubagentStatus::Succeeded);
    assert_eq!(orch.state("t1"), Some(&TaskState::Succeeded));
}

#[test]
fn retry_exhausts_budget_on_persistent_transient_failure() {
    // 4 transient failures — all retries used up.
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([
                server_error(),
                server_error(),
                server_error(),
                server_error(),
            ])),
        },
        "test-model",
    );
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("t1", AgentId::Planner), vec![]).unwrap();

    let results = orch.run_ready_once();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, SubagentStatus::Failed);
    assert!(
        results[0]
            .errors
            .iter()
            .any(|e| e.contains("retry budget exhausted"))
    );
}

#[test]
fn no_retry_on_non_transient_failure() {
    // Invalid JSON response (non-transient) — should NOT retry.
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([
                invalid_response(),
                valid_response(), // would succeed if retried, but shouldn't be called
            ])),
        },
        "test-model",
    );
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("t1", AgentId::Planner), vec![]).unwrap();

    let results = orch.run_ready_once();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, SubagentStatus::Failed);
    // Only one attempt was made — no retry.
    assert!(!results[0].errors.iter().any(|e| e.contains("retry budget")));
}

// ── Circuit breaker tests ──────────────────────────────────────────

#[test]
fn circuit_breaker_closed_to_open_after_threshold() {
    let cb = CircuitBreaker::new(3, 60);

    assert_eq!(cb.state("model-a"), CircuitState::Closed);
    assert!(cb.allow_request("model-a"));

    cb.record_failure("model-a");
    cb.record_failure("model-a");
    assert_eq!(cb.state("model-a"), CircuitState::Closed);

    cb.record_failure("model-a");
    assert_eq!(cb.state("model-a"), CircuitState::Open);
    assert!(!cb.allow_request("model-a"));
}

#[test]
fn circuit_breaker_open_to_half_open_after_cooldown() {
    // Use 0-second cooldown so the transition happens immediately.
    let cb = CircuitBreaker::new(2, 0);

    cb.record_failure("m");
    cb.record_failure("m");
    assert_eq!(cb.state("m"), CircuitState::Open);

    // Cooldown is 0 seconds, so allow_request should transition to HalfOpen.
    assert!(cb.allow_request("m"));
    assert_eq!(cb.state("m"), CircuitState::HalfOpen);
}

#[test]
fn circuit_breaker_half_open_closes_on_success() {
    let cb = CircuitBreaker::new(2, 0);

    cb.record_failure("m");
    cb.record_failure("m");
    assert_eq!(cb.state("m"), CircuitState::Open);

    // Transition to HalfOpen.
    assert!(cb.allow_request("m"));
    assert_eq!(cb.state("m"), CircuitState::HalfOpen);

    // Probe succeeds → Closed.
    cb.record_success("m");
    assert_eq!(cb.state("m"), CircuitState::Closed);
    assert_eq!(cb.consecutive_failures("m"), 0);
}

#[test]
fn circuit_breaker_half_open_reopens_on_failure() {
    let cb = CircuitBreaker::new(2, 0);

    cb.record_failure("m");
    cb.record_failure("m");
    assert_eq!(cb.state("m"), CircuitState::Open);

    assert!(cb.allow_request("m"));
    assert_eq!(cb.state("m"), CircuitState::HalfOpen);

    // Probe fails → re-Open.
    cb.record_failure("m");
    assert_eq!(cb.state("m"), CircuitState::Open);
}

#[test]
fn circuit_breaker_success_resets_counter() {
    let cb = CircuitBreaker::new(3, 60);

    cb.record_failure("m");
    cb.record_failure("m");
    assert_eq!(cb.consecutive_failures("m"), 2);

    cb.record_success("m");
    assert_eq!(cb.consecutive_failures("m"), 0);
    assert_eq!(cb.state("m"), CircuitState::Closed);
}

#[test]
fn orchestrator_rejects_request_when_circuit_open() {
    let runner = SubagentRunner::new(
        FakeRuntime {
            responses: RefCell::new(VecDeque::from([valid_response()])),
        },
        "test-model",
    );
    let cb = CircuitBreaker::new(1, 9999);
    cb.record_failure("test-model"); // Open the circuit.

    let mut orch = SubagentOrchestrator::new(runner)
        .with_retry_config(fast_retry())
        .with_circuit_breaker(cb);
    orch.add_task(task("t1", AgentId::Planner), vec![]).unwrap();

    let results = orch.run_ready_once();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, SubagentStatus::Failed);
    assert!(results[0].errors.iter().any(|e| e.contains("circuit open")));
}

// ── RetryConfig backoff tests ──────────────────────────────────────

#[test]
fn retry_config_backoff_grows_exponentially() {
    let cfg = RetryConfig {
        max_retries: 5,
        base_backoff_ms: 100,
        max_backoff_ms: 10_000,
        jitter_factor: 0.0, // no jitter for deterministic test
    };

    assert_eq!(cfg.backoff(0).as_millis(), 100);
    assert_eq!(cfg.backoff(1).as_millis(), 200);
    assert_eq!(cfg.backoff(2).as_millis(), 400);
    assert_eq!(cfg.backoff(3).as_millis(), 800);
}

#[test]
fn retry_config_backoff_is_capped() {
    let cfg = RetryConfig {
        max_retries: 10,
        base_backoff_ms: 1000,
        max_backoff_ms: 5000,
        jitter_factor: 0.0,
    };

    // 2^10 * 1000 = 1_024_000, but capped at 5000.
    assert_eq!(cfg.backoff(10).as_millis(), 5000);
}

// ── Parallel dispatch tests ────────────────────────────────────────

#[test]
fn parallel_dispatch_produces_same_results_as_sequential() {
    // 3 independent tasks, all succeed.
    let runner = SubagentRunner::new(SyncFakeRuntime::all_valid(), "test-model");
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("a", AgentId::Planner), vec![]).unwrap();
    orch.add_task(task("b", AgentId::Risk), vec![]).unwrap();
    orch.add_task(task("c", AgentId::Memory), vec![]).unwrap();

    let results = orch.run_ready_once_parallel(false);

    assert_eq!(results.len(), 3);
    // Deterministic ordering by task ID.
    assert_eq!(results[0].task_id, "a");
    assert_eq!(results[1].task_id, "b");
    assert_eq!(results[2].task_id, "c");
    assert!(
        results
            .iter()
            .all(|r| r.status == SubagentStatus::Succeeded)
    );
}

#[test]
fn parallel_dispatch_sorted_by_task_id() {
    // Tasks added in non-alphabetical order; results must be sorted.
    let runner = SubagentRunner::new(SyncFakeRuntime::all_valid(), "test-model");
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    // Add in reverse alphabetical order.
    orch.add_task(task("z-last", AgentId::Planner), vec![])
        .unwrap();
    orch.add_task(task("a-first", AgentId::Risk), vec![])
        .unwrap();
    orch.add_task(task("m-middle", AgentId::Memory), vec![])
        .unwrap();

    let results = orch.run_ready_once_parallel(false);

    assert_eq!(results.len(), 3);
    assert_eq!(results[0].task_id, "a-first");
    assert_eq!(results[1].task_id, "m-middle");
    assert_eq!(results[2].task_id, "z-last");
}

#[test]
fn parallel_failure_does_not_corrupt_sibling_results() {
    // 3 independent tasks: "b" fails (non-transient), others succeed.
    let runner = SubagentRunner::new(SyncFakeRuntime::with_failures(["b"]), "test-model");
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("a", AgentId::Planner), vec![]).unwrap();
    orch.add_task(task("b", AgentId::Risk), vec![]).unwrap();
    orch.add_task(task("c", AgentId::Memory), vec![]).unwrap();

    let results = orch.run_ready_once_parallel(false);

    assert_eq!(results.len(), 3);
    let a = results.iter().find(|r| r.task_id == "a").unwrap();
    let b = results.iter().find(|r| r.task_id == "b").unwrap();
    let c = results.iter().find(|r| r.task_id == "c").unwrap();

    assert_eq!(a.status, SubagentStatus::Succeeded);
    assert_eq!(b.status, SubagentStatus::Failed);
    assert_eq!(c.status, SubagentStatus::Succeeded);

    // Graph states are consistent.
    assert_eq!(orch.state("a"), Some(&TaskState::Succeeded));
    assert_eq!(orch.state("b"), Some(&TaskState::Failed));
    assert_eq!(orch.state("c"), Some(&TaskState::Succeeded));
}

#[test]
fn parallel_cancel_on_failure_stops_siblings() {
    // 3 independent tasks with cancel_on_failure=true.
    // All succeed, so nothing is cancelled.
    let runner = SubagentRunner::new(SyncFakeRuntime::all_valid(), "test-model");
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("a", AgentId::Planner), vec![]).unwrap();
    orch.add_task(task("b", AgentId::Risk), vec![]).unwrap();
    orch.add_task(task("c", AgentId::Memory), vec![]).unwrap();

    let results = orch.run_ready_once_parallel(true);

    assert_eq!(results.len(), 3);
    assert!(
        results
            .iter()
            .all(|r| r.status == SubagentStatus::Succeeded)
    );
}

// ── Integration: run_until_blocked_parallel ────────────────────────

#[test]
fn run_until_blocked_parallel_respects_dependencies() {
    // a → c, b → c. a and b are independent, c depends on both.
    let runner = SubagentRunner::new(SyncFakeRuntime::all_valid(), "test-model");
    let mut orch = SubagentOrchestrator::new(runner).with_retry_config(fast_retry());
    orch.add_task(task("a", AgentId::Planner), vec![]).unwrap();
    orch.add_task(task("b", AgentId::Risk), vec![]).unwrap();
    orch.add_task(
        task("c", AgentId::Memory),
        vec!["a".to_string(), "b".to_string()],
    )
    .unwrap();

    let results = orch.run_until_blocked_parallel(false);

    assert_eq!(results.len(), 3);
    assert!(
        results
            .iter()
            .all(|r| r.status == SubagentStatus::Succeeded)
    );
    // c should have run after a and b.
    let c = results.iter().find(|r| r.task_id == "c").unwrap();
    assert_eq!(c.status, SubagentStatus::Succeeded);
}
