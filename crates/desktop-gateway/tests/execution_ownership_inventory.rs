use std::path::Path;

fn production_source(path: &Path) -> String {
    let source = std::fs::read_to_string(path).expect("source file");
    source
        .split("#[cfg(test)]\nmod tests")
        .next()
        .unwrap_or(&source)
        .to_string()
}

#[test]
fn chat_turn_executor_does_not_project_lifecycle_state() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = production_source(&root.join("src/turn_executor.rs"));
    let forbidden = [
        ".update_task_status(",
        ".finish_agent_run(",
        ".set_message_delivery_state(",
        "task.status =",
    ];

    let violations = forbidden
        .into_iter()
        .filter(|pattern| source.contains(pattern))
        .collect::<Vec<_>>();
    assert!(
        violations.is_empty(),
        "chat lifecycle writes belong in execution_projection.rs: {violations:?}"
    );
}

#[test]
fn chat_dispatch_and_legacy_bridge_keep_one_terminal_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let task_executor = production_source(&root.join("src/gateway_task_executor.rs"));
    let worker = task_executor
        .split("fn run_next_task_once")
        .nth(1)
        .expect("task worker")
        .split("fn lease_stolen_task_response")
        .next()
        .expect("task worker end");
    assert!(worker.contains("ExecutionRuntime::new"));
    assert!(worker.contains("execution_runtime.execute("));
    assert!(!worker.contains("execute_chat_turn_task("));

    let runtime = production_source(&root.join("src/execution_runtime.rs"));
    assert!(!runtime.contains("persisted_task_status"));
    assert!(!runtime.contains("TaskStatus::Parked"));
}

#[test]
fn every_gateway_adapter_returns_only_the_canonical_outcome() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let runtime = production_source(&root.join("src/execution_runtime.rs"));
    let production = format!("{main}\n{runtime}");
    let forbidden = [
        "TaskExecutionOutcome",
        "AdapterExecution::legacy",
        "legacy_task_outcome_to_execution_outcome",
        "into_compatibility",
    ];

    let violations = forbidden
        .into_iter()
        .filter(|pattern| production.contains(pattern))
        .collect::<Vec<_>>();
    assert!(
        violations.is_empty(),
        "non-chat adapters still expose a competing lifecycle contract: {violations:?}"
    );
}

#[test]
fn gateway_adapter_trait_does_not_receive_unrestricted_app_state() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let runtime = production_source(&root.join("src/execution_runtime.rs"));
    let adapter_trait = runtime
        .split("pub(crate) trait GatewayExecutionAdapter")
        .nth(1)
        .expect("gateway adapter trait")
        .split("pub(crate) struct ExecutionRuntimeResult")
        .next()
        .expect("gateway adapter trait end");

    assert!(adapter_trait.contains("ExecutionAdapterContext"));
    assert!(
        !adapter_trait.contains("AppState"),
        "adapters must dispatch through the restricted execution context"
    );
}

#[test]
fn execution_adapter_context_does_not_retain_unrestricted_app_state() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let context = production_source(&root.join("src/execution_adapter_context.rs"));

    assert!(
        !context.contains("AppState"),
        "the adapter context must retain only the validated contract and restricted host"
    );
}

#[test]
fn execution_attempt_control_is_not_a_second_persisted_contract() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let control = production_source(&root.join("src/execution_control.rs"));
    let forbidden = [
        "AppState",
        "TaskStore",
        "ExecutionContract",
        "ExecutionOutcome",
        "Serialize",
        "Deserialize",
    ];

    let violations = forbidden
        .into_iter()
        .filter(|pattern| control.contains(pattern))
        .collect::<Vec<_>>();
    assert!(
        violations.is_empty(),
        "attempt control must remain volatile and state-free: {violations:?}"
    );
}

#[test]
fn channel_and_stream_markers_do_not_own_lifecycle() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let channels = production_source(&root.join("src/gateway_channels.rs"));
    let streams = production_source(&root.join("src/gateway_chat_streams.rs"));
    assert!(!main.contains("persist_legacy_hitl_wait_from_parts"));
    assert!(!channels.contains("persist_legacy_hitl_wait_from_parts"));
    assert!(!streams.contains("persist_legacy_hitl_wait_from_parts"));

    let inbound = channels
        .split("async fn handle_channel_inbound")
        .nth(1)
        .expect("channel inbound handler")
        .split("fn contact_handle")
        .next()
        .expect("channel inbound handler end");
    assert!(inbound.contains("enqueue_chat_turn_core"));
    assert!(inbound.contains("TurnApproval::Confirm"));
    assert!(inbound.contains("TurnApproval::ReadOnly"));
    assert!(!inbound.contains("run_agent_turn_into_message("));
    assert!(!inbound.contains("finalize_assistant_message_with_delivery_state"));
}

