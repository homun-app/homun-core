use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::provider::{Provider, StreamChunk, Usage};
use crate::session::SessionManager;
use crate::storage::Database;
use crate::tools::ResponseBlock;

use super::memory::MemoryConsolidator;
use super::memory_maintenance::{maybe_consolidate, ConsolidationInputs, MemoryIndexHandle};
use super::request_trace::RequestTracer;

pub(super) struct FinalizeTurnInputs<'a> {
    pub persistence: PersistenceContext<'a>,
    pub usage: UsageContext,
    pub memory: MemoryFinalizationContext,
    pub trace: TraceContext,
    pub stream_tx: Option<&'a mpsc::Sender<StreamChunk>>,
}

pub(super) struct PersistenceContext<'a> {
    pub session_manager: &'a SessionManager,
    pub db: Database,
}

pub(super) struct UsageContext {
    pub selected_model: String,
    pub provider_name: String,
    pub total_usage: Usage,
}

pub(super) struct MemoryFinalizationContext {
    pub memory: Arc<MemoryConsolidator>,
    pub config: Arc<tokio::sync::RwLock<Config>>,
    pub provider: Arc<dyn Provider>,
    pub db: Database,
    pub agent_id: Option<String>,
    pub searcher: MemoryIndexHandle,
    pub active_profile_id: i64,
    pub active_profile_brain_dir: Option<PathBuf>,
    pub active_profile_slug: Option<String>,
}

pub(super) struct TraceContext {
    pub tracer: Option<RequestTracer>,
    pub traces_max_files: usize,
    pub iteration: u32,
}

pub(super) async fn finalize_response_turn(
    inputs: FinalizeTurnInputs<'_>,
    content: &str,
    session_key: &str,
    safe_response: String,
    mut response_blocks: Vec<ResponseBlock>,
    tools_used: Vec<String>,
) -> Result<String> {
    let (safe_response, llm_blocks) = crate::tools::response_blocks::extract_blocks(&safe_response);
    if !llm_blocks.is_empty() {
        tracing::info!(
            count = llm_blocks.len(),
            "Extracted blocks from LLM response"
        );
        response_blocks.extend(llm_blocks);
    }

    inputs
        .persistence
        .session_manager
        .add_message(session_key, "user", content)
        .await?;

    let stored_response = if response_blocks.is_empty() {
        safe_response.clone()
    } else {
        crate::web::chat_attachments::encode_inline_context(
            &safe_response,
            &[],
            &[],
            &response_blocks,
        )
        .unwrap_or_else(|| safe_response.clone())
    };
    inputs
        .persistence
        .session_manager
        .add_message_with_tools(session_key, "assistant", &stored_response, &tools_used)
        .await?;

    if !tools_used.is_empty() {
        tracing::info!(
            tools_used = ?tools_used,
            "Agent completed with tool usage"
        );
    }

    record_token_usage(
        inputs.persistence.db.clone(),
        session_key,
        &inputs.usage.selected_model,
        &inputs.usage.provider_name,
        inputs.usage.total_usage.clone(),
    );

    emit_response_blocks(inputs.stream_tx, &response_blocks).await;
    cleanup_task_checkpoint(&inputs.persistence.db, session_key).await;

    maybe_consolidate(
        ConsolidationInputs {
            memory: inputs.memory.memory,
            config: inputs.memory.config,
            provider: inputs.memory.provider,
            db: inputs.memory.db,
            agent_id: inputs.memory.agent_id,
            searcher: inputs.memory.searcher,
        },
        session_key,
        inputs.memory.active_profile_brain_dir,
        Some(inputs.memory.active_profile_id),
        inputs.memory.active_profile_slug,
    )
    .await;

    finalize_trace(
        inputs.trace.tracer,
        &safe_response,
        inputs.trace.iteration,
        inputs.usage.total_usage.total_tokens,
        inputs.trace.traces_max_files,
    );

    Ok(safe_response)
}

fn record_token_usage(
    db: Database,
    session_key: &str,
    selected_model: &str,
    provider_name: &str,
    usage: Usage,
) {
    if usage.total_tokens == 0 {
        return;
    }

    let sk = session_key.to_string();
    let model = selected_model.to_string();
    let prov = provider_name.to_string();
    tokio::spawn(async move {
        if let Err(e) = db
            .insert_token_usage(
                &sk,
                &model,
                &prov,
                usage.prompt_tokens,
                usage.completion_tokens,
                usage.total_tokens,
            )
            .await
        {
            tracing::warn!(error = %e, "Failed to record token usage");
        }
    });
}

async fn emit_response_blocks(
    stream_tx: Option<&mpsc::Sender<StreamChunk>>,
    response_blocks: &[ResponseBlock],
) {
    if response_blocks.is_empty() {
        return;
    }

    tracing::info!(
        total = response_blocks.len(),
        types = %response_blocks.iter()
            .map(|b| b.block_type_name())
            .collect::<Vec<_>>()
            .join(", "),
        "Sending response blocks to client"
    );

    if let Some(tx) = stream_tx {
        let blocks_json = serde_json::to_string(response_blocks).unwrap_or_default();
        let _ = tx
            .send(StreamChunk {
                delta: blocks_json,
                done: false,
                event_type: Some("blocks".to_string()),
                tool_call_data: None,
            })
            .await;
    }
}

async fn cleanup_task_checkpoint(db: &Database, session_key: &str) {
    if let Err(e) = db.delete_task_checkpoint_by_session(session_key).await {
        tracing::debug!(error = %e, "Failed to cleanup task checkpoint (may not exist)");
    }
}

fn finalize_trace(
    tracer: Option<RequestTracer>,
    safe_response: &str,
    iteration: u32,
    total_tokens: u32,
    traces_max_files: usize,
) {
    if let Some(mut t) = tracer {
        let cancelled = crate::agent::stop::is_stop_requested();
        t.finalize(
            safe_response,
            iteration.saturating_sub(1),
            total_tokens,
            cancelled,
        );
        tokio::spawn(async move { t.write_to_disk(traces_max_files) });
    }
}
