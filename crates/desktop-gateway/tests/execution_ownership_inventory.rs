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
        "fn finalize_turn_steering(",
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
fn visible_turn_start_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let visible_turns = production_source(&root.join("src/gateway_visible_turns.rs"));

    for pattern in [
        "struct VisibleConversationTurn",
        "fn thread_turn_started_event(",
        "fn is_transient_store_error(",
        "fn start_visible_conversation_turn(",
    ] {
        assert!(
            visible_turns.contains(pattern),
            "visible turn owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain visible turn surface {pattern}"
        );
    }

    for adjacent in [
        "fn enqueue_chat_turn_core(",
        "async fn subscribe_turn_stream(",
        "async fn run_agent_turn_into_message(",
        "fn finalize_streamed_assistant_message(",
        "fn execute_proactive_prompt_task(",
    ] {
        assert!(
            !visible_turns.contains(adjacent),
            "visible turn owner must not absorb adjacent turn/stream executor {adjacent}"
        );
    }
}

#[test]
fn thread_model_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let thread_context = production_source(&root.join("src/gateway_thread_model_context.rs"));

    for pattern in [
        "fn context_message_for_model(",
        "fn thread_context_for_model(",
        "fn effective_prompt_context_for_model(",
        "pub(crate) fn model_context_window_for_turn(",
        "fn model_context_window_from_tokens(",
        "pub(crate) struct ChatModelPromptInput",
        "pub(crate) fn prepare_chat_model_prompt(",
        "fn chat_model_prompt_from_effective_context(",
        "fn agent_turn_context(",
    ] {
        assert!(
            thread_context.contains(pattern),
            "thread model context owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain thread model context surface {pattern}"
        );
    }

    for pattern in [
        "match request.thread_id.as_deref()",
        "thread_context_for_model(state, thread_id, &[], Some(request.prompt.as_str()))",
        "None => request.context.clone()",
        "registry_model_capabilities(&base_url, &model)\n        .and_then(|caps| caps.context_length)",
        "build_chat_runtime_prompt(&BuildPromptRequest",
        "local_first_desktop_gateway::render_checkpoint_input",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not choose the effective model context inline {pattern}"
        );
    }
    assert!(
        main.contains("prepare_chat_model_prompt(ChatModelPromptInput"),
        "main.rs should delegate chat model prompt setup to the thread context owner"
    );
    assert!(
        main.contains("model_context_window_for_turn(&base_url, &model)"),
        "main.rs should delegate model context-window resolution to the thread context owner"
    );

    for adjacent in [
        "fn finalize_streamed_assistant_message(",
        "fn start_visible_conversation_turn(",
        "async fn drain_agent_stream_into_message(",
        "fn recall_memory(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !thread_context.contains(adjacent),
            "thread model context owner must not absorb adjacent chat/runtime surface {adjacent}"
        );
    }
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
fn proactive_prompt_execution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let proactive_execution = production_source(&root.join("src/gateway_proactive_execution.rs"));

    for pattern in [
        "fn start_proactive_visible_turn(",
        "fn execute_proactive_prompt_task(",
    ] {
        assert!(
            proactive_execution.contains(pattern),
            "proactive execution owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain proactive execution item {pattern}"
        );
    }

    for adjacent in [
        "fn proactive_thread_plan(",
        "fn start_visible_conversation_turn(",
        "async fn run_agent_turn_into_message_with_fanout(",
        "fn execute_capability_browser_task(",
    ] {
        assert!(
            !proactive_execution.contains(adjacent),
            "proactive execution owner must not absorb adjacent surface {adjacent}"
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
fn capability_execution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let capability_execution_path = root.join("src/gateway_capability_execution.rs");
    let capability_execution = if capability_execution_path.exists() {
        production_source(&capability_execution_path)
    } else {
        String::new()
    };
    let task_executor = production_source(&root.join("src/gateway_task_executor.rs"));

    let owned = [
        "fn execute_capability_generic(",
        "fn authorize_managed_capability_tool(",
        "fn capability_call_completed_outcome(",
        "fn capability_call_failed_outcome(",
        "fn capability_kind_not_wired_outcome(",
        "fn task_execution_outcome_from_executor_result(",
        "fn completed_executor_outcome(",
    ];

    for pattern in owned {
        assert!(
            capability_execution.contains(pattern),
            "capability execution owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain capability execution surface {pattern}"
        );
    }

    for adjacent in [
        "fn execute_capability_browser_task(",
        "fn execute_persistent_browser_capability(",
        "fn run_next_task_once(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !capability_execution.contains(adjacent),
            "capability execution owner must not absorb adjacent surface {adjacent}"
        );
    }
    assert!(
        !task_executor.contains("fn execute_capability_generic("),
        "task executor owner must not absorb capability execution"
    );
}

#[test]
fn subagent_execution_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let subagent_execution_path = root.join("src/gateway_subagent_execution.rs");
    let subagent_execution = if subagent_execution_path.exists() {
        production_source(&subagent_execution_path)
    } else {
        String::new()
    };

    let pattern = "fn execute_subagent_task(";
    assert!(
        subagent_execution.contains(pattern),
        "subagent execution owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain subagent execution surface {pattern}"
    );

    for adjacent in [
        "fn execute_capability_browser_task(",
        "fn execute_capability_generic(",
        "fn execute_proactive_prompt_task(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !subagent_execution.contains(adjacent),
            "subagent execution owner must not absorb adjacent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_outcomes_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let agent_turn_outcomes_path = root.join("src/gateway_agent_turn_outcomes.rs");
    let agent_turn_outcomes = if agent_turn_outcomes_path.exists() {
        production_source(&agent_turn_outcomes_path)
    } else {
        String::new()
    };

    for pattern in [
        "fn apply_agent_recovery_checkpoint(",
        "async fn deliver_image_rejection(",
        "fn delivered_image_rejection_outcome(",
    ] {
        assert!(
            agent_turn_outcomes.contains(pattern),
            "agent turn outcome owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent turn outcome surface {pattern}"
        );
    }

    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds");
    assert!(
        !run_agent_rounds
            .contains("GenerateStreamEvent::Done {\n                text: rejection.clone(),"),
        "run_agent_rounds must delegate image rejection Done delivery to gateway_agent_turn_outcomes"
    );
    assert!(
        !run_agent_rounds.contains("metrics: TokenMetrics::zero(),"),
        "run_agent_rounds must not own image rejection terminal metrics"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "async fn run_agent_turn_into_message(",
        "async fn run_agent_turn_into_message_with_fanout(",
        "fn execute_capability_browser_task(",
    ] {
        assert!(
            !agent_turn_outcomes.contains(adjacent),
            "agent turn outcome owner must not absorb adjacent surface {adjacent}"
        );
    }
}

#[test]
fn skill_prompt_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let skill_runtime = production_source(&root.join("src/gateway_skill_runtime.rs"));

    for pattern in [
        "pub(crate) async fn prepare_skill_prompt_catalog(",
        "pub(crate) struct SkillPromptCatalog",
        "pub(crate) has_skills: bool",
        "fn skill_prompt_instructions_block(",
    ] {
        assert!(
            skill_runtime.contains(pattern),
            "skill runtime owner must contain {pattern}"
        );
    }

    for snippet in ["INSTALLED SKILLS —", "METHODOLOGY (HomunCoder)"] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain skill prompt instruction copy {snippet}"
        );
    }

    for adjacent in [
        "fn use_skill_tool_schema(",
        "fn run_in_sandbox_tool_schema(",
        "fn enabled_skills_summary(",
        "fn homuncoder_skill_ids(",
        "fn skill_prompt_catalog_for_workspace(",
    ] {
        assert!(
            skill_runtime.contains(adjacent),
            "skill prompt owner must stay with skill runtime adjacent helper {adjacent}"
        );
    }

    assert!(
        !main.contains("enabled_skills.retain(|(id, _, _)| !homuncoder.contains(id));"),
        "main.rs must not own HomunCoder prompt skill filtering"
    );
    for snippet in [
        "tokio::task::spawn_blocking(homuncoder_skill_ids)",
        "tokio::task::spawn_blocking(enabled_skills_summary)",
        "skill_prompt_catalog_for_workspace(",
        "let has_skills = !enabled_skills.is_empty();",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must delegate prompt skill catalog loading to gateway_skill_runtime: {snippet}"
        );
    }
}

#[test]
fn memory_prompt_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    let owned = [
        "fn memory_recall_usage_instruction(",
        "fn memory_scope_restricted_instruction(",
    ];
    for pattern in owned {
        assert!(
            prompt_instructions.contains(pattern),
            "prompt instruction owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain memory prompt instruction surface {pattern}"
        );
    }

    for snippet in [
        "MEMORY: you have a long-term memory of the user",
        "RECALL-BEFORE-ASKING:",
        "SENSITIVE VAULT:",
        "MEMORY SCOPE FOR THIS OBJECTIVE:",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain memory prompt instruction copy {snippet}"
        );
    }

    for adjacent in [
        "fn operational_plan_instruction(",
        "fn browser_open_research_discovery_instruction(",
        "fn booking_assumption_choice_instruction(",
    ] {
        assert!(
            prompt_instructions.contains(adjacent),
            "memory prompt owner must stay with prompt instruction adjacent helper {adjacent}"
        );
    }
}

#[test]
fn chat_mode_prompt_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    for pattern in [
        "fn plan_mode_instruction(",
        "fn ask_mode_instruction(",
        "fn debug_mode_instruction(",
    ] {
        assert!(
            prompt_instructions.contains(pattern),
            "prompt instruction owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain chat mode prompt instruction surface {pattern}"
        );
    }

    for snippet in [
        "PLAN MODE (chosen by the user):",
        "ASK MODE (chosen by the user):",
        "DEBUG MODE (chosen by the user):",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain chat mode prompt instruction copy {snippet}"
        );
    }

    for adjacent in [
        "fn operational_plan_instruction(",
        "fn memory_recall_usage_instruction(",
        "fn memory_scope_restricted_instruction(",
    ] {
        assert!(
            prompt_instructions.contains(adjacent),
            "chat mode prompt owner must stay with prompt instruction adjacent helper {adjacent}"
        );
    }
}

#[test]
fn language_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    let pattern = "fn language_follow_user_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "prompt instruction owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain language prompt instruction surface {pattern}"
    );

    for snippet in [
        "LANGUAGE: ALWAYS write",
        "SAME language as the user's latest message",
        "step-by-step narration",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain language prompt instruction copy {snippet}"
        );
    }

    for adjacent in [
        "fn operational_plan_instruction(",
        "fn memory_recall_usage_instruction(",
        "fn plan_mode_instruction(",
    ] {
        assert!(
            prompt_instructions.contains(adjacent),
            "language prompt owner must stay with prompt instruction adjacent helper {adjacent}"
        );
    }
}

#[test]
fn code_map_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    let pattern = "fn code_map_available_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "prompt instruction owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain code-map prompt instruction surface {pattern}"
    );

    for snippet in [
        "CODE MAP: this project has an indexed code map",
        "code STRUCTURE or DEPENDENCIES",
        "query_code_graph` FIRST",
        "Do NOT grep/list files",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain code-map prompt instruction copy {snippet}"
        );
    }

    assert!(
        prompt_instructions.contains("fn operational_plan_instruction("),
        "code-map prompt owner must stay with prompt instruction helpers"
    );
}

#[test]
fn code_map_presence_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_context = production_source(&root.join("src/gateway_memory_prompt_context.rs"));

    assert!(
        prompt_context.contains("fn project_has_code_map("),
        "code-map presence read-model must live with memory prompt context helpers"
    );
    assert!(
        !main.contains("let has_code_map ="),
        "main.rs must delegate the scoped runtime decision to append the code-map instruction"
    );
    assert!(
        !main.contains(
            "list_entities_for_ui(&gateway_memory_user_id(), &gateway_memory_workspace_id())"
        ),
        "main.rs must not query memory entities directly to detect code-map presence"
    );
}

