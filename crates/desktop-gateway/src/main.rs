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
mod gateway_capability_registry;
mod gateway_capability_routing;
mod gateway_channels;
mod gateway_chat_branches;
mod gateway_chat_markers;
mod gateway_chat_memory;
mod gateway_chat_streams;
mod gateway_chat_tasks;
mod gateway_chat_threads;
mod gateway_chat_utility_routes;
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
mod gateway_memory_prompt_context;
mod gateway_memory_publications;
mod gateway_memory_query_embeddings;
mod gateway_memory_recall_service;
mod gateway_memory_recall_tool;
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
mod gateway_proactive_threads;
mod gateway_proactivity;
mod gateway_proactivity_routes;
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
mod gateway_store_integrity;
mod gateway_system_status;
mod gateway_tags;
mod gateway_task_executor;
mod gateway_task_executor_config;
mod gateway_task_maintenance;
mod gateway_template_catalog;
mod gateway_text_safety;
mod gateway_thread_episodes;
mod gateway_thread_files;
mod gateway_tool_budget;
mod gateway_tool_execution;
mod gateway_tool_timeouts;
mod gateway_transcription;
mod gateway_turn_broker;
mod gateway_turn_recovery;
mod gateway_update_routes;
mod gateway_usage_routes;
mod gateway_user_preferences;
mod gateway_vault_key;
mod gateway_vault_routes;
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
pub(crate) use attachments::append_thread_attachment_context;
pub(crate) use gateway_actionable_source::*;
pub(crate) use gateway_artifacts::*;
pub(crate) use gateway_automation_routes::*;
pub(crate) use gateway_brain_materialization::*;
pub(crate) use gateway_brain_runtime::*;
pub(crate) use gateway_browser_runtime::*;
pub(crate) use gateway_chat_streams::*;
pub(crate) use gateway_composio_execution::*;
pub(crate) use gateway_composio_routes::*;
pub(crate) use gateway_connector_errors::*;
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
    BriefingMemoryItem, MemoryInjectionPolicy, format_memory_block,
    gather_profile_memory_for_prompt, gather_profile_memory_with_options,
    gather_profile_memory_with_provenance,
};
use gateway_memory_briefing::{
    CHAT_MEMORY_BUDGET_CHARS, format_memory_block_with_provenance,
    gather_profile_memory_for_intent_with_provenance, memory_briefing_source_fingerprint,
    memory_injection_policy, memory_intent_allows_recall, memory_intent_for_execution,
    revalidated_cached_briefing,
};
#[cfg(test)]
use gateway_memory_dedup::normalize_for_dedup;
use gateway_memory_dedup::{
    DEDUP_COSINE, DEDUP_JACCARD, cosine, dedup_tokens, forgotten_token_sets, is_semantic_duplicate,
    is_suppressed, jaccard,
};
pub(crate) use gateway_memory_prompt_context::decisions_for_path;
use gateway_memory_prompt_context::{
    artifact_provenance_context_for_query, relevant_code_components_for_prompt,
    workflow_status_context_for_query,
};
#[cfg(test)]
use gateway_memory_query_embeddings::memory_recall_timing_trace_line;
pub(crate) use gateway_memory_query_embeddings::{
    MemoryRecallTiming, embed_model, embed_query_for_memory_recall, embed_text,
};
pub(crate) use gateway_memory_recall_tool::{
    RecallOutcome, recall_memory, recall_stream_payload_from_outcome,
};
pub(crate) use gateway_memory_ui_routes::{
    export_user_data, memory_dashboard, memory_export, memory_items,
};
pub(crate) use gateway_model_routes::*;
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
    ActionableCard, RemoteApprovalIntent, actionable_cards_from_raw_text,
    append_remote_approval_thread_status, approval_continuation_visible_text,
    approval_progress_reply, cancel_pending_remote_approval, create_pending_approval,
    parse_approval_reply, pending_approval_exists, remote_approval_event_part,
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
pub(crate) use gateway_system_status::*;
#[cfg(test)]
pub(crate) use gateway_text_safety::task_goal_summary;
pub(crate) use gateway_text_safety::{
    redact_sensitive_text, strip_terminal_control_sequences, truncate_chars,
};
pub(crate) use gateway_user_preferences::*;
pub(crate) use gateway_vault_routes::*;
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
    browse_subagent_nav_cap, browser_act_error_hint, browser_act_tool_schema,
    browser_action_execution_fields_are_schema_legal, browser_action_outcome_hint,
    browser_dialog_tool_schema, browser_done_tool_schema, browser_navigate_failure_hint,
    browser_navigate_tool_schema, browser_rehydrate_tool_schema, browser_screenshot_tool_schema,
    browser_snapshot_tool_schema, browser_tabs_tool_schema, chat_browser_budget,
    chat_browser_max_rounds, chat_browser_nav_cap, chat_manager_browser_budget,
    computer_action_tool_schema, computer_get_state_tool_schema, computer_list_apps_tool_schema,
    initial_manager_tool_schemas_for_test, is_stale_ref_error, manager_browser_guidance,
    normalize_browser_action_bundle, parse_browser_done_payload, security_scan_block_reasons,
    stale_ref_recovery_message, use_computer_tool_schema,
};
#[cfg(test)]
pub(crate) use gateway_browser_tools::{
    BROWSER_ACT_SCHEMA_KINDS, bounded_browse_subagent_nav_cap, browse_tool_schema,
    manager_browser_max_elapsed_ms,
};
pub(crate) use gateway_capability_registry::{
    CapabilityCorpusMaterializationInput, CapabilityEntry, CapabilitySnapshotResponse,
    CapabilitySource, auto_retrieve_composio, bm25_rank, cap_tokenize,
    capability_discovery_trace_line, capability_snapshot_response, capability_source_label,
    find_capability_tool_schema, materialize_capability_corpus, open_seeded_capability_registry,
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
use gateway_memory_recall_service::{install_memory_service_if_enabled, recall_pack_on_facade};
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
use gateway_memory_turn_context::{
    memory_scope_for_turn, objective_block_for_workspace, project_brief_block,
    project_objective_block, recent_work_block, scope_from_active_workspace,
};
use gateway_memory_wiki::{
    active_open_loop_record, rebuild_decisions_wiki, rebuild_profile_wiki, rebuild_project_brief,
    rebuild_status_wiki, wiki_is_edited,
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
    booking_assumption_choice_instruction, browser_open_research_discovery_instruction,
};
pub(crate) use gateway_prompt_packets::*;
#[cfg(test)]
pub(crate) use gateway_recall_context::format_recall_entry;
use gateway_recall_context::{
    gather_open_loops, memory_access_status_instruction, memory_read_effects_from_recall_payload,
    merge_automatic_recall_payload, recall_stream_payload_from_hits,
    recall_stream_payload_from_pack, sanitize_dedup_key, seed_loop_memory_reads,
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
    IntegrityRepairApplyRequest, IntegrityRepairApplyResponse, IntegrityRepairEstimate,
    IntegrityRepairPreviewRequest, IntegrityRepairPreviewResponse, LinkedMemoryRepairApplyRequest,
    LinkedMemoryRepairApplyResponse, canonical_integrity_actions, gateway_approval_token,
    gateway_audit_checksum, inspect_registered_graph,
};
use local_first_desktop_gateway::linked_memory_repair::{
    LinkedMemoryRepairPreview, LinkedRepairError, LinkedRepairFailureInjection,
    apply_linked_memory_repair, preview_linked_memory_repair,
};
use local_first_desktop_gateway::project_graph_commit::{
    ProjectGraphCommitError, stage_project_graph_build,
};
use local_first_desktop_gateway::{
    AttachmentInput, BuildPromptRequest, ChatContextMessage, ChatContextRole,
    ChatGenerateStreamRequest, ChatMessage, ChatMessagesSnapshot, ChatThread, ChatThreadSnapshot,
    EnqueueTurnRequest, RoutingBinding, SetThreadPinnedRequest, build_chat_runtime_prompt,
    compact_thread_title, strip_display_markers,
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
    ExtractedEntity, ExtractedRelation, MemoryAccessRequest, MemoryCollectionKey,
    MemoryCreateRequest, MemoryEntity, MemoryError, MemoryFacade, MemoryIntegrityRepairRequest,
    MemoryLifecycleRequest, MemoryRecallService, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryRelation, MemoryScope, MemorySearchRequest, MemoryStatus, MemoryUpdatePatch,
    MemoryWikiProjection, PERSONAL_WORKSPACE, PrivacyDomain, ProjectGraphImportReport, RecallHit,
    RecallPack, SQLiteMemoryStore, UserId as MemoryUserId, WikiFileStore, WikiPage,
    WorkspaceId as MemoryWorkspaceId, briefing_cache, memory_record_revision, prompt_fingerprint,
};
use local_first_orchestrator::{
    ExecutionPlan, OrchestratorBrain, OrchestratorRequest, OrchestratorRoute, PlanStep,
    PlanStepKind, StepExecutionPolicy,
};
use local_first_secrets::{
    DevelopmentSecretKeyProvider, EncryptedFileSecretStore, SecretMaterial, SecretRef, SecretStore,
};
use local_first_subagents::{
    GenerateJsonRequest, GenerateJsonResponse, GenerateStreamEvent, SubagentTaskExecutor,
    TokenMetrics,
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

        let runs = get_agent_runs(Path("turn-api".to_string()), State(state.clone()))
            .await
            .unwrap()
            .0;
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "run-api");

        let events = get_agent_run_events(
            Path("run-api".to_string()),
            State(state.clone()),
            Query(TurnSinceQuery { since: Some(1) }),
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
            Query(TurnSinceQuery { since: Some(-1) }),
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
    // Initialize structured logging. RUST_LOG controls verbosity per module:
    //   RUST_LOG=warn                       → only warnings/errors (default-ish)
    //   RUST_LOG=homun_desktop_gateway=info → gateway info+ (broker/turn/chat lifecycle)
    //   RUST_LOG=homun_desktop_gateway=debug → verbose (per-event broker logging)
    //   RUST_LOG=trace                      → everything (noisy, includes deps)
    // Default when RUST_LOG is unset: warn (so existing eprintln! noise is reduced
    // and the user sees real problems). Existing eprintln!/println! calls still
    // print (they bypass tracing) but the structured tracing events are filterable.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_target(false)
        .try_init();
    // P0 observability: leave a trail for every panic, even when the shell
    // isn't capturing stdio. Fall back to the OS temp dir if HOME is unusable.
    panic_log::install(gateway_logs_dir().unwrap_or_else(|_| std::env::temp_dir()));

    // SECURITY (data at rest): make everything this process writes owner-only.
    // The personal stores (memory.sqlite, desktop-gateway.sqlite, the WhatsApp
    // session, …) are PLAINTEXT SQLite — 0644 would expose the user's memory,
    // contacts and messages to any other local user. umask 0077 makes new files
    // born 0600, including the SQLite WAL/SHM that SQLite creates at runtime.
    #[cfg(unix)]
    // SAFETY: libc::umask has no preconditions; called once before any file is created.
    unsafe {
        libc::umask(0o077 as libc::mode_t);
    }

    // Move any pre-rename data dir to the new ~/.homun location before anything
    // opens it (the SQLite stores are created immediately below).
    gateway_legacy_data::migrate_legacy_data_dir();

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
    let usage_path = gateway_database_path()?;
    let usage_store = usage_store::UsageStore::open(&usage_path).map_err(std::io::Error::other)?;
    usage_store
        .abort_orphaned_attempts(i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX))
        .map_err(std::io::Error::other)?;
    usage_store
        .rebuild_daily_rollups()
        .map_err(std::io::Error::other)?;
    let buffered_usage_recorder: Arc<dyn local_first_inference_usage::UsageRecorder> = Arc::new(
        usage_store::BufferedUsageRecorder::start(&usage_path, 4_096)
            .map_err(std::io::Error::other)?,
    );
    let usage_pricing = Arc::new(std::sync::RwLock::new(build_usage_pricing_snapshot(
        &usage_store,
    )));
    let usage_recorder: Arc<dyn local_first_inference_usage::UsageRecorder> =
        Arc::new(usage_pricing::CostEnrichingUsageRecorder::new(
            buffered_usage_recorder,
            usage_pricing.clone(),
        ));
    let _ = usage_recorder_registry().set(usage_recorder.clone());
    let mut state = AppState {
        http: gateway_http_client::build_gateway_http_client(),
        usage_store: Arc::new(Mutex::new(usage_store)),
        usage_recorder,
        usage_pricing,
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

/// Auto-confirm policy (M2): only durable, high-confidence knowledge enters memory
/// without asking. The ceiling is `Private` — NOT `Internal` — on purpose: the
/// extractor tags ordinary personal facts (possessions, family, city) as `private`
/// by its own rules, so an `Internal` cap froze EVERY personal fact at `candidate`,
/// invisible to the always-on profile (which is confirmed-only). A personal
/// assistant must know what you own / who's in your life without re-asking, so
/// `private` auto-confirms. Only `Confidential`/`Secret` (real PII — codice fiscale,
/// health docs, addresses) stays a candidate for the user to confirm explicitly.
#[cfg(test)]
fn is_auto_confirmable(
    memory_type: &str,
    sensitivity: MemoryDataSensitivity,
    confidence: f64,
) -> bool {
    // Decisions are factual records of choices made during work (low privacy risk),
    // so they auto-confirm like facts/preferences when confident + non-sensitive.
    matches!(
        memory_type,
        "preference" | "fact" | "decision" | "goal" | "open_loop"
    ) && sensitivity <= MemoryDataSensitivity::Private
        && confidence >= 0.8
}

/// ADR 0022 — Tappa 1/4: apprendimento post-turno. Di default (service ON)
/// instrada via `MemoryRecallService::learn`; anche nel
/// path OFF usa le STESSE fn del crate (3 fasi: prepare_learn_prompt →
/// LlmClient.chat → persist_learn_extraction) con capability client costruiti
/// al volo — così `learn_from_exchange` non è più duplicata nel gateway.
#[allow(clippy::too_many_arguments)]
fn learn_via_service_or_inline(
    state: &AppState,
    user_message: &str,
    assistant_message: &str,
    actions: &str,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    speaker: Option<&str>,
    prev_assistant: Option<&str>,
    reuse_envelope: local_first_memory::MemoryReuseEnvelope,
) -> local_first_memory::BoxFuture<'static, ()> {
    if let Some(service) = state.memory_service.clone() {
        let scope = scope_from_active_workspace();
        let exchange = Exchange {
            user_message: user_message.to_string(),
            assistant_message: assistant_message.to_string(),
            actions: actions.to_string(),
            thread_id: thread_id.map(str::to_string),
            turn_id: turn_id.map(str::to_string),
            speaker: speaker.map(str::to_string),
            prev_assistant: prev_assistant.map(str::to_string),
            reuse_envelope,
        };
        Box::pin(async move { service.learn(&exchange, &scope).await })
    } else {
        // Path OFF: stessa orchestrazione del crate, capability client al volo.
        let state = state.clone();
        let user_message = user_message.to_string();
        let assistant_message = assistant_message.to_string();
        let actions = actions.to_string();
        let thread_id = thread_id.map(str::to_string);
        let turn_id = turn_id.map(str::to_string);
        let speaker = speaker.map(str::to_string);
        let prev_assistant = prev_assistant.map(str::to_string);
        let exchange = Exchange {
            user_message,
            assistant_message,
            actions,
            thread_id: thread_id.clone(),
            turn_id,
            speaker,
            prev_assistant,
            reuse_envelope,
        };
        Box::pin(async move {
            let user = gateway_memory_user_id();
            let active = gateway_memory_workspace_id();
            let project_name = if active.as_str() != PERSONAL_WORKSPACE {
                load_workspaces_file()
                    .workspaces
                    .into_iter()
                    .find(|w| w.id.as_str() == active.as_str())
                    .map(|w| w.name)
            } else {
                None
            };
            let llm: std::sync::Arc<dyn local_first_memory::LlmClient> =
                gateway_llm_client(state.http.clone());
            // Fase 1 (lock): prompt.
            let prompt = {
                let facade = memory_facade(&state);
                local_first_memory::prepare_learn_prompt(
                    facade,
                    &user,
                    &active,
                    &exchange,
                    project_name.as_deref(),
                )
            };
            let Some((system, user_content)) = prompt else {
                return;
            };
            // Fase 2 (off-lock): LLM.
            let Some(content) = llm.chat(&system, &user_content).await else {
                return;
            };
            // Fase 3 (lock): persist + hooks.
            let facade = memory_facade(&state);
            let hooks = local_first_memory::LearnHooks {
                persist_graph: Some(
                    &|facade, user, workspace, entities, relations, project_ws| {
                        persist_graph(facade, user, workspace, entities, relations, project_ws);
                    },
                ),
                store_episode: Some(&|facade, user, thread_id, episode, active| {
                    store_episode(facade, user, thread_id, episode, active);
                }),
                backfill_embeddings: None,
            };
            local_first_memory::persist_learn_extraction(
                facade, &user, &active, &content, &exchange, hooks,
            );
        })
    }
}
/// Memory consolidation ("reflection"): review a scope's durable memories, MERGE the
/// fragments that say the same thing, and PRUNE noise (transient/trivial/irrelevant or
/// redundant). Conservative — when in doubt the model keeps. Returns (merged, dropped).
///
/// ADR 0022 (Tappa 4, F3): orchestrazione migrata nel crate via 3 fasi Send-safe
/// (`consolidate_prepare` → LLM curatore off-lock → `consolidate_apply`). Il
/// `MutexGuard` non attraversa l'await della LLM call. Corpo spostato fedelmente.
async fn consolidate_scope(
    state: &AppState,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) -> (usize, usize) {
    // is_edited callback: il crate non legge il FS gateway (pattern = hooks).
    let is_edited = |ws: &MemoryWorkspaceId, path: &str| wiki_is_edited(ws, path);
    // Fase 1 (lock): dedup open-loop + pre-pass deterministico + listing.
    let (merged, prepared) = {
        let facade = memory_facade(state);
        local_first_memory::consolidate_prepare(facade, user, workspace, &is_edited)
    };
    let Some(input) = prepared else {
        // <3 memorie sopravvissute (o early-exit): wiki già ricostruite nella prepare.
        return (merged, 0);
    };
    // Fase 2 (off-lock): LLM curatore via client gateway throwaway, poi parse
    // JSON resiliente (strip_json_fences è nel crate).
    let llm: std::sync::Arc<dyn local_first_memory::LlmClient> =
        gateway_llm_client(state.http.clone());
    let content = llm
        .chat(
            local_first_memory::CURATOR_SYSTEM,
            &format!("MEMORIE ATTUALI:\n{}", input.listing),
        )
        .await;
    let root = content.and_then(|c| {
        serde_json::from_str::<serde_json::Value>(local_first_memory::strip_json_fences(&c)).ok()
    });
    let Some(root) = root else {
        // LLM curator unavailable: keep the deterministic merges already applied,
        // rebuild the wiki pages.
        {
            let facade = memory_facade(state);
            local_first_memory::rebuild_all_wiki(facade, user, workspace, &is_edited);
        }
        return (merged, 0);
    };
    // Fase 3 (lock re-acquisito): applica merge/drop + ricostruisce wiki.
    let facade = memory_facade(state);
    local_first_memory::consolidate_apply(
        facade,
        user,
        workspace,
        &root,
        &input.mems,
        merged,
        &is_edited,
        &|text| redact_sensitive_text(text),
    )
}

fn tombstone_automation_memory_records(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    automation_id: &str,
) -> Result<usize, String> {
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "automation".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "automation_removed".to_string(),
    };
    let mut deleted = 0;
    for memory in facade
        .list_memories_for_ui(user, workspace)
        .map_err(|error| error.to_string())?
    {
        let matches_id = memory
            .metadata
            .get("automation_id")
            .and_then(|value| value.as_str())
            == Some(automation_id);
        if !matches_id {
            continue;
        }
        facade
            .delete_memory(&lifecycle, &memory.reference, "automation deleted")
            .map_err(|error| error.to_string())?;
        deleted += 1;
    }
    Ok(deleted)
}

fn record_subagent_task_step_outcome(
    state: &AppState,
    task: &TaskRecord,
    outcome: &TaskExecutionPresentation,
) {
    let thread_id = lock_store(state)
        .ok()
        .and_then(|store| {
            store
                .thread_by_task_id(task.task_id.as_str())
                .ok()
                .flatten()
        })
        .map(|thread| thread.thread_id);
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "runtime-plan".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "subagent_plan_step_verified".to_string(),
    };
    if record_subagent_task_step_outcome_memory(
        facade,
        &user,
        &workspace,
        &lifecycle,
        thread_id.as_deref(),
        task,
        outcome,
    )
    .is_ok()
    {
        rebuild_status_wiki(facade, &user, &workspace);
    }
}

/// system prompt so the model answers "why did we…" from memory WITHOUT having to call
/// recall_memory itself — and doesn't claim "I have nothing in memory" when it does.
/// A memory candidate for hybrid ranking: its rank in the lexical (FTS) and/or
/// semantic (dense) passes, plus importance (0..1) and age. Either rank may be absent
/// (matched by only one pass).
#[cfg(test)]
struct MemoryCandidate {
    fts_rank: Option<usize>,
    dense_rank: Option<usize>,
    importance: f32,
    age_days: f32,
}

/// Combined relevance score: RRF-fuse the two retrieval ranks (a memory strong in BOTH
/// lexical AND semantic is rewarded, unlike a plain concat), then add MILD boosts for
/// importance and recency so relevance still leads but a crucial/fresh memory edges out
/// an equally-relevant trivial/stale one. Weights are tuned so importance/recency act as
/// refinements (~one RRF position), not overrides.
#[cfg(test)]
fn hybrid_memory_score(c: &MemoryCandidate) -> f32 {
    const K: f32 = 60.0;
    let rrf = c.fts_rank.map(|r| 1.0 / (K + r as f32)).unwrap_or(0.0)
        + c.dense_rank.map(|r| 1.0 / (K + r as f32)).unwrap_or(0.0);
    let importance_boost = 0.012 * c.importance.clamp(0.0, 1.0);
    let recency_boost = 0.008 * (-(c.age_days.max(0.0) / 30.0)).exp();
    rrf + importance_boost + recency_boost
}

