// Shared browser high-risk safety gate (used by the main-agent-driven
// browser_* tools).
// The `browser_act_tool_schema` (and other large `serde_json::json!` literals) expand past the
// default 128 macro-recursion depth; 256 is the standard headroom for big inline JSON (compile-time
// only, no runtime effect).
#![recursion_limit = "256"]
mod agent_journal;
mod apply_patch;
mod attachments;
mod browser_safety;
mod chat_store;
mod hitl_resume;
mod host_computer_gateway;
// One-shot fuse of the two legacy SQLite files into the unified homun.sqlite.
mod db_migrate;
// Document CONTENT slot-schema (Fase 2 documents, Task 6): strict slot-filling
// schema derived from a pack's example.json skeleton + assembly back into
// doc.json. Wired into make_document's templated path (F2-T8,
// make_templated_document).
mod document_content;
mod effect_host;
mod execution_adapter_context;
mod execution_control;
mod execution_host;
mod execution_projection;
mod execution_runtime;
mod gateway_action_confirmations;
mod gateway_actionable_source;
mod gateway_agent_checkpoints;
mod gateway_agent_stream_drain;
mod gateway_agent_stream_events;
mod gateway_agent_stream_persistence;
mod gateway_agent_turn_config;
mod gateway_agent_turn_hitl_resume;
mod gateway_agent_turn_identity;
mod gateway_agent_turn_loop_seed;
mod gateway_agent_turn_model_seed;
mod gateway_agent_turn_outcomes;
mod gateway_agent_turn_plan_seed;
mod gateway_agent_turn_recall_seed;
mod gateway_agent_turn_recovery_seed;
mod gateway_agent_turn_route_trace;
mod gateway_agent_turn_runner;
mod gateway_agent_turn_sensitive;
mod gateway_agent_turn_tail;
mod gateway_agent_turn_tool_seed;
mod gateway_agent_turn_trace_dump;
mod gateway_agent_wake;
mod gateway_artifact_memory;
mod gateway_artifacts;
mod gateway_auth;
mod gateway_automation_formatting;
mod gateway_automation_requests;
mod gateway_automation_routes;
mod gateway_automation_tools;
mod gateway_background_startup;
mod gateway_bind;
mod gateway_boot_maintenance;
mod gateway_brain_materialization;
mod gateway_brain_runtime;
mod gateway_browser_runtime;
mod gateway_browser_tools;
mod gateway_capability_execution;
mod gateway_capability_registry;
mod gateway_capability_routing;
mod gateway_channels;
mod gateway_chat_branches;
mod gateway_chat_code_map_prompt;
mod gateway_chat_connected_prompt;
mod gateway_chat_markers;
mod gateway_chat_memory;
mod gateway_chat_plan_resume;
mod gateway_chat_prompt_layers;
mod gateway_chat_streams;
mod gateway_chat_tasks;
mod gateway_chat_threads;
mod gateway_chat_tool_perimeter;
mod gateway_chat_toolset;
mod gateway_chat_turn_context;
mod gateway_chat_utility_routes;
mod gateway_chat_vision_preflight;
mod gateway_chat_vision_recovery;
mod gateway_chat_workspace_prompt_context;
mod gateway_composio_execution;
mod gateway_composio_routes;
mod gateway_connector_errors;
mod gateway_contact_perimeter;
mod gateway_contact_profile;
mod gateway_contact_profiles;
mod gateway_contact_relationships;
mod gateway_contacts;
mod gateway_cors;
mod gateway_datetime_tools;
mod gateway_db_unify;
mod gateway_deliverables;
mod gateway_file_security;
mod gateway_health;
mod gateway_hitl_waits;
mod gateway_http_client;
mod gateway_identity;
mod gateway_image_generation;
mod gateway_legacy_data;
mod gateway_local_authorization_routes;
mod gateway_mcp_chat_tools;
mod gateway_mcp_connections;
mod gateway_mcp_execution;
mod gateway_mcp_runtime;
mod gateway_memory_background;
mod gateway_memory_bench;
mod gateway_memory_briefing;
mod gateway_memory_clients;
mod gateway_memory_dedup;
mod gateway_memory_goals;
mod gateway_memory_graph;
mod gateway_memory_graph_maintenance;
mod gateway_memory_graph_persistence;
mod gateway_memory_graph_routes;
mod gateway_memory_hygiene;
mod gateway_memory_json;
mod gateway_memory_learning;
mod gateway_memory_prompt_context;
mod gateway_memory_publications;
mod gateway_memory_query_embeddings;
mod gateway_memory_recall_service;
mod gateway_memory_recall_tool;
mod gateway_memory_reuse;
mod gateway_memory_sources;
mod gateway_memory_tools;
mod gateway_memory_turn_context;
mod gateway_memory_ui_routes;
mod gateway_memory_wiki;
mod gateway_model_routes;
mod gateway_model_routing;
mod gateway_model_timeouts;
mod gateway_paths;
mod gateway_payment_approval;
mod gateway_plan_stall;
mod gateway_plan_tools;
mod gateway_plugin_packages;
mod gateway_plugins;
mod gateway_privacy_preflight;
mod gateway_proactive_execution;
mod gateway_proactive_threads;
mod gateway_proactivity;
mod gateway_proactivity_routes;
mod gateway_process_bootstrap;
mod gateway_process_events;
mod gateway_project_access;
mod gateway_project_files;
mod gateway_project_graph_routes;
mod gateway_project_search_tools;
mod gateway_prompt;
mod gateway_prompt_instructions;
mod gateway_prompt_packets;
mod gateway_recall_context;
mod gateway_remote_approval;
mod gateway_remote_approval_execution;
mod gateway_routes;
mod gateway_runtime_flags;
mod gateway_runtime_plan_state;
mod gateway_runtime_settings;
mod gateway_secrets;
mod gateway_shell_tasks;
mod gateway_skill_routes;
mod gateway_skill_runtime;
mod gateway_state_access;
mod gateway_store_integrity;
mod gateway_subagent_execution;
mod gateway_system_status;
mod gateway_tags;
mod gateway_task_executor;
mod gateway_task_executor_config;
mod gateway_task_inputs;
mod gateway_task_maintenance;
mod gateway_template_catalog;
mod gateway_temporal_preflight;
mod gateway_text_safety;
mod gateway_thread_episodes;
mod gateway_thread_files;
mod gateway_thread_model_context;
mod gateway_time;
mod gateway_tool_budget;
mod gateway_tool_execution;
mod gateway_tool_timeouts;
mod gateway_transcription;
mod gateway_turn_broker;
mod gateway_turn_recovery;
mod gateway_turn_trace;
mod gateway_update_routes;
mod gateway_usage_routes;
mod gateway_usage_runtime;
mod gateway_user_preferences;
mod gateway_vault_key;
mod gateway_vault_routes;
mod gateway_visible_turns;
mod gateway_workspaces;
mod gateway_write_tool_allowlist;
// The concrete engine::ModelClient (ADR 0024): owns the per-round model HTTP call.
mod inference_transport;
mod model_client;
mod model_error_mapping;
mod provider_usage;
mod runtime_context;
mod usage_pricing;
mod usage_store;
mod usage_suggestions;
// Model-output normalization moved WHOLE into the engine crate (ADR 0024 inc 5e.3, pure serde
// module); re-exported so `model_normalize::…` call sites are unchanged.
use local_first_engine::model_normalize;
// Brings `.record(...)` into scope for direct calls on a `GatewayJournal` (C2, browser-protocol
// metrics); `run_turn`'s own generic `J: ExecutionJournal` parameter doesn't need this import, but
// calling the method directly outside that generic context does.
#[cfg(test)]
pub(crate) use attachments::append_thread_attachment_context;
pub(crate) use gateway_actionable_source::*;
pub(crate) use gateway_agent_checkpoints::*;
pub(crate) use gateway_agent_stream_drain::*;
pub(crate) use gateway_agent_stream_events::*;
pub(crate) use gateway_agent_stream_persistence::*;
pub(crate) use gateway_agent_turn_config::*;
pub(crate) use gateway_agent_turn_hitl_resume::*;
pub(crate) use gateway_agent_turn_identity::*;
pub(crate) use gateway_agent_turn_loop_seed::*;
pub(crate) use gateway_agent_turn_model_seed::*;
pub(crate) use gateway_agent_turn_plan_seed::*;
pub(crate) use gateway_agent_turn_recall_seed::*;
pub(crate) use gateway_agent_turn_recovery_seed::*;
pub(crate) use gateway_agent_turn_route_trace::*;
pub(crate) use gateway_agent_turn_runner::*;
pub(crate) use gateway_agent_turn_sensitive::*;
pub(crate) use gateway_agent_turn_tail::*;
pub(crate) use gateway_agent_turn_tool_seed::*;
pub(crate) use gateway_agent_turn_trace_dump::*;
pub(crate) use gateway_agent_wake::*;
pub(crate) use gateway_artifacts::*;
pub(crate) use gateway_automation_routes::*;
pub(crate) use gateway_brain_materialization::*;
pub(crate) use gateway_brain_runtime::*;
pub(crate) use gateway_browser_runtime::*;
pub(crate) use gateway_chat_code_map_prompt::*;
pub(crate) use gateway_chat_connected_prompt::*;
pub(crate) use gateway_chat_plan_resume::*;
pub(crate) use gateway_chat_prompt_layers::*;
pub(crate) use gateway_chat_streams::*;
pub(crate) use gateway_chat_tool_perimeter::*;
pub(crate) use gateway_chat_toolset::*;
pub(crate) use gateway_chat_turn_context::*;
pub(crate) use gateway_chat_vision_preflight::*;
pub(crate) use gateway_chat_vision_recovery::*;
pub(crate) use gateway_chat_workspace_prompt_context::*;
pub(crate) use gateway_composio_execution::*;
pub(crate) use gateway_composio_routes::*;
pub(crate) use gateway_connector_errors::*;
pub(crate) use gateway_hitl_waits::*;
pub(crate) use gateway_image_generation::*;
pub(crate) use gateway_local_authorization_routes::*;
#[cfg(test)]
pub(crate) use gateway_memory_bench::{
    MemoryBenchIngestRequest, MemoryBenchMessage, MemoryBenchSearchRequest, MemoryBenchSession,
    MemoryBenchStatusRequest, memorybench_workspace_id,
};
pub(crate) use gateway_memory_bench::{
    memory_bench_ingest, memory_bench_search, memory_bench_status,
};
#[cfg(test)]
use gateway_memory_briefing::{
    BriefingMemoryItem, format_memory_block, gather_profile_memory_for_prompt,
    gather_profile_memory_with_provenance,
};
use gateway_memory_briefing::{
    CHAT_MEMORY_BUDGET_CHARS, MemoryInjectionPolicy, format_memory_block_with_provenance,
    gather_profile_memory_for_workspace_with_provenance, memory_briefing_source_fingerprint,
    memory_injection_policy, memory_intent_allows_recall,
    memory_intent_context_for_semantic_contract, memory_intent_for_execution,
    revalidated_cached_briefing,
};
#[cfg(test)]
use gateway_memory_dedup::normalize_for_dedup;
use gateway_memory_dedup::{
    DEDUP_COSINE, DEDUP_JACCARD, cosine, dedup_tokens, forgotten_token_sets, is_semantic_duplicate,
    is_suppressed, jaccard,
};
pub(crate) use gateway_memory_learning::{consolidate_scope, learn_via_service_or_inline};
pub(crate) use gateway_memory_prompt_context::decisions_for_path;
#[cfg(test)]
use gateway_memory_prompt_context::{
    artifact_provenance_context_for_query, workflow_status_context_for_query,
};
#[cfg(test)]
use gateway_memory_query_embeddings::memory_recall_timing_trace_line;
pub(crate) use gateway_memory_query_embeddings::{
    MemoryRecallTiming, embed_model, embed_query_for_memory_recall, embed_text,
};
pub(crate) use gateway_memory_recall_tool::{
    RecallOutcome, recall_memory, recall_stream_payload_from_outcome,
};
pub(crate) use gateway_memory_reuse::{
    StreamMemoryReuseCollector, memory_reuse_envelope_from_read_set,
};
pub(crate) use gateway_memory_ui_routes::{
    export_user_data, memory_dashboard, memory_export, memory_items,
};
pub(crate) use gateway_model_routes::*;
pub(crate) use gateway_privacy_preflight::*;
pub(crate) use gateway_proactive_execution::*;
pub(crate) use gateway_proactive_threads::*;
pub(crate) use gateway_process_events::*;
#[cfg(test)]
pub(crate) use gateway_project_access::{
    ProjectAccessGrant, list_project_access, load_project_access_file, remove_project_access,
    resolve_project_contact_policy, upsert_project_access,
};
pub(crate) use gateway_project_graph_routes::*;
#[cfg(test)]
use gateway_remote_approval::remote_approval_matches_persisted_message;
use gateway_remote_approval::{
    ActionableCard, actionable_cards_from_raw_text, append_remote_approval_thread_status,
    approval_continuation_visible_text, approval_progress_reply, cancel_pending_remote_approval,
    create_pending_approval, parse_approval_reply, pending_approval_exists,
    remote_approval_intent_from_raw_text, resume_thread_after_approval,
};
#[cfg(test)]
use gateway_remote_approval::{
    approval_continuation_turn_input, approval_resume_prompt, remote_approval_thread_status,
};
pub(crate) use gateway_remote_approval_execution::*;
pub(crate) use gateway_runtime_settings::*;
pub(crate) use gateway_shell_tasks::*;
#[cfg(test)]
pub(crate) use gateway_skill_routes::{clawhub_origin, valid_catalog_owner};
pub(crate) use gateway_state_access::*;
pub(crate) use gateway_system_status::*;
#[cfg(test)]
pub(crate) use gateway_text_safety::task_goal_summary;
pub(crate) use gateway_text_safety::{
    redact_sensitive_text, strip_terminal_control_sequences, truncate_chars,
};
pub(crate) use gateway_thread_model_context::*;
pub(crate) use gateway_turn_trace::*;
pub(crate) use gateway_user_preferences::*;
pub(crate) use gateway_vault_routes::*;
pub(crate) use gateway_visible_turns::*;
use local_first_engine::ExecutionJournal;
mod model_registry;
// Local scanner for Anthropic "Agent Skills" (SKILL.md folders).
mod skills;
// Skill catalog (ClawHub/OpenClaw) — cached + searchable, ported from Homun.
mod skills_catalog;
// Static security scan for installed skills, ported from Homun.
mod skill_security;
// Startup integrity sweep: quick_check + quarantine of corrupt SQLite stores (P0).
mod store_integrity;
// Skill execution sandbox (reuses the browser's contained-computer container).
mod mcp_http;
mod mcp_registry;
mod process_skills;
// Reverse proxy for the contained computer's noVNC live view (HTTP assets + WS),
// so a remote browser on the cloud build can watch the agent's computer.
mod novnc_proxy;
mod panic_log;
mod pdf_render;
mod plugin_packages;
mod privacy_guard;
mod projection_worker;
mod sandbox;
mod setup_computer;
// macOS Seatbelt (`sandbox-exec`) profile generator from a SandboxPolicy (ADR 0023,
// step 3; pure string generation — not wired yet).
mod seatbelt;
mod semantic_decision;
mod steering_control;
mod task_registry;
mod template_packs;
mod temporal;
mod turn_executor;
mod vision;
mod working_ledger;
mod ws_gateway;
// Codex-style tool-safety policy vocabulary + pure decision fn (ADR 0023, step 1;
// not wired yet — seam types only).
mod tool_safety;
// tool_trace_dump moved to `local_first_engine::trace` (5.D1c.9); the loop calls it there.

