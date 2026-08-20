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
    let routes = production_source(&root.join("src/gateway_routes.rs"));
    let streams = production_source(&root.join("src/gateway_chat_streams.rs"));

    let owned = [
        "fn enqueue_chat_turn_core(",
        "async fn enqueue_turn(",
        "async fn cancel_turn(",
        "async fn get_turn_events(",
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
    assert!(
        !broker.contains("async fn thread_activity_projection("),
        "legacy /activity handler was retired; use thread_kernel_projection"
    );
    assert!(
        !routes.contains("\"/api/chat/threads/{thread_id}/activity\""),
        "legacy /activity route was retired; use /kernel-projection"
    );

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
        "fn resource_class_label(",
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
fn runtime_flags_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let runtime_flags = production_source(&root.join("src/gateway_runtime_flags.rs"));

    let owned = ["fn verbose_debug("];
    for pattern in owned {
        assert!(
            runtime_flags.contains(pattern),
            "runtime flags owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain runtime flags surface {pattern}"
        );
    }
}

#[test]
fn automation_formatting_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let formatting = production_source(&root.join("src/gateway_automation_formatting.rs"));

    for pattern in [
        "fn scheduled_thread_sender_for_task_id(",
        "fn scheduled_thread_title(",
    ] {
        assert!(
            formatting.contains(pattern),
            "automation formatting owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain automation formatting helper {pattern}"
        );
    }
}

#[test]
fn proactive_thread_planning_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let proactive_threads = production_source(&root.join("src/gateway_proactive_threads.rs"));

    for pattern in [
        "struct ProactiveThreadPlan",
        "fn proactive_thread_plan(",
        "fn proactive_thread_scope(",
    ] {
        assert!(
            proactive_threads.contains(pattern),
            "proactive thread owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain proactive thread planning item {pattern}"
        );
    }
}

#[test]
fn shell_read_only_tasks_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let shell_tasks = production_source(&root.join("src/gateway_shell_tasks.rs"));

    for pattern in [
        "fn redact_json_for_task_output(",
        "fn execute_shell_read_only_task(",
        "fn run_read_only_command(",
    ] {
        assert!(
            shell_tasks.contains(pattern),
            "shell task owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain shell task item {pattern}"
        );
    }
}

#[test]
fn runtime_plan_state_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let plan_state = production_source(&root.join("src/gateway_runtime_plan_state.rs"));

    let owned = [
        "fn plan_steps_reconciled_on_delivery(",
        "fn runtime_plan_thread_key(",
        "fn runtime_plan_control_scope(",
        "fn runtime_plan_memory_text(",
        "fn runtime_plan_memory_metadata(",
        "fn canonical_plan_value(",
        "fn plan_value_from(",
        "fn runtime_execution_plan(",
        "fn execution_plan_steps(",
        "fn merge_execution_plan(",
        "fn runtime_plan_record_from_state(",
        "fn record_runtime_plan_step_outcome_from_state(",
        "fn record_subagent_task_step_outcome(",
        "fn upsert_runtime_plan_memory_from_state(",
        "fn merge_plan(",
        "fn plan_tool_sent(",
        "pub(crate) struct GatewayPlanProgress",
    ];

    for pattern in owned {
        assert!(
            plan_state.contains(pattern),
            "runtime plan state owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain runtime plan state surface {pattern}"
        );
    }
}

#[test]
fn thread_episode_memory_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let episodes = production_source(&root.join("src/gateway_thread_episodes.rs"));

    let owned = [
        "pub(crate) const THREADS_WORKSPACE",
        "fn store_episode(",
        "fn current_thread_episode_block(",
        "fn episode_metadata_matches_scope(",
    ];

    for pattern in owned {
        assert!(
            episodes.contains(pattern),
            "thread episode owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain thread episode memory surface {pattern}"
        );
    }
}

#[test]
fn prompt_packets_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_packets = production_source(&root.join("src/gateway_prompt_packets.rs"));

    let owned = [
        "const MAX_PROJECT_INSTRUCTION_CHARS",
        "fn read_project_instruction(",
        "fn compose_gateway_prompt_packets(",
    ];

    for pattern in owned {
        assert!(
            prompt_packets.contains(pattern),
            "prompt packet owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain prompt packet surface {pattern}"
        );
    }
    for adjacent in [
        "fn current_thread_episode_block(",
        "fn memory_injection_policy(",
        "fn run_agent_rounds(",
    ] {
        assert!(
            !prompt_packets.contains(adjacent),
            "prompt packet owner must not absorb adjacent owner {adjacent}"
        );
    }
}

