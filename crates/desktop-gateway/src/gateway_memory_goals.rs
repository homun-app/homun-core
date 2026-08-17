// Memory goal and project briefing routes for the Workbench project context.
use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;

use crate::*;

#[derive(Deserialize)]
pub(crate) struct GoalsListQuery {
    #[serde(default)]
    pub(crate) thread: Option<String>,
    #[serde(default)]
    pub(crate) workspace: Option<String>,
}

/// Goals + promotable decisions for the Workbench "Obiettivi" tab. Resolves the scope
/// from the chat thread (like memory_graph), so the panel works from a thread id alone.
pub(crate) async fn memory_goals_list(
    State(state): State<AppState>,
    Query(q): Query<GoalsListQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let ws = if let Some(tid) = q.thread.as_deref().filter(|t| !t.trim().is_empty()) {
        lock_store(&state)
            .ok()
            .and_then(|s| s.workspace_for_thread(tid).ok())
            .filter(|w| !w.trim().is_empty())
            .map(MemoryWorkspaceId::new)
            .unwrap_or_else(gateway_memory_workspace_id)
    } else if let Some(w) = q.workspace.filter(|w| !w.trim().is_empty()) {
        MemoryWorkspaceId::new(w)
    } else {
        gateway_memory_workspace_id()
    };
    let is_project = ws.as_str() != PERSONAL_WORKSPACE && ws.as_str() != THREADS_WORKSPACE;
    // Scoped so the facade MutexGuard is dropped before objective_block_for_workspace
    // below, which locks the same (non-reentrant) memory facade mutex itself - holding
    // this guard across that call would deadlock the request on its own lock.
    let items = {
        let facade = memory_facade(&state);
        facade.list_memories_for_ui(&user, &ws).unwrap_or_default()
    };
    let pick = |t: &str| -> Vec<serde_json::Value> {
        items
            .iter()
            .filter(|m| {
                m.memory_type == t
                    && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
            })
            .map(|m| serde_json::json!({ "reference": m.reference.to_string(), "text": m.text }))
            .collect()
    };
    // Objective TEXT alongside the goal count: reuse the same derivation the system
    // prompt uses (converge, don't duplicate), but SCOPED to this request's `ws` - the
    // same workspace as `goals`/`is_project` above - so the whole payload describes one
    // project. (project_objective_block would instead read the process-global memory
    // scope, which a concurrent run-turn could have pointed at a different project.)
    let objective = objective_block_for_workspace(&state, &ws);
    Ok(Json(serde_json::json!({
        "workspace": ws.as_str(),
        "is_project": is_project,
        "objective": objective,
        "goals": pick("goal"),
        "decisions": pick("decision"),
    })))
}

