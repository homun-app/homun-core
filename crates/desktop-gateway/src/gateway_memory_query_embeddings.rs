//! Query embedding cache for memory recall.
//!
//! This owner keeps the deterministic cache behavior for recall embeddings out
//! of the gateway root: embedding provider config, HTTP transport, normalized
//! cache keys, LRU eviction, TTL, timeout knobs, and recall timing projection.

use std::collections::HashMap;
use std::env;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use local_first_memory::WorkspaceId as MemoryWorkspaceId;
use serde::Serialize;

use crate::{gateway_user_id, global_usage_recorder, inference_transport};

pub(crate) fn embed_model() -> String {
    env::var("HOMUN_EMBED_MODEL").unwrap_or_else(|_| "nomic-embed-text-v2-moe".to_string())
}

pub(crate) fn embed_base() -> String {
    env::var("HOMUN_EMBED_BASE").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string())
}

/// Embed one text via Ollama `/api/embed`. Best-effort: `None` on any failure
/// (the caller falls back to lexical), so embeddings never break a turn.
pub(crate) async fn embed_text(
    http: &reqwest::Client,
    text: &str,
    usage: &local_first_inference_usage::UsageContext,
) -> Option<Vec<f32>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let response = inference_transport::send_ollama_embed(
        http,
        global_usage_recorder(),
        usage,
        &embed_base(),
        &embed_model(),
        trimmed,
        Some(Duration::from_secs(30)),
    )
    .await
    .ok()?;
    if !(200..300).contains(&response.status) {
        return None;
    }
    let body = response.body;
    let arr = body
        .get("embeddings")
        .and_then(|e| e.get(0))
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| body.get("embedding").and_then(|v| v.as_array()).cloned())?;
    let vector: Vec<f32> = arr
        .iter()
        .filter_map(|x| x.as_f64().map(|f| f as f32))
        .collect();
    (!vector.is_empty()).then_some(vector)
}

#[derive(Debug, Clone, Serialize, Default)]
pub(crate) struct MemoryRecallTiming {
    pub(crate) lock_wait_ms: u64,
    pub(crate) profile_ms: u64,
    pub(crate) open_loops_ms: u64,
    pub(crate) fts_ms: u64,
    pub(crate) query_embedding_ms: Option<u64>,
    pub(crate) query_embedding_cache_hit: bool,
    pub(crate) query_embedding_timed_out: bool,
    pub(crate) vector_scan_ms: Option<u64>,
    pub(crate) graph_context_ms: u64,
    pub(crate) total_ms: u64,
    pub(crate) vector_candidates: usize,
    pub(crate) fts_candidates: usize,
    pub(crate) degraded: bool,
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
pub(crate) fn memory_recall_timing_trace_line(timing: &MemoryRecallTiming) -> String {
    format!(
        "memory recall: total_ms={} lock_wait_ms={} profile_ms={} open_loops_ms={} \
fts_ms={} query_embedding_ms={} query_embedding_cache_hit={} query_embedding_timed_out={} \
vector_scan_ms={} graph_context_ms={} \
fts_candidates={} vector_candidates={} degraded={}",
        timing.total_ms,
        timing.lock_wait_ms,
        timing.profile_ms,
        timing.open_loops_ms,
        timing.fts_ms,
        timing
            .query_embedding_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
        timing.query_embedding_cache_hit,
        timing.query_embedding_timed_out,
        timing
            .vector_scan_ms
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_string()),
        timing.graph_context_ms,
        timing.fts_candidates,
        timing.vector_candidates,
        timing.degraded
    )
}

#[derive(Debug, Clone)]
struct MemoryQueryEmbeddingCacheEntry {
    vector: Vec<f32>,
    inserted_at: Instant,
    last_access: u64,
}

#[derive(Debug, Default)]
pub(crate) struct MemoryQueryEmbeddingCache {
    entries: HashMap<String, MemoryQueryEmbeddingCacheEntry>,
    tick: u64,
}

impl MemoryQueryEmbeddingCache {
    pub(crate) fn get(&mut self, key: &str, ttl: Duration) -> Option<Vec<f32>> {
        let now = Instant::now();
        let expired = self
            .entries
            .get(key)
            .is_some_and(|entry| now.duration_since(entry.inserted_at) > ttl);
        if expired {
            self.entries.remove(key);
            return None;
        }
        let vector = self.entries.get(key).map(|entry| entry.vector.clone())?;
        self.tick = self.tick.saturating_add(1);
        if let Some(entry) = self.entries.get_mut(key) {
            entry.last_access = self.tick;
        }
        Some(vector)
    }