#[test]
fn brain_runtime_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let brain_runtime = production_source(&root.join("src/gateway_brain_runtime.rs"));

    let owned = [
        "const CAPABLE_MODEL_CONTEXT_WINDOW",
        "struct GatewayBrainMemory",
        "fn brain_materialize_enabled(",
        "fn open_brain_memory(",
        "fn brain_budgets_for_context_window(",
    ];

    for pattern in owned {
        assert!(
            brain_runtime.contains(pattern),
            "brain runtime owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain brain runtime surface {pattern}"
        );
    }
    for adjacent in [
        "fn brain_materialize_tasks(",
        "fn run_agent_rounds(",
        "fn recall_memory(",
    ] {
        assert!(
            !brain_runtime.contains(adjacent),
            "brain runtime owner must not absorb adjacent owner {adjacent}"
        );
    }
}

#[test]
fn brain_materialization_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let materialization = production_source(&root.join("src/gateway_brain_materialization.rs"));

    for pattern in [
        "fn brain_materialize_tasks(",
        "fn link_brain_tasks_to_thread(",
        "fn set_session_progress_total(",
    ] {
        assert!(
            materialization.contains(pattern),
            "brain materialization owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain brain materialization item {pattern}"
        );
    }
}

#[test]
fn context_compactor_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_routing = production_source(&root.join("src/gateway_model_routing.rs"));

    let owned = [
        "struct GatewayContextCompactor",
        "impl local_first_engine::ContextCompactor for GatewayContextCompactor",
    ];

    for pattern in owned {
        assert!(
            model_routing.contains(pattern),
            "model routing owner must contain context compactor surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain context compactor surface {pattern}"
        );
    }
    for adjacent in ["struct GatewayTurnPolicy", "struct GatewayPlanProgress"] {
        assert!(
            !model_routing.contains(adjacent),
            "model routing owner must not absorb adjacent loop port {adjacent}"
        );
    }
}

#[test]
fn turn_policy_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let capability_routing = production_source(&root.join("src/gateway_capability_routing.rs"));

    let owned = [
        "struct GatewayTurnPolicy",
        "impl local_first_engine::TurnPolicy for GatewayTurnPolicy",
    ];

    for pattern in owned {
        assert!(
            capability_routing.contains(pattern),
            "capability routing owner must contain turn policy surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain turn policy surface {pattern}"
        );
    }
    for adjacent in [
        "struct GatewayContextCompactor",
        "struct GatewayTurnCompletionJudge",
    ] {
        assert!(
            !capability_routing.contains(adjacent),
            "capability routing owner must not absorb adjacent loop port {adjacent}"
        );
    }
}

#[test]
fn turn_completion_judge_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_routing = production_source(&root.join("src/gateway_model_routing.rs"));

    let owned = [
        "struct GatewayTurnCompletionJudge",
        "impl local_first_engine::TurnCompletionJudge for GatewayTurnCompletionJudge",
    ];

    for pattern in owned {
        assert!(
            model_routing.contains(pattern),
            "model routing owner must contain turn completion judge surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain turn completion judge surface {pattern}"
        );
    }
    for adjacent in ["struct GatewayTurnPolicy", "struct GatewayPlanProgress"] {
        assert!(
            !model_routing.contains(adjacent),
            "model routing owner must not absorb adjacent loop port {adjacent}"
        );
    }
}

#[test]
fn agent_output_completion_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_routing = production_source(&root.join("src/gateway_model_routing.rs"));

    let owned = ["fn agent_output_incomplete_reason("];

    for pattern in owned {
        assert!(
            model_routing.contains(pattern),
            "model routing owner must contain agent output completion surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent output completion surface {pattern}"
        );
    }
    for adjacent in ["struct GatewayTurnPolicy", "struct GatewayPlanProgress"] {
        assert!(
            !model_routing.contains(adjacent),
            "model routing owner must not absorb adjacent loop port {adjacent}"
        );
    }
}

