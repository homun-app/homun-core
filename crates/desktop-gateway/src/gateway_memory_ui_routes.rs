//! Memory UI read/export routes.
//!
//! Owns dashboard, memory-only export, full user data export, and the memory
//! item explorer projection. Memory graph mutation/building, MemoryBench, and
//! low-level memory storage semantics remain separate owners.

use axum::{Json, extract::State};
use serde::Serialize;
use time::OffsetDateTime;

use local_first_desktop_gateway::{ChatMessagesSnapshot, ChatThreadSnapshot};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryAccessRequest, MemoryDashboard, MemoryStatus,
    MemoryUiReadModel, PERSONAL_WORKSPACE, PrivacyDomain, WorkspaceId as MemoryWorkspaceId,
};

use crate::{
    AppState, GatewayError, THREADS_WORKSPACE, gateway_memory_user_id, gateway_memory_workspace_id,
    load_workspaces_file, lock_store, memory_facade,
};

fn memory_item_visible(status: &MemoryStatus) -> bool {
    !matches!(status, MemoryStatus::Deleted | MemoryStatus::Rejected)
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

pub(crate) async fn memory_dashboard(
    State(state): State<AppState>,
) -> Result<Json<MemoryDashboard>, GatewayError> {
    let request = gateway_memory_access_request();
    let facade = memory_facade(&state);
    let dashboard = MemoryUiReadModel::new(facade)
        .dashboard(&request)
        .map_err(GatewayError::memory)?;
    Ok(Json(dashboard))
}

/// Exports local memory (personal scope) + dashboard counts as a JSON bundle the
/// frontend downloads. Tasks live in the chat store and are out of scope for v1.
pub(crate) async fn memory_export(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let facade = memory_facade(&state);
    let request = gateway_memory_access_request();
    let dashboard = MemoryUiReadModel::new(facade)
        .dashboard(&request)
        .map_err(GatewayError::memory)?;
    let user = gateway_memory_user_id();
    let personal = gateway_memory_workspace_id();
    let memories = facade
        .list_memories_for_ui(&user, &personal)
        .unwrap_or_default();
    let items: Vec<serde_json::Value> = memories
        .into_iter()
        .filter(|m| memory_item_visible(&m.status))
        .map(|m| {
            serde_json::json!({
                "reference": m.reference.to_string(),
                "memory_type": m.memory_type,
                "text": m.text,
                "status": format!("{:?}", m.status).to_lowercase(),
                "sensitivity": format!("{:?}", m.sensitivity).to_lowercase(),
                "confidence": m.confidence,
                "created_at": m.created_at,
            })
        })
        .collect();
    Ok(Json(serde_json::json!({
        "schema": "local-first-export/v1",
        "dashboard": dashboard,
        "memories": items,
    })))
}

/// GET /api/export — full user data export (GDPR-style data portability).
/// Serializes memories, chat threads + messages, contacts, and profiles into a
/// single JSON document. Complements /api/memory/export (which is memory-only)
/// and the workspace cascade-purge (which deletes).
pub(crate) async fn export_user_data(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    // Memories (reuse the existing memory_export shape).
    let memories = {
        let facade = memory_facade(&state);
        let user = gateway_memory_user_id();
        let workspace = gateway_memory_workspace_id();
        let items: Vec<serde_json::Value> = facade
            .list_memories_for_ui(&user, &workspace)
            .unwrap_or_default()
            .into_iter()
            .filter(|m| memory_item_visible(&m.status))
            .map(|m| {
                serde_json::json!({
                    "reference": m.reference.to_string(),
                    "memory_type": format!("{:?}", m.memory_type).to_lowercase(),
                    "text": m.text,
                    "status": format!("{:?}", m.status).to_lowercase(),
                    "sensitivity": format!("{:?}", m.sensitivity).to_lowercase(),
                    "confidence": m.confidence,
                    "created_at": m.created_at,
                })
            })
            .collect();
        items
    };

    // Chat threads + messages.
    let (threads, messages) = {
        let store = lock_store(&state)?;
        let file = load_workspaces_file();
        let mut all_threads = Vec::new();
        let mut all_messages = Vec::new();
        for ws in &file.workspaces {
            let snapshot = store
                .threads(&ws.id)
                .unwrap_or_else(|_| ChatThreadSnapshot {
                    active_thread_id: String::new(),
                    threads: Vec::new(),
                });
            for thread in &snapshot.threads {
                let msgs =
                    store
                        .messages(&thread.thread_id)
                        .unwrap_or_else(|_| ChatMessagesSnapshot {
                            thread_id: thread.thread_id.clone(),
                            messages: Vec::new(),
                        });
                all_threads.push(serde_json::json!({
                    "thread_id": thread.thread_id,
                    "workspace_id": ws.id,
                    "title": thread.title,
                    "status": thread.status,
                    "message_count": msgs.messages.len(),
                }));
                for msg in &msgs.messages {
                    all_messages.push(serde_json::json!({
                        "thread_id": thread.thread_id,
                        "role": msg.role,
                        "text": msg.text,
                        "timestamp": msg.timestamp,
                    }));
                }
            }
        }
        (all_threads, all_messages)
    };

    // Contacts + profiles.
    let (contacts, profiles) = {
        let store = lock_store(&state)?;
        let contacts_list = store.list_contacts().unwrap_or_default();
        let profiles_list = store.list_profiles().unwrap_or_default();
        let contacts_json: Vec<serde_json::Value> = contacts_list
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "name": c.name,
                    "contact_type": c.contact_type,
                    "is_self": c.is_self,
                })
            })
            .collect();
        let profiles_json: Vec<serde_json::Value> = profiles_list
            .iter()
            .map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "name": p.name,
                    "tone_of_voice": p.tone_of_voice,
                })
            })
            .collect();
        (contacts_json, profiles_json)
    };

    Ok(Json(serde_json::json!({
        "schema": "local-first-export/v2",
        "exported_at": OffsetDateTime::now_utc().to_string(),
        "memories": memories,
        "chat": {
            "threads": threads,
            "messages": messages,
        },
        "contacts": contacts,
        "profiles": profiles,
    })))
}

