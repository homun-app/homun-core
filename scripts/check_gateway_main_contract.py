#!/usr/bin/env python3
"""Guard the desktop gateway `main.rs` ownership boundary.

This is intentionally structural, not semantic. It prevents previously
extracted startup owners from being pasted back into `async fn main`, while
still allowing their implementation details to keep moving behind dedicated
modules.
"""
from __future__ import annotations

import os
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "main.rs")
ATTACHMENTS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "attachments.rs")
RECALL_CONTEXT_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_recall_context.rs"
)
MEMORY_PROMPT_CONTEXT_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_memory_prompt_context.rs"
)
TEXT_SAFETY_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_text_safety.rs")
BROWSER_TOOLS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_browser_tools.rs")
CHAT_UTILITY_ROUTES_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_chat_utility_routes.rs"
)
PROACTIVITY_ROUTES_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_proactivity_routes.rs"
)
VAULT_ROUTES_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_vault_routes.rs")
LOCAL_AUTHORIZATION_ROUTES_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_local_authorization_routes.rs"
)
COMPOSIO_ROUTES_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_composio_routes.rs")
COMPOSIO_EXECUTION_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_composio_execution.rs"
)
CONNECTOR_ERRORS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_connector_errors.rs")
IMAGE_GENERATION_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_image_generation.rs")
ACTION_CONFIRMATIONS_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_action_confirmations.rs"
)
ACTIONABLE_SOURCE_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_actionable_source.rs"
)
REMOTE_APPROVAL_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_remote_approval.rs")
REMOTE_APPROVAL_EXECUTION_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_remote_approval_execution.rs"
)
MODEL_ROUTING_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_model_routing.rs")
CAPABILITY_ROUTING_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_capability_routing.rs"
)
TASK_EXECUTOR_CONFIG_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_task_executor_config.rs"
)
TASK_EXECUTOR_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_task_executor.rs")
BOOT_MAINTENANCE_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_boot_maintenance.rs"
)
SKILL_RUNTIME_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_skill_runtime.rs")
RUNTIME_PLAN_STATE_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_runtime_plan_state.rs"
)
THREAD_EPISODES_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_thread_episodes.rs"
)
PROMPT_PACKETS_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_prompt_packets.rs"
)
BRAIN_RUNTIME_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_brain_runtime.rs"
)
BRAIN_MATERIALIZATION_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_brain_materialization.rs"
)
RUNTIME_FLAGS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_runtime_flags.rs")
AUTOMATION_FORMATTING_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_automation_formatting.rs"
)
PROACTIVE_THREADS_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_proactive_threads.rs"
)
SHELL_TASKS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_shell_tasks.rs")
CHANNELS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_channels.rs")
MEMORY_QUERY_EMBEDDINGS_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_memory_query_embeddings.rs"
)
MEMORY_JSON_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_memory_json.rs")
MEMORY_LEARNING_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_memory_learning.rs"
)
MEMORY_RECALL_TOOL_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_memory_recall_tool.rs"
)
MEMORY_CLIENTS_RS = os.path.join(ROOT, "crates", "desktop-gateway", "src", "gateway_memory_clients.rs")
PAYMENT_APPROVAL_RS = os.path.join(
    ROOT, "crates", "desktop-gateway", "src", "gateway_payment_approval.rs"
)