#[test]
fn role_resolution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_routing = production_source(&root.join("src/gateway_model_routing.rs"));

    let owned = ["fn resolve_role_for_task("];

    for pattern in owned {
        assert!(
            model_routing.contains(pattern),
            "model routing owner must contain role resolution surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain role resolution surface {pattern}"
        );
    }
    for adjacent in [
        "fn build_browser_inference_router(",
        "struct GatewayTurnPolicy",
        "struct GatewayPlanProgress",
    ] {
        assert!(
            !model_routing.contains(adjacent),
            "model routing owner must not absorb adjacent surface {adjacent}"
        );
    }
}

#[test]
fn model_usage_transport_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_routing = production_source(&root.join("src/gateway_model_routing.rs"));

    let owned = [
        "fn inference_locality(",
        "fn inference_provider_id(",
        "async fn recorded_openai_value(",
    ];

    for pattern in owned {
        assert!(
            model_routing.contains(pattern),
            "model routing owner must contain model usage transport surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain model usage transport surface {pattern}"
        );
    }
    for adjacent in [
        "fn build_browser_inference_router(",
        "struct GatewayTurnPolicy",
        "struct GatewayPlanProgress",
    ] {
        assert!(
            !model_routing.contains(adjacent),
            "model routing owner must not absorb adjacent surface {adjacent}"
        );
    }
}

