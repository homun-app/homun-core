//! Query embedding cache for memory recall.
//!
//! This owner keeps the deterministic cache behavior for recall embeddings out
//! of the gateway root: normalized cache keys, LRU eviction, TTL, and timeout
//! knobs. The HTTP embedding call remains in `main.rs` until provider routing
//! and usage recording have their own owner.

use std::collections::HashMap;
use std::env;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use local_first_memory::WorkspaceId as MemoryWorkspaceId;

use crate::{embed_base, embed_model};

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