def extract_async_main_body(source: str) -> str:
    marker = "async fn main()"
    start = source.find(marker)
    if start < 0:
        raise AssertionError("missing async fn main()")
    open_brace = source.find("{", start)
    if open_brace < 0:
        raise AssertionError("async fn main() has no body")

    depth = 0
    for index in range(open_brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[open_brace + 1 : index]
    raise AssertionError("async fn main() body is not balanced")


def forbidden_main_startup_snippets() -> dict[str, str]:
    return {
        "init_active_workspace_from_disk();": "active workspace boot must stay in gateway_boot_maintenance",
        "seed_default_skills();": "skill seeding must stay in gateway_boot_maintenance",
        "gc_stale_tasks(&state);": "stale task GC must stay in gateway_boot_maintenance",
        "backfill_contacts(&state);": "contact backfill must stay in gateway_boot_maintenance",
        "backfill_mentions(&state);": "mention backfill must stay in gateway_boot_maintenance",
        "unify_owner_identity(&state);": "owner identity unification must stay in gateway_boot_maintenance",
        "cancel_homun_checkins(&state);": "retired Homun check-ins must stay in gateway_boot_maintenance",
        "projection_worker::drain_at_startup(&state,": "projection replay must stay in gateway_turn_recovery",
        "local_first_task_runtime::broker::recover_chat_turns_at_boot(": "broker recovery must stay in gateway_turn_recovery",
        "set_chat_turn_message_delivery_state(\n            &state,": "recovered message repair must stay in gateway_turn_recovery",
        "projection_worker::start(state.clone());": "projection worker startup must stay in gateway_turn_recovery",
        "steering_control::start(state.clone());": "steering startup must stay in gateway_turn_recovery",
        "sweep_stale_dated_suggestions_once(&st).await": "stale suggestion sweep must stay in gateway_background_startup",
        "sweep_graph_on_startup(&st)": "graph startup sweep must stay in gateway_background_startup",
        "vacuum_all_stores(&st);": "startup VACUUM must stay in gateway_background_startup",
        "start_task_executor_worker(state.clone());": "task worker startup must stay in gateway_background_startup",
        "spawn_memory_consolidation_tick(state.clone());": "memory consolidation must stay in gateway_background_startup",
        "spawn_embedding_catchup(state.clone());": "embedding catchup must stay in gateway_background_startup",
        "spawn_memory_hygiene_sweep(state.clone());": "memory hygiene must stay in gateway_background_startup",
        "spawn_thread_browser_session_reaper(state.clone());": "thread browser session reaper must stay in gateway_background_startup",
        "spawn_contained_computer_idle_reaper(state.clone());": "contained computer reaper must stay in gateway_background_startup",
        "spawn_browser_handoff_reaper(state.clone());": "browser handoff reaper must stay in gateway_background_startup",
        "spawn_connector_event_poller(state.clone());": "connector event poller must stay in gateway_background_startup",
        "start_proactivity_auto_review(state.clone());": "proactivity auto-review must stay in gateway_background_startup",
        "spawn_computer_live_publisher(state.clone());": "computer live publisher must stay in gateway_background_startup",
        "let chat_routes = Router::new()": "route assembly must stay in gateway_routes",
        "let chat_routes = chat_routes": "route layering must stay in gateway_routes",
        "let mut app = Router::new()": "top-level app router assembly must stay in gateway_routes",
        "app = app.fallback_service(": "web fallback mounting must stay in gateway_routes",
        "let app = app.layer(gateway_cors::cors_layer());": "CORS layering must stay in gateway_routes",
    }


def forbidden_root_snippets() -> dict[str, str]:
    return {
        "fn recall_source_label(": "memory recall labeling must stay in gateway_recall_context",
        "fn recall_collection_token(": "memory recall collection labeling must stay in gateway_recall_context",
        "fn memory_access_status_instruction(": "memory access prompt status must stay in gateway_recall_context",
        "fn format_recall_entry(": "recall entry formatting must stay in gateway_recall_context",
        "fn recall_stream_payload_from_pack(": "recall stream payload assembly must stay in gateway_recall_context",
        "fn recall_stream_payload_from_hits(": "recall stream payload assembly must stay in gateway_recall_context",
        "fn merge_automatic_recall_payload(": "automatic recall payload merging must stay in gateway_recall_context",
        "fn memory_read_effects_from_recall_payload(": "recall effect projection must stay in gateway_recall_context",
        "fn seed_loop_memory_reads(": "loop memory-read seeding must stay in gateway_recall_context",
        "fn gather_open_loops(": "open-loop recall gathering must stay in gateway_recall_context",
        "fn sanitize_dedup_key(": "dedup-key normalization must stay in gateway_recall_context",
        "fn artifact_quality_summary(": "artifact quality prompt context must stay in gateway_memory_prompt_context",
        "fn artifact_provenance_context_for_query(": "artifact provenance prompt context must stay in gateway_memory_prompt_context",
        "fn decisions_for_path(": "file-decision prompt context must stay in gateway_memory_prompt_context",
        "fn producer_workflow_contract(": "producer workflow prompt context must stay in gateway_memory_prompt_context",
        "fn relevant_code_components_for_prompt(": "code-map prompt context must stay in gateway_memory_prompt_context",
        "fn workflow_status_context_for_query(": "workflow status prompt context must stay in gateway_memory_prompt_context",
        "fn compact_redacted_task_goal_summary(": "redacted task title compaction must stay in gateway_text_safety",
        "fn redact_sensitive_text(": "shared sensitive text redaction must stay in gateway_text_safety",
        "fn strip_terminal_control_sequences(": "terminal control stripping must stay in gateway_text_safety",
        "fn task_goal_summary(": "task goal summary redaction must stay in gateway_text_safety",
        "fn truncate_chars(": "shared text truncation must stay in gateway_text_safety",
        "fn gather_scope_memory(": "proactivity scope memory gathering must stay in gateway_proactivity",
        "fn gather_recent_connector_activity(": "proactivity connector activity gathering must stay in gateway_proactivity",
        "fn parse_review_suggestion(": "proactivity suggestion parsing must stay in gateway_proactivity",
        "fn parse_relevant_until_epoch(": "proactivity stale-date parsing must stay in gateway_proactivity",
        "fn suggestion_choices_json(": "proactivity choices serialization must stay in gateway_proactivity",
        "const PROACTIVE_SUPERVISOR_SYSTEM:": "proactivity supervisor prompt must stay in gateway_proactivity",
        "async fn run_proactive_review(": "proactivity review engine must stay in gateway_proactivity",
        "async fn sweep_stale_dated_suggestions_once(": "proactivity stale-date sweep must stay in gateway_proactivity",
        "fn proactive_tick_secs(": "proactivity cadence config must stay in gateway_proactivity",
        "fn proactive_cooldown_secs(": "proactivity cadence config must stay in gateway_proactivity",
        "fn start_proactivity_auto_review(": "proactivity background tick must stay in gateway_proactivity",
        "async fn proactivity_auto_review_tick(": "proactivity background tick must stay in gateway_proactivity",
        "struct PaymentApprovalGrant": "payment approval grants must stay in gateway_payment_approval",
        "fn apply_payment_approval_secret_for_action(": "payment approval secret injection must stay in gateway_payment_approval",
        "fn apply_payment_approval_secret_from_map(": "payment approval secret injection must stay in gateway_payment_approval",
        "fn single_action_rejects_unsupported_execution_before_payment_claim(": "payment approval reject-before-claim preflight must stay in gateway_payment_approval",
        "fn should_claim_payment_approval(": "payment approval claim policy must stay in gateway_payment_approval",
        "fn claim_payment_approval_for_action(": "payment approval claiming must stay in gateway_payment_approval",
        "fn validate_payment_approval_for_action(": "payment approval validation must stay in gateway_payment_approval",
        "fn validated_payment_approval_id(": "payment approval validation must stay in gateway_payment_approval",
        "fn claim_payment_approval_from_map(": "payment approval claiming must stay in gateway_payment_approval",
        "fn prune_expired_payment_approvals(": "payment approval expiry must stay in gateway_payment_approval",
        "fn lock_payment_approvals(": "payment approval state lock must stay in gateway_payment_approval",
        "const ATTACHMENT_TEXT_BUDGET_CHARS:": "attachment prompt context budget must stay in attachments",
        "const ATTACHMENT_CONTEXT_IMAGES:": "attachment prompt image budget must stay in attachments",
        "fn append_thread_attachment_context(": "attachment prompt context assembly must stay in attachments",
        "fn attachment_text_is_ready(": "attachment prompt readiness policy must stay in attachments",
        "fn task_delivers_to_homun(": "Homun check-in task matching must stay in gateway_task_maintenance",
        "fn task_is_live(": "task liveness classification must stay in gateway_task_maintenance",
        "fn cancel_homun_checkins(": "Homun check-in cancellation must stay in gateway_task_maintenance",
        "fn gc_stale_tasks(": "stale task GC must stay in gateway_task_maintenance",
        "fn spawn_memory_consolidation_tick(": "memory consolidation tick must stay in gateway_memory_background",
        "fn spawn_embedding_catchup(": "embedding catchup must stay in gateway_memory_background",
        "fn spawn_memory_hygiene_sweep(": "memory hygiene sweep must stay in gateway_memory_background",
        "struct MemoryBenchMessage ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchSession ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchIngestRequest ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchIngestResponse ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchStatusRequest ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchStatusResponse ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchSearchRequest ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "struct MemoryBenchSearchResult ": "MemoryBench DTOs must stay in gateway_memory_bench",
        "fn memorybench_default_limit(": "MemoryBench defaults must stay in gateway_memory_bench",
        "fn memorybench_enabled(": "MemoryBench opt-in policy must stay in gateway_memory_bench",
        "fn validate_memorybench_container_tag(": "MemoryBench validation must stay in gateway_memory_bench",
        "fn memorybench_workspace_id(": "MemoryBench workspace identity must stay in gateway_memory_bench",
        "fn ensure_memorybench_workspace(": "MemoryBench workspace materialization must stay in gateway_memory_bench",
        "fn memorybench_session_text(": "MemoryBench session projection must stay in gateway_memory_bench",
        "async fn memory_bench_ingest(": "MemoryBench routes must stay in gateway_memory_bench",
        "async fn memory_bench_status(": "MemoryBench routes must stay in gateway_memory_bench",
        "async fn memory_bench_search(": "MemoryBench routes must stay in gateway_memory_bench",
        "async fn memory_dashboard(": "memory UI routes must stay in gateway_memory_ui_routes",
        "async fn memory_export(": "memory export routes must stay in gateway_memory_ui_routes",
        "async fn export_user_data(": "full user data export must stay in gateway_memory_ui_routes",
        "struct MemoryItemView ": "memory explorer DTOs must stay in gateway_memory_ui_routes",
        "async fn memory_items(": "memory explorer routes must stay in gateway_memory_ui_routes",
        "struct RemoteApprovalIntent ": "remote approval intent parsing must stay in gateway_remote_approval",
        "fn remote_approval_intent_from_marker(": "remote approval marker parsing must stay in gateway_remote_approval",
        "fn remote_approval_intent_from_raw_text(": "remote approval marker parsing must stay in gateway_remote_approval",
        "fn actionable_cards_from_raw_text(": "actionable card parsing must stay in gateway_remote_approval",
        "async fn activate_remote_approvals_from_message(": "remote approval source binding and dispatch must stay in gateway_remote_approval",
        "fn approval_expires_at_secs(": "remote approval expiry policy must stay in gateway_remote_approval",
        "fn create_pending_approval(": "remote approval creation must stay in gateway_remote_approval",
        "fn pending_approval_exists(": "remote approval control checks must stay in gateway_remote_approval",
        "fn approval_progress_reply(": "remote approval channel progress copy must stay in gateway_remote_approval",
        "fn parse_approval_reply(": "remote approval channel reply parsing must stay in gateway_remote_approval",
        "fn approval_action_target(": "remote approval status target formatting must stay in gateway_remote_approval",
        "fn remote_approval_thread_status(": "remote approval thread status copy must stay in gateway_remote_approval",
        "fn append_remote_approval_thread_status(": "remote approval thread status append must stay in gateway_remote_approval",
        "fn approval_resume_prompt(": "remote approval continuation prompt must stay in gateway_remote_approval",
        "fn approval_source_user_text(": "remote approval continuation source lookup must stay in gateway_remote_approval",
        "fn approval_continuation_visible_text(": "remote approval continuation visible prompt must stay in gateway_remote_approval",
        "fn approval_continuation_turn_input(": "remote approval continuation input must stay in gateway_remote_approval",
        "fn resume_thread_after_approval(": "remote approval continuation wake must stay in gateway_remote_approval",
        "fn remote_approval_effect_request(": "remote approval effect receipt request must stay in gateway_remote_approval",
        "async fn dispatch_remote_approval(": "remote approval channel dispatch must stay in gateway_remote_approval",
        "fn cancel_pending_remote_approval(": "remote approval cancellation must stay in gateway_remote_approval",
        "async fn execute_pending_approval(": "remote approval execution must stay in gateway_remote_approval_execution",
        "const KNOWN_PLUGINS:": "plugin enablement registry must stay in gateway_plugins",
        "async fn plugins_list(": "plugin enablement listing must stay in gateway_plugins",
        "async fn plugin_toggle(": "plugin enablement toggle must stay in gateway_plugins",
        "const MAX_LOCAL_PLUGIN_PACKAGE_BYTES:": "plugin package limits must stay in gateway_plugin_packages",
        "struct InstallLocalPluginPackageRequest ": "plugin package request types must stay in gateway_plugin_packages",
        "async fn install_local_plugin_package(": "plugin package install endpoint must stay in gateway_plugin_packages",
        "async fn install_plugin_package_from_registry(": "plugin package install endpoint must stay in gateway_plugin_packages",
        "async fn update_plugin_package_from_registry(": "plugin package update endpoint must stay in gateway_plugin_packages",
        "async fn fetch_plugin_registry(": "plugin registry fetch endpoint must stay in gateway_plugin_packages",
        "fn installed_plugin_packages_root(": "plugin package paths must stay in gateway_plugin_packages",
        "struct ChatThreadsQuery ": "chat thread request types must stay in gateway_chat_threads",
        "fn resolve_threads_workspace(": "chat thread workspace resolution must stay in gateway_chat_threads",
        "async fn chat_threads(": "chat thread list endpoint must stay in gateway_chat_threads",
        "struct ThreadAttentionResponse ": "chat thread attention response must stay in gateway_chat_threads",
        "fn seen_terminal_cursor_to_persist(": "chat thread seen cursor clamp must stay in gateway_chat_threads",
        "async fn mark_chat_thread_seen(": "chat thread seen endpoint must stay in gateway_chat_threads",
        "async fn create_chat_thread(": "chat thread create endpoint must stay in gateway_chat_threads",
        "async fn delete_chat_thread(": "chat thread delete endpoint must stay in gateway_chat_threads",
        "async fn chat_messages(": "chat message list endpoint must stay in gateway_chat_threads",
        "struct ImprovePromptRequest ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "struct ImprovePromptResponse ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "async fn improve_prompt(": "chat utility routes must stay in gateway_chat_utility_routes",
        "struct SuggestionsRequest ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "struct SuggestionsResponse ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "fn chat_suggestions_payload(": "chat utility payload policy must stay in gateway_chat_utility_routes",
        "async fn chat_suggestions(": "chat utility routes must stay in gateway_chat_utility_routes",
        "struct AutoTitleRequest ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "fn title_model_inputs(": "chat title model inputs must stay in gateway_chat_utility_routes",
        "async fn autotitle_chat_thread(": "chat utility routes must stay in gateway_chat_utility_routes",
        "fn is_placeholder_chat_title(": "chat title placeholder policy must stay in gateway_chat_utility_routes",
        "struct SeedAssistantRequest ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "async fn seed_assistant_message(": "chat utility routes must stay in gateway_chat_utility_routes",
        "struct ProactiveAnswerRequest ": "chat utility route DTOs must stay in gateway_chat_utility_routes",
        "async fn proactive_answer(": "chat utility routes must stay in gateway_chat_utility_routes",
        "fn proactive_answer_memory_request(": "proactive answer memory capture must stay in gateway_chat_utility_routes",
        "struct ToolRunsQuery ": "tool run audit route DTOs must stay in gateway_proactivity_routes",
        "async fn tool_runs_list(": "tool run audit routes must stay in gateway_proactivity_routes",
        "struct SuggestionsQuery ": "proactivity suggestion route DTOs must stay in gateway_proactivity_routes",
        "async fn suggestions_list(": "proactivity suggestion routes must stay in gateway_proactivity_routes",
        "struct SuggestionActRequest ": "proactivity suggestion route DTOs must stay in gateway_proactivity_routes",
        "async fn suggestion_act(": "proactivity suggestion routes must stay in gateway_proactivity_routes",
        "fn write_proactive_action_memory(": "proactivity suggestion write-back must stay in gateway_proactivity_routes",
        "fn proactive_memory_request_for_suggestion_action(": "proactivity suggestion write-back must stay in gateway_proactivity_routes",
        "struct ProactiveReviewRequest ": "proactivity review route DTOs must stay in gateway_proactivity_routes",
        "async fn proactivity_review_now(": "proactivity review routes must stay in gateway_proactivity_routes",
        "struct VaultProposalActionRequest": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultRecordSummary": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultRecordUpdateRequest": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultRecordRevealRequest": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultPinStatusResponse": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultPinSetupRequest": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultPinVerifyRequest": "vault route DTOs must stay in gateway_vault_routes",
        "struct VaultPaymentApprovalRequest": "vault route DTOs must stay in gateway_vault_routes",
        "async fn vault_proposal_accept(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_proposal_dismiss(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_records_list(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_record_delete(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_record_update(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_record_reveal(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_pin_status(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_pin_setup(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_pin_verify(": "vault routes must stay in gateway_vault_routes",
        "async fn vault_payment_approval_approve(": "vault payment approval route must stay in gateway_vault_routes",
        "fn recall_memory_response_with_vault_fallback(": "Vault memory recall fallback must stay in gateway_vault_routes",
        "fn query_has_sensitive_vault_term(": "Vault sensitive-term recall policy must stay in gateway_vault_routes",
        "fn vault_reveal_marker(": "Vault reveal-card marker construction must stay in gateway_vault_routes",
        "const FS_AUTHORIZE_OPEN": "local authorization markers must stay in gateway_local_authorization_routes",
        "const SANDBOX_ESCALATE_OPEN": "local authorization markers must stay in gateway_local_authorization_routes",
        "const SANDBOX_READONLY_OPEN": "local authorization markers must stay in gateway_local_authorization_routes",
        "const CONNECT_SUGGEST_OPEN": "local authorization markers must stay in gateway_local_authorization_routes",
        "struct FsAuthorizeRequest": "filesystem authorization route DTOs must stay in gateway_local_authorization_routes",
        "struct RunEscalateRequest": "sandbox escalation route DTOs must stay in gateway_local_authorization_routes",
        "struct ConnectMarkRequest": "connect suggestion route DTOs must stay in gateway_local_authorization_routes",
        "fn fs_authorize_matches(": "filesystem authorization provenance must stay in gateway_local_authorization_routes",
        "fn rewrite_fs_authorize_to_done(": "filesystem authorization rewrite must stay in gateway_local_authorization_routes",
        "async fn fs_authorize(": "filesystem authorization route must stay in gateway_local_authorization_routes",
        "fn sandbox_escalate_matches(": "sandbox escalation provenance must stay in gateway_local_authorization_routes",
        "fn rewrite_sandbox_escalate_to_done(": "sandbox escalation rewrite must stay in gateway_local_authorization_routes",
        "async fn run_escalate(": "sandbox escalation route must stay in gateway_local_authorization_routes",
        "fn rewrite_connect_suggest_mark(": "connect suggestion rewrite must stay in gateway_local_authorization_routes",
        "async fn connect_mark(": "connect suggestion mark route must stay in gateway_local_authorization_routes",
        "struct ConnectComposioRequest": "Composio connection DTOs must stay in gateway_composio_routes",
        "struct ConnectComposioResponse": "Composio connection DTOs must stay in gateway_composio_routes",
        "fn composio_base_url(": "Composio route helpers must stay in gateway_composio_routes",
        "fn connect_composio_blocking(": "Composio connection route helpers must stay in gateway_composio_routes",
        "async fn connect_composio(": "Composio connection route must stay in gateway_composio_routes",
        "struct ComposioToolkit": "Composio toolkit DTOs must stay in gateway_composio_routes",
        "struct ComposioToolkitsResponse": "Composio toolkit DTOs must stay in gateway_composio_routes",
        "struct GatewayComposioTransport": "Composio HTTP transport must stay in gateway_composio_routes",
        "fn composio_transport_for(": "Composio transport lookup must stay in gateway_composio_routes",
        "fn composio_toolkits_blocking(": "Composio toolkit route helpers must stay in gateway_composio_routes",
        "async fn composio_toolkits(": "Composio toolkit route must stay in gateway_composio_routes",
        "struct ComposioLinkRequest": "Composio link DTOs must stay in gateway_composio_routes",
        "struct ComposioLinkResponse": "Composio link DTOs must stay in gateway_composio_routes",
        "struct ComposioConnection": "Composio connection DTOs must stay in gateway_composio_routes",
        "struct ComposioConnectionsResponse": "Composio connection DTOs must stay in gateway_composio_routes",
        "fn composio_entity_id(": "Composio entity scoping must stay in gateway_composio_routes",
        "struct ComposioChatTools": "Composio chat-tool catalog DTO must stay in gateway_composio_routes",
        "fn composio_tool_is_read(": "Composio tool classification must stay in gateway_composio_routes",
        "fn tool_touches_calendar(": "connector perimeter heuristics must stay in gateway_composio_routes",
        "fn tool_touches_contacts(": "connector perimeter heuristics must stay in gateway_composio_routes",
        "fn humanize_composio_tool(": "Composio display labels must stay in gateway_composio_routes",
        "fn composio_connected_toolkits(": "Composio connected toolkit projection must stay in gateway_composio_routes",
        "type ComposioCatalogCache": "Composio catalog cache must stay in gateway_composio_routes",
        "fn composio_catalog_cache(": "Composio catalog cache must stay in gateway_composio_routes",
        "fn composio_catalog_ttl(": "Composio catalog cache must stay in gateway_composio_routes",
        "fn composio_catalog_invalidate(": "Composio catalog cache invalidation must stay in gateway_composio_routes",
        "fn composio_chat_tools_cached(": "Composio chat-tool catalog must stay in gateway_composio_routes",
        "fn composio_chat_tools(": "Composio chat-tool catalog must stay in gateway_composio_routes",
        "struct CapabilitySuggestions": "capability suggestion DTO must stay in gateway_composio_routes",
        "async fn suggest_capabilities(": "capability suggestion execution must stay in gateway_composio_routes",
        "fn parse_composio_fields(": "Composio auth field parsing must stay in gateway_composio_routes",
        "async fn composio_toolkit_auth(": "Composio auth route must stay in gateway_composio_routes",
        "fn composio_auth_config_resolve(": "Composio auth config resolution must stay in gateway_composio_routes",
        "fn composio_link_blocking(": "Composio link route helpers must stay in gateway_composio_routes",
        "async fn composio_link(": "Composio link route must stay in gateway_composio_routes",
        "fn composio_connections_blocking(": "Composio connection route helpers must stay in gateway_composio_routes",
        "async fn composio_connections(": "Composio connection route must stay in gateway_composio_routes",
        "fn composio_disconnect_blocking(": "Composio disconnect route helpers must stay in gateway_composio_routes",
        "async fn composio_disconnect(": "Composio disconnect route must stay in gateway_composio_routes",
        "fn composio_logo_urls(": "Composio logo proxy cache must stay in gateway_composio_routes",
        "fn composio_logo_cache(": "Composio logo proxy cache must stay in gateway_composio_routes",
        "const COMPOSIO_LOGO_MAX_BYTES": "Composio logo proxy limits must stay in gateway_composio_routes",
        "async fn composio_toolkit_logo(": "Composio logo route must stay in gateway_composio_routes",
        "fn composio_logo_response(": "Composio logo response helper must stay in gateway_composio_routes",
        "enum ConnectorErrorKind": "connector error classification must stay in gateway_connector_errors",
        "fn classify_connector_error(": "connector error classification must stay in gateway_connector_errors",
        "fn connector_error_hint(": "connector user hints must stay in gateway_connector_errors",
        "fn connector_error_kind_str(": "connector error labels must stay in gateway_connector_errors",
        "fn record_connector_run(": "connector audit logging must stay in gateway_connector_errors",
        "fn mcp_error_hint(": "MCP connector hints must stay in gateway_connector_errors",
        "fn composio_execution_error(": "Composio execution failure detection must stay in gateway_connector_errors",
        "fn default_image_base(": "image generation defaults must stay in gateway_image_generation",
        "fn image_env_key(": "image generation env keys must stay in gateway_image_generation",
        "fn image_provider_config(": "image generation provider routing must stay in gateway_image_generation",
        "fn image_timeout_secs(": "image generation timeout policy must stay in gateway_image_generation",
        "fn deck_slide_image_prompt(": "deck image prompt policy must stay in gateway_image_generation",
        "async fn generate_image_png(": "image provider execution must stay in gateway_image_generation",
        "const TASK_EXECUTOR_MANUAL_WORKER_ID": "task executor manual worker id must stay in gateway_task_executor_config",
        "const TASK_EXECUTOR_POLL_INTERVAL_MS": "task executor poll interval must stay in gateway_task_executor_config",
        "async fn chat_branches(": "chat branch list endpoint must stay in gateway_chat_branches",
        "async fn set_active_leaf(": "chat branch active leaf endpoint must stay in gateway_chat_branches",
        "async fn set_branch_label(": "chat branch label endpoint must stay in gateway_chat_branches",
        "async fn create_task_from_chat_message(": "chat message task endpoint must stay in gateway_chat_tasks",
        "async fn save_chat_message_to_memory(": "chat message memory-save endpoint must stay in gateway_chat_memory",
        "fn persist_explicit_memory(": "explicit chat memory persistence must stay in gateway_chat_memory",
        "fn wiki_title_from_text(": "chat memory wiki title helper must stay in gateway_chat_memory",
        "fn sanitize_wiki_filename(": "chat memory wiki filename helper must stay in gateway_chat_memory",
        "fn normalize_for_dedup(": "memory dedup normalization must stay in gateway_memory_dedup",
        "fn dedup_tokens(": "memory dedup tokenization must stay in gateway_memory_dedup",
        "fn jaccard(": "memory dedup scoring must stay in gateway_memory_dedup",
        "fn cosine(": "memory semantic dedup scoring must stay in gateway_memory_dedup",
        "const DEDUP_JACCARD:": "memory dedup threshold must stay in gateway_memory_dedup",
        "const DEDUP_COSINE:": "memory semantic dedup threshold must stay in gateway_memory_dedup",
        "fn anchors_are_similar(": "memory anchor similarity must stay in gateway_memory_dedup",
        "fn is_semantic_duplicate(": "memory semantic duplicate check must stay in gateway_memory_dedup",
        "fn forgotten_token_sets(": "memory forget suppression tokenization must stay in gateway_memory_dedup",
        "fn is_suppressed(": "memory forget suppression must stay in gateway_memory_dedup",
        "struct MemoryQueryEmbeddingCacheEntry": "memory query embedding cache entry must stay in gateway_memory_query_embeddings",
        "struct MemoryQueryEmbeddingCache": "memory query embedding cache must stay in gateway_memory_query_embeddings",
        "fn embed_model(": "memory embedding model config must stay in gateway_memory_query_embeddings",
        "fn embed_base(": "memory embedding base config must stay in gateway_memory_query_embeddings",
        "async fn embed_text(": "memory embedding HTTP transport must stay in gateway_memory_query_embeddings",
        "struct MemoryRecallTiming": "memory recall timing projection must stay in gateway_memory_query_embeddings",
        "fn memory_recall_timing_trace_line(": "memory recall timing formatter must stay in gateway_memory_query_embeddings",
        "async fn embed_query_for_memory_recall(": "memory recall query embedding transport must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache(": "memory query embedding cache singleton must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache_max_entries(": "memory query embedding cache sizing must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache_ttl(": "memory query embedding cache ttl must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_timeout(": "memory query embedding timeout must stay in gateway_memory_query_embeddings",
        "fn normalize_memory_embedding_query(": "memory query normalization must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache_key(": "memory query embedding cache key must stay in gateway_memory_query_embeddings",
        "async fn backfill_embeddings(": "memory embedding backfill must stay in gateway_memory_clients",
        "const CHAT_MEMORY_BUDGET_CHARS:": "memory briefing prompt budget must stay in gateway_memory_briefing",
        "fn briefing_authorized_sources(": "memory briefing authorized sources must stay in gateway_memory_briefing",
        "fn memory_briefing_source_fingerprint(": "memory briefing source fingerprint must stay in gateway_memory_briefing",
        "fn revalidated_cached_briefing": "memory briefing cache revalidation must stay in gateway_memory_briefing",
        "struct BriefingMemoryItem": "memory briefing item type must stay in gateway_memory_briefing",
        "fn briefing_items_for_authorized_source(": "memory briefing source item collection must stay in gateway_memory_briefing",
        "fn gather_profile_memory_for_prompt(": "memory briefing prompt gathering must stay in gateway_memory_briefing",
        "fn gather_profile_memory_for_intent_with_provenance(": "memory briefing provenance gathering must stay in gateway_memory_briefing",
        "fn gather_profile_memory_with_options(": "memory briefing test gathering helper must stay in gateway_memory_briefing",
        "fn gather_profile_memory_with_provenance(": "memory briefing provenance gathering must stay in gateway_memory_briefing",
        "struct FormattedMemoryBlock": "memory briefing formatted block type must stay in gateway_memory_briefing",
        "fn format_memory_block_with_provenance(": "memory briefing block formatting must stay in gateway_memory_briefing",
        "fn format_memory_block(": "memory briefing test formatter must stay in gateway_memory_briefing",
        "fn memory_intent_for_execution(": "memory briefing execution intent resolution must stay in gateway_memory_briefing",
        "struct MemoryInjectionPolicy": "memory briefing injection policy type must stay in gateway_memory_briefing",
        "fn memory_injection_policy(": "memory briefing injection policy must stay in gateway_memory_briefing",
        "fn memory_intent_allows_recall(": "memory briefing recall policy must stay in gateway_memory_briefing",
        "fn project_objective_block(": "memory turn objective injection must stay in gateway_memory_turn_context",
        "fn objective_block_for_workspace(": "memory turn objective derivation must stay in gateway_memory_turn_context",
        "fn project_brief_block(": "memory turn project brief injection must stay in gateway_memory_turn_context",
        "fn recent_work_block(": "memory turn recent-work injection must stay in gateway_memory_turn_context",
        "fn scope_from_active_workspace(": "memory turn scope projection must stay in gateway_memory_turn_context",
        "fn memory_scope_for_turn(": "memory turn thread scope projection must stay in gateway_memory_turn_context",
        "struct GatewayEmbeddingClient": "memory embedding client must stay in gateway_memory_clients",
        "struct GatewayLlmClient": "memory LLM client must stay in gateway_memory_clients",
        "impl local_first_memory::EmbeddingClient for GatewayEmbeddingClient": "memory embedding client impl must stay in gateway_memory_clients",
        "impl local_first_memory::LlmClient for GatewayLlmClient": "memory LLM client impl must stay in gateway_memory_clients",
        "struct InProcessMemoryRecallService": "memory recall service must stay in gateway_memory_recall_service",
        "fn install_memory_service_if_enabled(": "memory recall service installation must stay in gateway_memory_recall_service",
        "fn recall_pack_on_facade(": "memory recall facade projection must stay in gateway_memory_recall_service",
        "impl MemoryRecallService for InProcessMemoryRecallService": "memory recall service impl must stay in gateway_memory_recall_service",
        "fn normalize_project_scope_entities(": "memory graph maintenance normalization must stay in gateway_memory_graph_maintenance",
        "fn is_generic_self_word(": "memory graph mention self-word policy must stay in gateway_memory_graph_maintenance",
        "fn link_memory_mentions(": "memory graph mention linking must stay in gateway_memory_graph_maintenance",
        "fn link_mentions_core(": "memory graph mention linking core must stay in gateway_memory_graph_maintenance",
        "fn sweep_graph_orphans(": "memory graph orphan sweep must stay in gateway_memory_graph_maintenance",
        "fn regenerate_graph_links(": "memory graph regeneration must stay in gateway_memory_graph_maintenance",
        "fn reconcile_memory_scope(": "memory graph scope reconciliation must stay in gateway_memory_graph_maintenance",
        "struct MemoryGraphQuery": "memory graph route query DTO must stay in gateway_memory_graph_routes",
        "struct GraphNode": "memory graph route node DTO must stay in gateway_memory_graph_routes",
        "struct GraphEdge": "memory graph route edge DTO must stay in gateway_memory_graph_routes",
        "struct MemoryGraphResponse": "memory graph route response DTO must stay in gateway_memory_graph_routes",
        "fn resolve_memory_query_scope(": "memory graph route scope resolution must stay in gateway_memory_graph_routes",
        "struct MemoryGraphMergeRequest": "memory graph merge DTO must stay in gateway_memory_graph_routes",
        "fn graph_push_node(": "memory graph projection assembly must stay in gateway_memory_graph_routes",
        "fn graph_entity_alias_detail(": "memory graph projection alias detail must stay in gateway_memory_graph_routes",
        "fn project_graph_entity_duplicates_root(": "memory graph duplicate root filtering must stay in gateway_memory_graph_routes",
        "fn dedupe_graph_edges(": "memory graph projection edge dedupe must stay in gateway_memory_graph_routes",
        "fn ensure_project_graph_connectivity(": "memory graph projection connectivity must stay in gateway_memory_graph_routes",
        "struct GraphifyImportRequest": "memory graphify import DTO must stay in gateway_memory_graph_routes",
        "async fn memory_graphify_import(": "memory graphify import route must stay in gateway_memory_graph_routes",
        "async fn memory_graph(": "memory graph route must stay in gateway_memory_graph_routes",
        "async fn memory_graph_merge(": "memory graph merge route must stay in gateway_memory_graph_routes",
        "struct GoalsListQuery": "memory goals list query DTO must stay in gateway_memory_goals",
        "async fn memory_goals_list(": "memory goals list route must stay in gateway_memory_goals",
        "async fn memory_project_briefing(": "memory project briefing route must stay in gateway_memory_goals",
        "struct PromoteGoalsRequest": "memory goal promotion DTO must stay in gateway_memory_goals",
        "async fn memory_goals_promote(": "memory goals promote route must stay in gateway_memory_goals",
        "struct AddGoalRequest": "memory goal add DTO must stay in gateway_memory_goals",
        "async fn memory_goals_add(": "memory goals add route must stay in gateway_memory_goals",
        "struct SuggestGoalsRequest": "memory goal suggestion DTO must stay in gateway_memory_goals",
        "async fn memory_goals_suggest(": "memory goals suggest route must stay in gateway_memory_goals",
        "struct MemoryHygieneSuggestion": "memory hygiene suggestion type must stay in gateway_memory_hygiene",
        "fn normalized_entity_name(": "memory hygiene entity-name normalization must stay in gateway_memory_hygiene",
        "fn verified_identity_aliases(": "memory hygiene identity alias detection must stay in gateway_memory_hygiene",
        "fn memory_hygiene_suggestions_for_scope(": "memory hygiene suggestions must stay in gateway_memory_hygiene",
        "async fn memory_hygiene_suggestions(": "memory hygiene route must stay in gateway_memory_hygiene",
        "struct ContactFact": "contact profile DTO must stay in gateway_contact_profile",
        "struct ContactProfile": "contact profile response must stay in gateway_contact_profile",
        "async fn extract_contact_facts(": "contact profile distillation must stay in gateway_contact_profile",
        "async fn contact_profile(": "contact profile route must stay in gateway_contact_profile",
        "async fn contact_profile_refresh(": "contact profile refresh route must stay in gateway_contact_profile",
        "struct ContactChannel": "core contact DTO must stay in gateway_contacts",
        "struct ContactView": "core contact DTO must stay in gateway_contacts",
        "struct ChannelProfileView": "core contact DTO must stay in gateway_contacts",
        "struct ContactRefRequest": "core contact request DTO must stay in gateway_contacts",
        "struct ContactUpdateRequest": "core contact request DTO must stay in gateway_contacts",
        "struct ContactMergeRequest": "core contact request DTO must stay in gateway_contacts",
        "struct ContactCreateRequest": "core contact request DTO must stay in gateway_contacts",
        "struct ContactIdentityRequest": "core contact request DTO must stay in gateway_contacts",
        "fn parse_contact_ref(": "core contact ref parsing must stay in gateway_contacts",
        "fn contact_meta_str(": "core contact metadata helpers must stay in gateway_contacts",
        "fn contact_is_self(": "core contact identity helpers must stay in gateway_contacts",
        "fn contact_handles(": "core contact handle helpers must stay in gateway_contacts",
        "fn episode_texts_by_handles(": "core contact memory helpers must stay in gateway_contacts",
        "fn episodes_dated_by_handles(": "core contact memory helpers must stay in gateway_contacts",
        "fn episode_refs_by_date(": "core contact memory helpers must stay in gateway_contacts",
        "fn contact_view_from_stored(": "core contact projection must stay in gateway_contacts",
        "async fn contacts_list(": "core contact route must stay in gateway_contacts",
        "async fn contact_memories(": "core contact route must stay in gateway_contacts",
        "async fn contact_update(": "core contact route must stay in gateway_contacts",
        "async fn contacts_merge(": "core contact route must stay in gateway_contacts",
        "async fn contact_create(": "core contact route must stay in gateway_contacts",
        "async fn contact_identity_add(": "core contact identity route must stay in gateway_contacts",
        "async fn contact_identity_remove(": "core contact identity route must stay in gateway_contacts",
        "async fn contact_delete(": "core contact route must stay in gateway_contacts",
        "fn epoch_to_iso_date(": "core contact date helpers must stay in gateway_contacts",
        "fn parse_memory_date(": "core contact date helpers must stay in gateway_contacts",
        "struct PerimeterView": "contact perimeter DTO must stay in gateway_contact_perimeter",
        "struct PerimeterUpdateRequest": "contact perimeter request DTO must stay in gateway_contact_perimeter",
        "async fn contact_perimeter_get(": "contact perimeter route must stay in gateway_contact_perimeter",
        "async fn contact_perimeter_set(": "contact perimeter route must stay in gateway_contact_perimeter",
        "struct RelationshipView": "contact relationship DTO must stay in gateway_contact_relationships",
        "struct RelationshipAddRequest": "contact relationship request DTO must stay in gateway_contact_relationships",
        "struct RelationshipRemoveRequest": "contact relationship request DTO must stay in gateway_contact_relationships",
        "async fn contact_relationships(": "contact relationship route must stay in gateway_contact_relationships",
        "fn mirror_contact_relationship_to_memory_graph(": "contact relationship graph mirror must stay in gateway_contact_relationships",
        "struct ProfileView": "named contact profile DTO must stay in gateway_contact_profiles",
        "struct ProfileCreateRequest": "named contact profile request DTO must stay in gateway_contact_profiles",
        "struct ProfileUpdateRequest": "named contact profile request DTO must stay in gateway_contact_profiles",
        "struct ProfileDeleteRequest": "named contact profile request DTO must stay in gateway_contact_profiles",
        "struct ContactAssignProfileRequest": "named contact profile assignment DTO must stay in gateway_contact_profiles",
        "async fn profiles_list(": "named contact profile route must stay in gateway_contact_profiles",
        "async fn profile_create(": "named contact profile route must stay in gateway_contact_profiles",
        "async fn profile_update(": "named contact profile route must stay in gateway_contact_profiles",
        "async fn profile_delete(": "named contact profile route must stay in gateway_contact_profiles",
        "async fn contact_assign_profile(": "named contact profile assignment route must stay in gateway_contact_profiles",
        "fn persist_graph(": "memory graph persistence routing must stay in gateway_memory_graph_persistence",
        "fn persist_graph_scope(": "memory graph scope persistence must stay in gateway_memory_graph_persistence",
        "fn recall_memory_tool_schema(": "memory tool schemas must stay in gateway_memory_tools",
        "fn record_decision_tool_schema(": "memory tool schemas must stay in gateway_memory_tools",
        "fn record_decision(": "memory decision recording must stay in gateway_memory_tools",
        "struct MemoryDecideRequest": "memory decide DTO must stay in gateway_memory_tools",
        "async fn memory_decide(": "memory decide route must stay in gateway_memory_tools",
        "fn forget_memory_tool_schema(": "memory tool schemas must stay in gateway_memory_tools",
        "fn forget_in_scope(": "memory forget search must stay in gateway_memory_tools",
        "fn forget_topic_in_scope(": "memory topic forget must stay in gateway_memory_tools",
        "fn forget_memory(": "memory forget orchestration must stay in gateway_memory_tools",
        "fn strip_json_fences(": "memory JSON response parsing must stay in gateway_memory_json",
        "async fn call_memory_json(": "memory JSON transport must stay in gateway_memory_json",
        "struct RecallOutcome": "memory recall tool result must stay in gateway_memory_recall_tool",
        "fn recall_stream_payload_from_outcome(": "memory recall payload projection must stay in gateway_memory_recall_tool",
        "fn recall_memory(": "memory recall tool execution must stay in gateway_memory_recall_tool",
        "fn learn_via_service_or_inline(": "memory learning orchestration must stay in gateway_memory_learning",
        "async fn consolidate_scope(": "memory consolidation orchestration must stay in gateway_memory_learning",
        "fn update_plan_tool_schema(": "runtime plan tool schemas must stay in gateway_plan_tools",
        "fn step_advance_tool_schema(": "runtime plan tool schemas must stay in gateway_plan_tools",
        "fn plan_steps_reconciled_on_delivery(": "runtime plan delivery reconcile must stay in gateway_runtime_plan_state",
        "fn runtime_plan_thread_key(": "runtime plan thread scoping must stay in gateway_runtime_plan_state",
        "fn runtime_plan_control_scope(": "runtime plan control scoping must stay in gateway_runtime_plan_state",
        "fn runtime_plan_memory_text(": "runtime plan memory projection must stay in gateway_runtime_plan_state",
        "fn runtime_plan_memory_metadata(": "runtime plan memory projection must stay in gateway_runtime_plan_state",
        "fn canonical_plan_value(": "runtime plan canonical shape must stay in gateway_runtime_plan_state",
        "fn plan_value_from(": "runtime plan value bridge must stay in gateway_runtime_plan_state",
        "fn runtime_execution_plan(": "runtime plan orchestrator bridge must stay in gateway_runtime_plan_state",
        "fn execution_plan_steps(": "runtime plan step projection must stay in gateway_runtime_plan_state",
        "fn merge_execution_plan(": "runtime plan merge must stay in gateway_runtime_plan_state",
        "fn runtime_plan_record_from_state(": "runtime plan store read must stay in gateway_runtime_plan_state",
        "fn record_runtime_plan_step_outcome_from_state(": "runtime plan outcome write must stay in gateway_runtime_plan_state",
        "fn upsert_runtime_plan_memory_from_state(": "runtime plan store write must stay in gateway_runtime_plan_state",
        "fn merge_plan(": "runtime plan merge must stay in gateway_runtime_plan_state",
        "fn plan_tool_sent(": "runtime plan tool argument parsing must stay in gateway_runtime_plan_state",
        "pub(crate) struct GatewayPlanProgress": "engine plan progress port must stay in gateway_runtime_plan_state",
        "const THREADS_WORKSPACE:": "thread episode memory workspace must stay in gateway_thread_episodes",
        "fn store_episode(": "thread episode persistence must stay in gateway_thread_episodes",
        "fn current_thread_episode_block(": "thread episode prompt block must stay in gateway_thread_episodes",
        "fn episode_metadata_matches_scope(": "thread episode scope matching must stay in gateway_thread_episodes",
        "const MAX_PROJECT_INSTRUCTION_CHARS": "project instruction limits must stay in gateway_prompt_packets",
        "fn read_project_instruction(": "project instruction reads must stay in gateway_prompt_packets",
        "fn compose_gateway_prompt_packets(": "prompt packet composition must stay in gateway_prompt_packets",
        "const CAPABLE_MODEL_CONTEXT_WINDOW": "brain context-window threshold must stay in gateway_brain_runtime",
        "struct GatewayBrainMemory": "brain memory adapter must stay in gateway_brain_runtime",
        "fn brain_materialize_enabled(": "brain enablement flag must stay in gateway_brain_runtime",
        "fn open_brain_memory(": "brain memory opening must stay in gateway_brain_runtime",
        "fn brain_budgets_for_context_window(": "brain budget policy must stay in gateway_brain_runtime",
        "fn brain_materialize_tasks(": "durable Brain task materialization must stay in gateway_brain_materialization",
        "fn link_brain_tasks_to_thread(": "Brain task thread linkage must stay in gateway_brain_materialization",
        "fn set_session_progress_total(": "Brain task session progress seeding must stay in gateway_brain_materialization",
        "fn strip_chat_markers(": "chat marker stripping must stay in gateway_chat_markers",
        "fn query_code_graph_tool_schema(": "project search tool schemas must stay in gateway_project_search_tools",
        "fn query_git_history_tool_schema(": "project search tool schemas must stay in gateway_project_search_tools",
        "fn github_search_tool_schema(": "project search tool schemas must stay in gateway_project_search_tools",
        "async fn github_search(": "github repository search must stay in gateway_project_search_tools",
        "fn query_git_history(": "git history search must stay in gateway_project_search_tools",
        "fn query_code_graph(": "code graph search must stay in gateway_project_search_tools",
        "fn resolve_datetime_tool_schema(": "datetime tool schema must stay in gateway_datetime_tools",
        "fn plan_stall_abort_enabled(": "runtime environment flags must stay in gateway_runtime_flags",
        "const MAX_PLAN_STALL_RESUMES:": "runtime plan stall budget must stay in gateway_plan_stall",
        "fn next_plan_stall(": "runtime plan stall budget must stay in gateway_plan_stall",
        "fn plan_stall_exhausted(": "runtime plan stall budget must stay in gateway_plan_stall",
        "fn block_stalled_step(": "runtime plan stall budget must stay in gateway_plan_stall",
        "fn plan_stall_check_and_bump(": "runtime plan stall budget must stay in gateway_plan_stall",
        "const MAX_TOOL_ROUNDS:": "runtime tool budget must stay in gateway_tool_budget",
        "const HARD_ROUND_CEILING:": "runtime tool budget must stay in gateway_tool_budget",
        "fn hard_round_ceiling(": "runtime tool budget must stay in gateway_tool_budget",
        "fn chat_max_rounds(": "runtime tool budget must stay in gateway_tool_budget",
        "const CORE_TOOL_NAMES:": "runtime tool live-set policy must stay in gateway_tool_budget",
        "fn tool_stays_live_this_turn(": "runtime tool live-set policy must stay in gateway_tool_budget",
        "fn mcp_call_timeout(": "tool timeout policy must stay in gateway_tool_timeouts",
        "fn confirm_marker_value(": "action confirmation marker parsing must stay in gateway_action_confirmations",
        "fn confirm_marker_matches_approval(": "action confirmation marker approval matching must stay in gateway_action_confirmations",
        "const MCP_CONFIRM_OPEN:": "MCP confirmation marker constants must stay in gateway_action_confirmations",
        "fn mcp_confirm_matches(": "MCP confirmation matching must stay in gateway_action_confirmations",
        "fn mcp_confirm_matches_approval(": "MCP remote approval matching must stay in gateway_action_confirmations",
        "fn rewrite_mcp_confirm_to_done(": "MCP confirmation rewrite must stay in gateway_action_confirmations",
        "const COMPOSIO_CONFIRM_OPEN:": "Composio confirmation marker constants must stay in gateway_action_confirmations",
        "fn composio_confirm_matches(": "Composio confirmation matching must stay in gateway_action_confirmations",
        "fn rewrite_confirm_to_done(": "Composio confirmation rewrite must stay in gateway_action_confirmations",
        "enum ActionableSourceResolution": "actionable source resolution must stay in gateway_actionable_source",
        "fn actionable_source_terminal_text(": "actionable source terminal text must stay in gateway_actionable_source",
        "fn actionable_claim_error(": "actionable source claim errors must stay in gateway_actionable_source",
        "fn terminal_actionable_execution_error(": "terminal actionable execution errors must stay in gateway_actionable_source",
        "fn claim_actionable_source<": "actionable source claim must stay in gateway_actionable_source",
        "fn resolve_actionable_source<": "actionable source resolution must stay in gateway_actionable_source",
        "fn mcp_chat_tool_name(": "MCP chat tool naming must stay in gateway_mcp_chat_tools",
        "fn parse_mcp_chat_name(": "MCP chat tool parsing must stay in gateway_mcp_chat_tools",
        "struct McpChatTools": "MCP chat tool catalogue DTO must stay in gateway_mcp_chat_tools",
        "fn mcp_chat_tools(": "MCP chat tool catalogue must stay in gateway_mcp_chat_tools",
        "fn mcp_stdio_config_from_metadata(": "MCP stdio metadata parsing must stay in gateway_mcp_runtime",
        "fn mcp_stdio_config_to_metadata(": "MCP stdio metadata serialization must stay in gateway_mcp_runtime",
        "fn mcp_http_config_to_metadata(": "MCP HTTP metadata serialization must stay in gateway_mcp_runtime",
        "fn mcp_http_headers_to_secret(": "MCP HTTP header secret encoding must stay in gateway_mcp_runtime",
        "fn mcp_http_headers_from_secret(": "MCP HTTP header secret decoding must stay in gateway_mcp_runtime",
        "fn migrate_legacy_mcp_http_header_secrets(": "MCP legacy secret migration must stay in gateway_mcp_runtime",
        "enum McpAnyTransport": "MCP transport adapter must stay in gateway_mcp_runtime",
        "fn build_mcp_transport(": "MCP transport construction must stay in gateway_mcp_runtime",
        "fn mcp_provider_slug(": "MCP provider id slugging must stay in gateway_mcp_runtime",
        "fn mcp_discover_and_cache_tools(": "MCP discovery/cache runtime must stay in gateway_mcp_runtime",
        "fn run_mcp_chat_tool(": "MCP chat execution runtime must stay in gateway_mcp_runtime",
        "struct ConnectMcpRequest": "MCP connection DTOs must stay in gateway_mcp_connections",
        "fn connect_mcp_blocking(": "MCP connection persistence must stay in gateway_mcp_connections",
        "async fn connect_mcp(": "MCP connect route must stay in gateway_mcp_connections",
        "struct McpRegistryQuery": "MCP registry query DTO must stay in gateway_mcp_connections",
        "async fn mcp_registry_search(": "MCP registry route must stay in gateway_mcp_connections",
        "struct McpConnectedServer": "MCP connected-list DTO must stay in gateway_mcp_connections",
        "fn mcp_connected_list(": "MCP connected-list projection must stay in gateway_mcp_connections",
        "async fn mcp_connected(": "MCP connected-list route must stay in gateway_mcp_connections",
        "struct McpDisconnectRequest": "MCP disconnect DTO must stay in gateway_mcp_connections",
        "fn mcp_disconnect_blocking(": "MCP disconnect persistence must stay in gateway_mcp_connections",
        "async fn mcp_disconnect(": "MCP disconnect route must stay in gateway_mcp_connections",
        "struct McpExecuteRequest": "MCP execution DTOs must stay in gateway_mcp_execution",
        "struct McpExecuteResponse": "MCP execution DTOs must stay in gateway_mcp_execution",
        "fn mcp_server_allow_marker(": "MCP server allow marker derivation must stay in gateway_mcp_execution",
        "async fn mcp_execute(": "MCP execution route must stay in gateway_mcp_execution",
        "struct DockerStatus ": "system status Docker DTO must stay in gateway_system_status",
        "struct SystemStatusResponse ": "system status response DTO must stay in gateway_system_status",
        "fn gateway_memory_mb(": "gateway memory measurement must stay in gateway_system_status",
        "fn parse_docker_mem_mb(": "Docker memory parsing must stay in gateway_system_status",
        "async fn system_status(": "system status route must stay in gateway_system_status",
        "fn composio_tool_allow_path(": "write-tool allow-list paths must stay in gateway_write_tool_allowlist",
        "struct ComposioToolAllow": "write-tool allow-list persistence DTO must stay in gateway_write_tool_allowlist",
        "fn load_composio_tool_allow(": "write-tool allow-list loading must stay in gateway_write_tool_allowlist",
        "fn tool_allowed_in_set(": "write-tool allow-list matching must stay in gateway_write_tool_allowlist",
        "fn composio_tool_allowed(": "write-tool allow-list matching must stay in gateway_write_tool_allowlist",
        "fn write_composio_tool_allow(": "write-tool allow-list persistence must stay in gateway_write_tool_allowlist",
        "fn add_composio_tool_allow(": "write-tool allow-list persistence must stay in gateway_write_tool_allowlist",
        "fn remove_composio_tool_allow(": "write-tool allow-list persistence must stay in gateway_write_tool_allowlist",
        "struct AllowedToolView": "write-tool allow-list route DTOs must stay in gateway_write_tool_allowlist",
        "struct AllowedToolsResponse": "write-tool allow-list route DTOs must stay in gateway_write_tool_allowlist",
        "async fn composio_allowed_tools(": "write-tool allow-list routes must stay in gateway_write_tool_allowlist",
        "async fn composio_revoke_allowed_tool(": "write-tool allow-list routes must stay in gateway_write_tool_allowlist",
        "fn path_within(": "canonical path containment must stay in gateway_file_security",
        "fn thread_folders_path(": "thread linked-folder paths must stay in gateway_thread_files",
        "fn load_thread_folders(": "thread linked-folder persistence must stay in gateway_thread_files",
        "fn write_thread_folders(": "thread linked-folder persistence must stay in gateway_thread_files",
        "fn thread_folder(": "thread linked-folder resolution must stay in gateway_thread_files",
        "fn effective_thread_folder(": "thread effective-folder resolution must stay in gateway_thread_files",
        "fn search_folder_files(": "thread file search must stay in gateway_thread_files",
        "struct ThreadFolderResponse": "thread folder route DTOs must stay in gateway_thread_files",
        "struct SetThreadFolderRequest": "thread folder route DTOs must stay in gateway_thread_files",
        "async fn get_thread_folder(": "thread folder routes must stay in gateway_thread_files",
        "async fn set_thread_folder(": "thread folder routes must stay in gateway_thread_files",
        "struct ThreadFilesQuery": "thread file route DTOs must stay in gateway_thread_files",
        "struct ThreadFilesResponse": "thread file route DTOs must stay in gateway_thread_files",
        "async fn search_thread_files(": "thread file routes must stay in gateway_thread_files",
        "struct ThreadFileQuery": "thread file route DTOs must stay in gateway_thread_files",
        "struct ThreadFileResponse": "thread file route DTOs must stay in gateway_thread_files",
        "const MAX_CONTEXT_FILE_BYTES": "thread file read limits must stay in gateway_thread_files",
        "async fn read_thread_file(": "thread file routes must stay in gateway_thread_files",
        "struct TranscribeRequest": "chat transcription DTOs must stay in gateway_transcription",
        "struct TranscribeResponse": "chat transcription DTOs must stay in gateway_transcription",
        "fn decode_audio_bytes(": "chat transcription audio validation must stay in gateway_transcription",
        "async fn transcribe_audio(": "chat transcription route must stay in gateway_transcription",
        "struct UsageWindowQuery": "usage route DTOs must stay in gateway_usage_routes",
        "fn default_usage_window(": "usage route defaults must stay in gateway_usage_routes",
        "fn parse_usage_window(": "usage route parsing must stay in gateway_usage_routes",
        "fn usage_now_i64(": "usage route clock adapter must stay in gateway_usage_routes",
        "async fn get_usage_summary(": "usage routes must stay in gateway_usage_routes",
        "async fn get_usage_daily(": "usage routes must stay in gateway_usage_routes",
        "async fn usage_breakdown(": "usage route helpers must stay in gateway_usage_routes",
        "async fn get_usage_models(": "usage routes must stay in gateway_usage_routes",
        "struct ProviderAccountingRow": "usage provider DTOs must stay in gateway_usage_routes",
        "async fn get_usage_providers(": "usage routes must stay in gateway_usage_routes",
        "async fn get_usage_processes(": "usage routes must stay in gateway_usage_routes",
        "struct UsageSuggestionsQuery": "usage suggestion DTOs must stay in gateway_usage_routes",
        "fn default_usage_suggestion_scope(": "usage suggestion defaults must stay in gateway_usage_routes",
        "async fn get_usage_suggestions(": "usage suggestion routes must stay in gateway_usage_routes",
        "fn build_usage_suggestions(": "usage suggestion assembly must stay in gateway_usage_routes",
        "fn usage_suggestion_read_error(": "usage suggestion errors must stay in gateway_usage_routes",
        "fn predicted_candidate_cost(": "usage suggestion cost prediction must stay in gateway_usage_routes",
        "fn provider_headroom_percent(": "usage suggestion headroom calculation must stay in gateway_usage_routes",
        "fn find_usage_suggestion(": "usage suggestion lookup must stay in gateway_usage_routes",
        "async fn apply_usage_suggestion(": "usage suggestion routes must stay in gateway_usage_routes",
        "async fn dismiss_usage_suggestion(": "usage suggestion routes must stay in gateway_usage_routes",
        "struct SetProviderUsagePolicyRequest": "usage provider policy DTOs must stay in gateway_usage_routes",
        "fn default_usage_currency(": "usage provider policy defaults must stay in gateway_usage_routes",
        "async fn get_usage_provider_policy(": "usage provider policy routes must stay in gateway_usage_routes",
        "async fn set_usage_provider_policy(": "usage provider policy routes must stay in gateway_usage_routes",
        "async fn refresh_usage_provider(": "usage provider refresh routes must stay in gateway_usage_routes",
        "struct CreateTagRequest ": "tag route DTOs must stay in gateway_tags",
        "struct TagAssignRequest ": "tag route DTOs must stay in gateway_tags",
        "fn parse_tag_entity(": "tag entity parsing must stay in gateway_tags",
        "async fn tags_list(": "tag routes must stay in gateway_tags",
        "async fn tags_create(": "tag routes must stay in gateway_tags",
        "async fn tags_rename(": "tag routes must stay in gateway_tags",
        "async fn tags_set_color(": "tag routes must stay in gateway_tags",
        "async fn tags_delete(": "tag routes must stay in gateway_tags",
        "async fn tags_assign(": "tag routes must stay in gateway_tags",
        "async fn tags_unassign(": "tag routes must stay in gateway_tags",
        "async fn tags_entities(": "tag routes must stay in gateway_tags",
        "async fn tags_for_entity_handler(": "tag routes must stay in gateway_tags",
        "async fn tags_all_assignments(": "tag routes must stay in gateway_tags",
        "fn update_webhook(": "update webhook config must stay in gateway_update_routes",
        "struct UpdateInfoResponse": "update route DTOs must stay in gateway_update_routes",
        "struct UpdateTriggerResponse": "update route DTOs must stay in gateway_update_routes",
        "async fn update_info(": "update routes must stay in gateway_update_routes",
        "async fn update_trigger(": "update routes must stay in gateway_update_routes",
        "struct SkillsState": "skill route state DTOs must stay in gateway_skill_routes",
        "fn skills_state_path(": "skill route state paths must stay in gateway_skill_routes",
        "fn load_skills_disabled(": "skill enablement state must stay in gateway_skill_routes",
        "fn save_skills_disabled(": "skill enablement state must stay in gateway_skill_routes",
        "struct SkillsResponse": "skill route DTOs must stay in gateway_skill_routes",
        "struct SetSkillEnabledRequest": "skill route DTOs must stay in gateway_skill_routes",
        "fn skills_origins_path(": "skill route origin paths must stay in gateway_skill_routes",
        "fn load_skills_origins(": "skill origin state must stay in gateway_skill_routes",
        "fn save_skills_origins(": "skill origin state must stay in gateway_skill_routes",
        "fn current_skills_response(": "skill route response projection must stay in gateway_skill_routes",
        "async fn list_skills(": "skill routes must stay in gateway_skill_routes",
        "struct SkillDetailResponse": "skill route DTOs must stay in gateway_skill_routes",
        "async fn skill_detail(": "skill routes must stay in gateway_skill_routes",
        "async fn set_skill_enabled(": "skill routes must stay in gateway_skill_routes",
        "fn skills_catalog_path(": "skill catalog path must stay in gateway_skill_routes",
        "struct CatalogQuery": "skill catalog DTOs must stay in gateway_skill_routes",
        "struct CatalogResponse": "skill catalog DTOs must stay in gateway_skill_routes",
        "fn catalog_response(": "skill catalog response projection must stay in gateway_skill_routes",
        "async fn skill_catalog(": "skill catalog routes must stay in gateway_skill_routes",
        "async fn skill_catalog_refresh(": "skill catalog routes must stay in gateway_skill_routes",
        "struct CatalogInstallRequest": "skill catalog install DTOs must stay in gateway_skill_routes",
        "fn valid_catalog_owner(": "skill catalog validation must stay in gateway_skill_routes",
        "fn validated_catalog_owner(": "skill catalog validation must stay in gateway_skill_routes",
        "fn clawhub_origin(": "skill catalog origin projection must stay in gateway_skill_routes",
        "async fn install_catalog_skill(": "skill catalog routes must stay in gateway_skill_routes",
        "struct CatalogPreviewQuery": "skill catalog preview DTOs must stay in gateway_skill_routes",
        "struct CatalogPreview": "skill catalog preview DTOs must stay in gateway_skill_routes",
        "async fn preview_catalog_skill(": "skill catalog routes must stay in gateway_skill_routes",
        "const CURATED_SKILL_REPOS:": "skill registry config must stay in gateway_skill_routes",
        "const SKILL_REGISTRY_MAX:": "skill registry limits must stay in gateway_skill_routes",
        "struct RegistrySkill": "skill registry DTOs must stay in gateway_skill_routes",
        "struct RegistryResponse": "skill registry DTOs must stay in gateway_skill_routes",
        "struct RegistryQuery": "skill registry DTOs must stay in gateway_skill_routes",
        "struct InstallSkillRequest": "skill registry DTOs must stay in gateway_skill_routes",
        "fn valid_github_repo(": "skill registry GitHub validation must stay in gateway_skill_routes",
        "fn github_token(": "skill registry GitHub auth must stay in gateway_skill_routes",
        "fn github_get(": "skill registry GitHub client must stay in gateway_skill_routes",
        "fn github_err(": "skill registry GitHub errors must stay in gateway_skill_routes",
        "async fn github_default_branch(": "skill registry GitHub fetch must stay in gateway_skill_routes",
        "async fn github_tree(": "skill registry GitHub fetch must stay in gateway_skill_routes",
        "async fn github_raw_bytes(": "skill registry GitHub fetch must stay in gateway_skill_routes",
        "fn skill_id_for(": "skill registry install id derivation must stay in gateway_skill_routes",
        "async fn registry_skills(": "skill registry routes must stay in gateway_skill_routes",
        "async fn install_registry_skill(": "skill registry routes must stay in gateway_skill_routes",
        "const MEMORY_PUBLICATION_BODY_MAX:": "memory publication body limit must stay in gateway_memory_publications",
        "struct MemoryPublicationCreateRequest": "memory publication DTOs must stay in gateway_memory_publications",
        "struct MemoryPublicationApproveRequest": "memory publication DTOs must stay in gateway_memory_publications",
        "struct MemoryPublicationEditRequest": "memory publication DTOs must stay in gateway_memory_publications",
        "struct MemoryPublicationRejectRequest": "memory publication DTOs must stay in gateway_memory_publications",
        "fn memory_publication_error(": "memory publication error mapping must stay in gateway_memory_publications",
        "fn memory_publication_facade_error(": "memory publication facade error mapping must stay in gateway_memory_publications",
        "fn publication_workspace_from_snapshot(": "memory publication workspace validation must stay in gateway_memory_publications",
        "fn validate_publication_owner_scope(": "memory publication owner validation must stay in gateway_memory_publications",
        "fn parse_publication_reference(": "memory publication reference validation must stay in gateway_memory_publications",
        "async fn memory_publication_create(": "memory publication routes must stay in gateway_memory_publications",
        "async fn memory_publication_get(": "memory publication routes must stay in gateway_memory_publications",
        "async fn memory_publication_edit(": "memory publication routes must stay in gateway_memory_publications",
        "async fn memory_publication_approve(": "memory publication routes must stay in gateway_memory_publications",
        "async fn memory_publication_reject(": "memory publication routes must stay in gateway_memory_publications",
        "struct MemorySourceOverrideInput": "memory source DTOs must stay in gateway_memory_sources",
        "struct MemorySourceUpsertRequest": "memory source DTOs must stay in gateway_memory_sources",
        "struct ValidatedMemorySourceInput": "memory source validation DTOs must stay in gateway_memory_sources",
        "struct MemorySourceWorkspaceContext": "memory source workspace validation must stay in gateway_memory_sources",
        "struct MemorySourceGrantView": "memory source API projections must stay in gateway_memory_sources",
        "struct MemorySourceGrantOverrideView": "memory source API projections must stay in gateway_memory_sources",
        "struct MemorySourceCandidateView": "memory source API projections must stay in gateway_memory_sources",
        "struct MemorySourceCandidatesQuery": "memory source query DTOs must stay in gateway_memory_sources",
        "fn memory_sources_flag(": "memory source feature flag parsing must stay in gateway_memory_sources",
        "fn memory_sources_enabled(": "memory source feature flag parsing must stay in gateway_memory_sources",
        "fn memory_perimeter_allows_recall(": "memory source recall perimeter must stay in gateway_memory_sources",
        "fn parse_memory_collection(": "memory source policy parsing must stay in gateway_memory_sources",
        "fn parse_grant_sensitivity(": "memory source policy parsing must stay in gateway_memory_sources",
        "fn validate_memory_source_input(": "memory source policy validation must stay in gateway_memory_sources",
        "fn validate_memory_source_workspaces(": "memory source workspace validation must stay in gateway_memory_sources",
        "fn validate_memory_source_consumer(": "memory source workspace validation must stay in gateway_memory_sources",
        "fn memory_source_bad_request(": "memory source error mapping must stay in gateway_memory_sources",
        "fn memory_source_disabled_error(": "memory source error mapping must stay in gateway_memory_sources",
        "fn memory_source_facade_error(": "memory source error mapping must stay in gateway_memory_sources",
        "fn all_memory_collections(": "memory source collection projection must stay in gateway_memory_sources",
        "fn memory_source_workspace_label(": "memory source workspace projection must stay in gateway_memory_sources",
        "fn memory_source_grant_views": "memory source grant projection must stay in gateway_memory_sources",
        "fn memory_source_candidates_from_records(": "memory source candidate projection must stay in gateway_memory_sources",
        "fn build_memory_source_grant(": "memory source grant assembly must stay in gateway_memory_sources",
        "fn validate_memory_source_overrides(": "memory source override validation must stay in gateway_memory_sources",
        "fn load_persisted_memory_source_workspace_ids(": "memory source authorization registry read must stay in gateway_memory_sources",
        "async fn memory_sources_list(": "memory source routes must stay in gateway_memory_sources",
        "async fn memory_source_upsert(": "memory source routes must stay in gateway_memory_sources",
        "async fn memory_source_revoke(": "memory source routes must stay in gateway_memory_sources",
        "async fn memory_source_candidates(": "memory source routes must stay in gateway_memory_sources",
        "struct ProjectAccessGrant ": "project access DTOs must stay in gateway_project_access",
        "struct ProjectAccessFile ": "project access persistence DTOs must stay in gateway_project_access",
        "struct EffectiveProjectContactPolicy ": "project access policy DTOs must stay in gateway_project_access",
        "struct ProjectAccessUpsertRequest ": "project access route DTOs must stay in gateway_project_access",
        "struct ProjectAccessRemoveRequest ": "project access route DTOs must stay in gateway_project_access",
        "fn normalize_project_access_grant(": "project access normalization must stay in gateway_project_access",
        "fn load_project_access_file(": "project access persistence must stay in gateway_project_access",
        "fn save_project_access_file(": "project access persistence must stay in gateway_project_access",
        "fn list_project_access(": "project access listing must stay in gateway_project_access",
        "fn upsert_project_access(": "project access persistence must stay in gateway_project_access",
        "fn remove_project_access(": "project access persistence must stay in gateway_project_access",
        "fn resolve_project_contact_policy(": "project contact policy resolution must stay in gateway_project_access",
        "async fn project_access_list(": "project access routes must stay in gateway_project_access",
        "async fn project_access_upsert(": "project access routes must stay in gateway_project_access",
        "async fn project_access_remove(": "project access routes must stay in gateway_project_access",
        "struct WorkspaceRecord ": "workspace registry DTOs must stay in gateway_workspaces",
        "struct WorkspacesFile ": "workspace registry DTOs must stay in gateway_workspaces",
        "struct WorkspacesResponse ": "workspace route DTOs must stay in gateway_workspaces",
        "struct CreateWorkspaceRequest ": "workspace route DTOs must stay in gateway_workspaces",
        "struct SetWorkspaceFolderRequest ": "workspace route DTOs must stay in gateway_workspaces",
        "struct RenameWorkspaceRequest ": "workspace route DTOs must stay in gateway_workspaces",
        "struct ReorderWorkspacesRequest ": "workspace route DTOs must stay in gateway_workspaces",
        "fn load_workspaces_file(": "workspace registry persistence must stay in gateway_workspaces",
        "fn active_workspace_folder(": "workspace active-folder projection must stay in gateway_workspaces",
        "fn save_workspaces_file(": "workspace registry persistence must stay in gateway_workspaces",
        "fn normalize_sandbox_override(": "workspace policy parsing must stay in gateway_workspaces",
        "fn normalize_approval_override(": "workspace policy parsing must stay in gateway_workspaces",
        "fn merge_workspace_policy(": "workspace policy merge must stay in gateway_workspaces",
        "fn upsert_workspace_root_memory_entity(": "workspace memory-root sync must stay in gateway_workspaces",
        "fn init_active_workspace_from_disk(": "workspace boot selection must stay in gateway_workspaces",
        "async fn workspaces_list(": "workspace routes must stay in gateway_workspaces",
        "async fn create_workspace(": "workspace routes must stay in gateway_workspaces",
        "async fn set_workspace_folder(": "workspace routes must stay in gateway_workspaces",
        "async fn rename_workspace(": "workspace routes must stay in gateway_workspaces",
        "async fn delete_workspace(": "workspace routes must stay in gateway_workspaces",
        "async fn reorder_workspaces(": "workspace routes must stay in gateway_workspaces",
        "fn purge_workspace_data(": "workspace deletion purge must stay in gateway_workspaces",
        "async fn select_workspace(": "workspace routes must stay in gateway_workspaces",
        "fn find_capability_tool_schema(": "capability discovery schemas must stay in gateway_capability_registry",
        "enum CapabilitySource ": "capability registry source typing must stay in gateway_capability_registry",
        "struct CapabilityEntry ": "capability registry entries must stay in gateway_capability_registry",
        "fn capability_entry_from_tool_schema(": "capability registry schema conversion must stay in gateway_capability_registry",
        "fn mcp_capability_entries(": "capability registry MCP projection must stay in gateway_capability_registry",
        "fn connector_capability_entry(": "capability registry connector projection must stay in gateway_capability_registry",
        "fn bm25_rank(": "capability registry ranking must stay in gateway_capability_registry",
        "fn search_connector_capability_entries(": "capability registry connector search must stay in gateway_capability_registry",
        "fn capability_discovery_trace_line(": "capability registry tracing must stay in gateway_capability_registry",
        "fn suggest_capabilities_tool_schema(": "capability suggestion schemas must stay in gateway_capability_registry",
        "let mut capability_corpus: Vec<CapabilityEntry>": "capability corpus materialization must stay in gateway_capability_registry",
        "for schema in deferred_tools {": "deferred tool corpus projection must stay in gateway_capability_registry",
        "struct CapabilityConnectionResponse": "capability snapshot DTOs must stay in gateway_capability_registry",
        "struct CapabilityToolResponse": "capability snapshot DTOs must stay in gateway_capability_registry",
        "struct CapabilityPolicyResponse": "capability snapshot DTOs must stay in gateway_capability_registry",
        "struct CapabilitySnapshotResponse": "capability snapshot DTOs must stay in gateway_capability_registry",
        "fn capability_snapshot_response(": "capability snapshot read model must stay in gateway_capability_registry",
        "fn capability_connection_response(": "capability snapshot read model must stay in gateway_capability_registry",
        "fn capability_tool_response(": "capability snapshot read model must stay in gateway_capability_registry",
        "fn open_seeded_capability_registry(": "capability registry bootstrap must stay in gateway_capability_registry",
        "fn seed_default_capabilities(": "capability registry bootstrap must stay in gateway_capability_registry",
        "fn browser_registry_cached_tools(": "capability browser seed tools must stay in gateway_capability_registry",
        "struct ComputerArtifactPreviewResponse ": "local computer preview DTO must stay in gateway_browser_runtime",
        "async fn local_computer_session(": "local computer session route must stay in gateway_browser_runtime",
        "async fn local_computer_artifact_preview(": "local computer artifact preview route must stay in gateway_browser_runtime",
        "fn resolve_contained_computer_cdp(": "local computer CDP resolution must stay in gateway_browser_runtime",
        "fn resolve_contained_computer_novnc(": "local computer noVNC resolution must stay in gateway_browser_runtime",
        "struct ComputerReadiness ": "local computer readiness DTO must stay in gateway_browser_runtime",
        "fn computer_readiness(": "local computer readiness projection must stay in gateway_browser_runtime",
        "struct ContainedComputerLiveResponse ": "local computer live DTO must stay in gateway_browser_runtime",
        "struct LocalComputerActionResponse ": "local computer action DTO must stay in gateway_browser_runtime",
        "async fn local_computer_start(": "local computer start route must stay in gateway_browser_runtime",
        "async fn local_computer_stop(": "local computer stop route must stay in gateway_browser_runtime",
        "fn spawn_computer_live_publisher(": "local computer live publisher must stay in gateway_browser_runtime",
        "async fn build_contained_computer_live(": "local computer live read model must stay in gateway_browser_runtime",
        "async fn contained_computer_live(": "local computer live route must stay in gateway_browser_runtime",
        "struct WorkflowDefinition ": "native workflow definitions must stay in gateway_capability_routing",
        "struct NativeWorkflowCapability ": "native workflow capability routing must stay in gateway_capability_routing",
        "struct NativeAtomicCapability ": "native atomic capability routing must stay in gateway_capability_routing",
        "fn native_workflow_by_tool_name(": "native workflow lookup must stay in gateway_capability_routing",
        "fn native_workflow_capability_entries(": "native workflow corpus projection must stay in gateway_capability_routing",
        "fn semantic_capability_registry(": "semantic capability registry must stay in gateway_capability_routing",
        "fn resolve_semantic_decision(": "semantic turn routing must stay in gateway_capability_routing",
        "fn resolve_steering_semantic_decision(": "semantic steering routing must stay in gateway_capability_routing",
        "fn generate_semantic_json_with_invalid_retry(": "semantic JSON retry policy must stay in gateway_capability_routing",
        "struct HitlResumeTurnContext ": "HITL resume routing context must stay in gateway_capability_routing",
        "fn take_hitl_resume_turn_context(": "HITL resume routing context must stay in gateway_capability_routing",
        "fn semantic_decision_auth_fallback_applies(": "semantic routing auth fallback must stay in gateway_capability_routing",
        "fn semantic_decision_auth_fallback_from_registry(": "semantic routing auth fallback must stay in gateway_capability_routing",
        "fn native_atomic_by_key(": "native atomic lookup must stay in gateway_capability_routing",
        "fn native_atomic_capability_entries(": "native atomic corpus projection must stay in gateway_capability_routing",
        "fn workflow_execution_plan(": "native workflow plan construction must stay in gateway_capability_routing",
        "fn run_static_workflow_plan_through_brain(": "native workflow brain validation must stay in gateway_capability_routing",
        "async fn run_static_workflow_plan_through_brain_async(": "native workflow brain validation must stay in gateway_capability_routing",
        "enum WorkflowRouteDecision ": "workflow route decision must stay in gateway_capability_routing",
        "enum CapabilityRouteDecision ": "capability route decision must stay in gateway_capability_routing",
        "fn workflow_route_from_capability(": "workflow route projection must stay in gateway_capability_routing",
        "fn route_capability_from_semantic(": "semantic capability routing must stay in gateway_capability_routing",
        "fn route_capability_with_binding(": "deterministic binding route must stay in gateway_capability_routing",
        "fn active_routing_binding(": "thread routing binding lookup must stay in gateway_capability_routing",
        "fn resolve_workflow_routing(": "workflow routing lookup must stay in gateway_capability_routing",
        "fn forced_tool_for_turn(": "forced tool turn-index policy must stay in gateway_capability_routing",
        "fn thread_user_message_count(": "routing turn-index helper must stay in gateway_capability_routing",
        "fn thread_user_message_count_fail_open(": "routing turn-index helper must stay in gateway_capability_routing",
        "fn capability_router_instruction_for_decision(": "capability router prompt instruction must stay in gateway_capability_routing",
        "fn capability_route_trace_line(": "capability route tracing must stay in gateway_capability_routing",
        "fn prune_tools_for_workflow_route(": "workflow route tool pruning must stay in gateway_capability_routing",
        "fn prune_tools_for_route_and_deny(": "workflow route deny pruning must stay in gateway_capability_routing",
        "fn prune_tools_for_route(": "workflow route tool pruning must stay in gateway_capability_routing",
        "fn workflow_route_blocked_tool_message(": "workflow route blocking message must stay in gateway_capability_routing",
        "fn plan_reconcile_on_delivery_flag(": "runtime environment flags must stay in gateway_runtime_flags",
        "fn plan_reconcile_on_delivery_enabled(": "runtime environment flags must stay in gateway_runtime_flags",
        "fn turn_trace_enabled(": "runtime environment flags must stay in gateway_runtime_flags",
        "struct UserPrefs ": "user preference persistence must stay in gateway_user_preferences",
        "fn load_user_prefs(": "user preference persistence must stay in gateway_user_preferences",
        "fn save_user_prefs(": "user preference persistence must stay in gateway_user_preferences",
        "fn effective_user_tz_name(": "user timezone resolution must stay in gateway_user_preferences",
        "fn effective_user_language(": "user language resolution must stay in gateway_user_preferences",
        "fn response_language_instruction(": "prompt language instruction must stay in gateway_user_preferences",
        "fn past_date_hint(": "prompt date guardrails must stay in gateway_user_preferences",
        "fn now_block(": "prompt now block must stay in gateway_user_preferences",
        "async fn get_user_timezone(": "user timezone routes must stay in gateway_user_preferences",
        "async fn set_user_timezone(": "user timezone routes must stay in gateway_user_preferences",
        "async fn get_user_language(": "user language routes must stay in gateway_user_preferences",
        "async fn set_user_language(": "user language routes must stay in gateway_user_preferences",
        "async fn get_setup_status(": "setup routes must stay in gateway_user_preferences",
        "async fn validate_llm_config(": "setup LLM validation route must stay in gateway_user_preferences",
        "async fn get_ollama_setup(": "Ollama setup route must stay in gateway_user_preferences",
        "async fn pull_model(": "Ollama setup route must stay in gateway_user_preferences",
        "async fn get_approval_routing(": "approval routing routes must stay in gateway_user_preferences",
        "async fn set_approval_routing(": "approval routing routes must stay in gateway_user_preferences",
        "struct StreamEntry ": "live chat stream registry must stay in gateway_chat_streams",
        "struct StreamSink ": "live chat stream transport must stay in gateway_chat_streams",
        "fn stream_registry(": "live chat stream registry must stay in gateway_chat_streams",
        "fn stream_abort_registry(": "live chat stream abort registry must stay in gateway_chat_streams",
        "fn abort_stream_generation(": "live chat stream abort handling must stay in gateway_chat_streams",
        "fn stream_event_is_terminal(": "live chat stream terminal detection must stay in gateway_chat_streams",
        "fn active_stream_thread_ids(": "live chat stream activity projection must stay in gateway_chat_streams",
        "async fn active_streams(": "live chat stream activity route must stay in gateway_chat_streams",
        "async fn resume_stream(": "live chat stream reattach route must stay in gateway_chat_streams",
        "async fn emit_stream_event(": "live chat stream event emission must stay in gateway_chat_streams",
        "fn app_events_tx(": "process event broadcast must stay in gateway_process_events",
        "fn ws_registry(": "process WebSocket registry must stay in gateway_process_events",
        "fn usage_recorder_registry(": "process usage recorder registry must stay in gateway_process_events",
        "fn global_usage_recorder(": "process usage recorder registry must stay in gateway_process_events",
        "fn publish_app_event(": "process event publishing must stay in gateway_process_events",
        "async fn app_events(": "process event route must stay in gateway_process_events",
        "fn turn_trace_max_bytes(": "runtime environment flags must stay in gateway_runtime_flags",
        "fn plan_autoadvance_from_evidence_enabled(": "runtime environment flags must stay in gateway_runtime_flags",
        "fn memory_service_enabled(": "runtime environment flags must stay in gateway_runtime_flags",
        "fn verbose_debug(": "runtime environment flags must stay in gateway_runtime_flags",
        "struct RuntimeSettings": "runtime settings DTO must stay in gateway_runtime_settings",
        "fn merge_runtime_settings(": "runtime settings merge must stay in gateway_runtime_settings",
        "async fn get_runtime_settings(": "runtime settings read route must stay in gateway_runtime_settings",
        "async fn set_runtime_settings(": "runtime settings update route must stay in gateway_runtime_settings",
        "struct TemplateCatalogEntry ": "template catalog entry model must stay in gateway_template_catalog",
        "trait TemplateCatalogProvider ": "template catalog provider contract must stay in gateway_template_catalog",
        "struct FileTemplateCatalogProvider ": "file template catalog provider must stay in gateway_template_catalog",
        "struct ImportedTemplatePackProvider ": "imported template pack provider must stay in gateway_template_catalog",
        "fn template_catalog_entries(": "template catalog loading must stay in gateway_template_catalog",
        "fn template_catalog_response_from_entries(": "template catalog response projection must stay in gateway_template_catalog",
        "fn template_catalog_capability_entries(": "template catalog capability projection must stay in gateway_template_catalog",
        "fn template_preview_content_type(": "template preview asset policy must stay in gateway_template_catalog",
        "async fn template_catalog(": "template catalog route must stay in gateway_template_catalog",
        "async fn template_preview(": "template preview route must stay in gateway_template_catalog",
        "async fn import_pptx_template(": "template import route must stay in gateway_template_catalog",
        "async fn delete_template(": "template delete route must stay in gateway_template_catalog",
        "async fn template_source_attachment(": "template source attachment route must stay in gateway_template_catalog",
        "fn read_file_tool_schema(": "project file tool schemas must stay in gateway_project_files",
        "fn project_filesystem_mcp_instruction(": "project filesystem MCP prompt must stay in gateway_project_files",
        "fn jail_in_root(": "project path jail must stay in gateway_project_files",
        "fn fs_expand_abs(": "filesystem absolute path expansion must stay in gateway_project_files",
        "fn read_project_file(": "project file reads must stay in gateway_project_files",
        "fn write_project_file(": "project file writes must stay in gateway_project_files",
        "fn apply_patch_in_project(": "project patch application must stay in gateway_project_files",
        "async fn run_in_project(": "project command execution must stay in gateway_project_files",
        "fn is_noise_dir(": "project graph source filtering must stay in gateway_project_graph_routes",
        "fn is_code_file(": "project graph source filtering must stay in gateway_project_graph_routes",
        "fn project_change_fingerprint(": "project graph fingerprinting must stay in gateway_project_graph_routes",
        "fn graphify_out_dir(": "project graph output paths must stay in gateway_project_graph_routes",
        "fn integrity_known_scopes(": "integrity scope projection must stay in gateway_project_graph_routes",
        "fn integrity_graph_statuses(": "integrity graph freshness projection must stay in gateway_project_graph_routes",
        "fn integrity_graph_status_for_workspace(": "integrity graph freshness projection must stay in gateway_project_graph_routes",
        "fn integrity_bad_request(": "integrity route error mapping must stay in gateway_project_graph_routes",
        "fn integrity_internal_error(": "integrity route error mapping must stay in gateway_project_graph_routes",
        "fn integrity_preview_for_actions(": "integrity preview assembly must stay in gateway_project_graph_routes",
        "async fn integrity_audit(": "integrity route must stay in gateway_project_graph_routes",
        "async fn integrity_repair_preview(": "integrity route must stay in gateway_project_graph_routes",
        "async fn linked_memory_repair_preview(": "linked-memory repair route must stay in gateway_project_graph_routes",
        "async fn linked_memory_repair_apply(": "linked-memory repair route must stay in gateway_project_graph_routes",
        "fn next_integrity_backup_path(": "integrity backup path creation must stay in gateway_project_graph_routes",
        "async fn integrity_repair_apply(": "integrity route must stay in gateway_project_graph_routes",
        "fn spawn_project_graph_refresh(": "project graph refresh orchestration must stay in gateway_project_graph_routes",
        "fn project_graph_error_code(": "project graph error mapping must stay in gateway_project_graph_routes",
        "fn publish_project_graph_result(": "project graph event publication must stay in gateway_project_graph_routes",
        "fn build_project_graph(": "project graph build orchestration must stay in gateway_project_graph_routes",
        "struct ProjectGraphEnsureRequest": "project graph request DTO must stay in gateway_project_graph_routes",
        "async fn project_graph_ensure(": "project graph route must stay in gateway_project_graph_routes",
        "struct ProjectSubdirsQuery": "project graph request DTO must stay in gateway_project_graph_routes",
        "async fn project_graph_subdirs(": "project graph route must stay in gateway_project_graph_routes",
        "fn chat_browser_budget(": "browser budget policy must stay in gateway_browser_tools",
        "fn browse_tool_schema(": "delegated browse schema must stay in gateway_browser_tools",
        "fn browser_done_tool_schema(": "browser done schema must stay in gateway_browser_tools",
        "fn parse_browser_done_payload(": "browser done parsing must stay in gateway_browser_tools",
        "fn browser_act_tool_schema(": "browser action schema must stay in gateway_browser_tools",
        "fn browser_action_outcome_hint(": "browser action outcome policy must stay in gateway_browser_tools",
        "fn normalize_browser_action_bundle(": "browser action bundle normalization must stay in gateway_browser_tools",
        "fn stale_ref_recovery_message(": "stale browser ref recovery must stay in gateway_browser_tools",
        "fn browse_web_lock(": "browser runtime lock must stay in gateway_browser_runtime",
        "async fn chat_browser_call_bounded(": "bounded browser sidecar calls must stay in gateway_browser_runtime",
        "async fn persist_browser_checkpoint(": "browser checkpoint persistence must stay in gateway_browser_runtime",
        "async fn restore_browser_checkpoint(": "browser checkpoint restore must stay in gateway_browser_runtime",
        "struct BrowserPaymentContext": "browser payment runtime context must stay in gateway_browser_runtime",
        "fn thread_has_browser_continuation(": "browser continuation probing must stay in gateway_browser_runtime",
        "fn spawn_thread_browser_session_reaper(": "browser session reaper must stay in gateway_browser_runtime",
        "fn spawn_contained_computer_idle_reaper(": "contained computer idle reaper must stay in gateway_browser_runtime",
        "fn spawn_browser_handoff_reaper(": "browser handoff reaper must stay in gateway_browser_runtime",
        "struct BrowserActivityState": "browser activity state must stay in gateway_browser_runtime",
        "struct TerminalEntryView": "sandbox terminal activity state must stay in gateway_browser_runtime",
        "fn make_deck_tool_schema(": "deck tool schema must stay in gateway_deliverables",
        "fn make_document_tool_schema(": "document tool schema must stay in gateway_deliverables",
        "fn deliverable_design_template(": "deliverable design parsing must stay in gateway_deliverables",
        "fn deck_content_schema(": "deck content schema must stay in gateway_deliverables",
        "async fn generate_deck_content(": "deck content generation must stay in gateway_deliverables",
        "fn document_generation_options(": "document generation options must stay in gateway_deliverables",
        "async fn generate_document_markdown(": "document markdown generation must stay in gateway_deliverables",
        "fn markdown_to_docx(": "DOCX packaging must stay in gateway_deliverables",
        "fn doc_json_to_docx(": "templated document DOCX projection must stay in gateway_deliverables",
        "fn save_artifact_tool_schema(": "artifact delivery schema must stay in gateway_deliverables",
        "fn active_inference_model(": "active model resolution must stay in gateway_model_routing",
        "fn load_provider_registry(": "provider registry loading must stay in gateway_model_routing",
        "fn chat_openai_stream_config(": "chat model config must stay in gateway_model_routing",
        "fn role_openai_config(": "role model config must stay in gateway_model_routing",
        "fn reassemble_openai_stream(": "OpenAI stream reassembly must stay in gateway_model_routing",
        "fn build_chat_payload(": "provider chat payload shaping must stay in gateway_model_routing",
        "fn parse_ollama_capabilities(": "Ollama capability parsing must stay in gateway_model_routing",
        "fn resolve_context_budget_chars(": "model context budget resolution must stay in gateway_model_routing",
        "async fn compact_for_context_budget(": "model-visible context compaction must stay in gateway_model_routing",
        "struct GatewayContextCompactor": "context compactor port must stay in gateway_model_routing",
        "struct GatewayTurnCompletionJudge": "turn completion judge port must stay in gateway_model_routing",
        "fn agent_output_incomplete_reason(": "agent output completion policy must stay in gateway_model_routing",
        "struct GatewayTurnPolicy": "turn policy port must stay in gateway_capability_routing",
        "fn zai_thinking_enabled(": "Z.ai thinking policy must stay in gateway_model_routing",
        "struct RoutingDecision ": "routing decision log DTO must stay in gateway_model_routing",
        "fn log_routing_decision(": "routing decision log writer must stay in gateway_model_routing",
        "fn resolve_inference_api_key(": "inference API key resolution must stay in gateway_model_routing",
        "fn env_inference_api_key(": "inference env key fallback must stay in gateway_model_routing",
        "fn inference_locality(": "inference locality classification must stay in gateway_model_routing",
        "fn inference_provider_id(": "inference provider identity must stay in gateway_model_routing",
        "async fn recorded_openai_value(": "recorded OpenAI transport must stay in gateway_model_routing",
        "fn build_router_from(": "model router factory must stay in gateway_model_routing",
        "fn build_router_for_resolved(": "resolved-role router factory must stay in gateway_model_routing",
        "fn router_for_role(": "role router factory must stay in gateway_model_routing",
        "fn resolve_role_for_task(": "semantic role resolution must stay in gateway_model_routing",
        "fn semantic_router_enabled(": "semantic router flag must stay in gateway_model_routing",
        "fn build_inference_router_from_env(": "legacy env router factory must stay in gateway_model_routing",
        "fn default_skills_dir(": "default skill source resolution must stay in gateway_boot_maintenance",
        "fn copy_dir_recursive(": "default skill tree copy must stay in gateway_boot_maintenance",
        "fn skill_tree_hash(": "default skill tree hashing must stay in gateway_boot_maintenance",
        "fn seed_default_skills(": "default skill seeding implementation must stay in gateway_boot_maintenance",
        "fn skills_dir(": "shared skill directory resolution must stay in gateway_skill_runtime",
        "fn slugify_skill_name(": "skill id normalization must stay in gateway_skill_runtime",
        "fn create_skill(": "skill authoring runtime must stay in gateway_skill_runtime",
        "fn enabled_skills_summary(": "skill prompt discovery runtime must stay in gateway_skill_runtime",
        "fn homuncoder_skill_ids(": "HomunCoder skill manifest loading must stay in gateway_skill_runtime",
        "fn load_skill_body(": "skill progressive disclosure runtime must stay in gateway_skill_runtime",
        "fn load_skill_body_and_sensitive(": "skill sensitive disclosure runtime must stay in gateway_skill_runtime",
        "fn skill_id_from_command(": "skill command id extraction must stay in gateway_skill_runtime",
        "fn adapt_skill_body(": "skill body adaptation must stay in gateway_skill_runtime",
        "fn use_skill_tool_schema(": "skill use schema must stay in gateway_skill_runtime",
        "fn run_in_sandbox_tool_schema(": "skill sandbox schema must stay in gateway_skill_runtime",
        "struct ActiveModelResponse": "runtime model response DTO must stay in gateway_model_routes",
        "struct ProviderModelsGroup": "runtime model list DTO must stay in gateway_model_routes",
        "struct RuntimeModelsResponse": "runtime model list DTO must stay in gateway_model_routes",
        "struct SetRuntimeModelRequest": "runtime model request DTO must stay in gateway_model_routes",
        "struct InferenceProviderResponse": "runtime provider response DTO must stay in gateway_model_routes",
        "struct SetInferenceProviderRequest": "runtime provider request DTO must stay in gateway_model_routes",
        "struct ProviderModelView": "provider registry DTO must stay in gateway_model_routes",
        "struct ProviderView": "provider registry DTO must stay in gateway_model_routes",
        "struct ProvidersResponse": "provider registry DTO must stay in gateway_model_routes",
        "struct UpsertProviderRequest": "provider registry request DTO must stay in gateway_model_routes",
        "struct SetProviderEnabledRequest": "provider registry request DTO must stay in gateway_model_routes",
        "struct SetModelProfileRequest": "model profile request DTO must stay in gateway_model_routes",
        "struct RoleView": "model role DTO must stay in gateway_model_routes",
        "struct RolesResponse": "model role DTO must stay in gateway_model_routes",
        "struct RoutingDecisionsResponse": "routing decisions DTO must stay in gateway_model_routes",
        "struct SetRoleRequest": "model role request DTO must stay in gateway_model_routes",
        "fn resolve_active_model(": "runtime model projection must stay in gateway_model_routes",
        "fn active_inference_model_info(": "runtime model projection must stay in gateway_model_routes",
        "fn deliver_model_available_wakes(": "model-available wake delivery must stay in gateway_model_routes",
        "fn provider_view(": "provider registry projection must stay in gateway_model_routes",
        "fn providers_response(": "provider registry projection must stay in gateway_model_routes",
        "fn roles_response(": "model role projection must stay in gateway_model_routes",
        "fn provider_registry_persist_error(": "provider route error mapping must stay in gateway_model_routes",
        "async fn runtime_models(": "runtime model route must stay in gateway_model_routes",
        "async fn set_runtime_model(": "runtime model route must stay in gateway_model_routes",
        "async fn runtime_provider(": "runtime provider route must stay in gateway_model_routes",
        "async fn set_runtime_provider(": "runtime provider route must stay in gateway_model_routes",
        "async fn list_providers(": "provider registry route must stay in gateway_model_routes",
        "async fn upsert_provider(": "provider registry route must stay in gateway_model_routes",
        "async fn remove_provider(": "provider registry route must stay in gateway_model_routes",
        "async fn set_provider_enabled(": "provider registry route must stay in gateway_model_routes",
        "async fn refresh_provider_models(": "provider registry route must stay in gateway_model_routes",
        "async fn set_model_profile(": "model profile route must stay in gateway_model_routes",
        "async fn generate_provider_profiles(": "provider profile generation route must stay in gateway_model_routes",
        "async fn list_roles(": "model role route must stay in gateway_model_routes",
        "async fn list_routing_decisions(": "routing decisions route must stay in gateway_model_routes",
        "async fn set_role(": "model role route must stay in gateway_model_routes",
        "async fn runtime_model(": "runtime model route must stay in gateway_model_routes",
        "struct BrowserToolCtx": "browser tool context must stay in gateway_tool_execution",
        "struct ChatToolCtx": "chat tool context must stay in gateway_tool_execution",
        "async fn execute_browser_tool(": "browser tool dispatch must stay in gateway_tool_execution",
        "async fn execute_chat_tool(": "chat tool dispatch must stay in gateway_tool_execution",
        "struct GatewayCapabilityExecutor": "gateway capability executor must stay in gateway_tool_execution",
        "struct GatewayBrowserExecutor": "gateway browser executor must stay in gateway_tool_execution",
        "struct GatewayBrowseExecutor": "browse sub-agent executor must stay in gateway_tool_execution",
        "struct BrowseOnlyCapabilityExecutor": "browse-only capability executor must stay in gateway_tool_execution",
        "fn enqueue_chat_turn_core(": "turn broker enqueue core must stay in gateway_turn_broker",
        "fn enqueue_or_steer_chat_turn_core(": "turn broker steer-or-enqueue core must stay in gateway_turn_broker",
        "struct ResumedChatTurn ": "turn broker resume result must stay in gateway_turn_broker",
        "fn resume_suspended_user_turn_core(": "turn broker user resume core must stay in gateway_turn_broker",
        "fn resume_suspended_approval_turn_core(": "turn broker approval resume core must stay in gateway_turn_broker",
        "fn insert_broker_turn_messages(": "turn broker transcript insertion must stay in gateway_turn_broker",
        "fn insert_broker_steering_user_message(": "turn broker steering transcript insertion must stay in gateway_turn_broker",
        "fn insert_broker_resume_user_message(": "turn broker resume transcript insertion must stay in gateway_turn_broker",
        "fn broker_turn_message_attachments(": "turn broker attachment projection must stay in gateway_turn_broker",
        "async fn enqueue_turn(": "turn broker enqueue route must stay in gateway_turn_broker",
        "fn cancel_chat_turn_and_finalize_bubble(": "turn broker cancel/finalize helper must stay in gateway_turn_broker",
        "async fn cancel_turn(": "turn broker cancel route must stay in gateway_turn_broker",
        "struct TurnSinceQuery ": "turn broker cursor query must stay in gateway_turn_broker",
        "fn execution_thread_workspace(": "turn broker workspace resolution must stay in gateway_turn_broker",
        "fn set_chat_turn_message_delivery_state(": "turn broker delivery projection must stay in gateway_turn_broker",
        "async fn get_turn_events(": "turn broker event route must stay in gateway_turn_broker",
        "struct SteeringMutationRequest ": "turn broker steering request DTO must stay in gateway_turn_broker",
        "struct SteeringRevisionRequest ": "turn broker steering revision DTO must stay in gateway_turn_broker",
        "fn publish_steering_changed(": "turn broker steering broadcast must stay in gateway_turn_broker",
        "async fn list_thread_steering(": "turn broker steering routes must stay in gateway_turn_broker",
        "async fn update_steering(": "turn broker steering routes must stay in gateway_turn_broker",
        "async fn delete_steering(": "turn broker steering routes must stay in gateway_turn_broker",
        "async fn send_steering_now(": "turn broker steering routes must stay in gateway_turn_broker",
        "async fn subscribe_turn_stream(": "turn broker durable stream route must stay in gateway_turn_broker",
        "struct TaskQueueQuery": "task executor queue query must stay in gateway_task_executor",
        "struct UncertainEffectQuery": "task executor effect query must stay in gateway_task_executor",
        "struct TaskExecutorStatus": "task executor status read model must stay in gateway_task_executor",
        "struct TaskItemResponse": "task executor queue DTOs must stay in gateway_task_executor",
        "struct ApprovalItemResponse": "task executor approval DTOs must stay in gateway_task_executor",
        "struct ResourceUsageResponse": "task executor resource usage DTOs must stay in gateway_task_executor",
        "struct UncertainEffectResponse": "task executor uncertain effect DTOs must stay in gateway_task_executor",
        "struct TaskQueueResponse": "task executor queue response must stay in gateway_task_executor",
        "struct TaskDetailResponse": "task executor detail response must stay in gateway_task_executor",
        "struct TaskRunStepResponse": "task executor run response must stay in gateway_task_executor",
        "struct TaskRunBatchResponse": "task executor run response must stay in gateway_task_executor",
        "struct TaskExecutorStatusResponse": "task executor status response must stay in gateway_task_executor",
        "struct TaskExecutionPresentation": "task executor presentation contract must stay in gateway_task_executor",
        "enum TaskResultSurfacing": "task executor surfacing contract must stay in gateway_task_executor",
        "struct PendingExecutorApproval": "task executor approval presentation must stay in gateway_task_executor",
        "struct TaskArtifactOutput": "task executor artifact DTO must stay in gateway_task_executor",
        "struct ResolveEffectResponse": "task executor effect response must stay in gateway_task_executor",
        "struct RejectApprovalRequest": "task executor approval request DTOs must stay in gateway_task_executor",
        "struct ApproveApprovalRequest": "task executor approval request DTOs must stay in gateway_task_executor",
        "async fn uncertain_effect_receipts(": "task executor effect routes must stay in gateway_task_executor",
        "async fn resolve_uncertain_effect_receipt(": "task executor effect routes must stay in gateway_task_executor",
        "fn task_queue_response_for_state(": "task executor queue read model must stay in gateway_task_executor",
        "fn task_queue_response(": "task executor queue read model must stay in gateway_task_executor",
        "fn uncertain_effect_response(": "task executor uncertain effect projection must stay in gateway_task_executor",
        "fn task_detail_response(": "task executor detail read model must stay in gateway_task_executor",
        "fn is_internal_task_kind(": "task executor queue filtering must stay in gateway_task_executor",
        "fn humanize_task_kind(": "task executor queue labels must stay in gateway_task_executor",
        "fn task_item_response(": "task executor task DTO mapping must stay in gateway_task_executor",
        "fn approval_item_response(": "task executor approval DTO mapping must stay in gateway_task_executor",
        "async fn task_queue(": "task executor queue route must stay in gateway_task_executor",
        "async fn task_detail(": "task executor detail route must stay in gateway_task_executor",
        "async fn cancel_task(": "task executor cancel route must stay in gateway_task_executor",
        "async fn run_next_task(": "task executor run route must stay in gateway_task_executor",
        "async fn task_executor_status(": "task executor status route must stay in gateway_task_executor",
        "async fn approve_approval(": "task executor approval route must stay in gateway_task_executor",
        "async fn reject_approval(": "task executor approval route must stay in gateway_task_executor",
        "fn run_next_task_once(": "task executor run loop must stay in gateway_task_executor",
        "fn start_task_executor_worker(": "task executor background worker must stay in gateway_task_executor",
        "enum TaskAcquireResult": "task executor acquire result must stay in gateway_task_executor",
        "fn acquire_task_for_execution(": "task executor acquire flow must stay in gateway_task_executor",
        "fn mark_task_completed(": "task executor finalization must stay in gateway_task_executor",
        "fn mark_task_failed(": "task executor finalization must stay in gateway_task_executor",
        "fn mark_task_waiting_external(": "task executor finalization must stay in gateway_task_executor",
        "fn mark_task_waiting_time(": "task executor finalization must stay in gateway_task_executor",
        "fn handle_failed_task_run(": "task executor retry/failure handling must stay in gateway_task_executor",
        "fn request_task_executor_approval(": "task executor approval suspension must stay in gateway_task_executor",
        "fn resource_class_label(": "task executor resource labels must stay in gateway_task_executor",
        "fn sync_session_for_task_run(": "task executor session sync must stay in gateway_task_executor",
        "fn append_task_result_to_chat(": "task executor result surfacing must stay in gateway_task_executor",
        "fn append_task_progress_checkpoint(": "task executor progress checkpoint must stay in gateway_task_executor",
        "fn lock_task_executor_status(": "task executor status lock must stay in gateway_task_executor",
        "struct LocalTaskExecutionError": "task executor adapter error contract must stay in gateway_task_executor",
        "struct ChannelSettings": "channel settings must stay in gateway_channels",
        "fn inbound_action(": "channel inbound policy must stay in gateway_channels",
        "async fn whatsapp_status(": "WhatsApp status route must stay in gateway_channels",
        "async fn telegram_status(": "Telegram status route must stay in gateway_channels",
        "async fn whatsapp_inbound(": "WhatsApp inbound route must stay in gateway_channels",
        "async fn telegram_inbound(": "Telegram inbound route must stay in gateway_channels",
        "fn contact_turn_context(": "channel contact perimeter resolution must stay in gateway_channels",
        "fn backfill_mentions(": "channel mention backfill must stay in gateway_channels",
        "fn unify_owner_identity(": "owner identity channel unification must stay in gateway_channels",
        "fn backfill_contacts(": "channel contact backfill must stay in gateway_channels",
        "fn channel_chat_message(": "channel chat message construction must stay in gateway_channels",
        "async fn channel_send_buttons_classified(": "channel button send sidecar helper must stay in gateway_channels",
        "fn send_message_tool_schema(": "channel send_message pseudo-tool schema must stay in gateway_channels",
        "fn execute_send_message(": "channel send_message pseudo-tool execution must stay in gateway_channels",
        "fn composio_execute_tool(": "Composio execute dispatcher must stay in gateway_composio_execution",
        "struct ComposioExecuteRequest": "Composio execute DTOs must stay in gateway_composio_execution",
        "struct ComposioExecuteResponse": "Composio execute DTOs must stay in gateway_composio_execution",
        "async fn composio_execute(": "Composio execute route must stay in gateway_composio_execution",
        "fn browser_open_research_discovery_instruction(": "prompt instruction snippets must stay in gateway_prompt_instructions",
        "fn booking_assumption_choice_instruction(": "prompt instruction snippets must stay in gateway_prompt_instructions",
        "fn choice_resume_instruction_legacy_backup(": "prompt instruction snippets must stay in gateway_prompt_instructions",
        "fn schedule_task_tool_schema(": "automation tool schemas must stay in gateway_automation_tools",
        "fn create_automation_tool_schema(": "automation tool schemas must stay in gateway_automation_tools",
        "fn update_automation_tool_schema(": "automation tool schemas must stay in gateway_automation_tools",
        "fn humanize_recurrence(": "automation formatting must stay in gateway_automation_formatting",
        "fn automation_trigger_summary(": "automation formatting must stay in gateway_automation_formatting",
        "fn scheduled_thread_sender_for_task_id(": "automation thread formatting must stay in gateway_automation_formatting",
        "fn scheduled_thread_title(": "automation thread formatting must stay in gateway_automation_formatting",
        "struct ProactiveThreadPlan": "proactive thread planning must stay in gateway_proactive_threads",
        "fn proactive_thread_plan(": "proactive thread planning must stay in gateway_proactive_threads",
        "fn proactive_thread_scope(": "proactive thread planning must stay in gateway_proactive_threads",
        "fn redact_json_for_task_output(": "shell task output shaping must stay in gateway_shell_tasks",
        "fn execute_shell_read_only_task(": "read-only shell task execution must stay in gateway_shell_tasks",
        "fn run_read_only_command(": "read-only shell command wrapper must stay in gateway_shell_tasks",
        "struct AutomationCreateRequest ": "automation request DTOs must stay in gateway_automation_requests",
        "struct AutomationScopeQuery ": "automation request DTOs must stay in gateway_automation_requests",
        "struct AutomationUpdateRequest ": "automation request DTOs must stay in gateway_automation_requests",
        "fn automation_workspace_scope(": "automation request scoping must stay in gateway_automation_requests",
        "fn automation_to_json(": "automation route DTO assembly must stay in gateway_automation_routes",
        "fn materialize_automation_task(": "automation task materialization must stay in gateway_automation_routes",
        "fn connector_poll_tick(": "automation connector polling must stay in gateway_automation_routes",
        "fn fire_channel_event_automations(": "channel event automation firing must stay in gateway_automation_routes",
        "async fn automations_list(": "automation list route must stay in gateway_automation_routes",
        "async fn automation_create(": "automation create route must stay in gateway_automation_routes",
        "async fn automation_update(": "automation update route must stay in gateway_automation_routes",
        "async fn automation_toggle(": "automation toggle route must stay in gateway_automation_routes",
        "async fn automation_delete(": "automation delete route must stay in gateway_automation_routes",
        "fn list_scheduled_tasks_tool_schema(": "scheduled task tool schemas must stay in gateway_automation_routes",
        "fn provenance_key_fragment(": "memory graph key fragments must stay in gateway_memory_graph",
        "fn upsert_memory_relation(": "memory graph relation upsert must stay in gateway_memory_graph",
        "fn artifact_memory_kind(": "artifact memory type classification must stay in gateway_artifact_memory",
        "fn artifact_memory_matches(": "artifact memory matching must stay in gateway_artifact_memory",
        "fn provenance_label(": "artifact provenance labels must stay in gateway_artifact_memory",
        "fn provenance_normalized_label(": "artifact provenance labels must stay in gateway_artifact_memory",
        "fn artifact_provenance_labels(": "artifact provenance labels must stay in gateway_artifact_memory",
        "fn decision_affects_artifact(": "artifact evidence provenance must stay in gateway_artifact_memory",
        "fn explicit_artifact_source_refs(": "artifact source ref parsing must stay in gateway_artifact_memory",
        "fn upsert_artifact_evidence_provenance_graph(": "artifact evidence provenance graph must stay in gateway_artifact_memory",
        "fn upsert_artifact_provenance_graph(": "artifact provenance graph must stay in gateway_artifact_memory",
        "fn upsert_artifact_memory_record(": "artifact memory upsert must stay in gateway_artifact_memory",
        "fn remember_artifact_memory(": "artifact memory registration must stay in gateway_artifact_memory",
        "async fn register_artifact_memory(": "artifact memory registration must stay in gateway_artifact_memory",
        "async fn register_artifact_memory_with_metadata(": "artifact memory registration must stay in gateway_artifact_memory",
        "async fn emit_rendered_deck_artifacts(": "rendered deck artifact emission must stay in gateway_artifact_memory",
        "fn remember_project_file_artifact_memory(": "project file artifact memory must stay in gateway_artifact_memory",
        "async fn register_project_file_artifact_memory(": "project file artifact memory must stay in gateway_artifact_memory",
        "fn mcp_filesystem_project_relative_path(": "MCP filesystem artifact detection must stay in gateway_artifact_memory",
        "fn mcp_filesystem_project_relative_path_for_root(": "MCP filesystem artifact detection must stay in gateway_artifact_memory",
        "async fn register_mcp_filesystem_artifact_memory(": "MCP filesystem artifact memory must stay in gateway_artifact_memory",
        "struct ArtifactRef": "artifact file route DTOs must stay in gateway_artifacts",
        "struct ArtifactDestination": "artifact destination DTOs must stay in gateway_artifacts",
        "struct BrandKit": "brand kit DTO must stay in gateway_artifacts",
        "async fn save_artifact_content(": "artifact content save route must stay in gateway_artifacts",
        "async fn download_artifact(": "artifact download route must stay in gateway_artifacts",
        "async fn artifact_pdf_pages(": "artifact PDF preview route must stay in gateway_artifacts",
        "async fn list_artifact_destinations(": "artifact destination route must stay in gateway_artifacts",
        "async fn export_artifacts_zip(": "artifact export route must stay in gateway_artifacts",
        "async fn memory_artifacts(": "artifact memory catalog route must stay in gateway_artifacts",
        "fn write_artifact_bytes(": "artifact write path must stay in gateway_artifacts",
        "fn materialize_brand_kit(": "brand kit materialization must stay in gateway_artifacts",
        "fn save_artifact_to_destination(": "authorized artifact save path must stay in gateway_artifacts",
        "fn detect_new_artifacts(": "artifact detection must stay in gateway_artifacts",
        "fn wiki_edited_path(": "memory wiki edit registry path must stay in gateway_memory_wiki",
        "fn load_wiki_edited(": "memory wiki edit registry loading must stay in gateway_memory_wiki",
        "fn mark_wiki_edited(": "memory wiki edit registry writes must stay in gateway_memory_wiki",
        "fn wiki_is_edited(": "memory wiki edit checks must stay in gateway_memory_wiki",
        "fn rebuild_decisions_wiki(": "memory decisions wiki rebuild must stay in gateway_memory_wiki",
        "fn rebuild_profile_wiki(": "memory profile wiki rebuild must stay in gateway_memory_wiki",
        "fn rebuild_project_brief(": "memory project brief rebuild must stay in gateway_memory_wiki",
        "fn rebuild_status_wiki(": "memory status wiki rebuild must stay in gateway_memory_wiki",
        "struct WikiPageView": "memory wiki route page DTO must stay in gateway_memory_wiki",
        "async fn memory_wiki(": "memory wiki read route must stay in gateway_memory_wiki",
        "struct WikiSaveRequest": "memory wiki save DTO must stay in gateway_memory_wiki",
        "async fn memory_wiki_save(": "memory wiki save route must stay in gateway_memory_wiki",
        "async fn memory_consolidate(": "memory consolidate route must stay in gateway_memory_wiki",
        "fn active_open_loop_record(": "memory open-loop status filter must stay in gateway_memory_wiki",
        "fn deduplicate_open_loops(": "memory open-loop dedup wrapper must stay in gateway_memory_wiki",
        "fn open_loop_matches_target(": "memory open-loop closure matching must stay in gateway_memory_wiki",
        "fn close_matching_open_loops(": "memory open-loop closure must stay in gateway_memory_wiki",
        "fn status_wiki_body_from_open_loops(": "memory status wiki body helper must stay in gateway_memory_wiki",
    }


def assert_contains(source: str, snippet: str, message: str) -> None:
    if snippet not in source:
        raise AssertionError(f"{message}: missing {snippet!r}")


def assert_not_contains(source: str, snippet: str, message: str) -> None:
    if snippet in source:
        raise AssertionError(f"{message}: found {snippet!r}")


def assert_ordered(source: str, snippets: list[str], message: str) -> None:
    cursor = -1
    for snippet in snippets:
        index = source.find(snippet, cursor + 1)
        if index < 0:
            raise AssertionError(f"{message}: missing {snippet!r}")
        if index <= cursor:
            raise AssertionError(f"{message}: {snippet!r} is out of order")
        cursor = index


def main() -> int:
    with open(MAIN_RS, "r", encoding="utf-8") as handle:
        source = handle.read()
    with open(ATTACHMENTS_RS, "r", encoding="utf-8") as handle:
        attachments_source = handle.read()
    with open(RECALL_CONTEXT_RS, "r", encoding="utf-8") as handle:
        recall_context_source = handle.read()
    with open(MEMORY_PROMPT_CONTEXT_RS, "r", encoding="utf-8") as handle:
        memory_prompt_context_source = handle.read()
    with open(TEXT_SAFETY_RS, "r", encoding="utf-8") as handle:
        text_safety_source = handle.read()
    with open(BROWSER_TOOLS_RS, "r", encoding="utf-8") as handle:
        browser_tools_source = handle.read()
    with open(CHAT_UTILITY_ROUTES_RS, "r", encoding="utf-8") as handle:
        chat_utility_routes_source = handle.read()
    with open(PROACTIVITY_ROUTES_RS, "r", encoding="utf-8") as handle:
        proactivity_routes_source = handle.read()
    with open(VAULT_ROUTES_RS, "r", encoding="utf-8") as handle:
        vault_routes_source = handle.read()
    with open(LOCAL_AUTHORIZATION_ROUTES_RS, "r", encoding="utf-8") as handle:
        local_authorization_routes_source = handle.read()
    with open(COMPOSIO_ROUTES_RS, "r", encoding="utf-8") as handle:
        composio_routes_source = handle.read()
    with open(COMPOSIO_EXECUTION_RS, "r", encoding="utf-8") as handle:
        composio_execution_source = handle.read()
    with open(CONNECTOR_ERRORS_RS, "r", encoding="utf-8") as handle:
        connector_errors_source = handle.read()
    with open(IMAGE_GENERATION_RS, "r", encoding="utf-8") as handle:
        image_generation_source = handle.read()
    with open(MODEL_ROUTING_RS, "r", encoding="utf-8") as handle:
        model_routing_source = handle.read()
    with open(CAPABILITY_ROUTING_RS, "r", encoding="utf-8") as handle:
        capability_routing_source = handle.read()
    with open(TASK_EXECUTOR_CONFIG_RS, "r", encoding="utf-8") as handle:
        task_executor_config_source = handle.read()
    with open(TASK_EXECUTOR_RS, "r", encoding="utf-8") as handle:
        task_executor_source = handle.read()
    with open(BOOT_MAINTENANCE_RS, "r", encoding="utf-8") as handle:
        boot_maintenance_source = handle.read()
    with open(SKILL_RUNTIME_RS, "r", encoding="utf-8") as handle:
        skill_runtime_source = handle.read()
    with open(RUNTIME_PLAN_STATE_RS, "r", encoding="utf-8") as handle:
        runtime_plan_state_source = handle.read()
    with open(THREAD_EPISODES_RS, "r", encoding="utf-8") as handle:
        thread_episodes_source = handle.read()
    with open(PROMPT_PACKETS_RS, "r", encoding="utf-8") as handle:
        prompt_packets_source = handle.read()
    with open(BRAIN_RUNTIME_RS, "r", encoding="utf-8") as handle:
        brain_runtime_source = handle.read()
    with open(BRAIN_MATERIALIZATION_RS, "r", encoding="utf-8") as handle:
        brain_materialization_source = handle.read()
    with open(RUNTIME_FLAGS_RS, "r", encoding="utf-8") as handle:
        runtime_flags_source = handle.read()
    with open(AUTOMATION_FORMATTING_RS, "r", encoding="utf-8") as handle:
        automation_formatting_source = handle.read()
    with open(PROACTIVE_THREADS_RS, "r", encoding="utf-8") as handle:
        proactive_threads_source = handle.read()
    with open(SHELL_TASKS_RS, "r", encoding="utf-8") as handle:
        shell_tasks_source = handle.read()
    with open(ACTION_CONFIRMATIONS_RS, "r", encoding="utf-8") as handle:
        action_confirmations_source = handle.read()
    with open(ACTIONABLE_SOURCE_RS, "r", encoding="utf-8") as handle:
        actionable_source_source = handle.read()
    with open(REMOTE_APPROVAL_RS, "r", encoding="utf-8") as handle:
        remote_approval_source = handle.read()
    with open(REMOTE_APPROVAL_EXECUTION_RS, "r", encoding="utf-8") as handle:
        remote_approval_execution_source = handle.read()
    with open(CHANNELS_RS, "r", encoding="utf-8") as handle:
        channels_source = handle.read()
    with open(MEMORY_QUERY_EMBEDDINGS_RS, "r", encoding="utf-8") as handle:
        memory_query_embeddings_source = handle.read()
    with open(MEMORY_JSON_RS, "r", encoding="utf-8") as handle:
        memory_json_source = handle.read()
    with open(MEMORY_LEARNING_RS, "r", encoding="utf-8") as handle:
        memory_learning_source = handle.read()
    with open(MEMORY_RECALL_TOOL_RS, "r", encoding="utf-8") as handle:
        memory_recall_tool_source = handle.read()
    with open(MEMORY_CLIENTS_RS, "r", encoding="utf-8") as handle:
        memory_clients_source = handle.read()
    with open(PAYMENT_APPROVAL_RS, "r", encoding="utf-8") as handle:
        payment_approval_source = handle.read()
    main_body = extract_async_main_body(source)
    assert_contains(source, "mod attachments;", "gateway root must declare attachment owner")
    for snippet in [
        "const ATTACHMENT_TEXT_BUDGET_CHARS:",
        "const ATTACHMENT_CONTEXT_IMAGES:",
        "pub(crate) fn append_thread_attachment_context(",
        "fn attachment_text_is_ready(",
    ]:
        assert_contains(
            attachments_source,
            snippet,
            "attachment owner must expose bounded prompt context surface",
        )
    for snippet in [
        "async fn stream_chat_via_openai(",
        "fn recall_memory(",
        "async fn run_agent_rounds(",
        "fn build_prompt_packet(",
    ]:
        assert_not_contains(
            attachments_source,
            snippet,
            "attachment owner must not absorb adjacent chat/runtime surfaces",
        )
    assert_contains(source, "mod gateway_recall_context;", "gateway root must declare recall context owner")
    assert_contains(
        recall_context_source,
        "pub(crate) fn format_recall_entry(",
        "recall context owner must expose recall entry formatting",
    )
    for snippet in [
        "fn recall_memory(",
        "fn workflow_status_context_for_query(",
        "fn artifact_provenance_context_for_query(",
        "async fn run_agent_rounds(",
    ]:
        assert_not_contains(
            recall_context_source,
            snippet,
            "recall context owner must not absorb adjacent chat/read-model surfaces",
        )
    assert_contains(
        source,
        "mod gateway_memory_prompt_context;",
        "gateway root must declare memory prompt context owner",
    )
    for snippet in [
        "pub(crate) fn artifact_quality_summary(",
        "pub(crate) fn artifact_provenance_context_for_query(",
        "pub(crate) fn decisions_for_path(",
        "pub(crate) fn producer_workflow_contract(",
        "pub(crate) fn relevant_code_components_for_prompt(",
        "pub(crate) fn workflow_status_context_for_query(",
    ]:
        assert_contains(
            memory_prompt_context_source,
            snippet,
            "memory prompt context owner must expose bounded prompt helpers",
        )
    for snippet in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn learn_via_service_or_inline(",
        "async fn run_agent_rounds(",
    ]:
        assert_not_contains(
            memory_prompt_context_source,
            snippet,
            "memory prompt context owner must not absorb adjacent memory/chat surfaces",
        )
    assert_contains(source, "mod gateway_text_safety;", "gateway root must declare text safety owner")
    for snippet in [
        "pub(crate) fn compact_redacted_task_goal_summary(",
        "pub(crate) fn redact_sensitive_text(",
        "pub(crate) fn strip_terminal_control_sequences(",
        "pub(crate) fn task_goal_summary(",
        "pub(crate) fn truncate_chars(",
    ]:
        assert_contains(
            text_safety_source,
            snippet,
            "text safety owner must expose shared text safety helpers",
        )
    for snippet in [
        "fn task_effective_goal(",
        "fn redact_json_for_task_output(",
        "async fn run_agent_rounds(",
        "fn recall_memory(",
    ]:
        assert_not_contains(
            text_safety_source,
            snippet,
            "text safety owner must not absorb adjacent gateway surfaces",
        )
    assert_contains(source, "mod gateway_proactivity;", "gateway root must declare proactivity owner")
    assert_contains(source, "mod gateway_action_confirmations;", "gateway root must declare action confirmation owner")
    assert_contains(source, "mod gateway_actionable_source;", "gateway root must declare actionable source owner")
    for snippet in [
        "pub(crate) enum ActionableSourceResolution",
        "pub(crate) fn actionable_source_terminal_text(",
        "pub(crate) fn actionable_claim_error(",
        "pub(crate) fn terminal_actionable_execution_error(",
        "pub(crate) fn claim_actionable_source<",
        "pub(crate) fn resolve_actionable_source<",
    ]:
        assert_contains(
            actionable_source_source,
            snippet,
            "actionable source owner must expose exact source claim/resolution helpers",
        )
    for snippet in [
        "async fn execute_pending_approval(",
        "fn composio_execute_tool(",
        "fn should_claim_payment_approval(",
        "fn browser_action_requires_payment_grant(",
        "fn cancel_pending_remote_approval(",
        "async fn dispatch_remote_approval(",
    ]:
        assert_not_contains(
            actionable_source_source,
            snippet,
            "actionable source owner must not absorb execution/payment/remote/browser surfaces",
        )
    for snippet in [
        "pub(crate) async fn channel_send_buttons_classified(",
        "pub(crate) fn send_message_tool_schema(",
        "pub(crate) fn execute_send_message(",
    ]:
        assert_contains(
            channels_source,
            snippet,
            "channel owner must expose send_message pseudo-tool surfaces",
        )
    for snippet in [
        "pub(crate) fn composio_execute_tool(",
        "pub(crate) struct ComposioExecuteRequest",
        "pub(crate) struct ComposioExecuteResponse",
        "pub(crate) async fn composio_execute(",
    ]:
        assert_contains(
            composio_execution_source,
            snippet,
            "Composio execution owner must expose execute surfaces",
        )
    for snippet in [
        "fn should_claim_payment_approval(",
        "async fn execute_pending_approval(",
        "fn browser_action_requires_payment_grant(",
        "async fn dispatch_remote_approval(",
    ]:
        assert_not_contains(
            composio_execution_source,
            snippet,
            "Composio execution owner must not absorb payment/remote/browser surfaces",
        )
    assert_contains(
        remote_approval_execution_source,
        "pub(crate) async fn execute_pending_approval(",
        "remote approval execution owner must expose pending approval execution",
    )
    for snippet in [
        "fn should_claim_payment_approval(",
        "fn claim_payment_approval_for_action(",
        "fn browser_action_requires_payment_grant(",
        "async fn dispatch_remote_approval(",
        "fn create_pending_approval(",
    ]:
        assert_not_contains(
            remote_approval_execution_source,
            snippet,
            "remote approval execution owner must not absorb control/payment/browser surfaces",
        )
    for snippet in [
        "pub(crate) struct PaymentApprovalGrant",
        "pub(crate) fn apply_payment_approval_secret_for_action(",
        "pub(crate) fn apply_payment_approval_secret_from_map(",
        "pub(crate) fn single_action_rejects_unsupported_execution_before_payment_claim(",
        "pub(crate) fn should_claim_payment_approval(",
        "pub(crate) fn claim_payment_approval_for_action(",
        "pub(crate) fn validate_payment_approval_for_action(",
        "pub(crate) fn validated_payment_approval_id(",
        "pub(crate) fn claim_payment_approval_from_map(",
        "pub(crate) fn prune_expired_payment_approvals(",
        "pub(crate) fn lock_payment_approvals(",
    ]:
        assert_contains(
            payment_approval_source,
            snippet,
            "payment approval owner must expose claim/secret surfaces",
        )
    for snippet in [
        "fn payment_approval_marker(",
        "async fn vault_payment_approval_approve(",
        "fn payment_approval_grant_from_request(",
        "fn payment_approval_marker_matches(",
        "fn rewrite_payment_approval_to_done(",
        "fn browser_action_requires_payment_grant(",
        "async fn execute_pending_approval(",
        "async fn dispatch_remote_approval(",
    ]:
        assert_not_contains(
            payment_approval_source,
            snippet,
            "payment approval owner must not absorb vault/browser/remote surfaces",
        )
    assert_contains(
        action_confirmations_source,
        "pub(crate) const COMPOSIO_CONFIRM_OPEN:",
        "action confirmation owner must expose Composio confirmation marker constants",
    )
    assert_contains(
        action_confirmations_source,
        "pub(crate) fn composio_confirm_matches(",
        "action confirmation owner must expose Composio confirmation matching",
    )
    assert_contains(
        action_confirmations_source,
        "pub(crate) fn rewrite_confirm_to_done(",
        "action confirmation owner must expose Composio confirmation rewrite",
    )
    assert_contains(source, "mod gateway_mcp_chat_tools;", "gateway root must declare MCP chat tools owner")
    assert_contains(source, "mod gateway_mcp_connections;", "gateway root must declare MCP connection route owner")
    assert_contains(source, "mod gateway_mcp_execution;", "gateway root must declare MCP execution route owner")
    assert_contains(source, "mod gateway_mcp_runtime;", "gateway root must declare MCP runtime owner")
    assert_contains(source, "mod gateway_thread_files;", "gateway root must declare thread file owner")
    assert_contains(source, "mod gateway_transcription;", "gateway root must declare transcription owner")
    assert_contains(source, "mod gateway_usage_routes;", "gateway root must declare usage route owner")
    assert_contains(source, "mod gateway_tags;", "gateway root must declare tag route owner")
    assert_contains(source, "mod gateway_update_routes;", "gateway root must declare update route owner")
    assert_contains(source, "mod gateway_skill_routes;", "gateway root must declare skill route owner")
    assert_contains(source, "mod gateway_skill_runtime;", "gateway root must declare skill runtime owner")
    assert_contains(
        source,
        "pub(crate) use gateway_skill_runtime::*;",
        "gateway root must re-export skill runtime owner",
    )
    assert_contains(
        source,
        "mod gateway_memory_publications;",
        "gateway root must declare memory publication owner",
    )
    assert_contains(
        source,
        "mod gateway_memory_sources;",
        "gateway root must declare memory source owner",
    )
    assert_contains(source, "mod gateway_memory_bench;", "gateway root must declare MemoryBench owner")
    assert_contains(
        source,
        "mod gateway_memory_ui_routes;",
        "gateway root must declare memory UI routes owner",
    )
    assert_contains(source, "mod gateway_project_access;", "gateway root must declare project access owner")
    assert_contains(source, "mod gateway_workspaces;", "gateway root must declare workspace registry owner")
    assert_contains(source, "mod gateway_write_tool_allowlist;", "gateway root must declare write-tool allow-list owner")
    assert_contains(source, "mod gateway_task_maintenance;", "gateway root must declare task maintenance owner")
    assert_contains(source, "mod gateway_memory_background;", "gateway root must declare memory background owner")
    assert_contains(source, "mod gateway_remote_approval;", "gateway root must declare remote approval owner")
    for snippet in [
        "pub(crate) fn create_pending_approval(",
        "pub(crate) fn pending_approval_exists(",
        "pub(crate) fn approval_progress_reply(",
        "pub(crate) fn parse_approval_reply(",
        "pub(crate) fn remote_approval_thread_status(",
        "pub(crate) fn append_remote_approval_thread_status(",
        "pub(crate) fn approval_resume_prompt(",
        "pub(crate) fn approval_continuation_visible_text(",
        "pub(crate) fn approval_continuation_turn_input(",
        "pub(crate) fn resume_thread_after_approval(",
    ]:
        assert_contains(
            remote_approval_source,
            snippet,
            "remote approval owner must expose approval control/continuation helpers",
        )
    assert_contains(source, "mod gateway_plugins;", "gateway root must declare plugin enablement owner")
    assert_contains(source, "mod gateway_plugin_packages;", "gateway root must declare plugin package owner")
    assert_contains(source, "mod gateway_chat_threads;", "gateway root must declare chat thread owner")
    assert_contains(source, "mod gateway_chat_branches;", "gateway root must declare chat branch owner")
    assert_contains(source, "mod gateway_chat_tasks;", "gateway root must declare chat task owner")
    assert_contains(source, "mod gateway_chat_memory;", "gateway root must declare chat memory owner")
    assert_contains(
        source,
        "mod gateway_chat_utility_routes;",
        "gateway root must declare chat utility route owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_chat_utility_routes::",
        "gateway root must re-export chat utility route owner",
    )
    assert_contains(
        chat_utility_routes_source,
        "pub(crate) async fn improve_prompt(",
        "chat utility route owner must expose improve-prompt handler",
    )
    assert_contains(
        chat_utility_routes_source,
        "fn title_model_inputs(",
        "chat utility route owner must own title model input cleanup",
    )
    assert_contains(
        source,
        "mod gateway_proactivity_routes;",
        "gateway root must declare proactivity route owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_proactivity_routes::",
        "gateway root must re-export proactivity route owner",
    )
    assert_contains(
        proactivity_routes_source,
        "pub(crate) async fn suggestions_list(",
        "proactivity route owner must expose suggestion list handler",
    )
    assert_contains(
        proactivity_routes_source,
        "fn proactive_memory_request_for_suggestion_action(",
        "proactivity route owner must own suggestion action memory write-back",
    )
    assert_contains(source, "mod gateway_turn_broker;", "gateway root must declare turn broker owner")
    assert_contains(
        source,
        "pub(crate) use gateway_turn_broker::*;",
        "gateway root must re-export turn broker owner",
    )
    assert_contains(source, "mod gateway_task_executor;", "gateway root must declare task executor owner")
    assert_contains(
        source,
        "pub(crate) use gateway_task_executor::*;",
        "gateway root must re-export task executor owner",
    )
    assert_contains(
        task_executor_source,
        "fn resource_class_label(",
        "task executor owner must expose resource class labels",
    )
    assert_contains(source, "mod gateway_memory_dedup;", "gateway root must declare memory dedup owner")
    assert_contains(
        source,
        "mod gateway_memory_query_embeddings;",
        "gateway root must declare memory query embedding owner",
    )
    for snippet in [
        "pub(crate) fn embed_model(",
        "pub(crate) fn embed_base(",
        "pub(crate) async fn embed_text(",
        "pub(crate) struct MemoryRecallTiming",
        "pub(crate) async fn embed_query_for_memory_recall(",
    ]:
        assert_contains(
            memory_query_embeddings_source,
            snippet,
            "memory query embedding owner must expose embedding transport surface",
        )
    assert_contains(source, "mod gateway_memory_json;", "gateway root must declare memory JSON owner")
    assert_contains(
        source,
        "pub(crate) use gateway_memory_json::{call_memory_json, strip_json_fences};",
        "gateway root must re-export memory JSON transport",
    )
    for snippet in [
        "pub(crate) fn strip_json_fences(",
        "pub(crate) async fn call_memory_json(",
    ]:
        assert_contains(
            memory_json_source,
            snippet,
            "memory JSON owner must expose JSON response transport",
        )
    for snippet in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn learn_via_service_or_inline(",
        "async fn consolidate_scope(",
    ]:
        assert_not_contains(
            memory_json_source,
            snippet,
            "memory JSON owner must not absorb adjacent memory surfaces",
        )
    assert_contains(
        source,
        "mod gateway_memory_learning;",
        "gateway root must declare memory learning owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_memory_learning::{consolidate_scope, learn_via_service_or_inline};",
        "gateway root must re-export memory learning surface",
    )
    for snippet in [
        "pub(crate) fn learn_via_service_or_inline(",
        "pub(crate) async fn consolidate_scope(",
    ]:
        assert_contains(
            memory_learning_source,
            snippet,
            "memory learning owner must expose learning and consolidation surface",
        )
    for snippet in [
        "fn recall_memory(",
        "fn recall_stream_payload_from_outcome(",
        "fn tombstone_automation_memory_records(",
        "fn record_subagent_task_step_outcome(",
    ]:
        assert_not_contains(
            memory_learning_source,
            snippet,
            "memory learning owner must not absorb adjacent memory surfaces",
        )
    assert_contains(
        source,
        "mod gateway_memory_recall_tool;",
        "gateway root must declare memory recall tool owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_memory_recall_tool::{\n    RecallOutcome, recall_memory, recall_stream_payload_from_outcome,\n};",
        "gateway root must re-export memory recall tool surface",
    )
    for snippet in [
        "pub(crate) struct RecallOutcome",
        "pub(crate) fn recall_stream_payload_from_outcome(",
        "pub(crate) fn recall_memory(",
    ]:
        assert_contains(
            memory_recall_tool_source,
            snippet,
            "memory recall tool owner must expose recall tool surface",
        )
    for snippet in [
        "fn learn_via_service_or_inline(",
        "async fn consolidate_scope(",
        "fn tombstone_automation_memory_records(",
        "fn record_subagent_task_step_outcome(",
    ]:
        assert_not_contains(
            memory_recall_tool_source,
            snippet,
            "memory recall tool owner must not absorb adjacent memory surfaces",
        )
    assert_contains(source, "mod gateway_memory_briefing;", "gateway root must declare memory briefing owner")
    assert_contains(
        source,
        "mod gateway_memory_turn_context;",
        "gateway root must declare memory turn context owner",
    )
    assert_contains(source, "mod gateway_memory_clients;", "gateway root must declare memory client owner")
    assert_contains(
        memory_clients_source,
        "pub(crate) async fn backfill_embeddings(",
        "memory client owner must expose embedding backfill orchestration",
    )
    assert_contains(
        source,
        "mod gateway_memory_recall_service;",
        "gateway root must declare memory recall service owner",
    )
    assert_contains(source, "mod gateway_memory_graph;", "gateway root must declare memory graph owner")
    assert_contains(
        source,
        "mod gateway_memory_graph_routes;",
        "gateway root must declare memory graph routes owner",
    )
    assert_contains(
        source,
        "mod gateway_memory_graph_maintenance;",
        "gateway root must declare memory graph maintenance owner",
    )
    assert_contains(source, "mod gateway_memory_hygiene;", "gateway root must declare memory hygiene owner")
    assert_contains(
        source,
        "mod gateway_memory_graph_persistence;",
        "gateway root must declare memory graph persistence owner",
    )
    assert_contains(source, "mod gateway_memory_tools;", "gateway root must declare memory tools owner")
    assert_contains(source, "mod gateway_plan_tools;", "gateway root must declare plan tools owner")
    assert_contains(
        source,
        "mod gateway_runtime_plan_state;",
        "gateway root must declare runtime plan state owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_runtime_plan_state::*;",
        "gateway root must re-export runtime plan state owner",
    )
    assert_contains(source, "mod gateway_thread_episodes;", "gateway root must declare thread episode owner")
    assert_contains(
        source,
        "pub(crate) use gateway_thread_episodes::*;",
        "gateway root must re-export thread episode owner",
    )
    assert_contains(source, "mod gateway_chat_markers;", "gateway root must declare chat marker owner")
    assert_contains(source, "mod gateway_tool_budget;", "gateway root must declare tool budget owner")
    assert_contains(source, "mod gateway_tool_timeouts;", "gateway root must declare tool timeout owner")
    assert_contains(
        source,
        "mod gateway_capability_registry;",
        "gateway root must declare capability registry owner",
    )
    assert_contains(
        source,
        "mod gateway_capability_routing;",
        "gateway root must declare capability routing owner",
    )
    assert_contains(
        capability_routing_source,
        "pub(crate) struct GatewayTurnPolicy",
        "capability routing owner must expose turn policy port",
    )
    assert_contains(
        source,
        "mod gateway_project_search_tools;",
        "gateway root must declare project search tools owner",
    )
    assert_contains(source, "mod gateway_datetime_tools;", "gateway root must declare datetime tools owner")
    assert_contains(source, "mod gateway_runtime_flags;", "gateway root must declare runtime flags owner")
    assert_contains(
        runtime_flags_source,
        "pub(crate) fn verbose_debug(",
        "runtime flags owner must expose verbose debug env flag",
    )
    assert_contains(
        source,
        "mod gateway_runtime_settings;",
        "gateway root must declare runtime settings owner",
    )
    assert_contains(source, "mod gateway_model_routes;", "gateway root must declare model route owner")
    assert_contains(source, "mod gateway_model_routing;", "gateway root must declare model routing owner")
    assert_contains(
        model_routing_source,
        "pub(crate) struct RoutingDecision",
        "model routing owner must expose routing decision log DTO",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) struct GatewayContextCompactor",
        "model routing owner must expose context compactor port",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) struct GatewayTurnCompletionJudge",
        "model routing owner must expose turn completion judge port",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn agent_output_incomplete_reason(",
        "model routing owner must expose agent output completion policy",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn log_routing_decision(",
        "model routing owner must expose routing decision log writer",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn build_router_from(",
        "model routing owner must expose model router factory",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn router_for_role(",
        "model routing owner must expose role router factory",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn resolve_role_for_task(",
        "model routing owner must expose semantic role resolution",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn build_inference_router_from_env(",
        "model routing owner must expose legacy env router factory",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn inference_locality(",
        "model routing owner must expose inference locality classification",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) fn inference_provider_id(",
        "model routing owner must expose inference provider identity",
    )
    assert_contains(
        model_routing_source,
        "pub(crate) async fn recorded_openai_value(",
        "model routing owner must expose recorded OpenAI transport",
    )
    assert_contains(source, "mod gateway_vault_routes;", "gateway root must declare vault route owner")
    assert_contains(
        source,
        "mod gateway_local_authorization_routes;",
        "gateway root must declare local authorization route owner",
    )
    assert_contains(source, "mod gateway_composio_routes;", "gateway root must declare Composio route owner")
    assert_contains(
        source,
        "mod gateway_composio_execution;",
        "gateway root must declare Composio execution owner",
    )
    assert_contains(
        source,
        "mod gateway_remote_approval_execution;",
        "gateway root must declare remote approval execution owner",
    )
    assert_contains(source, "mod gateway_connector_errors;", "gateway root must declare connector error owner")
    assert_contains(source, "mod gateway_image_generation;", "gateway root must declare image generation owner")
    assert_contains(
        source,
        "pub(crate) use gateway_image_generation::*;",
        "gateway root must re-export image generation owner",
    )
    assert_contains(
        source,
        "mod gateway_prompt_instructions;",
        "gateway root must declare prompt instructions owner",
    )
    assert_contains(source, "mod gateway_prompt_packets;", "gateway root must declare prompt packet owner")
    assert_contains(
        source,
        "pub(crate) use gateway_prompt_packets::*;",
        "gateway root must re-export prompt packet owner",
    )
    assert_contains(source, "mod gateway_brain_runtime;", "gateway root must declare brain runtime owner")
    assert_contains(
        source,
        "pub(crate) use gateway_brain_runtime::*;",
        "gateway root must re-export brain runtime owner",
    )
    assert_contains(
        source,
        "mod gateway_brain_materialization;",
        "gateway root must declare brain materialization owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_brain_materialization::*;",
        "gateway root must re-export brain materialization owner",
    )
    assert_contains(source, "mod gateway_automation_tools;", "gateway root must declare automation tools owner")
    assert_contains(
        source,
        "mod gateway_automation_formatting;",
        "gateway root must declare automation formatting owner",
    )
    for snippet in [
        "pub(crate) fn humanize_recurrence(",
        "pub(crate) fn automation_trigger_summary(",
        "pub(crate) fn scheduled_thread_sender_for_task_id(",
        "pub(crate) fn scheduled_thread_title(",
    ]:
        assert_contains(
            automation_formatting_source,
            snippet,
            "automation formatting owner must expose formatting helpers",
        )
    assert_contains(
        source,
        "mod gateway_proactive_threads;",
        "gateway root must declare proactive thread owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_proactive_threads::*;",
        "gateway root must re-export proactive thread owner",
    )
    for snippet in [
        "pub(crate) struct ProactiveThreadPlan",
        "pub(crate) fn proactive_thread_plan(",
        "pub(crate) fn proactive_thread_scope(",
    ]:
        assert_contains(
            proactive_threads_source,
            snippet,
            "proactive thread owner must expose thread planning helpers",
        )
    assert_contains(
        source,
        "mod gateway_shell_tasks;",
        "gateway root must declare shell task owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_shell_tasks::*;",
        "gateway root must re-export shell task owner",
    )
    for snippet in [
        "pub(crate) fn redact_json_for_task_output(",
        "pub(crate) fn execute_shell_read_only_task(",
        "pub(crate) fn run_read_only_command(",
    ]:
        assert_contains(
            shell_tasks_source,
            snippet,
            "shell task owner must expose read-only shell helpers",
        )
    assert_contains(
        source,
        "mod gateway_automation_requests;",
        "gateway root must declare automation request owner",
    )
    assert_contains(
        source,
        "mod gateway_automation_routes;",
        "gateway root must declare automation route owner",
    )
    assert_contains(source, "mod gateway_artifact_memory;", "gateway root must declare artifact memory owner")
    assert_contains(source, "mod gateway_artifacts;", "gateway root must declare artifact file owner")
    assert_contains(source, "mod gateway_memory_wiki;", "gateway root must declare memory wiki owner")
    assert_contains(source, "mod gateway_template_catalog;", "gateway root must declare template catalog owner")
    assert_contains(source, "mod gateway_project_files;", "gateway root must declare project files owner")
    assert_contains(source, "mod gateway_browser_tools;", "gateway root must declare browser tools owner")
    assert_contains(
        source,
        "mod gateway_browser_runtime;",
        "gateway root must declare browser runtime owner",
    )
    assert_contains(
        source,
        "mod gateway_project_graph_routes;",
        "gateway root must declare project graph route owner",
    )
    assert_contains(source, "mod gateway_deliverables;", "gateway root must declare deliverables owner")
    assert_contains(source, "mod gateway_tool_execution;", "gateway root must declare tool execution owner")
    assert_contains(source, "mod gateway_channels;", "gateway root must declare channels owner")
    assert_contains(source, "mod gateway_contacts;", "gateway root must declare core contacts owner")
    assert_contains(
        source,
        "pub(crate) use gateway_contacts::*;",
        "gateway root must re-export core contacts owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_model_routes::*;",
        "gateway root must re-export model route owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_project_graph_routes::*;",
        "gateway root must re-export project graph route owner",
    )
    assert_contains(
        source,
        "pub(crate) use gateway_capability_routing::*;",
        "gateway root must re-export capability routing owner",
    )
    assert_contains(
        source,
        "#[cfg(test)]\nmod gateway_main_tests;",
        "gateway root must declare extracted main test owner",
    )
    assert_not_contains(source, "\nmod tests {", "gateway root tests must stay in gateway_main_tests")

    required_owner_calls = [
        "gateway_boot_maintenance::run_gateway_boot_maintenance(&state);",
        "gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;",
        "gateway_background_startup::start_gateway_background_services(state.clone());",
        "let app = gateway_routes::build_gateway_router(state.clone());",
    ]
    for snippet in required_owner_calls:
        assert_contains(main_body, snippet, "async fn main must delegate startup ownership")

    for snippet, message in forbidden_main_startup_snippets().items():
        assert_not_contains(main_body, snippet, message)

    for snippet, message in forbidden_root_snippets().items():
        assert_not_contains(source, snippet, message)
    assert_not_contains(
        browser_tools_source,
        "fn mcp_call_timeout(",
        "MCP timeout policy must not be owned by browser tools",
    )
    assert_contains(
        vault_routes_source,
        "pub(crate) async fn vault_records_list(",
        "vault route owner must expose vault records list route",
    )
    assert_contains(
        vault_routes_source,
        "pub(crate) fn recall_memory_response_with_vault_fallback(",
        "vault route owner must expose memory recall fallback",
    )
    assert_contains(
        vault_routes_source,
        "fn query_has_sensitive_vault_term(",
        "vault route owner must own sensitive-term recall policy",
    )
    assert_contains(
        vault_routes_source,
        "fn vault_reveal_marker(",
        "vault route owner must own reveal-card marker construction",
    )
    assert_contains(
        local_authorization_routes_source,
        "pub(crate) async fn fs_authorize(",
        "local authorization route owner must expose filesystem authorization route",
    )
    assert_contains(
        composio_routes_source,
        "pub(crate) async fn connect_composio(",
        "Composio route owner must expose connection route",
    )
    assert_contains(
        composio_routes_source,
        "pub(crate) struct GatewayComposioTransport",
        "Composio route owner must expose HTTP transport",
    )
    assert_contains(
        connector_errors_source,
        "pub(crate) enum ConnectorErrorKind",
        "connector error owner must expose classified error kinds",
    )
    assert_contains(
        connector_errors_source,
        "pub(crate) fn classify_connector_error(",
        "connector error owner must expose connector error classification",
    )
    assert_contains(
        connector_errors_source,
        "pub(crate) fn connector_error_hint(",
        "connector error owner must expose connector user hints",
    )
    assert_contains(
        connector_errors_source,
        "pub(crate) fn mcp_error_hint(",
        "connector error owner must expose MCP user hints",
    )
    assert_contains(
        connector_errors_source,
        "pub(crate) fn record_connector_run(",
        "connector error owner must expose connector audit logging",
    )
    assert_contains(
        connector_errors_source,
        "pub(crate) fn composio_execution_error(",
        "connector error owner must expose Composio execution failure detection",
    )
    assert_contains(
        image_generation_source,
        "pub(crate) fn deck_slide_image_prompt(",
        "image generation owner must expose deck slide prompt policy",
    )
    assert_contains(
        image_generation_source,
        "pub(crate) async fn generate_image_png(",
        "image generation owner must expose image provider execution",
    )
    assert_contains(
        task_executor_config_source,
        'pub(crate) const TASK_EXECUTOR_MANUAL_WORKER_ID: &str = "desktop-gateway-manual-run";',
        "task executor config must expose manual worker id",
    )
    assert_contains(
        task_executor_config_source,
        "pub(crate) const TASK_EXECUTOR_POLL_INTERVAL_MS: u64 = 1_000;",
        "task executor config must expose poll interval",
    )
    assert_contains(
        boot_maintenance_source,
        "fn seed_default_skills(",
        "boot maintenance owner must own default skill seeding",
    )
    assert_contains(
        boot_maintenance_source,
        "fn skill_tree_hash(",
        "boot maintenance owner must own default skill tree hashing",
    )
    assert_contains(
        skill_runtime_source,
        "pub(crate) fn use_skill_tool_schema(",
        "skill runtime owner must expose use_skill schema",
    )
    assert_contains(
        skill_runtime_source,
        "pub(crate) fn slugify_skill_name(",
        "skill runtime owner must expose skill id normalization",
    )
    assert_contains(
        skill_runtime_source,
        "pub(crate) fn load_skill_body_and_sensitive(",
        "skill runtime owner must expose progressive skill loading with sensitive metadata",
    )
    assert_contains(
        runtime_plan_state_source,
        "pub(crate) fn upsert_runtime_plan_memory_from_state(",
        "runtime plan state owner must expose canonical plan persistence",
    )
    assert_contains(
        runtime_plan_state_source,
        "pub(crate) fn plan_tool_sent(",
        "runtime plan state owner must expose plan tool parsing",
    )
    assert_contains(
        runtime_plan_state_source,
        "pub(crate) struct GatewayPlanProgress",
        "runtime plan state owner must expose engine plan progress port",
    )
    assert_contains(
        thread_episodes_source,
        "pub(crate) const THREADS_WORKSPACE",
        "thread episode owner must expose the reserved thread workspace",
    )
    assert_contains(
        thread_episodes_source,
        "pub(crate) fn store_episode(",
        "thread episode owner must expose episode persistence",
    )
    assert_contains(
        thread_episodes_source,
        "pub(crate) fn current_thread_episode_block(",
        "thread episode owner must expose prompt block projection",
    )
    assert_contains(
        thread_episodes_source,
        "pub(crate) fn episode_metadata_matches_scope(",
        "thread episode owner must expose exact scope matching",
    )
    assert_contains(
        prompt_packets_source,
        "pub(crate) const MAX_PROJECT_INSTRUCTION_CHARS",
        "prompt packet owner must expose project instruction size limit",
    )
    assert_contains(
        prompt_packets_source,
        "pub(crate) fn read_project_instruction(",
        "prompt packet owner must expose project instruction reads",
    )
    assert_contains(
        prompt_packets_source,
        "pub(crate) fn compose_gateway_prompt_packets(",
        "prompt packet owner must expose packet composition",
    )
    assert_contains(
        brain_runtime_source,
        "pub(crate) const CAPABLE_MODEL_CONTEXT_WINDOW",
        "brain runtime owner must expose context-window threshold",
    )
    assert_contains(
        brain_runtime_source,
        "pub(crate) struct GatewayBrainMemory",
        "brain runtime owner must expose memory adapter",
    )
    assert_contains(
        brain_runtime_source,
        "pub(crate) fn brain_materialize_enabled(",
        "brain runtime owner must expose enablement flag",
    )
    assert_contains(
        brain_runtime_source,
        "pub(crate) fn open_brain_memory(",
        "brain runtime owner must expose memory opener",
    )
    assert_contains(
        brain_runtime_source,
        "pub(crate) fn brain_budgets_for_context_window(",
        "brain runtime owner must expose budget policy",
    )
    for snippet in [
        "pub(crate) fn brain_materialize_tasks(",
        "pub(crate) fn link_brain_tasks_to_thread(",
        "pub(crate) fn set_session_progress_total(",
    ]:
        assert_contains(
            brain_materialization_source,
            snippet,
            "brain materialization owner must expose durable task materialization helpers",
        )

    assert_ordered(
        main_body,
        [
            "gateway_file_security::harden_data_at_rest(&dir);",
            "gateway_boot_maintenance::run_gateway_boot_maintenance(&state);",
            "gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;",
            "gateway_background_startup::start_gateway_background_services(state.clone());",
            "let app = gateway_routes::build_gateway_router(state.clone());",
            "let computer_warmup_state = startup_state.clone();",
        ],
        "async fn main startup order must keep critical recovery before background work",
    )

    print("gateway main ownership contract passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"gateway main ownership contract failed: {error}", file=sys.stderr)
        raise SystemExit(1)