#[test]
fn chat_code_map_prompt_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let owner = production_source(&root.join("src/gateway_chat_code_map_prompt.rs"));

    assert!(
        main.contains("mod gateway_chat_code_map_prompt;"),
        "gateway root must declare chat code-map prompt owner"
    );
    assert!(
        main.contains("pub(crate) use gateway_chat_code_map_prompt::*;"),
        "gateway root must re-export chat code-map prompt owner"
    );

    for snippet in [
        "pub(crate) struct ChatCodeMapPromptInput",
        "pub(crate) async fn append_chat_code_map_prompt_instruction(",
        "project_has_code_map(&st)",
        "code_map_available_instruction()",
    ] {
        assert!(
            owner.contains(snippet),
            "chat code-map prompt owner must contain {snippet}"
        );
    }

    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai");
    for snippet in [
        "let has_code_map =",
        "project_has_code_map(&st)",
        "code_map_available_instruction()",
    ] {
        assert!(
            !stream_chat.contains(snippet),
            "stream_chat_via_openai must delegate code-map prompt composition {snippet}"
        );
    }

    for adjacent in [
        "fn project_has_code_map(",
        "pub(crate) fn code_map_available_instruction(",
        "pub(crate) async fn prepare_chat_toolset(",
        "async fn run_agent_rounds(",
        "fn query_code_graph(",
        "fn execute_capability_browser_task(",
    ] {
        assert!(
            !owner.contains(adjacent),
            "chat code-map prompt owner must not absorb adjacent memory/prompt/toolset/loop/search/browser surface {adjacent}"
        );
    }
}

#[test]
fn chat_connected_prompt_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let owner = production_source(&root.join("src/gateway_chat_connected_prompt.rs"));

    assert!(
        main.contains("mod gateway_chat_connected_prompt;"),
        "gateway root must declare chat connected prompt owner"
    );
    assert!(
        main.contains("pub(crate) use gateway_chat_connected_prompt::*;"),
        "gateway root must re-export chat connected prompt owner"
    );

    for snippet in [
        "pub(crate) struct ChatConnectedPromptInput",
        "pub(crate) struct ChatConnectedPrompt",
        "pub(crate) fn append_chat_connected_prompt_instructions(",
        "connected_service_tools_instruction()",
        "expired_connected_services_instruction(&inactive_services.join(\", \"))",
    ] {
        assert!(
            owner.contains(snippet),
            "chat connected prompt owner must contain {snippet}"
        );
    }

    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai");
    for snippet in [
        "connected_service_tools_instruction()",
        "expired_connected_services_instruction(",
        "let inactive_services = connected_tool_catalog.inactive_services;",
    ] {
        assert!(
            !stream_chat.contains(snippet),
            "stream_chat_via_openai must delegate connected prompt composition {snippet}"
        );
    }

    for adjacent in [
        "pub(crate) async fn prepare_connected_tool_catalog(",
        "pub(crate) async fn prepare_chat_toolset(",
        "fn connected_tool_catalog_from_sources(",
        "pub(crate) fn connected_service_tools_instruction(",
        "pub(crate) fn expired_connected_services_instruction(",
        "async fn run_agent_rounds(",
        "fn execute_capability_browser_task(",
    ] {
        assert!(
            !owner.contains(adjacent),
            "chat connected prompt owner must not absorb adjacent toolset, prompt wording, loop or browser surface {adjacent}"
        );
    }
}

#[test]
fn chat_prompt_layers_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let owner = production_source(&root.join("src/gateway_chat_prompt_layers.rs"));

    assert!(
        main.contains("mod gateway_chat_prompt_layers;"),
        "main.rs must declare chat prompt layers owner"
    );
    assert!(
        main.contains("pub(crate) use gateway_chat_prompt_layers::*;"),
        "main.rs must re-export chat prompt layers owner"
    );

    for snippet in [
        "pub(crate) struct ChatPromptLayersInput",
        "pub(crate) fn append_chat_prompt_layers(",
        "contact_context_instruction_block(",
        "skill_prompt_instructions_block(",
        "choice_clarify_instruction()",
        "booking_assumption_choice_instruction()",
        "artifact_destination_prompt_block(",
    ] {
        assert!(
            owner.contains(snippet),
            "chat prompt layers owner must compose runtime prompt layer {snippet}"
        );
    }

    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// ADR 0024 inc 5")
        .next()
        .expect("stream_chat_via_openai end");
    for snippet in [
        "if let Some(cx) = &contact_ctx",
        "skill_prompt_instructions_block(&enabled_skills",
        "choice_clarify_instruction()",
        "format!(\"{system}\\n{booking_choices}\")",
        "artifact_destination_prompt_block(&artifact_destinations)",
    ] {
        assert!(
            !stream_chat.contains(snippet),
            "stream_chat_via_openai must delegate prompt layer composition {snippet}"
        );
    }

    for adjacent in [
        "pub(crate) fn skill_prompt_catalog_for_workspace(",
        "pub(crate) fn contact_context_instruction_block(",
        "pub(crate) fn artifact_destination_prompt_block(",
        "pub(crate) async fn prepare_chat_toolset(",
        "async fn run_agent_rounds(",
        "fn execute_capability_browser_task(",
    ] {
        assert!(
            !owner.contains(adjacent),
            "chat prompt layers owner must not absorb adjacent owner surface {adjacent}"
        );
    }
}

#[test]
fn execution_verification_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    let pattern = "fn execution_verification_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "prompt instruction owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain execution verification prompt instruction surface {pattern}"
    );

    for snippet in [
        "EXECUTION / VERIFICATION: when you produce CODE",
        "VERIFY BY EXECUTING",
        "Trust the compiler and the tests",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain execution verification prompt instruction copy {snippet}"
        );
    }

    assert!(
        prompt_instructions.contains("fn operational_plan_instruction("),
        "execution verification prompt owner must stay with prompt instruction helpers"
    );
}

#[test]
fn freshness_verification_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    let pattern = "fn freshness_verification_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "prompt instruction owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain freshness prompt instruction surface {pattern}"
    );

    for snippet in [
        "FRESHNESS / VERIFICATION: your internal knowledge may be dated",
        "OFFICIAL documentation or recent sources",
        "If you can't verify, say so openly",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain freshness prompt instruction copy {snippet}"
        );
    }

    assert!(
        prompt_instructions.contains("fn execution_verification_instruction("),
        "freshness prompt owner must stay with prompt instruction helpers"
    );
}

#[test]
fn choice_clarify_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    let pattern = "fn choice_clarify_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "prompt instruction owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain choice/clarify prompt instruction surface {pattern}"
    );

    for snippet in [
        "CHOICES: when you ask the user to choose among discrete OPTIONS",
        "CLARIFY: when you need FREE-TEXT details from the user",
        "without the marker the harness cannot",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain choice/clarify prompt instruction copy {snippet}"
        );
    }

    assert!(
        prompt_instructions.contains("fn booking_assumption_choice_instruction("),
        "choice/clarify prompt owner must stay with prompt instruction helpers"
    );
}

#[test]
fn core_operating_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));
    let stream_body = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream chat function")
        .split("async fn run_agent_rounds(")
        .next()
        .expect("stream chat function end");

    let pattern = "fn core_operating_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "prompt instruction owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain core operating prompt instruction surface {pattern}"
    );

    for snippet in [
        "You are the local assistant acting as ORCHESTRATOR",
        "METHOD (applies to any request, not just travel)",
        "TOOLS AND ROUTING: when a request can be satisfied by a tool",
        "USER'S COMPUTER FILES AND FOLDERS",
        "AUTOMATIONS: for RECURRING or REACTIVE requests",
        "RESPONSE FORMATTING (markdown, always)",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain core operating prompt instruction copy {snippet}"
        );
    }

    assert!(
        prompt_instructions.contains("pub(crate) struct ChatCoreOperatingPromptInput"),
        "prompt instruction owner must expose chat core operating prompt input"
    );
    assert!(
        prompt_instructions.contains("pub(crate) fn prepare_chat_core_operating_prompt("),
        "prompt instruction owner must expose chat core operating prompt assembly"
    );
    assert!(
        stream_body.contains("prepare_chat_core_operating_prompt(ChatCoreOperatingPromptInput"),
        "gateway root must delegate chat core operating prompt assembly"
    );
    for snippet in [
        "now_block()",
        "std::env::var(\"HOME\")",
        "response_language_instruction(&effective_user_language())",
        "core_operating_instruction(&now, &home, browser_discovery, &language_instruction)",
    ] {
        assert!(
            !stream_body.contains(snippet),
            "main.rs must not retain core operating prompt bootstrap {snippet}"
        );
    }
    assert!(
        prompt_instructions.contains("fn browser_open_research_discovery_instruction("),
        "core operating prompt owner must stay with prompt instruction helpers"
    );
    assert!(
        prompt_instructions.contains("now_block()"),
        "prompt instruction owner must resolve the runtime date/time value"
    );
    assert!(
        prompt_instructions.contains("effective_user_language()"),
        "prompt instruction owner must resolve the runtime language selection"
    );
}

#[test]
fn connected_service_prompt_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let connected_prompt = production_source(&root.join("src/gateway_chat_connected_prompt.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    for pattern in [
        "fn connected_service_tools_instruction(",
        "fn expired_connected_services_instruction(",
    ] {
        assert!(
            prompt_instructions.contains(pattern),
            "prompt instruction owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain connected-service prompt instruction surface {pattern}"
        );
    }

    for snippet in [
        "CONNECTED-SERVICE TOOLS: the user has connected some services",
        "TOOL CHOICE: use ONE SINGLE tool",
        "WRITE ACTIONS (send/delete/modify)",
        "COUNTS (e.g. \"how many unread emails\")",
        "CONNECTED BUT EXPIRED SERVICES (slug)",
        "‹‹COMPOSIO_RECONNECT››<slug>‹‹/COMPOSIO_RECONNECT››",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain connected-service prompt instruction copy {snippet}"
        );
    }

    assert!(
        connected_prompt.contains("let has_composio = !catalog_index.is_empty();"),
        "chat connected prompt owner must own the runtime decision to append connected-service guidance"
    );
    assert!(
        connected_prompt.contains("inactive_services"),
        "chat connected prompt owner must own the runtime inactive-service list"
    );
    assert!(
        !main.contains("let inactive_services = connected_tool_catalog.inactive_services;"),
        "main.rs must delegate the runtime inactive-service list"
    );
}

#[test]
fn artifact_destination_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));
    let artifacts = production_source(&root.join("src/gateway_artifacts.rs"));

    let pattern = "fn destination_folders_instruction(";
    let block_pattern = "fn artifact_destination_prompt_block(";
    assert!(
        prompt_instructions.contains(pattern),
        "artifact destination prompt rendering must live in gateway_prompt_instructions"
    );
    assert!(
        prompt_instructions.contains(block_pattern),
        "artifact destination prompt block assembly must live in gateway_prompt_instructions"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain artifact destination prompt instruction surface {pattern}"
    );
    assert!(
        !main.contains("map(|d| d.label.as_str())"),
        "main.rs must not assemble artifact destination labels inline"
    );

    for snippet in [
        "DESTINATION FOLDERS: you can deliver generated files",
        "AUTHORIZED by the user with the `save_artifact` tool",
        "call save_artifact(file, destination)",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain artifact destination prompt contract text {snippet}"
        );
    }

    assert!(
        artifacts.contains("pub(crate) fn prepare_chat_artifact_destinations("),
        "artifact owner must expose chat-scoped artifact destination lookup"
    );
    assert!(
        artifacts.contains("load_artifact_destinations()"),
        "artifact owner must retain raw artifact destination loading"
    );
    assert!(
        !main.contains("load_artifact_destinations()"),
        "main.rs must delegate raw artifact destination lookup to gateway_artifacts"
    );
}

