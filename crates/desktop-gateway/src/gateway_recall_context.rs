//! Memory recall context helpers for gateway prompts and stream metadata.
//!
//! This module owns the translation from memory recall internals into the
//! prompt/status/effect contracts consumed by the chat loop. It intentionally
//! avoids route handling and long-running review orchestration.

use crate::*;

/// Friendly label for a scope (a workspace id or PERSONAL_WORKSPACE), so prompts
/// reason over "Progetto Acme" rather than an opaque id.
pub(crate) fn scope_display_name(scope: &str) -> String {
    match scope {
        PERSONAL_WORKSPACE => "Personal".to_string(),
        THREADS_WORKSPACE => "Conversations".to_string(),
        other => load_workspaces_file()
            .workspaces
            .iter()
            .find(|w| w.id == other)
            .map(|w| w.name.clone())
            .unwrap_or_else(|| other.to_string()),
    }
}

/// Resolve provenance labels at emission time rather than trusting a label that
/// travelled through recall. Renames are therefore visible immediately and the
/// reserved personal space never leaks as an implementation id.
pub(crate) fn recall_source_label(scope: &str) -> String {
    if scope == PERSONAL_WORKSPACE {
        return if effective_user_language() == "it" {
            "Personale".to_string()
        } else {
            "Personal".to_string()
        };
    }
    scope_display_name(scope)
}

pub(crate) fn recall_collection_token(collection: MemoryCollectionKey) -> &'static str {
    match collection {
        MemoryCollectionKey::Preferences => "preferences",
        MemoryCollectionKey::Profile => "profile",
        MemoryCollectionKey::Knowledge => "knowledge",
        MemoryCollectionKey::Decisions => "decisions",
        MemoryCollectionKey::Goals => "goals",
        MemoryCollectionKey::Artifacts => "artifacts",
        MemoryCollectionKey::Episodes => "episodes",
    }
}

pub(crate) fn memory_access_status_instruction(
    status: local_first_memory::MemoryAccessStatus,
) -> &'static str {
    match status {
        local_first_memory::MemoryAccessStatus::Ready => {
            "MEMORY ACCESS STATUS: ready. Matching records were retrieved."
        }
        local_first_memory::MemoryAccessStatus::Empty => {
            "MEMORY ACCESS STATUS: empty. The memory store is connected and answered correctly, but no matching record was found. Never describe this as a connection failure."
        }
        local_first_memory::MemoryAccessStatus::Degraded => {
            "MEMORY ACCESS STATUS: degraded. Memory is connected and lexical recall remains available, but semantic/vector recall is degraded. State that limitation precisely if relevant."
        }
        local_first_memory::MemoryAccessStatus::Unavailable => {
            "MEMORY ACCESS STATUS: unavailable. The memory store could not be queried; do not claim that no matching memory exists."
        }
        local_first_memory::MemoryAccessStatus::Denied => {
            "MEMORY ACCESS STATUS: denied. Policy does not authorize memory access for this turn; do not imply the store is empty or disconnected."
        }
    }
}

/// Renders a recalled memory for the model. For a DECISION it surfaces the
/// structured "why" — rationale and rejected alternatives from
/// `metadata.decision` — instead of returning only the summary text.
pub(crate) fn format_recall_entry(summary: &str, metadata: &serde_json::Value) -> String {
    let Some(decision) = metadata.get("decision") else {
        return summary.to_string();
    };
    let mut out = summary.to_string();
    if let Some(rationale) = decision.get("rationale").and_then(|r| r.as_str())
        && !rationale.is_empty()
        && !summary.contains(rationale)
    {
        out.push_str(&format!(" — why: {rationale}"));
    }
    if let Some(alternatives) = decision.get("alternatives").and_then(|a| a.as_array()) {
        let rejected: Vec<String> = alternatives
            .iter()
            .filter_map(|alt| {
                let option = alt.get("option").and_then(|o| o.as_str())?;
                if option.is_empty() {
                    return None;
                }
                let why = alt
                    .get("rejected_because")
                    .and_then(|w| w.as_str())
                    .unwrap_or("");
                Some(if why.is_empty() {
                    option.to_string()
                } else {
                    format!("{option} (rejected: {why})")
                })
            })
            .collect();
        if !rejected.is_empty() {
            out.push_str(&format!(
                " [rejected alternatives: {}]",
                rejected.join("; ")
            ));
        }
    }
    out
}

pub(crate) fn recall_stream_payload_from_pack(
    pack: &RecallPack,
) -> local_first_subagents::RecallStreamPayload {
    let mut payload = recall_stream_payload_from_hits(&pack.query, &pack.scope, &pack.hits);
    payload.status = pack.status.as_str().to_string();
    payload
}

