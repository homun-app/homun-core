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
        "fn recall_stream_payload_from_pack(": "recall stream payload assembly must stay in gateway_recall_context",
        "fn recall_stream_payload_from_hits(": "recall stream payload assembly must stay in gateway_recall_context",
        "fn merge_automatic_recall_payload(": "automatic recall payload merging must stay in gateway_recall_context",
        "fn memory_read_effects_from_recall_payload(": "recall effect projection must stay in gateway_recall_context",
        "fn seed_loop_memory_reads(": "loop memory-read seeding must stay in gateway_recall_context",
        "fn gather_open_loops(": "open-loop recall gathering must stay in gateway_recall_context",
        "fn sanitize_dedup_key(": "dedup-key normalization must stay in gateway_recall_context",
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
        "fn task_delivers_to_homun(": "Homun check-in task matching must stay in gateway_task_maintenance",
        "fn task_is_live(": "task liveness classification must stay in gateway_task_maintenance",
        "fn cancel_homun_checkins(": "Homun check-in cancellation must stay in gateway_task_maintenance",
        "fn gc_stale_tasks(": "stale task GC must stay in gateway_task_maintenance",
        "fn spawn_memory_consolidation_tick(": "memory consolidation tick must stay in gateway_memory_background",
        "fn spawn_embedding_catchup(": "embedding catchup must stay in gateway_memory_background",
        "fn spawn_memory_hygiene_sweep(": "memory hygiene sweep must stay in gateway_memory_background",
        "struct RemoteApprovalIntent ": "remote approval intent parsing must stay in gateway_remote_approval",
        "fn remote_approval_intent_from_marker(": "remote approval marker parsing must stay in gateway_remote_approval",
        "fn remote_approval_intent_from_raw_text(": "remote approval marker parsing must stay in gateway_remote_approval",
        "fn actionable_cards_from_raw_text(": "actionable card parsing must stay in gateway_remote_approval",
        "async fn activate_remote_approvals_from_message(": "remote approval source binding and dispatch must stay in gateway_remote_approval",
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
        "fn memory_query_embedding_cache(": "memory query embedding cache singleton must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache_max_entries(": "memory query embedding cache sizing must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache_ttl(": "memory query embedding cache ttl must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_timeout(": "memory query embedding timeout must stay in gateway_memory_query_embeddings",
        "fn normalize_memory_embedding_query(": "memory query normalization must stay in gateway_memory_query_embeddings",
        "fn memory_query_embedding_cache_key(": "memory query embedding cache key must stay in gateway_memory_query_embeddings",
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
        "struct MemoryHygieneSuggestion": "memory hygiene suggestion type must stay in gateway_memory_hygiene",
        "fn normalized_entity_name(": "memory hygiene entity-name normalization must stay in gateway_memory_hygiene",
        "fn verified_identity_aliases(": "memory hygiene identity alias detection must stay in gateway_memory_hygiene",
        "fn memory_hygiene_suggestions_for_scope(": "memory hygiene suggestions must stay in gateway_memory_hygiene",
        "fn persist_graph(": "memory graph persistence routing must stay in gateway_memory_graph_persistence",
        "fn persist_graph_scope(": "memory graph scope persistence must stay in gateway_memory_graph_persistence",
        "fn recall_memory_tool_schema(": "memory tool schemas must stay in gateway_memory_tools",
        "fn record_decision_tool_schema(": "memory tool schemas must stay in gateway_memory_tools",
        "fn record_decision(": "memory decision recording must stay in gateway_memory_tools",
        "fn forget_memory_tool_schema(": "memory tool schemas must stay in gateway_memory_tools",
        "fn forget_in_scope(": "memory forget search must stay in gateway_memory_tools",
        "fn forget_topic_in_scope(": "memory topic forget must stay in gateway_memory_tools",
        "fn forget_memory(": "memory forget orchestration must stay in gateway_memory_tools",
        "fn update_plan_tool_schema(": "runtime plan tool schemas must stay in gateway_plan_tools",
        "fn step_advance_tool_schema(": "runtime plan tool schemas must stay in gateway_plan_tools",
        "fn strip_chat_markers(": "chat marker stripping must stay in gateway_chat_markers",
        "fn query_code_graph_tool_schema(": "project search tool schemas must stay in gateway_project_search_tools",
        "fn query_git_history_tool_schema(": "project search tool schemas must stay in gateway_project_search_tools",
        "fn github_search_tool_schema(": "project search tool schemas must stay in gateway_project_search_tools",
        "async fn github_search(": "github repository search must stay in gateway_project_search_tools",
        "fn query_git_history(": "git history search must stay in gateway_project_search_tools",
        "fn query_code_graph(": "code graph search must stay in gateway_project_search_tools",
        "fn resolve_datetime_tool_schema(": "datetime tool schema must stay in gateway_datetime_tools",
        "fn plan_stall_abort_enabled(": "runtime environment flags must stay in gateway_runtime_flags",
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
        "fn zai_thinking_enabled(": "Z.ai thinking policy must stay in gateway_model_routing",
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
        "async fn thread_activity_projection(": "turn broker activity route must stay in gateway_turn_broker",
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
        "struct ResolveEffectResponse": "task executor effect response must stay in gateway_task_executor",
        "async fn uncertain_effect_receipts(": "task executor effect routes must stay in gateway_task_executor",
        "async fn resolve_uncertain_effect_receipt(": "task executor effect routes must stay in gateway_task_executor",
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
        "fn sync_session_for_task_run(": "task executor session sync must stay in gateway_task_executor",
        "fn append_task_result_to_chat(": "task executor result surfacing must stay in gateway_task_executor",
        "fn append_task_progress_checkpoint(": "task executor progress checkpoint must stay in gateway_task_executor",
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
        "fn browser_open_research_discovery_instruction(": "prompt instruction snippets must stay in gateway_prompt_instructions",
        "fn booking_assumption_choice_instruction(": "prompt instruction snippets must stay in gateway_prompt_instructions",
        "fn choice_resume_instruction_legacy_backup(": "prompt instruction snippets must stay in gateway_prompt_instructions",
        "fn schedule_task_tool_schema(": "automation tool schemas must stay in gateway_automation_tools",
        "fn create_automation_tool_schema(": "automation tool schemas must stay in gateway_automation_tools",
        "fn update_automation_tool_schema(": "automation tool schemas must stay in gateway_automation_tools",
        "fn humanize_recurrence(": "automation formatting must stay in gateway_automation_formatting",
        "fn automation_trigger_summary(": "automation formatting must stay in gateway_automation_formatting",
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
    main_body = extract_async_main_body(source)
    assert_contains(source, "mod gateway_recall_context;", "gateway root must declare recall context owner")
    assert_contains(source, "mod gateway_proactivity;", "gateway root must declare proactivity owner")
    assert_contains(source, "mod gateway_task_maintenance;", "gateway root must declare task maintenance owner")
    assert_contains(source, "mod gateway_memory_background;", "gateway root must declare memory background owner")
    assert_contains(source, "mod gateway_remote_approval;", "gateway root must declare remote approval owner")
    assert_contains(source, "mod gateway_plugins;", "gateway root must declare plugin enablement owner")
    assert_contains(source, "mod gateway_plugin_packages;", "gateway root must declare plugin package owner")
    assert_contains(source, "mod gateway_chat_threads;", "gateway root must declare chat thread owner")
    assert_contains(source, "mod gateway_chat_branches;", "gateway root must declare chat branch owner")
    assert_contains(source, "mod gateway_chat_tasks;", "gateway root must declare chat task owner")
    assert_contains(source, "mod gateway_chat_memory;", "gateway root must declare chat memory owner")
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
    assert_contains(source, "mod gateway_memory_dedup;", "gateway root must declare memory dedup owner")
    assert_contains(
        source,
        "mod gateway_memory_query_embeddings;",
        "gateway root must declare memory query embedding owner",
    )
    assert_contains(source, "mod gateway_memory_briefing;", "gateway root must declare memory briefing owner")
    assert_contains(
        source,
        "mod gateway_memory_turn_context;",
        "gateway root must declare memory turn context owner",
    )
    assert_contains(source, "mod gateway_memory_clients;", "gateway root must declare memory client owner")
    assert_contains(
        source,
        "mod gateway_memory_recall_service;",
        "gateway root must declare memory recall service owner",
    )
    assert_contains(source, "mod gateway_memory_graph;", "gateway root must declare memory graph owner")
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
    assert_contains(source, "mod gateway_chat_markers;", "gateway root must declare chat marker owner")
    assert_contains(
        source,
        "mod gateway_project_search_tools;",
        "gateway root must declare project search tools owner",
    )
    assert_contains(source, "mod gateway_datetime_tools;", "gateway root must declare datetime tools owner")
    assert_contains(source, "mod gateway_runtime_flags;", "gateway root must declare runtime flags owner")
    assert_contains(
        source,
        "mod gateway_runtime_settings;",
        "gateway root must declare runtime settings owner",
    )
    assert_contains(source, "mod gateway_model_routing;", "gateway root must declare model routing owner")
    assert_contains(
        source,
        "mod gateway_prompt_instructions;",
        "gateway root must declare prompt instructions owner",
    )
    assert_contains(source, "mod gateway_automation_tools;", "gateway root must declare automation tools owner")
    assert_contains(
        source,
        "mod gateway_automation_formatting;",
        "gateway root must declare automation formatting owner",
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
    assert_contains(source, "mod gateway_deliverables;", "gateway root must declare deliverables owner")
    assert_contains(source, "mod gateway_tool_execution;", "gateway root must declare tool execution owner")
    assert_contains(source, "mod gateway_channels;", "gateway root must declare channels owner")
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