#[test]
fn memory_query_embedding_transport_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let query_embeddings = production_source(&root.join("src/gateway_memory_query_embeddings.rs"));
    let memory_clients = production_source(&root.join("src/gateway_memory_clients.rs"));

    for pattern in [
        "fn embed_model(",
        "fn embed_base(",
        "async fn embed_text(",
        "struct MemoryRecallTiming",
        "fn memory_recall_timing_trace_line(",
        "async fn embed_query_for_memory_recall(",
    ] {
        assert!(
            query_embeddings.contains(pattern),
            "memory query embedding owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory query embedding surface {pattern}"
        );
    }

    assert!(
        memory_clients.contains("async fn backfill_embeddings("),
        "memory client owner must contain embedding backfill orchestration"
    );
    assert!(
        !main.contains("async fn backfill_embeddings("),
        "main.rs must not retain embedding backfill orchestration"
    );

    for adjacent in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn learn_via_service_or_inline(",
    ] {
        assert!(
            !query_embeddings.contains(adjacent),
            "memory query embedding owner must not absorb adjacent memory surface {adjacent}"
        );
        assert!(
            !memory_clients.contains(adjacent),
            "memory client owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn memory_json_transport_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let memory_json = production_source(&root.join("src/gateway_memory_json.rs"));

    for pattern in ["fn strip_json_fences(", "async fn call_memory_json("] {
        assert!(
            memory_json.contains(pattern),
            "memory JSON owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory JSON transport surface {pattern}"
        );
    }

    for adjacent in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn learn_via_service_or_inline(",
        "async fn consolidate_scope(",
    ] {
        assert!(
            !memory_json.contains(adjacent),
            "memory JSON owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn memory_recall_tool_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let memory_recall_tool = production_source(&root.join("src/gateway_memory_recall_tool.rs"));

    for pattern in [
        "struct RecallOutcome",
        "fn recall_stream_payload_from_outcome(",
        "fn recall_memory(",
    ] {
        assert!(
            memory_recall_tool.contains(pattern),
            "memory recall tool owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory recall tool surface {pattern}"
        );
    }

    for adjacent in [
        "fn learn_via_service_or_inline(",
        "async fn consolidate_scope(",
        "fn tombstone_automation_memory_records(",
        "fn record_subagent_task_step_outcome(",
    ] {
        assert!(
            !memory_recall_tool.contains(adjacent),
            "memory recall tool owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn memory_learning_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let memory_learning = production_source(&root.join("src/gateway_memory_learning.rs"));

    for pattern in [
        "fn learn_via_service_or_inline(",
        "async fn consolidate_scope(",
    ] {
        assert!(
            memory_learning.contains(pattern),
            "memory learning owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory learning surface {pattern}"
        );
    }

    for adjacent in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn tombstone_automation_memory_records(",
        "fn record_subagent_task_step_outcome(",
    ] {
        assert!(
            !memory_learning.contains(adjacent),
            "memory learning owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn automation_memory_tombstone_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let automation_routes = production_source(&root.join("src/gateway_automation_routes.rs"));

    let pattern = "fn tombstone_automation_memory_records(";
    assert!(
        automation_routes.contains(pattern),
        "automation routes owner must contain automation memory tombstone helper"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain automation memory tombstone helper"
    );

    for adjacent in [
        "fn learn_via_service_or_inline(",
        "async fn consolidate_scope(",
        "fn record_subagent_task_step_outcome(",
    ] {
        assert!(
            !automation_routes.contains(adjacent),
            "automation routes owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn recall_entry_formatting_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let recall_context = production_source(&root.join("src/gateway_recall_context.rs"));

    let pattern = "fn format_recall_entry(";
    assert!(
        recall_context.contains(pattern),
        "recall context owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain recall entry formatting {pattern}"
    );

    for adjacent in [
        "fn recall_memory(",
        "fn workflow_status_context_for_query(",
        "fn artifact_provenance_context_for_query(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !recall_context.contains(adjacent),
            "recall context owner must not absorb adjacent owner {adjacent}"
        );
    }
}

#[test]
fn memory_prompt_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_context = production_source(&root.join("src/gateway_memory_prompt_context.rs"));

    for pattern in [
        "fn artifact_quality_summary(",
        "fn artifact_provenance_context_for_query(",
        "fn producer_workflow_contract(",
        "fn workflow_status_context_for_query(",
    ] {
        assert!(
            prompt_context.contains(pattern),
            "memory prompt context owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory prompt context {pattern}"
        );
    }

    for adjacent in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn learn_via_service_or_inline(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !prompt_context.contains(adjacent),
            "memory prompt context owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn memory_push_prompt_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_context = production_source(&root.join("src/gateway_memory_prompt_context.rs"));

    for pattern in [
        "fn decisions_for_path(",
        "fn relevant_code_components_for_prompt(",
    ] {
        assert!(
            prompt_context.contains(pattern),
            "memory prompt context owner must contain push prompt context {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory push prompt context {pattern}"
        );
    }

    for adjacent in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn learn_via_service_or_inline(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !prompt_context.contains(adjacent),
            "memory prompt context owner must not absorb adjacent memory surface {adjacent}"
        );
    }
}

#[test]
fn text_safety_helpers_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let text_safety = production_source(&root.join("src/gateway_text_safety.rs"));

    for pattern in [
        "fn truncate_chars(",
        "fn task_goal_summary(",
        "fn compact_redacted_task_goal_summary(",
        "fn redact_sensitive_text(",
        "fn strip_terminal_control_sequences(",
    ] {
        assert!(
            text_safety.contains(pattern),
            "text safety owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain text safety helper {pattern}"
        );
    }

    for adjacent in [
        "fn task_effective_goal(",
        "fn redact_json_for_task_output(",
        "async fn run_agent_rounds(",
        "fn recall_memory(",
    ] {
        assert!(
            !text_safety.contains(adjacent),
            "text safety owner must not absorb adjacent gateway surface {adjacent}"
        );
    }
}

#[test]
fn attachment_prompt_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let attachments = production_source(&root.join("src/attachments.rs"));

    for pattern in [
        "const ATTACHMENT_TEXT_BUDGET_CHARS:",
        "const ATTACHMENT_CONTEXT_IMAGES:",
        "fn append_thread_attachment_context(",
        "fn attachment_text_is_ready(",
    ] {
        assert!(
            attachments.contains(pattern),
            "attachment prompt context owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain attachment prompt context {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "fn recall_memory(",
        "async fn run_agent_rounds(",
        "fn build_prompt_packet(",
    ] {
        assert!(
            !attachments.contains(adjacent),
            "attachment owner must not absorb adjacent owner {adjacent}"
        );
    }
}

#[test]
fn composio_transport_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let composio_routes = production_source(&root.join("src/gateway_composio_routes.rs"));

    let owned = [
        "struct GatewayComposioTransport",
        "impl GatewayComposioTransport",
    ];

    for pattern in owned {
        assert!(
            composio_routes.contains(pattern),
            "Composio route owner must contain transport surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain Composio transport surface {pattern}"
        );
    }
    for adjacent in [
        "fn composio_execute_tool(",
        "fn claim_remote_approval_card(",
        "fn browser_action_requires_payment_grant(",
    ] {
        assert!(
            !composio_routes.contains(adjacent),
            "Composio route owner must not absorb adjacent execution/payment surface {adjacent}"
        );
    }
}

#[test]
fn channel_send_message_tool_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let channels = production_source(&root.join("src/gateway_channels.rs"));
    let composio_routes = production_source(&root.join("src/gateway_composio_routes.rs"));

    let owned = [
        "async fn channel_send_buttons_classified(",
        "fn send_message_tool_schema(",
        "fn execute_send_message(",
    ];

    for pattern in owned {
        assert!(
            channels.contains(pattern),
            "channel owner must contain send_message pseudo-tool surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain send_message pseudo-tool surface {pattern}"
        );
        assert!(
            !composio_routes.contains(pattern),
            "Composio route owner must not absorb channel send_message pseudo-tool surface {pattern}"
        );
    }
}

#[test]
fn composio_execution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let composio_routes = production_source(&root.join("src/gateway_composio_routes.rs"));
    let composio_execution_path = root.join("src/gateway_composio_execution.rs");
    let composio_execution = if composio_execution_path.exists() {
        production_source(&composio_execution_path)
    } else {
        String::new()
    };

    let owned = [
        "fn composio_execute_tool(",
        "struct ComposioExecuteRequest",
        "struct ComposioExecuteResponse",
        "async fn composio_execute(",
    ];

    for pattern in owned {
        assert!(
            composio_execution.contains(pattern),
            "Composio execution owner must contain execute surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain Composio execute surface {pattern}"
        );
        assert!(
            !composio_routes.contains(pattern),
            "Composio connection/catalog owner must not absorb execute surface {pattern}"
        );
    }
    for adjacent in [
        "fn should_claim_payment_approval(",
        "async fn execute_pending_approval(",
        "fn browser_action_requires_payment_grant(",
        "async fn dispatch_remote_approval(",
    ] {
        assert!(
            !composio_execution.contains(adjacent),
            "Composio execution owner must not absorb adjacent payment/remote/browser surface {adjacent}"
        );
    }
}

#[test]
fn composio_confirmation_markers_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let action_confirmations = production_source(&root.join("src/gateway_action_confirmations.rs"));

    let owned = [
        "const COMPOSIO_CONFIRM_OPEN:",
        "const COMPOSIO_CONFIRM_CLOSE:",
        "fn composio_confirm_matches(",
        "fn rewrite_confirm_to_done(",
    ];

    for pattern in owned {
        assert!(
            action_confirmations.contains(pattern),
            "action confirmation owner must contain Composio confirmation surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain Composio confirmation surface {pattern}"
        );
    }
    for adjacent in [
        "fn composio_execute_tool(",
        "fn should_claim_payment_approval(",
        "fn dispatch_remote_approval(",
    ] {
        assert!(
            !action_confirmations.contains(adjacent),
            "action confirmation owner must not absorb adjacent execution/payment surface {adjacent}"
        );
    }
}

#[test]
fn remote_approval_control_helpers_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let remote_approval = production_source(&root.join("src/gateway_remote_approval.rs"));

    let owned = [
        "fn approval_expires_at_secs(",
        "fn create_pending_approval(",
        "fn pending_approval_exists(",
        "fn approval_progress_reply(",
        "fn parse_approval_reply(",
    ];

    for pattern in owned {
        assert!(
            remote_approval.contains(pattern),
            "remote approval owner must contain control helper {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain remote approval control helper {pattern}"
        );
    }
    for adjacent in [
        "async fn execute_pending_approval(",
        "fn composio_execute_tool(",
        "fn should_claim_payment_approval(",
        "fn browser_action_requires_payment_grant(",
    ] {
        assert!(
            !remote_approval.contains(adjacent),
            "remote approval control owner must not absorb adjacent execution/payment/browser surface {adjacent}"
        );
    }
}

#[test]
fn remote_approval_continuation_helpers_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let remote_approval = production_source(&root.join("src/gateway_remote_approval.rs"));

    let owned = [
        "fn approval_action_target(",
        "fn remote_approval_thread_status(",
        "fn append_remote_approval_thread_status(",
        "fn approval_resume_prompt(",
        "fn approval_source_user_text(",
        "fn approval_continuation_visible_text(",
        "fn approval_continuation_turn_input(",
        "fn resume_thread_after_approval(",
    ];

    for pattern in owned {
        assert!(
            remote_approval.contains(pattern),
            "remote approval owner must contain continuation helper {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain remote approval continuation helper {pattern}"
        );
    }
    for adjacent in [
        "enum ActionableSourceResolution",
        "fn claim_actionable_source<",
        "fn resolve_actionable_source<",
        "async fn execute_pending_approval(",
        "fn browser_action_requires_payment_grant(",
    ] {
        assert!(
            !remote_approval.contains(adjacent),
            "remote approval continuation owner must not absorb adjacent actionable/execution/browser surface {adjacent}"
        );
    }
}

#[test]
fn remote_approval_dispatch_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let remote_approval = production_source(&root.join("src/gateway_remote_approval.rs"));

    let owned = [
        "fn remote_approval_effect_request(",
        "async fn dispatch_remote_approval(",
    ];

    for pattern in owned {
        assert!(
            remote_approval.contains(pattern),
            "remote approval owner must contain dispatch surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain remote approval dispatch surface {pattern}"
        );
    }
    for adjacent in [
        "enum ActionableSourceResolution",
        "fn claim_actionable_source<",
        "fn resolve_actionable_source<",
        "async fn execute_pending_approval(",
        "fn composio_execute_tool(",
        "fn should_claim_payment_approval(",
        "fn browser_action_requires_payment_grant(",
    ] {
        assert!(
            !remote_approval.contains(adjacent),
            "remote approval dispatch owner must not absorb adjacent actionable/execution/payment/browser surface {adjacent}"
        );
    }
}

