//! HTTP route assembly for the desktop gateway.
//!
//! Keep this module focused on wiring paths to existing handlers and middleware.
//! Handler behavior remains owned by its feature module or the legacy handler
//! functions while `main.rs` stays responsible for process startup only.

use std::env;

use axum::{
    Router, middleware,
    routing::{delete, get, post, put},
};

use crate::agent_journal::debug_turn_journal;
use crate::gateway_chat_branches::{chat_branches, set_active_leaf, set_branch_label};
use crate::gateway_chat_memory::save_chat_message_to_memory;
use crate::gateway_chat_tasks::create_task_from_chat_message;
use crate::gateway_chat_threads::{
    archive_chat_thread, chat_messages, chat_thread_attentions, chat_threads, create_chat_thread,
    delete_chat_thread, mark_chat_thread_seen, rename_chat_thread, reorder_chat_threads,
    select_chat_thread, set_chat_thread_pinned, unarchive_chat_thread,
};
use crate::gateway_memory_publications::{
    memory_publication_approve, memory_publication_create, memory_publication_edit,
    memory_publication_get, memory_publication_reject,
};
use crate::gateway_memory_sources::{
    memory_source_candidates, memory_source_revoke, memory_source_upsert, memory_sources_list,
};
use crate::gateway_project_access::{
    project_access_list, project_access_remove, project_access_upsert,
};
use crate::gateway_skill_routes::{
    install_catalog_skill, install_registry_skill, list_skills, preview_catalog_skill,
    registry_skills, set_skill_enabled, skill_catalog, skill_catalog_refresh, skill_detail,
};
use crate::gateway_tags::{
    tags_all_assignments, tags_assign, tags_create, tags_delete, tags_entities,
    tags_for_entity_handler, tags_list, tags_rename, tags_set_color, tags_unassign,
};
use crate::gateway_update_routes::{update_info, update_trigger};
use crate::*;

