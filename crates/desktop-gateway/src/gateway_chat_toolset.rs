//! Per-turn manager toolset assembly owner.
//!
//! Owns the composition of the model-visible manager tools for a chat turn:
//! native base schemas, objective/workflow pruning, live/deferred split,
//! workflow/atomic route injection, small MCP always-load, best-effort Composio
//! pre-retrieval, and the deferred capability corpus. It does not own schema
//! definitions, routing semantics, tool dispatch, browser execution, or the
//! agent loop.

use super::*;

pub(crate) struct ChatToolsetInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) prompt: &'a str,
    pub(crate) read_only: bool,
    pub(crate) contact_only: bool,
    pub(crate) memory_recall_allowed: bool,
    pub(crate) has_skills: bool,
    pub(crate) artifact_destinations: &'a [ArtifactDestination],
    pub(crate) objective_effect_policy: &'a semantic_decision::ObjectiveEffectPolicy,
    pub(crate) composio_writes: &'a std::collections::BTreeSet<String>,
    pub(crate) workflow_route: &'a WorkflowRouteDecision,
    pub(crate) workflow_deny_tools: &'a [String],
    pub(crate) browser_continuation_available: bool,
    pub(crate) capability_route: &'a CapabilityRouteDecision,
    pub(crate) hitl_choice_resume_active: bool,
    pub(crate) mcp_schemas: &'a [serde_json::Value],
    pub(crate) has_composio: bool,
    pub(crate) catalog_index: &'a [(String, String, serde_json::Value)],
    pub(crate) enabled_skills: &'a [(String, String, String)],
}

pub(crate) struct ChatToolset {
    pub(crate) base_tools: Vec<serde_json::Value>,
    pub(crate) capability_corpus: Vec<CapabilityEntry>,
}

pub(crate) async fn prepare_chat_toolset(input: ChatToolsetInput<'_>) -> ChatToolset {
    let mut base_tools = initial_manager_tool_schemas_for_test(input.read_only, input.contact_only);
    if input.memory_recall_allowed {
        base_tools.push(recall_memory_tool_schema());
    }
    base_tools.extend([
        query_code_graph_tool_schema(),
        query_git_history_tool_schema(),
        github_search_tool_schema(),
        suggest_capabilities_tool_schema(),
        resolve_datetime_tool_schema(),
    ]);
    if !input.read_only {
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
        base_tools.push(run_in_sandbox_tool_schema());
        base_tools.push(read_file_tool_schema());
        base_tools.push(write_file_tool_schema());
        base_tools.push(edit_file_tool_schema());
        base_tools.push(apply_patch_tool_schema());
        base_tools.push(list_files_tool_schema());
        base_tools.push(list_directory_tool_schema());
        base_tools.push(read_text_file_tool_schema());
        base_tools.push(run_in_project_tool_schema());
        if addons_enabled() {
            base_tools.push(list_addons_tool_schema());
            base_tools.push(show_addon_tool_schema());
            base_tools.push(customize_addon_tool_schema());
        }
    }
    if input.has_skills {
        base_tools.push(use_skill_tool_schema());
    }
    if !input.artifact_destinations.is_empty() && !input.read_only {
        base_tools.push(save_artifact_tool_schema(input.artifact_destinations));
    }
    prune_tools_for_objective_policy(
        &mut base_tools,
        input.objective_effect_policy,
        input.composio_writes,
    );
    prune_tools_for_route(
        &mut base_tools,
        input.workflow_route,
        input.workflow_deny_tools,
    );

    let (mut base_tools, deferred_tools): (Vec<serde_json::Value>, Vec<serde_json::Value>) =
        base_tools.into_iter().partition(|schema| {
            schema
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .map(|name| tool_stays_live_this_turn(name, input.browser_continuation_available))
                .unwrap_or(false)
        });

    match input.capability_route {
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

    if input.hitl_choice_resume_active {
        hitl_resume::prune_cold_discovery_tools(
            &mut base_tools,
            !input.browser_continuation_available,
        );
    }

    const MCP_ALWAYS_LOAD_MAX: usize = 24;
    if !input.mcp_schemas.is_empty() && input.mcp_schemas.len() <= MCP_ALWAYS_LOAD_MAX {
        for schema in input.mcp_schemas {
            base_tools.push(schema.clone());
        }
    }

    if input.has_composio {
        let loaded: std::collections::HashSet<String> = base_tools
            .iter()
            .filter_map(|schema| {
                schema
                    .pointer("/function/name")
                    .and_then(|value| value.as_str())
                    .map(String::from)
            })
            .collect();
        for schema in
            auto_retrieve_composio(&input.state.http, input.prompt, input.catalog_index, 4).await
        {
            let name = schema
                .pointer("/function/name")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string();
            if !name.is_empty() && !loaded.contains(&name) {
                base_tools.push(schema);
            }
        }
    }

    prune_tools_for_objective_policy(
        &mut base_tools,
        input.objective_effect_policy,
        input.composio_writes,
    );
    prune_tools_for_route(
        &mut base_tools,
        input.workflow_route,
        input.workflow_deny_tools,
    );
    let capability_corpus = materialize_capability_corpus(CapabilityCorpusMaterializationInput {
        deferred_tools,
        read_only: input.read_only,
        objective_effect_policy: input.objective_effect_policy,
        composio_writes: input.composio_writes,
        mcp_schemas: input.mcp_schemas,
        enabled_skills: input.enabled_skills,
    });

    ChatToolset {
        base_tools,
        capability_corpus,
    }
}