/// Age of a memory in days from its `created_at` (`unix:<secs>` or `<secs>`).
#[cfg(test)]
fn memory_age_days(created_at: &str, now_secs: i64) -> f32 {
    let s = created_at.strip_prefix("unix:").unwrap_or(created_at);
    let secs: i64 = s
        .split('.')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(now_secs);
    ((now_secs - secs).max(0) as f32) / 86_400.0
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
    let applies_new_input = local_first_desktop_gateway::checkpoint_request_applies_new_input(
        request.agent_checkpoint.as_ref(),
        request.checkpoint_input.as_ref(),
    );
    let recovery_checkpoint = request
        .agent_checkpoint
        .clone()
        .map(serde_json::from_value::<local_first_engine::LoopCheckpoint>)
        .transpose()
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "agent_checkpoint_invalid",
            message: format!("Agent checkpoint schema is invalid: {error}"),
        })?;
    if let Some(checkpoint) = recovery_checkpoint.as_ref() {
        checkpoint.validate_schema().map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "agent_checkpoint_invalid",
            message: format!("Agent checkpoint schema is invalid: {error}"),
        })?;
    }
    // Turn trace (readable per-turn observability): handle created HERE, at the absolute entry, so a
    // hang in SETUP (memory recall, prompt-build, browser-session) is visible — see engine::turn_trace.
    // The `turn_received` event is the FIRST thing recorded; if no `turn_start` follows, the turn
    // stalled before generation (a setup-hang would otherwise be invisible). Cheap Arc/None handle;
    // no-op when disabled. It's a pure sink — it records what the turn does, never steers it.
    let turn_trace = if turn_trace_enabled() {
        match gateway_logs_dir() {
            Ok(dir) => local_first_engine::turn_trace::TurnTrace::new(
                request.request_id.clone(),
                dir,
                turn_trace_max_bytes(),
            ),
            Err(_) => local_first_engine::turn_trace::TurnTrace::disabled(),
        }
    } else {
        local_first_engine::turn_trace::TurnTrace::disabled()
    };
    turn_trace.record(local_first_engine::turn_trace::TurnEvent::TurnReceived {
        prompt_head: request.prompt.chars().take(200).collect(),
        prompt_len: request.prompt.chars().count(),
        mode: request.mode.as_deref().unwrap_or("agent").to_string(),
        model: model.clone(),
    });
    // Scope MEMORY to THIS conversation's project (profile injection, recall, per-file
    // recall, extractor). Uses a dedicated memory scope — NOT the global active
    // workspace — so Composio's entity and the user's selected workspace are untouched.
    if let Some(tid) = request.thread_id.as_deref() {
        if let Ok(store) = lock_store(state)
            && let Ok(ws) = store.workspace_for_thread(tid)
        {
            set_memory_workspace(&ws);
        }
    } else {
        set_memory_workspace("");
    }
    // Channel turns are bound to a curated contact: persona/tone + isolation
    // perimeter (what memory/tools/info this reply may use). `channel_owner` = the
    // sender is the user themselves (is_self card) → channel gates that protect the
    // user from OTHERS (e.g. the browser click block) don't apply. Lock taken and
    // released inside; never held across the generation.
    let (contact_ctx, channel_owner) = contact_turn_context(state, request.thread_id.as_deref());
    if verbose_debug()
        && request
            .thread_id
            .as_deref()
            .is_some_and(|t| t.starts_with("channel_"))
    {
        eprintln!(
            "channel-turn: thread={} owner={} contact={}",
            request.thread_id.as_deref().unwrap_or("-"),
            channel_owner,
            contact_ctx.as_ref().map(|c| c.name.as_str()).unwrap_or("-"),
        );
    }
    // Real-idle signal (H3): only genuine user work counts — in-app turns and the
    // OWNER writing via a channel. An inbound contact message or Homun's own
    // headless check-in must NOT reset the idle clock.
    {
        let tid = request.thread_id.as_deref();
        let is_channel = tid.is_some_and(|t| t.starts_with("channel_"));
        let is_homun = tid == Some("homun");
        if !is_homun && (!is_channel || channel_owner) {
            note_user_activity();
        }
    }
    // Budget the prompt against the model's REAL context window (catalog `context_window`,
    // auto-filled from `/api/show`, F0.3d) instead of a flat 32k default — so a 128k model
    // keeps its long history and a small local model is clamped to what it can actually read.
    let model_context_window = registry_model_capabilities(&base_url, &model)
        .and_then(|caps| caps.context_length)
        .map(|tokens| usize::try_from(tokens).unwrap_or(usize::MAX));
    let effective_context = match request.thread_id.as_deref() {
        Some(thread_id) => {
            thread_context_for_model(state, thread_id, &[], Some(request.prompt.as_str()))
                .unwrap_or_default()
        }
        None => request.context.clone(),
    };
    let prompt = request
        .checkpoint_input
        .as_ref()
        .map(local_first_desktop_gateway::render_checkpoint_input)
        .unwrap_or_else(|| {
            build_chat_runtime_prompt(&BuildPromptRequest {
                prompt: request.prompt.clone(),
                context: effective_context.clone(),
                max_context_chars: Some(chat_context_budget_chars(model_context_window)),
            })
            .runtime_prompt
        });
    let browser_discovery = browser_open_research_discovery_instruction();
    let booking_choices = booking_assumption_choice_instruction();
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

    let system = format!(
        "You are the local assistant acting as ORCHESTRATOR. Right now {now}: ALWAYS \
use this date/time to resolve temporal requests — do NOT rely on your internal \
knowledge of the date (it is almost always wrong). \"tomorrow\" = the day AFTER this \
date; \"June 10\" = June 10 of the correct year relative to this date; ALWAYS pick a \
time in the FUTURE. For any time slot (dates/times), call the resolve_datetime tool \
FIRST: it returns the correct absolute date to use (e.g. to fill in a form). Do not \
compute dates by hand. You have access to a real browser that YOU drive via granular \
tools (browser_navigate / browser_snapshot / browser_act / browser_rehydrate / browser_screenshot).\n\
\n\
METHOD (applies to any request, not just travel):\n\
1. UNDERSTAND: what the user wants and what the concrete EXPECTED RESULT is.\n\
2. SUCCESS CRITERIA: define explicitly what \"done\" means (which data/fields and how \
many options are needed) and keep it in mind while you work.\n\
3. CLARIFICATIONS: if a truly blocking and ambiguous parameter is missing, ask ONE \
concise question BEFORE searching; otherwise proceed with sensible defaults and \
STATE them (do not block the user over minor details).\n\
4. EXECUTE: when real-time web data or browser actions are needed, you MUST use the \
browser (do not say you have no internet access). Open the source with \
browser_navigate, read the snapshot and proceed ONE micro-action at a time. Keep \
2-3 candidate SOURCES in order of preference and try them in turn: if one is \
blocked/has no data, move to the next. Do not repeat the same search. For FACTUAL or \
statistical data (sports standings/results/schedules, reference figures, public \
timetables) PREFER a login-free, text-rich source (e.g. Wikipedia, an official \
schedule page) over login-walled, store, or marketing pages that return no data. \
{browser_discovery} \
EXTRACT AS YOU GO: the moment a page shows the data you need, COPY the concrete values \
(the actual table rows, names, numbers, dates) into your message text — do NOT defer \
extraction to \"later\" or across another tool call, because the page content is NOT \
retained once you navigate away or advance the plan. Your browsing budget is LIMITED: \
do NOT keep hopping across many sites for the same point. If ONE good static source \
already gives the data, take it and move on; do NOT chase JavaScript-heavy live-score \
or aggregator SPAs (they frequently fail to read) when an encyclopedic/text source \
already answers. Aim to settle each sub-question in 1-2 sources, not 5+.\n\
5. SYNTHESIZE: as soon as you have enough data, STOP using the browser and write the \
final answer to the user. Report the REAL status of each source: call a source \
\"blocked/unreachable\" ONLY if it failed to open or shows an explicit CAPTCHA. If \
you REACHED it but did not complete the search, do NOT say it is blocked or \
unreachable: say you got there but did not finish, show any partial data collected \
and offer to retry. REACHING a page and reading its data IS your verification: if you \
successfully read the data, you MUST report it — NEVER refuse with \"I can't state \
real-time facts without a verified source\" or \"the check was interrupted\" when you \
in fact read the page. Refuse ONLY if you never obtained the data at all. Always \
deliver the concrete data you DID gather rather than a meta-explanation of why you \
can't. CALIBRATED GROUNDING (critical): report as FACT only what you actually READ from \
a source. Anything you INFER, project, or that is NOT YET DETERMINED (results of matches \
not yet played, standings/brackets that depend on pending results) must be clearly \
LABELLED as projected/uncertain or OMITTED — never presented as established fact. It is \
contradictory to write \"live results not verifiable\" and then present a full \
results/bracket table as if confirmed: if you could not verify it, do not assert it. \
Prefer an accurate partial (\"decided so far: …; still open: …\") over a complete-looking \
but fabricated picture. Before sending, sanity-check internal consistency (counts match \
their labels; nothing is both \"already decided\" and \"played later today\").\n\
\n\
TOOLS AND ROUTING: when a request can be satisfied by a tool, USE it at once — do \
NOT reply with empty phrases (\"I'm ready, write to me\", \"what do you want me to \
do?\") nor ask to repeat what was already asked. A targeted clarification question \
(as in step 3 of METHOD) is fine; a non-answer is not.\n\
USER'S COMPUTER FILES AND FOLDERS: if the user wants to see/list/read files or \
folders on their computer — EVEN if they name the folder WITHOUT a path (e.g. \
\"the folders in Project\", \"the files in Documents\") — use `list_directory` / \
`read_text_file` on the most likely path INSIDE the user's home — the home is \
{home} (e.g. {home}/Projects, {home}/Documents) — or write `~/…` which I resolve. \
Do NOT invent a username (e.g. /Users/<random-name>/…): use {home} or `~/`. \
`list_files` / `read_file` are ONLY for code INSIDE the linked project folder \
(relative paths), NOT for the user's filesystem. \
`run_in_sandbox` is a throwaway container that does NOT see the user's computer: \
NEVER use it to inspect files/folders on the Mac. If you have no path hint, ask ONE \
targeted question; if the user is NOT talking about files/folders, do not use \
list_directory.\n\
ATTACHMENTS: files attached in chat arrive ALREADY as ready content (extracted text \
and/or images of the pages) under the \"[Files attached to this conversation]\" \
section. Analyze them from there directly. If the user says \"this file/pdf/\
attachment\" but there is NOTHING in that list, kindly ask to (re)attach it: do NOT \
use list_directory, run_in_sandbox or download links to find or decode it.\n\
AUTOMATIONS: for RECURRING or REACTIVE requests use `create_automation` (it creates \
a rule visible in the Automations section), do not just reply. \"every Friday / every \
morning / every Monday …\" → trigger_type=schedule with the recurrence. \"when X \
writes to me / when a message arrives from Y …\" → trigger_type=event (this is NOT a \
channel access request: it is a rule that fires on that message). \"when a \
mail/event arrives from a CONNECTED SERVICE (Gmail, Calendar, …)\" → \
trigger_type=event with event_tool (discover it via find_capability: the service's \
read tool), event_args (the query) and event_key_field (the id field, e.g. \
messageId): a poller checks it and fires on new items.\n\
TOOLS: you have a SMALL base set. For capabilities you do NOT see among your tools \
(browsing the web, searching GitHub, reading/listing the user's files and folders, \
running commands in a sandbox, creating artifacts, scheduling recurring tasks, …) \
call `find_capability` FIRST describing what you want to do: it activates the right \
tool, callable right after. The browser is NOT in the base set and is activated via \
`find_capability`: use it as a LAST resort, only if no more direct tool (e.g. \
`github_search` for GitHub) covers the request.\n\
EXTERNAL SERVICES (email, calendar, GitHub, …): call `find_capability` to discover \
the right tool (also search among connected services) and use it; if it finds \
nothing, call `suggest_capabilities` to propose what to connect. Never leave the \
user with a non-answer.\n\
\n\
Travel and follow-up: always carry with you ALL the parameters already resolved in \
the conversation (route/place, date with year, constraints). Even on a short \
follow-up (\"also search on easyJet\", \"and by train?\") resume the full objective, \
e.g. flights from Milan to Naples on June 10 2026, one-way, with times, duration, \
stops, price.\n\
\n\
Travel: if the user does NOT explicitly ask for a return, search ONE-WAY only. One \
passenger unless stated otherwise.\n\
When reporting results (flights, trains, hotels, …), be EXHAUSTIVE and SPECIFIC PER \
ROW: each option is its own row, NEVER merge different options into a generic row. \
For flights each row MUST indicate: airline, specific departure airport (e.g. \
Malpensa/Linate/Bergamo, not just \"Milan\") and arrival airport, departure and \
arrival times, duration, stops/changes and price. If the options are from different \
airlines or airports, the Airline and Airport columns are MANDATORY (do not leave \
ambiguous which price belongs to whom/where). Use a table and list several options, \
not just one.\n\
\n\
RESPONSE FORMATTING (markdown, always): write readable, airy answers, never a wall \
of text. ALWAYS use markdown: each item in a list goes on its OWN LINE with `- ` \
(dash) — do not paste multiple entries on the same line. For day/item lists with \
labels use `**Label**: value` with a blank line between entries, or a table if there \
are ≥3 fields. Put a blank line between paragraphs. Use `### ` for section headings \
when the answer is long. {language_instruction} Clear and well-structured.",
        now = now_block(),
        home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string()),
        language_instruction = response_language_instruction(&effective_user_language()),
    );
    // Code-map steering: if THIS project has an imported code graph, tell the
    // orchestrator to query it FIRST for structure/dependency questions instead of
    // grepping/reading files by default (the natural reflex). Conditional: only when a
    // map exists for the active scope (else query_code_graph would just say "no map"
    // and grep is the correct fallback). Cheap count on the already-scoped workspace.
    let has_code_map = {
        let st = state.clone();
        tokio::task::spawn_blocking(move || {
            memory_facade(&st)
                .list_entities_for_ui(&gateway_memory_user_id(), &gateway_memory_workspace_id())
                .ok()
                .map(|ents| ents.iter().any(|e| e.entity_type.starts_with("code_")))
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    };
    let system = if has_code_map {
        format!(
            "{system}\n\nCODE MAP: this project has an indexed code map. \
For questions about code STRUCTURE or DEPENDENCIES — \"what methods/functions \
does X have\", \"who calls/uses Y\", \"what does Z use\", \"where is W defined/which files use it\" — \
call `query_code_graph` FIRST (it's instant and authoritative). For HISTORY or the WHY \
OVER TIME — \"why/when did X change\", \"the history of Y\" — use `query_git_history` \
(commit messages are the why). Resort to read_file/list_files/run_in_project ONLY \
if the map and history aren't enough (e.g. reading the BODY of a function). Do NOT grep/list \
files for questions the map or history already answer."
        )
    } else {
        system
    };
    // Connected-service (Composio) tools are reached via a DISCOVERY meta-tool
    // (`find_connected_tools`), not dumped into the prompt: the model searches by
    // intent, we return the few relevant tools and inject their schemas for the
    // next round. Keeps the prompt small and scales to hundreds of tools — the
    // pattern Composio/Claude use.
    let catalog = {
        let st = state.clone();
        tokio::task::spawn_blocking(move || composio_chat_tools_cached(&st, COMPOSIO_CATALOG_CAP))
            .await
            .unwrap_or_default()
    };
    let mut composio_writes = catalog.writes.clone();
    // (name, lowercased "name + description" haystack, schema) for keyword search.
    let mut catalog_index: Vec<(String, String, serde_json::Value)> = catalog
        .schemas
        .iter()
        .filter_map(|s| {
            let f = s.get("function")?;
            let name = f.get("name")?.as_str()?.to_string();
            let desc = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
            let haystack = format!("{name} {desc}").to_lowercase();
            Some((name, haystack, s.clone()))
        })
        .collect();
    // MCP server tools join the SAME discovery surface as Composio: they appear in
    // `find_connected_tools` and their writes share the confirmation gate. Read
    // from the local SQLite cache (cheap), still off the runtime to be safe.
    let mcp_catalog = {
        let st = state.clone();
        tokio::task::spawn_blocking(move || mcp_chat_tools(&st, MCP_CATALOG_CAP))
            .await
            .unwrap_or_default()
    };
    let filesystem_mcp_connected = mcp_catalog.schemas.iter().any(|schema| {
        schema
            .pointer("/function/name")
            .and_then(|name| name.as_str())
            .is_some_and(|name| name.starts_with("mcp__filesystem__"))
    });
    let system = match project_filesystem_mcp_instruction(
        project_root_for_thread(state, request.thread_id.as_deref()).as_deref(),
        filesystem_mcp_connected,
    ) {
        Some(instruction) => format!("{system}\n\n{instruction}"),
        None => system,
    };
    composio_writes.extend(mcp_catalog.writes.iter().cloned());
    for schema in &mcp_catalog.schemas {
        if let Some(f) = schema.get("function")
            && let Some(name) = f.get("name").and_then(|n| n.as_str())
        {
            let desc = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
            let haystack = format!("{name} {desc}").to_lowercase();
            catalog_index.push((name.to_string(), haystack, schema.clone()));
        }
    }
    // `send_message` is a side-effecting action → route it through the same write-confirm
    // card as Composio/MCP writes (the confirm endpoint dispatches it to channel_send).
    composio_writes.insert("send_message".to_string());
    let composio_writes = composio_writes; // freeze: (Composio + MCP) write tools
    let has_composio = !catalog_index.is_empty();
    let system = if !has_composio {
        system
    } else {
        format!(
            "{system}\n\nCONNECTED-SERVICE TOOLS: the user has connected some services (e.g. Gmail, \
Google Calendar). To access them do NOT say you can't: call `find_capability` with a query \
about the intent (e.g. \"unread emails\", \"send email\", \"calendar events today\") to discover the \
right tool, then CALL the found tool with the complete arguments.\n\
TOOL CHOICE: use ONE SINGLE tool that matches the intent EXACTLY — for \
ADDING/CREATING use create/add/quick_add, for READING use fetch/list. NEVER call destructive \
tools (delete/remove/cancel) unless the user explicitly asks. find_capability \
finds the service's tools: to MODIFY something existing (e.g. the date of \
an event) use update/patch (NOT 'move', which moves between calendars). Do NOT conclude that a \
tool is missing after a single search.\n\
DATES AND TIMES: ALWAYS compute the ABSOLUTE date/time starting from 'Today is ...' above (e.g. tomorrow = today \
+ 1 day) and pass it to the tool in EXPLICIT ISO 8601 format with the timezone (e.g. \
start_datetime: 2026-06-08T11:00:00+02:00, end_datetime one hour later). Do NOT pass relative words \
like \"tomorrow\"/\"today\" in the arguments: the service's parsing may get the day wrong. Prefer \
a tool with explicit start/end over the textual \"quick add\" for times.\n\
WRITE ACTIONS (send/delete/modify): CALL the tool anyway with the complete arguments \
— the system will AUTOMATICALLY show the user a confirmation card before executing. \
Do NOT refuse, do NOT say you can't send, and do NOT ask the user to do it manually: your \
job is to call the right tool, the interface handles confirmation.\n\
COUNTS (e.g. \"how many unread emails\"): use the correct filter (for Gmail query \"is:unread\") and \
report the TOTAL indicated by the result (a field like resultSizeEstimate / total / nextPageToken \
absent), NOT the number of messages on the single returned page; if the result is paginated and \
doesn't give a reliable total, state that it's an estimate."
        )
    };
    // Connected-but-EXPIRED services: the integration EXISTS, the OAuth lapsed. Tell
    // the model so it says "reconnect" instead of "I have no integration" (the bug
    // that surfaced on a real "leggi le email" with an expired Gmail).
    let system = if catalog.inactive.is_empty() {
        system
    } else {
        format!(
            "{system}\n\nCONNECTED BUT EXPIRED SERVICES (slug): {}. The connection EXISTS but \
the authorization has EXPIRED. If the user asks for one of these services: do NOT say you don't have \
the integration; explain in ONE sentence that the connection has expired and just needs reauthorizing, and \
INCLUDE in the reply the marker (on its own line) `‹‹COMPOSIO_RECONNECT››<slug>‹‹/COMPOSIO_RECONNECT››` \
with only the slug of the affected service (e.g. gmail): the interface will show a \
\"Reconnect\" button that reopens authorization in one click.",
            catalog.inactive.join(", ")
        )
    };
    // Installed skills (Anthropic Agent Skills, progressive disclosure L1): pre-load
    // name+description; the model calls `use_skill(<id>)` to pull the full SKILL.md
    // when a request matches, then follows it.
    let homuncoder = tokio::task::spawn_blocking(homuncoder_skill_ids)
        .await
        .unwrap_or_default();
    // HomunCoder mode: the methodology skills surface only in PROJECT chats, so personal
    // chats aren't flooded with ~30 dev-discipline skills.
    let is_project = gateway_memory_workspace_id().as_str() != PERSONAL_WORKSPACE;
    let mut enabled_skills = tokio::task::spawn_blocking(enabled_skills_summary)
        .await
        .unwrap_or_default();
    if !is_project {
        enabled_skills.retain(|(id, _, _)| !homuncoder.contains(id));
    }
    let has_skills = !enabled_skills.is_empty();
    // The "Homun apprentice" persona (proactive/curious/onboarding on a dedicated
    // "homun" thread) is RETIRED: proactivity now lives solely in the Proattività
    // plugin (supervisor → cards). No per-thread persona prompt anymore.
    // Channel-contact persona + privacy perimeter. Prepended (like the Homun block,
    // which is mutually exclusive: homun is never a channel_ thread) so the contact
    // rules dominate the generic orchestrator voice.
    let system = if let Some(cx) = &contact_ctx {
        let mut block = format!(
            "REPLYING TO A CONTACT VIA CHANNEL: you are replying to {} on a \
messaging channel, on behalf of the user. Chat style: natural and concise.",
            cx.name
        );
        if !cx.tone_of_voice.trim().is_empty() {
            block.push_str(&format!(" REQUESTED TONE: {}.", cx.tone_of_voice.trim()));
        }
        if !cx.persona_instructions.trim().is_empty() {
            block.push_str(&format!(
                "\nPERSONA INSTRUCTIONS (always follow them): {}",
                cx.persona_instructions.trim()
            ));
        }
        if !cx.relationships.is_empty() {
            block.push_str(&format!(
                "\nKNOWN RELATIONSHIPS of {}: {}.",
                cx.name,
                cx.relationships.join("; ")
            ));
        }
        if !cx.perimeter.can_see_contacts {
            block.push_str(
                "\n[PRIVACY] NEVER mention other contacts, people or relationships \
of the user: with this person you know ONLY them.",
            );
        }
        if !cx.perimeter.can_see_calendar {
            block.push_str(
                "\n[PRIVACY] NEVER mention the user's commitments, appointments or \
calendar events.",
            );
        }
        format!("{block}\n\n{system}")
    } else {
        system
    };
    let system = if !has_skills {
        system
    } else {
        let lines = enabled_skills
            .iter()
            .map(|(id, name, desc)| format!("- {id}: {name} — {desc}"))
            .collect::<Vec<_>>()
            .join("\n");
        let methodology = if is_project
            && enabled_skills
                .iter()
                .any(|(id, _, _)| homuncoder.contains(id))
        {
            "\nMETHODOLOGY (HomunCoder) — for DEVELOPMENT work follow the evidence-first habits: \
plan with update_plan, REMEMBER/record decisions with their why, and VERIFY by executing \
(build/test/lint) before saying \"done\". When you apply one of these disciplines, call \
`use_skill` FIRST with the right skill (roadmap-first-planning, systematic-debugging, test-first-development, \
verification-before-completion, code-review-discipline, …) — so the user SEES which methodology \
you're following — and then follow its instructions. Don't just cite it: actually load it with use_skill."
        } else {
            ""
        };
        format!(
            "{system}\n\nINSTALLED SKILLS — when the request matches the description of one \
of these, PREFER it over the browser: call `use_skill` with its id to receive the complete \
instructions (SKILL.md). Then RUN the commands the skill indicates (e.g. `curl …`, `python …`) with the \
`run_in_sandbox` tool, which launches them in the contained computer, and use the output to reply.\n\
GENERATED FILES: if a skill or a command produces files (xlsx, pdf, csv, images, …), SAVE them in the \
environment folder `$OUTPUT_DIR` (e.g. `... --output \"$OUTPUT_DIR/report.xlsx\"`): files there \
automatically become artifacts downloadable by the user.{methodology}\n{lines}"
        )
    };
    // Inline choice prompts (Claude-Code style): when the answer is a pick among a few
    // discrete options, the model emits a CHOICES marker that the UI renders as clickable
    // single/multi-select buttons, instead of listing the options in prose.
    let system = format!(
        "{system}\n\nCHOICES: when you ask the user to choose among discrete OPTIONS \
(roughly 2-6 alternatives), you MUST emit on its own line the marker \
`‹‹CHOICES››{{\"question\":\"the question\",\"multi\":false,\"options\":[\"Option A\",\"Option B\"]}}‹‹/CHOICES››` \
(valid JSON; \"multi\":true if more than one can be chosen). Do NOT only list options in a markdown \
table or ask \"which do you prefer?\" in prose — without the marker the UI has no clickable buttons. \
The user will see clickable buttons and their choice will come back as a message. Use it ONLY for \
closed choices, not for open questions (name/email/free text).\n\
CLARIFY: when you need FREE-TEXT details from the user (name, email, phone, dates, payment prefs, …), \
you MUST emit on its own line \
`‹‹CLARIFY››{{\"question\":\"what you need\",\"fields\":[\"name\",\"email\"]}}‹‹/CLARIFY››` \
(valid JSON; \"fields\" optional). Do NOT only ask in prose — without the marker the harness cannot \
wait/resume correctly and will keep nudging the plan."
    );
    let system = format!("{system}\n{booking_choices}");
    let system = match choice_resume_slot {
        Some(resume) => format!("{system}\n\n{resume}"),
        None => system,
    };
    // Authorized write destinations: when present, the model can deliver
    // generated files to user-granted folders via `save_artifact`.
    let artifact_destinations = load_artifact_destinations();
    let system = if artifact_destinations.is_empty() {
        system
    } else {
        let labels = artifact_destinations
            .iter()
            .map(|d| d.label.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{system}\n\nDESTINATION FOLDERS: you can deliver generated files to these folders \
AUTHORIZED by the user with the `save_artifact` tool: {labels}. When the user asks to \
save/export a file to a folder, call save_artifact(file, destination)."
        )
    };
    // Layer boundary: everything added below through the end of recall assembly
    // is workspace/thread knowledge, not a core instruction. Keep the provider
    // prompt text-compatible while exposing the real content boundary to the
    // Prompt Inspector and independent budgets.
    let prompt_core = system.clone();
    let active_objective_contract =
        objective_contract_for_execution(state, request.thread_id.as_deref());
    let semantic_contract = active_objective_contract
        .as_ref()
        .and_then(semantic_decision::semantic_decision_from_contract);
    let objective_effect_policy =
        semantic_decision::ObjectiveEffectPolicy::from_contract(active_objective_contract.as_ref());
    catalog_index.retain(|(name, _, _)| {
        !objective_blocks_tool(&objective_effect_policy, name, &composio_writes)
    });
    let memory_intent = semantic_contract
        .as_ref()
        .map(|semantic| semantic.decision.memory_intent.clone())
        .unwrap_or_else(semantic_decision::MemoryIntent::safe_default);
    let memory_recall_allowed = memory_intent_allows_recall(&memory_intent);
    let memory_injection = memory_injection_policy(&memory_intent);
    // Memory scope. Perimeter "contact_only" (the default for channel contacts) is a
    // HARD gate: the user's personal profile + RAG are NOT injected — the turn only
    // sees the conversation history with THIS contact. "personal" opts a trusted
    // contact back into today's behavior.
    let contact_only = contact_ctx
        .as_ref()
        .map(|c| c.perimeter.memory_scope == "contact_only")
        .unwrap_or(false);
    // Finer-grained perimeter axes, independent of memory_scope. A contact opted into
    // "personal" memory (NOT contact_only) can still have can_see_contacts/can_see_calendar
    // = false; these are enforced HARD at dispatch below (not only in the prompt), so the
    // address book / calendar can't be exfiltrated even when broad memory is allowed.
    // No contact perimeter (self / in-app turn) → unrestricted.
    let (can_see_contacts, can_see_calendar) = contact_ctx
        .as_ref()
        .map(|c| (c.perimeter.can_see_contacts, c.perimeter.can_see_calendar))
        .unwrap_or((true, true));
    let can_use_project_memory = contact_ctx
        .as_ref()
        .map(|context| context.can_use_project_memory)
        .unwrap_or(true);
    // This is emitted as a structured stream event once the transport exists below.
    // Keep it next to prompt assembly so UI provenance and actual RAG context cannot diverge.
    let mut automatic_recall_payload = None;
    let system = if contact_only {
        let cx = contact_ctx
            .as_ref()
            .expect("contact_only implies contact_ctx");
        let episodes = {
            let facade = memory_facade(state);
            let user = gateway_memory_user_id();
            episode_texts_by_handles(facade, &user, &cx.handles)
        };
        if episodes.is_empty() {
            system
        } else {
            let mut block = String::from("HISTORY WITH THIS CONTACT (the only memory available):");
            let mut used = 0usize;
            for text in episodes.iter().rev().take(40).rev() {
                if used + text.len() > CHAT_MEMORY_BUDGET_CHARS {
                    break;
                }
                used += text.len();
                block.push_str("\n- ");
                block.push_str(text);
            }
            format!("{system}\n\n{block}")
        }
    } else if !memory_perimeter_allows_recall(
        contact_only,
        can_see_contacts,
        can_use_project_memory,
        is_project,
    ) {
        let scope = scope_from_active_workspace();
        automatic_recall_payload = Some(local_first_subagents::RecallStreamPayload {
            query: request.prompt.clone(),
            hits: Vec::new(),
            scope: match scope {
                MemoryScope::Personal => "personal".to_string(),
                MemoryScope::Project(_) | MemoryScope::Thread { .. } => "project".to_string(),
            },
            status: "denied".to_string(),
        });
        system
    } else {
        // Always-on memory profile (M1): inject what we durably know about the user
        // (personal scope) and the active project, so the chat is continuous instead
        // of starting cold every turn. Sensitive items are excluded here by design.
        //
        // ADR 0022 — Tappa 1: di default l'assemblaggio del briefing è
        // incapsulato in `MemoryRecallService::brief` (che delega alle stesse
        // funzioni, nello stesso ordine). Opt-out
        // `HOMUN_MEMORY_SERVICE=0`/`off`/`false` → path inline.
        let system = if let Some(service) = state.memory_service.as_ref() {
            let scope = memory_scope_for_turn(request.thread_id.as_deref());
            let pack = service.brief(&scope, &request.prompt);
            if !pack.linked_hits.is_empty() {
                merge_automatic_recall_payload(
                    &mut automatic_recall_payload,
                    recall_stream_payload_from_hits(&request.prompt, &scope, &pack.linked_hits),
                );
            }
            // ordered_blocks() = [profile, objective, brief, recent_work] — stesso
            // ordine dell'assemblaggio inline qui sotto. Mantiene la parità.
            let mut system = system;
            for block in pack.ordered_blocks().into_iter().flatten() {
                system = format!("{system}\n\n{block}");
            }
            system
        } else {
            let (memory_personal, memory_project) =
                gather_profile_memory_for_intent_with_provenance(state, &memory_intent);
            let memory_open_loops = if memory_injection.include_cross_thread {
                gather_open_loops(state, 6)
            } else {
                Vec::new()
            };
            let formatted_profile = format_memory_block_with_provenance(
                &memory_open_loops,
                &memory_personal,
                &memory_project,
                CHAT_MEMORY_BUDGET_CHARS,
            );
            if !formatted_profile.linked_hits.is_empty() {
                let scope = scope_from_active_workspace();
                merge_automatic_recall_payload(
                    &mut automatic_recall_payload,
                    recall_stream_payload_from_hits(
                        &request.prompt,
                        &scope,
                        &formatted_profile.linked_hits,
                    ),
                );
            }
            let system = match formatted_profile.block {
                Some(block) => format!("{system}\n\n{block}"),
                None => system,
            };
            // Project OBJECTIVE (always-on, FIRST): the north star + focus directive, so the
            // assistant keeps every implementation aligned and flags drift.
            let system = match project_objective_block(state) {
                Some(block) => format!("{system}\n\n{block}"),
                None => system,
            };
            // Project BRIEF (always-on): recent state, so "where this project is" is present
            // every turn — not just when the prompt happens to match.
            let system = match project_brief_block(state) {
                Some(block) => format!("{system}\n\n{block}"),
                None => system,
            };
            // Recent work (always-on): the last commits, so a new conversation resumes the
            // thread of what was just being done instead of starting cold.

            match recent_work_block(state) {
                Some(block) => format!("{system}\n\n{block}"),
                None => system,
            }
        };
        let thread_memory = request
            .thread_id
            .as_deref()
            .filter(|_| memory_injection.include_current_thread)
            .and_then(|thread_id| current_thread_episode_block(state, thread_id));
        let system = match thread_memory {
            Some(block) => format!("{system}\n\n{block}"),
            None => system,
        };
        // Goal-propose affordance (projects only): when the model articulates the project's
        // objective, it emits a marker → the UI shows a "Salva come obiettivo" card. This is
        // content-contextual via a MODEL-emitted affordance (not keyword parsing).
        let system = {
            let ws = gateway_memory_workspace_id();
            if ws.as_str() != PERSONAL_WORKSPACE && ws.as_str() != THREADS_WORKSPACE {
                format!(
                    "{system}\n\nIf you ARTICULATE or PROPOSE the OBJECTIVE or direction of THIS project \
(e.g. the user asks \"propose an objective\", or you are defining where the \
project should go), emit on its own line the marker \
‹‹GOAL_PROPOSE››{{\"objectives\":[\"objective 1\",\"objective 2\"]}}‹‹/GOAL_PROPOSE›› with 1-3 \
SHORT objectives looking FORWARD (the direction/the goal, NOT decisions already taken). \
The user will see a card to save them. Use it ONLY for real project objectives, never for \
normal answers."
                )
            } else {
                system
            }
        };
        // RAG: inject memory relevant to THIS prompt (decisions/facts), so the model
        // answers from what was already decided instead of saying it has nothing.
        // ADR 0022 — Tappa 1/4: via service quando il flag è ON; anche nel path OFF
        // usa le fn del crate (embed_query + recall_search_on_facade) con capability
        // client al volo — così `relevant_memory_for_prompt` non è più duplicata.
        let system = if memory_injection.include_cross_thread && applies_new_input {
            if let Some(service) = state.memory_service.as_ref() {
                let scope = memory_scope_for_turn(request.thread_id.as_deref());
                let pack = service.recall(&request.prompt, &scope).await;
                merge_automatic_recall_payload(
                    &mut automatic_recall_payload,
                    recall_stream_payload_from_pack(&pack),
                );
                let status = memory_access_status_instruction(pack.status);
                let system = match pack.block {
                    Some(block) => format!("{system}\n\n{block}"),
                    None => system,
                };
                format!("{system}\n\n{status}")
            } else {
                // Path OFF: stessa orchestrazione del crate, capability client al volo.
                let user = gateway_memory_user_id();
                let workspace = gateway_memory_workspace_id();
                let embedding: std::sync::Arc<dyn local_first_memory::EmbeddingClient> =
                    gateway_embedding_client(state.http.clone());
                let query_vec =
                    local_first_memory::embed_query(embedding.as_ref(), &request.prompt).await;
                let block = {
                    let facade = memory_facade(state);
                    let graph_context: Option<&local_first_memory::GraphContextHook<'_>> =
                        Some(&|facade, user, workspace, q| {
                            if let Some(workflow) =
                                workflow_status_context_for_query(facade, user, workspace, q)
                            {
                                return Some(workflow);
                            }
                            artifact_provenance_context_for_query(facade, user, workspace, q)
                        });
                    recall_pack_on_facade(
                        facade,
                        &user,
                        &workspace,
                        &request.prompt,
                        &query_vec,
                        graph_context,
                    )
                };
                merge_automatic_recall_payload(
                    &mut automatic_recall_payload,
                    recall_stream_payload_from_pack(&block),
                );
                let status = memory_access_status_instruction(block.status);
                let system = match block.block {
                    Some(block) => format!("{system}\n\n{block}"),
                    None => system,
                };
                format!("{system}\n\n{status}")
            }
        } else {
            system
        };
        // Anti-rewrite anchor: existing code components matching the request, so the
        // model extends/reuses instead of re-implementing (no-regression by default).
        let facade = memory_facade(state);
        let user = gateway_memory_user_id();
        let workspace = gateway_memory_workspace_id();
        match relevant_code_components_for_prompt(facade, &user, &workspace, &request.prompt) {
            Some(block) => format!("{system}\n\n{block}"),
            None => system,
        }
    };
    let prompt_workspace = system
        .strip_prefix(&prompt_core)
        .unwrap_or_default()
        .trim()
        .to_string();
    let system = prompt_core.clone();
    let system = format!(
        "{system}\n\nMEMORY: you have a long-term memory of the user. If you need a personal \
or project detail you may have already learned (a name, a preference, a fact, a \
past decision and its why), OR if the user asks what was discussed or decided in \
PREVIOUS conversations, and the information is NOT already in the profile above, ALWAYS call the \
recall_memory tool BEFORE saying you don't know or don't remember. \
RECALL-BEFORE-ASKING: when the user refers to a POSSESSION, a PERSON or a \
CONTEXT they take as already known (typically with a possessive: «my motorbike», «my boss», «my \
house», «my brother», «my management software»…) and to act you need a detail about it that is NOT \
already in the profile above, do NOT instinctively ask the user: call recall_memory FIRST and USE what \
you find; then ask ONLY for the details that are truly still missing after the recall. \
E.g.: «find me a fuel cap for my motorbike» → recall_memory(«user's motorbike, make \
model year») → if you find «Moto Guzzi V7 Stone 850 2021» proceed with that and ask for the year only if \
it's not in memory. This concerns DURABLE facts plausibly already learned, not \
ephemeral information or things that just came up in the conversation. \
DECISIONS: BEFORE modifying a project's code/documents, call recall_memory to remember \
why things are the way they are (do NOT re-scan everything from scratch). AFTER a non-trivial choice — in \
ANY domain: code, a document (e.g. a customer quote), data, configurations — call \
record_decision with what you decided, the WHY, the rejected alternatives and the objects touched, so \
the rationale stays and doesn't have to be reconstructed. \
SENSITIVE VAULT: sensitive values are NOT in ordinary memory. If the user asks for a sensitive personal \
value (identity document, fiscal/tax code, vehicle plate, health note, credentials, payment data, private \
note), call recall_memory before saying you don't know it: if normal memory has no match, the gateway \
checks Vault metadata internally and returns only redacted metadata. Never reveal, infer, or guess the \
secret value from metadata. If a matching record exists, say it is saved in the Vault and local PIN unlock \
is required to reveal or edit it. If recall_memory returns a `reveal_card:` line, COPY the marker after \
`reveal_card:` EXACTLY into your final answer on its own line; do not paraphrase it. The UI hides that \
marker and renders the PIN unlock card. Do NOT send or forward raw Vault secret values through \
generic external channels/tools such as send_message. The configured Telegram authorization channel may \
receive Vault/payment summaries or approval prompts, but raw-value reveal stays behind the local PIN \
unlock card unless a dedicated approved reveal flow exists. \
OPERATIONAL PLAN: for a non-trivial MULTI-STEP task, call update_plan and then continue executing \
in the SAME turn. The plan is a live projection of the canonical objective, not a separate artifact \
and not an approval gate. Replace or revise it autonomously when the new steps are only a better way \
to reach the SAME objective. Ask the user before continuing only when the validated semantic decision \
says the request changes the objective, expands its scope, or introduces new effects. Use update_plan \
to create or revise the operational plan; do not write a free-form numbered plan in prose. \
Use update_plan to update the step status (doing→done), shown in the \
\"Plan\" panel. To move a step's status (e.g. doing→done) call step_advance with its id (shown in \
parentheses after the title in the plan card) and the new status — this updates that ONE step \
WITHOUT re-sending the plan, so steps never duplicate; use update_plan only to CREATE or revise \
the plan. GOAL: when CREATING the plan you MUST set the top-level `goal` field to the user's \
objective in ONE sentence, written in the USER'S language (use null when you are only updating \
step statuses of an existing plan). The plan is ALREADY shown to the user as a CARD: do NOT \
repeat it in the reply text too — no list or table of the steps in prose (at most one \
line of context). For single-step requests no plan is needed. \
STEP-AT-A-TIME EXECUTION: work the plan ONE step at a time — do, then VERIFY that step's \
result (file written, search returned usable results, build/render succeeded), and only \
THEN mark it `done` with update_plan before starting the next. Give each step a \
`done_criterion` (the concrete, checkable proof it's finished): a step you mark done is \
INDEPENDENTLY verified against its evidence before it counts — if it isn't actually complete \
you'll be told and must keep working on it. Your working budget RESETS every time a step is \
verified complete, so a long task (e.g. a 10-slide deck, a deep research) can run as long as \
it KEEPS CLOSING STEPS — never rush or skip verification to save rounds, and never mark a \
step done before its result actually exists. RESUMING: if the conversation ALREADY shows an \
in-progress plan (some steps done, others not), CONTINUE it — re-emit the plan with update_plan \
keeping the completed steps as done, and proceed from the first not-done step; do NOT restart \
from scratch or re-propose."
    );
    let system = if memory_recall_allowed {
        system
    } else {
        format!(
            "{system}\n\nMEMORY SCOPE FOR THIS OBJECTIVE: long-term recall and Vault lookup are not authorized. Use only current-thread context and current-turn tool evidence; do not call recall_memory."
        )
    };
    // LANGUAGE: the whole system prompt is in English, so without an explicit
    // directive coding-oriented models (e.g. kimi-*-code) reply in English even to an
    // Italian request — narration AND final answer. Pin it to the user's language.
    let system = format!(
        "{system}\n\nLANGUAGE: ALWAYS write in the SAME language as the user's latest \
message — both your step-by-step narration AND the final answer. If the user writes in \
Italian, reply entirely in Italian; if in English, in English. Match the user and never \
switch language on your own. (Tool arguments, code, file paths and URLs stay as-is.)"
    );
    // An active thread-scoped RoutingBinding records an exact route the user already selected.
    // It remains authoritative over the model-owned semantic decision; absent or malformed
    // bindings fall back to that structured decision, never to prompt keyword routing.
    let routing_binding: Option<RoutingBinding> =
        active_routing_binding(state, request.thread_id.as_deref());
    let capability_route =
        route_capability_with_binding(semantic_contract.as_ref(), routing_binding.as_ref());
    let workflow_route = workflow_route_from_capability(&capability_route);
    // S2 T4/T5: resolve the binding's WorkflowRouting ONCE — when it survived plan-precedence
    // AND still resolves to a registered routing — so the hard-prune's `deny_tools` (T4) and the
    // forced `tool_choice` gate (T5) both read off the SAME resolution.
    let resolved_workflow_routing = routing_binding
        .as_ref()
        .filter(|_| matches!(workflow_route, WorkflowRouteDecision::Workflow { .. }))
        .and_then(resolve_workflow_routing);
    // S2 T4: carry its `deny_tools` to the prune call sites below — hard-prune removes
    // skill:*/run_command/shell/the-sibling-make_* explicitly, not just by omission.
    let workflow_deny_tools: Vec<String> = resolved_workflow_routing
        .as_ref()
        .map(|routing| routing.deny_tools.clone())
        .unwrap_or_default();
    // S2 T5: force `tool_choice` to the routed tool — belt-and-suspenders on top of the hard-
    // prune above — but ONLY once the intake exchange is done. On the workflow's FIRST turn
    // (right after "Use template") the model must stay free to ask clarifying questions
    // ("auto"); forcing immediately would railroad an empty/guessed brief into the tool call.
    // Turn-index heuristic: the thread already carries >=2 user messages (the seed "Use
    // template" prompt + at least one intake reply) by the time generation runs here — the
    // broker inserts the CURRENT turn's user message atomically at enqueue, before the worker
    // ever calls in (see `enqueue_chat_turn_core`), so a plain count already includes it.
    // Final-review fix (I3): only compute the user-message count when a binding actually
    // resolved — `thread_user_message_count_fail_open` loads the WHOLE thread message history
    // + takes a store lock, and `forced_tool_for_turn` returns `None` unconditionally when
    // `routing` is `None` anyway, so an ordinary turn (no binding) previously paid for that
    // load and threw the result away. Gating here skips the messages() load entirely for the
    // overwhelming majority of turns; behavior is identical when a binding IS present.
    let forced_tool: Option<String> = match resolved_workflow_routing.as_ref() {
        Some(routing) => forced_tool_for_turn(
            Some(routing),
            thread_user_message_count_fail_open(state, request.thread_id.as_deref()),
        ),
        None => None,
    };
    let system = match capability_router_instruction_for_decision(&capability_route) {
        Some(instruction) => format!("{system}\n\n{instruction}"),
        None => system,
    };
    let system = format!(
        "{system}\n\nFRESHNESS / VERIFICATION: your internal knowledge may be dated. For ANY \
question whose answer depends on information that changes over time or that requires up-to-date \
accuracy — news and current events, the state/condition/health of people, results or scores, prices, \
schedules, rankings; but ALSO software (libraries, frameworks, APIs, SDKs, tools: versions, syntax, \
options, best practices, current state of the art) — you MUST verify on the web with the browser, preferring the \
OFFICIAL documentation or recent sources, BEFORE answering, instead of answering from memory. NEVER \
cite a source (site/publication/doc) you haven't actually opened in THIS turn: no invented sources, \
versions or dates. If you can't verify, say so openly instead of guessing. Timeless \
questions (concepts, logic, generic code) you can answer directly."
    );
    let system = format!(
        "{system}\n\nEXECUTION / VERIFICATION: when you produce CODE or a calculation and you have the \
execution tool (run_in_sandbox), do NOT assume it works — VERIFY BY EXECUTING: run build/test/lint or \
run the code, read the REAL output and iterate on the failures until it passes, BEFORE saying it's done. \
Trust the compiler and the tests, not your estimate."
    );
    let system = format!("{system}\n\n{}", manager_browser_guidance());
    // Composer interaction mode (agent = default). plan/ask/debug refine behavior;
    // "ask" also drops the toolset below (pure conversation).
    let mode = request.mode.as_deref().unwrap_or("agent").to_string();
    // Model tier remains useful observability for role selection and evals; it no longer changes
    // the agent-loop control flow.
    let turn_tier = load_provider_registry().tier_for_model(&model);
    // Turn trace: setup COMPLETED (memory recall and prompt-build) and generation is about to begin.
    // A `turn_start` following a `turn_received` implies setup succeeded (no pre-gen hang).
    turn_trace.record(local_first_engine::turn_trace::TurnEvent::TurnStart {
        prompt_head: request.prompt.chars().take(200).collect(),
        prompt_len: request.prompt.chars().count(),
        mode: mode.clone(),
        model: model.to_string(),
        tier: turn_tier.as_str().to_string(),
    });
    let system = match mode.as_str() {
        "plan" => format!(
            "{system}\n\nPLAN MODE (chosen by the user): maintain the canonical operational plan with \
update_plan and continue execution in this turn. Replan autonomously while the objective, scope and effects stay unchanged."
        ),
        "ask" => format!(
            "{system}\n\nASK MODE (chosen by the user): answer by conversing from your \
knowledge and memory. Do NOT use tools and do NOT perform external actions (no browser, files, \
sends, searches). If answering would require a tool, say so and suggest switching to \
Agent mode."
        ),
        "debug" => format!(
            "{system}\n\nDEBUG MODE (chosen by the user): SYSTEMATIC debugging — reproduce the \
problem, isolate the cause, form a hypothesis, verify it with a minimal experiment, then fix and \
RE-VERIFY by executing. One cause at a time, no blind attempts."
        ),
        _ => system,
    };
    let system = match objective_contract_for_execution(state, request.thread_id.as_deref()) {
        Some(objective) => format!(
            "{system}\n\nOBJECTIVE CONTRACT (canonical, harness-enforced): revision {}; mode={:?}; objective={}. Stay inside its scope and allowed actions. Replan autonomously only when the objective, scope and mutation level stay unchanged. A new objective, wider scope or newly mutating action requires explicit user confirmation. Plan completion requires recorded evidence; response length is never completion evidence.",
            objective.revision, objective.mode, objective.objective
        ),
        // No contract does NOT mean "no rules": execution defaults to read-only analysis, so the
        // effectful tools are gated. Saying nothing here was the worst combination — the gate was armed
        // and the model had no idea, so its writes came back refused for reasons it could not see.
        None => format!(
            "{system}\n\nOBJECTIVE CONTRACT: none recorded for this task, so execution defaults to READ-ONLY analysis. Reading, searching, browsing and analysing are available; tools that change something (writing files, sending, creating, booking, purchasing) are refused until the user asks for that change. Do the read-only work and say plainly what you would need to change, rather than attempting it."
        ),
    };
    let prompt_runtime = system
        .strip_prefix(&prompt_core)
        .unwrap_or_default()
        .trim()
        .to_string();
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
    // Channel turns run read-only: offer only tools without side effects (search,
    // recall, skill instructions, Composio reads). Side-effecting tools (write
    // files, run sandbox, Composio writes) are withheld → Phase 2 routes them to
    // approval. App chat (tool_policy unset) keeps the full toolset.
    let read_only = request.tool_policy.as_deref() == Some("read_only");
    // `autonomous` (set only by an Automation run whose rule is ApprovalPolicy::Autonomous):
    // side-effecting tools EXECUTE directly instead of proposing a confirm card. This is the
    // user's explicit per-automation opt-in; everything else still confirms.
    let autonomous = request.tool_policy.as_deref() == Some("autonomous");
    // Browser toolset: the main agent ALWAYS drives the browser itself via the
    // granular micro-tools. The legacy coarse `browse_web` handoff is gone.
    // read_only (channels) still gets browser_act, but the dispatch blocks any
    // committing action — channels can fill/scroll/read, never click-submit.
    // ADR 0025 (slice 4b — converged): the MANAGER sees a single `browse(goal)` tool; the 6 granular
    // browser tools are driven ONLY inside the isolated browse sub-loop (they're seeded there directly),
    // never offered to the manager. The mid-turn model-switch + the granular-tools-on-the-manager path
    // are retired — one canonical browser path.
    let mut base_tools = initial_manager_tool_schemas_for_test(read_only, contact_only);
    if memory_recall_allowed {
        base_tools.push(recall_memory_tool_schema());
    }
    base_tools.extend([
        query_code_graph_tool_schema(),
        query_git_history_tool_schema(),
        github_search_tool_schema(),
        // Unified capability discovery — find what to connect (MCP/skill/Composio)
        // for a need. Read-only (search), so offered to channels too.
        suggest_capabilities_tool_schema(),
        // Deterministic date/time resolution (Layer C). Read-only and needed most
        // on channels (e.g. WhatsApp "treni per domani"), so offered to everyone.
        resolve_datetime_tool_schema(),
    ]);
    if !read_only {
        if host_computer_gateway::manager_ready() {
            base_tools.push(use_computer_tool_schema());
        }
        base_tools.push(create_artifact_tool_schema());
        base_tools.push(generate_image_tool_schema());
        base_tools.push(render_deck_tool_schema());
        base_tools.push(make_deck_tool_schema());
        base_tools.push(make_document_tool_schema());
        base_tools.push(get_brand_kit_tool_schema());
        base_tools.push(create_skill_tool_schema());
        base_tools.push(record_decision_tool_schema());
        base_tools.push(forget_memory_tool_schema());
        base_tools.push(update_plan_tool_schema());
        base_tools.push(step_advance_tool_schema());
        base_tools.push(schedule_task_tool_schema());
        base_tools.push(create_automation_tool_schema());
        base_tools.push(update_automation_tool_schema());
        base_tools.push(send_message_tool_schema());
        base_tools.push(list_scheduled_tasks_tool_schema());
        base_tools.push(cancel_scheduled_task_tool_schema());
        // Shell execution is a general capability (run scripts, process data, and
        // verify-by-execution: build/test/lint), not skill-only. The Docker
        // sandbox + security scan are the safety boundary, so it's safe to offer
        // whenever the turn can act (not read-only channels).
        base_tools.push(run_in_sandbox_tool_schema());
        // In-place file tools on the conversation's project folder (Claude-Code
        // style, path-jailed). No-op-with-explanation when no project folder.
        base_tools.push(read_file_tool_schema());
        base_tools.push(write_file_tool_schema());
        base_tools.push(edit_file_tool_schema());
        // Codex-format multi-file patch: preferred for precise / multi-file edits.
        // Jailed via jail_in_root, gated exactly like write_file/edit_file.
        base_tools.push(apply_patch_tool_schema());
        base_tools.push(list_files_tool_schema());
        // Native filesystem (browse/read the user's authorized folders), so this
        // fundamental capability isn't outsourced to a third-party MCP.
        base_tools.push(list_directory_tool_schema());
        base_tools.push(read_text_file_tool_schema());
        base_tools.push(run_in_project_tool_schema());
        // Addons (process-skills, ADR 0011) stay DORMANT until the post-release
        // addon phase: foundation wired but off by default (HOMUN_ADDONS=1).
        if addons_enabled() {
            base_tools.push(list_addons_tool_schema());
            base_tools.push(show_addon_tool_schema());
            base_tools.push(customize_addon_tool_schema());
        }
    }
    // NB: find_connected_tools is no longer offered separately — `find_capability` now
    // searches connectors too (unified discovery). The connectors still enter the corpus
    // below via `catalog_index` (gated by has_composio).
    if has_skills {
        base_tools.push(use_skill_tool_schema());
    }
    if !artifact_destinations.is_empty() && !read_only {
        base_tools.push(save_artifact_tool_schema(&artifact_destinations));
    }
    prune_tools_for_objective_policy(&mut base_tools, &objective_effect_policy, &composio_writes);
    prune_tools_for_route(&mut base_tools, &workflow_route, &workflow_deny_tools);
    // Tool Search (Anthropic pattern): split the full toolset into a SMALL always-loaded
    // CORE + a DEFERRED registry the model discovers via `find_capability`. Keeps the
    // upfront tool count low (selection accuracy + context budget) as tools grow, and makes
    // the browser a discovered last-resort instead of the silent catch-all. `find_capability`
    // pushes matches into the live `tool_schemas` (same mechanism as `find_connected_tools`).
    // One machine-derived exception (see `tool_stays_live_this_turn`): a thread with either a warm
    // browser session or an active revision-matched checkpoint is MID web task, so `browse` stays
    // live instead of requiring a discovery hop. This probe consumes neither state source.
    let browser_continuation_available = request
        .thread_id
        .as_deref()
        .is_some_and(|thread_id| thread_has_browser_continuation(state, thread_id));
    let (mut base_tools, deferred_tools): (Vec<serde_json::Value>, Vec<serde_json::Value>) =
        base_tools.into_iter().partition(|schema| {
            schema
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .map(|name| tool_stays_live_this_turn(name, browser_continuation_available))
                .unwrap_or(false)
        });
    match &capability_route {
        CapabilityRouteDecision::Workflow { tool_name, .. } => {
            if let Some(capability) = native_workflow_by_tool_name(tool_name) {
                base_tools.push((capability.schema)());
            }
        }
        CapabilityRouteDecision::AtomicTool { capability_key, .. } => {
            if let Some(capability) = native_atomic_by_key(capability_key) {
                base_tools.push((capability.schema)());
            }
            base_tools.push(find_capability_tool_schema());
        }
        CapabilityRouteDecision::AgentLoop { .. } => {
            base_tools.push(find_capability_tool_schema());
        }
    }
    // HITL Choice resume: strip cold discovery so the model cannot derail to
    // suggest_capabilities / CONNECT_SUGGEST. Warm state or a durable checkpoint keeps browse
    // live via tool_stays_live_this_turn; only a truly dead continuation permits rediscovery.
    if hitl_choice_resume.is_some() {
        let browser_continuation_available = request
            .thread_id
            .as_deref()
            .is_some_and(|tid| thread_has_browser_continuation(state, tid));
        hitl_resume::prune_cold_discovery_tools(&mut base_tools, !browser_continuation_available);
    }
    // MCP servers are installed deliberately and are few, so their tools go STRAIGHT
    // into the live tool set (not deferred behind find_capability) when the count is
    // small — the model uses them naturally instead of having to "discover" them via
    // a keyword search it rarely thinks to run. Past the cap they fall back to
    // find_capability like the large Composio catalog.
    const MCP_ALWAYS_LOAD_MAX: usize = 24;
    if !mcp_catalog.schemas.is_empty() && mcp_catalog.schemas.len() <= MCP_ALWAYS_LOAD_MAX {
        for schema in &mcp_catalog.schemas {
            base_tools.push(schema.clone());
        }
    }
    // Composio is the LARGE catalog (hundreds of tools) → kept behind find_capability,
    // but pre-retrieve the few relevant to THIS message and load them up front, so the
    // model uses them without having to think to search. Best-effort; deduped against
    // what's already loaded (core + always-loaded MCP).
    if has_composio && applies_new_input {
        let loaded: std::collections::HashSet<String> = base_tools
            .iter()
            .filter_map(|s| {
                s.pointer("/function/name")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect();
        for schema in auto_retrieve_composio(&state.http, &request.prompt, &catalog_index, 4).await
        {
            let name = schema
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !name.is_empty() && !loaded.contains(&name) {
                base_tools.push(schema);
            }
        }
    }
    prune_tools_for_objective_policy(&mut base_tools, &objective_effect_policy, &composio_writes);
    prune_tools_for_route(&mut base_tools, &workflow_route, &workflow_deny_tools);
    let capability_corpus = materialize_capability_corpus(CapabilityCorpusMaterializationInput {
        deferred_tools,
        read_only,
        objective_effect_policy: &objective_effect_policy,
        composio_writes: &composio_writes,
        mcp_schemas: &mcp_catalog.schemas,
        enabled_skills: &enabled_skills,
    });
    // Connectors are NOT flattened into the BM25 corpus: they're searched via the
    // toolkit-aware `search_composio_catalog` inside find_capability (returns a service's
    // full CRUD set together, so the model picks the right verb). The hits are still
    // converted to typed `CapabilityEntry` values before being surfaced.
    // Attachments (persistent): ingest NEW files off-runtime, PERSIST them on the
    // thread, then load the thread's FULL set so a file stays usable across turns
    // (no re-attach). A manifest lists the available files so the model uses their
    // content instead of improvising (sandbox / list_directory / download links).
    let new_files = if !applies_new_input || request.attachments.is_empty() {
        Vec::new()
    } else {
        let atts = request.attachments.clone();
        tokio::task::spawn_blocking(move || attachments::ingest_each(&atts))
            .await
            .unwrap_or_default()
    };
    let mut working: Vec<chat_store::StoredAttachment> = Vec::new();
    if applies_new_input && let Some(thread_id) = request.thread_id.as_deref() {
        // Persist new files + load the whole thread set (sync DB work, no await
        // while the lock is held).
        if let Ok(store) = lock_store(state) {
            for file in &new_files {
                let _ = store.upsert_thread_attachment(
                    thread_id,
                    &file.display_name,
                    &file.mime_type,
                    file.text.as_deref(),
                    &file.images,
                );
            }
            working = store.thread_attachments(thread_id).unwrap_or_default();
        }
    }
    // Guarantee THIS turn's files are present even if persistence failed / no thread.
    for file in &new_files {
        if !working.iter().any(|w| w.display_name == file.display_name) {
            working.push(chat_store::StoredAttachment {
                display_name: file.display_name.clone(),
                mime_type: file.mime_type.clone(),
                text: file.text.clone(),
                images: file.images.clone(),
            });
        }
    }

    let mut model_text = prompt.clone();
    let mut all_images = if applies_new_input {
        request.images.clone()
    } else {
        Vec::new()
    };
    let new_attachment_context = new_files
        .iter()
        .map(|file| chat_store::StoredAttachment {
            display_name: file.display_name.clone(),
            mime_type: file.mime_type.clone(),
            text: file.text.clone(),
            images: file.images.clone(),
        })
        .collect::<Vec<_>>();
    let attachment_context = if !applies_new_input || request.checkpoint_input.is_some() {
        &new_attachment_context
    } else {
        &working
    };
    all_images.extend(append_thread_attachment_context(
        &mut model_text,
        attachment_context,
    ));

    // Vision: when the turn carries images (request + rendered attachments), the
    // user message becomes multimodal content (text + image_url parts) per the
    // OpenAI-compatible schema; otherwise it stays a plain string.
    let user_content = if all_images.is_empty() {
        serde_json::Value::String(model_text.clone())
    } else {
        let mut parts = vec![serde_json::json!({ "type": "text", "text": model_text })];
        for url in &all_images {
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        }
        serde_json::Value::Array(parts)
    };
    // Built once here, then moved into `ls.messages` at the loop's start (the loop grows it).
    // `mut` because the vision policy below may swap the images out for a description (see
    // `vision::AttachmentPlan`) before the manager ever sees them.
    let mut messages = vec![
        serde_json::json!({ "role": "system", "content": system }),
        serde_json::json!({ "role": "user", "content": user_content }),
    ];

    let (mpsc_tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    // Resume registry entry: the generation records here so a reloaded client can
    // reattach to the in-flight answer (GET /api/chat/stream_resume/{id}).
    let (broadcast_tx, _) = tokio::sync::broadcast::channel::<String>(512);
    let stream_entry = std::sync::Arc::new(StreamEntry {
        lines: std::sync::Mutex::new(Vec::new()),
        tx: broadcast_tx,
        finished: std::sync::atomic::AtomicBool::new(false),
        last_event_at: std::sync::atomic::AtomicU64::new(now_epoch_secs()),
        thread_id: request.thread_id.clone(),
        assistant_message_id: std::sync::Mutex::new(None),
        outcome: std::sync::Mutex::new(None),
        outcome_ready: tokio::sync::Notify::new(),
    });
    let resume_id = request.request_id.clone();
    if let Ok(mut map) = stream_registry().lock() {
        map.insert(resume_id.clone(), stream_entry.clone());
    }
    let tx = StreamSink {
        mpsc: mpsc_tx,
        entry: stream_entry,
    };
    let orchestrator_is_local = provider_endpoint_is_local(&base_url) && !model_id_is_cloud(&model);
    let privacy_prompt = if applies_new_input {
        request.prompt.as_str()
    } else {
        ""
    };
    let deterministic_privacy_decision =
        privacy_guard::classify_sensitive_input_deterministic(privacy_prompt);
    let guarded_decision = if applies_new_input {
        match classify_sensitive_input_with_privacy_guard_model(&state.http, privacy_prompt).await {
            privacy_guard::PrivacyGuardModelOutcome::Classified(model_decision) => {
                Ok(privacy_guard::merge_guard_decisions(
                    privacy_prompt,
                    model_decision,
                    deterministic_privacy_decision.clone(),
                ))
            }
            privacy_guard::PrivacyGuardModelOutcome::Unavailable(reason) => Err(reason),
            privacy_guard::PrivacyGuardModelOutcome::InvalidOutput => Err("invalid_output"),
        }
    } else {
        Ok(deterministic_privacy_decision.clone())
    };
    let privacy_decision = match guarded_decision {
        Ok(decision) => decision,
        Err(reason) => match privacy_guard::failure_policy(orchestrator_is_local) {
            privacy_guard::PrivacyGuardFailurePolicy::DeterministicLocalOnly => {
                tracing::warn!(
                    target: "privacy::guard",
                    %reason,
                    "privacy guard unavailable; using deterministic local-only fallback"
                );
                deterministic_privacy_decision
            }
            privacy_guard::PrivacyGuardFailurePolicy::BlockAndRetry => {
                tracing::warn!(
                    target: "privacy::guard",
                    %reason,
                    "privacy guard unavailable; blocking remote inference"
                );
                let _ = emit_stream_event(
                    &tx,
                    GenerateStreamEvent::Error {
                        code: "privacy_guard_unavailable".to_string(),
                        message: "Privacy Guard non disponibile. Riprova senza inviare dati al provider remoto.".to_string(),
                        retryable: true,
                    },
                )
                .await;
                schedule_stream_registry_cleanup(resume_id.clone());
                let body =
                    Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
                        rx.recv().await.map(|item| (item, rx))
                    }));
                return Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/x-ndjson")
                    .header("x-effective-model", "privacy_guard")
                    .body(body)
                    .expect("valid streaming response"));
            }
        },
    };
    if let Some(intercept) = privacy_guard::build_privacy_guard_intercept(
        &state.pending_vault_proposals,
        &request.request_id,
        &privacy_decision,
    ) {
        // The two failure branches above log; the branch that actually REWRITES the user's message
        // did not — and that is the common one. A false positive (an ordinary path or word read as a
        // credential) therefore silently changed what the model was asked, with nothing in the log to
        // explain the odd answer. Categories/kinds only — never the matched value.
        tracing::warn!(
            target: "privacy::guard",
            detections = privacy_decision.items.len(),
            kinds = %privacy_decision
                .items
                .iter()
                .map(|item| format!("{}:{}", item.category, item.kind))
                .collect::<Vec<_>>()
                .join(","),
            "privacy guard intercepted the turn (user text rewritten)"
        );
        // Privacy Guard runs before the agent loop: the raw secret must not reach
        // the main chat model or the committed user transcript. The actual value
        // lives only in the pending sidecar until the user accepts with the PIN.
        let _ = emit_stream_event(
            &tx,
            GenerateStreamEvent::Done {
                text: intercept.assistant_text,
                metrics: TokenMetrics::zero(),
                redacted_user_text: Some(intercept.user_text),
            },
        )
        .await;
        schedule_stream_registry_cleanup(resume_id.clone());
        let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
            rx.recv().await.map(|item| (item, rx))
        }));
        return Ok(Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/x-ndjson")
            .header("x-effective-model", "privacy_guard")
            .body(body)
            .expect("valid streaming response"));
    }

    // Vision: this turn carries images, so decide WHO is allowed to look at them before the loop
    // starts — the manager itself, a vision model standing in for it, or nobody. The manager's model
    // never changes (ADR 0025 retired the mid-turn model switch); what changes is what reaches it.
    let vision_fallback_armed = if vision::messages_have_image(&messages) {
        match vision::plan_attachments(model_vision_support(&base_url, &model), has_vision_model())
        {
            // Known-blind manager and nobody to read for it. Say so — shipping the image to a provider
            // that will reject it, and calling the rejection an answer, is what we're here to stop.
            vision::AttachmentPlan::Refuse => {
                let _ = emit_stream_event(
                    &tx,
                    GenerateStreamEvent::Done {
                        text: vision::no_vision_model_message(&model),
                        metrics: TokenMetrics::zero(),
                        redacted_user_text: None,
                    },
                )
                .await;
                schedule_stream_registry_cleanup(resume_id.clone());
                let body =
                    Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
                        rx.recv().await.map(|item| (item, rx))
                    }));
                return Ok(Response::builder()
                    .status(StatusCode::OK)
                    .header("content-type", "application/x-ndjson")
                    .header("x-effective-model", "vision")
                    .body(body)
                    .expect("valid streaming response"));
            }
            // Known-blind manager, but a vision model can stand in: it looks at the image and its
            // description takes the image's place. Same message, same position — only the modality
            // changed, and the manager keeps its own model, tools and context.
            vision::AttachmentPlan::Delegate => {
                let readers = vision_model_candidates();
                let images = vision::collect_image_urls(&messages);
                let descriptions =
                    vision::describe_images(&state.http, &readers, &images, &prompt).await;
                vision::replace_images_with_descriptions(&mut messages, &descriptions);
                false
            }
            // Sent inline, as before. The difference is only whether a vision model exists to rescue
            // the turn should the provider refuse the image anyway (see `run_agent_rounds`).
            vision::AttachmentPlan::InlineWithFallback => true,
            vision::AttachmentPlan::Inline => false,
        }
    } else {
        false
    };

    // Dedicated STREAMING client: HTTP/1.1 (avoids HTTP/2 RST_STREAM that CDNs in
    // front of cloud model hosts can throw on long streams) + no idle connection
    // reuse (a stale pooled keep-alive connection is a classic cause of the
    // intermittent "error decoding response body" mid/early stream). Falls back to the
    // shared pooled client if the builder fails.
    let http = reqwest::Client::builder()
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap_or_else(|_| state.http.clone());
    let state_owned = state.clone();
    let temperature = request.temperature;
    let execution_journal = agent_journal::for_run(request.agent_run_id.as_deref());
    let effect_run_id = request.agent_run_id.clone();
    let effect_turn_id = request.agent_run_id.as_ref().and_then(|_| {
        request
            .request_id
            .strip_prefix("broker-")
            .map(str::to_string)
    });
    // Thread this chat belongs to: lets browser work reuse a persistent
    // per-thread browser session (search → then book on the same tab).
    let thread_id = request.thread_id.clone();
    let automation_user_id = gateway_user_id();
    let automation_workspace_id = thread_id
        .as_deref()
        .and_then(|tid| {
            lock_store(state)
                .ok()
                .and_then(|store| store.workspace_for_thread(tid).ok())
        })
        .map(WorkspaceId::new)
        .unwrap_or_else(gateway_workspace_id);
    // Raw user message captured for post-turn memory extraction (M2).
    let memory_user_message = if applies_new_input {
        request.prompt.clone()
    } else {
        String::new()
    };
    // The assistant's most recent prior turn (the question a short "sì" would answer),
    // so the extractor can ground a confirmation into the fact it commits.
    let memory_prev_assistant = effective_context
        .iter()
        .rev()
        .find(|m| matches!(m.role, ChatContextRole::Assistant))
        .map(|m| m.text.clone());
    // F4: resume an interrupted long task on the CANONICAL plan so the turn continues on
    // the same authoritative state (done steps stay done) instead of RESTARTING. Prefer the
    // durable per-thread runtime-plan store (upserted on every plan call, survives even when
    // the prior turn hasn't yet persisted its ‹‹PLAN›› marker into this turn's context) —
    // reading only the context marker made a continuation turn resume 0 steps and revert
    // done→doing (the "il piano riparta" symptom). Fall back to the context marker for a
    // thread-less turn or a store miss.
    let (mut resume_plan, resume_goal): (Vec<serde_json::Value>, Option<String>) = {
        let from_store = runtime_plan_record_from_state(state, thread_id.as_deref());
        if let Some((goal, steps)) = from_store
            && !steps.is_empty()
        {
            (steps, goal)
        } else {
            // A marker-resumed plan carries no goal line (it was never part of the checklist
            // grammar) — without a durable goal the canonical plan starts goal-less.
            let steps = effective_context
                .iter()
                .rev()
                .find(|m| m.text.contains("‹‹PLAN››"))
                .map(|m| parse_plan_marker(&m.text))
                .unwrap_or_default();
            (steps, None)
        }
    };
    // F4: a RESUMED plan that closes no new step across turns is stuck (the per-turn recovery
    // counters reset each turn, so the same failing step retries forever). After the cap the
    // harness BLOCKS the stuck step (caposaldo #2) — `block_stalled_step` makes the plan
    // `settled`, so `upsert_runtime_plan_memory` stops it auto-resuming. Gated until validated
    // live; the bookkeeping is a no-op when off.
    if applies_new_input && !resume_plan.is_empty() && plan_stall_abort_enabled() {
        let stalled = runtime_plan_control_scope(state, thread_id.as_deref()).is_some_and(
            |(user_id, workspace_id, thread_id)| {
                plan_stall_check_and_bump(
                    state.task_store.as_ref(),
                    &user_id,
                    &workspace_id,
                    &thread_id,
                    &resume_plan,
                )
            },
        );
        if stalled && let Some(title) = block_stalled_step(&mut resume_plan) {
            upsert_runtime_plan_memory_from_state(
                state,
                thread_id.as_deref(),
                resume_goal.as_deref(),
                &resume_plan,
            );
            if verbose_debug() {
                eprintln!(
                    "[plan] F4: blocked stalled step after {MAX_PLAN_STALL_RESUMES} no-progress resumes: «{title}»"
                );
            }
        }
    }
    let capability_route_for_runtime = capability_route.clone();
    let abort_resume_id = resume_id.clone();
    let engine_task = tokio::spawn(async move {
        let mut ls = local_first_engine::LoopState::new();
        ls.prompt_packets = prompt_packets;
        ls.messages = messages;
        if applies_new_input {
            seed_loop_memory_reads(&mut ls, automatic_recall_payload.as_ref());
        }
        // RAG completed before the loop starts. Publish the exact selected hits before any
        // narration delta so a resumed client and the persisted assistant message agree on
        // which memory sources informed this turn.
        if applies_new_input && let Some(payload) = automatic_recall_payload {
            let _ = emit_stream_event(&tx, GenerateStreamEvent::Recall { payload }).await;
        }
        // Phase 3 (per-project skill confirmations): seed the turn's force-confirm set with the
        // workspace's configured categories so an effectful action is gated even with NO
        // sensitive skill loaded. Fail-safe — this only ADDS to `active_sensitive`; the loop
        // later unions per-skill categories via `ToolEffects::arm_sensitive`. `merged_sensitive`
        // dedups the (empty-at-init) skill set with the project set.
        {
            let existing: Vec<crate::skills::SensitiveCategory> = ls
                .active_sensitive
                .iter()
                .filter_map(|t| crate::skills::SensitiveCategory::parse(t))
                .collect();
            let project_sensitive =
                resolved_skill_confirmations(&state_owned, thread_id.as_deref());
            ls.active_sensitive = merged_sensitive(&existing, &project_sensitive)
                .iter()
                .map(|cat| cat.as_token().to_string())
                .collect();
        }
        // Last upstream model error this turn (e.g. a 410 "model retired"), already
        // human-readable. Surfaced as the final answer if the turn produces no text,
        // so a dead/blocked model is obvious instead of a generic "no answer".
        let last_model_error: Option<String> = None;
        // Final answer text captured for post-turn memory extraction (M2).
        let memory_answer = String::new();
        // Consequential actions performed this turn (any domain) → fed to the
        // memory extractor so the "why" of each mutation is remembered.
        if let Some(route_line) = capability_route_trace_line(&capability_route_for_runtime) {
            ls.tool_trace.push(route_line.clone());
            let _ = emit_stream_event(
                &tx,
                GenerateStreamEvent::Delta {
                    text: format!("‹‹ACT››🧭 {route_line}‹‹/ACT››"),
                },
            )
            .await;
        }
        // No-progress guard: if the model repeats the EXACT same tool calls round after
        // round, it's stuck (not making progress) → stop and synthesize, instead of
        // burning the whole round budget on a loop. This is what lets the budget be
        // generous: real long tasks run, loops are caught fast.
        let final_done = false;
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
        // P5: carried as an opaque `Value` in `LoopState` (engine-safe); seeded here from the resume.
        ls.plan = canonical_plan_value(resume_goal.as_deref(), &resume_plan);
        if verbose_debug() {
            let done = resume_plan
                .iter()
                .filter(|s| s.get("status").and_then(|v| v.as_str()) == Some("done"))
                .count();
            eprintln!(
                "[plan] turn-start: resumed {} steps ({done} done) from prior ‹‹PLAN›› marker",
                resume_plan.len()
            );
        }

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
        let plan_nudges: u32 = 0;
        // Slice 2.5: did the model actually ACT (use a tool) this turn? Used at the no-tool
        // stop to tell a PREMATURE stop on a real task (judge it, bootstrap a plan) apart from
        // a plain conversational answer (let it end). Latches true once any tool has run.
        let turn_used_tools = false;
        // Source URLs visited via browse_web this request, for the "Fonti" footer.
        let browse_sources: Vec<String> = Vec::new();
        // Tools offered to the model this run: the base set, plus any tools the
        // model discovers via `find_connected_tools` (injected on demand).
        ls.tool_schemas = base_tools;
        // "Chiedi" mode: pure conversation — no tools, no actions.
        if mode == "ask" {
            ls.tool_schemas.clear();
        }
        // Contact perimeter tool filter (channel turns): denied wins, then the
        // allowlist (if non-empty) narrows further. Substring match on the function
        // name, composed ON TOP of the channel read-only policy.
        if let Some(cx) = &contact_ctx {
            let denied = &cx.perimeter.tools_denied;
            let allowed = &cx.perimeter.tools_allowed;
            if !denied.is_empty() || !allowed.is_empty() {
                let mut dropped: Vec<String> = Vec::new();
                ls.tool_schemas.retain(|schema| {
                    let name = schema
                        .pointer("/function/name")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if denied.iter().any(|d| name.contains(d.as_str())) {
                        dropped.push(name.to_string());
                        return false;
                    }
                    // An allowlist narrows CAPABILITIES, not the loop's own machinery. Applied to
                    // everything, a perimeter allowing only e.g. "calendar" also deleted update_plan,
                    // step_advance, find_capability and recall_memory — so the turn lost the ability to
                    // plan, to discover what it may use, and to read memory, for a reason that has
                    // nothing to do with the contact's perimeter. Harness tools stay unless explicitly
                    // denied above.
                    if !allowed.is_empty()
                        && !HARNESS_CONTROL_TOOLS.contains(&name)
                        && !allowed.iter().any(|a| name.contains(a.as_str()))
                    {
                        dropped.push(name.to_string());
                        return false;
                    }
                    true
                });
                if !dropped.is_empty() {
                    // Was entirely silent: a turn could lose tools with nothing to explain why the
                    // model then said it could not do something it normally can.
                    tracing::warn!(
                        target: "perimeter::tools",
                        dropped = %dropped.join(","),
                        "contact perimeter withheld tools from this turn"
                    );
                }
            }
        }
        // Turn-local browser state now lives in the browser subsystem: the loop-visible fields
        // (browser_used / pending_browser_image / browser_tool_call_ids) travel in `LoopState`
        // (slice 5a), and the browser-private state (sidecar session, last snapshot, current tab /
        // opened targets, per-URL nav failures) is OWNED by `GatewayBrowserExecutor`, constructed
        // inside `run_agent_rounds` (slice 5b). Nothing to seed here.
        // Fresh terminal buffer for this request; the computer panel shows the
        // CLI commands + output run during THIS response.
        sandbox_clear(thread_id.clone());

        // F3: the first plan step's work begins after the initial context is in place.
        ls.step_messages_start = ls.messages.len();

        // F0 / model-io: detect+cache this Ollama model's capability profile (thinking, tools,
        // vision, context window) via one /api/show, so the harness can ADAPT — send `think`
        // only to thinking models, and (future) gate tools/images and budget on the real
        // context. The thinking gate in `build_chat_payload` reads this cache.
        if is_ollama_base(&base_url) {
            warm_ollama_capabilities(&http, &base_url, &model).await;
        }

        // The concrete model seam (ADR 0024): borrows the turn's client + sink for the loop.
        // The outer ceiling is the BROWSER budget; the EFFECTIVE budget is dynamic
        // (the normal 5 rounds until a browser tool is actually used, then the
        // larger browser budget). This keeps non-browser turns identical to today.
        // ADR 0026: provider binding travels with LoopState (per-round swap), not as separate args.
        ls.provider = local_first_engine::ProviderBinding {
            model,
            base_url,
            api_key,
        };
        let checkpoint_input = request
            .checkpoint_input
            .as_ref()
            .and_then(|_| ls.messages.last().cloned());
        apply_agent_recovery_checkpoint(&mut ls, recovery_checkpoint, checkpoint_input);
        // 5.D1c.1: resolve the loop's turn-constant config ONCE (env-stable for the turn) so the moved
        // loop never reads env. Behavior-preserving — same values the inline getters returned.
        let cfg = local_first_engine::TurnConfig {
            hard_round_ceiling: hard_round_ceiling(),
            max_rounds: chat_max_rounds(),
            browser_max_rounds: chat_browser_max_rounds(),
            browser_nav_cap: chat_browser_nav_cap(),
            // The MANAGER budget, not the shared one: its absolute wall clock must outlive the
            // `browse` sub-turns it delegates (see `manager_browser_max_elapsed_ms`), otherwise a
            // multi-phase task — search → choose → book, one browse per phase — is cut mid-flight
            // while every single delegation succeeded.
            browser_budget: chat_manager_browser_budget(),
            // Fase 1.1: the model's real context window (catalog `context_window`, resolved above)
            // drives token-budget auto-compaction. `None` → fail-open (no budget compaction).
            context_window: model_context_window,
            reconcile_on_delivery: plan_reconcile_on_delivery_enabled(),
            autoadvance_from_evidence: plan_autoadvance_from_evidence_enabled(),
            step_verification: step_verification_enabled(),
            verbose: verbose_debug(),
            // S2 T5: resolved above from (routing_binding, Forcing::Specific, turn-index).
            forced_tool: forced_tool.clone(),
            // E2: this is the manager (chat) turn, NOT the browse sub-turn. Its browser tool set
            // (`browser_registry_cached_tools`) deliberately excludes `browser_done` — reaching this
            // turn's dispatcher is a hallucination — so the terminal must stay disarmed here.
            browser_subturn: false,
            resolved_hitl: hitl_choice_resume.as_ref().map(|ctx| {
                local_first_engine::hitl::ResolvedHitlGuard {
                    envelope: local_first_engine::hitl::HitlEnvelope {
                        kind: match ctx.wait.kind {
                            hitl_resume::HitlWaitKind::Choice => {
                                local_first_engine::hitl::HitlKind::Choice
                            }
                            hitl_resume::HitlWaitKind::Clarify => {
                                local_first_engine::hitl::HitlKind::Clarify
                            }
                        },
                        hold_policy: local_first_engine::hitl::HoldPolicy::Free,
                        payload: ctx.wait.payload.clone(),
                        source_marker: "durable_resume".to_string(),
                    },
                    resolution: ctx.resolution.clone(),
                }
            }),
        };
        // 5.D1c.8: the post-turn tail (memory learn + code-graph refresh) is a GATEWAY concern, so it
        // runs HERE after the engine turn returns. Snapshot what it needs before the turn consumes the
        // owned values (AppState is a cheap Arc clone; the strings are small).
        let tail_state = state_owned.clone();
        let tail_user = memory_user_message.clone();
        let tail_thread = thread_id.clone();
        let tail_turn_id = request.request_id.clone();
        // Snapshots for the end-of-turn steering fence below: the originals are moved into
        // `run_agent_rounds` (and `tail_turn_id` into the memory-learn spawn).
        let fence_turn_id = request.request_id.clone();
        let fence_user_id = automation_user_id.clone();
        let fence_workspace_id = automation_workspace_id.clone();
        let canonical_broker_turn = effect_turn_id.is_some();
        // 5.D1c.9: resolve the trace-dump dir gateway-side (armed only when HOMUN_TRACE_DUMP=1) and
        // inject it, so the engine loop appends without calling the gateway's path resolver.
        let trace_dir = local_first_engine::trace::dump_enabled()
            .then(gateway_logs_dir)
            .and_then(Result::ok);
        let outcome = run_agent_rounds(
            ls,
            &tx,
            http,
            state_owned,
            temperature,
            prompt,
            thread_id,
            read_only,
            autonomous,
            channel_owner,
            contact_only,
            can_see_contacts,
            can_see_calendar,
            can_use_project_memory,
            memory_recall_allowed,
            memory_intent.vault_value_requested,
            memory_user_message,
            memory_answer,
            last_model_error,
            final_done,
            plan_nudges,
            turn_used_tools,
            composio_writes,
            catalog_index,
            capability_corpus,
            capability_route_for_runtime,
            automation_user_id,
            automation_workspace_id,
            browse_sources,
            cfg,
            trace_dir,
            execution_journal,
            effect_turn_id,
            effect_run_id,
            &turn_trace,
            vision_fallback_armed,
        )
        .await;
        if !canonical_broker_turn
            && let (Some(thread_id), Some(assistant_message_id)) = (
                tail_thread.as_deref(),
                tx.entry
                    .assistant_message_id
                    .lock()
                    .ok()
                    .and_then(|id| id.clone()),
            )
            && let Err(error) = persist_hitl_wait_from_outcome(
                &tail_state,
                thread_id,
                &assistant_message_id,
                &outcome,
            )
        {
            eprintln!("[hitl] legacy turn projection failed: {error}");
        }
        // Turn trace: the final record. `outcome.memory_answer` is the committed answer; `final_plan` is
        // the turn's last runtime plan (carried out for exactly this). The derived flags (incomplete
        // steps, artifact claimed-but-absent) are the high-value signal. Observability only.
        {
            let final_steps = plan_value_steps(&outcome.final_plan);
            let plan_final: Vec<String> = final_steps
                .iter()
                .map(|s| plan_step_status(s).to_string())
                .collect();
            let plan_titles: Vec<String> = final_steps
                .iter()
                .map(|s| plan_step_title(s).to_string())
                .collect();
            let artifact_count = outcome.memory_answer.matches("‹‹ARTIFACT››").count();
            let signals = local_first_engine::turn_trace::answer_signals(
                &outcome.memory_answer,
                artifact_count,
            );
            let derived =
                local_first_engine::turn_trace::derive_flags(&plan_final, &plan_titles, &signals);
            turn_trace.record(local_first_engine::turn_trace::TurnEvent::TurnEnd {
                final_len: outcome.memory_answer.chars().count(),
                plan_final,
                signals,
                derived,
            });
        }
        // M2: mine this exchange for durable personal memory (fire-and-forget, off the response path).
        // Best-effort; never blocks or fails the turn. Skip for channel turns (read_only): the inbound
        // is from a CONTACT, not the user, and the channel handler runs its own speaker-attributed learn
        // — this one (speaker=None) would mis-attribute the contact's facts to person:self.
        if applies_new_input && !outcome.memory_answer.trim().is_empty() && !read_only {
            let learn_state = tail_state.clone();
            let learn_user = tail_user;
            let learn_answer = outcome.memory_answer.clone();
            let learn_thread = tail_thread.clone();
            let learn_actions = outcome.tool_actions.clone();
            let learn_prev = memory_prev_assistant.clone();
            let learn_envelope = memory_reuse_envelope_from_read_set(&outcome.memory_reads);
            tokio::spawn(async move {
                learn_via_service_or_inline(
                    &learn_state,
                    &learn_user,
                    &learn_answer,
                    &learn_actions,
                    learn_thread.as_deref(),
                    Some(&tail_turn_id),
                    None,
                    learn_prev.as_deref(),
                    learn_envelope,
                )
                .await;
            });
        }
        // Keep the code map FRESH on every turn in a mapped project — driven by GIT, not by who edited:
        // spawn_project_graph_refresh re-extracts only if the git fingerprint changed since the last
        // build, so it catches the AGENT's writes AND the user's own editor edits (and checkout/pull),
        // while being a cheap no-op when nothing changed. Only refreshes already-mapped projects.
        if !read_only
            && let Some(ws) = tail_thread
                .as_deref()
                .and_then(|tid| {
                    lock_store(&tail_state)
                        .ok()
                        .and_then(|s| s.workspace_for_thread(tid).ok())
                })
                .filter(|w| !w.trim().is_empty())
        {
            spawn_project_graph_refresh(&tail_state, &ws);
        }
        // INVARIANT — nothing transient outlives its turn. This runs on EVERY exit of the turn task
        // (delivered, parked, error, abort), because the failure it prevents is not tied to any one
        // outcome: a steering row still `pending` when its turn ends can never be applied (the turn it
        // targeted is gone), but the next turn's finalization fence still sees PendingInput, waits its
        // budget and PARKS — so one uninterpretable instruction silently broke every following turn in
        // the thread. Resources with their own lifetime (the thread's warm browser session, reused for
        // "search → then book") are deliberately NOT touched here; they are owned per thread and reaped
        // on idle/close.
        finalize_turn_steering(
            &tail_state,
            tail_thread.as_deref(),
            &fence_turn_id,
            &fence_user_id,
            &fence_workspace_id,
        );
        publish_stream_outcome(&tx.entry, outcome);
        // Mark the resume entry finished and evict it after a grace window so a
        // client that reloaded right at the end can still reattach and read it.
        tx.entry
            .finished
            .store(true, std::sync::atomic::Ordering::Relaxed);
        schedule_stream_registry_cleanup(resume_id.clone());
    });
    if let Ok(mut map) = stream_abort_registry().lock() {
        map.insert(abort_resume_id, engine_task.abort_handle());
    }

    let body = Body::from_stream(futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    }));
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/x-ndjson")
        .body(body)
        .expect("valid streaming response"))
}