#[test]
fn goal_propose_prompt_instruction_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));
    let workspace_prompt =
        production_source(&root.join("src/gateway_chat_workspace_prompt_context.rs"));

    let pattern = "fn goal_propose_instruction(";
    assert!(
        prompt_instructions.contains(pattern),
        "project goal-propose prompt rendering must live in gateway_prompt_instructions"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain goal-propose prompt instruction surface {pattern}"
    );

    for snippet in [
        "If you ARTICULATE or PROPOSE the OBJECTIVE",
        "‹‹GOAL_PROPOSE››",
        "1-3 SHORT objectives looking FORWARD",
        "Use it ONLY for real project objectives",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain goal-propose prompt contract text {snippet}"
        );
    }

    assert!(
        !main.contains("ws.as_str() != PERSONAL_WORKSPACE"),
        "main.rs still owns the runtime workspace decision to append goal-propose guidance"
    );
    assert!(
        workspace_prompt.contains("ws.as_str() != PERSONAL_WORKSPACE"),
        "chat workspace prompt context owner must decide when to append goal-propose guidance"
    );
}

#[test]
fn objective_contract_prompt_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    for pattern in [
        "fn objective_contract_instruction(",
        "fn objective_contract_read_only_default_instruction(",
    ] {
        assert!(
            prompt_instructions.contains(pattern),
            "prompt instruction owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain objective prompt instruction surface {pattern}"
        );
    }

    for snippet in [
        "OBJECTIVE CONTRACT (canonical, harness-enforced)",
        "OBJECTIVE CONTRACT: none recorded for this task",
        "Plan completion requires recorded evidence",
        "execution defaults to READ-ONLY analysis",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not retain objective prompt instruction copy {snippet}"
        );
    }

    assert!(
        main.contains("objective_contract: active_objective_contract.as_ref()"),
        "main.rs must pass the projected objective contract to runtime prompt control"
    );
}

#[test]
fn chat_objective_execution_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let tool_execution = production_source(&root.join("src/gateway_tool_execution.rs"));
    let memory_briefing = production_source(&root.join("src/gateway_memory_briefing.rs"));
    let setup = main
        .split("let prompt_core =")
        .nth(1)
        .expect("prompt core setup")
        .split("let contact_memory_perimeter =")
        .next()
        .expect("objective execution setup");

    for pattern in [
        "pub(crate) struct ChatObjectiveExecutionContextInput",
        "pub(crate) struct ChatObjectiveExecutionContext",
        "pub(crate) fn prepare_chat_objective_execution_context(",
    ] {
        assert!(
            tool_execution.contains(pattern),
            "tool execution owner must contain chat objective execution context surface {pattern}"
        );
    }
    assert!(
        memory_briefing.contains("pub(crate) fn memory_intent_context_for_semantic_contract("),
        "memory briefing owner must expose typed memory intent context projection"
    );
    assert!(
        setup.contains(
            "prepare_chat_objective_execution_context(ChatObjectiveExecutionContextInput"
        ),
        "main.rs must delegate chat objective execution context assembly"
    );

    for pattern in [
        "objective_contract_for_execution(state, request.thread_id.as_deref())",
        "semantic_decision::ObjectiveEffectPolicy::from_contract(",
        "catalog_index.retain(|(name, _, _)|",
        "objective_blocks_tool(&objective_effect_policy",
        ".unwrap_or_else(semantic_decision::MemoryIntent::safe_default)",
        "memory_intent_allows_recall(&memory_intent)",
        "memory_injection_policy(&memory_intent)",
    ] {
        assert!(
            !setup.contains(pattern),
            "main.rs must not assemble chat objective execution context inline {pattern}"
        );
    }
}

#[test]
fn gateway_time_has_one_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let gateway_time_path = root.join("src/gateway_time.rs");
    let gateway_time = if gateway_time_path.exists() {
        production_source(&gateway_time_path)
    } else {
        String::new()
    };

    let pattern = "fn now_epoch_secs(";
    assert!(
        gateway_time.contains(pattern),
        "gateway time owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain shared time surface {pattern}"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !gateway_time.contains(adjacent),
            "gateway time owner must not absorb adjacent surface {adjacent}"
        );
    }
}

#[test]
fn hitl_wait_persistence_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let hitl_waits_path = root.join("src/gateway_hitl_waits.rs");
    let hitl_waits = if hitl_waits_path.exists() {
        production_source(&hitl_waits_path)
    } else {
        String::new()
    };

    let owned = [
        "fn persist_hitl_wait_from_outcome(",
        "fn persist_hitl_wait_payload(",
    ];

    for pattern in owned {
        assert!(
            hitl_waits.contains(pattern),
            "HITL wait owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain HITL wait persistence surface {pattern}"
        );
    }

    for adjacent in [
        "async fn drain_agent_stream_into_message(",
        "fn execute_persistent_browser_capability(",
        "fn thread_browser_session_is_live(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !hitl_waits.contains(adjacent),
            "HITL wait owner must not absorb adjacent surface {adjacent}"
        );
    }
}

#[test]
fn runtime_plan_state_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let plan_state = production_source(&root.join("src/gateway_runtime_plan_state.rs"));
    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds")
        .split("// Vision fallback")
        .next()
        .expect("run_agent_rounds seam construction");

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
        "pub(crate) fn gateway_plan_progress(",
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
    assert!(
        !run_agent_rounds.contains("GatewayPlanProgress {"),
        "run_agent_rounds must not construct GatewayPlanProgress inline"
    );
    assert!(
        !run_agent_rounds.contains("GatewayPlanProgress::new("),
        "run_agent_rounds must not construct GatewayPlanProgress directly"
    );
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
fn agent_checkpoint_preflight_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let checkpoints = production_source(&root.join("src/gateway_agent_checkpoints.rs"));

    for pattern in [
        "pub(crate) fn validate_agent_checkpoint_request(",
        "local_first_desktop_gateway::checkpoint_request_applies_new_input(",
        "fn invalid_agent_checkpoint_error(",
    ] {
        assert!(
            checkpoints.contains(pattern),
            "agent checkpoint owner must contain {pattern}"
        );
    }

    for pattern in [
        "local_first_desktop_gateway::checkpoint_request_applies_new_input(",
        "code: \"agent_checkpoint_invalid\",",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent checkpoint preflight {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "fn apply_agent_recovery_checkpoint(",
        "fn execute_capability_browser_task(",
    ] {
        assert!(
            !checkpoints.contains(adjacent),
            "agent checkpoint owner must not absorb adjacent owner {adjacent}"
        );
    }
}

