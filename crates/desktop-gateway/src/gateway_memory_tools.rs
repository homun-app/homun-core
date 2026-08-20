// Tool schemas and handlers for long-term memory recall, decisions, and forgetting.
use axum::{Json, extract::State};
use local_first_memory::MemoryAccessRequest;
use serde::Deserialize;

use crate::gateway_memory_graph_maintenance::reconcile_memory_scope;
use crate::gateway_memory_wiki::rebuild_decisions_wiki;
use crate::*;

/// Tool schema for on-demand deep memory recall (M3). The always-on profile is a
/// small slice; this lets the model fetch specific personal/project knowledge
/// (names, data, past decisions + their why) when it needs more.
pub(crate) fn recall_memory_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "Search the user's long-term memory (facts, preferences, people, past \
    decisions and their why) for what is relevant to the request. Use it when you need a personal or \
    project detail you may have learned before and that is NOT already in the prompt profile, BEFORE \
    saying you don't know it — and ALSO BEFORE ASKING the user for a possession, a person or a context \
    they take as already known (e.g. «my motorbike», «my boss»): retrieve what you know and ask only for \
    the details that remain missing. If normal memory has no match for a sensitive personal detail, the \
    gateway also checks Vault metadata internally and returns only redacted record metadata, never the secret value.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search in memory (keywords or question)."
                    }
                },
                "required": ["query"]
            }
        }
    })
}

pub(crate) fn record_decision_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "record_decision",
            "description": "Record in memory a DECISION made during work — valid for ANY domain \
    (code, documents e.g. a customer quote, data, configurations), not only technical. Call it AFTER \
    a non-trivial choice, so the WHY stays remembered and doesn't have to be reconstructed by re-reading \
    the files. Save: what was decided, the why, the discarded alternatives and the touched objects. The \
    decision is linked to the current project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "description": "What was decided/done, in one sentence (e.g. \"Moved the ACME quote to 10% discount\")." },
                    "rationale": { "type": "string", "description": "The WHY of the choice." },
                    "alternatives": {
                        "type": "array",
                        "items": { "type": "object", "properties": { "option": { "type": "string" }, "rejected_because": { "type": "string" } } },
                        "description": "Evaluated and discarded alternatives, with the reason. Optional."
                    },
                    "affects": { "type": "array", "items": { "type": "string" }, "description": "Touched objects: file, document, contact, etc. Optional." }
                },
                "required": ["summary", "rationale"]
            }
        }
    })
}

/// Records an explicit DECISION into project-scoped memory (the M3b decision layer):
/// the agent calls this after a non-trivial choice so the "why" survives — for any
/// domain (code, documents, data), not just coding.
pub(crate) fn record_decision(state: &AppState, args: &serde_json::Value) -> String {
    let summary = args
        .get("summary")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let rationale = args
        .get("rationale")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if summary.is_empty() || rationale.is_empty() {
        return "Per registrare una decisione servono almeno 'summary' e 'rationale'.".to_string();
    }
    let alternatives = args
        .get("alternatives")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let affects = args
        .get("affects")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    // The touched objects (file names, etc.) become ALIASES — those are FTS-indexed,
    // so a later "decisions affecting this file" lookup finds the decision by name.
    let affect_aliases: Vec<String> = affects
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "desktop-chat".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "record_decision".to_string(),
    };
    // The "why" lives in the text too, so the existing recall (which surfaces the
    // record text) shows it without needing to render the structured fields.
    let text = redact_sensitive_text(&format!("{summary} — why: {rationale}"));
    let facade = memory_facade(state);
    let record = facade.create_memory_candidate(MemoryCreateRequest {
        request: lifecycle.clone(),
        memory_type: "decision".to_string(),
        text,
        aliases: affect_aliases,
        language_hints: Vec::new(),
        confidence: 1.0,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: MemoryDataSensitivity::Internal,
        evidence_refs: Vec::new(),
        metadata: serde_json::json!({
            "source": "record_decision",
            "scope": "project",
            "decision": { "rationale": rationale, "alternatives": alternatives },
            "affects_labels": affects,
        }),
    });
    match record {
        Ok(rec) => {
            let _ = facade.confirm_memory(&lifecycle, &rec.reference, "decision recorded by agent");
            rebuild_decisions_wiki(facade, &user, &workspace);
            "✅ Decision recorded in memory (the why will stay available in upcoming turns and \
in future sessions)."
                .to_string()
        }
        Err(error) => format!("I couldn't record the decision: {error}"),
    }
}