#[test]
fn remote_approval_cancel_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let remote_approval = production_source(&root.join("src/gateway_remote_approval.rs"));

    let owned = ["fn cancel_pending_remote_approval("];

    for pattern in owned {
        assert!(
            remote_approval.contains(pattern),
            "remote approval owner must contain cancellation surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain remote approval cancellation surface {pattern}"
        );
    }
    for adjacent in [
        "enum ActionableSourceResolution",
        "fn claim_actionable_source<",
        "fn resolve_actionable_source<",
        "async fn execute_pending_approval(",
        "fn composio_execute_tool(",
        "fn should_claim_payment_approval(",
        "fn browser_action_requires_payment_grant(",
    ] {
        assert!(
            !remote_approval.contains(adjacent),
            "remote approval cancel owner must not absorb adjacent actionable/execution/payment/browser surface {adjacent}"
        );
    }
}

#[test]
fn remote_approval_execution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let channels = production_source(&root.join("src/gateway_channels.rs"));
    let remote_approval = production_source(&root.join("src/gateway_remote_approval.rs"));
    let execution_path = root.join("src/gateway_remote_approval_execution.rs");
    let remote_approval_execution = if execution_path.exists() {
        production_source(&execution_path)
    } else {
        String::new()
    };

    let owned = ["async fn execute_pending_approval("];

    for pattern in owned {
        assert!(
            remote_approval_execution.contains(pattern),
            "remote approval execution owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain remote approval execution surface {pattern}"
        );
        assert!(
            !channels.contains(pattern),
            "channel owner must call but not own remote approval execution surface {pattern}"
        );
        assert!(
            !remote_approval.contains(pattern),
            "remote approval state owner must not absorb execution surface {pattern}"
        );
    }
    for adjacent in [
        "fn should_claim_payment_approval(",
        "fn claim_payment_approval_for_action(",
        "fn browser_action_requires_payment_grant(",
        "async fn dispatch_remote_approval(",
        "fn create_pending_approval(",
    ] {
        assert!(
            !remote_approval_execution.contains(adjacent),
            "remote approval execution owner must not absorb adjacent control/payment/browser surface {adjacent}"
        );
    }
}