fn apply_agent_recovery_checkpoint(
    state: &mut local_first_engine::LoopState,
    checkpoint: Option<local_first_engine::LoopCheckpoint>,
    new_input: Option<serde_json::Value>,
) {
    if let Some(checkpoint) = checkpoint {
        checkpoint.apply_to(state);
        if let Some(new_input) = new_input {
            state.messages.push(new_input);
        }
    }
}

/// Build the terminal outcome for an image rejection that has already been surfaced with `Done`.
/// Keeping this pure makes the stream event and outcome delivery state move together.
fn delivered_image_rejection_outcome(
    mut outcome: local_first_engine::TurnOutcome,
    rejection: String,
) -> local_first_engine::TurnOutcome {
    outcome.memory_answer = rejection;
    outcome.stop = local_first_engine::TurnStop::Completed;
    outcome
}

// ADR 0024 inc 5 (5.D1a): the agent turn's round loop + forced synthesis + post-turn
// learn, extracted VERBATIM from the tokio::spawn body of stream_chat_via_openai. The
// signature (the captured turn state) is what becomes engine::run_turn's interface at 5.D1c.
#[allow(clippy::too_many_arguments)]
async fn run_agent_rounds(
    ls: local_first_engine::LoopState,
    tx: &StreamSink,
    http: reqwest::Client,
    state_owned: AppState,
    temperature: f64,
    prompt: String,
    thread_id: Option<String>,
    read_only: bool,
    autonomous: bool,
    channel_owner: bool,
    contact_only: bool,
    can_see_contacts: bool,
    can_see_calendar: bool,
    can_use_project_memory: bool,
    memory_recall_allowed: bool,
    vault_value_requested: bool,
    memory_user_message: String,
    memory_answer: String,
    last_model_error: Option<String>,
    final_done: bool,
    plan_nudges: u32,
    turn_used_tools: bool,
    composio_writes: std::collections::BTreeSet<String>,
    catalog_index: Vec<(String, String, serde_json::Value)>,
    capability_corpus: Vec<CapabilityEntry>,
    capability_route_for_runtime: CapabilityRouteDecision,
    automation_user_id: UserId,
    automation_workspace_id: WorkspaceId,
    browse_sources: Vec<String>,
    cfg: local_first_engine::TurnConfig,
    // 5.D1c.9: the armed trace-dump dir (gateway-resolved `~/.homun/logs`), or None when the dump is
    // disarmed / the dir won't resolve. The engine appends here instead of calling `gateway_logs_dir`.
    trace_dir: Option<std::path::PathBuf>,
    execution_journal: agent_journal::GatewayJournal,
    effect_turn_id: Option<String>,
    effect_run_id: Option<String>,
    // Readable per-turn observability sink (ported): passed into the capability executor (Plan event)
    // and into `run_turn` (the in-loop events). No-op when disabled. See `engine::turn_trace`.
    turn_trace: &local_first_engine::turn_trace::TurnTrace,
    // The turn is sending images to a model on a guess (`AttachmentPlan::InlineWithFallback`), and a
    // vision model exists to describe them if the provider refuses. Passed rather than re-derived here:
    // the policy is decided ONCE, in `vision::plan_attachments`, and this is its consequence.
    vision_fallback_armed: bool,
) -> local_first_engine::TurnOutcome {
    // Build the seams `engine::run_turn` runs against — thin gateway adapters over AppState/transport/
    // stores, constructed ONCE per turn from this turn's context (ADR 0024/0026). model_client borrows
    // http+tx locally; the tool chokepoints hold the turn-constant read-only context and get `&mut ls`
    // per call from the engine.
    let steering_context = match (thread_id.as_deref(), effect_turn_id.as_deref()) {
        (Some(thread_id), Some(turn_id)) => Some(crate::model_client::GatewaySteeringContext {
            state: &state_owned,
            user_id: automation_user_id.as_str(),
            workspace_id: automation_workspace_id.as_str(),
            thread_id,
            turn_id,
            run_id: effect_run_id.as_deref().unwrap_or(turn_id),
        }),
        _ => None,
    };
    let model_client = crate::model_client::GatewayModelClient {
        http: &http,
        tx,
        usage: state_owned.usage_recorder.as_ref(),
        steering: steering_context,
    };
    let mut usage_context = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::ChatResponse,
        automation_user_id.as_str(),
    );
    usage_context.workspace_id = Some(automation_workspace_id.as_str().to_string());
    usage_context.thread_id = thread_id.clone();
    usage_context.turn_id = effect_turn_id.clone();
    usage_context.run_id = effect_run_id.clone();
    let effect_contract = effect_turn_id.as_deref().and_then(|execution_id| {
        state_owned
            .task_store
            .lock()
            .ok()?
            .execution(execution_id)
            .ok()
            .flatten()
            .map(|record| record.contract)
    });
    let capability_executor = GatewayCapabilityExecutor {
        state: &state_owned,
        tx,
        thread_id: thread_id.as_deref(),
        read_only,
        contact_only,
        can_see_contacts,
        can_see_calendar,
        can_use_project_memory,
        memory_recall_allowed,
        vault_value_requested,
        autonomous,
        composio_writes: &composio_writes,
        catalog_index: &catalog_index,
        capability_corpus: &capability_corpus,
        automation_user_id: &automation_user_id,
        automation_workspace_id: &automation_workspace_id,
        // ADR 0025: turn-constants for a recursive `browse(goal)` sub-turn (used only when the manager
        // calls the `browse` tool; inert otherwise).
        prompt: &prompt,
        channel_owner,
        turn_trace,
        turn_id: effect_turn_id.as_deref(),
        run_id: effect_run_id.as_deref(),
        execution_contract: effect_contract.as_ref(),
    };
    // The browser tool chokepoint (ADR 0025 seam): OWNS the browser subsystem's private state (session +
    // snapshot/tab/nav bookkeeping); `&mut` because run_turn mutates it per browser call.
    let mut browser_executor = GatewayBrowserExecutor {
        browser_session: None,
        last_snapshot: String::new(),
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
        read_only,
        channel_owner,
        // C2: the manager turn's own registered journal — same handle `run_turn` below receives via
        // `&execution_journal`, so protocol metrics from a manager-level browser call land in the same
        // run as everything else this turn records.
        journal: execution_journal.clone(),
        execution_contract: effect_contract.clone(),
        effect_run_id: effect_run_id.clone(),
        turn_id: effect_turn_id.clone(),
        step_memory: None,
        auto_screenshot: false,
        screenshot_on_stall: false,
        consecutive_snapshot_count: 0,
        recent_action_signatures: std::collections::VecDeque::new(),
        recent_failed_action_families: std::collections::VecDeque::new(),
    };
    let plan_progress = GatewayPlanProgress {
        state: state_owned.clone(),
    };
    let compactor = GatewayContextCompactor {
        state: state_owned.clone(),
        thread_id: thread_id.clone(),
    };
    let turn_policy = GatewayTurnPolicy::new(capability_route_for_runtime);
    let completion_judge = GatewayTurnCompletionJudge::new(state_owned.clone());

    // Vision fallback (`AttachmentPlan::InlineWithFallback`): this turn's images ride the manager's
    // first call on nothing better than a catalog's opinion. Keep the turn's PRISTINE seed so we can
    // replay it: a provider that refuses to look at the images kills the turn before it has streamed a
    // token or run a tool (`TurnOutcome::image_rejection` — see the engine's early return), so we can
    // describe them on the vision role and re-run from a conversation the manager can actually read.
    // The user gets one answer, not a 400 followed by an apology. Cloning the seed is cheap (2
    // messages) and happens only for image turns that have a vision model to fall back on.
    let vision_seed = vision_fallback_armed.then(|| {
        (
            ls.clone(),
            cfg.clone(),
            memory_user_message.clone(),
            memory_answer.clone(),
            last_model_error.clone(),
            browse_sources.clone(),
            trace_dir.clone(),
        )
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
        &turn_policy,
        &execution_journal,
        tx,
        temperature,
        thread_id.as_deref(),
        &composio_writes,
        &catalog_index,
        memory_user_message,
        memory_answer,
        last_model_error,
        final_done,
        plan_nudges,
        turn_used_tools,
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

    let Some((
        mut seed_ls,
        seed_cfg,
        seed_user_msg,
        seed_answer,
        seed_error,
        seed_sources,
        seed_trace,
    )) = vision_seed
    else {
        // The model can't read the image and we have nobody to read it for us. The turn emitted
        // nothing, so this is its answer — the one case where the provider's refusal is the honest
        // thing to show.
        let _ = emit_stream_event(
            tx,
            GenerateStreamEvent::Done {
                text: rejection.clone(),
                metrics: TokenMetrics::zero(),
                redacted_user_text: None,
            },
        )
        .await;
        return delivered_image_rejection_outcome(outcome, rejection);
    };

    let readers = vision_model_candidates();
    if readers.is_empty() {
        // Armed at seed time but gone now (the role was cleared mid-turn) — same dead end.
        let _ = emit_stream_event(
            tx,
            GenerateStreamEvent::Done {
                text: rejection.clone(),
                metrics: TokenMetrics::zero(),
                redacted_user_text: None,
            },
        )
        .await;
        return delivered_image_rejection_outcome(outcome, rejection);
    }

    // Recover: describe the images the manager was refused, put the text where they were, run again.
    let images = vision::collect_image_urls(&seed_ls.messages);
    let descriptions = vision::describe_images(&http, &readers, &images, &prompt).await;
    vision::replace_images_with_descriptions(&mut seed_ls.messages, &descriptions);

    local_first_engine::agent_loop::run_turn(
        seed_ls,
        seed_cfg,
        &usage_context,
        &model_client,
        &capability_executor,
        &mut browser_executor,
        &plan_progress,
        &completion_judge,
        &compactor,
        &turn_policy,
        &execution_journal,
        tx,
        temperature,
        thread_id.as_deref(),
        &composio_writes,
        &catalog_index,
        seed_user_msg,
        seed_answer,
        seed_error,
        final_done,
        plan_nudges,
        turn_used_tools,
        seed_sources,
        seed_trace,
        turn_trace,
    )
    .await
}

#[derive(Debug, Clone)]
struct VisibleConversationTurn {
    turn_id: String,
    user_message_id: String,
    assistant_message_id: String,
}

fn thread_turn_started_event(
    thread_id: &str,
    workspace: &str,
    source: &str,
    channel: Option<&str>,
    title: &str,
    turn: &VisibleConversationTurn,
) -> serde_json::Value {
    let mut event = serde_json::json!({
        "type": "thread.turn_started",
        "thread_id": thread_id,
        "workspace": workspace,
        "source": source,
        "title": title,
        "turn_id": turn.turn_id,
        "user_message_id": turn.user_message_id,
        "assistant_message_id": turn.assistant_message_id,
    });
    if let Some(channel) = channel {
        event["channel"] = serde_json::Value::String(channel.to_string());
    }
    event
}

/// A store error a retry (fresh transaction) can plausibly clear: SQLite BUSY/LOCKED
/// under the unified homun.sqlite/WAL when another writer is active. `busy_timeout`
/// handles pure busy-waiting, but a write-write snapshot conflict returns immediately —
/// only re-running the transaction (not waiting) resolves it.
fn is_transient_store_error(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(e, _)
            if matches!(
                e.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            )
    )
}