/// ADR 0022 (Piano UI A5): project context panel - cio' che l'agente SA stabilmente
/// del progetto (objective/brief/open-loops/decisions), per la UI. Risolve lo
/// scope dal threadId (None per Personal/Threads - invariant P1). Incl. provenance
/// `thread_id`/`origin_thread_title` per i record che lo registrano (cross-chat).
pub(crate) async fn memory_project_briefing(
    State(state): State<AppState>,
    Query(q): Query<GoalsListQuery>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let (ws, is_project) = if let Some(tid) = q.thread.as_deref().filter(|t| !t.trim().is_empty()) {
        let resolved = lock_store(&state)
            .ok()
            .and_then(|s| s.workspace_for_thread(tid).ok())
            .filter(|w| !w.trim().is_empty())
            .map(MemoryWorkspaceId::new)
            .unwrap_or_else(gateway_memory_workspace_id);
        let is_proj =
            resolved.as_str() != PERSONAL_WORKSPACE && resolved.as_str() != THREADS_WORKSPACE;
        (resolved, is_proj)
    } else if let Some(w) = q.workspace.filter(|w| !w.trim().is_empty()) {
        let resolved = MemoryWorkspaceId::new(w);
        let is_proj =
            resolved.as_str() != PERSONAL_WORKSPACE && resolved.as_str() != THREADS_WORKSPACE;
        (resolved, is_proj)
    } else {
        let resolved = gateway_memory_workspace_id();
        let is_proj =
            resolved.as_str() != PERSONAL_WORKSPACE && resolved.as_str() != THREADS_WORKSPACE;
        (resolved, is_proj)
    };
    if !is_project {
        // Personal/Threads: shape snella (invariant P1 - no project briefing).
        return Ok(Json(serde_json::json!({
            "workspace": ws.as_str(),
            "is_project": false,
            "objective": null,
            "brief": null,
            "open_loops": [],
            "decisions": [],
        })));
    }
    let facade = memory_facade(&state);
    let items = facade.list_memories_for_ui(&user, &ws).unwrap_or_default();
    // Objective (goals) + decisions + open-loops, con provenance thread_id.
    // Dedup by normalized text and cap: accepting the SAME repeated proactive card
    // (e.g. a recurring automation-failure card) stacks up many near-identical loops,
    // which flooded the context panel. `cap` bounds each list so the "cockpit" stays a
    // glanceable summary, not an unbounded dump.
    let pick_with_provenance = |t: &str, cap: usize| -> Vec<serde_json::Value> {
        let mut seen = std::collections::HashSet::new();
        let mut out: Vec<serde_json::Value> = Vec::new();
        for m in items.iter().filter(|m| {
            m.memory_type == t
                && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
        }) {
            let key: String = m
                .text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .to_lowercase();
            if !seen.insert(key) {
                continue;
            }
            let origin_thread = m.metadata.get("thread_id").and_then(|v| v.as_str());
            out.push(serde_json::json!({
                "reference": m.reference.to_string(),
                "text": m.text,
                "thread_id": origin_thread,
            }));
            if out.len() >= cap {
                break;
            }
        }
        out
    };
    // Brief: la wiki page `brief.md`.
    let brief = facade
        .list_wiki_pages_for_ui(&user, &ws)
        .ok()
        .and_then(|pages| pages.into_iter().find(|p| p.path == "brief.md"))
        .map(|p| serde_json::json!({ "body": p.body }));
    // Objective block testuale (formato come nel system prompt).
    let objective_text = project_objective_block(&state);
    Ok(Json(serde_json::json!({
        "workspace": ws.as_str(),
        "is_project": true,
        "objective": objective_text,
        "brief": brief,
        "open_loops": pick_with_provenance("open_loop", 6),
        "decisions": pick_with_provenance("decision", 8),
        "goals": pick_with_provenance("goal", 8),
    })))
}

#[derive(Deserialize)]
pub(crate) struct PromoteGoalsRequest {
    #[serde(default)]
    pub(crate) workspace: Option<String>,
    pub(crate) refs: Vec<String>,
}

/// Promote selected memories (the `decision`s the user flagged) to `goal` - the
/// LLM-free, language-agnostic way to set project objectives: the user picks, no keyword
/// guessing, no fighting the extractor's bias. Regenerates the brief so ## Obiettivi
/// reflects them.
pub(crate) async fn memory_goals_promote(
    State(state): State<AppState>,
    Json(req): Json<PromoteGoalsRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let ws = req
        .workspace
        .filter(|w| !w.trim().is_empty())
        .map(MemoryWorkspaceId::new)
        .unwrap_or_else(gateway_memory_workspace_id);
    let facade = memory_facade(&state);
    let mut promoted = 0usize;
    for raw in &req.refs {
        if let Ok(reference) = raw.parse::<MemoryRef>()
            && facade
                .set_memory_type(&reference, &user, &ws, "goal")
                .is_ok()
        {
            promoted += 1;
        }
    }
    rebuild_project_brief(facade, &user, &ws);
    Ok(Json(serde_json::json!({ "promoted": promoted })))
}

#[derive(Deserialize)]
pub(crate) struct AddGoalRequest {
    #[serde(default)]
    pub(crate) workspace: Option<String>,
    pub(crate) text: String,
}

