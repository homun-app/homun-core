//! Chat workspace prompt context owner.
//!
//! Owns the workspace/thread knowledge layer appended after the core runtime
//! prompt layers and before prompt packets are built. The memory stores, recall
//! service, prompt wording, toolset and agent loop remain separate owners.

use crate::gateway_channels::ContactTurnContext;
use crate::gateway_contacts::{contact_history_prompt_block, episode_texts_by_handles};
use crate::gateway_identity::{gateway_memory_user_id, gateway_memory_workspace_id};
use crate::gateway_memory_briefing::{
    CHAT_MEMORY_BUDGET_CHARS, MemoryInjectionPolicy, format_memory_block_with_provenance,
    gather_profile_memory_for_intent_with_provenance,
};
use crate::gateway_memory_clients::gateway_embedding_client;
use crate::gateway_memory_prompt_context::{
    artifact_provenance_context_for_query, relevant_code_components_for_prompt,
    workflow_status_context_for_query,
};
use crate::gateway_memory_recall_service::recall_pack_on_facade;
use crate::gateway_memory_sources::memory_perimeter_allows_recall;
use crate::gateway_memory_turn_context::{
    memory_scope_for_turn, project_brief_block, project_objective_block, recent_work_block,
    scope_from_active_workspace,
};
use crate::gateway_prompt_instructions::goal_propose_instruction;
use crate::gateway_recall_context::{
    gather_open_loops, memory_access_status_instruction, merge_automatic_recall_payload,
    recall_stream_payload_from_hits, recall_stream_payload_from_pack,
};
use crate::gateway_state_access::memory_facade;
use crate::gateway_thread_episodes::current_thread_episode_block;
use crate::{AppState, semantic_decision};
use local_first_memory::{MemoryScope, PERSONAL_WORKSPACE, THREADS_WORKSPACE};

pub(crate) struct ChatWorkspacePromptContextInput<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) system: String,
    pub(crate) prompt_core: &'a str,
    pub(crate) prompt: &'a str,
    pub(crate) thread_id: Option<&'a str>,
    pub(crate) contact: Option<&'a ContactTurnContext>,
    pub(crate) contact_only: bool,
    pub(crate) can_see_contacts: bool,
    pub(crate) can_use_project_memory: bool,
    pub(crate) is_project: bool,
    pub(crate) memory_intent: &'a semantic_decision::MemoryIntent,
    pub(crate) memory_injection: MemoryInjectionPolicy,
    pub(crate) applies_new_input: bool,
}

pub(crate) struct ChatWorkspacePromptContext {
    pub(crate) prompt_workspace: String,
    pub(crate) automatic_recall_payload: Option<local_first_subagents::RecallStreamPayload>,
}

struct MemoryPromptContextInput<'a, 'b> {
    state: &'a AppState,
    system: String,
    prompt: &'a str,
    thread_id: Option<&'a str>,
    memory_intent: &'a semantic_decision::MemoryIntent,
    memory_injection: MemoryInjectionPolicy,
    applies_new_input: bool,
    automatic_recall_payload: &'b mut Option<local_first_subagents::RecallStreamPayload>,
}

pub(crate) async fn prepare_chat_workspace_prompt_context(
    input: ChatWorkspacePromptContextInput<'_>,
) -> ChatWorkspacePromptContext {
    let mut automatic_recall_payload = None;
    let system = if input.contact_only {
        let cx = input.contact.expect("contact_only implies contact context");
        let episodes = {
            let facade = memory_facade(input.state);
            let user = gateway_memory_user_id();
            episode_texts_by_handles(facade, &user, &cx.handles)
        };
        match contact_history_prompt_block(&episodes) {
            Some(block) => format!("{}\n\n{block}", input.system),
            None => input.system,
        }
    } else if !memory_perimeter_allows_recall(
        input.contact_only,
        input.can_see_contacts,
        input.can_use_project_memory,
        input.is_project,
    ) {
        let scope = scope_from_active_workspace();
        automatic_recall_payload = Some(local_first_subagents::RecallStreamPayload {
            query: input.prompt.to_string(),
            hits: Vec::new(),
            scope: match scope {
                MemoryScope::Personal => "personal".to_string(),
                MemoryScope::Project(_) | MemoryScope::Thread { .. } => "project".to_string(),
            },
            status: "denied".to_string(),
        });
        input.system
    } else {
        append_memory_prompt_context(MemoryPromptContextInput {
            state: input.state,
            system: input.system,
            prompt: input.prompt,
            thread_id: input.thread_id,
            memory_intent: input.memory_intent,
            memory_injection: input.memory_injection,
            applies_new_input: input.applies_new_input,
            automatic_recall_payload: &mut automatic_recall_payload,
        })
        .await
    };

    let system = append_relevant_code_context(input.state, system, input.prompt);
    ChatWorkspacePromptContext {
        prompt_workspace: system
            .strip_prefix(input.prompt_core)
            .unwrap_or_default()
            .trim()
            .to_string(),
        automatic_recall_payload,
    }
}