pub(crate) fn forget_memory_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "forget_memory",
            "description": "Delete from long-term memory what matches the query. Use it when the user \
    asks to FORGET/delete a piece of information, or when a decision/fact is no longer valid and it's \
    better to remove it (not just update it). It searches its scopes and soft-deletes the best matches; \
    always report to the user WHAT you forgot.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "What to forget (keywords or phrase)." },
                    "reason": { "type": "string", "description": "Why (optional)." }
                },
                "required": ["query"]
            }
        }
    })
}

/// Soft-deletes the best matches for `query` in a scope, returning their summaries.
fn forget_in_scope(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    ws: &MemoryWorkspaceId,
    query: &str,
    reason: &str,
) -> Vec<String> {
    let access = MemoryAccessRequest {
        actor_id: "forget".to_string(),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        purpose: "forget".to_string(),
        allowed_domains: vec![
            PrivacyDomain::new("personal"),
            PrivacyDomain::new("work"),
            PrivacyDomain::new("general"),
        ],
        max_sensitivity: MemoryDataSensitivity::Secret,
        allow_raw_payload: true,
        allow_export: true,
        broad_query: false,
    };
    let mut out = Vec::new();
    if let Ok(page) = facade.search_memories(MemorySearchRequest {
        access,
        query: query.to_string(),
        statuses: vec![MemoryStatus::Confirmed, MemoryStatus::Candidate],
        memory_types: Vec::new(),
        // Delete ALL matches, not just the top 3: search returns only genuine matches
        // (it doesn't pad to the limit), so a generous cap forgets the whole cluster
        // instead of leaving stragglers — the bug where "forget Gianluca" left records.
        limit: 25,
        offset: 0,
    }) {
        let lifecycle = MemoryLifecycleRequest {
            actor_id: "forget".to_string(),
            user_id: user.clone(),
            workspace_id: ws.clone(),
            purpose: "forget".to_string(),
        };
        for item in page.items {
            if facade
                .delete_memory(&lifecycle, &item.reference, reason)
                .is_ok()
            {
                out.push(item.summary);
            }
        }
    }
    out
}

/// Topic/entity forget: resolve the entities named by `query` (by name/alias),
/// delete every memory linked to them via `mentions`, then tombstone the entities
/// themselves — "dimentica TUTTO su X". This is the structural complement to the
/// text-based forget: it catches memories about X even when their wording differs.
/// Protected: person:self (never "forget me") and contact-backed entities (people
/// with a card — those are removed via the contacts flow, not topic-forget).
fn forget_topic_in_scope(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    ws: &MemoryWorkspaceId,
    query: &str,
    reason: &str,
    protected: &std::collections::HashSet<String>,
) -> Vec<String> {
    let needle = query.trim().to_lowercase();
    if needle.chars().count() < 3 {
        return Vec::new();
    }
    let entities = facade.list_entities_for_ui(user, ws).unwrap_or_default();
    let matched: Vec<MemoryRef> = entities
        .into_iter()
        .filter(|e| e.canonical_key != "person:self")
        .filter(|e| !protected.contains(&e.reference.to_string()))
        .filter(|e| {
            std::iter::once(&e.name).chain(e.aliases.iter()).any(|n| {
                let t = n.trim().to_lowercase();
                t.chars().count() >= 3 && (needle.contains(&t) || t.contains(&needle))
            })
        })
        .map(|e| e.reference)
        .collect();
    if matched.is_empty() {
        return Vec::new();
    }
    let matched_set: std::collections::HashSet<String> =
        matched.iter().map(|r| r.to_string()).collect();
    let to_delete: std::collections::HashSet<String> = facade
        .list_relations_for_ui(user, ws)
        .unwrap_or_default()
        .into_iter()
        .filter(|r| {
            r.relation_type == "mentions" && matched_set.contains(&r.target_ref.to_string())
        })
        .map(|r| r.source_ref.to_string())
        .collect();
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "forget".to_string(),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        purpose: "forget".to_string(),
    };
    let mut out = Vec::new();
    for m in facade.list_memories_for_ui(user, ws).unwrap_or_default() {
        if matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
            && to_delete.contains(&m.reference.to_string())
            && facade
                .delete_memory(&lifecycle, &m.reference, reason)
                .is_ok()
        {
            out.push(m.text);
        }
    }
    // The topic itself goes away (no live memory references it anymore).
    for entity_ref in &matched {
        let _ = facade.tombstone_entity(entity_ref, user, ws, reason);
    }
    out
}