#[allow(clippy::too_many_arguments)]
fn start_visible_conversation_turn(
    state: &AppState,
    thread_id: &str,
    workspace: &str,
    source: &str,
    channel: Option<&str>,
    title: &str,
    user_text: &str,
    // When the broker's atomic enqueue already persisted a tree-linked prompt
    // (`local_user_{request_id}`), REUSE its id here so `commit_prompt_result`'s
    // INSERT OR IGNORE no-ops on it instead of minting a second `msg_...` row.
    // `None` for the inline paths (channel / automation / approval) that have no
    // pre-seeded message and must mint a fresh id.
    preseeded_user_message_id: Option<&str>,
    // The assistant placeholder is preallocated with the user prompt by broker
    // enqueue. Reusing this stable id across worker attempts prevents duplicate
    // assistant bubbles after a retry.
    preseeded_assistant_message_id: Option<&str>,
    // The broker turn id (`turn_{request_id}` = the task id) to advertise in the
    // `thread.turn_started` event. This is the SAME id the live WS `turn.event` fan-out and
    // the resumable turn stream key on, so a client that receives the event can attach to the
    // running turn (live island + transcript) — including a channel turn it never launched.
    // `None` for legacy inline paths with no broker task: they mint a throwaway id (nothing
    // downstream joins on the visible turn_id, so it stays cosmetic for those).
    turn_id_override: Option<&str>,
    // A persisted-bubble executor (currently proactive automation) owns this
    // assistant from creation, so an inline action card can later resolve the
    // exact waiting task without guessing from thread state.
    linked_task_id: Option<&str>,
) -> Option<VisibleConversationTurn> {
    let user_message = match preseeded_user_message_id {
        Some(id) => channel_chat_message_with_id("user", user_text, id),
        None => channel_chat_message("user", user_text),
    };
    let mut assistant_message = match preseeded_assistant_message_id {
        Some(id) => channel_chat_message_with_id("assistant", "", id),
        None => channel_chat_message("assistant", "…"),
    };
    assistant_message.memory_reuse =
        Some(local_first_memory::MemoryReuseEnvelope::blocked_unknown());
    assistant_message.delivery_state = local_first_desktop_gateway::MessageDeliveryState::Streaming;
    assistant_message.linked_task_id = linked_task_id.map(str::to_string);
    let turn = VisibleConversationTurn {
        turn_id: match turn_id_override {
            Some(id) => id.to_string(),
            None => format!(
                "turn_{}_{}",
                now_epoch_secs(),
                uuid::Uuid::new_v4().simple()
            ),
        },
        user_message_id: user_message.id.clone(),
        assistant_message_id: assistant_message.id.clone(),
    };
    // Persist the visible turn via commit_prompt_result (inserts both messages AND
    // synthesizes the provisional title from the first prompt when the thread is still
    // titled "New task"). This is a fail-closed safety boundary: a failure here aborts
    // the whole turn ("could not start a visible ... turn").
    //
    // Under the UNIFIED homun.sqlite (chat + task stores on ONE WAL file), a concurrent
    // writer can make this hit a TRANSIENT `SQLITE_BUSY`/`LOCKED`. `busy_timeout` alone
    // doesn't cover a write-write *snapshot* conflict (it returns immediately; only a
    // fresh transaction — a retry — resolves it, not waiting). That's why unattended
    // automations failed intermittently (e.g. 09:00 ok, 09:06 "failed") while
    // interactive chats mostly succeeded. So retry a few times before giving up, and
    // never swallow the error silently.
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let persisted = match lock_store(state) {
            Ok(store) => {
                store.commit_prompt_result(thread_id, &user_message, &assistant_message, None)
            }
            Err(error) => {
                tracing::error!(
                    target: "gateway::visible_turn",
                    %thread_id, %source, error = %error.message,
                    "start_visible_conversation_turn: chat store lock failed"
                );
                return None;
            }
        };
        match persisted {
            Ok(_) => break,
            Err(error) if is_transient_store_error(&error) && attempt < 5 => {
                tracing::warn!(
                    target: "gateway::visible_turn",
                    %thread_id, %source, attempt, error = %error,
                    "start_visible_conversation_turn: transient store contention — retrying"
                );
                std::thread::sleep(std::time::Duration::from_millis(u64::from(attempt) * 40));
            }
            Err(error) => {
                tracing::error!(
                    target: "gateway::visible_turn",
                    %thread_id, %source, attempt, error = %error,
                    "start_visible_conversation_turn: could not persist the turn — failing closed"
                );
                return None;
            }
        }
    }
    if let Some(assistant_message_id) = preseeded_assistant_message_id {
        let reopened = lock_store(state).ok().and_then(|store| {
            store
                .set_message_delivery_state(
                    thread_id,
                    assistant_message_id,
                    local_first_desktop_gateway::MessageDeliveryState::Streaming,
                )
                .ok()
        });
        if reopened != Some(true) {
            tracing::error!(
                target: "gateway::visible_turn",
                %thread_id,
                %assistant_message_id,
                "start_visible_conversation_turn: could not reopen assistant stream"
            );
            return None;
        }
    }
    // Re-read the (now provisional) title so the event reflects what was persisted,
    // rather than echoing the raw prompt passed in by the caller.
    let started_title = lock_store(state)
        .ok()
        .and_then(|store| store.thread(thread_id).ok().flatten())
        .map(|t| t.title)
        .unwrap_or_else(|| title.to_string());
    publish_app_event(thread_turn_started_event(
        thread_id,
        workspace,
        source,
        channel,
        &started_title,
        &turn,
    ));
    Some(turn)
}

