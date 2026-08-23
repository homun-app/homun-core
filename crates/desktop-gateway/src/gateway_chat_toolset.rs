//! Per-turn manager toolset assembly owner.
//!
//! Owns the composition of the model-visible manager tools for a chat turn:
//! native base schemas, objective/workflow pruning, live/deferred split,
//! workflow/atomic route injection, small MCP always-load, best-effort Composio
//! pre-retrieval, and the deferred capability corpus. It does not own schema
//! definitions, routing semantics, tool dispatch, browser execution, or the
//! agent loop.

use super::*;

pub(crate) struct ConnectedToolCatalogInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) project_root: Option<&'a std::path::Path>,
}

pub(crate) struct ConnectedToolCatalog {
    pub(crate) catalog_index: Vec<(String, String, serde_json::Value)>,
    pub(crate) composio_writes: std::collections::BTreeSet<String>,
    pub(crate) mcp_schemas: Vec<serde_json::Value>,
    pub(crate) inactive_services: Vec<String>,
    pub(crate) filesystem_mcp_instruction: Option<String>,
}

pub(crate) struct ChatToolsetInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) prompt: &'a str,
    pub(crate) turn_policy: &'a ChatTurnPolicy,
    pub(crate) contact_memory_perimeter: ContactMemoryPerimeter,
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

pub(crate) async fn prepare_connected_tool_catalog(
    input: ConnectedToolCatalogInput<'_>,
) -> ConnectedToolCatalog {
    let catalog = {
        let st = input.state.clone();
        tokio::task::spawn_blocking(move || composio_chat_tools_cached(&st, COMPOSIO_CATALOG_CAP))
            .await
            .unwrap_or_default()
    };
    let mcp_catalog = {
        let st = input.state.clone();
        tokio::task::spawn_blocking(move || mcp_chat_tools(&st, MCP_CATALOG_CAP))
            .await
            .unwrap_or_default()
    };

    connected_tool_catalog_from_sources(catalog, mcp_catalog, input.project_root)
}

fn connected_tool_catalog_from_sources(
    catalog: ComposioChatTools,
    mcp_catalog: McpChatTools,
    project_root: Option<&std::path::Path>,
) -> ConnectedToolCatalog {
    let mut composio_writes = catalog.writes;
    composio_writes.extend(mcp_catalog.writes.iter().cloned());
    // `send_message` is a side-effecting action routed through the same write-confirm card.
    composio_writes.insert("send_message".to_string());

    let mut catalog_index = connected_tool_catalog_index(&catalog.schemas);
    catalog_index.extend(connected_tool_catalog_index(&mcp_catalog.schemas));
    let filesystem_mcp_instruction = project_filesystem_mcp_instruction(
        project_root,
        filesystem_mcp_connected(&mcp_catalog.schemas),
    );

    ConnectedToolCatalog {
        catalog_index,
        composio_writes,
        mcp_schemas: mcp_catalog.schemas,
        inactive_services: catalog.inactive,
        filesystem_mcp_instruction,
    }
}

fn connected_tool_catalog_index(
    schemas: &[serde_json::Value],
) -> Vec<(String, String, serde_json::Value)> {
    schemas
        .iter()
        .filter_map(|schema| {
            let f = schema.get("function")?;
            let name = f.get("name")?.as_str()?.to_string();
            let desc = f.get("description").and_then(|d| d.as_str()).unwrap_or("");
            let haystack = format!("{name} {desc}").to_lowercase();
            Some((name, haystack, schema.clone()))
        })
        .collect()
}

fn filesystem_mcp_connected(schemas: &[serde_json::Value]) -> bool {
    schemas.iter().any(|schema| {
        schema
            .pointer("/function/name")
            .and_then(|name| name.as_str())
            .is_some_and(|name| name.starts_with("mcp__filesystem__"))
    })
}

pub(crate) async fn prepare_chat_toolset(input: ChatToolsetInput<'_>) -> ChatToolset {
    let read_only = input.turn_policy.read_only;
    let mut base_tools =
        initial_manager_tool_schemas_for_test(input.turn_policy, &input.contact_memory_perimeter);
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
    if !input.artifact_destinations.is_empty() && !read_only {
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
        turn_policy: input.turn_policy,
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_schema(name: &str, description: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": name,
                "description": description,
                "parameters": { "type": "object", "properties": {} }
            }
        })
    }

    #[test]
    fn connected_tool_catalog_merges_connector_and_mcp_writes() {
        let catalog = ComposioChatTools {
            schemas: vec![tool_schema("GMAIL_SEND_EMAIL", "Send an email")],
            writes: std::collections::BTreeSet::from(["GMAIL_SEND_EMAIL".to_string()]),
            inactive: vec!["gmail".to_string()],
        };
        let mcp_catalog = McpChatTools {
            schemas: vec![tool_schema("mcp__filesystem__write_file", "Write a file")],
            writes: std::collections::BTreeSet::from(["mcp__filesystem__write_file".to_string()]),
        };

        let connected = connected_tool_catalog_from_sources(
            catalog,
            mcp_catalog,
            Some(std::path::Path::new("/tmp/project")),
        );

        assert!(connected.composio_writes.contains("GMAIL_SEND_EMAIL"));
        assert!(
            connected
                .composio_writes
                .contains("mcp__filesystem__write_file")
        );
        assert!(connected.composio_writes.contains("send_message"));
        assert_eq!(connected.inactive_services, vec!["gmail"]);
        assert_eq!(connected.mcp_schemas.len(), 1);
        assert!(
            connected
                .filesystem_mcp_instruction
                .as_deref()
                .unwrap_or_default()
                .contains("/tmp/project")
        );
    }

    #[test]
    fn connected_tool_catalog_indexes_names_and_descriptions_for_discovery() {
        let catalog = ComposioChatTools {
            schemas: vec![tool_schema("SLACK_LIST_MESSAGES", "List Slack messages")],
            writes: std::collections::BTreeSet::new(),
            inactive: Vec::new(),
        };
        let mcp_catalog = McpChatTools {
            schemas: vec![tool_schema("mcp__drive__search", "Search Drive")],
            writes: std::collections::BTreeSet::new(),
        };

        let connected = connected_tool_catalog_from_sources(catalog, mcp_catalog, None);

        let indexed = connected
            .catalog_index
            .iter()
            .map(|(name, haystack, _)| (name.as_str(), haystack.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            indexed,
            vec![
                (
                    "SLACK_LIST_MESSAGES",
                    "slack_list_messages list slack messages"
                ),
                ("mcp__drive__search", "mcp__drive__search search drive"),
            ]
        );
        assert!(connected.filesystem_mcp_instruction.is_none());
    }
}
