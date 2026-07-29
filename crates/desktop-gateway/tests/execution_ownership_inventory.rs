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
    let main = production_source(&root.join("src/main.rs"));
    let worker = main
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
fn channel_and_stream_markers_do_not_own_lifecycle() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    assert!(!main.contains("persist_legacy_hitl_wait_from_parts"));

    let inbound = main
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