// ADR 0023 tool-safety vocabulary + pure decision fn, used by the (unconditional)
// write-confirm branches in `execute_chat_tool`.
use crate::tool_safety::{SafetyDecision, SandboxPolicy, assess_tool_safety};
use axum::{
    Json,
    body::Body,
    extract::{Path, Query, State},
    http::{StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use chat_store::{ChatStore, RemoteApprovalInput, RemoteApprovalRow};
pub(crate) use gateway_action_confirmations::{
    COMPOSIO_CONFIRM_CLOSE, COMPOSIO_CONFIRM_OPEN, MCP_CONFIRM_CLOSE, MCP_CONFIRM_OPEN,
    composio_confirm_matches, confirm_marker_matches_approval, confirm_marker_value,
    mcp_confirm_matches, mcp_confirm_matches_approval, rewrite_confirm_to_done,
    rewrite_mcp_confirm_to_done,
};
use gateway_artifact_memory::{
    DECK_ARTIFACT_NAMES, artifact_provenance_labels, emit_rendered_deck_artifacts,
    register_artifact_memory, register_mcp_filesystem_artifact_memory,
    register_project_file_artifact_memory,
};
#[cfg(test)]
pub(crate) use gateway_artifact_memory::{
    artifact_memory_kind, mcp_filesystem_project_relative_path_for_root,
    upsert_artifact_memory_record,
};
use gateway_automation_formatting::automation_trigger_summary;
#[cfg(test)]
pub(crate) use gateway_automation_formatting::{
    scheduled_thread_sender_for_task_id, scheduled_thread_title,
};
use gateway_automation_requests::{
    AutomationCreateRequest, AutomationScopeQuery, AutomationUpdateRequest,
    automation_workspace_scope,
};
use gateway_automation_tools::{
    create_automation_tool_schema, schedule_task_tool_schema, update_automation_tool_schema,
};
pub(crate) use gateway_browser_tools::{
    BROWSE_SUBTURN_MAX_ELAPSED_MS, BROWSER_UNSUPPORTED_COMMITTING_ACTION_ERROR,
    COMPOSIO_CATALOG_CAP, COMPOSIO_DISCOVERY_RESULTS, COMPOSIO_RESULT_CHARS, MCP_CATALOG_CAP,
    browse_subagent_nav_cap_for_contract, browser_act_error_hint, browser_act_tool_schema,
    browser_action_execution_fields_are_schema_legal, browser_action_outcome_hint,
    browser_dialog_tool_schema, browser_done_tool_schema, browser_navigate_failure_hint,
    browser_navigate_tool_schema, browser_rehydrate_tool_schema, browser_screenshot_tool_schema,
    browser_snapshot_tool_schema, browser_tabs_tool_schema, chat_browser_budget,
    chat_browser_max_rounds, chat_browser_nav_cap, chat_manager_browser_budget,
    computer_action_tool_schema, computer_get_state_tool_schema, computer_list_apps_tool_schema,
    initial_manager_tool_schemas_for_test, is_stale_ref_error, normalize_browser_action_bundle,
    parse_browser_done_payload, security_scan_block_reasons, stale_ref_recovery_message,
    use_computer_tool_schema,
};
#[cfg(test)]
pub(crate) use gateway_browser_tools::{
    BROWSER_ACT_SCHEMA_KINDS, bounded_browse_subagent_nav_cap, browse_tool_schema,
    manager_browser_guidance, manager_browser_max_elapsed_ms,
};
pub(crate) use gateway_capability_registry::{
    CapabilityCorpusMaterializationInput, CapabilityEntry, CapabilitySource,
    auto_retrieve_composio, bm25_rank, cap_tokenize, capability_discovery_trace_line,
    capability_snapshot, capability_source_label, find_capability_tool_schema,
    materialize_capability_corpus, open_seeded_capability_registry,
    search_connector_capability_entries, suggest_capabilities_tool_schema,
};
#[cfg(test)]
pub(crate) use gateway_capability_registry::{
    browser_registry_cached_tools, connector_capability_entry, mcp_capability_entries,
    search_composio_catalog, seed_default_capabilities,
};
pub(crate) use gateway_capability_routing::*;
pub(crate) use gateway_channels::*;
use gateway_chat_markers::strip_chat_markers;
pub(crate) use gateway_chat_utility_routes::{
    autotitle_chat_thread, chat_suggestions, improve_prompt, proactive_answer,
    seed_assistant_message,
};
use gateway_contact_perimeter::{contact_perimeter_get, contact_perimeter_set};
use gateway_contact_profile::{contact_profile, contact_profile_refresh};
use gateway_contact_profiles::{
    contact_assign_profile, profile_create, profile_delete, profile_update, profiles_list,
};
use gateway_contact_relationships::{
    contact_relationship_add, contact_relationship_remove, contact_relationships,
};
pub(crate) use gateway_contacts::*;
use gateway_datetime_tools::resolve_datetime_tool_schema;
pub(crate) use gateway_deliverables::*;
pub(crate) use gateway_file_security::path_within;
pub(crate) use gateway_identity::gateway_workspace_id;
pub(crate) use gateway_identity::{
    active_workspace_id, base_workspace_id, canonical_memory_workspace_id,
    gateway_capability_user_id, gateway_capability_workspace_id, gateway_memory_user_id,
    gateway_memory_workspace_id, gateway_user_id, set_active_workspace, set_memory_workspace,
};
#[cfg(test)]
pub(crate) use gateway_mcp_chat_tools::mcp_chat_tool_name;
pub(crate) use gateway_mcp_chat_tools::{McpChatTools, mcp_chat_tools, parse_mcp_chat_name};
#[cfg(test)]
pub(crate) use gateway_mcp_connections::{
    ConnectMcpRequest, connect_mcp_blocking, mcp_disconnect_blocking,
};
pub(crate) use gateway_mcp_connections::{
    connect_mcp, mcp_connected, mcp_disconnect, mcp_registry_search,
};
pub(crate) use gateway_mcp_execution::mcp_execute;
pub(crate) use gateway_mcp_runtime::{
    build_mcp_transport, mcp_discover_and_cache_tools, mcp_http_config_to_metadata,
    mcp_http_headers_to_secret, mcp_provider_slug, mcp_stdio_config_to_metadata,
    migrate_legacy_mcp_http_header_secrets, run_mcp_chat_tool,
};
#[cfg(test)]
pub(crate) use gateway_mcp_runtime::{
    mcp_http_config_from_connection, mcp_http_headers_from_secret, mcp_stdio_config_from_metadata,
};
pub(crate) use gateway_memory_clients::{
    backfill_embeddings, gateway_embedding_client, gateway_llm_client,
};
#[cfg(test)]
pub(crate) use gateway_memory_goals::GoalsListQuery;
pub(crate) use gateway_memory_goals::{
    memory_goals_add, memory_goals_list, memory_goals_promote, memory_goals_suggest,
    memory_project_briefing,
};
#[cfg(test)]
use gateway_memory_graph_maintenance::normalize_project_scope_entities;
use gateway_memory_graph_maintenance::{
    link_memory_mentions, reconcile_memory_scope, regenerate_graph_links,
};
use gateway_memory_graph_persistence::persist_graph;
use gateway_memory_graph_routes::{MemoryGraphQuery, resolve_memory_query_scope};
pub(crate) use gateway_memory_graph_routes::{
    memory_graph, memory_graph_merge, memory_graphify_import,
};
#[cfg(test)]
use gateway_memory_hygiene::memory_hygiene_suggestions_for_scope;
use gateway_memory_hygiene::{memory_hygiene_suggestions, normalized_entity_name};
#[cfg(test)]
pub(crate) use gateway_memory_publications::{
    memory_publication_approve, memory_publication_create, memory_publication_edit,
    memory_publication_get, memory_publication_reject,
};
#[cfg(test)]
use gateway_memory_recall_service::InProcessMemoryRecallService;
use gateway_memory_recall_service::install_memory_service_if_enabled;
#[cfg(test)]
use gateway_memory_recall_service::recall_pack_on_facade;
#[cfg(test)]
pub(crate) use gateway_memory_sources::{
    MemorySourceOverrideInput, MemorySourceUpsertRequest, ValidatedMemorySourceInput,
    build_memory_source_grant, memory_source_candidates, memory_source_candidates_from_records,
    memory_source_facade_error, memory_source_grant_views, memory_source_revoke,
    memory_source_upsert, memory_sources_flag, memory_sources_list, validate_memory_source_input,
    validate_memory_source_overrides, validate_memory_source_workspaces,
};
pub(crate) use gateway_memory_sources::{
    load_persisted_memory_source_workspace_ids, memory_perimeter_allows_recall,
    memory_sources_enabled,
};
use gateway_memory_tools::{
    forget_memory, forget_memory_tool_schema, memory_decide, recall_memory_tool_schema,
    record_decision, record_decision_tool_schema,
};
use gateway_memory_turn_context::objective_block_for_workspace;
#[cfg(test)]
use gateway_memory_turn_context::{
    project_brief_block, project_objective_block, recent_work_block, scope_from_active_workspace,
};
use gateway_memory_wiki::{
    active_open_loop_record, rebuild_decisions_wiki, rebuild_profile_wiki, rebuild_project_brief,
    rebuild_status_wiki,
};
#[cfg(test)]
use gateway_memory_wiki::{
    close_matching_open_loops, deduplicate_open_loops, status_wiki_body_from_open_loops,
};
pub(crate) use gateway_memory_wiki::{memory_consolidate, memory_wiki, memory_wiki_save};
pub(crate) use gateway_model_routing::*;
pub(crate) use gateway_model_timeouts::{
    model_first_token_timeout_secs, model_headers_timeout_secs, model_idle_timeout_secs,
    model_request_timeout_secs,
};
use gateway_paths::{
    gateway_browser_policy_database_path, gateway_data_dir, gateway_database_path,
    gateway_local_computer_database_path, gateway_logs_dir, gateway_memory_database_path,
    gateway_memory_wiki_dir, gateway_task_database_path, gateway_vault_database_path,
    gateway_workspaces_path,
};
pub(crate) use gateway_payment_approval::*;
pub(crate) use gateway_plan_stall::{
    MAX_PLAN_STALL_RESUMES, block_stalled_step, plan_stall_check_and_bump,
};
#[cfg(test)]
pub(crate) use gateway_plan_stall::{next_plan_stall, plan_stall_exhausted};
use gateway_plan_tools::{step_advance_tool_schema, update_plan_tool_schema};
#[cfg(test)]
use gateway_proactivity::parse_review_suggestion;
#[cfg(test)]
use gateway_proactivity::suggestion_choices_json;
pub(crate) use gateway_proactivity_routes::{
    proactivity_review_now, suggestion_act, suggestions_list, tool_runs_list,
};
#[cfg(test)]
pub(crate) use gateway_project_files::{
    CommandOutputError, command_output_with_timeout, fs_path_authorized, jail_absolute_in_root,
    workspace_filesystem_manifest, workspace_scoped_mcp_write_for_root,
};
pub(crate) use gateway_project_files::{
    FsAuthIssue, RunProjectOutcome, addons_enabled, apply_patch_in_project,
    apply_patch_tool_schema, create_skill_tool_schema, customize_addon_tool_schema,
    edit_file_tool_schema, edit_project_file, fs_authorize_folder, fs_expand_abs, fs_file, fs_list,
    fs_list_dir_contents, fs_read_text, fs_resolve_authorized, jail_in_root,
    list_addons_tool_schema, list_directory_tool_schema, list_files_tool_schema,
    list_project_files, project_filesystem_mcp_instruction, project_root_for_thread,
    read_file_tool_schema, read_project_file, read_text_file_tool_schema,
    run_bash_unsandboxed_result, run_in_project, run_in_project_tool_schema,
    show_addon_tool_schema, workspace_scoped_mcp_write, workspace_write_roots,
    write_file_tool_schema, write_project_file,
};
use gateway_project_search_tools::{
    github_search, github_search_tool_schema, query_code_graph, query_code_graph_tool_schema,
    query_git_history, query_git_history_tool_schema,
};
use gateway_prompt_instructions::{
    ChatCoreOperatingPromptInput, ChatRuntimePromptInput,
    browser_open_research_discovery_instruction, prepare_chat_core_operating_prompt,
    prepare_chat_runtime_prompt,
};
pub(crate) use gateway_prompt_packets::*;
#[cfg(test)]
pub(crate) use gateway_recall_context::format_recall_entry;
#[cfg(test)]
use gateway_recall_context::{
    gather_open_loops, memory_access_status_instruction, merge_automatic_recall_payload,
    recall_stream_payload_from_hits, recall_stream_payload_from_pack,
};
use gateway_recall_context::{
    memory_read_effects_from_recall_payload, sanitize_dedup_key, seed_loop_memory_reads,
};
pub(crate) use gateway_runtime_plan_state::*;
pub(crate) use gateway_skill_runtime::*;
// `memory_service_flag` is resolved via `crate::` from cfg(test) code only.
pub(crate) use gateway_memory_json::{call_memory_json, strip_json_fences};
#[cfg_attr(not(test), allow(unused_imports))]
use gateway_runtime_flags::{
    memory_service_enabled, memory_service_flag, plan_autoadvance_from_evidence_enabled,
    plan_reconcile_on_delivery_enabled, plan_stall_abort_enabled, turn_trace_enabled,
    turn_trace_max_bytes, verbose_debug,
};
use gateway_secrets::{open_browser_checkpoint_secret_store, open_gateway_secret_store};
pub(crate) use gateway_task_executor::*;
pub(crate) use gateway_task_inputs::task_effective_goal;
#[cfg(test)]
pub(crate) use gateway_template_catalog::{
    FileTemplateCatalogProvider, ImportPptxTemplateRequest, ImportedTemplatePackProvider,
    collect_template_catalog_entries, delete_imported_template_pack, import_pptx_template_pack,
    template_catalog_by_id_from_entries, template_catalog_entry,
    template_catalog_response_from_entries, template_preview_content_type,
};
pub(crate) use gateway_template_catalog::{
    TemplateCatalogEntry, TemplateCatalogProvider, clean_template_catalog_ref, delete_template,
    import_pptx_template, imported_template_preview_ref, parse_file_template_catalog_entry,
    template_catalog, template_catalog_by_id, template_catalog_capability_entries,
    template_preview, template_source_attachment,
};
pub(crate) use gateway_thread_episodes::*;
pub(crate) use gateway_thread_files::{
    effective_thread_folder, get_thread_folder, read_thread_file, search_thread_files,
    set_thread_folder,
};
pub(crate) use gateway_time::now_epoch_secs;
pub(crate) use gateway_tool_budget::{
    chat_max_rounds, hard_round_ceiling, tool_stays_live_this_turn,
};
pub(crate) use gateway_tool_execution::*;
pub(crate) use gateway_tool_timeouts::mcp_call_timeout;
pub(crate) use gateway_transcription::transcribe_audio;
pub(crate) use gateway_turn_broker::*;
pub(crate) use gateway_usage_routes::{
    apply_usage_suggestion, dismiss_usage_suggestion, get_usage_daily, get_usage_models,
    get_usage_processes, get_usage_provider_policy, get_usage_providers, get_usage_suggestions,
    get_usage_summary, refresh_usage_provider, set_usage_provider_policy,
};
use gateway_usage_runtime::{
    chat_response_usage_context, install_gateway_usage_recorder, open_gateway_usage_runtime,
};
#[cfg(test)]
pub(crate) use gateway_workspaces::merge_workspace_policy;
pub(crate) use gateway_workspaces::{
    WorkspaceRecord, WorkspacesFile, active_workspace_folder, create_workspace, delete_workspace,
    init_active_workspace_from_disk, load_workspaces_file, rename_workspace, reorder_workspaces,
    save_workspaces_file, select_workspace, set_workspace_folder, set_workspace_policy,
    upsert_workspace_root_memory_entity, workspaces_list,
};
pub(crate) use gateway_write_tool_allowlist::{
    add_composio_tool_allow, composio_allowed_tools, composio_revoke_allowed_tool,
    composio_tool_allowed,
};
use local_first_browser_automation::{
    BrowserAutomationClient, BrowserAutomationError, BrowserCheckpoint, BrowserMethod,
    BrowserResponse, BrowserSidecarSession, BrowserSidecarSpawnOptions, BrowserUrlApprovalGrant,
    BrowserUrlApprovalScope, BrowserUrlPolicyStore, BrowserVisibilityMode,
};
#[cfg(test)]
pub(crate) use local_first_capabilities::CachedCapabilityTool;
#[cfg(test)]
use local_first_capabilities::CachedToolProvider;
#[cfg(test)]
use local_first_capabilities::CapabilityCall;
use local_first_capabilities::{
    ActionClass, CapabilityConnectionConfig, CapabilityError, CapabilityFacade, CapabilityPolicy,
    CapabilityProviderConfig, CapabilityProviderGrant, CapabilityProviderKind,
    CapabilityRegistryStore, CapabilityResult, CapabilityTaskPayload, CapabilityTool,
    InMemoryCapabilityAudit, McpCapabilityProvider, McpToolPolicy, PluginRegistryEntry,
    PluginRegistryIndex, PolicyContext, ProviderId as CapabilityProviderId,
    WorkflowRoutingRegistry,
};
use local_first_desktop_gateway::browser_checkpoint::BrowserCheckpointSecretStore;
use local_first_desktop_gateway::integrity_api::{
    GraphIntegrityStatus, IntegrityAuditResponse, IntegrityBackupSummary, IntegrityRepairAction,
    IntegrityRepairApplyRequest, IntegrityRepairApplyResponse, IntegrityRepairDomain,
    IntegrityRepairEstimate, IntegrityRepairPreviewRequest, IntegrityRepairPreviewResponse,
    LinkedMemoryRepairApplyRequest, LinkedMemoryRepairApplyResponse, canonical_integrity_actions,
    gateway_approval_token, gateway_audit_checksum, gateway_runtime_audit_checksum,
    inspect_registered_graph,
};
use local_first_desktop_gateway::linked_memory_repair::{
    LinkedMemoryRepairPreview, LinkedRepairError, LinkedRepairFailureInjection,
    apply_linked_memory_repair, preview_linked_memory_repair,
};
use local_first_desktop_gateway::project_graph_commit::{
    ProjectGraphCommitError, stage_project_graph_build,
};
use local_first_desktop_gateway::{
    ChatContextMessage, ChatContextRole, ChatGenerateStreamRequest, ChatMessage,
    ChatMessagesSnapshot, ChatThread, ChatThreadSnapshot, EnqueueTurnRequest, RoutingBinding,
    SetThreadPinnedRequest, compact_thread_title, strip_display_markers,
};
pub(crate) use model_registry::{
    ProviderEntry, ProviderKind, ProviderRegistry, ResolvedRole, RoleBinding,
    canonical_provider_base_url,
};
// The pure plan state machine now lives in the engine crate (ADR 0024, increment 3). Imported
// unqualified so every call site (and the `use super::{…}` in the test module) resolves unchanged.
// Plan helpers still used by NON-loop gateway code (titling, plan projection, etc.); the loop's own
// plan helpers moved into the engine with `run_turn` (5.D2).
use local_first_engine::plan::{
    build_plan_markdown, parse_plan_marker, plan_done_count, plan_incomplete_reason, plan_step_id,
    plan_step_status, plan_step_title, plan_value_goal, plan_value_steps,
};
// Engine helpers exercised ONLY by this crate's tests (their non-test callers moved into
// `engine::run_turn` at 5.D2). `#[cfg(test)]`-gated so they're in scope for `super::…` in `mod tests`
// without reading as unused imports in the non-test build.
use execution_runtime::{ExecutionRuntime, contract_for_acquired_task};
#[cfg(test)]
use local_first_engine::{
    browser::{prune_browser_history, resolve_browser_chat_tool_name},
    markers::{
        VAULT_REVEAL_OPEN, append_vault_reveal_marker_if_missing, extract_vault_reveal_marker,
        should_force_synthesis_for_empty_visible_answer,
    },
    plan::{answer_concludes_plan, replace_latest_plan_marker},
    text::{extract_source_urls, fonti_section, is_low_value_source_url},
    tools::{connected_capability_execution_trace_line, summarize_tool_action},
};
use local_first_inference::{
    AnthropicProvider, CapabilityDescriptor, Locality, ModelRouter, OpenAiCompatProvider,
    PrivacyPolicy, Requirements, structured_response_format,
};
use local_first_local_computer_session::{
    ApprovalState, ArtifactRecord, ComputerEventRecord, ComputerSessionRecord,
    ComputerSurfaceRecord, SessionStatus, SurfaceKind, SurfaceStatus, TakeoverState,
};
use local_first_local_computer_session::{LocalComputerReadModel, LocalComputerSessionStore};
use local_first_memory::{
    BriefingPack, CachedBriefing, DataSensitivity as MemoryDataSensitivity, Exchange,
    ExtractedEntity, ExtractedRelation, MemoryCollectionKey, MemoryCreateRequest, MemoryEntity,
    MemoryError, MemoryFacade, MemoryIntegrityRepairRequest, MemoryLifecycleRequest,
    MemoryRecallService, MemoryRecord, MemoryRef, MemoryRefKind, MemoryRelation, MemoryScope,
    MemorySearchRequest, MemoryStatus, MemoryUpdatePatch, MemoryWikiProjection, PERSONAL_WORKSPACE,
    PrivacyDomain, ProjectGraphImportReport, RecallHit, RecallPack, SQLiteMemoryStore,
    UserId as MemoryUserId, WikiFileStore, WikiPage, WorkspaceId as MemoryWorkspaceId,
    briefing_cache, memory_record_revision, prompt_fingerprint,
};
use local_first_orchestrator::{
    ExecutionPlan, OrchestratorBrain, OrchestratorRequest, OrchestratorRoute, PlanStep,
    PlanStepKind, StepExecutionPolicy,
};
use local_first_secrets::{
    DevelopmentSecretKeyProvider, EncryptedFileSecretStore, SecretMaterial, SecretRef, SecretStore,
};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, GenerateStreamEvent, TokenMetrics,
};
use local_first_task_runtime::{
    ApprovalGate, ApprovalPolicy, ApprovalRequest, Automation, AutomationSource, AutomationTrigger,
    EventTrigger, ExecutorResult, LeaseManager, LeaseOwnership, NewBrowserCheckpoint,
    ResourceClass, ResourceGovernor, ResourceLimits, TaskExecutor, TaskId, TaskQueueSnapshot,
    TaskRecord, TaskRuntimeError, TaskRuntimeResult, TaskScheduler, TaskStatus, TaskStore,
    TaskUiDetail, TaskUiItem, TaskUiReadModel, UserId, WorkspaceId,
};
use local_first_vault::SQLiteVaultStore;
#[cfg(not(test))]
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, HashSet},
    env, fs,
    io::{Cursor, Read, Write},
    path::{Path as FsPath, PathBuf},
    str::FromStr,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration as StdDuration,
};
use task_registry::TaskExecutorRegistry;
use time::{Duration, OffsetDateTime};
use tokio::net::TcpListener;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) http: reqwest::Client,
    usage_store: Arc<Mutex<usage_store::UsageStore>>,
    usage_recorder: Arc<dyn local_first_inference_usage::UsageRecorder>,
    usage_pricing: Arc<std::sync::RwLock<usage_pricing::PricingSnapshot>>,
    chat_store: Arc<Mutex<ChatStore>>,
    task_store: Arc<Mutex<TaskStore>>,
    computer_store: Arc<Mutex<LocalComputerSessionStore>>,
    browser_url_policies: Arc<Mutex<BrowserUrlPolicyStore>>,
    memory_facade: Arc<MemoryFacade>,
    /// ADR 0022 (Tappa 1): service memoria che incapsula brief/recall/learn.
    /// `Some` di default; `None` solo con opt-out esplicito
    /// (`HOMUN_MEMORY_SERVICE=0`/`off`/`false`) → orchestrazione inline.
    memory_service: Option<Arc<dyn MemoryRecallService>>,
    vault_store: Arc<Mutex<SQLiteVaultStore>>,
    /// 32-byte key that WRAPS the vault master key (ADR: system-usable vault
    /// values). Sourced from the OS keychain at boot so the system can obtain the
    /// master key with NO PIN — the PIN is now a reveal-only human-authorization
    /// gate. Read once at startup; stable for the life of the vault.
    vault_wrap_key: Arc<[u8; 32]>,
    pending_vault_proposals: Arc<privacy_guard::PendingVaultProposalStore>,
    capability_registry: Arc<Mutex<CapabilityRegistryStore>>,
    task_executor_status: Arc<Mutex<TaskExecutorStatus>>,
    task_executor_registry: TaskExecutorRegistry,
    browser_capability_client: Arc<Mutex<Option<BrowserAutomationClient<BrowserSidecarSession>>>>,
    /// Persistent browser sessions keyed by chat thread_id, so a thread's
    /// browse_web calls reuse one warm session (search → then book on the same
    /// tab) instead of spawning a fresh sidecar each time. Reaped on idle and on
    /// thread archive/close/delete.
    browser_thread_sessions: Arc<Mutex<std::collections::HashMap<String, ThreadBrowserSession>>>,
    /// Per-thread HITL Choice resume stash: set when semantic binds an open wait,
    /// consumed once when assembling the resume turn's prompt/tools.
    hitl_resume_by_thread: Arc<Mutex<std::collections::HashMap<String, HitlResumeTurnContext>>>,
    payment_approvals: Arc<Mutex<std::collections::HashMap<String, PaymentApprovalGrant>>>,
    setup_computer: Arc<setup_computer::SetupComputerCoordinator>,
    secret_store: Arc<EncryptedFileSecretStore<DevelopmentSecretKeyProvider>>,
    browser_checkpoint_secret_store: Arc<BrowserCheckpointSecretStore>,
    auth_token: Arc<str>,
    /// Short-lived tickets authorizing the noVNC live-view proxy. The iframe and
    /// its WebSocket can't carry the Bearer header, so a Bearer-authed endpoint
    /// mints a ticket the proxy routes accept via query param. ticket -> expiry.
    pub(crate) novnc_tickets: Arc<Mutex<std::collections::HashMap<String, std::time::Instant>>>,
    /// The current STABLE live-view ticket, reused across status polls so the embed
    /// URL (and thus the iframe) doesn't change every poll. Re-minted when expired.
    pub(crate) novnc_view_ticket: Arc<Mutex<Option<String>>>,
    /// Unified WebSocket subscriber registry. Long-lived (created at boot).
    /// publish_* functions fan-out events to all connected WS clients.
    pub(crate) ws_registry: std::sync::Arc<ws_gateway::WsRegistry>,
    /// Stores quarantined by the startup integrity sweep (empty = all healthy).
    recovered_stores: std::sync::Arc<Vec<String>>,
}