    pub(crate) fn insert(&mut self, key: String, vector: Vec<f32>, max_entries: usize) {
        if max_entries == 0 {
            return;
        }
        self.tick = self.tick.saturating_add(1);
        self.entries.insert(
            key,
            MemoryQueryEmbeddingCacheEntry {
                vector,
                inserted_at: Instant::now(),
                last_access: self.tick,
            },
        );
        while self.entries.len() > max_entries {
            let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest_key);
        }
    }
}

pub(crate) fn memory_query_embedding_cache() -> &'static Mutex<MemoryQueryEmbeddingCache> {
    static CACHE: OnceLock<Mutex<MemoryQueryEmbeddingCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(MemoryQueryEmbeddingCache::default()))
}

pub(crate) fn memory_query_embedding_cache_max_entries() -> usize {
    env::var("HOMUN_MEMORY_QUERY_EMBED_CACHE_MAX")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(512)
}

pub(crate) fn memory_query_embedding_cache_ttl() -> Duration {
    let seconds = env::var("HOMUN_MEMORY_QUERY_EMBED_CACHE_TTL_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(86_400);
    Duration::from_secs(seconds)
}

pub(crate) fn memory_query_embedding_timeout() -> Duration {
    let ms = env::var("HOMUN_MEMORY_QUERY_EMBED_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(700);
    Duration::from_millis(ms.max(1))
}

fn normalize_memory_embedding_query(query: &str) -> String {
    query
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(crate) fn memory_query_embedding_cache_key(
    query: &str,
    workspace: &MemoryWorkspaceId,
) -> String {
    format!(
        "{}|{}|{}|{}",
        embed_base(),
        embed_model(),
        workspace.as_str(),
        normalize_memory_embedding_query(query)
    )
}

pub(crate) async fn embed_query_for_memory_recall(
    http: &reqwest::Client,
    query: &str,
    workspace: &MemoryWorkspaceId,
    timing: &mut MemoryRecallTiming,
) -> Option<Vec<f32>> {
    let key = memory_query_embedding_cache_key(query, workspace);
    if let Ok(mut cache) = memory_query_embedding_cache().lock()
        && let Some(vector) = cache.get(&key, memory_query_embedding_cache_ttl())
    {
        timing.query_embedding_cache_hit = true;
        timing.query_embedding_ms = Some(0);
        return Some(vector);
    }

    let embedding_start = Instant::now();
    let mut usage = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::MemoryRecall,
        gateway_user_id().as_str(),
    );
    usage.purpose_detail = Some("query_embedding".to_string());
    usage.workspace_id = Some(workspace.as_str().to_string());
    let result = match tokio::time::timeout(
        memory_query_embedding_timeout(),
        embed_text(http, query, &usage),
    )
    .await
    {
        Ok(vector) => vector,
        Err(_) => {
            timing.query_embedding_timed_out = true;
            timing.query_embedding_ms = Some(elapsed_ms(embedding_start));
            return None;
        }
    };
    timing.query_embedding_ms = Some(elapsed_ms(embedding_start));
    if let Some(vector) = result.as_ref()
        && let Ok(mut cache) = memory_query_embedding_cache().lock()
    {
        cache.insert(
            key,
            vector.clone(),
            memory_query_embedding_cache_max_entries(),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_normalizes_workspace_query() {
        let workspace = MemoryWorkspaceId::new("personal");

        let first = memory_query_embedding_cache_key("  Codice   Fiscale ", &workspace);
        let second = memory_query_embedding_cache_key("codice fiscale", &workspace);
        let other_workspace =
            memory_query_embedding_cache_key("codice fiscale", &MemoryWorkspaceId::new("project"));

        assert_eq!(first, second);
        assert_ne!(second, other_workspace);
        assert!(second.ends_with("|personal|codice fiscale"));
    }

    #[test]
    fn cache_reuses_and_evicts_lru() {
        let mut cache = MemoryQueryEmbeddingCache::default();
        let ttl = Duration::from_secs(60);

        cache.insert("a".to_string(), vec![1.0], 2);
        cache.insert("b".to_string(), vec![2.0], 2);
        assert_eq!(cache.get("a", ttl), Some(vec![1.0]));

        cache.insert("c".to_string(), vec![3.0], 2);

        assert_eq!(cache.get("a", ttl), Some(vec![1.0]));
        assert_eq!(cache.get("b", ttl), None);
        assert_eq!(cache.get("c", ttl), Some(vec![3.0]));
    }

    #[test]
    fn cache_ttl_expires_entries() {
        let mut cache = MemoryQueryEmbeddingCache::default();

        cache.insert("a".to_string(), vec![1.0], 2);

        assert_eq!(cache.get("a", Duration::from_secs(0)), None);
    }
}