async fn append_memory_prompt_context(input: MemoryPromptContextInput<'_, '_>) -> String {
    let system = append_briefing_context(
        input.state,
        input.system,
        input.prompt,
        input.thread_id,
        input.memory_intent,
        input.memory_injection,
        input.automatic_recall_payload,
    );
    let thread_memory = input
        .thread_id
        .filter(|_| input.memory_injection.include_current_thread)
        .and_then(|thread_id| current_thread_episode_block(input.state, thread_id));
    let system = match thread_memory {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    };
    let system = append_goal_propose_affordance(system);
    append_recall_context(
        input.state,
        system,
        input.prompt,
        input.thread_id,
        input.memory_injection,
        input.applies_new_input,
        input.automatic_recall_payload,
    )
    .await
}

fn append_briefing_context(
    state: &AppState,
    system: String,
    prompt: &str,
    thread_id: Option<&str>,
    memory_intent: &semantic_decision::MemoryIntent,
    memory_injection: MemoryInjectionPolicy,
    automatic_recall_payload: &mut Option<local_first_subagents::RecallStreamPayload>,
) -> String {
    if let Some(service) = state.memory_service.as_ref() {
        let scope = memory_scope_for_turn(thread_id);
        let pack = service.brief(&scope, prompt);
        if !pack.linked_hits.is_empty() {
            merge_automatic_recall_payload(
                automatic_recall_payload,
                recall_stream_payload_from_hits(prompt, &scope, &pack.linked_hits),
            );
        }
        let mut system = system;
        for block in pack.ordered_blocks().into_iter().flatten() {
            system = format!("{system}\n\n{block}");
        }
        return system;
    }

    let (memory_personal, memory_project) =
        gather_profile_memory_for_intent_with_provenance(state, memory_intent);
    let memory_open_loops = if memory_injection.include_cross_thread {
        gather_open_loops(state, 6)
    } else {
        Vec::new()
    };
    let formatted_profile = format_memory_block_with_provenance(
        &memory_open_loops,
        &memory_personal,
        &memory_project,
        CHAT_MEMORY_BUDGET_CHARS,
    );
    if !formatted_profile.linked_hits.is_empty() {
        let scope = scope_from_active_workspace();
        merge_automatic_recall_payload(
            automatic_recall_payload,
            recall_stream_payload_from_hits(prompt, &scope, &formatted_profile.linked_hits),
        );
    }
    let system = match formatted_profile.block {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    };
    let system = match project_objective_block(state) {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    };
    let system = match project_brief_block(state) {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    };
    match recent_work_block(state) {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    }
}

fn append_goal_propose_affordance(system: String) -> String {
    let ws = gateway_memory_workspace_id();
    if ws.as_str() != PERSONAL_WORKSPACE && ws.as_str() != THREADS_WORKSPACE {
        format!("{system}\n\n{}", goal_propose_instruction())
    } else {
        system
    }
}

async fn append_recall_context(
    state: &AppState,
    system: String,
    prompt: &str,
    thread_id: Option<&str>,
    memory_injection: MemoryInjectionPolicy,
    applies_new_input: bool,
    automatic_recall_payload: &mut Option<local_first_subagents::RecallStreamPayload>,
) -> String {
    if !memory_injection.include_cross_thread || !applies_new_input {
        return system;
    }

    if let Some(service) = state.memory_service.as_ref() {
        let scope = memory_scope_for_turn(thread_id);
        let pack = service.recall(prompt, &scope).await;
        merge_automatic_recall_payload(
            automatic_recall_payload,
            recall_stream_payload_from_pack(&pack),
        );
        let status = memory_access_status_instruction(pack.status);
        let system = match pack.block {
            Some(block) => format!("{system}\n\n{block}"),
            None => system,
        };
        return format!("{system}\n\n{status}");
    }

    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let embedding: std::sync::Arc<dyn local_first_memory::EmbeddingClient> =
        gateway_embedding_client(state.http.clone());
    let query_vec = local_first_memory::embed_query(embedding.as_ref(), prompt).await;
    let block = {
        let facade = memory_facade(state);
        let graph_context: Option<&local_first_memory::GraphContextHook<'_>> =
            Some(&|facade, user, workspace, q| {
                if let Some(workflow) =
                    workflow_status_context_for_query(facade, user, workspace, q)
                {
                    return Some(workflow);
                }
                artifact_provenance_context_for_query(facade, user, workspace, q)
            });
        recall_pack_on_facade(facade, &user, &workspace, prompt, &query_vec, graph_context)
    };
    merge_automatic_recall_payload(
        automatic_recall_payload,
        recall_stream_payload_from_pack(&block),
    );
    let status = memory_access_status_instruction(block.status);
    let system = match block.block {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    };
    format!("{system}\n\n{status}")
}

fn append_relevant_code_context(state: &AppState, system: String, prompt: &str) -> String {
    let facade = memory_facade(state);
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    match relevant_code_components_for_prompt(facade, &user, &workspace, prompt) {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    }
}