impl gateway_auth::GatewayAuthState for AppState {
    fn gateway_auth_token(&self) -> &str {
        self.auth_token.as_ref()
    }
}

impl gateway_health::GatewayHealthState for AppState {
    fn gateway_auth_required(&self) -> bool {
        !self.auth_token.is_empty()
    }

    fn recovered_stores(&self) -> Vec<String> {
        self.recovered_stores.as_ref().clone()
    }

    /// Model provider reachability is derived from the persisted provider
    /// registry (a lightweight file read — no DB query). `reachable` is true
    /// when an active provider with a non-empty base URL exists. The
    /// `last_successful_inference` timestamp comes from the process-wide
    /// cache updated by the model client after each successful response.
    fn model_provider_health(&self) -> gateway_health::ModelProviderHealth {
        let registry = load_provider_registry();
        let provider = registry.active().or_else(|| registry.providers.first());
        gateway_health::ModelProviderHealth {
            reachable: provider.is_some_and(|p| !p.base_url.is_empty()),
            last_successful_inference: gateway_health::last_successful_inference(),
            provider_name: provider.map(|p| {
                if p.label.is_empty() {
                    p.id.clone()
                } else {
                    p.label.clone()
                }
            }),
        }
    }

    /// Memory store health: the facade is always available (it's an `Arc`),
    /// so the pool is considered healthy. The schema version is the known
    /// constant from the memory crate (8) — querying the actual version
    /// would require a DB read, which the health handler avoids.
    fn memory_store_health(&self) -> gateway_health::MemoryStoreHealth {
        gateway_health::MemoryStoreHealth {
            pool_healthy: true,
            schema_version: 8,
        }
    }

    /// Sidecar status: browser automation is "running" when a sidecar
    /// client has been spawned (the `browser_capability_client` is `Some`).
    /// The contained computer status comes from the setup coordinator cache:
    /// the health handler must not shell out to Docker or block on external
    /// probes, otherwise the Electron watchdog can lose its liveness signal
    /// under load. PIDs are not directly available from these in-memory holders.
    fn sidecar_health(&self) -> gateway_health::SidecarHealth {
        let browser_running = self
            .browser_capability_client
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some();
        let contained_running = self.setup_computer.status().ready;
        gateway_health::SidecarHealth {
            browser_automation: gateway_health::SidecarStatus {
                running: browser_running,
                pid: None,
            },
            contained_computer: gateway_health::SidecarStatus {
                running: contained_running,
                pid: None,
            },
        }
    }

    /// Lease counts come from the process-wide cache updated by the task
    /// executor after lease acquisition / recovery. The health handler
    /// reads this cached snapshot instead of locking the task_store,
    /// preserving the lock-free liveness invariant.
    fn lease_health(&self) -> gateway_health::LeaseHealth {
        gateway_health::lease_health_snapshot()
    }
}

#[cfg(test)]
mod agent_run_api_tests {
    use super::*;
    use local_first_inference_usage::{
        InferencePurpose, Locality as UsageLocality, NormalizedUsage, UsageAttemptEvent,
        UsageContext, UsageProvenance,
    };
    use local_first_task_runtime::NewAgentRun;