pub(crate) fn recall_stream_payload_from_hits(
    query: &str,
    scope: &MemoryScope,
    hits: &[RecallHit],
) -> local_first_subagents::RecallStreamPayload {
    local_first_subagents::RecallStreamPayload {
        query: query.to_string(),
        hits: hits
            .iter()
            .map(|hit| local_first_subagents::RecallStreamHit {
                r#ref: hit.memory_ref.clone(),
                text: hit.text.clone(),
                score: hit.score,
                kind: hit.kind.clone(),
                source_workspace_id: hit.source_workspace_id.as_str().to_string(),
                source_label: recall_source_label(hit.source_workspace_id.as_str()),
                collection: recall_collection_token(hit.collection).to_string(),
                grant_id: hit.grant_id.clone(),
                policy_version: hit.policy_version,
                source_revision: hit.grant_id.as_ref().map(|_| hit.source_revision.clone()),
                conflict: hit.conflict,
                graph_path: hit.graph_path.clone(),
            })
            .collect(),
        scope: match scope {
            MemoryScope::Personal => "personal".to_string(),
            MemoryScope::Project(_) | MemoryScope::Thread { .. } => "project".to_string(),
        },
        status: if hits.is_empty() {
            "empty".to_string()
        } else {
            "ready".to_string()
        },
    }
}

pub(crate) fn merge_automatic_recall_payload(
    target: &mut Option<local_first_subagents::RecallStreamPayload>,
    incoming: local_first_subagents::RecallStreamPayload,
) {
    let Some(current) = target.as_mut() else {
        *target = Some(incoming);
        return;
    };
    let incoming_status = incoming.status;
    for hit in incoming.hits {
        let duplicate = current.hits.iter().any(|existing| {
            existing.r#ref == hit.r#ref
                && existing.source_workspace_id == hit.source_workspace_id
                && existing.grant_id == hit.grant_id
                && existing.policy_version == hit.policy_version
                && existing.source_revision == hit.source_revision
        });
        if !duplicate {
            current.hits.push(hit);
        }
    }
    current.status = match (current.status.as_str(), incoming_status.as_str()) {
        ("unavailable", _) | (_, "unavailable") => "unavailable",
        ("denied", _) | (_, "denied") => "denied",
        ("degraded", _) | (_, "degraded") => "degraded",
        ("ready", _) | (_, "ready") => "ready",
        _ => "empty",
    }
    .to_string();
}

pub(crate) fn memory_read_effects_from_recall_payload(
    payload: &local_first_subagents::RecallStreamPayload,
) -> local_first_engine::ToolEffects {
    let mut effects = local_first_engine::ToolEffects::default();
    effects.memory_reads.extend_payload(payload);
    effects
}

pub(crate) fn seed_loop_memory_reads(
    state: &mut local_first_engine::LoopState,
    payload: Option<&local_first_subagents::RecallStreamPayload>,
) {
    if let Some(payload) = payload {
        state.memory_reads.extend_payload(payload);
    }
}

/// WS5.4 open loops for the active scope. Most-recent first, small cap.
pub(crate) fn gather_open_loops(state: &AppState, cap: usize) -> Vec<String> {
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let mut items: Vec<String> = facade
        .list_memories_for_ui(&user, &workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(active_open_loop_record)
        .map(|m| m.text.trim().replace('\n', " "))
        .collect();
    if items.len() > cap {
        items.drain(0..items.len() - cap);
    }
    items
}

/// Normalize a model-proposed anchor into a stable, durable `{kind}:{slug}` key.
pub(crate) fn sanitize_dedup_key(kind: &str, raw: &str) -> String {
    let slug = |s: &str| -> String {
        let mut out = String::new();
        let mut prev_dash = false;
        for ch in s.trim().to_lowercase().chars() {
            if ch.is_alphanumeric() {
                out.push(ch);
                prev_dash = false;
            } else if !out.is_empty() && !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
        out.trim_matches('-').to_string()
    };
    let k = slug(kind);
    let a = slug(raw);
    match (k.is_empty(), a.is_empty()) {
        (true, true) => "suggerimento".to_string(),
        (true, false) => a,
        (false, true) => k,
        (false, false) => format!("{k}:{a}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_recall_context_normalizes_dedup_keys() {
        assert_eq!(
            sanitize_dedup_key("Scadenza", "il contratto  ACME!!!"),
            "scadenza:il-contratto-acme"
        );
        assert_eq!(sanitize_dedup_key("", ""), "suggerimento");
    }

    #[test]
    fn gateway_recall_context_distinguishes_memory_statuses() {
        assert!(
            memory_access_status_instruction(local_first_memory::MemoryAccessStatus::Empty)
                .contains("no matching record")
        );
        assert!(
            memory_access_status_instruction(local_first_memory::MemoryAccessStatus::Unavailable)
                .contains("could not be queried")
        );
    }
}