#[test]
fn turn_broker_surface_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let broker = production_source(&root.join("src/gateway_turn_broker.rs"));
    let streams = production_source(&root.join("src/gateway_chat_streams.rs"));

    let owned = [
        "fn enqueue_chat_turn_core(",
        "async fn enqueue_turn(",
        "async fn cancel_turn(",
        "async fn get_turn_events(",
        "async fn thread_activity_projection(",
        "async fn subscribe_turn_stream(",
        "async fn list_thread_steering(",
        "async fn update_steering(",
        "async fn delete_steering(",
        "async fn send_steering_now(",
    ];
    for pattern in owned {
        assert!(
            broker.contains(pattern),
            "turn broker owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain turn broker surface {pattern}"
        );
    }

    let forbidden_in_broker = [
        "async fn run_agent_rounds(",
        "async fn emit_stream_event(",
        "fn stream_registry(",
        "fn save_chat_message_to_memory(",
        "fn start_task_executor_worker(",
        "fn run_next_task_once(",
        "fn recall_memory(",
    ];
    for pattern in forbidden_in_broker {
        assert!(
            !broker.contains(pattern),
            "turn broker owner must not absorb adjacent owner {pattern}"
        );
    }
    assert!(streams.contains("async fn emit_stream_event("));
}

#[test]
fn task_executor_surface_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let executor = production_source(&root.join("src/gateway_task_executor.rs"));
    let turn_broker = production_source(&root.join("src/gateway_turn_broker.rs"));

    let owned = [
        "struct TaskQueueQuery",
        "async fn task_queue(",
        "async fn task_detail(",
        "async fn cancel_task(",
        "async fn run_next_task(",
        "async fn task_executor_status(",
        "async fn approve_approval(",
        "async fn reject_approval(",
        "fn run_next_task_once(",
        "fn start_task_executor_worker(",
        "enum TaskAcquireResult",
        "fn acquire_task_for_execution(",
        "fn mark_task_completed(",
        "fn mark_task_failed(",
        "fn handle_failed_task_run(",
        "fn request_task_executor_approval(",
        "fn sync_session_for_task_run(",
        "fn append_task_result_to_chat(",
        "fn append_task_progress_checkpoint(",
    ];
    for pattern in owned {
        assert!(
            executor.contains(pattern),
            "task executor owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain task executor surface {pattern}"
        );
    }

    let forbidden_in_executor = [
        "async fn run_agent_rounds(",
        "async fn stream_chat_via_openai(",
        "fn execute_capability_browser_task(",
        "fn execute_capability_generic(",
        "fn execute_persistent_browser_capability(",
        "fn recall_memory(",
        "async fn subscribe_turn_stream(",
    ];
    for pattern in forbidden_in_executor {
        assert!(
            !executor.contains(pattern),
            "task executor owner must not absorb adjacent owner {pattern}"
        );
    }
    assert!(turn_broker.contains("async fn subscribe_turn_stream("));
}

#[test]
fn startup_background_writers_follow_process_fencing() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let background = production_source(&root.join("src/gateway_background_startup.rs"));
    let boot = main
        .find("gateway_boot_maintenance::run_gateway_boot_maintenance(&state);")
        .expect("boot maintenance delegation");
    let recovery = main
        .find("gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;")
        .expect("turn recovery delegation");
    let background_start = main
        .find("gateway_background_startup::start_gateway_background_services(state.clone());")
        .expect("background startup delegation");
    assert!(boot < recovery);
    assert!(recovery < background_start);

    let writers = [
        "sweep_stale_dated_suggestions_once(&st).await",
        "sweep_graph_on_startup(&st)",
        "vacuum_all_stores(&st)",
    ];
    for writer in writers {
        assert!(
            background.contains(writer),
            "startup writer {writer} must stay behind background startup delegation"
        );
        assert!(
            !main.contains(writer),
            "startup writer {writer} must not run inline in main.rs"
        );
    }
}