fn context_message_for_model(
    _facade: &MemoryFacade,
    _consumer: (&MemoryUserId, &MemoryWorkspaceId),
    message: &ChatMessage,
    _now_unix: i64,
) -> Option<ChatContextMessage> {
    local_first_desktop_gateway::chat_message_for_existing_thread_context(message)
}

fn thread_context_for_model(
    state: &AppState,
    thread_id: &str,
    skip_message_ids: &[&str],
    current_prompt: Option<&str>,
) -> Option<Vec<ChatContextMessage>> {
    let skip: std::collections::HashSet<&str> = skip_message_ids.iter().copied().collect();
    let (snapshot, workspace_id) = {
        let Ok(store) = lock_store(state) else {
            return None;
        };
        (
            store.messages(thread_id).ok()?,
            store.workspace_for_thread(thread_id).ok()?,
        )
    };
    let mut messages: Vec<ChatMessage> = snapshot
        .messages
        .into_iter()
        .filter(|m| matches!(m.role.as_str(), "user" | "assistant"))
        .filter(|m| !skip.contains(m.id.as_str()))
        .collect();
    if messages
        .last()
        .is_some_and(|message| message.role == "assistant" && message.text.trim() == "…")
    {
        messages.pop();
    }
    if let Some(current_prompt) = current_prompt
        && messages.last().is_some_and(|message| {
            message.role == "user" && message.text.trim() == current_prompt.trim()
        })
    {
        messages.pop();
    }
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(workspace_id);
    let now_unix = i64::try_from(now_epoch_secs()).unwrap_or(i64::MAX);
    let mut msgs: Vec<ChatContextMessage> = messages
        .iter()
        .filter_map(|message| {
            context_message_for_model(facade, (&user, &workspace), message, now_unix)
        })
        .collect();
    let len = msgs.len();
    if len > 16 {
        msgs.drain(0..len - 16);
    }
    Some(msgs)
}

