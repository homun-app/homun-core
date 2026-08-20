use crate::gateway_identity::{gateway_memory_user_id, gateway_memory_workspace_id};
use crate::gateway_memory_prompt_context::{
    artifact_provenance_context_for_query, workflow_status_context_for_query,
};
use crate::gateway_memory_recall_service::recall_pack_on_facade;
use crate::gateway_memory_sources::memory_sources_enabled;
use crate::gateway_recall_context::{
    format_recall_entry, recall_collection_token, recall_source_label,
    recall_stream_payload_from_pack,
};
use crate::{
    AppState, lock_vault_store, memory_facade, recall_memory_response_with_vault_fallback,
};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryAccessRequest, MemoryCollectionKey,
    MemorySearchRequest, MemoryStatus, PERSONAL_WORKSPACE, PrivacyDomain,
    WorkspaceId as MemoryWorkspaceId,
};

/// Esito di `recall_memory`: la risposta testuale per il modello e il payload
/// UI costruito dagli stessi hit autorizzati. ADR 0022 (Piano UI A2/A3).
pub(crate) struct RecallOutcome {
    /// Risposta formattata per il modello (stringa tool result).
    pub(crate) response: String,
    /// Provenienza completa: non ricostruire mai gli hit nel trasporto del tool.
    pub(crate) payload: local_first_subagents::RecallStreamPayload,
}

pub(crate) fn recall_stream_payload_from_outcome(
    outcome: &RecallOutcome,
    query: &str,
) -> local_first_subagents::RecallStreamPayload {
    let mut payload = outcome.payload.clone();
    payload.query = if query.is_empty() {
        "(query)".to_string()
    } else {
        query.to_string()
    };
    payload
}

pub(crate) fn recall_memory(
    state: &AppState,
    query: &str,
    vault_value_requested: bool,
) -> RecallOutcome {
    let query = query.trim();
    let empty = |msg: &str| -> RecallOutcome {
        RecallOutcome {
            response: msg.to_string(),
            payload: local_first_subagents::RecallStreamPayload {
                query: query.to_string(),
                hits: Vec::new(),
                scope: "personal".to_string(),
                status: "empty".to_string(),
            },
        }
    };
    if query.is_empty() {
        return empty("No query provided.");
    }
    let facade = memory_facade(state);
    if facade.memory_health().is_err() {
        return RecallOutcome {
            response: "Memory is unavailable; the search was not completed.".to_string(),
            payload: local_first_subagents::RecallStreamPayload {
                query: query.to_string(),
                hits: Vec::new(),
                scope: "personal".to_string(),
                status: "unavailable".to_string(),
            },
        };
    }
    let user = gateway_memory_user_id();
    let active = gateway_memory_workspace_id();
    let search = |workspace: MemoryWorkspaceId| -> Vec<local_first_subagents::RecallStreamHit> {
        let access = MemoryAccessRequest {
            actor_id: "recall".to_string(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            purpose: "recall".to_string(),
            allowed_domains: vec![
                PrivacyDomain::new("personal"),
                PrivacyDomain::new("work"),
                PrivacyDomain::new("general"),
            ],
            max_sensitivity: MemoryDataSensitivity::Secret,
            allow_raw_payload: true,
            allow_export: true,
            broad_query: true,
        };
        facade
            .search_memories(MemorySearchRequest {
                access,
                query: query.to_string(),
                statuses: vec![MemoryStatus::Confirmed, MemoryStatus::Candidate],
                memory_types: Vec::new(),
                limit: 8,
                offset: 0,
            })
            .map(|page| {
                page.items
                    .into_iter()
                    .map(|item| {
                        let collection = [
                            MemoryCollectionKey::Preferences,
                            MemoryCollectionKey::Profile,
                            MemoryCollectionKey::Knowledge,
                            MemoryCollectionKey::Decisions,
                            MemoryCollectionKey::Goals,
                            MemoryCollectionKey::Artifacts,
                            MemoryCollectionKey::Episodes,
                        ]
                        .into_iter()
                        .find(|collection| {
                            collection.matches_candidate(&item.memory_type, &item.metadata)
                        })
                        .unwrap_or(MemoryCollectionKey::Knowledge);
                        local_first_subagents::RecallStreamHit {
                            r#ref: item.reference.to_string(),
                            text: format_recall_entry(&item.summary, &item.metadata),
                            score: 1.0 / item.rank.max(1) as f32,
                            kind: item.memory_type,
                            source_workspace_id: workspace.as_str().to_string(),
                            source_label: recall_source_label(workspace.as_str()),
                            collection: recall_collection_token(collection).to_string(),
                            grant_id: None,
                            policy_version: None,
                            source_revision: None,
                            conflict: false,
                            graph_path: Vec::new(),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    let in_project = active.as_str() != PERSONAL_WORKSPACE;
    let mut lines = Vec::new();
    // Keep the full structured hit alongside the text given to the model.
    let mut ui_hits: Vec<local_first_subagents::RecallStreamHit> = Vec::new();
    if memory_sources_enabled() && in_project {
        let pack = recall_pack_on_facade(facade, &user, &active, query, &[], None);
        let payload = recall_stream_payload_from_pack(&pack);
        for hit in pack.hits {
            lines.push(format!("- [{}] {}", hit.kind, hit.text));
        }
        ui_hits.extend(payload.hits);
    } else {
        for hit in search(active.clone()) {
            lines.push(format!("- [{}] {}", hit.kind, hit.text));
            ui_hits.push(hit);
        }
    }
    if let Some(workflow) = workflow_status_context_for_query(facade, &user, &active, query) {
        lines.push(workflow);
    } else if let Some(provenance) =
        artifact_provenance_context_for_query(facade, &user, &active, query)
    {
        lines.push(provenance);
    }
    let personal = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
    if !in_project
        && let Ok(relations) = facade.list_relations_for_ui(&user, &personal)
        && !relations.is_empty()
    {
        let names: std::collections::HashMap<String, String> = facade
            .list_entities_for_ui(&user, &personal)
            .unwrap_or_default()
            .into_iter()
            .map(|entity| (entity.reference.to_string(), entity.name))
            .collect();
        for relation in relations.iter().take(12) {
            if let (Some(source), Some(target)) = (
                names.get(&relation.source_ref.to_string()),
                names.get(&relation.target_ref.to_string()),
            ) {
                lines.push(format!("- {source} —{}→ {target}", relation.relation_type));
            }
        }
    }
    let scope = if in_project { "project" } else { "personal" }.to_string();
    let has_hits = !lines.is_empty();
    let response = match lock_vault_store(state) {
        Ok(vault_store) => recall_memory_response_with_vault_fallback(
            &vault_store,
            query,
            lines,
            in_project,
            vault_value_requested,
        ),
        Err(_) if lines.is_empty() => format!("No memories relevant to «{query}»."),
        Err(_) if in_project => format!("Memories relevant to THIS project:\n{}", lines.join("\n")),
        Err(_) => format!("Relevant memories from memory:\n{}", lines.join("\n")),
    };
    RecallOutcome {
        response,
        payload: local_first_subagents::RecallStreamPayload {
            query: query.to_string(),
            hits: ui_hits,
            scope,
            status: if has_hits {
                "ready".to_string()
            } else {
                "empty".to_string()
            },
        },
    }
}