pub(crate) fn build_gateway_router(state: AppState) -> Router {
    let chat_routes = Router::new()
        .route(
            "/api/chat/threads",
            get(chat_threads).post(create_chat_thread),
        )
        .route("/api/chat/threads/attention", get(chat_thread_attentions))
        .route(
            "/api/chat/threads/{thread_id}/seen",
            post(mark_chat_thread_seen),
        )
        .route(
            "/api/chat/threads/{thread_id}/select",
            post(select_chat_thread),
        )
        .route(
            "/api/chat/threads/{thread_id}/pin",
            post(set_chat_thread_pinned),
        )
        .route(
            "/api/chat/threads/{thread_id}/rename",
            post(rename_chat_thread),
        )
        .route("/api/chat/threads/reorder", post(reorder_chat_threads))
        .route(
            "/api/chat/threads/{thread_id}/archive",
            post(archive_chat_thread),
        )
        .route(
            "/api/chat/threads/{thread_id}/unarchive",
            post(unarchive_chat_thread),
        )
        .route("/api/chat/threads/{thread_id}", delete(delete_chat_thread))
        .route("/api/chat/threads/{thread_id}/messages", get(chat_messages))
        .route(
            "/api/chat/threads/{thread_id}/kernel-projection",
            get(thread_kernel_projection),
        )
        .route(
            "/api/chat/threads/{thread_id}/steering",
            get(list_thread_steering),
        )
        .route(
            "/api/chat/steering/{steering_id}",
            axum::routing::patch(update_steering).delete(delete_steering),
        )
        .route(
            "/api/chat/steering/{steering_id}/send-now",
            post(send_steering_now),
        )
        .route("/api/chat/threads/{thread_id}/branches", get(chat_branches))
        .route(
            "/api/chat/threads/{thread_id}/active_leaf",
            post(set_active_leaf),
        )
        .route(
            "/api/chat/threads/{thread_id}/branch_label",
            post(set_branch_label),
        )
        .route(
            "/api/chat/threads/{thread_id}/messages/{message_id}/create_task",
            post(create_task_from_chat_message),
        )
        .route(
            "/api/chat/threads/{thread_id}/messages/{message_id}/save_to_memory",
            post(save_chat_message_to_memory),
        )
        .route("/api/chat/build_prompt", post(gateway_prompt::build_prompt))
        .route("/api/chat/stream_resume/{request_id}", get(resume_stream))
        .route("/api/chat/active_streams", get(active_streams))
        .route("/api/events", get(app_events))
        .route("/api/chat/improve_prompt", post(improve_prompt))
        .route("/api/chat/transcribe", post(transcribe_audio))
        .route(
            "/api/artifacts/file",
            get(download_artifact).delete(delete_artifact_file),
        )
        .route("/api/artifacts/pdf-pages", get(artifact_pdf_pages))
        .route("/api/artifacts/path", get(artifact_folder_path))
        .route("/api/artifacts/versions", get(artifact_versions))
        .route("/api/artifacts/content", post(save_artifact_content))
        .route("/api/artifacts/usage", get(artifacts_usage))
        .route("/api/artifacts/export", post(export_artifacts_zip))
        .route(
            "/api/artifacts/memory",
            get(memory_artifacts).delete(delete_memory_artifact),
        )
        .route("/api/artifacts/thread", delete(delete_artifact_thread))
        .route("/api/artifacts/clear", post(clear_artifacts))
        .route(
            "/api/artifacts/destinations",
            get(list_artifact_destinations)
                .post(add_artifact_destination)
                .delete(remove_artifact_destination),
        )
        .route("/api/chat/suggestions", post(chat_suggestions))
        .route(
            "/api/chat/threads/{thread_id}/autotitle",
            post(autotitle_chat_thread),
        )
        .route(
            "/api/chat/threads/{thread_id}/assistant_message",
            post(seed_assistant_message),
        )
        .route(
            "/api/chat/threads/{thread_id}/proactive_answer",
            post(proactive_answer),
        )
        .route(
            "/api/chat/threads/{thread_id}/folder",
            get(get_thread_folder).post(set_thread_folder),
        )
        .route(
            "/api/chat/threads/{thread_id}/files",
            get(search_thread_files),
        )
        .route("/api/chat/threads/{thread_id}/file", get(read_thread_file))
        .route(
            "/api/runtime/model",
            get(runtime_model).post(set_runtime_model),
        )
        .route("/api/runtime/models", get(runtime_models))
        .route(
            "/api/runtime/settings",
            get(get_runtime_settings).post(set_runtime_settings),
        )
        .route(
            "/api/runtime/llm-concurrency",
            get(get_llm_concurrency).post(set_llm_concurrency),
        )
        .route("/api/usage/summary", get(get_usage_summary))
        .route("/api/usage/daily", get(get_usage_daily))
        .route("/api/usage/models", get(get_usage_models))
        .route("/api/usage/providers", get(get_usage_providers))
        .route("/api/usage/processes", get(get_usage_processes))
        .route("/api/usage/suggestions", get(get_usage_suggestions))
        .route(
            "/api/usage/suggestions/{suggestion_key}/apply",
            post(apply_usage_suggestion),
        )
        .route(
            "/api/usage/suggestions/{suggestion_key}/dismiss",
            post(dismiss_usage_suggestion),
        )
        .route(
            "/api/usage/providers/{provider_id}/refresh",
            post(refresh_usage_provider),
        )
        .route(
            "/api/usage/providers/{provider_id}/policy",
            get(get_usage_provider_policy).put(set_usage_provider_policy),
        )
        .route(
            "/api/prefs/timezone",
            get(get_user_timezone).post(set_user_timezone),
        )
        .route(
            "/api/prefs/language",
            get(get_user_language).post(set_user_language),
        )
        .route("/api/setup/status", get(get_setup_status))
        .route("/api/setup/validate-llm", post(validate_llm_config))
        .route("/api/setup/complete", post(complete_setup))
        .route("/api/setup/ollama", get(get_ollama_setup))
        .route("/api/setup/pull-model", post(pull_model))
        .route("/api/setup/computer/prepare", post(prepare_setup_computer))
        .route("/api/setup/computer/status", get(get_setup_computer_status))
        .route(
            "/api/prefs/approval-routing",
            get(get_approval_routing).post(set_approval_routing),
        )
        .route("/api/prefs/channel-identities", get(channel_identities))
        .route("/api/tools/runs", get(tool_runs_list))
        .route("/api/suggestions", get(suggestions_list))
        .route("/api/suggestions/{id}/act", post(suggestion_act))
        .route("/api/proactivity/review-now", post(proactivity_review_now))
        .route("/api/plugins", get(crate::gateway_plugins::plugins_list))
        .route("/api/brand-kit", get(brand_kit_get).put(brand_kit_put))
        .route(
            "/api/plugins/{id}/toggle",
            post(crate::gateway_plugins::plugin_toggle),
        )
        .route(
            "/api/plugins/packages/install-local",
            post(crate::gateway_plugin_packages::install_local_plugin_package),
        )
        .route(
            "/api/plugins/packages/install-from-registry",
            post(crate::gateway_plugin_packages::install_plugin_package_from_registry),
        )
        .route(
            "/api/plugins/packages/update-from-registry",
            post(crate::gateway_plugin_packages::update_plugin_package_from_registry),
        )
        .route(
            "/api/plugins/packages/installed",
            get(crate::gateway_plugin_packages::installed_plugin_packages),
        )
        .route(
            "/api/plugins/packages/updates",
            get(crate::gateway_plugin_packages::plugin_package_updates),
        )
        .route(
            "/api/plugins/trusted-keys",
            get(crate::gateway_plugin_packages::trusted_plugin_public_keys)
                .put(crate::gateway_plugin_packages::set_trusted_plugin_public_keys),
        )
        .route(
            "/api/plugins/licenses",
            get(crate::gateway_plugin_packages::plugin_licenses)
                .put(crate::gateway_plugin_packages::set_plugin_license),
        )
        .route(
            "/api/plugins/registry/cache",
            get(crate::gateway_plugin_packages::cached_plugin_registry)
                .post(crate::gateway_plugin_packages::cache_plugin_registry),
        )
        .route(
            "/api/plugins/registry/fetch",
            post(crate::gateway_plugin_packages::fetch_plugin_registry),
        )
        .route(
            "/api/runtime/provider",
            get(runtime_provider).post(set_runtime_provider),
        )
        .route("/api/providers", get(list_providers).post(upsert_provider))
        .route("/api/providers/{id}", delete(remove_provider))
        .route("/api/providers/{id}/models", post(refresh_provider_models))
        .route(
            "/api/providers/{id}/generate-profiles",
            post(generate_provider_profiles),
        )
        .route("/api/providers/{id}/enabled", post(set_provider_enabled))
        .route("/api/model-profile", post(set_model_profile))
        .route("/api/roles", get(list_roles).post(set_role))
        .route("/api/routing-decisions", get(list_routing_decisions))
        .route("/api/skills", get(list_skills))
        .route("/api/skills/registry", get(registry_skills))
        .route("/api/skills/registry/install", post(install_registry_skill))
        .route("/api/skills/catalog", get(skill_catalog))
        .route("/api/skills/catalog/refresh", post(skill_catalog_refresh))
        .route("/api/skills/catalog/install", post(install_catalog_skill))
        .route("/api/skills/catalog/preview", get(preview_catalog_skill))
        .route("/api/templates/catalog", get(template_catalog))
        .route("/api/templates/import-pptx", post(import_pptx_template))
        .route("/api/templates/delete", post(delete_template))
        .route("/api/templates/preview", get(template_preview))
        .route(
            "/api/templates/source-attachment",
            post(template_source_attachment),
        )
        .route("/api/skills/{id}", get(skill_detail))
        .route("/api/skills/{id}/enabled", post(set_skill_enabled))
        .route("/api/tasks/queue", get(task_queue))
        .route("/api/tasks/executor", get(task_executor_status))
        .route("/api/tasks/run_next", post(run_next_task))
        .route("/api/effects/uncertain", get(uncertain_effect_receipts))
        .route(
            "/api/effects/{receipt_ref}/resolve",
            post(resolve_uncertain_effect_receipt),
        )
        .route("/api/tasks/{task_id}/cancel", post(cancel_task))
        .route("/api/tasks/{task_id}", get(task_detail))
        .route(
            "/api/automations/event-sources",
            get(automation_event_sources),
        )
        .route(
            "/api/automations",
            get(automations_list).post(automation_create),
        )
        .route("/api/automations/dry-run", post(automation_dry_run))
        .route("/api/automations/{id}/toggle", post(automation_toggle))
        .route("/api/automations/{id}/runs", get(automation_runs))
        .route(
            "/api/automations/{id}",
            put(automation_update).delete(automation_delete),
        )
        .route(
            "/api/approvals/{approval_id}/approve",
            post(approve_approval),
        )
        .route("/api/approvals/{approval_id}/reject", post(reject_approval))
        .route(
            "/api/local-computer/sessions/{session_id}",
            get(local_computer_session),
        )
        .route(
            "/api/local-computer/sessions/{session_id}/artifacts/{artifact_id}/preview",
            get(local_computer_artifact_preview),
        )
        .route("/api/local-computer/live", get(contained_computer_live))
        .route("/api/local-computer/start", post(local_computer_start))
        .route("/api/local-computer/stop", post(local_computer_stop))
        .route(
            "/api/host-computer/status",
            get(host_computer_gateway::status),
        )
        .route("/api/host-computer/apps", get(host_computer_gateway::apps))
        .route(
            "/api/host-computer/grants",
            get(host_computer_gateway::list_grants).post(host_computer_gateway::create_grant),
        )
        .route(
            "/api/host-computer/grants/{grant_id}",
            axum::routing::delete(host_computer_gateway::revoke_grant),
        )
        .route(
            "/api/host-computer/permissions/present",
            post(host_computer_gateway::present_permission),
        )
        .route(
            "/api/host-computer/sessions/{session_id}/approve",
            post(host_computer_gateway::approve_session),
        )
        .route(
            "/api/host-computer/sessions/{session_id}/deny",
            post(host_computer_gateway::deny_session),
        )
        .route(
            "/api/host-computer/sessions/{session_id}/pause",
            post(host_computer_gateway::pause_session),
        )
        .route(
            "/api/host-computer/sessions/{session_id}/resume",
            post(host_computer_gateway::resume_session),
        )
        .route(
            "/api/host-computer/sessions/{session_id}/cancel",
            post(host_computer_gateway::cancel_session),
        )
        // Bearer-authed: mint a short-lived ticket for the noVNC live-view proxy
        // (the iframe + WS that follow can't send the Bearer header).
        .route(
            "/api/computer/novnc-ticket",
            post(novnc_proxy::novnc_ticket),
        )
        .route("/api/system/status", get(system_status))
        .route("/api/update/info", get(update_info))
        .route("/api/update/trigger", post(update_trigger))
        .route("/api/system/browser/close-all", post(close_all_browsers))
        .route("/api/memory/dashboard", get(memory_dashboard))
        .route("/api/memory/bench/ingest", post(memory_bench_ingest))
        .route("/api/memory/bench/status", post(memory_bench_status))
        .route("/api/memory/bench/search", post(memory_bench_search))
        .route("/api/memory/export", get(memory_export))
        .route("/api/export", get(export_user_data))
        .route("/api/memory/items", get(memory_items))
        .route("/api/memory/graph", get(memory_graph))
        .route("/api/memory/graph/merge", post(memory_graph_merge))
        .route(
            "/api/memory/hygiene/suggestions",
            get(memory_hygiene_suggestions),
        )
        .route("/api/memory/graphify/import", post(memory_graphify_import))
        .route(
            "/api/memory/project-graph/ensure",
            post(project_graph_ensure),
        )
        .route(
            "/api/memory/project-graph/subdirs",
            get(project_graph_subdirs),
        )
        .route("/api/memory/goals", get(memory_goals_list))
        .route("/api/memory/project-briefing", get(memory_project_briefing))
        .route("/api/memory/goals/suggest", post(memory_goals_suggest))
        .route("/api/memory/goals/promote", post(memory_goals_promote))
        .route("/api/memory/goals/add", post(memory_goals_add))
        .route("/api/memory/wiki", get(memory_wiki).put(memory_wiki_save))
        .route("/api/memory/consolidate", post(memory_consolidate))
        .route("/api/memory/decide", post(memory_decide))
        .route("/api/vault/records", get(vault_records_list))
        .route("/api/vault/records/{id}/reveal", post(vault_record_reveal))
        .route(
            "/api/vault/records/{id}",
            delete(vault_record_delete).patch(vault_record_update),
        )
        .route("/api/vault/proposals/accept", post(vault_proposal_accept))
        .route("/api/vault/proposals/dismiss", post(vault_proposal_dismiss))
        .route("/api/vault/pin/status", get(vault_pin_status))
        .route("/api/vault/pin/setup", post(vault_pin_setup))
        .route("/api/vault/pin/verify", post(vault_pin_verify))
        .route(
            "/api/vault/payment-approvals/approve",
            post(vault_payment_approval_approve),
        )
        .route("/api/memory/contacts", get(contacts_list))
        .route("/api/memory/contacts/memories", post(contact_memories))
        .route("/api/memory/contacts/profile", post(contact_profile))
        .route(
            "/api/memory/contacts/profile/refresh",
            post(contact_profile_refresh),
        )
        .route("/api/memory/contacts/update", post(contact_update))
        .route("/api/memory/contacts/merge", post(contacts_merge))
        .route("/api/memory/contacts/create", post(contact_create))
        .route(
            "/api/memory/contacts/identity/add",
            post(contact_identity_add),
        )
        .route(
            "/api/memory/contacts/identity/remove",
            post(contact_identity_remove),
        )
        .route("/api/memory/contacts/delete", post(contact_delete))
        .route(
            "/api/memory/contacts/perimeter",
            post(contact_perimeter_get),
        )
        .route(
            "/api/memory/contacts/perimeter/update",
            post(contact_perimeter_set),
        )
        .route("/api/profiles", get(profiles_list))
        .route("/api/profiles/create", post(profile_create))
        .route("/api/profiles/update", post(profile_update))
        .route("/api/profiles/delete", post(profile_delete))
        .route(
            "/api/memory/contacts/assign-profile",
            post(contact_assign_profile),
        )
        .route(
            "/api/memory/contacts/relationships",
            post(contact_relationships),
        )
        .route(
            "/api/memory/contacts/relationships/add",
            post(contact_relationship_add),
        )
        .route(
            "/api/memory/contacts/relationships/remove",
            post(contact_relationship_remove),
        )
        .route(
            "/api/channels/settings",
            get(get_channel_settings).post(set_channel_settings),
        )
        .route("/api/channels/whatsapp/status", get(whatsapp_status))
        .route("/api/channels/whatsapp/connect", post(whatsapp_connect))
        .route(
            "/api/channels/whatsapp/disconnect",
            post(whatsapp_disconnect),
        )
        .route("/api/channels/whatsapp/send", post(whatsapp_send))
        .route("/api/channels/whatsapp/inbound", post(whatsapp_inbound))
        .route("/api/channels/telegram/status", get(telegram_status))
        .route("/api/channels/telegram/connect", post(telegram_connect))
        .route(
            "/api/channels/telegram/disconnect",
            post(telegram_disconnect),
        )
        .route("/api/channels/telegram/inbound", post(telegram_inbound))
        .route("/api/channels/telegram/callback", post(telegram_callback))
        .route("/api/capabilities/snapshot", get(capability_snapshot))
        .route(
            "/api/workspaces",
            get(workspaces_list).post(create_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/select",
            post(select_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/folder",
            post(set_workspace_folder),
        )
        .route(
            "/api/workspaces/{workspace_id}/rename",
            post(rename_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/policy",
            post(set_workspace_policy),
        )
        .route(
            "/api/workspaces/{workspace_id}/delete",
            post(delete_workspace),
        )
        .route("/api/workspaces/reorder", post(reorder_workspaces))
        // Tags (cross-project colored labels on projects + conversations).
        .route("/api/tags", get(tags_list).post(tags_create))
        .route("/api/tags/assignments", get(tags_all_assignments))
        .route("/api/tags/{tag_id}/rename", post(tags_rename))
        .route("/api/tags/{tag_id}/color", post(tags_set_color))
        .route("/api/tags/{tag_id}/delete", post(tags_delete))
        .route("/api/tags/{tag_id}/assign", post(tags_assign))
        .route("/api/tags/{tag_id}/unassign", post(tags_unassign))
        .route("/api/tags/{tag_id}/entities", get(tags_entities))
        .route(
            "/api/tags/entity/{entity_type}/{entity_id}",
            get(tags_for_entity_handler),
        )
        .route(
            "/api/workspaces/{workspace_id}/access",
            get(project_access_list),
        )
        .route(
            "/api/workspaces/{workspace_id}/access/upsert",
            post(project_access_upsert),
        )
        .route(
            "/api/workspaces/{workspace_id}/access/remove",
            post(project_access_remove),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources",
            get(memory_sources_list),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources/upsert",
            post(memory_source_upsert),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources/{grant_id}/revoke",
            post(memory_source_revoke),
        )
        .route(
            "/api/workspaces/{workspace_id}/memory-sources/candidates",
            get(memory_source_candidates),
        )
        .route("/api/memory/publications", post(memory_publication_create))
        .route(
            "/api/memory/publications/{proposal_id}",
            get(memory_publication_get),
        )
        .route(
            "/api/memory/publications/{proposal_id}/edit",
            post(memory_publication_edit),
        )
        .route(
            "/api/memory/publications/{proposal_id}/approve",
            post(memory_publication_approve),
        )
        .route(
            "/api/memory/publications/{proposal_id}/reject",
            post(memory_publication_reject),
        )
        .route("/api/capabilities/mcp/connect", post(connect_mcp))
        .route("/api/capabilities/mcp/execute", post(mcp_execute))
        .route("/api/capabilities/mcp/registry", get(mcp_registry_search))
        .route("/api/capabilities/mcp/connected", get(mcp_connected))
        .route("/api/capabilities/mcp/disconnect", post(mcp_disconnect))
        .route("/api/capabilities/run/escalate", post(run_escalate))
        .route("/api/fs/authorize", post(fs_authorize))
        .route("/api/fs/list", get(fs_list))
        .route("/api/fs/file", get(fs_file))
        .route("/api/connect/mark", post(connect_mark))
        .route("/api/capabilities/composio/connect", post(connect_composio))
        .route(
            "/api/capabilities/composio/toolkits",
            get(composio_toolkits),
        )
        .route(
            "/api/capabilities/composio/toolkits/{slug}/auth",
            get(composio_toolkit_auth),
        )
        .route("/api/capabilities/composio/link", post(composio_link))
        .route(
            "/api/capabilities/composio/connections",
            get(composio_connections),
        )
        .route(
            "/api/capabilities/composio/connections/{id}",
            delete(composio_disconnect),
        )
        .route("/api/capabilities/composio/execute", post(composio_execute))
        .route(
            "/api/capabilities/composio/allowed-tools",
            get(composio_allowed_tools),
        )
        .route(
            "/api/capabilities/composio/allowed-tools/{slug}",
            delete(composio_revoke_allowed_tool),
        );
    // Turn broker HTTP surface -- the only chat path. Registered before the token layer
    // is applied (below) so these routes are still bearer-gated like the rest of /api.
    let chat_routes = chat_routes
        .route("/api/integrity/audit", get(integrity_audit))
        .route(
            "/api/integrity/linked-memory/repair/preview",
            post(linked_memory_repair_preview),
        )
        .route(
            "/api/integrity/linked-memory/repair/apply",
            post(linked_memory_repair_apply),
        )
        .route(
            "/api/integrity/repair/preview",
            post(integrity_repair_preview),
        )
        .route("/api/integrity/repair/apply", post(integrity_repair_apply))
        .route("/api/chat/turns", post(enqueue_turn))
        .route(
            "/api/chat/turns/{turn_id}",
            get(get_turn).delete(cancel_turn),
        )
        .route("/api/chat/turns/{turn_id}/events", get(get_turn_events))
        .route("/api/chat/turns/{turn_id}/runs", get(get_agent_runs))
        .route(
            "/api/chat/threads/{thread_id}/runs",
            get(get_thread_agent_runs),
        )
        .route(
            "/api/chat/threads/{thread_id}/runtime-plan",
            get(get_thread_runtime_plan),
        )
        .route(
            "/api/chat/threads/{thread_id}/runtime-context",
            get(get_thread_runtime_context),
        )
        .route(
            "/api/chat/threads/{thread_id}/ledger",
            get(get_thread_working_ledger),
        )
        .route("/api/chat/runs/{run_id}/events", get(get_agent_run_events))
        .route(
            "/api/chat/runs/{run_id}/prompt/latest",
            get(get_latest_agent_prompt),
        )
        .route(
            "/api/chat/runs/{run_id}/checkpoint/latest",
            get(get_latest_agent_checkpoint),
        )
        .route(
            "/api/chat/turns/{turn_id}/stream",
            get(subscribe_turn_stream),
        )
        .route(
            "/api/debug/turns/{turn_id}/journal",
            get(debug_turn_journal),
        );
    let chat_routes = chat_routes.route_layer(middleware::from_fn_with_state(
        state.clone(),
        gateway_auth::require_gateway_token::<AppState>,
    ));
    let mut app = Router::new()
        .route("/api/health", get(gateway_health::health::<AppState>))
        // Unified WS endpoint: OUTSIDE the bearer layer (WS upgrade can't always
        // carry the header). See the unified-websocket-design spec.
        .route("/api/ws", get(ws_gateway::ws_handler))
        // noVNC live-view proxy: OUTSIDE the bearer layer (an iframe/WS can't send
        // the header) -- gated instead by the short-lived ticket. The exact
        // `/websockify` match wins over the asset catch-all.
        .route("/api/computer/novnc/websockify", get(novnc_proxy::novnc_ws))
        .route("/api/computer/novnc/{*path}", get(novnc_proxy::novnc_asset))
        // Composio brand logos: OUTSIDE the bearer layer for the same reason as the two above -- an
        // `<img>` tag can't send the Authorization header, and the token has no business in a URL.
        // Serves a public logo keyed by slug (no user data), on a loopback-only listener.
        .route(
            "/api/capabilities/composio/toolkits/{slug}/logo",
            get(composio_toolkit_logo),
        )
        .merge(chat_routes)
        .with_state(state);
    // Server/PaaS mode: serve the built web UI on the same port (one deployable
    // unit) when HOMUN_WEB_DIR points at the vite build output. Mounted outside
    // the token layer so the SPA can load; its JS then sends the bearer token for
    // /api calls. Unknown paths fall back to index.html for client-side routing.
    if let Ok(web_dir) = env::var("HOMUN_WEB_DIR")
        && !web_dir.trim().is_empty()
    {
        let index = std::path::Path::new(&web_dir).join("index.html");
        app = app.fallback_service(
            tower_http::services::ServeDir::new(&web_dir)
                .not_found_service(tower_http::services::ServeFile::new(index)),
        );
    }
    app.layer(gateway_cors::cors_layer())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_gateway_router_from_test_state() {
        let _router = build_gateway_router(crate::AppState::for_tests());
    }
}