fn agent_turn_context(
    state: &AppState,
    thread_id: &str,
    skip_message_ids: &[&str],
) -> Option<Vec<ChatContextMessage>> {
    thread_context_for_model(state, thread_id, skip_message_ids, None)
}

fn apply_agent_stream_line(
    line: &str,
    streamed_text: &mut String,
    final_text: &mut Option<String>,
) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return false;
    };
    match value.get("type").and_then(|t| t.as_str()) {
        Some("delta") => {
            if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
                streamed_text.push_str(text);
            }
            false
        }
        Some("done") => {
            if let Some(text) = value.get("text").and_then(|t| t.as_str()) {
                *final_text = Some(text.to_string());
            } else if !streamed_text.trim().is_empty() {
                *final_text = Some(streamed_text.clone());
            }
            true
        }
        Some("error") => true,
        _ => false,
    }
}

fn update_channel_assistant_message(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    text: &str,
) {
    if let Ok(store) = lock_store(state) {
        let _ = store.set_message_text(thread_id, message_id, text);
    }
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
    }));
}

fn memory_reuse_envelope_from_read_set(
    reads: &local_first_engine::events::TurnMemoryReadSet,
) -> local_first_memory::MemoryReuseEnvelope {
    if reads.is_blocked_unknown() {
        return local_first_memory::MemoryReuseEnvelope::blocked_unknown();
    }
    if !reads.has_linked_reads() {
        return local_first_memory::MemoryReuseEnvelope::normal();
    }
    local_first_memory::MemoryReuseEnvelope::user_input_only(
        reads
            .linked
            .iter()
            .map(|read| local_first_memory::LinkedMemoryReadRef {
                source_workspace_id: read.source_workspace_id.clone(),
                grant_id: read.grant_id.clone(),
                policy_version: read.policy_version,
                memory_ref: read.memory_ref.clone(),
                source_revision: read.source_revision.clone(),
            })
            .collect(),
    )
}

#[derive(Debug, Default)]
struct StreamMemoryReuseCollector {
    event_parts: Vec<serde_json::Value>,
    reads: local_first_engine::events::TurnMemoryReadSet,
}

impl StreamMemoryReuseCollector {
    fn observe_line(&mut self, line: &str) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            return;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("recall") {
            return;
        }
        let Some(payload_value) = value.get("payload").cloned() else {
            self.reads.blocked_unknown = true;
            return;
        };
        let part = serde_json::json!({
            "type": "recall",
            "payload": payload_value,
        });
        if !self.event_parts.contains(&part) {
            self.event_parts.push(part);
        }
        match serde_json::from_value::<local_first_subagents::RecallStreamPayload>(payload_value) {
            Ok(payload) => self.reads.extend_payload(&payload),
            Err(_) => self.reads.blocked_unknown = true,
        }
    }

    fn event_parts(&self) -> &[serde_json::Value] {
        &self.event_parts
    }

    fn observe_remote_approval(&mut self, intent: &RemoteApprovalIntent) {
        let part = remote_approval_event_part(intent);
        if !self.event_parts.contains(&part) {
            self.event_parts.push(part);
        }
    }

    fn observe_actionable_cards(&mut self, cards: &[ActionableCard]) {
        for card in cards {
            let part = serde_json::json!({
                "type": "actionable_card",
                "kind": card.kind,
                "payload": card.payload,
                "raw": card.raw,
            });
            if !self.event_parts.contains(&part) {
                self.event_parts.push(part);
            }
        }
    }

    fn envelope(&self) -> local_first_memory::MemoryReuseEnvelope {
        memory_reuse_envelope_from_read_set(&self.reads)
    }
}

