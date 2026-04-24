use std::sync::Arc;

use crate::provider::Provider;
use crate::user::DEFAULT_ADMIN_USER_ID;

use super::memory::{ConsolidationResult, MemoryConsolidator};
use super::session_control::try_compact;

#[cfg(feature = "embeddings")]
use super::memory_search::MemorySearcher;

#[cfg(feature = "embeddings")]
pub(super) type MemoryIndexHandle = Option<Arc<tokio::sync::Mutex<MemorySearcher>>>;

#[cfg(not(feature = "embeddings"))]
pub(super) type MemoryIndexHandle = ();

#[allow(clippy::too_many_arguments)]
pub(super) async fn finish_consolidation(
    memory: &Arc<MemoryConsolidator>,
    provider: Arc<dyn Provider>,
    model: &str,
    session_key: &str,
    result: ConsolidationResult,
    searcher: MemoryIndexHandle,
    max_memory_chunks: u32,
    memory_window: u32,
    contact_id: Option<i64>,
    agent_id: Option<&str>,
    profile_id: Option<i64>,
) {
    tracing::info!(
        session = %session_key,
        messages_processed = result.messages_processed,
        memory_updated = result.memory_updated,
        instructions = result.instructions_learned,
        secrets = result.secrets_stored,
        new_chunks = result.new_chunks.len(),
        "Background memory consolidation complete"
    );

    index_new_chunks(&result, &searcher).await;
    prune_memory_budget(memory, max_memory_chunks, profile_id, &searcher).await;
    summarize_period(
        memory,
        provider.clone(),
        model,
        contact_id,
        agent_id,
        profile_id,
    )
    .await;
    try_compact(memory, session_key, memory_window, provider.as_ref(), model).await;
}

#[cfg(feature = "embeddings")]
async fn index_new_chunks(result: &ConsolidationResult, searcher: &MemoryIndexHandle) {
    if result.new_chunks.is_empty() {
        return;
    }

    let Some(searcher_mutex) = searcher else {
        return;
    };

    let mut s = searcher_mutex.lock().await;
    let mut indexed = 0;
    let mut skipped = 0;

    for (chunk_id, text) in &result.new_chunks {
        match s.engine_mut().find_similar(text, 0.15).await {
            Ok(Some((existing_id, distance))) => {
                tracing::debug!(
                    chunk_id,
                    existing_id,
                    distance = format!("{:.3}", distance),
                    "Skipping duplicate memory chunk"
                );
                skipped += 1;
                continue;
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(
                    chunk_id,
                    error = %e,
                    "Failed to check for duplicates, indexing anyway"
                );
            }
        }

        if let Err(e) = s.engine_mut().index_chunk(*chunk_id, text).await {
            tracing::warn!(
                chunk_id,
                error = %e,
                "Failed to index chunk in HNSW"
            );
        } else {
            indexed += 1;
        }
    }

    if let Err(e) = s.save_index() {
        tracing::warn!(error = %e, "Failed to save HNSW index");
    }
    tracing::info!(
        total = result.new_chunks.len(),
        indexed,
        skipped,
        "Indexed memory chunks in HNSW (duplicates skipped)"
    );
}

#[cfg(not(feature = "embeddings"))]
async fn index_new_chunks(_result: &ConsolidationResult, _searcher: &MemoryIndexHandle) {}

async fn prune_memory_budget(
    memory: &MemoryConsolidator,
    max_memory_chunks: u32,
    profile_id: Option<i64>,
    searcher: &MemoryIndexHandle,
) {
    if max_memory_chunks == 0 {
        return;
    }

    match memory
        .prune_if_over_budget(max_memory_chunks, profile_id)
        .await
    {
        Ok(pruned_ids) if !pruned_ids.is_empty() => {
            tracing::info!(
                pruned = pruned_ids.len(),
                budget = max_memory_chunks,
                "Pruned memory chunks to stay within budget"
            );
            remove_pruned_chunks_from_index(&pruned_ids, searcher).await;
        }
        Err(e) => {
            tracing::warn!(error = %e, "Memory pruning failed");
        }
        _ => {}
    }
}

#[cfg(feature = "embeddings")]
async fn remove_pruned_chunks_from_index(pruned_ids: &[i64], searcher: &MemoryIndexHandle) {
    let Some(searcher_mutex) = searcher else {
        return;
    };

    let mut s = searcher_mutex.lock().await;
    for id in pruned_ids {
        s.engine_mut().remove(*id);
    }
    let _ = s.save_index();
}

#[cfg(not(feature = "embeddings"))]
async fn remove_pruned_chunks_from_index(_pruned_ids: &[i64], _searcher: &MemoryIndexHandle) {}

async fn summarize_period(
    memory: &MemoryConsolidator,
    provider: Arc<dyn Provider>,
    model: &str,
    contact_id: Option<i64>,
    agent_id: Option<&str>,
    profile_id: Option<i64>,
) {
    if let Err(e) = memory
        .maybe_summarize_period(
            provider.as_ref(),
            model,
            contact_id,
            agent_id,
            profile_id,
            Some(DEFAULT_ADMIN_USER_ID),
        )
        .await
    {
        tracing::warn!(error = %e, "Period summarization failed");
    }
}