#[test]
fn vault_memory_recall_fallback_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let vault_routes = production_source(&root.join("src/gateway_vault_routes.rs"));

    let owned = [
        "fn recall_memory_response_with_vault_fallback(",
        "fn query_has_sensitive_vault_term(",
        "fn vault_reveal_marker(",
    ];
    for pattern in owned {
        assert!(
            vault_routes.contains(pattern),
            "vault route owner must contain memory recall fallback helper {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory recall fallback helper {pattern}"
        );
    }

    let forbidden_in_vault = [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn memory_facade(",
        "fn run_agent_rounds(",
        "fn apply_payment_approval_secret_for_action(",
        "async fn execute_pending_approval(",
    ];
    for pattern in forbidden_in_vault {
        assert!(
            !vault_routes.contains(pattern),
            "vault route owner must not absorb adjacent owner {pattern}"
        );
    }
}

#[test]
fn payment_approval_claims_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let vault_routes = production_source(&root.join("src/gateway_vault_routes.rs"));
    let browser_tools = production_source(&root.join("src/gateway_browser_tools.rs"));
    let payment_approval_path = root.join("src/gateway_payment_approval.rs");
    let payment_approval = if payment_approval_path.exists() {
        production_source(&payment_approval_path)
    } else {
        String::new()
    };

    let owned = [
        "struct PaymentApprovalGrant",
        "fn apply_payment_approval_secret_for_action(",
        "fn apply_payment_approval_secret_from_map(",
        "fn single_action_rejects_unsupported_execution_before_payment_claim(",
        "fn should_claim_payment_approval(",
        "fn claim_payment_approval_for_action(",
        "fn validate_payment_approval_for_action(",
        "fn validated_payment_approval_id(",
        "fn claim_payment_approval_from_map(",
        "fn prune_expired_payment_approvals(",
        "fn lock_payment_approvals(",
    ];

    for pattern in owned {
        assert!(
            payment_approval.contains(pattern),
            "payment approval owner must contain claim/secret surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain payment approval claim/secret surface {pattern}"
        );
        assert!(
            !vault_routes.contains(pattern),
            "vault route owner must call but not own payment approval claim/secret surface {pattern}"
        );
    }

    for adjacent in [
        "fn payment_approval_marker(",
        "async fn vault_payment_approval_approve(",
        "fn payment_approval_grant_from_request(",
        "fn payment_approval_marker_matches(",
        "fn rewrite_payment_approval_to_done(",
        "fn browser_action_execution_fields_are_schema_legal(",
        "fn browser_action_requires_payment_grant(",
        "async fn execute_pending_approval(",
        "async fn dispatch_remote_approval(",
    ] {
        assert!(
            !payment_approval.contains(adjacent),
            "payment approval owner must not absorb adjacent vault/browser/remote surface {adjacent}"
        );
    }
    assert!(vault_routes.contains("fn payment_approval_grant_from_request("));
    assert!(browser_tools.contains("fn browser_action_execution_fields_are_schema_legal("));
}

