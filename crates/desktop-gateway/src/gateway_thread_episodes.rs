//! Thread-scoped episodic memory ownership.
//!
//! Conversation episodes are stored in a reserved memory workspace so they can
//! be recalled by exact thread/workspace scope without polluting the always-on
//! personal or project memory surfaces.

use crate::gateway_identity::{gateway_memory_user_id, gateway_memory_workspace_id};
use crate::gateway_memory_briefing::CHAT_MEMORY_BUDGET_CHARS;
use crate::{AppState, memory_facade};
use local_first_memory::{
    DataSensitivity as MemoryDataSensitivity, ExtractedMemory, MemoryExtraction, MemoryFacade,
    MemoryLifecycleRequest, MemoryStatus, PrivacyDomain, UserId as MemoryUserId,
    WorkspaceId as MemoryWorkspaceId,
};

/// Reserved workspace for THREAD (episodic) memory - "what we discussed".
pub(crate) const THREADS_WORKSPACE: &str = "__threads__";

/// Store a one-line episodic summary of a conversation turn, tagged with its
/// thread, in the thread scope. Confirmed directly as a factual record.
pub(crate) fn store_episode(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    thread_id: &str,
    summary: &str,
    origin_workspace: &str,
) {
    let summary = summary.trim();
    if summary.is_empty() {
        return;
    }
    let workspace = MemoryWorkspaceId::new(THREADS_WORKSPACE);
    let extracted = ExtractedMemory {
        memory_type: "episode".to_string(),
        text: summary.to_string(),
        aliases: Vec::new(),
        language_hints: Vec::new(),
        confidence: 1.0,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: MemoryDataSensitivity::Internal,
        evidence_refs: Vec::new(),
        evolution: None,
        // `workspace` is the conversation scope, so episodic recall can stay
        // isolated per project instead of leaking into global thread recall.
        metadata: serde_json::json!({
            "thread_id": thread_id,
            "scope": "thread",
            "workspace": origin_workspace,
        }),
    };
    let extraction = MemoryExtraction {
        memories: vec![extracted],
        entities: Vec::new(),
        relations: Vec::new(),
    };
    let Ok(result) = facade.apply_extraction(user_id, &workspace, extraction) else {
        return;
    };
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "memory-extractor".to_string(),
        user_id: user_id.clone(),
        workspace_id: workspace,
        purpose: "episode".to_string(),
    };
    if let Some(reference) = result.memory_refs.first() {
        let _ = facade.confirm_memory(&lifecycle, reference, "episode");
    }
}

pub(crate) fn current_thread_episode_block(state: &AppState, thread_id: &str) -> Option<String> {
    let user = gateway_memory_user_id();
    let threads = MemoryWorkspaceId::new(THREADS_WORKSPACE);
    let origin_workspace = gateway_memory_workspace_id();
    let mut episodes = memory_facade(state)
        .list_memories_for_ui(&user, &threads)
        .ok()?
        .into_iter()
        .filter(|memory| memory.status == MemoryStatus::Confirmed)
        .filter(|memory| {
            episode_metadata_matches_scope(&memory.metadata, thread_id, origin_workspace.as_str())
        })
        .collect::<Vec<_>>();
    episodes.sort_by(|left, right| left.updated_at.cmp(&right.updated_at));
    let mut selected = Vec::new();
    let mut used = 0usize;
    for episode in episodes.into_iter().rev().take(24) {
        if used.saturating_add(episode.text.len()) > CHAT_MEMORY_BUDGET_CHARS / 2 {
            break;
        }
        used += episode.text.len();
        selected.push(episode.text);
    }
    if selected.is_empty() {
        return None;
    }
    selected.reverse();
    Some(format!(
        "CURRENT THREAD MEMORY (confirmed episodes from this exact thread and workspace):\n- {}",
        selected.join("\n- ")
    ))
}

pub(crate) fn episode_metadata_matches_scope(
    metadata: &serde_json::Value,
    thread_id: &str,
    workspace_id: &str,
) -> bool {
    metadata.get("thread_id").and_then(|value| value.as_str()) == Some(thread_id)
        && metadata.get("workspace").and_then(|value| value.as_str()) == Some(workspace_id)
}