/// One memory in the management view (M5): UI-safe, with its scope and a string ref.
#[derive(Debug, Serialize)]
struct MemoryItemView {
    reference: String,
    scope: String,
    workspace_id: String,
    workspace_label: String,
    memory_type: String,
    status: String,
    sensitivity: String,
    confidence: f64,
    text: String,
    created_at: String,
    certainty: String,
}

/// Lists individual memories from the PERSONAL + active PROJECT scopes so the user
/// can see and manage what the assistant has learned (M5). Rejected/deleted are
/// hidden; candidates are shown so they can be confirmed.
pub(crate) async fn memory_items(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let facade = memory_facade(&state);
    let user = gateway_memory_user_id();
    let mut out: Vec<MemoryItemView> = Vec::new();
    let mut push_scope = |workspace: &MemoryWorkspaceId, scope: &str, label: &str| {
        if let Ok(memories) = facade.list_memories_for_ui(&user, workspace) {
            for memory in memories {
                if !memory_item_visible(&memory.status) {
                    continue;
                }
                out.push(MemoryItemView {
                    reference: memory.reference.to_string(),
                    scope: scope.to_string(),
                    workspace_id: workspace.as_str().to_string(),
                    workspace_label: label.to_string(),
                    memory_type: memory.memory_type,
                    status: format!("{:?}", memory.status).to_lowercase(),
                    sensitivity: format!("{:?}", memory.sensitivity).to_lowercase(),
                    confidence: memory.confidence,
                    certainty: memory
                        .metadata
                        .get("certainty")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string(),
                    text: memory.text,
                    created_at: memory.created_at,
                });
            }
        }
    };
    // Whole memory across scopes, so the explorer can filter by project / build a timeline.
    push_scope(
        &MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
        "personal",
        "Personal",
    );
    push_scope(
        &MemoryWorkspaceId::new(THREADS_WORKSPACE),
        "thread",
        "Conversations",
    );
    for workspace in load_workspaces_file().workspaces {
        if workspace.id == PERSONAL_WORKSPACE || workspace.id == THREADS_WORKSPACE {
            continue;
        }
        push_scope(
            &MemoryWorkspaceId::new(workspace.id.clone()),
            "project",
            &workspace.name,
        );
    }
    // Selectable scopes for the graph view: the memory scopes above PLUS every
    // folder-backed project even with zero memory, so a code project is reachable
    // and its code graph gets built on open.
    let mut scopes: Vec<serde_json::Value> = Vec::new();
    let mut seen_ws: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut add_scope = |id: &str, label: &str, kind: &str, has_folder: bool| {
        if seen_ws.insert(id.to_string()) {
            scopes.push(serde_json::json!({
                "workspace_id": id, "workspace_label": label, "scope": kind, "has_folder": has_folder
            }));
        }
    };
    add_scope(PERSONAL_WORKSPACE, "Personal", "personal", false);
    add_scope(THREADS_WORKSPACE, "Conversations", "thread", false);
    for it in &out {
        add_scope(&it.workspace_id, &it.workspace_label, &it.scope, false);
    }
    for workspace in load_workspaces_file().workspaces {
        if workspace.id == PERSONAL_WORKSPACE || workspace.id == THREADS_WORKSPACE {
            continue;
        }
        let has_folder = workspace
            .folder
            .as_deref()
            .map(|f| !f.trim().is_empty())
            .unwrap_or(false);
        add_scope(&workspace.id, &workspace.name, "project", has_folder);
    }
    Ok(Json(serde_json::json!({ "items": out, "scopes": scopes })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_ui_routes_hide_terminal_memory_management_states() {
        assert!(memory_item_visible(&MemoryStatus::Confirmed));
        assert!(memory_item_visible(&MemoryStatus::Candidate));
        assert!(!memory_item_visible(&MemoryStatus::Deleted));
        assert!(!memory_item_visible(&MemoryStatus::Rejected));
    }
}