pub(crate) fn forget_memory(state: &AppState, args: &serde_json::Value) -> String {
    let query = args
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if query.is_empty() {
        return "To forget something, tell me what (query).".to_string();
    }
    let reason = args
        .get("reason")
        .and_then(|r| r.as_str())
        .unwrap_or("forgetting requested by the user");
    // Contact-backed entities are people with a card — never topic-forget those
    // (the address book has its own delete). Gathered before the facade lock.
    let protected: std::collections::HashSet<String> = lock_store(state)
        .ok()
        .and_then(|store| store.list_contacts().ok())
        .map(|cs| cs.into_iter().filter_map(|c| c.entity_ref).collect())
        .unwrap_or_default();
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let active = gateway_memory_workspace_id();
    let mut deleted = forget_in_scope(facade, &user, &active, &query, reason);
    deleted.extend(forget_topic_in_scope(
        facade, &user, &active, &query, reason, &protected,
    ));
    if active.as_str() != PERSONAL_WORKSPACE {
        let personal = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
        deleted.extend(forget_in_scope(facade, &user, &personal, &query, reason));
        deleted.extend(forget_topic_in_scope(
            facade, &user, &personal, &query, reason, &protected,
        ));
    }
    deleted.sort();
    deleted.dedup();
    // Cascade: the graph already hides Deleted; refresh the wiki projection too.
    rebuild_decisions_wiki(facade, &user, &active);
    // G5: deletions can orphan entities — re-optimize the touched scopes.
    // ADR 0027: no facade lock to release; the store serializes each op internally.
    if !deleted.is_empty() {
        reconcile_memory_scope(state, &active);
        if active.as_str() != PERSONAL_WORKSPACE {
            reconcile_memory_scope(state, &MemoryWorkspaceId::new(PERSONAL_WORKSPACE));
        }
    }
    if deleted.is_empty() {
        format!("I didn't find anything in memory matching «{query}».")
    } else {
        let list = deleted
            .iter()
            .map(|d| format!("- {}", d.chars().take(90).collect::<String>()))
            .collect::<Vec<_>>()
            .join("\n");
        format!("🗑️ I forgot {} item(s) from memory:\n{list}", deleted.len())
    }
}

#[derive(Debug, Deserialize)]
pub(crate) struct MemoryDecideRequest {
    reference: String,
    /// "confirm" | "reject" | "delete" | "edit"
    action: String,
    /// New text for the "edit" action.
    #[serde(default)]
    text: Option<String>,
}

