// Memory wiki projections, routes, and manual-edit registry for the hybrid memory view.
use axum::{
    Json,
    extract::{Query, State},
};
use serde::{Deserialize, Serialize};

use crate::*;

/// Wiki pages the user edited by hand (`workspace|path`) are not
/// auto-regenerated: the human-curated version wins for that page until a
/// dedicated regeneration path replaces it.
fn wiki_edited_path() -> Option<PathBuf> {
    gateway_data_dir()
        .ok()
        .map(|dir| dir.join("wiki-edited.json"))
}
fn load_wiki_edited() -> std::collections::BTreeSet<String> {
    wiki_edited_path()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}
pub(crate) fn mark_wiki_edited(workspace: &MemoryWorkspaceId, path: &str) {
    let mut set = load_wiki_edited();
    set.insert(format!("{}|{}", workspace.as_str(), path));
    if let Some(file) = wiki_edited_path() {
        let _ = fs::write(file, serde_json::to_string(&set).unwrap_or_default());
    }
}
pub(crate) fn wiki_is_edited(workspace: &MemoryWorkspaceId, path: &str) -> bool {
    load_wiki_edited().contains(&format!("{}|{}", workspace.as_str(), path))
}

/// Wiki projection (markdown face of the memory): regenerate the project's "Decisioni"
/// page from the confirmed decisions and persist it to SQL (wiki_pages). The structured
/// rows stay canonical; this is the readable, human-editable projection (the hybrid
/// model). Idempotent — one page per workspace, rebuilt in place. Skipped if the user
/// edited the page by hand (their version wins until they regenerate).
///
/// ADR 0022 (Tappa 4, F2): corpo migrato nel crate (`local_first_memory`); qui
/// resta un thin wrapper (firma identica — molti caller). Rimosso in F4.
pub(crate) fn rebuild_decisions_wiki(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) {
    local_first_memory::rebuild_decisions_wiki(facade, user_id, workspace, &|ws, path| {
        wiki_is_edited(ws, path)
    });
}

/// F6 — the third leg: a human-readable VIEW of the personal memory, generated from
/// the live facts grouped by the entity they're about (via the graph's mentions
/// edges). Derived & rebuildable like the graph — the truth stays in SQL, this is the
/// Karpathy-style "compiled knowledge" page, navigable and linked back to the records.
/// One page ("profilo.md"); respects manual edits.
pub(crate) fn rebuild_profile_wiki(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) {
    if wiki_is_edited(workspace, "profilo.md") {
        return;
    }
    let memories = facade
        .list_memories_for_ui(user_id, workspace)
        .unwrap_or_default();
    let facts: Vec<_> = memories
        .into_iter()
        .filter(|m| {
            matches!(m.status, MemoryStatus::Confirmed)
                && matches!(m.memory_type.as_str(), "fact" | "preference")
        })
        .collect();
    if facts.is_empty() {
        return;
    }
    // memory_ref → entity names it mentions (via the graph).
    let entity_name: std::collections::HashMap<String, String> = facade
        .list_entities_for_ui(user_id, workspace)
        .unwrap_or_default()
        .into_iter()
        .map(|e| (e.reference.to_string(), e.name))
        .collect();
    let mut mem_entities: std::collections::HashMap<String, Vec<String>> = Default::default();
    for rel in facade
        .list_relations_for_ui(user_id, workspace)
        .unwrap_or_default()
    {
        if rel.relation_type == "mentions"
            && let Some(name) = entity_name.get(&rel.target_ref.to_string())
        {
            mem_entities
                .entry(rel.source_ref.to_string())
                .or_default()
                .push(name.clone());
        }
    }
    // Group facts under each entity they mention; entity-less facts → "Generale".
    let mut sections: std::collections::BTreeMap<String, Vec<&str>> = Default::default();
    let mut linked: Vec<MemoryRef> = Vec::new();
    for fact in &facts {
        linked.push(fact.reference.clone());
        let names = mem_entities.get(&fact.reference.to_string());
        match names {
            Some(ns) if !ns.is_empty() => {
                for n in ns {
                    sections
                        .entry(n.clone())
                        .or_default()
                        .push(fact.text.as_str());
                }
            }
            _ => sections
                .entry("Generale".to_string())
                .or_default()
                .push(fact.text.as_str()),
        }
    }
    let mut body = String::from(
        "# Personal profile\n\n> Page generated from memory (editable by hand: corrections flow back into the structured store).\n\n",
    );
    // "Generale" last; entities alphabetical.
    let mut keys: Vec<&String> = sections.keys().collect();
    keys.sort_by_key(|k| (*k == "Generale", (*k).clone()));
    for key in keys {
        body.push_str(&format!("## {key}\n\n"));
        for text in &sections[key] {
            body.push_str(&format!("- {}\n", text.trim()));
        }
        body.push('\n');
    }
    let path = "profilo.md";
    let reference = facade
        .list_wiki_pages_for_ui(user_id, workspace)
        .ok()
        .and_then(|pages| {
            pages
                .into_iter()
                .find(|p| p.path == path)
                .map(|p| p.reference)
        })
        .unwrap_or_else(|| {
            MemoryRef::generated(MemoryRefKind::Wiki, user_id.clone(), workspace.clone())
        });
    let page = WikiPage {
        reference,
        user_id: user_id.clone(),
        workspace_id: workspace.clone(),
        path: path.to_string(),
        title: "Personal profile".to_string(),
        body,
        linked_refs: linked,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Internal,
    };
    let _ = facade.record_wiki_page_for_ui(&page);
}

