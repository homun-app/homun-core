use crate::gateway_identity::{gateway_memory_user_id, gateway_memory_workspace_id};
use crate::gateway_memory_clients::gateway_llm_client;
use crate::gateway_memory_graph_persistence::persist_graph;
use crate::gateway_memory_turn_context::scope_from_active_workspace;
use crate::gateway_memory_wiki::wiki_is_edited;
use crate::gateway_text_safety::redact_sensitive_text;
use crate::gateway_thread_episodes::store_episode;
use crate::gateway_workspaces::load_workspaces_file;
use crate::{AppState, memory_facade};
use local_first_memory::{
    Exchange, PERSONAL_WORKSPACE, UserId as MemoryUserId, WorkspaceId as MemoryWorkspaceId,
};

/// ADR 0022 — Tappa 1/4: apprendimento post-turno. Di default (service ON)
/// instrada via `MemoryRecallService::learn`; anche nel
/// path OFF usa le STESSE fn del crate (3 fasi: prepare_learn_prompt →
/// LlmClient.chat → persist_learn_extraction) con capability client costruiti
/// al volo — così `learn_from_exchange` non è più duplicata nel gateway.
#[allow(clippy::too_many_arguments)]
pub(crate) fn learn_via_service_or_inline(
    state: &AppState,
    user_message: &str,
    assistant_message: &str,
    actions: &str,
    thread_id: Option<&str>,
    turn_id: Option<&str>,
    speaker: Option<&str>,
    prev_assistant: Option<&str>,
    reuse_envelope: local_first_memory::MemoryReuseEnvelope,
) -> local_first_memory::BoxFuture<'static, ()> {
    if let Some(service) = state.memory_service.clone() {
        let scope = scope_from_active_workspace();
        let exchange = Exchange {
            user_message: user_message.to_string(),
            assistant_message: assistant_message.to_string(),
            actions: actions.to_string(),
            thread_id: thread_id.map(str::to_string),
            turn_id: turn_id.map(str::to_string),
            speaker: speaker.map(str::to_string),
            prev_assistant: prev_assistant.map(str::to_string),
            reuse_envelope,
        };
        Box::pin(async move { service.learn(&exchange, &scope).await })
    } else {
        // Path OFF: stessa orchestrazione del crate, capability client al volo.
        let state = state.clone();
        let user_message = user_message.to_string();
        let assistant_message = assistant_message.to_string();
        let actions = actions.to_string();
        let thread_id = thread_id.map(str::to_string);
        let turn_id = turn_id.map(str::to_string);
        let speaker = speaker.map(str::to_string);
        let prev_assistant = prev_assistant.map(str::to_string);
        let exchange = Exchange {
            user_message,
            assistant_message,
            actions,
            thread_id: thread_id.clone(),
            turn_id,
            speaker,
            prev_assistant,
            reuse_envelope,
        };
        Box::pin(async move {
            let user = gateway_memory_user_id();
            let active = gateway_memory_workspace_id();
            let project_name = if active.as_str() != PERSONAL_WORKSPACE {
                load_workspaces_file()
                    .workspaces
                    .into_iter()
                    .find(|w| w.id.as_str() == active.as_str())
                    .map(|w| w.name)
            } else {
                None
            };
            let llm: std::sync::Arc<dyn local_first_memory::LlmClient> =
                gateway_llm_client(state.http.clone());
            // Fase 1 (lock): prompt.
            let prompt = {
                let facade = memory_facade(&state);
                local_first_memory::prepare_learn_prompt(
                    facade,
                    &user,
                    &active,
                    &exchange,
                    project_name.as_deref(),
                )
            };
            let Some((system, user_content)) = prompt else {
                return;
            };
            // Fase 2 (off-lock): LLM.
            let Some(content) = llm.chat(&system, &user_content).await else {
                return;
            };
            // Fase 3 (lock): persist + hooks.
            let facade = memory_facade(&state);
            let hooks = local_first_memory::LearnHooks {
                persist_graph: Some(
                    &|facade, user, workspace, entities, relations, project_ws| {
                        persist_graph(facade, user, workspace, entities, relations, project_ws);
                    },
                ),
                store_episode: Some(&|facade, user, thread_id, episode, active| {
                    store_episode(facade, user, thread_id, episode, active);
                }),
                backfill_embeddings: None,
            };
            local_first_memory::persist_learn_extraction(
                facade, &user, &active, &content, &exchange, hooks,
            );
        })
    }
}

/// Memory consolidation ("reflection"): review a scope's durable memories, MERGE the
/// fragments that say the same thing, and PRUNE noise (transient/trivial/irrelevant or
/// redundant). Conservative — when in doubt the model keeps. Returns (merged, dropped).
///
/// ADR 0022 (Tappa 4, F3): orchestrazione migrata nel crate via 3 fasi Send-safe
/// (`consolidate_prepare` → LLM curatore off-lock → `consolidate_apply`). Il
/// `MutexGuard` non attraversa l'await della LLM call. Corpo spostato fedelmente.
pub(crate) async fn consolidate_scope(
    state: &AppState,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) -> (usize, usize) {
    // is_edited callback: il crate non legge il FS gateway (pattern = hooks).
    let is_edited = |ws: &MemoryWorkspaceId, path: &str| wiki_is_edited(ws, path);
    // Fase 1 (lock): dedup open-loop + pre-pass deterministico + listing.
    let (merged, prepared) = {
        let facade = memory_facade(state);
        local_first_memory::consolidate_prepare(facade, user, workspace, &is_edited)
    };
    let Some(input) = prepared else {
        // <3 memorie sopravvissute (o early-exit): wiki già ricostruite nella prepare.
        return (merged, 0);
    };
    // Fase 2 (off-lock): LLM curatore via client gateway throwaway, poi parse
    // JSON resiliente (strip_json_fences è nel crate).
    let llm: std::sync::Arc<dyn local_first_memory::LlmClient> =
        gateway_llm_client(state.http.clone());
    let content = llm
        .chat(
            local_first_memory::CURATOR_SYSTEM,
            &format!("MEMORIE ATTUALI:\n{}", input.listing),
        )
        .await;
    let root = content.and_then(|c| {
        serde_json::from_str::<serde_json::Value>(local_first_memory::strip_json_fences(&c)).ok()
    });
    let Some(root) = root else {
        // LLM curator unavailable: keep the deterministic merges already applied,
        // rebuild the wiki pages.
        {
            let facade = memory_facade(state);
            local_first_memory::rebuild_all_wiki(facade, user, workspace, &is_edited);
        }
        return (merged, 0);
    };
    // Fase 3 (lock re-acquisito): applica merge/drop + ricostruisce wiki.
    let facade = memory_facade(state);
    local_first_memory::consolidate_apply(
        facade,
        user,
        workspace,
        &root,
        &input.mems,
        merged,
        &is_edited,
        &|text| redact_sensitive_text(text),
    )
}