/// Confirm / reject / delete a single memory by ref (M5 management actions). The
/// lifecycle scope is taken from the ref itself so personal + project both work.
pub(crate) async fn memory_decide(
    State(state): State<AppState>,
    Json(request): Json<MemoryDecideRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let reference = request
        .reference
        .parse::<MemoryRef>()
        .map_err(|error| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "memory_bad_ref",
            message: error,
        })?;
    let facade = memory_facade(&state);
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "desktop-ui".to_string(),
        user_id: reference.user_id.clone(),
        workspace_id: reference.workspace_id.clone(),
        purpose: "memory_management".to_string(),
    };
    match request.action.as_str() {
        "confirm" => {
            facade
                .confirm_memory(&lifecycle, &reference, "user confirmed")
                .map_err(|error| GatewayError::memory(error.to_string()))?;
        }
        "reject" => {
            facade
                .reject_memory(&lifecycle, &reference, "user rejected")
                .map_err(|error| GatewayError::memory(error.to_string()))?;
        }
        "delete" => {
            if reference.kind == MemoryRefKind::Entity {
                facade
                    .tombstone_entity(
                        &reference,
                        &reference.user_id,
                        &reference.workspace_id,
                        "user deleted",
                    )
                    .map_err(|error| GatewayError::memory(error.to_string()))?;
            } else {
                facade
                    .delete_memory(&lifecycle, &reference, "user deleted")
                    .map_err(|error| GatewayError::memory(error.to_string()))?;
            }
        }
        "edit" => {
            let text = request.text.unwrap_or_default();
            if text.trim().is_empty() {
                return Err(GatewayError {
                    status: StatusCode::BAD_REQUEST,
                    code: "memory_empty_text",
                    message: "empty text".to_string(),
                });
            }
            let patch = MemoryUpdatePatch {
                text: Some(text),
                ..Default::default()
            };
            facade
                .update_memory(&lifecycle, &reference, patch)
                .map_err(|error| GatewayError::memory(error.to_string()))?;
        }
        _ => {
            return Err(GatewayError {
                status: StatusCode::BAD_REQUEST,
                code: "memory_bad_action",
                message: "invalid action (confirm|reject|delete)".to_string(),
            });
        }
    }
    // G5: a deletion can orphan entities and leave dangling edges - re-optimize
    // the graph of the touched scope. ADR 0027: no facade lock; the store is
    // internally serialized, so the re-optimize sweep needs no explicit release.
    reconcile_memory_scope(&state, &reference.workspace_id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_tools_schema_exports_canonical_function_names() {
        assert_eq!(
            recall_memory_tool_schema()["function"]["name"],
            serde_json::json!("recall_memory")
        );
        assert_eq!(
            record_decision_tool_schema()["function"]["name"],
            serde_json::json!("record_decision")
        );
        assert_eq!(
            forget_memory_tool_schema()["function"]["name"],
            serde_json::json!("forget_memory")
        );
    }

    #[test]
    fn gateway_memory_tools_topic_forget_deletes_linked_memories_and_tombstones_entity() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = MemoryUserId::new("local");
        let workspace = MemoryWorkspaceId::new("project");
        let lifecycle = MemoryLifecycleRequest {
            actor_id: "test".to_string(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            purpose: "test".to_string(),
        };
        let memory = facade
            .create_memory_candidate(MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "fact".to_string(),
                text: "Gianluca owns the handoff context".to_string(),
                aliases: Vec::new(),
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: PrivacyDomain::new("work"),
                sensitivity: MemoryDataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({ "source": "test" }),
            })
            .unwrap();
        facade
            .confirm_memory(&lifecycle, &memory.reference, "test")
            .unwrap();
        let entity_ref =
            MemoryRef::generated(MemoryRefKind::Entity, user.clone(), workspace.clone());
        let entity = MemoryEntity {
            reference: entity_ref.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            entity_type: "person".to_string(),
            name: "Gianluca".to_string(),
            canonical_key: "person:gianluca".to_string(),
            aliases: vec!["Gianluca".to_string()],
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: MemoryDataSensitivity::Internal,
            metadata: serde_json::json!({}),
        };
        facade.upsert_entity(&entity).unwrap();
        facade
            .upsert_relation(&MemoryRelation {
                reference: MemoryRef::generated(
                    MemoryRefKind::Relation,
                    user.clone(),
                    workspace.clone(),
                ),
                user_id: user.clone(),
                workspace_id: workspace.clone(),
                source_ref: memory.reference.clone(),
                relation_type: "mentions".to_string(),
                target_ref: entity_ref.clone(),
                confidence: 1.0,
                privacy_domain: PrivacyDomain::new("work"),
                sensitivity: MemoryDataSensitivity::Internal,
                evidence: Vec::new(),
                metadata: serde_json::json!({}),
            })
            .unwrap();

        let deleted = forget_topic_in_scope(
            &facade,
            &user,
            &workspace,
            "dimentica tutto su Gianluca",
            "test forget",
            &std::collections::HashSet::new(),
        );

        assert_eq!(
            deleted,
            vec!["Gianluca owns the handoff context".to_string()]
        );
        assert!(
            facade
                .list_forgotten_texts(&user, &workspace)
                .unwrap()
                .contains(&"Gianluca owns the handoff context".to_string())
        );
        assert!(
            facade
                .list_entities_for_ui(&user, &workspace)
                .unwrap()
                .into_iter()
                .all(|entity| entity.canonical_key != "person:gianluca")
        );
    }
}