fn finalize_streamed_assistant_message(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    text: &str,
    collector: &StreamMemoryReuseCollector,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<(), String> {
    let store = lock_store(state).map_err(|error| error.message)?;
    store
        .finalize_assistant_message_with_delivery_state(
            thread_id,
            message_id,
            text,
            collector.event_parts(),
            &collector.envelope(),
            requested_delivery_state,
        )
        .map_err(|error| error.to_string())?;
    publish_app_event(serde_json::json!({
        "type": "thread.updated",
        "thread_id": thread_id,
        "workspace": base_workspace_id(),
    }));
    Ok(())
}

/// Typed TurnOutcome projection: this is the gateway's source of truth for opening
/// Free HITL waits. Marker/event-part persistence remains only as stream compatibility.
fn persist_hitl_wait_from_outcome(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    outcome: &local_first_engine::TurnOutcome,
) -> Result<(), String> {
    let Some(envelope) = outcome.awaiting_user.as_ref() else {
        return Ok(());
    };
    if !envelope.is_free() {
        return Ok(());
    }
    let wait_kind = match envelope.kind {
        local_first_engine::hitl::HitlKind::Choice
        | local_first_engine::hitl::HitlKind::Clarify
        | local_first_engine::hitl::HitlKind::PlanPropose => envelope.wait_kind_key(),
        local_first_engine::hitl::HitlKind::Confirm
        | local_first_engine::hitl::HitlKind::Vault
        | local_first_engine::hitl::HitlKind::Payment => return Ok(()),
    };
    let store = lock_store(state).map_err(|error| error.message)?;
    persist_hitl_wait_payload(
        &store,
        state,
        thread_id,
        message_id,
        wait_kind,
        envelope.payload.clone(),
    )
}

fn persist_hitl_wait_payload(
    store: &chat_store::ChatStore,
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    wait_kind: &str,
    payload: serde_json::Value,
) -> Result<(), String> {
    let browser_live = state
        .browser_thread_sessions
        .lock()
        .map_err(|error| format!("browser session store unavailable: {error}"))?
        .get(thread_id)
        .is_some_and(|session| thread_browser_session_is_live(session.last_used));
    // `store` is already held by both callers. Resolve the workspace through that
    // guard and read task state directly; calling `runtime_plan_control_scope` here
    // would try to acquire the same chat-store mutex again and self-deadlock.
    let workspace_id = store
        .workspace_for_thread(thread_id)
        .map_err(|error| format!("HITL workspace lookup failed: {error}"))?;
    let task_store = state
        .task_store
        .lock()
        .map_err(|error| format!("task store unavailable while persisting HITL wait: {error}"))?;
    let user_id = gateway_user_id();
    let contract = task_store
        .load_objective_contract(user_id.as_str(), &workspace_id, thread_id)
        .map_err(|error| format!("HITL objective lookup failed: {error}"))?
        .as_ref()
        .map(hitl_resume::ResumeContractSnapshot::from_objective);
    let plan = task_store
        .load_runtime_plan(user_id.as_str(), &workspace_id, thread_id)
        .map_err(|error| format!("HITL runtime plan lookup failed: {error}"))?
        .filter(|plan| plan.status == "open")
        // Tolerates both persistence shapes: `{"goal", "steps"}` and the legacy bare step array.
        .map(|plan| local_first_engine::plan::plan_value_steps(&plan.plan_json))
        .unwrap_or_default();
    let remaining_plan = hitl_resume::bounded_remaining_plan(plan);
    let browser_checkpoint_generation = task_store
        .load_active_browser_checkpoint_for_thread(user_id.as_str(), &workspace_id, thread_id)
        .map_err(|error| format!("HITL browser checkpoint lookup failed: {error}"))?
        .map(|checkpoint| checkpoint.generation);
    drop(task_store);
    let open_work = hitl_resume::OpenWorkSnapshot {
        schema_version: hitl_resume::OPEN_WORK_SCHEMA_VERSION,
        browser_session_live: browser_live,
        browser_checkpoint_available: browser_checkpoint_generation.is_some(),
        browser_checkpoint_generation,
        last_url: None,
        capability_hint: (browser_live || browser_checkpoint_generation.is_some())
            .then(|| "browse".to_string()),
        contract,
        remaining_plan,
    };
    let wait_id = format!("hitl_{wait_kind}_{message_id}");
    let payload_json = serde_json::to_string(&payload)
        .map_err(|error| format!("HITL payload serialization failed: {error}"))?;
    let open_work_json = serde_json::to_string(&open_work)
        .map_err(|error| format!("HITL open-work serialization failed: {error}"))?;
    store
        .set_open_hitl_wait(
            &wait_id,
            thread_id,
            message_id,
            wait_kind,
            &payload_json,
            &open_work_json,
        )
        .map_err(|error| format!("HITL wait persistence failed: {error}"))
}

#[derive(Debug, Clone)]
pub(crate) struct AgentTurnResult {
    text: String,
    actionable_cards: Vec<ActionableCard>,
    outcome: local_first_engine::TurnOutcome,
}

pub(crate) struct BrokerAgentTurnResult {
    outcome: local_first_engine::TurnOutcome,
}

fn wake_for_agent_stop(
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    stop: &local_first_engine::TurnStop,
    action: Option<&str>,
) -> Option<local_first_execution_protocol::WakeCondition> {
    match stop {
        local_first_engine::TurnStop::SuspendedUser => {
            Some(local_first_execution_protocol::WakeCondition::User {
                wait_ref: format!(
                    "{}:{}:user",
                    contract.as_ref().execution_id,
                    contract.as_ref().revision
                ),
            })
        }
        local_first_engine::TurnStop::SuspendedApproval => {
            Some(local_first_execution_protocol::WakeCondition::Approval {
                approval_ref: format!(
                    "{}:{}:approval:{}",
                    contract.as_ref().execution_id,
                    contract.as_ref().revision,
                    action.unwrap_or("action_card")
                ),
            })
        }
        local_first_engine::TurnStop::SuspendedEffect { receipt_ref } => Some(
            local_first_execution_protocol::WakeCondition::EffectResolution {
                receipt_ref: receipt_ref.clone(),
            },
        ),
        local_first_engine::TurnStop::SuspendedModel { role } => Some(
            local_first_execution_protocol::WakeCondition::ModelAvailable { role: role.clone() },
        ),
        local_first_engine::TurnStop::Completed | local_first_engine::TurnStop::Failed { .. } => {
            None
        }
    }
}

async fn drain_agent_stream_into_message(
    state: &AppState,
    thread_id: &str,
    assistant_message_id: &str,
    entry: std::sync::Arc<StreamEntry>,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<Option<AgentTurnResult>, String> {
    if let Ok(mut stored_id) = entry.assistant_message_id.lock() {
        *stored_id = Some(assistant_message_id.to_string());
    }
    let mut streamed_text = String::new();
    let mut final_text: Option<String> = None;
    let mut last_flush = std::time::Instant::now();
    let mut last_flushed_len = 0usize;
    let mut memory_reuse = StreamMemoryReuseCollector::default();

    let (snapshot, mut brx) = {
        let buf = entry.lines.lock().expect("stream lines lock");
        (buf.clone(), entry.tx.subscribe())
    };
    for line in snapshot {
        let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
        memory_reuse.observe_line(&line);
        persist_recall_event_part(state, thread_id, assistant_message_id, &line);
        if streamed_text.len() != last_flushed_len
            && last_flush.elapsed() >= std::time::Duration::from_millis(200)
        {
            update_channel_assistant_message(
                state,
                thread_id,
                assistant_message_id,
                &streamed_text,
            );
            last_flush = std::time::Instant::now();
            last_flushed_len = streamed_text.len();
        }
        if terminal {
            break;
        }
    }

    while final_text.is_none() {
        match brx.recv().await {
            Ok(line) => {
                let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
                memory_reuse.observe_line(&line);
                persist_recall_event_part(state, thread_id, assistant_message_id, &line);
                if streamed_text.len() != last_flushed_len
                    && last_flush.elapsed() >= std::time::Duration::from_millis(200)
                {
                    update_channel_assistant_message(
                        state,
                        thread_id,
                        assistant_message_id,
                        &streamed_text,
                    );
                    last_flush = std::time::Instant::now();
                    last_flushed_len = streamed_text.len();
                }
                if terminal {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }

    let outcome = wait_for_stream_outcome(entry).await;
    let raw_final_text = final_text.unwrap_or(streamed_text);
    let remote_approval = remote_approval_intent_from_raw_text(&raw_final_text);
    let actionable_cards = actionable_cards_from_raw_text(&raw_final_text);
    if let Some(intent) = remote_approval.as_ref() {
        memory_reuse.observe_remote_approval(intent);
    }
    memory_reuse.observe_actionable_cards(&actionable_cards);
    let mut final_text = strip_chat_markers(&raw_final_text);
    if final_text.is_empty() && actionable_cards.is_empty() {
        return Ok(None);
    }
    if final_text.is_empty() {
        final_text = "Waiting for your approval.".to_string();
    }
    finalize_streamed_assistant_message(
        state,
        thread_id,
        assistant_message_id,
        &raw_final_text,
        &memory_reuse,
        requested_delivery_state,
    )?;
    Ok(Some(AgentTurnResult {
        text: final_text,
        actionable_cards,
        outcome,
    }))
}

/// Maps a raw stream value to a durable TurnEventKind and its transport payload.
fn turn_event_from_stream_value(
    value: &serde_json::Value,
) -> Option<(local_first_task_runtime::TurnEventKind, serde_json::Value)> {
    let kind_str = value.get("type").and_then(|t| t.as_str())?;
    let (kind, payload) = match kind_str {
        "delta" => (
            local_first_task_runtime::TurnEventKind::Delta,
            serde_json::json!({ "text": value.get("text").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "reasoning" => (
            local_first_task_runtime::TurnEventKind::Reasoning,
            serde_json::json!({ "text": value.get("text").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "activity" => (
            local_first_task_runtime::TurnEventKind::Activity,
            serde_json::json!({ "text": value.get("text").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "plan_update" => (
            local_first_task_runtime::TurnEventKind::PlanUpdate,
            serde_json::json!({ "markdown": value.get("markdown").and_then(|t| t.as_str()).unwrap_or("") }),
        ),
        "tool_result" => (local_first_task_runtime::TurnEventKind::Tool, value.clone()),
        "step_advance" => (
            local_first_task_runtime::TurnEventKind::StepAdvance,
            // Frontend contract (exact): step_id, title, from (null for a new step), to,
            // verified (F2 verdict, null for plain moves), note.
            serde_json::json!({
                "step_id": value.get("step_id").and_then(|v| v.as_str()).unwrap_or(""),
                "title": value.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "from": value.get("from").cloned().filter(|v| !v.is_null()).unwrap_or(serde_json::Value::Null),
                "to": value.get("to").and_then(|v| v.as_str()).unwrap_or(""),
                "verified": value.get("verified").cloned().filter(|v| !v.is_null()).unwrap_or(serde_json::Value::Null),
                "note": value.get("note").cloned().filter(|v| !v.is_null()).unwrap_or(serde_json::Value::Null),
            }),
        ),
        "recall" => (
            local_first_task_runtime::TurnEventKind::Recall,
            value
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
        ),
        "error" => (
            local_first_task_runtime::TurnEventKind::Error,
            serde_json::json!({
                "code": value.get("code").and_then(Value::as_str).unwrap_or(""),
                "message": value.get("message").and_then(Value::as_str).unwrap_or(""),
                "retryable": value.get("retryable").and_then(Value::as_bool).unwrap_or(false),
            }),
        ),
        // unknown event types (e.g. choice_prompt, vault_propose) are not turn events
        _ => return None,
    };
    Some((kind, payload))
}

/// Stores an emitted Recall part with the assistant message. This is deliberately
/// idempotent because a stream snapshot and its broadcast tail can overlap.
fn persist_recall_event_part(
    state: &AppState,
    thread_id: &str,
    assistant_message_id: &str,
    line: &str,
) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return;
    };
    if value.get("type").and_then(|kind| kind.as_str()) != Some("recall") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    let part = serde_json::json!({ "type": "recall", "payload": payload });
    if let Ok(store) = lock_store(state) {
        let _ = store.append_assistant_event_part(thread_id, assistant_message_id, &part);
    }
}

fn redacted_user_text_from_stream_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(line.trim()).ok()?;
    if value.get("type").and_then(|kind| kind.as_str()) != Some("done") {
        return None;
    }
    value
        .get("redacted_user_text")
        .and_then(|text| text.as_str())
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn persist_redacted_user_text_from_stream_line(
    state: &AppState,
    thread_id: &str,
    user_message_id: &str,
    line: &str,
) {
    let Some(redacted) = redacted_user_text_from_stream_line(line) else {
        return;
    };
    if let Ok(store) = lock_store(state) {
        let _ = store.set_message_text(thread_id, user_message_id, &redacted);
    }
}

/// Maps a raw stream NDJSON line to a TurnEventKind + payload and emits it via
/// the turn_executor fan-out (durable turn_events + live broadcast). Best-effort:
/// unparseable lines or unknown types are silently skipped (they don't affect the
/// assistant message accumulation either).
fn fanout_turn_event(state: &AppState, turn_id: &str, line: &str) {
    let line = line.trim();
    if line.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    let kind_str = value
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("unknown");
    tracing::debug!(target: "broker::fanout", turn_id = %turn_id, kind = %kind_str, "stream event");
    let Some((kind, payload)) = turn_event_from_stream_value(&value) else {
        return;
    };
    if let Ok(store) = state.task_store.lock() {
        let _ = crate::turn_executor::emit_turn_event(state, &store, turn_id, kind, payload);
    }
}

/// Like `drain_agent_stream_into_message` but additionally mirrors each raw
/// stream event into the turn_events durable log + per-turn live broadcast via
/// `fanout_turn_event`. Used by the broker executor path; the automation path
/// keeps using the plain drain.
async fn drain_agent_stream_into_message_with_fanout(
    state: &AppState,
    thread_id: &str,
    user_message_id: &str,
    assistant_message_id: &str,
    entry: std::sync::Arc<StreamEntry>,
    turn_id: &str,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<BrokerAgentTurnResult, String> {
    if let Ok(mut stored_id) = entry.assistant_message_id.lock() {
        *stored_id = Some(assistant_message_id.to_string());
    }
    let mut streamed_text = String::new();
    let mut final_text: Option<String> = None;
    let mut last_flush = std::time::Instant::now();
    let mut last_flushed_len = 0usize;
    let mut memory_reuse = StreamMemoryReuseCollector::default();

    let (snapshot, mut brx) = {
        let buf = entry.lines.lock().expect("stream lines lock");
        (buf.clone(), entry.tx.subscribe())
    };
    for line in snapshot {
        let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
        memory_reuse.observe_line(&line);
        persist_redacted_user_text_from_stream_line(state, thread_id, user_message_id, &line);
        persist_recall_event_part(state, thread_id, assistant_message_id, &line);
        fanout_turn_event(state, turn_id, &line);
        if streamed_text.len() != last_flushed_len
            && last_flush.elapsed() >= std::time::Duration::from_millis(200)
        {
            update_channel_assistant_message(
                state,
                thread_id,
                assistant_message_id,
                &streamed_text,
            );
            last_flush = std::time::Instant::now();
            last_flushed_len = streamed_text.len();
        }
        if terminal {
            break;
        }
    }

    let mut typed_outcome = None;
    while final_text.is_none() && typed_outcome.is_none() {
        let outcome_ready = entry.outcome_ready.notified();
        if let Some(outcome) = entry.outcome.lock().ok().and_then(|slot| slot.clone()) {
            typed_outcome = Some(outcome);
            break;
        }
        tokio::select! {
            received = brx.recv() => match received {
            Ok(line) => {
                let terminal = apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
                memory_reuse.observe_line(&line);
                persist_redacted_user_text_from_stream_line(
                    state,
                    thread_id,
                    user_message_id,
                    &line,
                );
                persist_recall_event_part(state, thread_id, assistant_message_id, &line);
                fanout_turn_event(state, turn_id, &line);
                if streamed_text.len() != last_flushed_len
                    && last_flush.elapsed() >= std::time::Duration::from_millis(200)
                {
                    update_channel_assistant_message(
                        state,
                        thread_id,
                        assistant_message_id,
                        &streamed_text,
                    );
                    last_flush = std::time::Instant::now();
                    last_flushed_len = streamed_text.len();
                }
                if terminal {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            },
            _ = outcome_ready => {
                typed_outcome = entry.outcome.lock().ok().and_then(|slot| slot.clone());
            }
        }
    }

    // The engine publishes the typed outcome only after all stream emissions.
    // Drain any lines already queued before using the outcome as the transport close.
    while let Ok(line) = brx.try_recv() {
        apply_agent_stream_line(&line, &mut streamed_text, &mut final_text);
        memory_reuse.observe_line(&line);
        persist_redacted_user_text_from_stream_line(state, thread_id, user_message_id, &line);
        persist_recall_event_part(state, thread_id, assistant_message_id, &line);
        fanout_turn_event(state, turn_id, &line);
    }
    let outcome = match typed_outcome {
        Some(outcome) => outcome,
        None => wait_for_stream_outcome(entry.clone()).await,
    };

    let raw_final_text = final_text.unwrap_or(streamed_text);
    let remote_approval = remote_approval_intent_from_raw_text(&raw_final_text);
    let actionable_cards = actionable_cards_from_raw_text(&raw_final_text);
    if let Some(intent) = remote_approval.as_ref() {
        memory_reuse.observe_remote_approval(intent);
    }
    memory_reuse.observe_actionable_cards(&actionable_cards);
    let final_text = strip_chat_markers(&raw_final_text);
    if !(final_text.is_empty() && actionable_cards.is_empty()) {
        finalize_streamed_assistant_message(
            state,
            thread_id,
            assistant_message_id,
            &raw_final_text,
            &memory_reuse,
            requested_delivery_state,
        )?;
    }
    Ok(BrokerAgentTurnResult { outcome })
}

/// Runs an agent turn for channel-originated work while keeping the owning chat
/// visible: the inbound user message and assistant placeholder already exist,
/// and this function streams deltas into that assistant message.
fn agent_turn_stream_request_id(assistant_message_id: &str) -> String {
    format!("agentturn-{assistant_message_id}")
}

async fn run_agent_turn_into_message(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    tool_policy: &str,
    source_user_message_id: &str,
    assistant_message_id: &str,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<Option<AgentTurnResult>, String> {
    let (base_url, model, api_key) = chat_role_config_for_thread(state, Some(thread_id))
        .ok_or_else(|| "chat role configuration is unavailable".to_string())?;
    let context = agent_turn_context(
        state,
        thread_id,
        &[source_user_message_id, assistant_message_id],
    )
    .ok_or_else(|| "chat context is unavailable".to_string())?;
    let request_id = agent_turn_stream_request_id(assistant_message_id);
    let request = ChatGenerateStreamRequest {
        request_id: request_id.clone(),
        agent_run_id: None,
        agent_checkpoint: None,
        checkpoint_input: None,
        prompt: prompt.to_string(),
        thread_id: Some(thread_id.to_string()),
        context,
        max_context_chars: None,
        model: None,
        images: Vec::new(),
        attachments: Vec::new(),
        max_tokens: 2000,
        temperature: 0.3,
        wait_if_busy: true,
        request_timeout_seconds: None,
        tool_policy: Some(tool_policy.to_string()),
        mode: None,
    };
    let response = stream_chat_via_openai(state, request, base_url, model, api_key)
        .await
        .map_err(|error| error.message)?;
    let entry = stream_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    let body_task = tokio::spawn(async move {
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    });

    let result = match entry {
        Some(entry) => {
            drain_agent_stream_into_message(
                state,
                thread_id,
                assistant_message_id,
                entry,
                requested_delivery_state,
            )
            .await
        }
        None => {
            let _ = body_task.await;
            return Err("stream registration disappeared before draining".to_string());
        }
    };
    let _ = body_task.await;
    result
}

/// Like `run_agent_turn_into_message` but additionally mirrors each stream
/// event into turn_events (durable) + the per-turn broadcast (live) via the
/// fan-out drain. Used by the broker executor path.
#[allow(clippy::too_many_arguments)]
async fn run_agent_turn_into_message_with_fanout(
    state: &AppState,
    thread_id: &str,
    prompt: &str,
    tool_policy: &str,
    images: Vec<String>,
    attachments: Vec<AttachmentInput>,
    source_user_message_id: &str,
    assistant_message_id: &str,
    turn_id: &str,
    agent_run_id: Option<&str>,
    agent_checkpoint: Option<serde_json::Value>,
    checkpoint_input: Option<serde_json::Value>,
    model_override: Option<&str>,
    requested_delivery_state: local_first_desktop_gateway::MessageDeliveryState,
) -> Result<BrokerAgentTurnResult, String> {
    let (base_url, model, api_key) =
        chat_model_config_for_turn(state, Some(thread_id), model_override)?;
    let context = agent_turn_context(
        state,
        thread_id,
        &[source_user_message_id, assistant_message_id],
    )
    .ok_or_else(|| "chat context is unavailable".to_string())?;
    let request_id = format!("broker-{turn_id}");
    let request = ChatGenerateStreamRequest {
        request_id: request_id.clone(),
        agent_run_id: agent_run_id.map(str::to_string),
        agent_checkpoint,
        checkpoint_input,
        prompt: prompt.to_string(),
        thread_id: Some(thread_id.to_string()),
        context,
        max_context_chars: None,
        model: None,
        images,
        attachments,
        max_tokens: 2000,
        temperature: 0.3,
        wait_if_busy: true,
        request_timeout_seconds: None,
        tool_policy: Some(tool_policy.to_string()),
        mode: None,
    };
    let response = stream_chat_via_openai(state, request, base_url, model, api_key)
        .await
        .map_err(|error| error.message)?;
    let entry = stream_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned());
    if let Some(abort) = stream_abort_registry()
        .lock()
        .ok()
        .and_then(|map| map.get(&request_id).cloned())
    {
        crate::turn_executor::attach_turn_engine_abort(turn_id, abort);
    }

    let body_task = tokio::spawn(async move {
        let _ = axum::body::to_bytes(response.into_body(), usize::MAX).await;
    });

    let result = match entry {
        Some(entry) => {
            drain_agent_stream_into_message_with_fanout(
                state,
                thread_id,
                source_user_message_id,
                assistant_message_id,
                entry,
                turn_id,
                requested_delivery_state,
            )
            .await
        }
        None => {
            let _ = body_task.await;
            return Err("stream registration disappeared before draining".to_string());
        }
    };
    let _ = body_task.await;
    result
}

fn start_proactive_visible_turn(
    state: &AppState,
    task: &TaskRecord,
    thread_id: &str,
    thread_plan: &ProactiveThreadPlan,
    goal: &str,
) -> Result<VisibleConversationTurn, LocalTaskExecutionError> {
    let visible_turn = start_visible_conversation_turn(
        state,
        thread_id,
        &thread_plan.workspace_id,
        &thread_plan.source,
        thread_plan.channel.as_deref(),
        &thread_plan.title,
        goal,
        None,
        None,
        None,
        Some(task.task_id.as_str()),
    )
    .ok_or_else(|| LocalTaskExecutionError {
        message: "could not start a visible automation turn".to_string(),
    })?;

    let store = lock_task_store(state).map_err(local_task_gateway_error)?;
    let mut persisted = store
        .get_task(&task.task_id, &task.user_id, &task.workspace_id)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?
        .ok_or_else(|| LocalTaskExecutionError {
            message: "owning proactive task disappeared before execution".to_string(),
        })?;
    let mut input = persisted
        .input_json
        .as_object()
        .cloned()
        .unwrap_or_default();
    input.insert(
        "thread_id".to_string(),
        Value::String(thread_id.to_string()),
    );
    input.insert(
        "assistant_message_id".to_string(),
        Value::String(visible_turn.assistant_message_id.clone()),
    );
    persisted.input_json = Value::Object(input);
    persisted.updated_at = OffsetDateTime::now_utc();
    store
        .insert_task(&persisted)
        .map_err(GatewayError::task)
        .map_err(local_task_gateway_error)?;
    Ok(visible_turn)
}

/// Executes a scheduled/recurring "proactive prompt": runs a full agent turn on
/// the task's goal in a stable per-schedule chat thread, persists the exchange,
/// and pushes a live `/api/events` update so the desktop app surfaces it — the
/// same delivery path channel messages use. Tools stay read-only (safe by
/// default for unattended runs). Async `run_agent_turn` is driven to completion
/// via the runtime handle: this executor runs inside `spawn_blocking`, so
/// blocking on the current runtime here does not stall the async workers.
fn execute_proactive_prompt_task(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    control: std::sync::Arc<crate::execution_control::ExecutionAttemptControl>,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    let goal = task.goal.clone();
    let thread_plan = proactive_thread_plan(task, &goal);

    // Scheduled tasks get a stable per-schedule thread. Evented tasks can carry
    // their owning thread explicitly (channel, connector, addon), so the visible
    // run lands where the trigger happened instead of in a generic background chat.
    let thread_id = if let Some(root) = thread_plan.scheduled_root.clone() {
        match lock_store(state) {
            Ok(store) => store
                .find_or_create_channel_thread(
                    &thread_plan.workspace_id,
                    &thread_plan.source,
                    &root,
                    &thread_plan.title,
                )
                .ok()
                .map(|thread| thread.thread_id),
            Err(_) => None,
        }
    } else {
        thread_plan.thread_id.clone()
    };
    let Some(thread_id) = thread_id else {
        return Err(LocalTaskExecutionError {
            message: "could not create the automation thread".to_string(),
        });
    };

    // Automation runs (input_json carries `automation_id`) may ACT. Three policies:
    // - `autonomous`  → the rule is marked Autonomous: side-effecting tools execute directly.
    // - `full`        → the rule needs confirmation: writes PROPOSE a confirm card.
    // - `read_only`   → check-in / curiosity runs (no automation_id): "no actions".
    let is_automation = task.input_json.get("automation_id").is_some();
    let is_autonomous = task
        .input_json
        .get("approval")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("autonomous"));
    let policy = if is_automation && is_autonomous {
        "autonomous"
    } else if is_automation {
        "full"
    } else {
        "read_only"
    };

    // Safety boundary: scheduled/automation work must be visible in its owning
    // chat before any model/tool/browser work starts. If the durable turn cannot
    // be persisted, fail closed instead of running invisible background work.
    let visible_turn = start_proactive_visible_turn(state, task, &thread_id, &thread_plan, &goal)?;

    let request_id = agent_turn_stream_request_id(&visible_turn.assistant_message_id);
    let result = tokio::runtime::Handle::current().block_on(async {
        tokio::select! {
            biased;
            interruption = control.interrupted() => {
                tracing::info!(
                    target: "proactive::executor",
                    execution_id = %contract.as_ref().execution_id,
                    ?interruption,
                    "runtime interruption reached proactive agent turn"
                );
                abort_stream_generation(&request_id);
                Ok(None)
            }
            result = run_agent_turn_into_message(
                state,
                &thread_id,
                &goal,
                policy,
                &visible_turn.user_message_id,
                &visible_turn.assistant_message_id,
                local_first_desktop_gateway::MessageDeliveryState::Streaming,
            ) => result,
        }
    });
    let agent_result = result.ok().flatten();
    let waiting_action = agent_result
        .as_ref()
        .and_then(|result| result.actionable_cards.first())
        .map(|card| card.kind.to_string());
    let wake = agent_result.as_ref().and_then(|result| {
        wake_for_agent_stop(contract, &result.outcome.stop, waiting_action.as_deref())
    });
    let answer = agent_result.as_ref().map(|result| result.text.clone());
    let stop_failure = agent_result
        .as_ref()
        .and_then(|result| match &result.outcome.stop {
            local_first_engine::TurnStop::Failed { failure } => {
                Some(failure.redacted_detail.clone())
            }
            _ => None,
        });
    let incomplete_reason = stop_failure.or_else(|| {
        answer
            .as_deref()
            .and_then(agent_output_incomplete_reason)
            .or_else(|| {
                answer
                    .is_none()
                    .then(|| "scheduled task produced no final reply".to_string())
            })
    });

    let completed = incomplete_reason.is_none()
        && agent_result
            .as_ref()
            .is_some_and(|result| result.outcome.stop == local_first_engine::TurnStop::Completed);
    let suspended = wake.is_some();
    let blocked_reason = if suspended {
        Some("scheduled task is waiting for its durable wake".to_string())
    } else {
        incomplete_reason.clone()
    };
    let summary = blocked_reason.clone().unwrap_or_else(|| {
        if suspended {
            "Scheduled task is waiting for its durable wake.".to_string()
        } else {
            "Scheduled task executed.".to_string()
        }
    });
    let presentation = TaskExecutionPresentation {
        pending_approval: matches!(
            wake,
            Some(local_first_execution_protocol::WakeCondition::Approval { .. })
        )
        .then(|| PendingExecutorApproval {
            action: waiting_action
                .clone()
                .unwrap_or_else(|| "action card".to_string()),
            risk_level: "high".to_string(),
            data_boundary: "in-chat action card".to_string(),
            explanation: "The scheduled task is waiting for its persisted action card.".to_string(),
            inline_action_card: true,
        }),
        summary,
        checkpoint_payload: serde_json::json!({
            "kind": "proactive_prompt",
            "goal": goal,
            "thread_id": thread_id,
            "assistant_message_id": visible_turn.assistant_message_id,
            "user_message_id": visible_turn.user_message_id,
            "objective_revision": contract.as_ref().objective.as_ref().map(|objective| objective.revision),
            "awaiting_user": agent_result.as_ref().and_then(|result| result.outcome.awaiting_user.clone()),
            "answer": answer,
            "completed": completed,
            "suspended": suspended,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "proactive_prompt",
            "completed": completed,
        }),
        chat_message: answer.clone().unwrap_or_default(),
        result_surfacing: TaskResultSurfacing::AlreadyPersisted,
        surface: SurfaceKind::Logs,
        event_kind: if completed {
            "proactive_prompt_completed".to_string()
        } else if suspended {
            "proactive_prompt_suspended".to_string()
        } else {
            "proactive_prompt_incomplete".to_string()
        },
        event_title: if completed {
            "Scheduled task completed".to_string()
        } else if suspended {
            "Scheduled task suspended".to_string()
        } else {
            "Scheduled task incomplete".to_string()
        },
        event_subtitle: if completed {
            "Scheduled proactive execution.".to_string()
        } else if suspended {
            "The execution is waiting for its registered wake condition.".to_string()
        } else {
            "Scheduled task stopped before finishing its plan.".to_string()
        },
        event_payload: serde_json::json!({ "goal": goal }),
        artifacts: vec![],
    };
    if completed {
        execution_runtime::complete_task_execution(state, task, presentation)
    } else if let Some(wake) = wake {
        execution_runtime::suspend_task_execution(state, task, contract, wake, presentation)
    } else {
        execution_runtime::fail_task_execution(
            state,
            task,
            local_first_execution_protocol::ExecutionFailure::transient(
                "proactive_prompt_incomplete",
                incomplete_reason
                    .as_deref()
                    .unwrap_or("scheduled task stopped before completing"),
            ),
            presentation,
        )
    }
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

    task_execution_outcome_from_executor_result(
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

/// Runs a `subagent.*` task through the real `SubagentTaskExecutor` (trait-based)
/// and maps its `ExecutorResult` into the canonical execution protocol.
/// (ADR 0008 pillar #3 / GAP 4: de-stub the registered executors). The runner
/// only needs the local LLM runtime.
fn execute_subagent_task(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    // Pick the model that best fits THIS task's goal: the semantic stage-2 router
    // (with heuristic fallback) over the "orchestrator" role.
    let goal = task
        .input_json
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let router = match resolve_role_for_task(goal, "orchestrator") {
        Some(resolved) => build_router_for_resolved(&resolved),
        None => router_for_role("orchestrator"),
    };

    let mut executor = SubagentTaskExecutor::new(router);
    let executor_id = executor.executor_id().to_string();
    let result = executor
        .execute_step(task, None)
        .map_err(|error| LocalTaskExecutionError {
            message: format!("subagent executor failed: {error}"),
        })?;
    // Reuse the shared ExecutorResult presentation mapping used by browser capabilities.
    task_execution_outcome_from_executor_result(
        state,
        task,
        contract,
        &executor_id,
        "subagent",
        result,
    )
}

/// P2: executes a non-browser `capability.*` task by building a LIVE provider
/// from the registry and dispatching through `CapabilityFacade::call_tool`.
///
/// Today MCP is wired end-to-end (the crate ships a real `McpStdioTransport`):
/// the registry connection metadata gives the command/args, the provider spawns
/// the server and speaks JSON-RPC, and the facade enforces the grant-based
/// policy before calling the tool. Composio (no real HTTP transport yet) and
/// skills (need a runner) report a clear "kind not yet wired" instead of the
/// previous blanket "unwired" — so the unlock is incremental and honest.
fn execute_capability_generic(
    state: &AppState,
    task: &TaskRecord,
    _contract: &local_first_execution_protocol::ValidatedExecutionContract,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    let payload: CapabilityTaskPayload =
        serde_json::from_value(task.input_json.clone()).map_err(|error| {
            LocalTaskExecutionError {
                message: format!("Invalid capability payload: {error}"),
            }
        })?;
    let call = payload.call;
    let provider_id = call.provider_id.clone();
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();

    let (kind, connection, tool_policies, policy_context) = {
        let registry = lock_capability_registry(state).map_err(local_task_gateway_error)?;
        let kind = registry
            .provider_config(&provider_id)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("provider config: {error}"),
            })?
            .map(|config| config.provider_kind)
            .ok_or_else(|| LocalTaskExecutionError {
                message: format!("provider not configured: {}", provider_id.as_str()),
            })?;
        let connection = registry
            .connection_configs(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("connection configs: {error}"),
            })?
            .into_iter()
            .find(|config| config.provider_id == provider_id);
        let tool_policies = registry
            .cached_tools(&provider_id)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("cached tools: {error}"),
            })?
            .into_iter()
            .map(|cached| McpToolPolicy {
                tool_name: cached.tool.name,
                action: cached.tool.action,
                privacy_domains: cached.tool.privacy_domains,
                sensitivity: cached.tool.sensitivity,
            })
            .collect::<Vec<_>>();
        let policy_context = registry
            .policy_context(&user, &workspace)
            .map_err(|error| LocalTaskExecutionError {
                message: format!("policy context: {error}"),
            })?;
        (kind, connection, tool_policies, policy_context)
    };

    let result = match kind {
        CapabilityProviderKind::Mcp => {
            let connection = connection.ok_or_else(|| LocalTaskExecutionError {
                message: format!("no connection for provider {}", provider_id.as_str()),
            })?;
            let transport = build_mcp_transport(state, &connection)
                .map_err(|message| LocalTaskExecutionError { message })?;
            let mut facade =
                CapabilityFacade::new(CapabilityPolicy, InMemoryCapabilityAudit::default());
            facade.register_provider(McpCapabilityProvider::new(
                provider_id.clone(),
                true,
                transport,
                tool_policies,
            ));
            facade.call_tool(&policy_context, call)
        }
        CapabilityProviderKind::Managed => {
            // Composio: converged onto the SINGLE v3 execution path (F1.c, caposaldo #5).
            // The task-runtime used to wrap the pre-v3 `ComposioCapabilityProvider` in a
            // throwaway facade, but the facade locates the tool via `provider.list_tools()`,
            // which does `GET /tools` and parses the pre-v3 `{tools}` shape — that FAILS
            // against Composio v3 (`{items}`), so the call errored before ever executing
            // (autonomous Composio runs were broken). We now re-check the SAME deny-by-default
            // policy (`CapabilityPolicy::tool_access`, no gate duplication) against the
            // v3-sourced cached tool metadata, then execute through `composio_execute_tool` —
            // the one v3 path the chat loop already uses. `connection` is unused here now:
            // the v3 transport is resolved by `composio_transport_for` (single source).
            if let Err(reason) = authorize_managed_capability_tool(
                &tool_policies,
                &policy_context,
                &provider_id,
                call.tool_name.as_str(),
            ) {
                return execution_runtime::fail_task_execution(
                    state,
                    task,
                    local_first_execution_protocol::ExecutionFailure::policy_denied(
                        "capability_policy_denied",
                        &reason,
                    ),
                    capability_call_failed_outcome(task, &reason),
                );
            }
            composio_execute_tool(state, call.tool_name.as_str(), &call.arguments)
                .map(|output| local_first_capabilities::CapabilityCallResult {
                    provider_id: provider_id.clone(),
                    tool_name: call.tool_name.clone(),
                    output,
                })
                .map_err(|error| CapabilityError::ToolExecutionFailed(error.message))
        }
        other => {
            let presentation = capability_kind_not_wired_outcome(task, other);
            return execution_runtime::fail_task_execution(
                state,
                task,
                local_first_execution_protocol::ExecutionFailure::permanent(
                    "capability_provider_not_wired",
                    &presentation.summary,
                ),
                presentation,
            );
        }
    };

    match result {
        Ok(call_result) => execution_runtime::complete_task_execution(
            state,
            task,
            capability_call_completed_outcome(task, &call_result),
        ),
        Err(error) => {
            let reason = error.to_string();
            execution_runtime::fail_task_execution(
                state,
                task,
                local_first_execution_protocol::ExecutionFailure::transient(
                    "capability_call_failed",
                    &reason,
                ),
                capability_call_failed_outcome(task, &reason),
            )
        }
    }
}

/// Re-check the deny-by-default policy for a Managed (Composio) tool before AUTONOMOUS
/// execution by the task-runtime. Returns `Ok(())` if authorized, else a human-readable
/// denial reason. Pure (so the security gate is unit-testable without app state), and it
/// reuses the ONE canonical `CapabilityPolicy::tool_access` — no gate logic is duplicated
/// here. Fail-closed: a tool absent from the v3 catalog cache (`cached_tools`) cannot be
/// authorized, so a stale/uncached slug is denied rather than executed blindly. This is the
/// gate the old facade path enforced; it is preserved here while execution moves to the v3
/// `composio_execute_tool` (F1.c).
fn authorize_managed_capability_tool(
    tool_policies: &[McpToolPolicy],
    policy_context: &PolicyContext,
    provider_id: &CapabilityProviderId,
    tool_name: &str,
) -> Result<(), String> {
    let Some(policy) = tool_policies.iter().find(|p| p.tool_name == tool_name) else {
        return Err(format!(
            "Composio tool «{tool_name}» is not in the catalog cache — cannot authorize it \
             for autonomous execution; open the chat once to refresh the connected toolkit."
        ));
    };
    let tool = CapabilityTool {
        name: policy.tool_name.clone(),
        provider_id: provider_id.clone(),
        provider_kind: CapabilityProviderKind::Managed,
        action: policy.action,
        description: String::new(),
        privacy_domains: policy.privacy_domains.clone(),
        sensitivity: policy.sensitivity.clone(),
        input_schema: serde_json::json!({ "type": "object" }),
    };
    let decision = CapabilityPolicy.tool_access(policy_context, &tool);
    if decision.executable {
        Ok(())
    } else {
        Err(format!("denied: {}", decision.reasons.join("; ")))
    }
}

fn capability_call_completed_outcome(
    _task: &TaskRecord,
    result: &local_first_capabilities::CapabilityCallResult,
) -> TaskExecutionPresentation {
    let summary = format!("Tool `{}` eseguito.", result.tool_name);
    TaskExecutionPresentation {
        pending_approval: None,
        summary: summary.clone(),
        // Raw output stays in the (audited, non-UI) checkpoint; the redacted
        // checkpoint and chat message carry only provider/tool identifiers.
        checkpoint_payload: serde_json::json!({
            "kind": "capability_tool_completed",
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
            "output": result.output,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "capability_tool_completed",
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
        }),
        chat_message: format!(
            "Ran `{}` via `{}`.",
            result.tool_name,
            result.provider_id.as_str()
        ),
        result_surfacing: TaskResultSurfacing::AppendToChat,
        surface: SurfaceKind::Logs,
        event_kind: "capability_tool_completed".to_string(),
        event_title: "Tool executed".to_string(),
        event_subtitle: summary,
        event_payload: serde_json::json!({
            "provider": result.provider_id.as_str(),
            "tool": result.tool_name,
        }),
        artifacts: vec![],
    }
}

fn capability_call_failed_outcome(task: &TaskRecord, reason: &str) -> TaskExecutionPresentation {
    TaskExecutionPresentation {
        pending_approval: None,
        summary: reason.to_string(),
        checkpoint_payload: serde_json::json!({
            "kind": "capability_tool_failed",
            "task_kind": task.kind,
            "reason": reason,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "capability_tool_failed",
            "task_kind": task.kind,
            "reason": reason,
        }),
        chat_message: format!("The capability tool failed: {reason}"),
        result_surfacing: TaskResultSurfacing::AppendToChat,
        surface: SurfaceKind::Logs,
        event_kind: "capability_tool_failed".to_string(),
        event_title: "Tool failed".to_string(),
        event_subtitle: reason.to_string(),
        event_payload: serde_json::json!({ "task_kind": task.kind }),
        artifacts: vec![],
    }
}

fn capability_kind_not_wired_outcome(
    task: &TaskRecord,
    kind: CapabilityProviderKind,
) -> TaskExecutionPresentation {
    let reason = format!(
        "Capability execution for provider kind {kind:?} not yet wired (MCP and Composio active)."
    );
    capability_call_failed_outcome(task, &reason)
}

// VAULT_REVEAL_OPEN/CLOSE moved to engine::markers (ADR 0024 inc 5e.3); imported below.

/// Close every steering row still waiting on a turn that has ended.
///
/// A row left `pending`/`held` when its turn finishes is unappliable — its target turn is over — but
/// it stays visible to the NEXT turn's finalization fence, which then waits its full budget and parks.
/// One instruction the semantic coordinator could not interpret therefore broke every subsequent turn
/// in the thread, each time looking like a fresh hang. Cancelling is the honest state: the instruction
/// never ran, and the user can restate it; leaving it pending is strictly worse, because it cannot ever
/// be applied and it disables the thread.
///
/// Best-effort and non-fatal by design: this is a cleanup fence on the way out of a turn, so a store
/// error must never propagate into (or fail) the turn that just finished — it is logged instead.
fn finalize_turn_steering(
    state: &AppState,
    thread_id: Option<&str>,
    turn_id: &str,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) {
    let Some(thread_id) = thread_id.filter(|id| !id.trim().is_empty()) else {
        return;
    };
    let Ok(store) = state.task_store.lock() else {
        return;
    };
    let (user_id, workspace_id) = (user_id.as_str(), workspace_id.as_str());
    let Ok(before) = store.list_turn_steering(user_id, workspace_id, thread_id) else {
        return;
    };
    let changed =
        match store.close_unsettled_turn_steering(user_id, workspace_id, thread_id, turn_id) {
            Ok(changed) => changed,
            Err(error) => {
                tracing::warn!(
                    target: "steering::finalize",
                    turn_id,
                    %error,
                    "could not close steering rows left unsettled by a finished turn"
                );
                return;
            }
        };
    if changed == 0 {
        return;
    }
    let Ok(after) = store.list_turn_steering(user_id, workspace_id, thread_id) else {
        tracing::warn!(
            target: "steering::finalize",
            turn_id,
            "closed steering rows left unsettled by a finished turn but could not reload them for publication"
        );
        return;
    };
    for record in after {
        if record.active_turn_id != turn_id || record.status.as_str() != "cancelled" {
            continue;
        }
        let changed_status = before
            .iter()
            .any(|old| old.steering_id == record.steering_id && old.status != record.status);
        if !changed_status {
            continue;
        }
        tracing::warn!(
            target: "steering::finalize",
            steering_id = record.steering_id,
            turn_id,
            "closed a steering row left unsettled by a finished turn"
        );
        publish_steering_changed(&record);
    }
}

fn task_execution_outcome_from_executor_result(
    state: &AppState,
    task: &TaskRecord,
    contract: &local_first_execution_protocol::ValidatedExecutionContract,
    executor_id: &str,
    tool_name: &str,
    result: ExecutorResult,
) -> Result<local_first_execution_protocol::ExecutionOutcome, LocalTaskExecutionError> {
    match result {
        ExecutorResult::Completed { output } => execution_runtime::complete_task_execution(
            state,
            task,
            completed_executor_outcome(task, executor_id, tool_name, output),
        ),
        ExecutorResult::Checkpoint {
            payload,
            redacted_payload,
        } => {
            let output = payload.clone();
            let mut presentation = completed_executor_outcome(task, executor_id, tool_name, output);
            presentation.checkpoint_payload = serde_json::json!({
                "kind": "executor_completed",
                "executor_id": executor_id,
                "tool": tool_name,
                "output": payload,
            });
            presentation.checkpoint_redacted = serde_json::json!({
                "kind": "executor_completed",
                "executor_id": executor_id,
                "tool": tool_name,
                "output": redacted_payload,
            });
            execution_runtime::complete_task_execution(state, task, presentation)
        }
        ExecutorResult::NeedsApproval {
            action,
            risk_level,
            data_boundary,
            explanation,
        } => {
            let presentation = TaskExecutionPresentation {
                pending_approval: Some(PendingExecutorApproval {
                    action: action.clone(),
                    risk_level: risk_level.clone(),
                    data_boundary: data_boundary.clone(),
                    explanation: explanation.clone(),
                    inline_action_card: false,
                }),
                summary: "Task in attesa di approval.".to_string(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_needs_approval",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "approval": {
                        "action": action,
                        "risk_level": risk_level,
                        "data_boundary": data_boundary,
                        "explanation": explanation,
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_needs_approval",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "approval": {
                        "action": action,
                        "risk_level": risk_level,
                        "data_boundary": data_boundary,
                        "explanation": explanation,
                    },
                }),
                chat_message: format!(
                    "The task `{}` requires a new approval before continuing: {}",
                    task.kind, explanation
                ),
                result_surfacing: TaskResultSurfacing::AppendToChat,
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_waiting_approval".to_string(),
                event_title: "Approval required".to_string(),
                event_subtitle: explanation,
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                }),
                artifacts: vec![],
            };
            execution_runtime::suspend_task_execution(
                state,
                task,
                contract,
                local_first_execution_protocol::WakeCondition::Approval {
                    approval_ref: format!(
                        "{}:{}:approval:{}",
                        contract.as_ref().execution_id,
                        contract.as_ref().revision,
                        action
                    ),
                },
                presentation,
            )
        }
        ExecutorResult::WaitUntil { not_before, reason } => {
            let presentation = TaskExecutionPresentation {
                pending_approval: None,
                summary: reason.clone(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_waiting_time",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                        "not_before": not_before.unix_timestamp(),
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_waiting_time",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                        "not_before": not_before.unix_timestamp(),
                    },
                }),
                chat_message: format!(
                    "The task `{}` is waiting until {}: {}",
                    task.kind, not_before, reason
                ),
                result_surfacing: TaskResultSurfacing::AppendToChat,
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_waiting_time".to_string(),
                event_title: "Task waiting".to_string(),
                event_subtitle: reason.clone(),
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "not_before": not_before.unix_timestamp(),
                }),
                artifacts: vec![],
            };
            execution_runtime::suspend_task_execution(
                state,
                task,
                contract,
                local_first_execution_protocol::WakeCondition::At {
                    unix_seconds: not_before.unix_timestamp(),
                },
                presentation,
            )
        }
        ExecutorResult::RetryableFailure { reason } => {
            let presentation = TaskExecutionPresentation {
                pending_approval: None,
                summary: reason.clone(),
                checkpoint_payload: serde_json::json!({
                    "kind": "executor_blocked",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                    },
                }),
                checkpoint_redacted: serde_json::json!({
                    "kind": "executor_blocked",
                    "executor_id": executor_id,
                    "tool": tool_name,
                    "output": {
                        "blocked_reason": reason,
                    },
                }),
                chat_message: format!("The task `{}` is blocked: {}", task.kind, reason),
                result_surfacing: TaskResultSurfacing::AppendToChat,
                surface: SurfaceKind::Logs,
                event_kind: "computer_executor_blocked".to_string(),
                event_title: "Task blocked".to_string(),
                event_subtitle: reason.clone(),
                event_payload: serde_json::json!({
                    "executor_id": executor_id,
                    "tool": tool_name,
                }),
                artifacts: vec![],
            };
            execution_runtime::fail_task_execution(
                state,
                task,
                local_first_execution_protocol::ExecutionFailure::transient(
                    "executor_retryable_failure",
                    &reason,
                ),
                presentation,
            )
        }
    }
}

fn completed_executor_outcome(
    task: &TaskRecord,
    executor_id: &str,
    tool_name: &str,
    output: Value,
) -> TaskExecutionPresentation {
    TaskExecutionPresentation {
        pending_approval: None,
        summary: format!("Executor `{executor_id}` completed."),
        checkpoint_payload: serde_json::json!({
            "kind": "executor_completed",
            "executor_id": executor_id,
            "tool": tool_name,
            "output": output,
        }),
        checkpoint_redacted: serde_json::json!({
            "kind": "executor_completed",
            "executor_id": executor_id,
            "tool": tool_name,
            "output": redact_json_for_task_output(&output),
        }),
        chat_message: format!("Task `{}` completed via `{tool_name}`.", task.kind),
        result_surfacing: TaskResultSurfacing::AppendToChat,
        surface: SurfaceKind::Browser,
        event_kind: "computer_executor_completed".to_string(),
        event_title: "Executor completed".to_string(),
        event_subtitle: format!("{} produced structured output.", tool_name),
        event_payload: serde_json::json!({
            "executor_id": executor_id,
            "tool": tool_name,
        }),
        artifacts: vec![],
    }
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

fn now_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Browser-loop router (Phase 2): the "browser" role.
fn build_browser_inference_router() -> ModelRouter {
    router_for_role("browser")
}

async fn capability_snapshot(
    State(state): State<AppState>,
) -> Result<Json<CapabilitySnapshotResponse>, GatewayError> {
    let user = gateway_capability_user_id();
    let workspace = gateway_capability_workspace_id();
    let registry = lock_capability_registry(&state)?;
    let policy = registry
        .policy_context(&user, &workspace)
        .map_err(GatewayError::capability)?;
    let snapshot = capability_snapshot_response(&registry, &user, &workspace, policy)?;
    Ok(Json(snapshot))
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

fn task_effective_goal(task: &TaskRecord) -> String {
    task.input_json
        .get("prompt_redacted")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(task.goal.as_str())
        .to_string()
}

#[derive(Debug)]
struct GatewayError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl GatewayError {
    fn store(error: rusqlite::Error) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "chat_store_error",
            message: error.to_string(),
        }
    }

    fn task(error: local_first_task_runtime::TaskRuntimeError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "task_runtime_error",
            message: error.to_string(),
        }
    }

    fn local_computer(error: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "local_computer_error",
            message: error,
        }
    }

    fn memory(error: String) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "memory_error",
            message: error,
        }
    }

    fn capability(error: local_first_capabilities::CapabilityError) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "capability_error",
            message: error.to_string(),
        }
    }
}