#[test]
fn privacy_guard_preflight_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let preflight = production_source(&root.join("src/gateway_privacy_preflight.rs"));

    for pattern in [
        "pub(crate) struct ChatPrivacyGuardPreflightInput",
        "pub(crate) fn chat_privacy_orchestrator_is_local(",
        "pub(crate) async fn evaluate_chat_privacy_guard_preflight(",
        "pub(crate) async fn evaluate_privacy_guard_preflight(",
        "gateway_model_routing::provider_endpoint_is_local(",
        "gateway_model_routing::model_id_is_cloud(",
        "PrivacyGuardPreflightOutcome::EarlyResponse",
        "privacy_guard::failure_policy(",
        "privacy_guard::build_privacy_guard_intercept(",
        "privacy_guard_unavailable",
    ] {
        assert!(
            preflight.contains(pattern),
            "privacy preflight owner must contain {pattern}"
        );
    }

    for pattern in [
        "let privacy_prompt = if applies_new_input",
        "privacy_guard::classify_sensitive_input_deterministic(",
        "classify_sensitive_input_with_privacy_guard_model(",
        "privacy_guard::failure_policy(",
        "privacy_guard::build_privacy_guard_intercept(",
        "privacy_guard_unavailable",
        "let orchestrator_is_local = provider_endpoint_is_local(&base_url) && !model_id_is_cloud(&model);",
        "provider_endpoint_is_local(&base_url) && !model_id_is_cloud(&model)",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain privacy guard preflight decision {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "fn execute_capability_browser_task(",
        "fn apply_agent_recovery_checkpoint(",
    ] {
        assert!(
            !preflight.contains(adjacent),
            "privacy preflight owner must not absorb adjacent owner {adjacent}"
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
    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds")
        .split("// Vision fallback")
        .next()
        .expect("run_agent_rounds seam construction");
    let context_compactor_surface = model_routing
        .split("pub(crate) struct GatewayContextCompactor")
        .nth(1)
        .expect("context compactor owner")
        .split("impl local_first_engine::ContextCompactor for GatewayContextCompactor")
        .next()
        .expect("context compactor constructor section");

    let owned = [
        "struct GatewayContextCompactor",
        "pub(crate) fn gateway_context_compactor(",
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
    let pattern = "pub(crate) fn gateway_context_compactor(";
    assert!(
        context_compactor_surface.contains(pattern),
        "context compactor owner must expose constructor surface {pattern}"
    );
    assert!(
        !run_agent_rounds.contains("GatewayContextCompactor {"),
        "run_agent_rounds must not construct GatewayContextCompactor inline"
    );
    assert!(
        !run_agent_rounds.contains("GatewayContextCompactor::new("),
        "run_agent_rounds must not construct GatewayContextCompactor directly"
    );
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
        "pub(crate) fn gateway_turn_policy(",
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
    assert!(
        !main.contains("GatewayTurnPolicy::new("),
        "main.rs must not construct GatewayTurnPolicy directly"
    );
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
        "pub(crate) fn gateway_turn_completion_judge(",
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
    assert!(
        !main.contains("GatewayTurnCompletionJudge::new("),
        "main.rs must not construct GatewayTurnCompletionJudge directly"
    );
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
fn memory_recall_scoring_has_one_crate_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let recall = production_source(&root.join("../memory/src/recall.rs"));

    for pattern in [
        "pub struct MemoryCandidate",
        "pub fn hybrid_memory_score(",
        "pub fn memory_age_days(",
    ] {
        assert!(
            recall.contains(pattern),
            "memory crate recall owner must contain {pattern}"
        );
    }

    for duplicate in [
        "struct MemoryCandidate",
        "fn hybrid_memory_score(",
        "fn memory_age_days(",
    ] {
        assert!(
            !main.contains(duplicate),
            "main.rs must not retain duplicate memory recall scoring {duplicate}"
        );
    }
}

#[test]
fn stream_memory_reuse_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let memory_reuse = production_source(&root.join("src/gateway_memory_reuse.rs"));

    for pattern in [
        "fn memory_reuse_envelope_from_read_set(",
        "struct StreamMemoryReuseCollector",
        "fn observe_line(",
        "fn observe_remote_approval(",
        "fn observe_actionable_cards(",
        "fn envelope(",
    ] {
        assert!(
            memory_reuse.contains(pattern),
            "stream memory reuse owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain stream memory reuse surface {pattern}"
        );
    }

    for adjacent in [
        "fn finalize_streamed_assistant_message(",
        "fn persist_hitl_wait_from_outcome(",
        "fn drain_agent_stream_into_message(",
        "fn actionable_cards_from_raw_text(",
        "fn remote_approval_event_part(",
    ] {
        assert!(
            !memory_reuse.contains(adjacent),
            "stream memory reuse owner must not absorb adjacent stream/action owner {adjacent}"
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
fn memory_ui_access_request_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let memory_ui = production_source(&root.join("src/gateway_memory_ui_routes.rs"));

    let pattern = "fn gateway_memory_access_request(";
    assert!(
        memory_ui.contains(pattern),
        "memory UI routes owner must contain dashboard access request helper"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain memory UI access request helper"
    );

    for adjacent in [
        "fn memorybench_",
        "fn record_decision(",
        "fn rebuild_status_wiki(",
    ] {
        assert!(
            !memory_ui.contains(adjacent),
            "memory UI routes owner must not absorb adjacent memory surface {adjacent}"
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
fn task_input_helpers_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let task_inputs = production_source(&root.join("src/gateway_task_inputs.rs"));

    assert!(
        task_inputs.contains("fn task_effective_goal("),
        "task input owner must contain task_effective_goal"
    );
    assert!(
        !main.contains("fn task_effective_goal("),
        "main.rs must not retain task_effective_goal"
    );

    for adjacent in [
        "fn browser_targets_for_goal(",
        "fn browser_url_for_goal(",
        "async fn run_agent_rounds(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !task_inputs.contains(adjacent),
            "task input owner must not absorb adjacent execution/browser surface {adjacent}"
        );
    }
}

#[test]
fn attachment_prompt_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let attachments = production_source(&root.join("src/attachments.rs"));

    for pattern in [
        "pub(crate) struct ChatAttachmentWorkingSetInput",
        "pub(crate) async fn prepare_chat_attachment_working_set(",
        "const ATTACHMENT_TEXT_BUDGET_CHARS:",
        "const ATTACHMENT_CONTEXT_IMAGES:",
        "fn append_thread_attachment_context(",
        "pub(crate) struct ChatAttachmentUserContentInput",
        "pub(crate) fn prepare_chat_attachment_user_content(",
        "fn attachment_user_content(",
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

    assert!(
        main.contains("attachments::prepare_chat_attachment_user_content("),
        "main.rs should delegate chat attachment user-content assembly to attachments"
    );
    assert!(
        main.contains("attachments::prepare_chat_attachment_working_set("),
        "main.rs should delegate chat attachment ingestion/persistence/working-set assembly to attachments"
    );
    for snippet in [
        "attachments::ingest_each(",
        "let mut working: Vec<chat_store::StoredAttachment>",
        "store.upsert_thread_attachment(",
        "store.thread_attachments(",
        "let new_attachment_context =",
        "let user_content = if all_images.is_empty()",
        "serde_json::json!({ \"type\": \"image_url\"",
    ] {
        assert!(
            !main.contains(snippet),
            "main.rs must not rebuild attachment user content inline: {snippet}"
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
fn gateway_process_bootstrap_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let process_bootstrap = production_source(&root.join("src/gateway_process_bootstrap.rs"));

    for pattern in [
        "pub(crate) fn install_gateway_process_bootstrap()",
        "tracing_subscriber::fmt()",
        "panic_log::install(",
        "libc::umask(",
        "gateway_legacy_data::migrate_legacy_data_dir();",
    ] {
        assert!(
            process_bootstrap.contains(pattern),
            "gateway process bootstrap owner must contain {pattern}"
        );
    }

    let main_fn = main
        .split("async fn main()")
        .nth(1)
        .expect("main function")
        .split("let recovered_stores")
        .next()
        .expect("store integrity boundary");
    assert!(
        main_fn.contains("gateway_process_bootstrap::install_gateway_process_bootstrap();"),
        "main.rs must delegate process bootstrap before opening stores"
    );
    for pattern in [
        "tracing_subscriber::fmt()",
        "panic_log::install(",
        "libc::umask(",
        "gateway_legacy_data::migrate_legacy_data_dir();",
    ] {
        assert!(
            !main_fn.contains(pattern),
            "main.rs must not retain process bootstrap surface {pattern}"
        );
    }

    for adjacent in [
        "pub(crate) struct AppState",
        "gateway_store_integrity::ensure_gateway_store_integrity()",
        "gateway_db_unify::unify_legacy_databases_at_startup()",
        "gateway_routes::build_gateway_router(",
        "gateway_background_startup::start_gateway_background_services(",
        "TcpListener::bind(",
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
    ] {
        assert!(
            !process_bootstrap.contains(adjacent),
            "gateway process bootstrap owner must not absorb adjacent startup/runtime surface {adjacent}"
        );
    }
}

#[test]
fn agent_wake_mapping_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let agent_wake = production_source(&root.join("src/gateway_agent_wake.rs"));

    let pattern = "fn wake_for_agent_stop(";
    assert!(
        agent_wake.contains(pattern),
        "agent wake owner must contain {pattern}"
    );
    assert!(
        !main.contains(pattern),
        "main.rs must not retain agent wake mapping surface {pattern}"
    );

    for adjacent in [
        "async fn drain_agent_stream_into_message(",
        "fn finalize_streamed_assistant_message(",
        "fn persist_hitl_wait_from_outcome(",
        "fn persist_hitl_wait_payload(",
        "fn apply_agent_stream_line(",
        "fn turn_event_from_stream_value(",
        "fn thread_browser_session_is_live(",
    ] {
        assert!(
            !agent_wake.contains(adjacent),
            "agent wake owner must not absorb adjacent stream/HITL/browser surface {adjacent}"
        );
    }
}

#[test]
fn agent_stream_events_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let stream_events = production_source(&root.join("src/gateway_agent_stream_events.rs"));

    for pattern in [
        "fn apply_agent_stream_line(",
        "fn turn_event_from_stream_value(",
        "fn redacted_user_text_from_stream_line(",
    ] {
        assert!(
            stream_events.contains(pattern),
            "agent stream events owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent stream event surface {pattern}"
        );
    }

    for adjacent in [
        "async fn drain_agent_stream_into_message(",
        "fn finalize_streamed_assistant_message(",
        "fn persist_hitl_wait_from_outcome(",
        "fn persist_hitl_wait_payload(",
        "fn persist_recall_event_part(",
        "fn persist_redacted_user_text_from_stream_line(",
        "fn fanout_turn_event(",
        "fn thread_browser_session_is_live(",
    ] {
        assert!(
            !stream_events.contains(adjacent),
            "agent stream events owner must not absorb adjacent drain/persistence/browser surface {adjacent}"
        );
    }
}

#[test]
fn agent_stream_persistence_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let stream_persistence =
        production_source(&root.join("src/gateway_agent_stream_persistence.rs"));

    for pattern in [
        "fn update_channel_assistant_message(",
        "fn finalize_streamed_assistant_message(",
        "fn persist_recall_event_part(",
        "fn persist_redacted_user_text_from_stream_line(",
        "fn fanout_turn_event(",
    ] {
        assert!(
            stream_persistence.contains(pattern),
            "agent stream persistence owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent stream persistence surface {pattern}"
        );
    }

    for adjacent in [
        "async fn drain_agent_stream_into_message(",
        "async fn drain_agent_stream_into_message_with_fanout(",
        "fn persist_hitl_wait_from_outcome(",
        "fn persist_hitl_wait_payload(",
        "fn thread_browser_session_is_live(",
        "fn execute_persistent_browser_capability(",
    ] {
        assert!(
            !stream_persistence.contains(adjacent),
            "agent stream persistence owner must not absorb adjacent drain/HITL/browser surface {adjacent}"
        );
    }
}

#[test]
fn agent_stream_drain_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let stream_drain = production_source(&root.join("src/gateway_agent_stream_drain.rs"));

    for pattern in [
        "async fn drain_agent_stream_into_message(",
        "async fn drain_agent_stream_into_message_with_fanout(",
    ] {
        assert!(
            stream_drain.contains(pattern),
            "agent stream drain owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent stream drain surface {pattern}"
        );
    }

    for adjacent in [
        "fn apply_agent_stream_line(",
        "fn turn_event_from_stream_value(",
        "fn redacted_user_text_from_stream_line(",
        "fn update_channel_assistant_message(",
        "fn finalize_streamed_assistant_message(",
        "fn persist_hitl_wait_from_outcome(",
        "fn persist_hitl_wait_payload(",
        "fn thread_browser_session_is_live(",
        "fn execute_persistent_browser_capability(",
    ] {
        assert!(
            !stream_drain.contains(adjacent),
            "agent stream drain owner must not absorb adjacent event/persistence/HITL/browser surface {adjacent}"
        );
    }
}

#[test]
fn agent_stream_request_ids_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let chat_streams = production_source(&root.join("src/gateway_chat_streams.rs"));

    for pattern in [
        "fn agent_turn_stream_request_id(",
        "fn broker_turn_stream_request_id(",
    ] {
        assert!(
            chat_streams.contains(pattern),
            "chat streams owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent stream request-id surface {pattern}"
        );
    }
    assert!(
        !main.contains("format!(\"broker-{turn_id}\")"),
        "main.rs must not inline broker stream request-id formatting"
    );
}

#[test]
fn chat_stream_transport_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let chat_streams = production_source(&root.join("src/gateway_chat_streams.rs"));

    for pattern in [
        "struct ChatStreamTransport",
        "fn open_chat_stream_transport(",
        "fn chat_streaming_http_client(",
        "fn chat_stream_response(",
        "tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32)",
        "tokio::sync::broadcast::channel::<String>(512)",
        ".http1_only()",
        ".pool_max_idle_per_host(0)",
        "StreamEntry {",
        "stream_registry().lock()",
        "Body::from_stream(futures_util::stream::unfold(",
        "\"content-type\", \"application/x-ndjson\"",
        "\"x-effective-model\"",
    ] {
        assert!(
            chat_streams.contains(pattern),
            "chat stream transport owner must contain {pattern}"
        );
    }

    for pattern in [
        "tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32)",
        "tokio::sync::broadcast::channel::<String>(512)",
        "StreamEntry {",
        "Body::from_stream(futures_util::stream::unfold(rx",
        "\"content-type\", \"application/x-ndjson\"",
        "reqwest::Client::builder()\n        .http1_only()",
        ".pool_max_idle_per_host(0)",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not own chat stream transport setup/response {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn prepare_chat_toolset(",
        "pub(crate) fn apply_chat_tool_perimeter(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !chat_streams.contains(adjacent),
            "chat stream transport owner must not absorb adjacent chat/tool/browser/subagent owner {adjacent}"
        );
    }
}

#[test]
fn agent_turn_execution_identity_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let identity = production_source(&root.join("src/gateway_agent_turn_identity.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// Thread this chat belongs to:")
        .next()
        .expect("agent turn identity setup");

    for pattern in [
        "pub(crate) struct AgentTurnExecutionIdentity",
        "pub(crate) fn resolve_agent_turn_execution_identity(",
        "agent_journal::for_run(agent_run_id)",
        "request_id.strip_prefix(\"broker-\")",
        "canonical_broker_turn",
    ] {
        assert!(
            identity.contains(pattern),
            "agent turn identity owner must contain {pattern}"
        );
    }

    for pattern in [
        "agent_journal::for_run(request.agent_run_id.as_deref())",
        "let effect_run_id = request.agent_run_id.clone();",
        ".strip_prefix(\"broker-\")",
        "let canonical_broker_turn = effect_turn_id.is_some();",
    ] {
        assert!(
            !stream_chat.contains(pattern) && !main.contains(pattern),
            "main.rs must not own agent turn execution identity {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "GatewayBrowserExecutor {",
    ] {
        assert!(
            !identity.contains(adjacent),
            "agent turn identity owner must not absorb adjacent stream/loop/tail/browser surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_sensitive_confirmations_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let sensitive = production_source(&root.join("src/gateway_agent_turn_sensitive.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// Last upstream model error this turn")
        .next()
        .expect("agent turn sensitive setup");

    for pattern in [
        "pub(crate) fn seed_agent_turn_sensitive_confirmations(",
        "resolved_skill_confirmations(state, thread_id)",
        "merged_sensitive(&existing, &project_sensitive)",
        "crate::skills::SensitiveCategory::parse",
        "cat.as_token().to_string()",
    ] {
        assert!(
            sensitive.contains(pattern),
            "agent turn sensitive owner must contain {pattern}"
        );
    }

    for pattern in [
        ".active_sensitive\n                .iter()",
        "resolved_skill_confirmations(&state_owned, thread_id.as_deref())",
        "merged_sensitive(&existing, &project_sensitive)",
        "cat.as_token().to_string()",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn sensitive confirmation seeding {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !sensitive.contains(adjacent),
            "agent turn sensitive owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_route_trace_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let route_trace = production_source(&root.join("src/gateway_agent_turn_route_trace.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// No-progress guard:")
        .next()
        .expect("agent turn route trace setup");

    for pattern in [
        "pub(crate) async fn publish_agent_turn_route_trace(",
        "pub(crate) fn agent_turn_route_trace_activity_text(",
        "capability_route_trace_line(route)",
        "loop_state.tool_trace.push(route_line.clone())",
        "GenerateStreamEvent::Delta",
        "format!(\"‹‹ACT››🧭 {route_line}‹‹/ACT››\")",
    ] {
        assert!(
            route_trace.contains(pattern),
            "agent turn route trace owner must contain {pattern}"
        );
    }

    for pattern in [
        "capability_route_trace_line(&capability_route_for_runtime)",
        "ls.tool_trace.push(route_line.clone())",
        "format!(\"‹‹ACT››🧭 {route_line}‹‹/ACT››\")",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn route trace publication {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !route_trace.contains(adjacent),
            "agent turn route trace owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_recall_seed_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let recall_seed = production_source(&root.join("src/gateway_agent_turn_recall_seed.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// Last upstream model error this turn")
        .next()
        .expect("agent turn recall seed setup");

    for pattern in [
        "pub(crate) async fn seed_agent_turn_recall(",
        "seed_loop_memory_reads(loop_state, payload.as_ref())",
        "GenerateStreamEvent::Recall",
        "applies_new_input && let Some(payload) = payload",
    ] {
        assert!(
            recall_seed.contains(pattern),
            "agent turn recall seed owner must contain {pattern}"
        );
    }

    for pattern in [
        "seed_loop_memory_reads(&mut ls, automatic_recall_payload.as_ref())",
        "GenerateStreamEvent::Recall { payload }",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn recall seeding/publication {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !recall_seed.contains(adjacent),
            "agent turn recall seed owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_plan_seed_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let plan_seed = production_source(&root.join("src/gateway_agent_turn_plan_seed.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// Tools offered to the model this run:")
        .next()
        .expect("agent turn plan seed setup");

    for pattern in [
        "pub(crate) struct AgentTurnPlanSeed",
        "pub(crate) fn seed_agent_turn_plan_state(",
        "loop_state.plan = canonical_plan_value(resume_goal, resume_plan)",
        "loop_state.step_messages_start = loop_state.messages.len()",
        "final_done: false",
        "plan_nudges: 0",
        "turn_used_tools: false",
    ] {
        assert!(
            plan_seed.contains(pattern),
            "agent turn plan seed owner must contain {pattern}"
        );
    }

    for pattern in [
        "ls.plan = canonical_plan_value(resume_goal.as_deref(), &resume_plan)",
        "let final_done = false;",
        "let plan_nudges: u32 = 0;",
        "let turn_used_tools = false;",
        "ls.step_messages_start = ls.messages.len();",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn plan seed state {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !plan_seed.contains(adjacent),
            "agent turn plan seed owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_tool_seed_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let tool_seed = production_source(&root.join("src/gateway_agent_turn_tool_seed.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// Turn-local browser state now lives in the browser subsystem")
        .next()
        .expect("agent turn tool seed setup");

    for pattern in [
        "pub(crate) fn seed_agent_turn_tool_schemas(",
        "turn_policy: &ChatTurnPolicy,",
        "loop_state.tool_schemas = base_tools",
        "if turn_policy.mode == \"ask\"",
        "loop_state.tool_schemas.clear()",
        "apply_chat_tool_perimeter(ChatToolPerimeterInput",
        "tool_schemas: &mut loop_state.tool_schemas",
    ] {
        assert!(
            tool_seed.contains(pattern),
            "agent turn tool seed owner must contain {pattern}"
        );
    }

    for pattern in [
        "ls.tool_schemas = base_tools",
        "if mode == \"ask\"",
        "ls.tool_schemas.clear()",
        "apply_chat_tool_perimeter(ChatToolPerimeterInput",
        "tool_schemas: &mut ls.tool_schemas",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn tool schema seeding {pattern}"
        );
    }
    assert!(
        stream_chat.contains("seed_agent_turn_tool_schemas(&mut ls, base_tools, &turn_policy,"),
        "main.rs must pass typed ChatTurnPolicy into agent turn tool seed owner"
    );
    assert!(
        !stream_chat.contains("seed_agent_turn_tool_schemas(&mut ls, base_tools, &mode,"),
        "main.rs must not pass scalar mode into agent turn tool seed owner"
    );
    assert!(
        !stream_chat.contains("let mode = turn_policy.mode.clone();"),
        "main.rs must not retain a scalar mode clone after typed policy handoff"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn prepare_chat_toolset(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !tool_seed.contains(adjacent),
            "agent turn tool seed owner must not absorb adjacent stream/toolset/loop/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_recovery_seed_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let recovery_seed = production_source(&root.join("src/gateway_agent_turn_recovery_seed.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// 5.D1c.1: resolve the loop's turn-constant config ONCE")
        .next()
        .expect("agent turn recovery seed setup");

    for pattern in [
        "pub(crate) fn seed_agent_turn_recovery_checkpoint(",
        "let checkpoint_input = if checkpoint_input_present",
        "loop_state.messages.last().cloned()",
        "gateway_agent_turn_outcomes::apply_agent_recovery_checkpoint(",
    ] {
        assert!(
            recovery_seed.contains(pattern),
            "agent turn recovery seed owner must contain {pattern}"
        );
    }

    for pattern in [
        "let checkpoint_input = request",
        "gateway_agent_turn_outcomes::apply_agent_recovery_checkpoint(\n            &mut ls,\n            recovery_checkpoint,\n            checkpoint_input,",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn recovery checkpoint seeding {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !recovery_seed.contains(adjacent),
            "agent turn recovery seed owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_model_seed_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_seed = production_source(&root.join("src/gateway_agent_turn_model_seed.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("seed_agent_turn_recovery_checkpoint(")
        .next()
        .expect("agent turn model seed setup");

    for pattern in [
        "pub(crate) async fn seed_agent_turn_model_provider(",
        "warm_turn_provider_capabilities(http, &base_url, &model).await",
        "loop_state.provider = crate::model_client::gateway_provider_binding(",
    ] {
        assert!(
            model_seed.contains(pattern),
            "agent turn model seed owner must contain {pattern}"
        );
    }

    for pattern in [
        "warm_turn_provider_capabilities(&http, &base_url, &model).await",
        "ls.provider = crate::model_client::gateway_provider_binding(model, base_url, api_key)",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn model provider seeding {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !model_seed.contains(adjacent),
            "agent turn model seed owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_config_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let config_owner = production_source(&root.join("src/gateway_agent_turn_config.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("let tail_state = state_owned.clone();")
        .next()
        .expect("agent turn config setup");

    for pattern in [
        "pub(crate) struct AgentTurnConfigInput",
        "pub(crate) fn resolve_agent_turn_config(",
        "local_first_engine::TurnConfig {",
        "hard_round_ceiling: hard_round_ceiling()",
        "forced_tool: input.forced_tool",
        "resolved_hitl: input.resolved_hitl",
    ] {
        assert!(
            config_owner.contains(pattern),
            "agent turn config owner must contain {pattern}"
        );
    }

    for pattern in [
        "let cfg = local_first_engine::TurnConfig {",
        "hard_round_ceiling: hard_round_ceiling(),",
        "reconcile_on_delivery: plan_reconcile_on_delivery_enabled(),",
        "resolved_hitl: hitl_choice_resume.as_ref().map(|ctx| {",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn config construction {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "GatewayBrowserExecutor {",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !config_owner.contains(adjacent),
            "agent turn config owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_hitl_resume_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let hitl_resume_owner = production_source(&root.join("src/gateway_agent_turn_hitl_resume.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("let cfg = resolve_agent_turn_config(")
        .next()
        .expect("agent turn HITL resume setup");

    for pattern in [
        "pub(crate) fn resolved_hitl_guard_for_turn(",
        "local_first_engine::hitl::ResolvedHitlGuard",
        "local_first_engine::hitl::HitlEnvelope",
        "hitl_resume::HitlWaitKind::Choice",
        "source_marker: \"durable_resume\".to_string()",
    ] {
        assert!(
            hitl_resume_owner.contains(pattern),
            "agent turn HITL resume owner must contain {pattern}"
        );
    }

    for pattern in [
        "local_first_engine::hitl::ResolvedHitlGuard {",
        "source_marker: \"durable_resume\".to_string(),",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own engine HITL resume projection {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "GatewayBrowserExecutor {",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !hitl_resume_owner.contains(adjacent),
            "agent turn HITL resume owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_loop_seed_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let loop_seed_owner = production_source(&root.join("src/gateway_agent_turn_loop_seed.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("seed_agent_turn_recall(")
        .next()
        .expect("agent turn loop seed setup");

    for pattern in [
        "pub(crate) struct AgentTurnLoopSeed",
        "pub(crate) fn prepare_agent_turn_initial_messages(",
        "pub(crate) fn seed_agent_turn_loop_state(",
        "pub(crate) fn reset_agent_turn_terminal_buffer(",
        "serde_json::json!({ \"role\": \"system\", \"content\": system })",
        "serde_json::json!({ \"role\": \"user\", \"content\": user_content })",
        "local_first_engine::LoopState::new()",
        "loop_state.prompt_packets = prompt_packets",
        "loop_state.messages = messages",
        "last_model_error: None",
        "memory_answer: String::new()",
        "browse_sources: Vec::new()",
        "sandbox_clear(thread_id)",
    ] {
        assert!(
            loop_seed_owner.contains(pattern),
            "agent turn loop seed owner must contain {pattern}"
        );
    }

    for pattern in [
        "let mut ls = local_first_engine::LoopState::new();",
        "ls.prompt_packets = prompt_packets;",
        "ls.messages = messages;",
        "let last_model_error: Option<String> = None;",
        "let memory_answer = String::new();",
        "let browse_sources: Vec<String> = Vec::new();",
        "sandbox_clear(thread_id.clone());",
        "let mut messages = vec![\n        serde_json::json!({ \"role\": \"system\", \"content\": system }),\n        serde_json::json!({ \"role\": \"user\", \"content\": user_content }),\n    ];",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn loop seed state {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "GatewayBrowserExecutor {",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !loop_seed_owner.contains(adjacent),
            "agent turn loop seed owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_trace_dump_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let trace_dump_owner = production_source(&root.join("src/gateway_agent_turn_trace_dump.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("let outcome = run_agent_rounds(")
        .next()
        .expect("agent turn trace dump setup");

    for pattern in [
        "pub(crate) fn resolve_agent_turn_trace_dump_dir(",
        "local_first_engine::trace::dump_enabled()",
        ".then(gateway_logs_dir)",
        ".and_then(Result::ok)",
    ] {
        assert!(
            trace_dump_owner.contains(pattern),
            "agent turn trace dump owner must contain {pattern}"
        );
    }

    for pattern in [
        "local_first_engine::trace::dump_enabled()\n            .then(gateway_logs_dir)",
        ".then(gateway_logs_dir)\n            .and_then(Result::ok)",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own agent turn trace dump dir resolution {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "GatewayBrowserExecutor {",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !trace_dump_owner.contains(adjacent),
            "agent turn trace dump owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn chat_turn_start_trace_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let turn_trace_owner = production_source(&root.join("src/gateway_turn_trace.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("let capability_router_instruction =")
        .next()
        .expect("chat turn start trace setup");

    for pattern in [
        "pub(crate) struct ChatTurnStartTraceInput",
        "pub(crate) turn_policy: &'a ChatTurnPolicy,",
        "pub(crate) struct ChatTurnTraceInput",
        "pub(crate) fn begin_chat_turn_trace(",
        "pub(crate) fn record_chat_turn_start_trace(",
        "turn_trace_enabled()",
        "gateway_logs_dir()",
        "turn_trace_max_bytes()",
        "TurnEvent::TurnStart",
        "tier_for_model(input.model)",
    ] {
        assert!(
            turn_trace_owner.contains(pattern),
            "turn trace owner must contain {pattern}"
        );
    }

    for pattern in [
        "TurnTraceEntry {",
        "turn_trace_enabled()",
        "gateway_logs_dir()",
        "turn_trace_max_bytes()",
        "TurnEvent::TurnStart",
        "prompt_head: request.prompt.chars()",
        "load_provider_registry().tier_for_model(&model)",
        "let turn_tier =",
        "tier: turn_tier.as_str()",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not own chat turn start trace field mapping {pattern}"
        );
    }
    assert!(
        stream_chat.contains("turn_policy: &turn_policy,"),
        "main.rs must pass typed ChatTurnPolicy into turn start trace owner"
    );
    assert!(
        !stream_chat.contains("mode: mode.as_str(),"),
        "main.rs must not pass scalar mode into turn start trace owner"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "GatewayBrowserExecutor {",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !turn_trace_owner.contains(adjacent),
            "turn trace owner must not absorb adjacent stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn chat_usage_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let usage_runtime = production_source(&root.join("src/gateway_usage_runtime.rs"));

    for pattern in [
        "fn chat_response_usage_context(",
        "UsageContext::new(",
        "InferencePurpose::ChatResponse",
        "usage_context.workspace_id",
        "usage_context.thread_id",
        "usage_context.turn_id",
        "usage_context.run_id",
    ] {
        assert!(
            usage_runtime.contains(pattern),
            "usage runtime owner must contain chat usage context surface {pattern}"
        );
    }

    for pattern in [
        "let mut usage_context = local_first_inference_usage::UsageContext::new(",
        "local_first_inference_usage::InferencePurpose::ChatResponse",
        "usage_context.workspace_id",
        "usage_context.thread_id",
        "usage_context.turn_id",
        "usage_context.run_id",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not own chat usage context surface {pattern}"
        );
    }

    for adjacent in [
        "async fn run_agent_rounds(",
        "GatewayCapabilityExecutor {",
        "GatewayBrowserExecutor {",
        "GatewayPlanProgress {",
        "GatewayTurnCompletionJudge::new(",
        "local_first_engine::agent_loop::run_turn(",
    ] {
        assert!(
            !usage_runtime.contains(adjacent),
            "usage runtime owner must not absorb adjacent agent loop surface {adjacent}"
        );
    }
}

#[test]
fn model_steering_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_client = production_source(&root.join("src/model_client.rs"));
    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds")
        .split("let usage_context = chat_response_usage_context(")
        .next()
        .expect("model client seam construction");

    for pattern in [
        "pub(crate) struct GatewayModelClient",
        "pub(crate) fn gateway_model_client<'a>(",
        "pub(crate) struct GatewaySteeringContext",
        "pub(crate) fn gateway_steering_context",
        "effect_run_id.unwrap_or(turn_id)",
        "thread_id.map(",
        "turn_id.map(",
    ] {
        assert!(
            model_client.contains(pattern),
            "model client owner must contain steering context surface {pattern}"
        );
    }

    for pattern in [
        "crate::model_client::GatewaySteeringContext {",
        "let steering_context = match (thread_id.as_deref(), effect_turn_id.as_deref())",
        "run_id: effect_run_id.as_deref().unwrap_or(turn_id)",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not own model steering context construction {pattern}"
        );
    }
    assert!(
        !run_agent_rounds.contains("crate::model_client::GatewayModelClient {"),
        "run_agent_rounds must not construct GatewayModelClient inline"
    );
    assert!(
        !run_agent_rounds.contains("crate::model_client::GatewayModelClient::new("),
        "run_agent_rounds must not call GatewayModelClient constructor directly"
    );

    for adjacent in [
        "async fn run_agent_rounds(",
        "GatewayCapabilityExecutor {",
        "GatewayBrowserExecutor {",
        "GatewayPlanProgress {",
        "GatewayTurnCompletionJudge::new(",
        "local_first_engine::agent_loop::run_turn(",
    ] {
        assert!(
            !model_client.contains(adjacent),
            "model client steering owner must not absorb adjacent agent loop surface {adjacent}"
        );
    }
}

#[test]
fn model_provider_binding_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_client = production_source(&root.join("src/model_client.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("let checkpoint_input = request")
        .next()
        .expect("provider binding construction");

    for pattern in [
        "pub(crate) fn gateway_provider_binding(",
        "ProviderBinding {",
        "model,",
        "base_url,",
        "api_key,",
    ] {
        assert!(
            model_client.contains(pattern),
            "model client owner must contain provider binding construction surface {pattern}"
        );
    }

    assert!(
        !stream_chat.contains("local_first_engine::ProviderBinding {"),
        "stream_chat_via_openai must not construct ProviderBinding inline"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "GatewayCapabilityExecutor {",
        "GatewayBrowserExecutor {",
        "GatewayPlanProgress::new(",
        "GatewayTurnCompletionJudge::new(",
    ] {
        assert!(
            !model_client.contains(adjacent),
            "model client provider owner must not absorb adjacent agent loop surface {adjacent}"
        );
    }
}

#[test]
fn model_provider_capability_warm_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let model_routing = production_source(&root.join("src/gateway_model_routing.rs"));
    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("// The concrete model seam")
        .next()
        .expect("provider capability warm construction");

    for pattern in [
        "pub(crate) async fn warm_turn_provider_capabilities(",
        "if is_ollama_base(base_url)",
        "warm_ollama_capabilities(http, base_url, model).await",
    ] {
        assert!(
            model_routing.contains(pattern),
            "model routing owner must contain provider capability warm surface {pattern}"
        );
    }

    for pattern in [
        "if is_ollama_base(&base_url)",
        "warm_ollama_capabilities(&http, &base_url, &model).await",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "stream_chat_via_openai must not own provider capability warm logic {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "GatewayCapabilityExecutor {",
        "GatewayBrowserExecutor {",
        "GatewayPlanProgress::new(",
        "GatewayTurnCompletionJudge::new(",
    ] {
        assert!(
            !model_routing.contains(adjacent),
            "model routing capability warm owner must not absorb adjacent agent loop surface {adjacent}"
        );
    }
}

#[test]
fn workflow_routing_plan_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let capability_routing = production_source(&root.join("src/gateway_capability_routing.rs"));
    let stream_setup = main
        .split("let prompt_workspace =")
        .nth(1)
        .expect("prompt workspace setup")
        .split("let turn_policy =")
        .next()
        .expect("turn policy setup");

    for pattern in [
        "pub(crate) struct ChatWorkflowRoutingPlanInput",
        "pub(crate) struct ChatWorkflowRoutingPlan",
        "pub(crate) fn resolve_chat_workflow_routing_plan(",
        "route_capability_with_binding(input.semantic_contract,",
        "thread_user_message_count_fail_open(input.state, input.thread_id)",
    ] {
        assert!(
            capability_routing.contains(pattern),
            "capability routing owner must contain workflow routing plan surface {pattern}"
        );
    }

    for pattern in [
        "active_routing_binding(state, request.thread_id.as_deref())",
        "route_capability_with_binding(semantic_contract.as_ref(), routing_binding.as_ref())",
        "workflow_route_from_capability(&capability_route)",
        ".and_then(resolve_workflow_routing)",
        "thread_user_message_count_fail_open(state, request.thread_id.as_deref())",
    ] {
        assert!(
            !stream_setup.contains(pattern),
            "main.rs must not assemble workflow routing plan inline {pattern}"
        );
    }
}

#[test]
fn tool_effect_contract_lookup_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let tool_execution = production_source(&root.join("src/gateway_tool_execution.rs"));
    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds")
        .split("// Vision fallback")
        .next()
        .expect("run_agent_rounds seam construction");

    for pattern in [
        "pub(crate) fn load_turn_effect_contract(",
        ".execution(execution_id)",
        ".map(|record| record.contract)",
    ] {
        assert!(
            tool_execution.contains(pattern),
            "tool execution owner must contain effect-contract lookup surface {pattern}"
        );
    }

    for pattern in [
        "let effect_contract = effect_turn_id.as_deref().and_then(|execution_id|",
        ".task_store\n            .lock()",
        ".execution(execution_id)",
        ".map(|record| record.contract)",
    ] {
        assert!(
            !run_agent_rounds.contains(pattern),
            "run_agent_rounds must not own effect-contract lookup surface {pattern}"
        );
    }

    for adjacent in [
        "async fn run_agent_rounds(",
        "GatewayPlanProgress {",
        "GatewayContextCompactor {",
        "GatewayTurnCompletionJudge::new(",
    ] {
        assert!(
            !tool_execution.contains(adjacent),
            "tool execution effect-contract owner must not absorb adjacent loop/model surface {adjacent}"
        );
    }
}

#[test]
fn capability_executor_constructor_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let tool_execution = production_source(&root.join("src/gateway_tool_execution.rs"));
    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds")
        .split("// The browser tool chokepoint")
        .next()
        .expect("capability executor seam construction");

    for pattern in [
        "pub(crate) struct GatewayCapabilityExecutorInput",
        "pub(crate) turn_policy: &'a ChatTurnPolicy,",
        "pub(crate) contact_memory_perimeter: ContactMemoryPerimeter,",
        "pub(crate) struct GatewayCapabilityExecutor",
        "pub(crate) fn gateway_capability_executor<'a>(",
    ] {
        assert!(
            tool_execution.contains(pattern),
            "tool execution owner must contain capability executor constructor surface {pattern}"
        );
    }
    let capability_executor_input = tool_execution
        .split("pub(crate) struct GatewayCapabilityExecutorInput")
        .nth(1)
        .expect("GatewayCapabilityExecutorInput")
        .split("/// The gateway's `CapabilityExecutor`")
        .next()
        .expect("GatewayCapabilityExecutorInput block");
    assert!(
        !capability_executor_input.contains("pub(crate) read_only: bool,"),
        "capability executor input must receive typed ChatTurnPolicy, not scalar read_only"
    );
    assert!(
        !capability_executor_input.contains("pub(crate) autonomous: bool,"),
        "capability executor input must receive typed ChatTurnPolicy, not scalar autonomous"
    );
    for pattern in [
        "pub(crate) contact_only: bool,",
        "pub(crate) can_see_contacts: bool,",
        "pub(crate) can_see_calendar: bool,",
        "pub(crate) can_use_project_memory: bool,",
    ] {
        assert!(
            !capability_executor_input.contains(pattern),
            "capability executor input must receive typed ContactMemoryPerimeter, not scalar perimeter {pattern}"
        );
    }
    assert!(
        run_agent_rounds.contains("turn_policy,"),
        "run_agent_rounds must pass the typed chat turn policy into capability executor"
    );
    assert!(
        run_agent_rounds.contains("contact_memory_perimeter,"),
        "run_agent_rounds must pass the typed contact memory perimeter into capability executor"
    );
    for pattern in [
        "read_only: turn_policy.read_only,",
        "autonomous: turn_policy.autonomous,",
        "contact_only: contact_memory_perimeter.contact_only,",
        "can_see_contacts: contact_memory_perimeter.can_see_contacts,",
        "can_see_calendar: contact_memory_perimeter.can_see_calendar,",
        "can_use_project_memory: contact_memory_perimeter.can_use_project_memory,",
    ] {
        assert!(
            !run_agent_rounds.contains(pattern),
            "run_agent_rounds must not pass scalar turn context into capability executor {pattern}"
        );
    }

    assert!(
        !run_agent_rounds.contains("let capability_executor = GatewayCapabilityExecutor {"),
        "run_agent_rounds must not construct GatewayCapabilityExecutor inline"
    );
    assert!(
        !run_agent_rounds.contains("GatewayCapabilityExecutor::new("),
        "run_agent_rounds must not call GatewayCapabilityExecutor constructor directly"
    );

    for adjacent in [
        "GatewayPlanProgress::new(",
        "GatewayContextCompactor::new(",
        "GatewayTurnCompletionJudge::new(",
    ] {
        assert!(
            !tool_execution.contains(adjacent),
            "tool execution capability executor owner must not absorb adjacent loop/browser surface {adjacent}"
        );
    }
}

#[test]
fn agent_turn_tail_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let turn_tail = production_source(&root.join("src/gateway_agent_turn_tail.rs"));

    for pattern in [
        "pub(crate) async fn complete_agent_turn_tail(",
        "struct AgentTurnTailInput",
        "turn_policy: &'a ChatTurnPolicy,",
        "struct AgentTurnTailContext",
        "struct AgentTurnTailSnapshot",
        "pub(crate) fn prepare_agent_turn_tail_context(",
        "pub(crate) fn snapshot_agent_turn_tail(",
        "memory_reuse_envelope_from_read_set(",
        "spawn_project_graph_refresh(",
        "finalize_turn_steering(",
        "publish_stream_outcome(",
        "schedule_stream_registry_cleanup(",
    ] {
        assert!(
            turn_tail.contains(pattern),
            "agent turn tail owner must contain {pattern}"
        );
    }

    for pattern in [
        "let learn_envelope = memory_reuse_envelope_from_read_set(",
        "let automation_workspace_id = thread_id\n        .as_deref()",
        "let memory_user_message = if applies_new_input",
        "let memory_prev_assistant = effective_context",
        "let tail_state = state_owned.clone();",
        "let tail_user = memory_user_message.clone();",
        "let tail_thread = thread_id.clone();",
        "let tail_turn_id = request.request_id.clone();",
        "let fence_turn_id = request.request_id.clone();",
        "let fence_user_id = automation_user_id.clone();",
        "let fence_workspace_id = automation_workspace_id.clone();",
        "spawn_project_graph_refresh(&tail_state, &ws);",
        "finalize_turn_steering(\n            &tail_state,",
        "publish_stream_outcome(&tx.entry, outcome);",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain agent turn tail surface {pattern}"
        );
    }

    assert!(
        !turn_tail.contains("pub(crate) read_only: bool,"),
        "agent turn tail input must receive typed ChatTurnPolicy, not a scalar read_only copy"
    );
    let tail_call = main
        .split("complete_agent_turn_tail(AgentTurnTailInput {")
        .nth(1)
        .expect("agent turn tail call")
        .split("})")
        .next()
        .expect("agent turn tail input block");
    assert!(
        tail_call.contains("turn_policy: &turn_policy,"),
        "main.rs must pass the typed chat turn policy into the tail owner"
    );
    assert!(
        !tail_call.contains("read_only: turn_policy.read_only,"),
        "main.rs must not pass a scalar read_only copy into the tail owner"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "fn execute_capability_browser_task(",
        "fn execute_persistent_browser_capability(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !turn_tail.contains(adjacent),
            "agent turn tail owner must not absorb adjacent stream/loop/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn chat_turn_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let turn_context = production_source(&root.join("src/gateway_chat_turn_context.rs"));

    for pattern in [
        "pub(crate) fn prepare_chat_turn_context(",
        "pub(crate) fn resolve_chat_turn_policy(",
        "pub(crate) fn resolve_contact_memory_perimeter(",
        "struct ChatTurnContextInput",
        "struct ChatTurnContext",
        "struct ChatTurnPolicy",
        "struct ContactMemoryPerimeter",
        "set_memory_workspace(",
        "contact_turn_context(",
        "note_user_activity(",
    ] {
        assert!(
            turn_context.contains(pattern),
            "chat turn context owner must contain {pattern}"
        );
    }

    for pattern in [
        "set_memory_workspace(&ws);",
        "set_memory_workspace(\"\");",
        "let (contact_ctx, channel_owner) = contact_turn_context(",
        "note_user_activity();",
        "request.tool_policy.as_deref() == Some(\"read_only\")",
        "request.tool_policy.as_deref() == Some(\"autonomous\")",
        "request.mode.as_deref().unwrap_or(\"agent\")",
        "c.perimeter.memory_scope == \"contact_only\"",
        "c.perimeter.can_see_contacts",
        "c.perimeter.can_see_calendar",
        "context.can_use_project_memory",
        "let contact_only = contact_memory_perimeter.contact_only;",
        "let can_see_contacts = contact_memory_perimeter.can_see_contacts;",
        "let can_see_calendar = contact_memory_perimeter.can_see_calendar;",
        "let can_use_project_memory = contact_memory_perimeter.can_use_project_memory;",
        "let read_only = turn_policy.read_only;",
        "let autonomous = turn_policy.autonomous;",
        "contact_only: bool,",
        "can_see_contacts: bool,",
        "can_see_calendar: bool,",
        "can_use_project_memory: bool,",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain chat turn context setup {pattern}"
        );
    }

    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds");
    assert!(
        run_agent_rounds.contains("turn_policy: &ChatTurnPolicy,"),
        "run_agent_rounds must receive the typed chat turn policy"
    );
    for pattern in ["read_only: bool,", "autonomous: bool,"] {
        assert!(
            !run_agent_rounds.contains(pattern),
            "run_agent_rounds must not split chat turn policy back into scalar flag {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !turn_context.contains(adjacent),
            "chat turn context owner must not absorb stream/loop/tail/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn contact_context_prompt_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_layers = production_source(&root.join("src/gateway_chat_prompt_layers.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    assert!(
        prompt_instructions.contains("pub(crate) fn contact_context_instruction_block("),
        "contact channel prompt rendering must live in gateway_prompt_instructions"
    );

    assert!(
        prompt_layers.contains("if let Some(cx) = input.contact"),
        "chat prompt layers owner must own the runtime decision to prepend contact context"
    );
    assert!(
        !main.contains("if let Some(cx) = &contact_ctx"),
        "main.rs must delegate the runtime decision to prepend contact context"
    );

    for pattern in [
        "REQUESTED TONE:",
        "PERSONA INSTRUCTIONS (always follow them):",
        "[PRIVACY] NEVER mention other contacts, people or relationships",
        "[PRIVACY] NEVER mention the user's commitments, appointments",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain contact prompt contract text {pattern}"
        );
    }
}

#[test]
fn contact_history_prompt_block_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let contacts = production_source(&root.join("src/gateway_contacts.rs"));
    let workspace_prompt =
        production_source(&root.join("src/gateway_chat_workspace_prompt_context.rs"));

    assert!(
        contacts.contains("pub(crate) fn contact_history_prompt_block("),
        "contact history prompt block must live with gateway_contacts handle memory helpers"
    );
    assert!(
        !main.contains("fn contact_history_prompt_block("),
        "main.rs must not retain contact history prompt block surface"
    );

    for pattern in [
        "HISTORY WITH THIS CONTACT (the only memory available):",
        "block.push_str(\"\\n- \");",
        "episodes.iter().rev().take(40).rev()",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain contact history prompt block text/building {pattern}"
        );
    }

    assert!(
        !main.contains("episode_texts_by_handles("),
        "main.rs still owns the runtime decision to fetch contact-only history"
    );
    assert!(
        workspace_prompt.contains("episode_texts_by_handles("),
        "chat workspace prompt context owner must fetch contact-only history"
    );
}

#[test]
fn runtime_prompt_control_instructions_have_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let prompt_instructions = production_source(&root.join("src/gateway_prompt_instructions.rs"));

    for pattern in [
        "pub(crate) struct RuntimePromptControlInput",
        "pub(crate) fn runtime_prompt_control_instructions(",
        "pub(crate) struct ChatRuntimePromptInput",
        "pub(crate) turn_policy: &'a ChatTurnPolicy,",
        "pub(crate) fn prepare_chat_runtime_prompt(",
        "memory_recall_usage_instruction()",
        "operational_plan_instruction()",
        "memory_scope_restricted_instruction()",
        "capability_router_instruction",
        "manager_browser_guidance()",
        "objective_contract_read_only_default_instruction()",
    ] {
        assert!(
            prompt_instructions.contains(pattern),
            "runtime prompt control owner must contain {pattern}"
        );
    }

    let stream = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai body");
    assert!(
        stream.contains("prepare_chat_runtime_prompt(ChatRuntimePromptInput"),
        "main.rs must delegate runtime prompt control assembly"
    );
    let runtime_prompt_setup = stream
        .split("let capability_router_instruction =")
        .nth(1)
        .expect("runtime prompt setup")
        .split("let (system, prompt_packets) =")
        .next()
        .expect("prompt packet setup");
    for pattern in [
        "let system = format!(\n        \"{}\\n\\n{}\"",
        ".strip_prefix(&prompt_core)",
    ] {
        assert!(
            !runtime_prompt_setup.contains(pattern),
            "main.rs must not own runtime prompt wrapper glue {pattern}"
        );
    }
    assert!(
        runtime_prompt_setup.contains("turn_policy: &turn_policy,"),
        "main.rs must pass typed ChatTurnPolicy into runtime prompt owner"
    );
    assert!(
        !runtime_prompt_setup.contains("mode: mode.as_str(),"),
        "main.rs must not pass scalar mode into runtime prompt owner"
    );
    assert_eq!(
        stream
            .matches("prepare_chat_objective_execution_context(ChatObjectiveExecutionContextInput")
            .count(),
        1,
        "stream setup must prepare the chat objective execution context once"
    );
    assert_eq!(
        stream
            .matches("objective_contract_for_execution(state, request.thread_id.as_deref())")
            .count(),
        0,
        "stream setup must not load the active objective contract inline"
    );

    for pattern in [
        "format!(\"{system}\\n\\n{}\", memory_recall_usage_instruction())",
        "format!(\"{system}\\n\\n{}\", operational_plan_instruction())",
        "format!(\"{system}\\n\\n{}\", memory_scope_restricted_instruction())",
        "format!(\"{system}\\n\\n{}\", language_follow_user_instruction())",
        "format!(\"{system}\\n\\n{}\", freshness_verification_instruction())",
        "format!(\"{system}\\n\\n{}\", execution_verification_instruction())",
        "format!(\"{system}\\n\\n{}\", manager_browser_guidance())",
        "objective_contract_read_only_default_instruction()",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain runtime prompt control assembly {pattern}"
        );
    }
}

#[test]
fn chat_toolset_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let toolset = production_source(&root.join("src/gateway_chat_toolset.rs"));

    for pattern in [
        "pub(crate) async fn prepare_connected_tool_catalog(",
        "struct ConnectedToolCatalogInput",
        "struct ConnectedToolCatalog",
        "fn connected_tool_catalog_from_sources(",
        "fn connected_tool_catalog_index(",
        "fn filesystem_mcp_connected(",
        "pub(crate) async fn prepare_chat_toolset(",
        "struct ChatToolsetInput",
        "turn_policy: &'a ChatTurnPolicy,",
        "contact_memory_perimeter: ContactMemoryPerimeter,",
        "struct ChatToolset",
        "initial_manager_tool_schemas_for_test(",
        "tool_stays_live_this_turn(",
        "materialize_capability_corpus(",
        "auto_retrieve_composio(",
    ] {
        assert!(
            toolset.contains(pattern),
            "chat toolset owner must contain {pattern}"
        );
    }

    for pattern in [
        "let mut base_tools = initial_manager_tool_schemas_for_test(",
        "base_tools.into_iter().partition(|schema|",
        "for schema in auto_retrieve_composio(",
        "let capability_corpus = materialize_capability_corpus(",
        "let mut composio_writes = catalog.writes.clone();",
        ".filter_map(|s| {\n            let f = s.get(\"function\")?;",
        "let filesystem_mcp_connected = mcp_catalog.schemas.iter().any(|schema|",
        "composio_writes.extend(mcp_catalog.writes.iter().cloned());",
        "for schema in &mcp_catalog.schemas {",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain chat toolset assembly {pattern}"
        );
    }

    assert!(
        !toolset.contains("pub(crate) read_only: bool,"),
        "chat toolset input must receive typed ChatTurnPolicy, not a scalar read_only copy"
    );
    assert!(
        !toolset.contains("pub(crate) contact_only: bool,"),
        "chat toolset input must receive typed ContactMemoryPerimeter, not a scalar contact_only copy"
    );
    let toolset_call = main
        .split("let chat_toolset = prepare_chat_toolset(ChatToolsetInput {")
        .nth(1)
        .expect("chat toolset call")
        .split("})")
        .next()
        .expect("chat toolset input block");
    assert!(
        toolset_call.contains("turn_policy: &turn_policy,"),
        "main.rs must pass the typed chat turn policy into the toolset owner"
    );
    assert!(
        toolset_call.contains("contact_memory_perimeter,"),
        "main.rs must pass the typed contact memory perimeter into the toolset owner"
    );
    assert!(
        !toolset_call.contains("read_only: turn_policy.read_only,"),
        "main.rs must not pass a scalar read_only copy into the toolset owner"
    );
    assert!(
        !toolset_call.contains("contact_only: contact_memory_perimeter.contact_only,"),
        "main.rs must not pass a scalar contact_only copy into the toolset owner"
    );

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
        "fn run_mcp_chat_tool(",
    ] {
        assert!(
            !toolset.contains(adjacent),
            "chat toolset owner must not absorb adjacent stream/loop/tail/browser/subagent/MCP runtime surface {adjacent}"
        );
    }
}

#[test]
fn chat_plan_resume_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let plan_resume = production_source(&root.join("src/gateway_chat_plan_resume.rs"));

    for pattern in [
        "pub(crate) fn prepare_chat_plan_resume(",
        "struct ChatPlanResumeInput",
        "struct ChatPlanResume",
        "runtime_plan_record_from_state(",
        "parse_plan_marker(",
        "plan_stall_check_and_bump(",
        "block_stalled_step(",
        "upsert_runtime_plan_memory_from_state(",
    ] {
        assert!(
            plan_resume.contains(pattern),
            "chat plan resume owner must contain {pattern}"
        );
    }

    for pattern in [
        "let (mut resume_plan, resume_goal): (Vec<serde_json::Value>, Option<String>) =",
        "let from_store = runtime_plan_record_from_state(",
        "let stalled = runtime_plan_control_scope(",
        "state.task_store.as_ref(),\n                    &user_id,",
        "block_stalled_step(&mut resume_plan)",
        "upsert_runtime_plan_memory_from_state(\n                state,",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain chat plan resume/stall setup {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn complete_agent_turn_tail(",
        "pub(crate) async fn prepare_chat_toolset(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !plan_resume.contains(adjacent),
            "chat plan resume owner must not absorb adjacent stream/loop/tail/toolset/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn chat_vision_preflight_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let vision_preflight = production_source(&root.join("src/gateway_chat_vision_preflight.rs"));

    for pattern in [
        "pub(crate) async fn prepare_chat_vision_preflight(",
        "struct ChatVisionPreflightInput",
        "enum ChatVisionPreflight",
        "struct ChatVisionFallbackSeed",
        "struct ChatVisionFallbackSeedInput",
        "pub(crate) fn snapshot_chat_vision_fallback_seed(",
        "vision::messages_have_image(",
        "vision::plan_attachments(",
        "vision::AttachmentPlan::Refuse",
        "vision::AttachmentPlan::Delegate",
        "vision::describe_images(",
        "vision::replace_images_with_descriptions(",
        "vision::no_vision_model_message(",
    ] {
        assert!(
            vision_preflight.contains(pattern),
            "chat vision preflight owner must contain {pattern}"
        );
    }

    for pattern in [
        "let vision_fallback_armed = if vision::messages_have_image(&messages) {",
        "match vision::plan_attachments(model_vision_support(&base_url, &model), has_vision_model())",
        "vision::AttachmentPlan::Refuse => {",
        "vision::AttachmentPlan::Delegate => {",
        "vision::replace_images_with_descriptions(&mut messages, &descriptions);",
        "let vision_seed = vision_fallback_armed.then(|| {",
        "            ls.clone(),",
        "            cfg.clone(),",
        "            memory_user_message.clone(),",
        "            trace_dir.clone(),",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain chat vision preflight setup {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn prepare_chat_toolset(",
        "pub(crate) fn prepare_chat_plan_resume(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
        "delivered_image_rejection_outcome(",
    ] {
        assert!(
            !vision_preflight.contains(adjacent),
            "chat vision preflight owner must not absorb adjacent stream/loop/toolset/plan/browser/subagent/recovery surface {adjacent}"
        );
    }
}

#[test]
fn chat_vision_recovery_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let vision_recovery = production_source(&root.join("src/gateway_chat_vision_recovery.rs"));

    assert!(
        main.contains("mod gateway_chat_vision_recovery;"),
        "gateway root must declare chat vision recovery owner"
    );
    assert!(
        main.contains("pub(crate) use gateway_chat_vision_recovery::*;"),
        "gateway root must re-export chat vision recovery owner"
    );

    for pattern in [
        "pub(crate) struct ChatVisionRecoveryInput",
        "pub(crate) async fn recover_chat_vision_fallback_seed(",
        "vision::collect_image_urls(",
        "vision::describe_images(",
        "vision::replace_images_with_descriptions(",
    ] {
        assert!(
            vision_recovery.contains(pattern),
            "chat vision recovery owner must contain {pattern}"
        );
    }

    let run_agent_rounds = main
        .split("async fn run_agent_rounds(")
        .nth(1)
        .expect("run_agent_rounds");
    for pattern in [
        "vision::collect_image_urls(",
        "vision::describe_images(",
        "vision::replace_images_with_descriptions(",
    ] {
        assert!(
            !run_agent_rounds.contains(pattern),
            "run_agent_rounds must delegate chat vision recovery primitive {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn prepare_chat_vision_preflight(",
        "pub(crate) async fn prepare_chat_toolset(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
        "local_first_engine::agent_loop::run_turn(",
    ] {
        assert!(
            !vision_recovery.contains(adjacent),
            "chat vision recovery owner must not absorb adjacent stream/loop/preflight/toolset/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn chat_tool_perimeter_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let tool_perimeter = production_source(&root.join("src/gateway_chat_tool_perimeter.rs"));

    for pattern in [
        "pub(crate) fn apply_chat_tool_perimeter(",
        "struct ChatToolPerimeterInput",
        "contact: Option<&'a ContactTurnContext>",
        "tool_schemas: &'a mut Vec<serde_json::Value>",
        "tools_denied",
        "tools_allowed",
        "HARNESS_CONTROL_TOOLS.contains(&name)",
        "input.tool_schemas.retain(|schema|",
        "tracing::warn!",
        "contact perimeter withheld tools from this turn",
    ] {
        assert!(
            tool_perimeter.contains(pattern),
            "chat tool perimeter owner must contain {pattern}"
        );
    }

    for pattern in [
        "let denied = &cx.perimeter.tools_denied;",
        "let allowed = &cx.perimeter.tools_allowed;",
        "ls.tool_schemas.retain(|schema| {",
        "&& !HARNESS_CONTROL_TOOLS.contains(&name)",
        "contact perimeter withheld tools from this turn",
    ] {
        assert!(
            !main.contains(pattern),
            "main.rs must not retain chat tool perimeter filtering {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn prepare_chat_toolset(",
        "pub(crate) async fn prepare_chat_vision_preflight(",
        "pub(crate) fn prepare_chat_plan_resume(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !tool_perimeter.contains(adjacent),
            "chat tool perimeter owner must not absorb adjacent stream/loop/toolset/vision/plan/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn chat_workspace_prompt_context_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let workspace_prompt =
        production_source(&root.join("src/gateway_chat_workspace_prompt_context.rs"));

    for pattern in [
        "pub(crate) struct ChatWorkspacePromptContextInput",
        "pub(crate) struct ChatWorkspacePromptContext",
        "pub(crate) async fn prepare_chat_workspace_prompt_context(",
        "contact_memory_perimeter: &'a ContactMemoryPerimeter",
        "contact_history_prompt_block(",
        "memory_perimeter_allows_recall(",
        "goal_propose_instruction()",
        "recall_pack_on_facade(",
        "relevant_code_components_for_prompt(",
    ] {
        assert!(
            workspace_prompt.contains(pattern),
            "chat workspace prompt context owner must contain {pattern}"
        );
    }

    let stream_chat = main
        .split("async fn stream_chat_via_openai(")
        .nth(1)
        .expect("stream_chat_via_openai")
        .split("let workflow_routing_plan =")
        .next()
        .expect("workflow routing boundary");
    assert!(
        stream_chat.contains("prepare_chat_workspace_prompt_context("),
        "gateway root must delegate chat workspace prompt context assembly"
    );
    for pattern in [
        "let mut automatic_recall_payload = None;",
        "contact_history_prompt_block(&episodes)",
        "goal_propose_instruction()",
        "recall_pack_on_facade(",
        "relevant_code_components_for_prompt(",
        ".strip_prefix(&prompt_core)",
    ] {
        assert!(
            !stream_chat.contains(pattern),
            "main.rs must not retain chat workspace prompt context assembly {pattern}"
        );
    }

    for adjacent in [
        "async fn stream_chat_via_openai(",
        "async fn run_agent_rounds(",
        "pub(crate) async fn prepare_chat_toolset(",
        "pub(crate) fn prepare_chat_plan_resume(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !workspace_prompt.contains(adjacent),
            "chat workspace prompt context owner must not absorb adjacent stream/loop/toolset/plan/browser/subagent surface {adjacent}"
        );
    }
}

#[test]
fn gateway_state_access_has_one_gateway_owner() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let main = production_source(&root.join("src/main.rs"));
    let state_access = production_source(&root.join("src/gateway_state_access.rs"));

    for pattern in [
        "struct GatewayError",
        "fn lock_store(",
        "fn lock_task_store(",
        "fn lock_computer_store(",
        "fn lock_browser_url_policies(",
        "fn memory_facade(",
        "fn lock_vault_store(",
        "fn lock_capability_registry(",
        "fn vacuum_all_stores(",
        "impl IntoResponse for GatewayError",
    ] {
        assert!(
            state_access.contains(pattern),
            "gateway state access owner must contain {pattern}"
        );
        assert!(
            !main.contains(pattern),
            "main.rs must not retain gateway state access surface {pattern}"
        );
    }

    for adjacent in [
        "async fn run_agent_rounds(",
        "async fn stream_chat_via_openai(",
        "async fn run_agent_turn_into_message(",
        "fn execute_proactive_prompt_task(",
        "fn execute_capability_browser_task(",
        "fn execute_subagent_task(",
    ] {
        assert!(
            !state_access.contains(adjacent),
            "gateway state access owner must not absorb execution/browser surface {adjacent}"
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