#[test]
fn actionable_source_resolution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let actionable_source = production_source(&root.join("src/gateway_actionable_source.rs"));

    let owned = [
        "enum ActionableSourceResolution",
        "fn actionable_source_terminal_text(",
        "fn terminal_actionable_execution_error(",
        "fn claim_actionable_source<",
        "fn resolve_actionable_source<",
    ];

    for pattern in owned {
        assert!(
            actionable_source.contains(pattern),
            "actionable source owner must contain resolution surface {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain actionable source resolution surface {pattern}"
        );
    }
    for adjacent in [
        "async fn execute_pending_approval(",
        "fn composio_execute_tool(",
        "fn should_claim_payment_approval(",
        "fn browser_action_requires_payment_grant(",
        "fn cancel_pending_remote_approval(",
        "async fn dispatch_remote_approval(",
    ] {
        assert!(
            !actionable_source.contains(adjacent),
            "actionable source owner must not absorb adjacent execution/payment/remote/browser surface {adjacent}"
        );
    }
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

#[test]
fn gateway_ownership_documentation_tracks_extracted_kernel_owners() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let doc = production_source(
        &root
            .parent()
            .expect("crates dir")
            .parent()
            .expect("repo root")
            .join("docs/testing/gateway-ownership-contracts.md"),
    );
    let required_patterns = [
        "main.rs",
        "gateway_turn_broker.rs",
        "gateway_task_executor.rs",
        "gateway_routes.rs",
        "gateway_boot_maintenance.rs",
        "gateway_turn_recovery.rs",
        "gateway_background_startup.rs",
        "gateway_chat_streams.rs",
        "gateway_browser_tools.rs",
        "gateway_browser_runtime.rs",
        "gateway_model_routing.rs",
        "gateway_tool_execution.rs",
        "check_gateway_main_contract.py",
        "execution_ownership_inventory.rs",
        "kernel_regression_gate.py",
    ];

    for pattern in required_patterns {
        assert!(
            doc.contains(pattern),
            "gateway ownership documentation must track {pattern}"
        );
    }
}