    fn seed_run(state: &AppState, run_id: &str, turn_id: &str, user_id: &str) {
        let store = state.task_store.lock().unwrap();
        store
            .create_agent_run(&NewAgentRun {
                run_id: run_id.to_string(),
                turn_id: turn_id.to_string(),
                thread_id: "thread-test".to_string(),
                user_id: user_id.to_string(),
                workspace_id: gateway_workspace_id().as_str().to_string(),
                role: None,
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .unwrap();
    }

    #[test]
    fn early_preflight_response_backfills_agent_run_attribution() {
        let state = AppState::for_tests();
        seed_run(
            &state,
            "run-privacy-preflight",
            "turn-privacy-preflight",
            gateway_user_id().as_str(),
        );

        backfill_early_response_agent_run_attribution(
            &state,
            Some("run-privacy-preflight"),
            "privacy_guard",
        );

        let runs = state
            .task_store
            .lock()
            .unwrap()
            .list_agent_runs_for_turn(
                "turn-privacy-preflight",
                gateway_user_id().as_str(),
                gateway_workspace_id().as_str(),
            )
            .unwrap();
        assert_eq!(runs[0].model.as_deref(), Some("privacy_guard"));
        assert_eq!(runs[0].provider.as_deref(), Some("local_preflight"));
    }

    #[test]
    fn normal_agent_turn_backfills_model_and_provider_attribution() {
        let state = AppState::for_tests();
        seed_run(
            &state,
            "run-normal-attribution",
            "turn-normal-attribution",
            gateway_user_id().as_str(),
        );

        backfill_normal_agent_run_attribution(
            &state,
            Some("run-normal-attribution"),
            "http://127.0.0.1:11434/v1",
            "qwen3.5:4b",
        );

        let runs = state
            .task_store
            .lock()
            .unwrap()
            .list_agent_runs_for_turn(
                "turn-normal-attribution",
                gateway_user_id().as_str(),
                gateway_workspace_id().as_str(),
            )
            .unwrap();
        assert_eq!(runs[0].model.as_deref(), Some("qwen3.5:4b"));
        assert_eq!(runs[0].provider.as_deref(), Some("local"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn agent_run_api_is_ordered_cursor_based_and_scope_checked() {
        let state = AppState::for_tests();
        seed_run(&state, "run-api", "turn-api", gateway_user_id().as_str());
        {
            let store = state.task_store.lock().unwrap();
            store
                .append_agent_run_event(
                    "run-api",
                    2,
                    Some(1),
                    "prompt_snapshot",
                    &serde_json::json!({
                        "fingerprint": "abc",
                        "redacted": true,
                        "messages": [{"role": "user", "content": "safe"}],
                        "tools": [],
                    }),
                )
                .unwrap();
            store
                .append_agent_run_event(
                    "run-api",
                    3,
                    Some(1),
                    "model_response",
                    &serde_json::json!({"content_chars": 4}),
                )
                .unwrap();
        }

        let runs = get_agent_runs(
            Path("turn-api".to_string()),
            State(state.clone()),
            Query(TurnSinceQuery::default()),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "run-api");

        let events = get_agent_run_events(
            Path("run-api".to_string()),
            State(state.clone()),
            Query(TurnSinceQuery {
                since: Some(1),
                workspace: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            events.iter().map(|event| event.seq).collect::<Vec<_>>(),
            vec![2, 3]
        );

        let prompt = get_latest_agent_prompt(Path("run-api".to_string()), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(prompt["fingerprint"], "abc");
        assert_eq!(prompt["redacted"], true);

        let cursor_error = get_agent_run_events(
            Path("run-api".to_string()),
            State(state.clone()),
            Query(TurnSinceQuery {
                since: Some(-1),
                workspace: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(cursor_error.status, StatusCode::BAD_REQUEST);

        seed_run(&state, "foreign-run", "foreign-turn", "other-user");
        let error = get_latest_agent_prompt(Path("foreign-run".to_string()), State(state))
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_context_handler_is_stable_without_a_run_and_rejects_unknown_threads() {
        let state = AppState::for_tests();
        let thread = state
            .chat_store
            .lock()
            .unwrap()
            .create_thread("workspace-runtime")
            .unwrap();

        let response =
            get_thread_runtime_context(Path(thread.thread_id.clone()), State(state.clone()))
                .await
                .unwrap()
                .0;
        let value = serde_json::to_value(response).unwrap();
        assert!(value["run_id"].is_null());
        assert!(value["effective_model"].is_null());
        assert!(value["used_input_tokens"].is_null());
        assert_eq!(value["compacted"], false);
        assert!(value["contributions"]["conversation"].is_null());

        {
            state
                .task_store
                .lock()
                .unwrap()
                .create_agent_run(&NewAgentRun {
                    run_id: "foreign-runtime-run".into(),
                    turn_id: "foreign-runtime-turn".into(),
                    thread_id: thread.thread_id.clone(),
                    user_id: "foreign-user".into(),
                    workspace_id: "workspace-runtime".into(),
                    role: None,
                    model: None,
                    provider: None,
                    prompt_fingerprint: None,
                })
                .unwrap();
        }
        let foreign_run_error =
            get_thread_runtime_context(Path(thread.thread_id.clone()), State(state.clone()))
                .await
                .unwrap_err();
        assert_eq!(foreign_run_error.status, StatusCode::NOT_FOUND);

        let foreign_workspace_thread = state
            .chat_store
            .lock()
            .unwrap()
            .create_thread("workspace-runtime-b")
            .unwrap();
        state
            .task_store
            .lock()
            .unwrap()
            .create_agent_run(&NewAgentRun {
                run_id: "foreign-workspace-run".into(),
                turn_id: "foreign-workspace-turn".into(),
                thread_id: foreign_workspace_thread.thread_id.clone(),
                user_id: gateway_user_id().as_str().into(),
                workspace_id: "other-workspace".into(),
                role: None,
                model: None,
                provider: None,
                prompt_fingerprint: None,
            })
            .unwrap();
        let foreign_workspace_error = get_thread_runtime_context(
            Path(foreign_workspace_thread.thread_id),
            State(state.clone()),
        )
        .await
        .unwrap_err();
        assert_eq!(foreign_workspace_error.status, StatusCode::NOT_FOUND);

        let error = get_thread_runtime_context(Path("foreign-thread".to_string()), State(state))
            .await
            .unwrap_err();
        assert_eq!(error.status, StatusCode::NOT_FOUND);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runtime_context_handler_uses_scoped_canonical_sources_without_leaking_payloads() {
        let state = AppState::for_tests();
        let thread = state
            .chat_store
            .lock()
            .unwrap()
            .create_thread("workspace-runtime")
            .unwrap();
        {
            let store = state.task_store.lock().unwrap();
            store
                .create_agent_run(&NewAgentRun {
                    run_id: "runtime-run".into(),
                    turn_id: "runtime-turn".into(),
                    thread_id: thread.thread_id.clone(),
                    user_id: gateway_user_id().as_str().into(),
                    workspace_id: "workspace-runtime".into(),
                    role: Some("coding".into()),
                    model: Some("run-model".into()),
                    provider: Some("internal-provider-value".into()),
                    prompt_fingerprint: Some("private-run-hash".into()),
                })
                .unwrap();
            store
                .append_agent_run_event(
                    "runtime-run",
                    2,
                    Some(1),
                    "prompt_snapshot",
                    &serde_json::json!({
                        "model": "snapshot-model",
                        "provider": "https://private.example/v1",
                        "messages": [
                            {"role": "system", "chars": 40, "content": "system-secret"},
                            {"role": "user", "chars": 80, "content": "user-secret"}
                        ],
                        "tools": [{"chars": 20, "schema": {"api_key": "secret"}}],
                        "fingerprint": "private-snapshot-hash",
                        "packets": [{"path": "/private/path", "memory": "private-memory"}]
                    }),
                )
                .unwrap();
            store
                .append_agent_run_event(
                    "runtime-run",
                    3,
                    Some(1),
                    "context_compacted",
                    &serde_json::json!({"reason": "private-reason"}),
                )
                .unwrap();
        }
        {
            let mut context = UsageContext::new(
                "runtime-call",
                InferencePurpose::ChatResponse,
                gateway_user_id().as_str(),
            );
            context.workspace_id = Some("workspace-runtime".into());
            context.thread_id = Some(thread.thread_id.clone());
            context.turn_id = Some("runtime-turn".into());
            context.run_id = Some("runtime-run".into());
            let started = UsageAttemptEvent::started(
                context,
                "runtime-attempt",
                "usage-provider",
                "usage-model",
                UsageLocality::Cloud,
                10,
            );
            let mut completed = started.completed(
                20,
                NormalizedUsage {
                    input_tokens: Some(321),
                    ..NormalizedUsage::default()
                },
            );
            completed.usage_provenance = UsageProvenance::ProviderReported;
            state
                .usage_store
                .lock()
                .unwrap()
                .append(&completed)
                .unwrap();
        }

        let response = get_thread_runtime_context(Path(thread.thread_id), State(state))
            .await
            .unwrap()
            .0;
        let encoded = serde_json::to_string(&response).unwrap();
        let value = serde_json::to_value(response).unwrap();
        assert_eq!(value["effective_model"], "snapshot-model");
        assert_eq!(value["provider"], "usage-provider");
        assert_eq!(value["locality"], "cloud");
        assert_eq!(value["used_input_tokens"], 35);
        assert_eq!(value["compacted"], true);
        assert_eq!(
            value["contributions"]["conversation"]["estimated_tokens"],
            20
        );
        assert_eq!(
            value["contributions"]["system_tools"]["estimated_tokens"],
            15
        );
        for forbidden in [
            "system-secret",
            "user-secret",
            "api_key",
            "private-run-hash",
            "private-snapshot-hash",
            "/private/path",
            "private-memory",
            "https://private.example/v1",
            "base_url",
            "\"messages\":",
            "\"tools\":",
            "\"packets\":",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "leaked {forbidden}: {encoded}"
            );
        }
    }

    #[test]
    fn runtime_plan_control_store_is_authoritative_and_workspace_scoped() {
        let state = AppState::for_tests();
        let thread = state
            .chat_store
            .lock()
            .unwrap()
            .create_thread("workspace-a")
            .unwrap();
        let user = gateway_user_id();
        {
            let store = state.task_store.lock().unwrap();
            store
                .upsert_runtime_plan(
                    user.as_str(),
                    "workspace-b",
                    &thread.thread_id,
                    0,
                    &serde_json::json!([{"title": "foreign", "status": "doing"}]),
                    "open",
                )
                .unwrap();
        }
        assert!(load_runtime_plan_from_state(&state, Some(&thread.thread_id)).is_empty());

        {
            let store = state.task_store.lock().unwrap();
            store
                .upsert_runtime_plan(
                    user.as_str(),
                    "workspace-a",
                    &thread.thread_id,
                    0,
                    &serde_json::json!([{"title": "owned", "status": "doing"}]),
                    "open",
                )
                .unwrap();
        }
        assert_eq!(
            load_runtime_plan_from_state(&state, Some(&thread.thread_id))[0]["title"],
            "owned"
        );
    }

    #[test]
    fn runtime_plan_control_store_owns_stall_bookkeeping() {
        let state = AppState::for_tests();
        let thread = state
            .chat_store
            .lock()
            .unwrap()
            .create_thread("workspace-a")
            .unwrap();
        let steps = serde_json::json!([{"title": "step", "status": "doing"}]);
        state
            .task_store
            .lock()
            .unwrap()
            .upsert_runtime_plan(
                gateway_user_id().as_str(),
                "workspace-a",
                &thread.thread_id,
                0,
                &steps,
                "open",
            )
            .unwrap();
        let steps = steps.as_array().unwrap();
        assert!(!plan_stall_check_and_bump(
            state.task_store.as_ref(),
            gateway_user_id().as_str(),
            "workspace-a",
            &thread.thread_id,
            steps
        ));
        assert!(!plan_stall_check_and_bump(
            state.task_store.as_ref(),
            gateway_user_id().as_str(),
            "workspace-a",
            &thread.thread_id,
            steps
        ));
        let stored = state
            .task_store
            .lock()
            .unwrap()
            .load_runtime_plan(gateway_user_id().as_str(), "workspace-a", &thread.thread_id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.stall_turns, 1);
    }
}

impl AppState {
    /// Minimal AppState for unit tests that only need a subset of fields (e.g.
    /// `ws_registry` for `emit_turn_event`). Stores use in-memory SQLite; the
    /// secret store uses a throwaway temp file. Heavy subsystems (browser
    /// client, capabilities) are left empty/default — tests that need them
    /// should construct a real state via the boot path instead.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        let secret_path = std::env::temp_dir().join(format!(
            "desktop-gateway-test-secrets-{}.json",
            uuid::Uuid::new_v4().simple()
        ));
        let secret_store = EncryptedFileSecretStore::open(
            &secret_path,
            DevelopmentSecretKeyProvider::new([0u8; 32]),
        )
        .expect("open test secret store");
        let browser_checkpoint_secret_store = BrowserCheckpointSecretStore::open(
            secret_path.with_file_name(format!(
                "desktop-gateway-test-browser-checkpoints-{}.json",
                uuid::Uuid::new_v4().simple()
            )),
            [0u8; 32],
        )
        .expect("open test browser checkpoint secret store");
        let state = AppState {
            http: reqwest::Client::new(),
            usage_store: Arc::new(Mutex::new(
                usage_store::UsageStore::open_in_memory().expect("in-memory usage store"),
            )),
            usage_recorder: Arc::new(local_first_inference_usage::NoopUsageRecorder),
            usage_pricing: Arc::new(std::sync::RwLock::new(
                usage_pricing::PricingSnapshot::default(),
            )),
            chat_store: Arc::new(Mutex::new(
                ChatStore::in_memory().expect("in-memory chat store"),
            )),
            task_store: Arc::new(Mutex::new(
                TaskStore::open_in_memory().expect("in-memory task store"),
            )),
            computer_store: Arc::new(Mutex::new(
                LocalComputerSessionStore::open_in_memory().expect("in-memory computer store"),
            )),
            browser_url_policies: Arc::new(Mutex::new(
                BrowserUrlPolicyStore::open_in_memory().expect("in-memory url policy store"),
            )),
            memory_facade: Arc::new(MemoryFacade::new(
                SQLiteMemoryStore::open_in_memory().expect("in-memory memory store"),
            )),
            memory_service: None,
            vault_store: Arc::new(Mutex::new(
                SQLiteVaultStore::open_in_memory().expect("in-memory vault store"),
            )),
            vault_wrap_key: Arc::new([7u8; 32]),
            pending_vault_proposals: Arc::new(privacy_guard::PendingVaultProposalStore::default()),
            capability_registry: Arc::new(Mutex::new(
                CapabilityRegistryStore::open_in_memory().expect("in-memory capability store"),
            )),
            task_executor_status: Arc::new(Mutex::new(TaskExecutorStatus::new(false))),
            task_executor_registry: ExecutionRuntime::default_registry(),
            browser_capability_client: Arc::new(Mutex::new(None)),
            browser_thread_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
            hitl_resume_by_thread: Arc::new(Mutex::new(std::collections::HashMap::new())),
            payment_approvals: Arc::new(Mutex::new(std::collections::HashMap::new())),
            setup_computer: Arc::new(setup_computer::SetupComputerCoordinator::default()),
            secret_store: Arc::new(secret_store),
            browser_checkpoint_secret_store: Arc::new(browser_checkpoint_secret_store),
            auth_token: "test-token".into(),
            novnc_tickets: Arc::new(Mutex::new(std::collections::HashMap::new())),
            novnc_view_ticket: Arc::new(Mutex::new(None)),
            ws_registry: std::sync::Arc::new(ws_gateway::WsRegistry::new()),
            recovered_stores: std::sync::Arc::new(Vec::new()),
        };
        // Register the test registry process-wide so the global accessor
        // (`ws_registry()`) is consistent with `state.ws_registry`.
        let _ = ws_registry().set(state.ws_registry.clone());
        state
    }
}

/// A live, reusable browser session bound to a chat thread.
struct ThreadBrowserSession {
    client: BrowserAutomationClient<BrowserSidecarSession>,
    last_used: std::time::Instant,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    gateway_process_bootstrap::install_gateway_process_bootstrap();

    // P0 resilience: verify every personal store BEFORE anything opens it; a
    // corrupt file is quarantined (never deleted) and the fresh open below
    // succeeds. Surfaced to the UI via /api/health `recovered_stores`.
    let recovered_stores: std::sync::Arc<Vec<String>> =
        std::sync::Arc::new(gateway_store_integrity::ensure_gateway_store_integrity()?);

    let addr = gateway_bind::gateway_bind_addr();
    gateway_db_unify::unify_legacy_databases_at_startup()?;
    // Unified WS registry: build the Arc once, register it process-wide (so free
    // functions like `publish_app_event` can publish without `&AppState`), then
    // hand the same Arc to AppState. Clones below are cheap Arc clones.
    let ws_registry_arc = std::sync::Arc::new(ws_gateway::WsRegistry::new());
    let _ = ws_registry().set(ws_registry_arc.clone());
    let usage_runtime = open_gateway_usage_runtime(gateway_database_path()?)?;
    install_gateway_usage_recorder(usage_runtime.recorder.clone());
    let mut state = AppState {
        http: gateway_http_client::build_gateway_http_client(),
        usage_store: usage_runtime.store,
        usage_recorder: usage_runtime.recorder,
        usage_pricing: usage_runtime.pricing,
        chat_store: Arc::new(Mutex::new(ChatStore::open(gateway_database_path()?)?)),
        task_store: Arc::new(Mutex::new(TaskStore::open(gateway_task_database_path()?)?)),
        computer_store: Arc::new(Mutex::new(LocalComputerSessionStore::open(
            gateway_local_computer_database_path()?,
        )?)),
        browser_url_policies: Arc::new(Mutex::new(BrowserUrlPolicyStore::open(
            gateway_browser_policy_database_path()?,
        )?)),
        memory_facade: Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open(gateway_memory_database_path()?)
                .map_err(std::io::Error::other)?,
        )),
        // ADR 0022 (Tappa 1): costruisci il service solo se il flag è ON.
        // L'impl delega interamente alla memoria_facade sopra (condivisa via Arc),
        // quindi niente nuovi store, niente big-bang.
        memory_service: None,
        vault_store: Arc::new(Mutex::new(
            SQLiteVaultStore::open(gateway_vault_database_path()?)
                .map_err(std::io::Error::other)?,
        )),
        vault_wrap_key: Arc::new(gateway_vault_key::resolve_vault_wrap_key()?),
        pending_vault_proposals: Arc::new(privacy_guard::PendingVaultProposalStore::default()),
        capability_registry: Arc::new(Mutex::new(open_seeded_capability_registry()?)),
        task_executor_status: Arc::new(Mutex::new(TaskExecutorStatus::new(
            gateway_task_executor_config::task_executor_worker_enabled(),
        ))),
        task_executor_registry: ExecutionRuntime::default_registry(),
        browser_capability_client: Arc::new(Mutex::new(None)),
        browser_thread_sessions: Arc::new(Mutex::new(std::collections::HashMap::new())),
        hitl_resume_by_thread: Arc::new(Mutex::new(std::collections::HashMap::new())),
        payment_approvals: Arc::new(Mutex::new(std::collections::HashMap::new())),
        setup_computer: Arc::new(setup_computer::SetupComputerCoordinator::default()),
        secret_store: Arc::new(gateway_secrets::open_gateway_secret_store()?),
        browser_checkpoint_secret_store: Arc::new(open_browser_checkpoint_secret_store()?),
        auth_token: gateway_auth::resolve_gateway_auth_token(
            &gateway_paths::gateway_data_dir()?,
            gateway_file_security::write_private_file,
        )?
        .into(),
        novnc_tickets: Arc::new(Mutex::new(std::collections::HashMap::new())),
        novnc_view_ticket: Arc::new(Mutex::new(None)),
        ws_registry: ws_registry_arc,
        recovered_stores: recovered_stores.clone(),
    };
    migrate_legacy_mcp_http_header_secrets(&state)
        .map_err(|error| std::io::Error::other(error.message))?;
    // ADR 0022 — Tappa 1: il service memoria è ON di default — costruisci
    // l'istanza che incapsula brief/recall/learn. Costruito dopo il letterale
    // perché `InProcessMemoryRecallService` prende in prestito lo stesso
    // `AppState`. Opt-out via `HOMUN_MEMORY_SERVICE=0`/`off`/`false`.
    let embedding: Arc<dyn local_first_memory::EmbeddingClient> =
        gateway_embedding_client(state.http.clone());
    let llm: Arc<dyn local_first_memory::LlmClient> = gateway_llm_client(state.http.clone());
    install_memory_service_if_enabled(&mut state, embedding, llm);
    // Fix any pre-existing 0644 data files (created before the umask above was set):
    // the SQLite stores and the WhatsApp session are world-readable on old installs.
    if let Ok(dir) = gateway_data_dir() {
        gateway_file_security::harden_data_at_rest(&dir);
    }
    gateway_boot_maintenance::run_gateway_boot_maintenance(&state);
    gateway_turn_recovery::recover_gateway_chat_turns_at_startup(&state).await;
    gateway_background_startup::start_gateway_background_services(state.clone());
    let startup_state = state.clone();
    let app = gateway_routes::build_gateway_router(state.clone());
    // Warm up the contained computer so the live view + browser are ready without waiting for
    // the first skill. Off the async runtime so startup is not blocked by the container boot.
    // Behavior depends on the user's `local_computer_autostart` setting (default ON):
    //   ON  → start it eagerly, OPENING Docker if it's closed (ensure_contained_computer).
    //   OFF → stay non-intrusive: only warm up when Docker is already running.
    let computer_warmup_state = startup_state.clone();
    tokio::spawn(async move {
        if sandbox::container_up() {
            return;
        }
        let autostart = load_runtime_settings().local_computer_autostart;
        if autostart || sandbox::docker_running() {
            let _ = begin_setup_computer(computer_warmup_state).await;
        }
    });
    let listener = TcpListener::bind(addr).await?;
    println!("local-first-desktop-gateway listening on http://{addr}");
    tokio::spawn(reconnect_channels_on_startup(startup_state));
    axum::serve(listener, app).await?;
    Ok(())
}

// `extract_vault_reveal_marker`, `append_vault_reveal_marker_if_missing`, and the
// `VAULT_REVEAL_OPEN/CLOSE` consts moved to `engine::markers` (ADR 0024 inc 5e.3); imported below.

// MAX_PLAN_NUDGES moved into `engine::agent_loop` (5.D2 — the loop that used it lives there now).
// Round budget once a browser tool is in play. Driving a browser one micro-action
// at a time (navigate -> snapshot -> act -> re-snapshot) needs many more
// model/tool round-trips than a normal chat turn. Env-overridable via
// `HOMUN_CHAT_BROWSER_MAX_ROUNDS`.

/// Capable (OpenAI-compatible) chat path with NATIVE TOOL-CALLING. The model is
/// given real tools and decides when to use them (no keyword routing). Tool
/// rounds run non-streamed; the final assistant answer is emitted as Delta+Done
/// to match the existing UI stream protocol.
async fn stream_chat_via_openai(
    state: &AppState,
    request: ChatGenerateStreamRequest,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<Response, GatewayError> {
    let validated_checkpoint = validate_agent_checkpoint_request(&request)?;
    let applies_new_input = validated_checkpoint.applies_new_input;
    let recovery_checkpoint = validated_checkpoint.recovery_checkpoint;
    // Turn trace (readable per-turn observability): handle created HERE, at the absolute entry, so a
    // hang in SETUP (memory recall, prompt-build, browser-session) is visible — see engine::turn_trace.
    // The `turn_received` event is the FIRST thing recorded; if no `turn_start` follows, the turn
    // stalled before generation (a setup-hang would otherwise be invisible). Cheap Arc/None handle;
    // no-op when disabled. It's a pure sink — it records what the turn does, never steers it.
    let turn_trace = begin_chat_turn_trace(ChatTurnTraceInput {
        request_id: &request.request_id,
        prompt: &request.prompt,
        mode: request.mode.as_deref(),
        model: &model,
    });
    let chat_turn_context = prepare_chat_turn_context(ChatTurnContextInput {
        state,
        thread_id: request.thread_id.as_deref(),
        mode: request.mode.as_deref(),
        tool_policy: request.tool_policy.as_deref(),
    });
    let ChatTurnContext {
        contact: contact_ctx,
        chat_channel,
        turn_policy,
        contact_memory_perimeter,
        memory_workspace,
    } = chat_turn_context;
    // Budget the prompt against the model's REAL context window (catalog `context_window`,
    // auto-filled from `/api/show`, F0.3d) instead of a flat 32k default — so a 128k model
    // keeps its long history and a small local model is clamped to what it can actually read.
    let model_context_window = model_context_window_for_turn(&base_url, &model);
    let chat_model_prompt = prepare_chat_model_prompt(ChatModelPromptInput {
        state,
        thread_id: request.thread_id.as_deref(),
        request_context: &request.context,
        prompt: request.prompt.as_str(),
        checkpoint_input: request.checkpoint_input.as_ref(),
        model_context_window,
    });
    let effective_context = chat_model_prompt.effective_context;
    let prompt = chat_model_prompt.prompt;
    let browser_discovery = browser_open_research_discovery_instruction();
    // ResumeBinding: consume the per-turn stash set by semantic short-circuit (not
    // prompt-heuristic on ‹‹CHOICES›› in prior assistant text).
    let hitl_choice_resume = take_hitl_resume_turn_context(state, request.thread_id.as_deref());
    let choice_resume_slot = hitl_choice_resume.as_ref().map(|ctx| {
        let browser_still_live = request
            .thread_id
            .as_deref()
            .is_some_and(|tid| thread_has_live_browser_session(state, tid));
        hitl_resume::hitl_resume_harness_slot(&ctx.wait, &ctx.resolution, browser_still_live)
    });

    let system =
        prepare_chat_core_operating_prompt(ChatCoreOperatingPromptInput { browser_discovery });
    let system =
        append_chat_code_map_prompt_instruction(ChatCodeMapPromptInput { state, system }).await;
    // Connected-service and MCP tools share one discovery/write-set owner. The
    // root only consumes the per-turn projection for prompt and toolset assembly.
    let connected_tool_catalog = prepare_connected_tool_catalog(ConnectedToolCatalogInput {
        state,
        project_root: project_root_for_thread(state, request.thread_id.as_deref()).as_deref(),
    })
    .await;
    let connected_prompt = append_chat_connected_prompt_instructions(ChatConnectedPromptInput {
        system,
        catalog: connected_tool_catalog,
    });
    let catalog_index = connected_prompt.catalog_index;
    let composio_writes = connected_prompt.composio_writes;
    let mcp_schemas = connected_prompt.mcp_schemas;
    let has_composio = connected_prompt.has_composio;
    let system = connected_prompt.system;
    let skill_prompt_catalog = prepare_skill_prompt_catalog(memory_workspace.as_str()).await;
    let enabled_skills = skill_prompt_catalog.enabled_skills;
    let homuncoder = skill_prompt_catalog.homuncoder;
    let is_project = skill_prompt_catalog.is_project;
    let has_skills = skill_prompt_catalog.has_skills;
    let artifact_destinations = prepare_chat_artifact_destinations();
    let system = append_chat_prompt_layers(ChatPromptLayersInput {
        system,
        contact: contact_ctx.as_ref(),
        enabled_skills: &enabled_skills,
        homuncoder: &homuncoder,
        is_project,
        choice_resume_slot,
        artifact_destinations: &artifact_destinations,
    });
    // Layer boundary: everything added below through the end of recall assembly
    // is workspace/thread knowledge, not a core instruction. Keep the provider
    // prompt text-compatible while exposing the real content boundary to the
    // Prompt Inspector and independent budgets.
    let prompt_core = system.clone();
    let objective_execution_context =
        prepare_chat_objective_execution_context(ChatObjectiveExecutionContextInput {
            state,
            thread_id: request.thread_id.as_deref(),
            catalog_index,
            composio_writes: &composio_writes,
        });
    let ChatObjectiveExecutionContext {
        active_objective_contract,
        semantic_contract,
        objective_effect_policy,
        memory_intent,
        memory_injection,
        catalog_index,
        ..
    } = objective_execution_context;
    // Memory scope. Perimeter "contact_only" (the default for channel contacts) is a
    // HARD gate: the user's personal profile + RAG are NOT injected — the turn only
    // sees the conversation history with THIS contact. "personal" opts a trusted
    // contact back into today's behavior.
    let workspace_prompt_context =
        prepare_chat_workspace_prompt_context(ChatWorkspacePromptContextInput {
            state,
            system,
            prompt_core: &prompt_core,
            prompt: &request.prompt,
            thread_id: request.thread_id.as_deref(),
            contact: contact_ctx.as_ref(),
            contact_memory_perimeter: &contact_memory_perimeter,
            memory_workspace: &memory_workspace,
            is_project,
            memory_intent: &memory_intent,
            memory_injection,
            applies_new_input,
        })
        .await;
    let prompt_workspace = workspace_prompt_context.prompt_workspace;
    let automatic_recall_payload = workspace_prompt_context.automatic_recall_payload;
    let workflow_routing_plan = resolve_chat_workflow_routing_plan(ChatWorkflowRoutingPlanInput {
        state,
        thread_id: request.thread_id.as_deref(),
        semantic_contract: semantic_contract.as_ref(),
    });
    let ChatWorkflowRoutingPlan {
        capability_route,
        workflow_route,
        workflow_deny_tools,
        forced_tool,
        ..
    } = workflow_routing_plan;
    // Turn trace: setup COMPLETED (memory recall and prompt-build) and generation is about to begin.
    // A `turn_start` following a `turn_received` implies setup succeeded (no pre-gen hang).
    record_chat_turn_start_trace(ChatTurnStartTraceInput {
        turn_trace: &turn_trace,
        prompt: request.prompt.as_str(),
        turn_policy: &turn_policy,
        model: model.as_str(),
    });
    let capability_router_instruction =
        capability_router_instruction_for_decision(&capability_route);
    let prompt_runtime = prepare_chat_runtime_prompt(ChatRuntimePromptInput {
        memory_intent: &memory_intent,
        capability_router_instruction: capability_router_instruction.as_deref(),
        turn_policy: &turn_policy,
        objective_contract: active_objective_contract.as_ref(),
    });
    let (system, prompt_packets) = compose_gateway_prompt_packets(
        state,
        request.thread_id.as_deref(),
        prompt_core,
        prompt_workspace,
        prompt_runtime,
    );
    let system = system.as_str();
    // (The 401/tool-compat/timeout fallback flags moved into GatewayModelClient::generate,
    // which now owns the per-round provider swap — ADR 0024.)
    // Browser toolset: the main agent ALWAYS drives the browser itself via the
    // granular micro-tools. The legacy coarse `browse_web` handoff is gone.
    // read_only (channels) still gets browser_act, but the dispatch blocks any
    // committing action — channels can fill/scroll/read, never click-submit.
    // ADR 0025 (slice 4b — converged): the MANAGER sees a single `browse(goal)` tool; the 6 granular
    // browser tools are driven ONLY inside the isolated browse sub-loop (they're seeded there directly),
    // never offered to the manager. The mid-turn model-switch + the granular-tools-on-the-manager path
    // are retired — one canonical browser path.
    let browser_continuation_available = request
        .thread_id
        .as_deref()
        .is_some_and(|thread_id| thread_has_browser_continuation(state, thread_id));
    let chat_toolset = prepare_chat_toolset(ChatToolsetInput {
        state,
        prompt: &request.prompt,
        turn_policy: &turn_policy,
        contact_memory_perimeter,
        memory_intent: &memory_intent,
        has_skills,
        artifact_destinations: &artifact_destinations,
        objective_effect_policy: &objective_effect_policy,
        composio_writes: &composio_writes,
        workflow_route: &workflow_route,
        workflow_deny_tools: &workflow_deny_tools,
        browser_continuation_available,
        capability_route: &capability_route,
        hitl_choice_resume_active: hitl_choice_resume.is_some(),
        mcp_schemas: &mcp_schemas,
        has_composio: has_composio && applies_new_input,
        catalog_index: &catalog_index,
        enabled_skills: &enabled_skills,
    })
    .await;
    let base_tools = chat_toolset.base_tools;
    let capability_corpus = chat_toolset.capability_corpus;
    // Connectors are NOT flattened into the BM25 corpus: they're searched via the
    // toolkit-aware `search_composio_catalog` inside find_capability (returns a service's
    // full CRUD set together, so the model picks the right verb). The hits are still
    // converted to typed `CapabilityEntry` values before being surfaced.
    let attachments::ChatAttachmentWorkingSet { new_files, working } =
        attachments::prepare_chat_attachment_working_set(
            attachments::ChatAttachmentWorkingSetInput {
                state,
                thread_id: request.thread_id.as_deref(),
                attachments: &request.attachments,
                applies_new_input,
            },
        )
        .await;

    let user_content = attachments::prepare_chat_attachment_user_content(
        attachments::ChatAttachmentUserContentInput {
            prompt: &prompt,
            request_images: &request.images,
            applies_new_input,
            checkpoint_input_present: request.checkpoint_input.is_some(),
            new_files: &new_files,
            working: &working,
        },
    );
    // Built once, then moved into `ls.messages` at the loop's start (the loop grows it).
    // `mut` because the vision policy below may swap the images out for a description (see
    // `vision::AttachmentPlan`) before the manager ever sees them.
    let mut messages = prepare_agent_turn_initial_messages(system, user_content);

    let transport =
        open_chat_stream_transport(request.request_id.clone(), request.thread_id.clone());
    let resume_id = transport.resume_id;
    let tx = transport.sink;
    let rx = transport.receiver;
    if let gateway_temporal_preflight::TemporalPreflightOutcome::EarlyResponse(event) =
        gateway_temporal_preflight::evaluate_chat_temporal_preflight(request.prompt.as_str())
    {
        backfill_early_response_agent_run_attribution(
            state,
            request.agent_run_id.as_deref(),
            "temporal_preflight",
        );
        let _ = emit_early_stream_event(&tx, event).await;
        schedule_stream_registry_cleanup(resume_id.clone());
        return Ok(chat_stream_response_with_effective_model(
            rx,
            "temporal_preflight",
        ));
    }
    if let PrivacyGuardPreflightOutcome::EarlyResponse(response) =
        evaluate_chat_privacy_guard_preflight(ChatPrivacyGuardPreflightInput {
            http: &state.http,
            pending_vault_proposals: &state.pending_vault_proposals,
            request_id: &request.request_id,
            prompt: request.prompt.as_str(),
            applies_new_input,
            base_url: &base_url,
            model: &model,
        })
        .await
    {
        backfill_early_response_agent_run_attribution(
            state,
            request.agent_run_id.as_deref(),
            response.effective_model,
        );
        let early_text = match &response.event {
            GenerateStreamEvent::Done { text, .. } => Some(text.clone()),
            _ => None,
        };
        let _ = emit_early_stream_event(&tx, response.event).await;
        let turn_id = broker_turn_id_from_stream_request_id(&request.request_id);
        if let Some(text) = early_text.as_deref() {
            fanout_legacy_card_markers_from_text(state, turn_id, text);
        }
        if let Ok(lines) = tx.entry.lines.lock() {
            for line in lines.iter() {
                fanout_turn_event(state, turn_id, line);
            }
        }
        schedule_stream_registry_cleanup(resume_id.clone());
        return Ok(chat_stream_response_with_effective_model(
            rx,
            response.effective_model,
        ));
    }

    let vision_preflight = prepare_chat_vision_preflight(ChatVisionPreflightInput {
        http: &state.http,
        base_url: &base_url,
        model: &model,
        messages: &mut messages,
        prompt: &prompt,
    })
    .await;
    let vision_fallback_armed = match vision_preflight {
        ChatVisionPreflight::Continue { fallback_armed } => fallback_armed,
        ChatVisionPreflight::EarlyResponse {
            text,
            effective_model,
        } => {
            backfill_early_response_agent_run_attribution(
                state,
                request.agent_run_id.as_deref(),
                &effective_model,
            );
            let _ = emit_early_stream_event(
                &tx,
                GenerateStreamEvent::Done {
                    text,
                    metrics: TokenMetrics::zero(),
                    redacted_user_text: None,
                },
            )
            .await;
            schedule_stream_registry_cleanup(resume_id.clone());
            return Ok(chat_stream_response_with_effective_model(
                rx,
                effective_model,
            ));
        }
    };

    let http = chat_streaming_http_client(&state.http);
    let state_owned = state.clone();
    let temperature = request.temperature;
    backfill_normal_agent_run_attribution(
        state,
        request.agent_run_id.as_deref(),
        &base_url,
        &model,
    );
    let execution_identity =
        resolve_agent_turn_execution_identity(&request.request_id, request.agent_run_id.as_deref());
    // Thread this chat belongs to: lets browser work reuse a persistent
    // per-thread browser session (search → then book on the same tab).
    let thread_id = request.thread_id.clone();
    let tail_context = prepare_agent_turn_tail_context(
        state,
        thread_id.as_deref(),
        &request.prompt,
        &effective_context,
        applies_new_input,
    );
    let actor_scope = tail_context.actor_scope;
    let memory_user_message = tail_context.user_message;
    let memory_prev_assistant = tail_context.previous_assistant;
    let chat_plan_resume = prepare_chat_plan_resume(ChatPlanResumeInput {
        state,
        thread_id: thread_id.as_deref(),
        effective_context: &effective_context,
        applies_new_input,
    });
    let tool_runtime_scope = AgentTurnToolRuntimeScope {
        composio_writes,
        catalog_index,
        capability_corpus,
        capability_route: capability_route.clone(),
    };
    let abort_resume_id = resume_id.clone();
    let engine_task = tokio::spawn(async move {
        let mut loop_seed = seed_agent_turn_loop_state(prompt_packets, messages);
        seed_agent_turn_recall(
            &mut loop_seed.loop_state,
            &tx,
            applies_new_input,
            automatic_recall_payload,
        )
        .await;
        seed_agent_turn_sensitive_confirmations(
            &state_owned,
            thread_id.as_deref(),
            &mut loop_seed.loop_state,
        );
        publish_agent_turn_route_trace(
            &mut loop_seed.loop_state,
            &tx,
            &tool_runtime_scope.capability_route,
        )
        .await;
        // No-progress guard: if the model repeats the EXACT same tool calls round after
        // round, it's stuck (not making progress) → stop and synthesize, instead of
        // burning the whole round budget on a loop. This is what lets the budget be
        // generous: real long tasks run, loops are caught fast.
        // Long-horizon execution (F1): the round budget is measured from the LAST
        // verified progress, not from round 0. Whenever a canonical plan step becomes
        // `done` (verified), we move the anchor to the current round and reset the
        // no-progress guard — so a big plan-driven task (10 slides, a long web research)
        // keeps going for as long as it KEEPS CLOSING STEPS, while a turn stuck on one
        // step still trips the per-step budget.
        // CANONICAL PLAN: the single source of truth for the task's steps + their status,
        // owned by the runtime (not rebuilt from the model's text each call). update_plan
        // MERGES into this by id/title and can never reset a done step; F1 budget reset,
        // F2 verification, F5 next-step and the ‹‹PLAN›› marker all read THIS. Seeded from
        // the prior conversation (F4 resume). A step is `done` only after F2 verified it.
        // F2 verification gate: the running evidence (tool name → result snippet) for the
        // CURRENT plan step, fed to the verifier when the model marks the step done, then
        // cleared. A chat model can claim "done" without doing the work; the gate checks.
        // F3 context compaction: `ls.step_messages_start` is the index in `ls.messages` where the
        // current step's work begins; once the step is verified, that slice is summarised
        // into one note so a long multi-step turn stays within the context window.
        // `ls.pending_compaction` defers the rewrite to the next round's safe boundary (never
        // mid tool-call/result group, which would break OpenAI-compat pairing).
        // Set right before the round loop (once the initial context is fully in
        // `ls.messages`) so compaction never folds the system/user context into a summary.
        // Plan-completion enforcement: counts consecutive turns where the model STOPPED
        // (no tool call) while its plan still has open steps. Reset on any tool call.
        // Slice 2.5: did the model actually ACT (use a tool) this turn? Used at the no-tool
        // stop to tell a PREMATURE stop on a real task (judge it, bootstrap a plan) apart from
        // a plain conversational answer (let it end). Latches true once any tool has run.
        // Tools offered to the model this run: the base set, plus any tools the
        // model discovers via `find_connected_tools` (injected on demand).
        seed_agent_turn_tool_schemas(
            &mut loop_seed.loop_state,
            base_tools,
            &turn_policy,
            contact_ctx.as_ref(),
        );
        // Turn-local browser state now lives in the browser subsystem: the loop-visible fields
        // (browser_used / pending_browser_image / browser_tool_call_ids) travel in `LoopState`
        // (slice 5a), and the browser-private state (sidecar session, last snapshot, current tab /
        // opened targets, per-URL nav failures) is OWNED by `GatewayBrowserExecutor`, constructed
        // inside `run_agent_rounds` (slice 5b). Nothing to seed here.
        // Fresh terminal buffer for this request; the computer panel shows the
        // CLI commands + output run during THIS response.
        reset_agent_turn_terminal_buffer(thread_id.clone());

        let plan_seed = seed_agent_turn_plan_state(
            &mut loop_seed.loop_state,
            &chat_plan_resume,
            verbose_debug(),
        );

        seed_agent_turn_model_provider(&mut loop_seed.loop_state, &http, model, base_url, api_key)
            .await;
        seed_agent_turn_recovery_checkpoint(
            &mut loop_seed.loop_state,
            recovery_checkpoint,
            request.checkpoint_input.is_some(),
        );
        let resolved_hitl = resolved_hitl_guard_for_turn(hitl_choice_resume.as_ref());
        let config_runtime_scope = resolve_agent_turn_config(AgentTurnConfigInput {
            context_window: model_context_window,
            forced_tool: forced_tool.clone(),
            resolved_hitl,
        });
        let tail_snapshot = snapshot_agent_turn_tail(AgentTurnTailSnapshotInput {
            state: &state_owned,
            thread_id: thread_id.as_deref(),
            request_id: &request.request_id,
            user_id: &actor_scope.user_id,
            workspace_id: &actor_scope.workspace_id,
            user_message: &memory_user_message,
            previous_assistant: memory_prev_assistant.as_deref(),
        });
        // 5.D1c.9: resolve the trace-dump dir gateway-side (armed only when HOMUN_TRACE_DUMP=1) and
        // inject it, so the engine loop appends without calling the gateway's path resolver.
        let trace_dir = resolve_agent_turn_trace_dump_dir();
        let trace_runtime_scope = AgentTurnTraceRuntimeScope {
            trace_dir,
            turn_trace: &turn_trace,
        };
        let outcome = run_agent_rounds(
            loop_seed,
            &tx,
            http,
            state_owned,
            temperature,
            prompt,
            thread_id,
            &turn_policy,
            chat_channel,
            contact_memory_perimeter,
            memory_intent,
            memory_user_message,
            plan_seed,
            tool_runtime_scope,
            actor_scope,
            config_runtime_scope,
            trace_runtime_scope,
            &execution_identity,
            vision_fallback_armed,
        )
        .await;
        complete_agent_turn_tail(AgentTurnTailInput {
            state: tail_snapshot.state,
            tx: &tx,
            outcome,
            execution_identity: &execution_identity,
            thread_id: tail_snapshot.thread_id,
            fence_turn_id: tail_snapshot.fence_turn_id,
            fence_user_id: tail_snapshot.fence_user_id,
            fence_workspace_id: tail_snapshot.fence_workspace_id,
            applies_new_input,
            turn_policy: &turn_policy,
            user_message: tail_snapshot.user_message,
            previous_assistant: tail_snapshot.previous_assistant,
            tail_turn_id: tail_snapshot.tail_turn_id,
            resume_id: resume_id.clone(),
            turn_trace: &turn_trace,
        })
        .await;
    });
    if let Ok(mut map) = stream_abort_registry().lock() {
        map.insert(abort_resume_id, engine_task.abort_handle());
    }

    Ok(chat_stream_response(rx))
}

fn backfill_early_response_agent_run_attribution(
    state: &AppState,
    agent_run_id: Option<&str>,
    effective_model: &str,
) {
    let Some(run_id) = agent_run_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if effective_model.trim().is_empty() {
        return;
    }
    if let Ok(store) = state.task_store.lock()
        && let Err(error) = store.backfill_agent_run_attribution(
            run_id,
            Some(effective_model),
            Some("local_preflight"),
            None,
        )
    {
        tracing::warn!(
            target: "agent::journal",
            %run_id,
            %error,
            "could not backfill early-response agent run attribution"
        );
    }
}

fn backfill_normal_agent_run_attribution(
    state: &AppState,
    agent_run_id: Option<&str>,
    base_url: &str,
    effective_model: &str,
) {
    let Some(run_id) = agent_run_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let provider = diagnostic_provider_label(base_url);
    if effective_model.trim().is_empty() || provider.is_none() {
        return;
    }
    if let Ok(store) = state.task_store.lock()
        && let Err(error) = store.backfill_agent_run_attribution(
            run_id,
            Some(effective_model),
            provider.as_deref(),
            None,
        )
    {
        tracing::warn!(
            target: "agent::journal",
            %run_id,
            %error,
            "could not backfill normal agent run attribution"
        );
    }
}

fn diagnostic_provider_label(base_url: &str) -> Option<String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains("127.0.0.1") || trimmed.contains("localhost") {
        return Some("local".to_string());
    }
    Some("remote".to_string())
}

// ADR 0024 inc 5 (5.D1a): the agent turn's round loop + forced synthesis + post-turn
// learn, extracted VERBATIM from the tokio::spawn body of stream_chat_via_openai. The
// signature (the captured turn state) is what becomes engine::run_turn's interface at 5.D1c.
#[allow(clippy::too_many_arguments)]
async fn run_agent_rounds(
    loop_seed: AgentTurnLoopSeed,
    tx: &StreamSink,
    http: reqwest::Client,
    state_owned: AppState,
    temperature: f64,
    prompt: String,
    thread_id: Option<String>,
    turn_policy: &ChatTurnPolicy,
    chat_channel: ChatChannelContext,
    contact_memory_perimeter: ContactMemoryPerimeter,
    memory_intent: semantic_decision::MemoryIntent,
    memory_user_message: String,
    plan_seed: AgentTurnPlanSeed,
    tool_runtime_scope: AgentTurnToolRuntimeScope,
    actor_scope: AgentTurnActorScope,
    config_runtime_scope: AgentTurnConfigRuntimeScope,
    trace_runtime_scope: AgentTurnTraceRuntimeScope<'_>,
    execution_identity: &AgentTurnExecutionIdentity,
    // The turn is sending images to a model on a guess (`AttachmentPlan::InlineWithFallback`), and a
    // vision model exists to describe them if the provider refuses. Passed rather than re-derived here:
    // the policy is decided ONCE, in `vision::plan_attachments`, and this is its consequence.
    vision_fallback_armed: bool,
) -> local_first_engine::TurnOutcome {
    let AgentTurnLoopSeed {
        loop_state: ls,
        memory_answer,
        last_model_error,
        browse_sources,
    } = loop_seed;
    let AgentTurnToolRuntimeScope {
        composio_writes,
        catalog_index,
        capability_corpus,
        capability_route,
    } = tool_runtime_scope;
    let AgentTurnTraceRuntimeScope {
        trace_dir,
        turn_trace,
    } = trace_runtime_scope;
    let AgentTurnConfigRuntimeScope { turn_config: cfg } = config_runtime_scope;

    // Build the seams `engine::run_turn` runs against — thin gateway adapters over AppState/transport/
    // stores, constructed ONCE per turn from this turn's context (ADR 0024/0026). model_client borrows
    // http+tx locally; the tool chokepoints hold the turn-constant read-only context and get `&mut ls`
    // per call from the engine.
    let steering_context = crate::model_client::gateway_steering_context(
        &state_owned,
        actor_scope.user_id.as_str(),
        actor_scope.workspace_id.as_str(),
        thread_id.as_deref(),
        execution_identity.effect_turn_id.as_deref(),
        execution_identity.effect_run_id.as_deref(),
    );
    let model_client = crate::model_client::gateway_model_client(
        &http,
        tx,
        state_owned.usage_recorder.as_ref(),
        steering_context,
    );
    let usage_context = chat_response_usage_context(
        actor_scope.user_id.as_str(),
        actor_scope.workspace_id.as_str(),
        thread_id.clone(),
        execution_identity.effect_turn_id.clone(),
        execution_identity.effect_run_id.clone(),
    );
    let effect_contract =
        load_turn_effect_contract(&state_owned, execution_identity.effect_turn_id.as_deref());
    let capability_executor = gateway_capability_executor(GatewayCapabilityExecutorInput {
        state: &state_owned,
        tx,
        thread_id: thread_id.as_deref(),
        turn_policy,
        contact_memory_perimeter,
        memory_intent,
        composio_writes: &composio_writes,
        catalog_index: &catalog_index,
        capability_corpus: &capability_corpus,
        automation_user_id: &actor_scope.user_id,
        automation_workspace_id: &actor_scope.workspace_id,
        // ADR 0025: turn-constants for a recursive `browse(goal)` sub-turn (used only when the manager
        // calls the `browse` tool; inert otherwise).
        prompt: &prompt,
        chat_channel,
        turn_trace,
        turn_id: execution_identity.effect_turn_id.as_deref(),
        run_id: execution_identity.effect_run_id.as_deref(),
        execution_contract: effect_contract.as_ref(),
    });
    // The browser tool chokepoint (ADR 0025 seam): OWNS the browser subsystem's private state (session +
    // snapshot/tab/nav bookkeeping); `&mut` because run_turn mutates it per browser call.
    let mut browser_executor = GatewayBrowserExecutor {
        browser_session: None,
        last_snapshot: String::new(),
        last_snapshot_semantic_fingerprint: String::new(),
        browse_sources: Vec::new(),
        last_payment_floor_refs: std::collections::HashMap::new(),
        payment_context_by_target: std::collections::HashMap::new(),
        result_contract: None,
        current_target: "chat_0".to_string(), // the first tab the tools operate on
        opened_targets: Vec::new(),
        nav_failures: std::collections::HashMap::new(),
        state: &state_owned,
        tx,
        thread_id: thread_id.as_deref(),
        prompt: &prompt,
        read_only: turn_policy.read_only,
        channel_owner: chat_channel.owner,
        // C2: the manager turn's own registered journal — same handle `run_turn` below receives via
        // `&execution_journal`, so protocol metrics from a manager-level browser call land in the same
        // run as everything else this turn records.
        journal: execution_identity.execution_journal.clone(),
        execution_contract: effect_contract.clone(),
        effect_run_id: execution_identity.effect_run_id.clone(),
        turn_id: execution_identity.effect_turn_id.clone(),
        step_memory: None,
        auto_screenshot: false,
        screenshot_on_stall: false,
        consecutive_snapshot_count: 0,
        recent_action_signatures: std::collections::VecDeque::new(),
        recent_failed_action_families: std::collections::VecDeque::new(),
    };
    let plan_progress = gateway_plan_progress(state_owned.clone());
    let compactor = gateway_context_compactor(state_owned.clone(), thread_id.clone());
    let engine_turn_policy = gateway_turn_policy(capability_route);
    let completion_judge = gateway_turn_completion_judge(state_owned.clone());

    // Vision fallback (`AttachmentPlan::InlineWithFallback`): this turn's images ride the manager's
    // first call on nothing better than a catalog's opinion. Keep the turn's PRISTINE seed so we can
    // replay it: a provider that refuses to look at the images kills the turn before it has streamed a
    // token or run a tool (`TurnOutcome::image_rejection` — see the engine's early return), so we can
    // describe them on the vision role and re-run from a conversation the manager can actually read.
    // The user gets one answer, not a 400 followed by an apology. Cloning the seed is cheap (2
    // messages) and happens only for image turns that have a vision model to fall back on.
    let vision_seed = snapshot_chat_vision_fallback_seed(ChatVisionFallbackSeedInput {
        fallback_armed: vision_fallback_armed,
        loop_state: &ls,
        config: &cfg,
        user_message: &memory_user_message,
        memory_answer: &memory_answer,
        last_model_error: &last_model_error,
        browse_sources: &browse_sources,
        trace_dir: &trace_dir,
    });

    // ADR 0024 inc 5, 5.D2 — THE MOVE landed: the single guarded ReAct loop (motore #1) lives in
    // `engine::run_turn`. The gateway builds the seams above and invokes the ONE canonical loop — no
    // flag, no inline copy (converge, don't duplicate). ADR 0025 (browse-as-recursion) invokes this
    // same `run_turn` recursively for the browser.
    let outcome = local_first_engine::agent_loop::run_turn(
        ls,
        cfg,
        &usage_context,
        &model_client,
        &capability_executor,
        &mut browser_executor,
        &plan_progress,
        &completion_judge,
        &compactor,
        &engine_turn_policy,
        &execution_identity.execution_journal,
        tx,
        temperature,
        thread_id.as_deref(),
        &composio_writes,
        &catalog_index,
        memory_user_message,
        memory_answer,
        last_model_error,
        plan_seed.final_done,
        plan_seed.plan_nudges,
        plan_seed.turn_used_tools,
        browse_sources,
        trace_dir,
        turn_trace,
    )
    .await;

    // A model suspension is a typed engine stop. The broker drain observes it
    // through the stream entry's outcome channel; no fabricated `done` event and
    // no task-state mutation are needed to unblock transport.
    if matches!(
        outcome.stop,
        local_first_engine::TurnStop::SuspendedModel { .. }
            | local_first_engine::TurnStop::SuspendedEffect { .. }
    ) {
        return outcome;
    }

    // The common case: the turn ran (whatever it concluded).
    let Some(rejection) = outcome.image_rejection.clone() else {
        return outcome;
    };

    let Some(mut vision_seed) = vision_seed else {
        // The model can't read the image and we have nobody to read it for us. The turn emitted
        // nothing, so this is its answer — the one case where the provider's refusal is the honest
        // thing to show.
        return gateway_agent_turn_outcomes::deliver_image_rejection(tx, outcome, rejection).await;
    };

    let readers = vision_model_candidates();
    if readers.is_empty() {
        // Armed at seed time but gone now (the role was cleared mid-turn) — same dead end.
        return gateway_agent_turn_outcomes::deliver_image_rejection(tx, outcome, rejection).await;
    }

    // Recover: describe the refused images, put the text where they were, run again.
    recover_chat_vision_fallback_seed(ChatVisionRecoveryInput {
        http: &http,
        seed: &mut vision_seed,
        readers: &readers,
        prompt: &prompt,
    })
    .await;

    local_first_engine::agent_loop::run_turn(
        vision_seed.loop_state,
        vision_seed.config,
        &usage_context,
        &model_client,
        &capability_executor,
        &mut browser_executor,
        &plan_progress,
        &completion_judge,
        &compactor,
        &engine_turn_policy,
        &execution_identity.execution_journal,
        tx,
        temperature,
        thread_id.as_deref(),
        &composio_writes,
        &catalog_index,
        vision_seed.user_message,
        vision_seed.memory_answer,
        vision_seed.last_model_error,
        plan_seed.final_done,
        plan_seed.plan_nudges,
        plan_seed.turn_used_tools,
        vision_seed.browse_sources,
        vision_seed.trace_dir,
        turn_trace,
    )
    .await
}

fn execute_capability_browser_task(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    let payload: CapabilityTaskPayload =
        serde_json::from_value(task.input_json.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("Invalid browser capability payload: {error}"),
            }
        })?;
    let method = browser_method_for_capability_tool(&payload.call.tool_name).ok_or_else(|| {
        LocalTaskExecutionError {
            message: format!("Unsupported browser tool: {}", payload.call.tool_name),
        }
    })?;

    append_task_progress_checkpoint(
        state,
        task,
        "capability_browser_executor_started",
        SurfaceKind::Browser,
        "Browser executor",
        &format!(
            "Running capability `{}` via BrowserTaskExecutor.",
            payload.call.tool_name
        ),
        serde_json::json!({
            "kind": "capability_browser_executor_started",
            "tool": payload.call.tool_name,
            "provider": payload.call.provider_id.as_str(),
        }),
    )
    .map_err(local_task_gateway_error)?;

    let result =
        execute_persistent_browser_capability(state, task, method, payload.call.arguments)?;

    gateway_capability_execution::task_execution_outcome_from_executor_result(
        state,
        task,
        contract,
        "browser-capability-executor",
        &payload.call.tool_name,
        result,
    )
}

/// True when a browser client error means the single persistent sidecar process
/// is gone (broken IPC pipe, or a garbled/empty reply because the child closed
/// its stdout) and the cached handle should be dropped so the next attempt
/// respawns. `InvalidRequest` is our own serialization bug and the policy/path
/// blocks are legitimate per-call errors — none of those imply a dead process.
fn browser_error_indicates_dead_sidecar(error: &BrowserAutomationError) -> bool {
    matches!(
        error,
        BrowserAutomationError::Sidecar(_) | BrowserAutomationError::InvalidResponse(_)
    )
}

/// Fixed label for the one tab the execution surface manages per session. Using
/// a constant label (instead of a runtime-generated id) lets the planner emit
/// high-level steps while the executor keeps a stable target.
const BROWSER_MANAGED_TARGET: &str = "primary";

/// Maps a planner-level browser call onto the executor-managed tab.
///
/// The sidecar's capability tools are tab-scoped: `navigate`/`act`/`snapshot`/…
/// all require a `target_id`. But the planner emits intent ("navigate to URL",
/// "fill these fields") and cannot know a tab id that only exists at runtime. So
/// the single execution surface owns ONE managed tab (label "primary"):
/// - `navigate {url}` with no target becomes an idempotent `open {url, label}`
///   (open creates the tab on first use and re-navigates it afterwards),
/// - other tab-scoped calls get `target_id` injected,
/// - tabless calls (health/profiles/tabs/open/start/stop) pass through.
///
/// A call that already carries an explicit `target_id` is left untouched.
fn normalize_browser_call(method: BrowserMethod, mut params: Value) -> (BrowserMethod, Value) {
    let has_target = params
        .get("target_id")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    if has_target {
        return (method, params);
    }
    if !params.is_object() {
        params = serde_json::json!({});
    }
    match method {
        BrowserMethod::Navigate => {
            // open is idempotent on the label: creates+navigates the managed tab.
            params["label"] = serde_json::json!(BROWSER_MANAGED_TARGET);
            (BrowserMethod::Open, params)
        }
        BrowserMethod::Snapshot
        | BrowserMethod::Checkpoint
        | BrowserMethod::Restore
        | BrowserMethod::Rehydrate
        | BrowserMethod::Act
        | BrowserMethod::Screenshot
        | BrowserMethod::Console
        | BrowserMethod::Pdf
        | BrowserMethod::Focus
        | BrowserMethod::CloseTab
        | BrowserMethod::ArmFileChooser
        | BrowserMethod::RespondDialog
        | BrowserMethod::WaitDownload => {
            params["target_id"] = serde_json::json!(BROWSER_MANAGED_TARGET);
            (method, params)
        }
        BrowserMethod::Health
        | BrowserMethod::Profiles
        | BrowserMethod::Tabs
        | BrowserMethod::Open
        | BrowserMethod::Start
        | BrowserMethod::Stop => (method, params),
    }
}

/// Outcome of a call against the single shared browser sidecar.
enum SharedSidecarCall {
    /// The sidecar replied (the response may still be a browser-level error).
    Response(BrowserResponse),
    /// The sidecar process was gone; the cached handle has been dropped and the
    /// task should retry (which respawns a fresh sidecar). Carries the reason.
    SidecarLost(String),
}

/// A CDP "wedge": the sidecar IPC is healthy but its inner `connectOverCDP` to the
/// contained-computer Chromium times out. Happens when a long-lived container
/// accumulates stale CDP targets — `/json/version` still answers (so `browser_cdp_ok`
/// can't see it), yet the ws handshake hangs. The cure is recycling the container.
/// Matched conservatively on Playwright's English message (its only producer). This
/// is the gap that turned a transient wedge into the drive's hard browse failure:
/// motore #1's HTTP-only self-heal misses it too, but its warm per-thread session
/// usually predates the wedge — the drive spawns cold into it.
/// The textual signature of a CDP wedge in an error string: a `connectOverCDP` timeout.
fn cdp_wedge_signature(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("connectovercdp") && message.contains("timeout")
}

fn browser_response_indicates_cdp_wedge(response: &BrowserResponse) -> bool {
    match response {
        BrowserResponse::Error { error, .. } => cdp_wedge_signature(&error.message),
        BrowserResponse::Success { .. } => false,
    }
}

/// Throttle container recycles so a burst of wedge responses (an agentic loop
/// retrying every round) recycles AT MOST once per window — never thrashing
/// `docker rm -f`. Returns true and arms the window when a recycle is allowed.
fn browser_recycle_throttle_ok() -> bool {
    static LAST: std::sync::OnceLock<std::sync::Mutex<Option<std::time::Instant>>> =
        std::sync::OnceLock::new();
    let cell = LAST.get_or_init(|| std::sync::Mutex::new(None));
    let Ok(mut guard) = cell.lock() else {
        return false;
    };
    let now = std::time::Instant::now();
    let allowed = guard
        .map(|last| now.duration_since(last) >= std::time::Duration::from_secs(90))
        .unwrap_or(true);
    if allowed {
        *guard = Some(now);
    }
    allowed
}

/// THE single browser execution surface (A1.3). All durable browser capability
/// execution flows through here so there is exactly one owner of the persistent
/// sidecar: this function holds `state.browser_capability_client`, lazily spawns
/// the process once, reuses it across calls/tasks, and self-heals by dropping a
/// dead handle. Any future live read-only provider must delegate here rather
/// than spawn a competing sidecar.
fn call_shared_browser_sidecar(
    state: &AppState,
    task: &TaskRecord,
    method: BrowserMethod,
    params: Value,
) -> Result<SharedSidecarCall, LocalTaskExecutionError> {
    // Map the planner-level call onto the managed tab (inject/translate target).
    let (method, params) = normalize_browser_call(method, params);
    let mut client_guard =
        state
            .browser_capability_client
            .lock()
            .map_err(|error| LocalTaskExecutionError {
                message: format!("Browser capability lock fallita: {error}"),
            })?;
    if client_guard.is_none() {
        *client_guard = Some(BrowserAutomationClient::new(
            spawn_browser_sidecar_for_task(state, task)?,
        ));
    }
    // Borrow the shared client only for the call so we can replace it afterwards
    // if the sidecar turns out to be dead.
    let call_result = {
        let client = client_guard
            .as_ref()
            .ok_or_else(|| LocalTaskExecutionError {
                message: "Browser capability not initialized.".to_string(),
            })?;
        client.call_response(method, params)
    };
    match call_result {
        // Self-heal a CDP wedge (connectOverCDP timeout despite a live sidecar):
        // recycle the contained computer once per window, drop the sidecar so the next
        // call respawns against the fresh CDP, and report SidecarLost so the caller
        // retries (the drive's agentic loop retries next round; the durable runtime
        // re-enqueues). Closes the gap `browser_cdp_ok`'s HTTP probe can't catch.
        Ok(response)
            if browser_response_indicates_cdp_wedge(&response) && browser_recycle_throttle_ok() =>
        {
            crate::sandbox::recycle_container();
            let _ = crate::sandbox::ensure_contained_computer();
            *client_guard = None;
            Ok(SharedSidecarCall::SidecarLost(
                "browser CDP wedged (connectOverCDP timeout); recycled contained computer, \
                 respawning on retry"
                    .to_string(),
            ))
        }
        Ok(response) => Ok(SharedSidecarCall::Response(response)),
        // Self-heal: a broken IPC pipe (Sidecar) or a garbled/empty reply
        // (InvalidResponse, e.g. the child closed stdout) means the single
        // persistent sidecar process is gone. Drop the dead handle so the next
        // attempt respawns a fresh one, and let the durable task runtime retry
        // instead of failing the task permanently against a corpse.
        Err(error) if browser_error_indicates_dead_sidecar(&error) => {
            *client_guard = None;
            Ok(SharedSidecarCall::SidecarLost(format!(
                "browser sidecar lost ({error}); respawning on retry"
            )))
        }
        Err(error) => Err(LocalTaskExecutionError {
            message: format!("Browser capability fallita: {error}"),
        }),
    }
}

/// Fail-closed safety gate for the durable, NON-INTERACTIVE browser capability
/// executor. Returns the refusal reason, or `None` when the call is safe to run.
///
/// The interactive guarded loop (`execute_browser_tool` + `browser_safety`) is the
/// ONLY place a browser *action* can be gated safely: it owns the live page snapshot
/// (needed to resolve the target control's label) and the per-turn Payment Approval
/// Card (the `payment_approval_id` a final purchase requires). A durable capability
/// task — materialized by the OrchestratorBrain and run by the background worker —
/// has NEITHER: there is no chat turn to carry an approval, and no snapshot to
/// evaluate against, so `browser_safety::high_risk_reason` would itself fail OPEN
/// here on an unresolved `ref`. Reusing that gate would therefore be a fail-open, not
/// a fix. So this executor must never perform a committing browser action: `Act`
/// (the sidecar's single committing/interactive surface) is refused outright, as is
/// any method carrying payment-commit intent. Page reads (snapshot/tabs/screenshot)
/// and navigation stay allowed. This is deliberately scoped to THIS pipeline and does
/// not touch the interactive `browser_safety` gate (converge, don't duplicate).
fn browser_capability_action_refusal(method: BrowserMethod, params: &Value) -> Option<String> {
    if method == BrowserMethod::Act {
        return Some(
            "refused: browser_act cannot run in a non-interactive durable task — a \
             click/type/payment can only be gated by the interactive guarded loop (live \
             snapshot + Payment Approval Card). Drive the browser inline in chat instead."
                .to_string(),
        );
    }
    // Defense in depth: refuse payment-commit intent declared or carried on ANY method.
    // A `payment_approval_id`/`vault_secret` cannot be validated without the interactive
    // approval flow, so its presence here is a rejection, never an implicit unlock.
    let declares_payment_commit = browser_safety::declared_action_class(params)
        == Some(browser_safety::ActionClass::PaymentCommit);
    let carries_payment_field = ["payment_approval_id", "vault_secret"].iter().any(|field| {
        params
            .get(*field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    });
    if declares_payment_commit || carries_payment_field {
        return Some(
            "refused: a payment-commit browser action cannot run in a non-interactive durable \
             task — it requires a Payment Approval Card that only the interactive guarded loop \
             can issue and validate."
                .to_string(),
        );
    }
    None
}

fn execute_persistent_browser_capability(
    state: &AppState,
    task: &TaskRecord,
    method: BrowserMethod,
    params: Value,
) -> Result<ExecutorResult, LocalTaskExecutionError> {
    // Fail-closed gate BEFORE the shared sidecar's `Act` call: this durable, headless
    // context can never present a Payment Approval Card nor a live snapshot, so a
    // committing/payment browser action is refused here rather than forwarded ungated.
    if let Some(reason) = browser_capability_action_refusal(method, &params) {
        return Err(LocalTaskExecutionError { message: reason });
    }
    let response = match call_shared_browser_sidecar(state, task, method, params.clone())? {
        SharedSidecarCall::SidecarLost(reason) => {
            return Ok(ExecutorResult::RetryableFailure { reason });
        }
        SharedSidecarCall::Response(response) => response,
    };
    match response {
        BrowserResponse::Success {
            ok: true, result, ..
        } if method == BrowserMethod::Snapshot => Ok(ExecutorResult::Checkpoint {
            payload: result.clone(),
            redacted_payload: browser_capability_redacted_checkpoint(method, &params, result),
        }),
        BrowserResponse::Success {
            ok: true, result, ..
        } => Ok(ExecutorResult::Completed { output: result }),
        BrowserResponse::Success { .. } => Ok(ExecutorResult::RetryableFailure {
            reason: "browser returned invalid success envelope".to_string(),
        }),
        BrowserResponse::Error { error, .. } if error.manual_action_required => {
            Ok(ExecutorResult::NeedsApproval {
                action: "browser.manual_action".to_string(),
                risk_level: "medium".to_string(),
                data_boundary: "local_browser".to_string(),
                explanation: error.message,
            })
        }
        BrowserResponse::Error { error, .. } => Ok(ExecutorResult::RetryableFailure {
            reason: format!("{}:{}", error.code, error.message),
        }),
    }
}

fn browser_capability_redacted_checkpoint(
    method: BrowserMethod,
    params: &Value,
    result: Value,
) -> Value {
    let method_name = serde_json::to_value(method).unwrap_or(Value::Null);
    let target_id = params.get("target_id").cloned().unwrap_or(Value::Null);
    let mut browser = serde_json::json!({
        "method": method_name,
        "target_id": target_id,
    });
    if let Some(url) = result.get("url") {
        browser["url"] = url.clone();
    }
    if let Some(snapshot) = result.get("snapshot").and_then(Value::as_str) {
        browser["snapshot_excerpt"] =
            Value::String(redact_sensitive_text(&truncate_chars(snapshot, 2_000)));
    }
    browser
}

fn spawn_browser_sidecar_for_task(
    state: &AppState,
    task: &TaskRecord,
) -> Result<BrowserSidecarSession, LocalTaskExecutionError> {
    let browser_dir = browser_automation_dir();
    if !browser_dir.exists() {
        return Err(LocalTaskExecutionError {
            message: format!("Browser runtime not found: {}", browser_dir.display()),
        });
    }
    BrowserSidecarSession::spawn_with_options(
        "npm",
        &["run", "start", "--silent"],
        BrowserSidecarSpawnOptions {
            current_dir: Some(browser_dir),
            env: browser_sidecar_env(state, task),
        },
    )
    .map_err(|error| LocalTaskExecutionError {
        message: format!("Browser sidecar not started: {error}"),
    })
}

/// Spawn a browser sidecar for the CHAT granular-tool path (no TaskRecord). The
/// env mirrors `spawn_browser_sidecar_for_task` so profile/CDP/allow-private-
/// network/artifact-root are not lost; only the visibility (headless) falls back
/// to the global default since there is no task to read it from.
fn spawn_browser_sidecar_for_chat(
    state: &AppState,
) -> Result<BrowserSidecarSession, LocalTaskExecutionError> {
    let _ = state; // reserved for future per-state env (parity with the task path)
    let browser_dir = browser_automation_dir();
    if !browser_dir.exists() {
        return Err(LocalTaskExecutionError {
            message: format!("Browser runtime not found: {}", browser_dir.display()),
        });
    }
    BrowserSidecarSession::spawn_with_options(
        "npm",
        &["run", "start", "--silent"],
        BrowserSidecarSpawnOptions {
            current_dir: Some(browser_dir),
            env: browser_sidecar_env_for_chat(),
        },
    )
    .map_err(|error| LocalTaskExecutionError {
        message: format!("Browser sidecar not started: {error}"),
    })
}

fn browser_method_for_capability_tool(tool_name: &str) -> Option<BrowserMethod> {
    match tool_name {
        "browser.health" => Some(BrowserMethod::Health),
        "browser.profiles" => Some(BrowserMethod::Profiles),
        "browser.tabs" => Some(BrowserMethod::Tabs),
        "browser.snapshot" => Some(BrowserMethod::Snapshot),
        "browser.console" => Some(BrowserMethod::Console),
        "browser.open" => Some(BrowserMethod::Open),
        "browser.focus" => Some(BrowserMethod::Focus),
        "browser.close_tab" => Some(BrowserMethod::CloseTab),
        "browser.navigate" => Some(BrowserMethod::Navigate),
        "browser.screenshot" => Some(BrowserMethod::Screenshot),
        "browser.pdf" => Some(BrowserMethod::Pdf),
        "browser.act" => Some(BrowserMethod::Act),
        "browser.arm_file_chooser" => Some(BrowserMethod::ArmFileChooser),
        "browser.respond_dialog" => Some(BrowserMethod::RespondDialog),
        "browser.wait_download" => Some(BrowserMethod::WaitDownload),
        _ => None,
    }
}

/// Browser-loop router (Phase 2): the "browser" role.
fn build_browser_inference_router() -> ModelRouter {
    router_for_role("browser")
}

fn ensure_computer_session_for_task(
    state: &AppState,
    session_id: &str,
    task_id: &str,
    thread_id: &str,
    goal_redacted: &str,
    requires_approval: bool,
) -> Result<(), GatewayError> {
    let user = gateway_user_id();
    let workspace = gateway_workspace_id();
    let mut store = lock_computer_store(state)?;
    if store
        .session(session_id, user.as_str(), workspace.as_str())
        .map_err(GatewayError::local_computer)?
        .is_some()
    {
        return Ok(());
    }

    let now = OffsetDateTime::now_utc();
    let session = ComputerSessionRecord {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        workflow_id: Some(format!("workflow_{thread_id}")),
        user_id: user.as_str().to_string(),
        workspace_id: workspace.as_str().to_string(),
        status: if requires_approval {
            SessionStatus::WaitingUser
        } else {
            SessionStatus::Running
        },
        active_surface: if goal_redacted.to_lowercase().contains("terminal") {
            SurfaceKind::Shell
        } else {
            SurfaceKind::Browser
        },
        surfaces: default_computer_surfaces(now),
        title: "Computer locale".to_string(),
        subtitle: goal_redacted.to_string(),
        progress_current: 0,
        progress_total: if requires_approval { 3 } else { 2 },
        approval_state: if requires_approval {
            ApprovalState::WaitingUser
        } else {
            ApprovalState::None
        },
        takeover_state: TakeoverState::None,
        risk_level: if requires_approval { "medium" } else { "low" }.to_string(),
        last_error: None,
        started_at: now,
        updated_at: now,
    };
    store
        .upsert_session(&session)
        .map_err(GatewayError::local_computer)?;
    append_computer_event(
        &mut store,
        session_id,
        &user,
        &workspace,
        SurfaceKind::Logs,
        "computer_session_started",
        "done",
        "Local task created",
        "Local Computer session associated with the chat.",
        false,
    )?;
    if requires_approval {
        append_computer_event(
            &mut store,
            session_id,
            &user,
            &workspace,
            SurfaceKind::Logs,
            "computer_approval_required",
            "waiting",
            "Approval required",
            "Confirm the plan before running local actions.",
            true,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn append_computer_event(
    store: &mut LocalComputerSessionStore,
    session_id: &str,
    user: &UserId,
    workspace: &WorkspaceId,
    surface: SurfaceKind,
    kind: &str,
    status: &str,
    title: &str,
    subtitle: &str,
    approval_required: bool,
) -> Result<(), GatewayError> {
    store
        .append_event(&ComputerEventRecord {
            event_id: format!(
                "event_{}_{}",
                OffsetDateTime::now_utc().unix_timestamp_nanos(),
                kind
            ),
            session_id: session_id.to_string(),
            user_id: user.as_str().to_string(),
            workspace_id: workspace.as_str().to_string(),
            surface,
            kind: kind.to_string(),
            status: status.to_string(),
            title: title.to_string(),
            subtitle: subtitle.to_string(),
            payload: serde_json::json!({ "payload_redacted": true }),
            artifact_refs: vec![],
            approval_required,
            created_at: OffsetDateTime::now_utc(),
        })
        .map_err(GatewayError::local_computer)
}

#[allow(clippy::too_many_arguments)]
fn append_computer_event_with_payload(
    store: &mut LocalComputerSessionStore,
    session_id: &str,
    user: &UserId,
    workspace: &WorkspaceId,
    surface: SurfaceKind,
    kind: &str,
    status: &str,
    title: &str,
    subtitle: &str,
    payload: Value,
    approval_required: bool,
    artifact_refs: Vec<String>,
) -> Result<(), GatewayError> {
    store
        .append_event(&ComputerEventRecord {
            event_id: format!(
                "event_{}_{}",
                OffsetDateTime::now_utc().unix_timestamp_nanos(),
                kind
            ),
            session_id: session_id.to_string(),
            user_id: user.as_str().to_string(),
            workspace_id: workspace.as_str().to_string(),
            surface,
            kind: kind.to_string(),
            status: status.to_string(),
            title: title.to_string(),
            subtitle: subtitle.to_string(),
            payload,
            artifact_refs,
            approval_required,
            created_at: OffsetDateTime::now_utc(),
        })
        .map_err(GatewayError::local_computer)
}

fn default_computer_surfaces(now: OffsetDateTime) -> Vec<ComputerSurfaceRecord> {
    [
        (SurfaceKind::Browser, "Browser"),
        (SurfaceKind::Shell, "Terminale"),
        (SurfaceKind::Files, "File"),
        (SurfaceKind::Logs, "Log"),
    ]
    .into_iter()
    .map(|(surface, label)| ComputerSurfaceRecord {
        surface,
        label: label.to_string(),
        status: SurfaceStatus::Idle,
        detail: None,
        updated_at: now,
    })
    .collect()
}

fn surface_for_task(task: &TaskRecord) -> SurfaceKind {
    match task.kind.as_str() {
        "local_shell_task" => SurfaceKind::Shell,
        "browser_task" => SurfaceKind::Browser,
        kind if kind.starts_with("capability.browser.") => SurfaceKind::Browser,
        _ => SurfaceKind::Logs,
    }
}

fn browser_automation_dir() -> PathBuf {
    if let Ok(path) = env::var("HOMUN_BROWSER_AUTOMATION_DIR") {
        return PathBuf::from(path);
    }
    FsPath::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../runtimes/browser-automation")
        .components()
        .collect()
}

/// Phase-1 default for the browser surface: HEADLESS.
///
/// Previously "0" (visible), which opened a real OS window that grabbed focus —
/// the behavior users dislike. Headless-by-default means the automated browser
/// runs invisibly; the user watches it *inside the chat* (the live frame view),
/// not as a window that takes over the desktop. This does NOT lose capability:
/// the sidecar's `restartAssistantVisible` self-heal still recovers the rare
/// site that genuinely fails headless, so it's "invisible by default, a window
/// only as a last resort" rather than "a window always". Override per install
/// with `HOMUN_BROWSER_HEADLESS=0`.
fn default_browser_headless_value() -> &'static str {
    "1"
}

fn browser_headless_env_value() -> String {
    env::var("HOMUN_BROWSER_HEADLESS")
        .unwrap_or_else(|_| default_browser_headless_value().to_string())
}

/// Is the contained-computer CDP responding? `/json/version` with a short timeout. Returns
/// true when there's no contained CDP (host-browser mode → nothing to heal). The self-heal
/// gate before connecting the browser sidecar.
async fn browser_cdp_ok(state: &AppState) -> bool {
    let Some(endpoint) = contained_computer_cdp_endpoint() else {
        return true;
    };
    state
        .http
        .get(format!("{}/json/version", endpoint.trim_end_matches('/')))
        .timeout(std::time::Duration::from_millis(1500))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Self-heal a wedged browser: if the contained-computer CDP doesn't answer (Chrome
/// alive-but-stuck, or the container died), recycle the container (`docker rm -f`) and
/// recreate it, then wait for CDP to come back. No-op (fast) when already healthy.
async fn ensure_browser_cdp_healthy(state: &AppState) -> bool {
    if browser_cdp_ok(state).await {
        return true;
    }
    let _ = tokio::task::spawn_blocking(|| {
        crate::sandbox::recycle_container();
        let _ = crate::sandbox::ensure_contained_computer();
    })
    .await;
    // Poll for Chrome to relaunch + bind CDP (cold container start).
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if browser_cdp_ok(state).await {
            return true;
        }
    }
    false
}

/// Direct reachability probe of the contained browser's CDP. Unlike `browser_cdp_ok` (which
/// short-circuits to `true` when no endpoint resolves — its "we're in host mode" answer), this
/// always hits the wire, so the browse gate can tell "sandbox genuinely down" from "host mode".
async fn contained_cdp_reachable(state: &AppState) -> bool {
    let endpoint =
        contained_computer_cdp_endpoint().unwrap_or_else(|| "http://127.0.0.1:9222".to_string());
    state
        .http
        .get(format!("{}/json/version", endpoint.trim_end_matches('/')))
        .timeout(std::time::Duration::from_millis(1500))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// How long the browse gate waits for the contained computer to come up (1s polls) before it
/// falls back to the host browser. Sized for a COLD Docker Desktop + container start.
const CONTAINED_BROWSER_START_POLLS: u32 = 45;

/// Browse-gate policy (user's rule): PREFER the sandbox. If the contained browser's CDP isn't up,
/// actively try to START the contained computer (opens Docker if closed) and wait; only after a
/// real attempt + timeout fall through to the on-host browser — a visible, last-resort degradation,
/// never the silent immediate escape the old code did. Returns true when the sandbox CDP is ready
/// (so `contained_computer_cdp_endpoint()` now resolves and the sidecar attaches via connectOverCDP);
/// false means the caller proceeds and the sidecar launches the host browser as the fallback.
async fn ensure_contained_browser_or_host_fallback(state: &AppState, tx: &StreamSink) -> bool {
    if contained_cdp_reachable(state).await {
        return true;
    }
    let _ = emit_stream_event(
        tx,
        GenerateStreamEvent::Delta {
            text: "‹‹ACT››🖥️ Avvio il computer isolato (browser nel sandbox)…‹‹/ACT››".to_string(),
        },
    )
    .await;
    match tokio::task::spawn_blocking(crate::sandbox::ensure_contained_computer).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::warn!("sandbox: contained-computer bootstrap failed: {e}"),
        Err(e) => tracing::warn!("sandbox: contained-computer bootstrap task failed: {e}"),
    }
    // Cold Docker + container start can take a while; poll up to the timeout the user asked for.
    for _ in 0..CONTAINED_BROWSER_START_POLLS {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if contained_cdp_reachable(state).await {
            return true;
        }
    }
    // Genuine timeout: fall back to the host browser, but SURFACE it (the user was alarmed by the
    // silent escape) instead of quietly leaving the sandbox.
    let _ = emit_stream_event(
        tx,
        GenerateStreamEvent::Delta {
            text: "‹‹ACT››⚠️ Il computer isolato non è partito: uso il browser locale come fallback.‹‹/ACT››".to_string(),
        },
    )
    .await;
    false
}

/// UNCONDITIONAL recycle of the contained computer, for the CDP WEDGE: Chrome's HTTP
/// `/json/version` still answers (so `browser_cdp_ok` returns true and
/// `ensure_browser_cdp_healthy` is a no-op) yet `connectOverCDP` hangs on stale targets.
/// Throttled (once per window) so a retry loop can't thrash `docker rm -f`. Returns true
/// if CDP came back. Mirrors the drive's shared-path self-heal for motore #1's chat path.
async fn force_recycle_contained_computer(state: &AppState) -> bool {
    if !browser_recycle_throttle_ok() {
        return false;
    }
    let _ = tokio::task::spawn_blocking(|| {
        crate::sandbox::recycle_container();
        let _ = crate::sandbox::ensure_contained_computer();
    })
    .await;
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
        if browser_cdp_ok(state).await {
            return true;
        }
    }
    false
}

#[derive(Debug, Serialize)]
struct CloseAllBrowsersResponse {
    closed_sessions: usize,
    closed_tabs: usize,
}

/// Close every per-thread browser session AND any lingering page in the contained
/// browser. Exposed in Settings as "Chiudi tutti i browser".
async fn close_all_browsers(State(state): State<AppState>) -> Json<CloseAllBrowsersResponse> {
    let sessions: Vec<ThreadBrowserSession> = state
        .browser_thread_sessions
        .lock()
        .map(|mut map| map.drain().map(|(_, session)| session).collect())
        .unwrap_or_default();
    let closed_sessions = sessions.len();
    let _ = tokio::task::spawn_blocking(move || {
        for session in sessions {
            let _ = session
                .client
                .call(BrowserMethod::Stop, serde_json::json!({}));
        }
    })
    .await;

    let mut closed_tabs = 0usize;
    if let Some(endpoint) = contained_computer_cdp_endpoint() {
        let base = endpoint.trim_end_matches('/').to_string();
        if let Ok(response) = state
            .http
            .get(format!("{base}/json"))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
            && let Ok(targets) = response.json::<Vec<serde_json::Value>>().await
        {
            for target in targets {
                if target.get("type").and_then(Value::as_str) != Some("page") {
                    continue;
                }
                let Some(id) = target.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let closed = state
                    .http
                    .get(format!("{base}/json/close/{id}"))
                    .timeout(std::time::Duration::from_secs(2))
                    .send()
                    .await
                    .map(|response| response.status().is_success())
                    .unwrap_or(false);
                if closed {
                    closed_tabs += 1;
                }
            }
        }
    }

    Json(CloseAllBrowsersResponse {
        closed_sessions,
        closed_tabs,
    })
}

/// Env for the browser sidecar, shared by every spawn site so contained-computer
/// mode can never be wired into one path and missed in another. In contained
/// mode we add the CDP endpoint of the in-container real browser; the sidecar
/// then attaches via connectOverCDP instead of launching a host Chromium.
fn browser_sidecar_env(state: &AppState, task: &TaskRecord) -> Vec<(String, String)> {
    browser_sidecar_env_with_headless(browser_headless_env_value_for_task(state, task))
}

/// Sidecar env for a CHAT-driven browser session (granular tools): same env as the
/// task path (artifact root, CDP endpoint, isolated-context opt-in, allow-private-
/// network via the sidecar default) but WITHOUT a TaskRecord — there is no task to
/// derive visibility from, so the global headless default is used.
fn browser_sidecar_env_for_chat() -> Vec<(String, String)> {
    browser_sidecar_env_with_headless(browser_headless_env_value())
}

/// Shared sidecar env builder. PRESERVE every var here when adding new spawn
/// callers — only the headless value differs between task and chat sessions.
fn browser_sidecar_env_with_headless(headless: String) -> Vec<(String, String)> {
    let artifact_root = env::temp_dir().join("local-first-browser-artifacts");
    let mut env = vec![
        ("BROWSER_AUTOMATION_HEADLESS".to_string(), headless),
        (
            "BROWSER_AUTOMATION_ARTIFACT_ROOT".to_string(),
            artifact_root.display().to_string(),
        ),
    ];
    // Where a PERSISTENT assistant profile would live (under the data dir, not tmp).
    // Persistence is OPT-IN (BROWSER_AUTOMATION_PERSIST_PROFILE=1): by default the
    // runtime ignores this and uses an ephemeral per-run profile, so anonymous
    // searches never inherit a once-flagged "bot" fingerprint (the flights/trains
    // block). Set it for authenticated flows where a returning logged-in identity
    // helps. Harmless when unset.
    if let Ok(dir) = gateway_data_dir() {
        env.push((
            "BROWSER_AUTOMATION_PROFILE_ROOT".to_string(),
            dir.join("browser-automation").display().to_string(),
        ));
    }
    if let Some(endpoint) = contained_computer_cdp_endpoint() {
        if let Some(epoch) = contained_browser_epoch(&endpoint) {
            env.push(("BROWSER_AUTOMATION_BROWSER_EPOCH".to_string(), epoch));
        }
        env.push(("BROWSER_AUTOMATION_USER_CDP_ENDPOINT".to_string(), endpoint));
        // Isolated context is OFF by default: measured that a fresh ("cold")
        // context regresses reliability (no cookies -> consent/geo walls ->
        // the worker wanders and burns iterations). The default warm shared
        // context is far more reliable. Isolation is opt-in per worker via
        // HOMUN_BROWSER_ISOLATED_CONTEXT=1 (checked below) — see parallel path.
        if env::var("HOMUN_BROWSER_ISOLATED_CONTEXT").as_deref() == Ok("1") {
            env.push((
                "BROWSER_AUTOMATION_ISOLATED_CONTEXT".to_string(),
                "1".to_string(),
            ));
        }
    }
    env
}

fn contained_browser_epoch(endpoint: &str) -> Option<String> {
    if let Some(explicit) = env::var("HOMUN_CONTAINED_COMPUTER_EPOCH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return Some(explicit);
    }
    let version_url = format!("{}/json/version", endpoint.trim_end_matches('/'));
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(750))
        .build()
        .ok()?
        .get(version_url)
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .json::<serde_json::Value>()
        .ok()?;
    let browser_socket = response.get("webSocketDebuggerUrl")?.as_str()?;
    Some(format!(
        "cdp-{:x}",
        Sha256::digest(browser_socket.as_bytes())
    ))
}

fn browser_headless_env_value_for_task(state: &AppState, task: &TaskRecord) -> String {
    let fallback = browser_headless_env_value();
    browser_visibility_for_task(state, task).headless_env_value(&fallback)
}

fn browser_visibility_for_task(state: &AppState, task: &TaskRecord) -> BrowserVisibilityMode {
    if !task_uses_browser(task) {
        return BrowserVisibilityMode::Auto;
    }
    let latest_checkpoint_visibility = task
        .checkpoint_json
        .as_ref()
        .and_then(|checkpoint| checkpoint.get("browser_visibility"))
        .and_then(Value::as_str)
        .map(|value| parse_browser_visibility(Some(value)))
        .filter(|visibility| *visibility != BrowserVisibilityMode::Auto);
    if let Some(visibility) = latest_checkpoint_visibility {
        return visibility;
    }

    let Ok(policy_store) = lock_browser_url_policies(state) else {
        return BrowserVisibilityMode::Auto;
    };
    for target in browser_targets_for_goal(&task_effective_goal(task)) {
        let Ok(Some(rule)) = policy_store.rule_for_url(
            gateway_user_id().as_str(),
            gateway_workspace_id().as_str(),
            &target.url,
            "navigate",
        ) else {
            continue;
        };
        if rule.visibility != BrowserVisibilityMode::Auto {
            return rule.visibility;
        }
    }
    BrowserVisibilityMode::Auto
}

fn task_uses_browser(task: &TaskRecord) -> bool {
    task.kind == "browser_task"
        || task.kind.starts_with("capability.browser.")
        || task
            .resource_requirements
            .iter()
            .any(|resource| resource.class == ResourceClass::BrowserSession)
}

fn parse_approval_scope(value: Option<&str>) -> BrowserUrlApprovalScope {
    match value {
        Some("always") => BrowserUrlApprovalScope::Always,
        _ => BrowserUrlApprovalScope::Once,
    }
}

fn parse_browser_visibility(value: Option<&str>) -> BrowserVisibilityMode {
    match value {
        Some("headless") => BrowserVisibilityMode::Headless,
        Some("visible") => BrowserVisibilityMode::Visible,
        _ => BrowserVisibilityMode::Auto,
    }
}

fn approval_scope_label(value: BrowserUrlApprovalScope) -> &'static str {
    match value {
        BrowserUrlApprovalScope::Once => "once",
        BrowserUrlApprovalScope::Always => "always",
    }
}

fn browser_visibility_label(value: BrowserVisibilityMode) -> &'static str {
    match value {
        BrowserVisibilityMode::Auto => "auto",
        BrowserVisibilityMode::Headless => "headless",
        BrowserVisibilityMode::Visible => "visible",
    }
}

#[derive(Debug, Clone)]
struct BrowserTarget {
    #[allow(dead_code)]
    label: String,
    url: String,
}

/// ONE general entry for every goal: a web search of the goal. The model-driven
/// observe-act loop navigates from there. No keyword/domain/transport routing —
/// the model understands what the goal needs and decides where to go.
fn browser_targets_for_goal(goal: &str) -> Vec<BrowserTarget> {
    vec![BrowserTarget {
        label: "Web search".to_string(),
        url: browser_url_for_goal(goal),
    }]
}

fn browser_url_for_goal(goal: &str) -> String {
    // Uniform entry for EVERY goal: a web search of the goal verbatim. No
    // keyword/site special-casing — the observe-act loop navigates from the
    // results to wherever the goal actually leads.
    format!("https://duckduckgo.com/?q={}", url_encode(goal))
}

fn url_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            b' ' => encoded.push('+'),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod gateway_main_tests;