fn lock_store(state: &AppState) -> Result<MutexGuard<'_, ChatStore>, GatewayError> {
    state.chat_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "chat_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_task_store(state: &AppState) -> Result<MutexGuard<'_, TaskStore>, GatewayError> {
    state.task_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "task_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_computer_store(
    state: &AppState,
) -> Result<MutexGuard<'_, LocalComputerSessionStore>, GatewayError> {
    state.computer_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "local_computer_store_lock_error",
        message: error.to_string(),
    })
}

fn lock_browser_url_policies(
    state: &AppState,
) -> Result<MutexGuard<'_, BrowserUrlPolicyStore>, GatewayError> {
    state
        .browser_url_policies
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "browser_url_policy_lock_error",
            message: error.to_string(),
        })
}

/// ADR 0027: the facade is lock-free — the store owns concurrency per-op. Direct &-access;
/// never held across a model/embed call (that was the HTTP-hot-path freeze this move removes).
fn memory_facade(state: &AppState) -> &MemoryFacade {
    &state.memory_facade
}

fn lock_vault_store(state: &AppState) -> Result<MutexGuard<'_, SQLiteVaultStore>, GatewayError> {
    state.vault_store.lock().map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "vault_store_lock_error",
        message: error.to_string(),
    })
}

pub(crate) fn lock_capability_registry(
    state: &AppState,
) -> Result<MutexGuard<'_, CapabilityRegistryStore>, GatewayError> {
    state
        .capability_registry
        .lock()
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "capability_registry_lock_error",
            message: error.to_string(),
        })
}

/// Runs VACUUM on all SQLite stores to reclaim free space. Called at startup
/// and periodically (every 24h via the worker loop). Safe but can be slow on
/// large databases — runs without holding other locks.
fn vacuum_all_stores(state: &AppState) {
    if let Ok(store) = state.chat_store.lock()
        && let Err(error) = store.vacuum()
    {
        eprintln!("VACUUM chat store: {error}");
    }
    if let Ok(store) = lock_task_store(state)
        && let Err(error) = store.vacuum()
    {
        eprintln!("VACUUM task store: {error:?}");
    }
    {
        let facade = memory_facade(state);
        if let Err(error) = facade.vacuum() {
            eprintln!("VACUUM memory store: {error}");
        }
    }
    if let Ok(store) = state.usage_store.lock()
        && let Err(error) = store.vacuum()
    {
        eprintln!("VACUUM usage store: {error}");
    }
}

fn gateway_memory_access_request() -> MemoryAccessRequest {
    MemoryAccessRequest {
        actor_id: "desktop-ui".to_string(),
        user_id: gateway_memory_user_id(),
        workspace_id: gateway_memory_workspace_id(),
        purpose: "desktop_memory_dashboard".to_string(),
        allowed_domains: vec![
            PrivacyDomain::new("local"),
            PrivacyDomain::new("personal"),
            PrivacyDomain::new("work"),
            PrivacyDomain::new("browser"),
        ],
        max_sensitivity: MemoryDataSensitivity::Private,
        allow_raw_payload: false,
        allow_export: false,
        broad_query: true,
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorResponse {
                error: ErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod gateway_main_tests;