/// Project BRIEF (`brief.md`): the always-on "where this project is going" page —
/// goals + recent state. Generated & editable like profilo.md/decisioni.md (manual
/// edits win). Injected at turn start (push) so the assistant holds the project's
/// direction without being asked. Projects only (not personal/threads).
pub(crate) fn rebuild_project_brief(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) {
    local_first_memory::rebuild_project_brief(facade, user_id, workspace, &|ws, path| {
        wiki_is_edited(ws, path)
    });
}

/// Project status (`stato-lavori.md`): the readable/editable face of open loops.
/// SQL stays canonical; this page makes unfinished work visible in the wiki and
/// links each item back to its source memory ref. Manual edits win like the other
/// generated wiki pages.
pub(crate) fn rebuild_status_wiki(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) {
    local_first_memory::rebuild_status_wiki(facade, user_id, workspace, &|ws, path| {
        wiki_is_edited(ws, path)
    });
}

#[derive(Serialize)]
pub(crate) struct WikiPageView {
    path: String,
    title: String,
    body: String,
}

/// The markdown face of the project's memory (wiki pages persisted in SQL): the
/// readable, human-editable projection. Same scope resolution as the graph.
pub(crate) async fn memory_wiki(
    State(state): State<AppState>,
    Query(query): Query<MemoryGraphQuery>,
) -> Result<Json<Vec<WikiPageView>>, GatewayError> {
    let facade = memory_facade(&state);
    let user = gateway_memory_user_id();
    let ws = resolve_memory_query_scope(&state, &query);
    // Regenerate the "Decisioni" page from current decisions so existing projects show
    // it without needing a fresh turn (idempotent).
    rebuild_decisions_wiki(facade, &user, &ws);
    rebuild_status_wiki(facade, &user, &ws);
    let pages = facade
        .list_wiki_pages_for_ui(&user, &ws)
        .unwrap_or_default();
    Ok(Json(
        pages
            .into_iter()
            .map(|p| WikiPageView {
                path: p.path,
                title: p.title,
                body: p.body,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub(crate) struct WikiSaveRequest {
    workspace: Option<String>,
    thread: Option<String>,
    path: String,
    body: String,
}

impl WikiSaveRequest {
    fn graph_query(&self) -> MemoryGraphQuery {
        MemoryGraphQuery {
            workspace: self.workspace.clone(),
            thread: self.thread.clone(),
        }
    }
}

/// Save a hand-edited wiki page (the editable face of the hybrid model): persist the
/// new markdown, mark the page as user-edited (so it isn't auto-regenerated), and
/// RE-INGEST it — run the extractor on the edited text so the corrections flow back
/// into the canonical structured memory.
pub(crate) async fn memory_wiki_save(
    State(state): State<AppState>,
    Json(req): Json<WikiSaveRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let ws = resolve_memory_query_scope(&state, &req.graph_query());
    {
        let facade = memory_facade(&state);
        let existing = facade
            .list_wiki_pages_for_ui(&user, &ws)
            .ok()
            .and_then(|pages| pages.into_iter().find(|p| p.path == req.path));
        let reference = existing
            .as_ref()
            .map(|p| p.reference.clone())
            .unwrap_or_else(|| MemoryRef::generated(MemoryRefKind::Wiki, user.clone(), ws.clone()));
        let title = existing
            .as_ref()
            .map(|p| p.title.clone())
            .unwrap_or_else(|| req.path.clone());
        let linked_refs = existing.map(|p| p.linked_refs).unwrap_or_default();
        let page = WikiPage {
            reference,
            user_id: user.clone(),
            workspace_id: ws.clone(),
            path: req.path.clone(),
            title,
            body: req.body.clone(),
            linked_refs,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: MemoryDataSensitivity::Internal,
        };
        facade
            .record_wiki_page_for_ui(&page)
            .map_err(|e| GatewayError::memory(e.to_string()))?;
    }
    reconcile_memory_scope(&state, &ws);
    mark_wiki_edited(&ws, &req.path);
    // Re-ingest: scope the MEMORY workspace to this page, then extract memories from
    // the edited markdown into the structured store (non-empty `actions` bypasses the
    // salience gate). Background — the save returns immediately. (Memory scope only —
    // doesn't touch the global active workspace / Composio.)
    set_memory_workspace(ws.as_str());
    let st = state.clone();
    let body = req.body.clone();
    let reconcile_ws = ws.clone();
    tokio::spawn(async move {
        learn_via_service_or_inline(
            &st,
            &body,
            "",
            "The user manually corrected a project memory wiki page",
            None,
            None,
            None,
            None,
            local_first_memory::MemoryReuseEnvelope::normal(),
        )
        .await;
        reconcile_memory_scope(&st, &reconcile_ws);
    });
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Consolidate a scope's memory: merge fragments + prune noise (user/agent triggered).
pub(crate) async fn memory_consolidate(
    State(state): State<AppState>,
    Query(query): Query<MemoryGraphQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let ws = resolve_memory_query_scope(&state, &query);
    let (merged, dropped) = consolidate_scope(&state, &user, &ws).await;
    Ok(Json(
        serde_json::json!({ "merged": merged, "dropped": dropped }),
    ))
}

pub(crate) fn active_open_loop_record(memory: &MemoryRecord) -> bool {
    memory.memory_type == "open_loop"
        && matches!(
            memory.status,
            MemoryStatus::Confirmed | MemoryStatus::Candidate
        )
        && memory.superseded_by.is_none()
        && !memory.text.trim().is_empty()
        // Runtime plans are harness-owned control-flow state. They are resumed
        // only through the per-thread runtime-plan loader; injecting them as
        // generic open loops lets unrelated threads contaminate a fresh prompt.
        && memory.metadata.get("source").and_then(|v| v.as_str()) != Some("runtime_plan")
}

#[cfg(test)]
pub(crate) fn deduplicate_open_loops(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) -> usize {
    local_first_memory::deduplicate_open_loops(facade, user_id, workspace)
}

#[cfg(test)]
fn open_loop_matches_target(open_loop_text: &str, target: &str) -> bool {
    let loop_tokens = dedup_tokens(open_loop_text);
    let target_tokens = dedup_tokens(target);
    if loop_tokens.is_empty() || target_tokens.is_empty() {
        return false;
    }
    let shared = loop_tokens.intersection(&target_tokens).count();
    shared >= 2
        && (jaccard(&loop_tokens, &target_tokens) >= 0.35
            || target_tokens.is_subset(&loop_tokens)
            || loop_tokens.is_subset(&target_tokens))
}

#[cfg(test)]
pub(crate) fn close_matching_open_loops(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    targets: &[String],
) -> usize {
    if targets.is_empty() {
        return 0;
    }
    let loops: Vec<MemoryRecord> = facade
        .list_memories_for_ui(user_id, workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(active_open_loop_record)
        .collect();
    if loops.is_empty() {
        return 0;
    }
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "open-loop-closure".to_string(),
        user_id: user_id.clone(),
        workspace_id: workspace.clone(),
        purpose: "close_completed_open_loops".to_string(),
    };
    let mut closed = 0usize;
    for open_loop in loops {
        if targets
            .iter()
            .any(|target| open_loop_matches_target(&open_loop.text, target))
            && facade
                .mark_memory_stale(
                    &lifecycle,
                    &open_loop.reference,
                    "open_loop closed by verified exchange evidence",
                )
                .is_ok()
        {
            closed += 1;
        }
    }
    closed
}

/// ADR 0022 (Tappa 4, F2): corpo migrato nel crate; thin wrapper (test caller).
#[cfg(test)]
pub(crate) fn status_wiki_body_from_open_loops(
    open_loops: &[(MemoryRef, String)],
) -> (String, Vec<MemoryRef>) {
    local_first_memory::status_wiki_body_from_open_loops(open_loops)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_wiki_excludes_runtime_plans_from_generic_open_loops() {
        let user = local_first_memory::UserId::new("local");
        let workspace = local_first_memory::WorkspaceId::new("project");
        let now = "2026-08-04T00:00:00Z".to_string();
        let mut memory = local_first_memory::MemoryRecord {
            reference: local_first_memory::MemoryRef::generated(
                local_first_memory::MemoryRefKind::Memory,
                user.clone(),
                workspace.clone(),
            ),
            user_id: user,
            workspace_id: workspace,
            memory_type: "open_loop".to_string(),
            text: "Run the kernel gate".to_string(),
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            status: local_first_memory::MemoryStatus::Confirmed,
            privacy_domain: local_first_memory::PrivacyDomain::new("work"),
            sensitivity: local_first_memory::DataSensitivity::Internal,
            metadata: serde_json::json!({"source":"runtime_plan"}),
            created_at: now.clone(),
            updated_at: now,
            last_seen_at: None,
            supersedes: Vec::new(),
            superseded_by: None,
            correction_of: None,
        };

        assert!(!active_open_loop_record(&memory));
        memory.metadata = serde_json::json!({"source":"test"});
        assert!(active_open_loop_record(&memory));
    }
}