/// Add a fresh project goal authored by the user (created confirmed; brief refreshed).
pub(crate) async fn memory_goals_add(
    State(state): State<AppState>,
    Json(req): Json<AddGoalRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let text = req.text.trim().to_string();
    if text.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "empty_goal",
            message: "empty objective".to_string(),
        });
    }
    let user = gateway_memory_user_id();
    let ws = req
        .workspace
        .filter(|w| !w.trim().is_empty())
        .map(MemoryWorkspaceId::new)
        .unwrap_or_else(gateway_memory_workspace_id);
    let facade = memory_facade(&state);
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "desktop-chat".to_string(),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        purpose: "add_goal".to_string(),
    };
    let record = facade
        .create_memory_candidate(MemoryCreateRequest {
            request: lifecycle.clone(),
            memory_type: "goal".to_string(),
            text,
            aliases: Vec::new(),
            language_hints: Vec::new(),
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("work"),
            sensitivity: MemoryDataSensitivity::Internal,
            evidence_refs: Vec::new(),
            metadata: serde_json::json!({ "source": "add_goal", "scope": "project" }),
        })
        .map_err(|e| GatewayError::memory(e.to_string()))?;
    let _ = facade.confirm_memory(&lifecycle, &record.reference, "goal added by user");
    rebuild_project_brief(facade, &user, &ws);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub(crate) struct SuggestGoalsRequest {
    #[serde(default)]
    pub(crate) thread: Option<String>,
    #[serde(default)]
    pub(crate) workspace: Option<String>,
}

/// Assistant PROPOSES objectives (the north star) from the project context - this is the
/// logic to DEFINE goals, not derive them from decisions. The model drafts forward-looking
/// objectives; the user edits/confirms (LLM proposes, user disposes).
pub(crate) async fn memory_goals_suggest(
    State(state): State<AppState>,
    Json(req): Json<SuggestGoalsRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let user = gateway_memory_user_id();
    let ws = if let Some(tid) = req.thread.as_deref().filter(|t| !t.trim().is_empty()) {
        lock_store(&state)
            .ok()
            .and_then(|s| s.workspace_for_thread(tid).ok())
            .filter(|w| !w.trim().is_empty())
            .map(MemoryWorkspaceId::new)
            .unwrap_or_else(gateway_memory_workspace_id)
    } else if let Some(w) = req.workspace.clone().filter(|w| !w.trim().is_empty()) {
        MemoryWorkspaceId::new(w)
    } else {
        gateway_memory_workspace_id()
    };
    let name = load_workspaces_file()
        .workspaces
        .into_iter()
        .find(|w| w.id.as_str() == ws.as_str())
        .map(|w| w.name)
        .unwrap_or_else(|| "(unnamed)".to_string());
    // Collect context as OWNED strings, then DROP the facade before the await (the lock
    // guard isn't Send across an await point).
    let (decisions, existing): (Vec<String>, Vec<String>) = {
        let facade = memory_facade(&state);
        let items = facade.list_memories_for_ui(&user, &ws).unwrap_or_default();
        let dec = items
            .iter()
            .filter(|m| {
                m.memory_type == "decision"
                    && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
            })
            .map(|m| m.text.lines().next().unwrap_or(&m.text).trim().to_string())
            .take(20)
            .collect();
        let goals = items
            .iter()
            .filter(|m| {
                m.memory_type == "goal"
                    && matches!(m.status, MemoryStatus::Confirmed | MemoryStatus::Candidate)
            })
            .map(|m| m.text.trim().to_string())
            .collect();
        (dec, goals)
    };
    let context = format!(
        "PROJECT: {name}\n\nDECISIONS MADE SO FAR:\n- {}\n\nOBJECTIVES ALREADY DEFINED (don't repeat them):\n- {}",
        if decisions.is_empty() {
            "(none)".to_string()
        } else {
            decisions.join("\n- ")
        },
        if existing.is_empty() {
            "(none)".to_string()
        } else {
            existing.join("\n- ")
        },
    );
    let system = "You are a product strategist. Given a project's context (name, decisions made), \
propose 1 to 3 HIGH-LEVEL OBJECTIVES: the NORTH STAR - WHERE the project must arrive, or HOW a key \
module must work. An objective looks FORWARD (the direction/the milestone to reach); it is NOT an \
already-made technical decision (that looks backward). Infer the direction from the decisions, but \
phrase the INTENT, not the list of what was done. Short and concrete sentences, in the project's \
language. Do not repeat already-defined objectives. Reply ONLY with JSON: \
{\"objectives\":[\"...\"]}.";
    let objectives = call_memory_json(&state, system, &context)
        .await
        .and_then(|v| {
            v.get("objectives").and_then(|a| a.as_array()).map(|arr| {
                arr.iter()
                    .filter_map(|s| s.as_str().map(|t| t.trim().to_string()))
                    .filter(|t| !t.is_empty())
                    .collect::<Vec<_>>()
            })
        })
        .unwrap_or_default();
    Ok(Json(
        serde_json::json!({ "objectives": objectives, "workspace": ws.as_str() }),
    ))
}
