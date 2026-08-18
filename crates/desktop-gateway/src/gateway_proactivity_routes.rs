//! Proactivity dashboard routes and suggestion action write-back.

use crate::{
    AppState, gateway_memory_user_id,
    gateway_proactivity::{run_proactive_review, suggestion_choices_json},
    lock_store, memory_facade, redact_sensitive_text,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, MemoryCreateRequest, MemoryLifecycleRequest,
    PERSONAL_WORKSPACE, PrivacyDomain, WorkspaceId as MemoryWorkspaceId,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub(crate) struct ToolRunsQuery {
    limit: Option<usize>,
}

/// GET /api/tools/runs?limit=N — recent connector tool executions.
pub(crate) async fn tool_runs_list(
    State(state): State<AppState>,
    Query(q): Query<ToolRunsQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let runs = lock_store(&state)
        .ok()
        .and_then(|s| s.recent_tool_runs(limit).ok())
        .unwrap_or_default();
    let items: Vec<serde_json::Value> = runs
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "ts": r.ts,
                "thread_id": r.thread_id,
                "tool": r.tool,
                "kind": r.kind,
                "ok": r.ok,
                "error_kind": r.error_kind,
                "duration_ms": r.duration_ms,
                "summary": r.summary,
            })
        })
        .collect();
    Json(serde_json::json!({ "runs": items }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct SuggestionsQuery {
    scope: Option<String>,
    limit: Option<usize>,
}

/// GET /api/suggestions?scope=&limit= — pending proactive cards + counts.
pub(crate) async fn suggestions_list(
    State(state): State<AppState>,
    Query(q): Query<SuggestionsQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let (rows, counts) = lock_store(&state)
        .map(|s| {
            (
                s.pending_suggestions(q.scope.as_deref(), limit)
                    .unwrap_or_default(),
                s.pending_suggestion_counts().unwrap_or_default(),
            )
        })
        .unwrap_or_default();
    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "scope": r.scope,
                "kind": r.kind,
                "title": r.title,
                "body": r.body,
                "rationale": r.rationale,
                "proposed_action": r.proposed_action,
                "choices": suggestion_choices_json(&r.choices),
                "status": r.status,
                "feedback": r.feedback,
                "created_at": r.created_at,
                "generated_at": r.created_at,
                "source_ref": r.source_ref,
                "relevant_until": r.relevant_until,
            })
        })
        .collect();
    let counts: Vec<serde_json::Value> = counts
        .into_iter()
        .map(|(scope, count)| serde_json::json!({ "scope": scope, "count": count }))
        .collect();
    Json(serde_json::json!({ "suggestions": items, "counts": counts }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct SuggestionActRequest {
    status: String,
    #[serde(default)]
    feedback: Option<String>,
    #[serde(default)]
    note: Option<String>,
}

/// POST /api/suggestions/{id}/act — accept, dismiss, or snooze a card.
pub(crate) async fn suggestion_act(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(req): Json<SuggestionActRequest>,
) -> Json<serde_json::Value> {
    let status = match req.status.as_str() {
        "accepted" | "dismissed" | "snoozed" => req.status.as_str(),
        _ => "dismissed",
    };
    let feedback = req
        .feedback
        .as_deref()
        .filter(|f| matches!(*f, "liked" | "disliked"));
    let row = lock_store(&state)
        .ok()
        .and_then(|s| s.suggestion(id).ok().flatten());
    let ok = lock_store(&state)
        .ok()
        .and_then(|s| {
            s.set_suggestion_status(id, status, feedback, req.note.as_deref())
                .ok()
        })
        .is_some();
    if ok && let Some(row) = row {
        write_proactive_action_memory(&state, &row, status, feedback, req.note.as_deref());
    }
    Json(serde_json::json!({ "ok": ok }))
}

fn write_proactive_action_memory(
    state: &AppState,
    row: &crate::chat_store::SuggestionRow,
    status: &str,
    feedback: Option<&str>,
    note: Option<&str>,
) {
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "proactivity".to_string(),
        user_id: gateway_memory_user_id(),
        workspace_id: MemoryWorkspaceId::new(&row.scope),
        purpose: "proactive_action_writeback".to_string(),
    };
    let Some(request) =
        proactive_memory_request_for_suggestion_action(row, status, feedback, note, lifecycle)
    else {
        return;
    };
    let facade = memory_facade(state);
    if let Ok(record) = facade.create_memory_candidate(request.clone()) {
        let _ = facade.confirm_memory(
            &request.request,
            &record.reference,
            "proactive action write-back",
        );
    }
}

fn proactive_memory_request_for_suggestion_action(
    row: &crate::chat_store::SuggestionRow,
    status: &str,
    feedback: Option<&str>,
    note: Option<&str>,
    request: MemoryLifecycleRequest,
) -> Option<MemoryCreateRequest> {
    let memory_type = match status {
        "accepted" | "snoozed" => "open_loop",
        "dismissed" => "decision",
        _ => return None,
    };
    let note = note.map(str::trim).filter(|value| !value.is_empty());
    let feedback = feedback.map(str::trim).filter(|value| !value.is_empty());
    let action = row
        .proposed_action
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let text = match status {
        "accepted" => {
            let action_text = action.unwrap_or(row.body.as_str());
            format!(
                "Open loop from proactive card accepted: {} — follow through on: {}",
                row.title, action_text
            )
        }
        "snoozed" => format!(
            "Open loop from proactive card snoozed: {} — revisit later. {}",
            row.title, row.body
        ),
        "dismissed" => {
            let reason = note.or(feedback).unwrap_or("no reason recorded");
            format!(
                "Decision from proactive card: dismissed '{}' — reason: {}",
                row.title, reason
            )
        }
        _ => return None,
    };
    Some(MemoryCreateRequest {
        request,
        memory_type: memory_type.to_string(),
        text: redact_sensitive_text(&text),
        aliases: vec![row.title.clone(), row.kind.clone(), row.dedup_key.clone()],
        language_hints: Vec::new(),
        confidence: 1.0,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: MemoryDataSensitivity::Internal,
        evidence_refs: Vec::new(),
        metadata: serde_json::json!({
            "source": "proactivity",
            "suggestion": {
                "id": row.id,
                "scope": row.scope.clone(),
                "kind": row.kind.clone(),
                "title": row.title.clone(),
                "status": status,
                "feedback": feedback,
                "note": note,
                "dedup_key": row.dedup_key.clone(),
                "proposed_action": row.proposed_action.clone(),
            }
        }),
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct ProactiveReviewRequest {
    #[serde(default)]
    scope: String,
}

/// POST /api/proactivity/review-now — run one supervisor review immediately.
pub(crate) async fn proactivity_review_now(
    State(state): State<AppState>,
    Json(req): Json<ProactiveReviewRequest>,
) -> Json<serde_json::Value> {
    let scope = {
        let s = req.scope.trim();
        if s.is_empty() {
            PERSONAL_WORKSPACE.to_string()
        } else {
            s.to_string()
        }
    };
    if !lock_store(&state)
        .map(|s| s.plugin_enabled("proattivita"))
        .unwrap_or(true)
    {
        return Json(serde_json::json!({ "emitted": false, "disabled": true }));
    }
    match run_proactive_review(&state, &scope).await {
        Some(id) => {
            let card = lock_store(&state)
                .ok()
                .and_then(|s| s.pending_suggestions(Some(&scope), 50).ok())
                .and_then(|cards| cards.into_iter().find(|c| c.id == id))
                .map(|r| {
                    serde_json::json!({
                        "id": r.id,
                        "scope": r.scope,
                        "kind": r.kind,
                        "title": r.title,
                        "body": r.body,
                        "rationale": r.rationale,
                        "proposed_action": r.proposed_action,
                        "choices": suggestion_choices_json(&r.choices),
                        "status": r.status,
                        "created_at": r.created_at,
                    })
                });
            Json(serde_json::json!({ "emitted": true, "id": id, "card": card }))
        }
        None => Json(serde_json::json!({ "emitted": false })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proactive_action_memory_writeback_maps_statuses() {
        let row = crate::chat_store::SuggestionRow {
            id: 7,
            scope: "project-x".to_string(),
            kind: "follow-up".to_string(),
            title: "Controlla Idra".to_string(),
            body: "Idra sembra fermo.".to_string(),
            rationale: "Nessuna attività recente.".to_string(),
            proposed_action: Some("Controllare lo stato di Idra".to_string()),
            choices: None,
            status: "pending".to_string(),
            feedback: None,
            dedup_key: "follow-up:idra".to_string(),
            created_at: 123,
            source_ref: "supervisor:test".to_string(),
            relevant_until: None,
        };
        let lifecycle = local_first_memory::MemoryLifecycleRequest {
            actor_id: "test".to_string(),
            user_id: local_first_memory::UserId::new("user"),
            workspace_id: local_first_memory::WorkspaceId::new("project-x"),
            purpose: "test".to_string(),
        };

        let accepted = proactive_memory_request_for_suggestion_action(
            &row,
            "accepted",
            Some("liked"),
            None,
            lifecycle.clone(),
        )
        .expect("accepted writeback");
        assert_eq!(accepted.memory_type, "open_loop");
        assert!(accepted.text.contains("Open loop"));
        assert!(accepted.text.contains("Controlla Idra"));
        assert_eq!(
            accepted.metadata["suggestion"]["dedup_key"],
            "follow-up:idra"
        );

        let dismissed = proactive_memory_request_for_suggestion_action(
            &row,
            "dismissed",
            Some("disliked"),
            Some("non prioritario"),
            lifecycle.clone(),
        )
        .expect("dismissed writeback");
        assert_eq!(dismissed.memory_type, "decision");
        assert!(dismissed.text.contains("dismissed"));
        assert!(dismissed.text.contains("non prioritario"));

        let snoozed = proactive_memory_request_for_suggestion_action(
            &row,
            "snoozed",
            None,
            None,
            lifecycle.clone(),
        )
        .expect("snoozed writeback");
        assert_eq!(snoozed.memory_type, "open_loop");
        assert!(snoozed.text.contains("revisit later"));

        assert!(
            proactive_memory_request_for_suggestion_action(&row, "unknown", None, None, lifecycle,)
                .is_none()
        );
    }
}
