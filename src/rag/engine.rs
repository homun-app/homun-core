use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context as _, Result};
use sha2::{Digest, Sha256};

use std::sync::Arc;

use crate::agent::embeddings::EmbeddingEngine;
use crate::storage::{RagChunkRow, RagSourceRow, RagStore};

use super::chunker::{chunk_file, detect_doc_type, is_supported, ChunkOptions};
use super::sensitive;

const CANDIDATES_PER_SOURCE: usize = 20;
const RRF_K: f64 = 60.0;

/// RAG search result with source attribution.
#[derive(Debug)]
pub struct RagSearchResult {
    pub chunk: RagChunkRow,
    pub score: f64,
    pub source_file: String,
}

/// RAG knowledge base stats.
#[derive(Debug, serde::Serialize)]
pub struct RagStats {
    pub source_count: i64,
    pub chunk_count: i64,
    pub index_vectors: usize,
}

/// Unified RAG engine — handles ingestion, search, and lifecycle.
pub struct RagEngine {
    store: Arc<dyn RagStore>,
    engine: EmbeddingEngine,
    chunk_opts: ChunkOptions,
}

impl RagEngine {
    /// Create from a concrete Database (backwards-compatible convenience).
    pub fn new(
        db: crate::storage::Database,
        engine: EmbeddingEngine,
        chunk_opts: ChunkOptions,
    ) -> Self {
        Self {
            store: Arc::new(db),
            engine,
            chunk_opts,
        }
    }

    /// Create from any RagStore implementation.
    pub fn from_store(
        store: Arc<dyn RagStore>,
        engine: EmbeddingEngine,
        chunk_opts: ChunkOptions,
    ) -> Self {
        Self {
            store,
            engine,
            chunk_opts,
        }
    }

    /// Ingest a single file. Returns source_id if successful, None if already indexed (dedup).
    ///
    /// `profile_id` and `user_id` scope the source and its chunks to a specific profile/user.
    /// Pass `None` for global (unscoped) ingestion.
    /// Maximum file size for RAG ingestion (100 MB).
    ///
    /// Files larger than this are rejected before reading into memory to
    /// prevent OOM on very large documents (#26). This limit applies to all
    /// ingest paths: API upload, directory watcher, and CLI ingest.
    pub const MAX_INGEST_BYTES: u64 = 100 * 1024 * 1024;

    pub async fn ingest_file(
        &mut self,
        path: &Path,
        source_channel: &str,
        profile_id: Option<i64>,
        user_id: Option<&str>,
        namespace: Option<&str>,
    ) -> Result<Option<i64>> {
        if !is_supported(path) {
            anyhow::bail!(
                "Unsupported file type: {}",
                path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("(none)")
            );
        }

        // Guard against OOM: check file size before reading into memory (#26).
        // Covers all 3 ingest paths (API upload, watcher, directory ingest)
        // with a single chokepoint.
        let file_size = std::fs::metadata(path)
            .with_context(|| format!("Cannot stat {}", path.display()))?
            .len();
        if file_size > Self::MAX_INGEST_BYTES {
            anyhow::bail!(
                "File too large for ingestion: {} MB (max {} MB). Path: {}",
                file_size / (1024 * 1024),
                Self::MAX_INGEST_BYTES / (1024 * 1024),
                path.display()
            );
        }

        let content =
            std::fs::read(path).with_context(|| format!("Cannot read {}", path.display()))?;

        let hash = hex_sha256(&content);

        // Dedup: skip if already indexed
        if let Some(existing) = self.store.find_rag_source_by_hash(&hash).await? {
            tracing::debug!(source_id = existing.id, "File already indexed, skipping");
            return Ok(None);
        }

        let file_name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let doc_type = detect_doc_type(path).to_string();

        let source_id = self
            .store
            .insert_rag_source(
                &path.to_string_lossy(),
                &file_name,
                &hash,
                &doc_type,
                content.len() as i64,
                Some(source_channel),
                profile_id,
                user_id,
                namespace,
            )
            .await?;

        match chunk_file(path, &self.chunk_opts) {
            Ok(chunks) if chunks.is_empty() => {
                self.store
                    .update_rag_source_status(source_id, "indexed", None, 0)
                    .await?;
                tracing::info!(source_id, file = %file_name, "File indexed (empty, 0 chunks)");
                Ok(Some(source_id))
            }
            Ok(chunks) => {
                let filename_sensitive = sensitive::is_sensitive_filename(&file_name);

                for chunk in &chunks {
                    // Prepend filename to heading so FTS5 can match by filename
                    let heading = if chunk.heading.is_empty() {
                        file_name.clone()
                    } else {
                        format!("{} — {}", file_name, chunk.heading)
                    };

                    let is_sensitive =
                        filename_sensitive || sensitive::is_sensitive(&chunk.content);

                    let chunk_id = self
                        .store
                        .insert_rag_chunk(
                            source_id,
                            chunk.index as i64,
                            &heading,
                            &chunk.content,
                            chunk.token_count as i64,
                            is_sensitive,
                            profile_id,
                            user_id,
                        )
                        .await?;

                    // Embed filename + content together for better vector search
                    let embed_text = format!("{}\n{}", file_name, chunk.content);
                    self.engine.index_chunk(chunk_id, &embed_text).await?;
                }

                // Persist the HNSW index so vectors survive restarts
                if let Err(e) = self.engine.save() {
                    tracing::warn!(error = %e, "Failed to save RAG HNSW index");
                }

                self.store
                    .update_rag_source_status(source_id, "indexed", None, chunks.len() as i64)
                    .await?;

                tracing::info!(
                    source_id,
                    file = %file_name,
                    chunks = chunks.len(),
                    "File indexed in RAG"
                );
                Ok(Some(source_id))
            }
            Err(e) => {
                self.store
                    .update_rag_source_status(source_id, "error", Some(&e.to_string()), 0)
                    .await?;
                Err(e)
            }
        }
    }

    /// Ingest all supported files from a directory.
    pub async fn ingest_directory(
        &mut self,
        dir: &Path,
        recursive: bool,
        source_channel: &str,
        profile_id: Option<i64>,
        user_id: Option<&str>,
        namespace: Option<&str>,
    ) -> Result<Vec<i64>> {
        let mut indexed = Vec::new();

        let entries: Vec<_> = if recursive {
            walkdir_entries(dir)?
        } else {
            std::fs::read_dir(dir)
                .with_context(|| format!("Cannot read directory {}", dir.display()))?
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .collect()
        };

        for path in entries {
            if !path.is_file() || !is_supported(&path) {
                continue;
            }
            match self
                .ingest_file(&path, source_channel, profile_id, user_id, namespace)
                .await
            {
                Ok(Some(id)) => indexed.push(id),
                Ok(None) => {} // already indexed
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "Failed to ingest file");
                }
            }
        }

        Ok(indexed)
    }

    /// Hybrid search: vector + FTS5 + RRF merge (no temporal decay).
    ///
    /// When `profile_id` is provided, results are filtered to include both
    /// profile-scoped chunks (matching the profile) and global chunks (profile_id IS NULL).
    ///
    /// When `allowed_namespaces` is provided (contact perimeter), results are filtered
    /// to only include chunks from sources whose namespace matches the allowed list.
    /// `None` means no namespace restriction (owner sees everything).
    pub async fn search(
        &mut self,
        query: &str,
        top_k: usize,
        profile_id: Option<i64>,
        user_id: Option<&str>,
        allowed_namespaces: Option<&[String]>,
    ) -> Result<Vec<RagSearchResult>> {
        let vector_results = self
            .engine
            .search(query, CANDIDATES_PER_SOURCE)
            .await
            .unwrap_or_default();

        let sanitized_query = sanitize_fts5_query(query);
        let fts_results = if sanitized_query.trim().is_empty() {
            Vec::new()
        } else {
            self.store
                .rag_fts5_search(&sanitized_query, CANDIDATES_PER_SOURCE)
                .await
                .unwrap_or_default()
        };

        let merged = rrf_merge(&vector_results, &fts_results, top_k);
        if merged.is_empty() {
            return Ok(Vec::new());
        }

        let chunk_ids: Vec<i64> = merged.iter().map(|&(id, _)| id).collect();
        let chunks = self.store.load_rag_chunks_by_ids(&chunk_ids).await?;

        let chunk_map: HashMap<i64, RagChunkRow> = chunks.into_iter().map(|c| (c.id, c)).collect();

        // Load source file names for attribution
        let source_ids: Vec<i64> = chunk_map
            .values()
            .map(|c| c.source_id)
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        let sources = self.store.list_rag_sources().await.unwrap_or_default();
        let source_map: HashMap<i64, String> = sources
            .iter()
            .filter(|s| source_ids.contains(&s.id))
            .map(|s| (s.id, s.file_name.clone()))
            .collect();
        // Namespace map for perimeter-based filtering
        let source_ns_map: HashMap<i64, String> = sources
            .iter()
            .filter(|s| source_ids.contains(&s.id))
            .map(|s| {
                (
                    s.id,
                    if s.namespace.is_empty() {
                        "_private".to_string()
                    } else {
                        s.namespace.clone()
                    },
                )
            })
            .collect();

        let results = merged
            .into_iter()
            .filter_map(|(id, score)| {
                chunk_map.get(&id).and_then(|chunk| {
                    // Profile scoping: include global chunks + profile-specific chunks
                    if let Some(pid) = profile_id {
                        if chunk.profile_id.is_some() && chunk.profile_id != Some(pid) {
                            return None; // belongs to a different profile
                        }
                    }
                    // User scoping: authenticated users only see their own chunks.
                    if let Some(uid) = user_id {
                        if chunk.user_id.as_deref() != Some(uid) {
                            return None;
                        }
                    }
                    // Namespace scoping: if allowed_namespaces is set (contact perimeter),
                    // only include chunks from sources with a matching namespace
                    if let Some(namespaces) = allowed_namespaces {
                        let source_ns = source_ns_map
                            .get(&chunk.source_id)
                            .map(|s| s.as_str())
                            .unwrap_or("_private");
                        if !namespaces.iter().any(|ns| ns == source_ns) {
                            return None; // source namespace not in allowed list
                        }
                    }
                    let mut chunk = chunk.clone();
                    // Redact sensitive chunk content
                    if chunk.sensitive {
                        chunk.content = format!(
                            "[REDACTED — auth required] {} ({} tokens)",
                            chunk.heading, chunk.token_count
                        );
                    }
                    Some(RagSearchResult {
                        source_file: source_map
                            .get(&chunk.source_id)
                            .cloned()
                            .unwrap_or_default(),
                        chunk,
                        score,
                    })
                })
            })
            .collect();

        Ok(results)
    }

    /// Re-ingest a file if its content has changed (for watcher use).
    /// Removes old source if hash changed, then ingests fresh.
    pub async fn reingest_file(
        &mut self,
        path: &Path,
        source_channel: &str,
        profile_id: Option<i64>,
        user_id: Option<&str>,
        namespace: Option<&str>,
    ) -> Result<Option<i64>> {
        // Same OOM guard as ingest_file (#26)
        let file_size = std::fs::metadata(path)
            .with_context(|| format!("Cannot stat {}", path.display()))?
            .len();
        if file_size > Self::MAX_INGEST_BYTES {
            anyhow::bail!(
                "File too large for re-ingestion: {} MB (max {} MB). Path: {}",
                file_size / (1024 * 1024),
                Self::MAX_INGEST_BYTES / (1024 * 1024),
                path.display()
            );
        }

        let content =
            std::fs::read(path).with_context(|| format!("Cannot read {}", path.display()))?;
        let new_hash = hex_sha256(&content);

        if let Some(existing) = self
            .store
            .find_rag_source_by_path(&path.to_string_lossy())
            .await?
        {
            if existing.file_hash == new_hash {
                return Ok(None); // unchanged
            }
            // Hash changed: remove old, re-ingest
            tracing::info!(path = %path.display(), "File modified, re-indexing");
            self.remove_source(existing.id).await?;
        }

        self.ingest_file(path, source_channel, profile_id, user_id, namespace)
            .await
    }

    /// Remove a source and its chunks.
    pub async fn remove_source(&mut self, source_id: i64) -> Result<bool> {
        self.store.delete_rag_source(source_id).await
    }

    /// Remove a source only if it belongs to the authenticated user.
    pub async fn remove_source_for_user(&mut self, source_id: i64, user_id: &str) -> Result<bool> {
        self.store
            .delete_rag_source_for_user(source_id, user_id)
            .await
    }

    /// List indexed sources, optionally filtered by profile.
    ///
    /// When `profile_id` is `Some`, returns sources belonging to that profile
    /// plus global (unscoped) sources. When `None`, returns all sources.
    pub async fn list_sources(&self, profile_id: Option<i64>) -> Result<Vec<RagSourceRow>> {
        if let Some(pid) = profile_id {
            self.store.list_rag_sources_for_profile(pid).await
        } else {
            self.store.list_rag_sources().await
        }
    }

    /// List indexed sources owned by a user.
    pub async fn list_sources_for_user(
        &self,
        user_id: &str,
        profile_id: Option<i64>,
    ) -> Result<Vec<RagSourceRow>> {
        self.store
            .list_rag_sources_for_user(user_id, profile_id)
            .await
    }

    /// Get knowledge base stats.
    pub async fn stats(&self) -> Result<RagStats> {
        Ok(RagStats {
            source_count: self.store.count_rag_sources().await.unwrap_or(0),
            chunk_count: self.store.count_rag_chunks().await.unwrap_or(0),
            index_vectors: self.engine.len(),
        })
    }

    /// Rebuild the HNSW index from all chunks in the database.
    pub async fn reindex_all(&mut self) -> Result<usize> {
        let sources = self.store.list_rag_sources().await?;
        let source_map: HashMap<i64, String> = sources
            .iter()
            .map(|s| (s.id, s.file_name.clone()))
            .collect();
        let mut total = 0;

        for source in &sources {
            if source.chunk_count == 0 {
                continue;
            }

            let chunks = self.store.load_rag_chunks_by_source(source.id).await?;
            for chunk in chunks {
                let file_name = source_map
                    .get(&chunk.source_id)
                    .cloned()
                    .unwrap_or_default();

                // Fix empty headings by prepending filename (for FTS5 matching)
                if chunk.heading.is_empty() && !file_name.is_empty() {
                    let _ = self
                        .store
                        .update_rag_chunk_heading(chunk.id, &file_name)
                        .await;
                }

                let embed_text = format!("{}\n{}", file_name, chunk.content);
                self.engine.index_chunk(chunk.id, &embed_text).await?;
                total += 1;
            }
        }

        self.engine.save()?;
        tracing::info!(vectors = total, "RAG index rebuilt");
        Ok(total)
    }

    /// Reindex if HNSW is empty but DB has chunks (e.g., after restart with missing index file).
    pub async fn reindex_if_needed(&mut self) -> Result<()> {
        let db_chunks = self.store.count_rag_chunks().await.unwrap_or(0);
        let index_vectors = self.engine.len();

        if db_chunks > 0 && index_vectors == 0 {
            tracing::info!(
                db_chunks,
                "HNSW index is empty but DB has chunks — rebuilding"
            );
            self.reindex_all().await?;
        }
        Ok(())
    }

    /// Persist the HNSW index to disk.
    pub fn save_index(&self) -> Result<()> {
        self.engine.save()
    }

    /// Replace the embedding engine's provider (for model change + reindex).
    pub fn reset_engine(
        &mut self,
        provider: Box<dyn crate::agent::embeddings::EmbeddingProvider>,
    ) -> Result<()> {
        self.engine.reset_with_provider(provider)
    }

    /// Reveal a sensitive chunk's full content (bypasses redaction).
    pub async fn reveal_chunk(&self, chunk_id: i64) -> Result<Option<RagChunkRow>> {
        let chunks = self.store.load_rag_chunks_by_ids(&[chunk_id]).await?;
        Ok(chunks.into_iter().next())
    }

    /// Reveal a chunk only if it belongs to the authenticated user.
    pub async fn reveal_chunk_for_user(
        &self,
        chunk_id: i64,
        user_id: &str,
    ) -> Result<Option<RagChunkRow>> {
        self.store.load_rag_chunk_for_user(chunk_id, user_id).await
    }
}

fn hex_sha256(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn sanitize_fts5_query(query: &str) -> String {
    let sanitized: String = query
        .chars()
        .filter(|c| {
            c.is_alphanumeric()
                || *c == ' '
                || *c == '-'
                || *c == '_'
                || *c == '.'
                || *c == ','
                || (*c >= '\u{00e0}' && *c <= '\u{00ff}')
                || (*c >= '\u{00c0}' && *c <= '\u{00df}')
        })
        .collect();

    if sanitized.trim().is_empty() {
        query
            .chars()
            .filter(|c| c.is_alphanumeric() || *c == ' ')
            .collect()
    } else {
        sanitized
    }
}

fn rrf_merge(
    vector_results: &[(i64, f32)],
    fts_results: &[(i64, f64)],
    top_k: usize,
) -> Vec<(i64, f64)> {
    let mut scores: HashMap<i64, f64> = HashMap::new();

    for (rank, &(id, _)) in vector_results.iter().enumerate() {
        *scores.entry(id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    for (rank, &(id, _)) in fts_results.iter().enumerate() {
        *scores.entry(id).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    let mut sorted: Vec<(i64, f64)> = scores.into_iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    sorted.truncate(top_k);
    sorted
}

/// Recursively collect file paths from a directory.
fn walkdir_entries(dir: &Path) -> Result<Vec<std::path::PathBuf>> {
    let mut paths = Vec::new();
    walk_recursive(dir, &mut paths)?;
    Ok(paths)
}

fn walk_recursive(dir: &Path, paths: &mut Vec<std::path::PathBuf>) -> Result<()> {
    let entries = std::fs::read_dir(dir)
        .with_context(|| format!("Cannot read directory {}", dir.display()))?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Skip hidden dirs
            if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with('.'))
                .unwrap_or(false)
            {
                continue;
            }
            walk_recursive(&path, paths)?;
        } else {
            paths.push(path);
        }
    }

    Ok(())
}

// ─── Tests ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::embeddings::{EmbeddingEngine, EmbeddingProvider};
    use crate::storage::Database;
    use async_trait::async_trait;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Deterministic mock embedding provider for testing.
    /// Returns hash-based vectors so identical texts produce identical embeddings.
    struct MockEmbeddingProvider {
        dims: usize,
    }

    #[async_trait]
    impl EmbeddingProvider for MockEmbeddingProvider {
        async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|text| {
                    // Hash-based deterministic vector
                    let hash = {
                        let mut hasher = Sha256::new();
                        hasher.update(text.as_bytes());
                        hasher.finalize()
                    };
                    (0..self.dims)
                        .map(|i| {
                            let byte = hash[i % hash.len()];
                            (byte as f32 / 255.0) * 2.0 - 1.0 // normalize to [-1, 1]
                        })
                        .collect()
                })
                .collect())
        }
        fn dimensions(&self) -> usize {
            self.dims
        }
        fn name(&self) -> &str {
            "mock"
        }
        fn model_name(&self) -> &str {
            "mock-embed-test"
        }
    }

    /// Create an isolated RAG engine with temp DB + temp index.
    async fn test_rag_engine() -> (RagEngine, TempDir) {
        let (rag, dir, _) = test_rag_engine_with_db().await;
        (rag, dir)
    }

    async fn test_rag_engine_with_db() -> (RagEngine, TempDir, Database) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Database::open(&db_path).await.unwrap();
        let db_handle = db.clone();

        let index_path = dir.path().join("rag_test.usearch");
        let provider = Box::new(MockEmbeddingProvider { dims: 32 });
        let engine = EmbeddingEngine::with_provider_and_path(provider, index_path).unwrap();

        let rag = RagEngine::new(db, engine, ChunkOptions::default());
        (rag, dir, db_handle)
    }

    /// Write a test markdown file and return its path.
    fn write_test_md(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    async fn insert_test_user(db: &Database, user_id: &str) {
        sqlx::query("INSERT OR IGNORE INTO users (id, username, roles) VALUES (?, ?, ?)")
            .bind(user_id)
            .bind(user_id)
            .bind(r#"["user"]"#)
            .execute(db.pool())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_ingest_markdown_file() {
        let (mut rag, dir) = test_rag_engine().await;

        let md = write_test_md(
            dir.path(),
            "test.md",
            "# Heading One\n\nSome content about Rust.\n\n# Heading Two\n\nMore about async.",
        );

        let result = rag
            .ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();
        assert!(result.is_some(), "Should return source_id");

        let sources = rag.list_sources(None).await.unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].file_name, "test.md");
        assert_eq!(sources[0].status, "indexed");
        assert!(sources[0].chunk_count > 0);
    }

    #[tokio::test]
    async fn test_dedup_same_file() {
        let (mut rag, dir) = test_rag_engine().await;

        let md = write_test_md(dir.path(), "dedup.md", "# Test\n\nContent.");

        let first = rag
            .ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();
        assert!(first.is_some());

        let second = rag
            .ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();
        assert!(second.is_none(), "Same file should be deduplicated");

        let sources = rag.list_sources(None).await.unwrap();
        assert_eq!(sources.len(), 1, "Should still have exactly one source");
    }

    #[tokio::test]
    async fn test_search_returns_results() {
        let (mut rag, dir) = test_rag_engine().await;

        let md = write_test_md(
            dir.path(),
            "searchable.md",
            "# Machine Learning\n\nNeural networks use gradient descent for optimization.\n\n\
             # Databases\n\nSQLite is a lightweight embedded database engine.",
        );

        rag.ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();

        let results = rag
            .search("neural networks", 5, None, None, None)
            .await
            .unwrap();
        assert!(!results.is_empty(), "Search should return results");
        assert!(results[0].score > 0.0, "Score should be positive");
        assert_eq!(results[0].source_file, "searchable.md");
    }

    #[tokio::test]
    async fn test_search_filters_by_user() {
        let (mut rag, dir, db) = test_rag_engine_with_db().await;
        insert_test_user(&db, "alice").await;
        insert_test_user(&db, "bob").await;

        let alice_md = write_test_md(
            dir.path(),
            "alice-tax.md",
            "# Alice\n\nAlice fiscal code is ALICE123.",
        );
        let bob_md = write_test_md(
            dir.path(),
            "bob-tax.md",
            "# Bob\n\nBob fiscal code is BOB456.",
        );

        rag.ingest_file(&alice_md, "test", None, Some("alice"), None)
            .await
            .unwrap();
        rag.ingest_file(&bob_md, "test", None, Some("bob"), None)
            .await
            .unwrap();

        let alice_results = rag
            .search("fiscal code", 10, None, Some("alice"), None)
            .await
            .unwrap();
        assert!(
            alice_results
                .iter()
                .any(|r| r.chunk.content.contains("ALICE123")),
            "Alice should see Alice content"
        );
        assert!(
            !alice_results
                .iter()
                .any(|r| r.chunk.content.contains("BOB456")),
            "Alice must not see Bob content"
        );
    }

    #[tokio::test]
    async fn test_list_sources_filters_by_user() {
        let (mut rag, dir, db) = test_rag_engine_with_db().await;
        insert_test_user(&db, "alice").await;
        insert_test_user(&db, "bob").await;

        let alice_md = write_test_md(dir.path(), "alice-source.md", "# Alice\n\nContent.");
        let bob_md = write_test_md(dir.path(), "bob-source.md", "# Bob\n\nContent.");

        rag.ingest_file(&alice_md, "test", None, Some("alice"), None)
            .await
            .unwrap();
        rag.ingest_file(&bob_md, "test", None, Some("bob"), None)
            .await
            .unwrap();

        let alice_sources = rag.list_sources_for_user("alice", None).await.unwrap();
        assert_eq!(alice_sources.len(), 1);
        assert_eq!(alice_sources[0].file_name, "alice-source.md");
    }

    #[tokio::test]
    async fn test_sensitive_chunk_redacted() {
        let (mut rag, dir) = test_rag_engine().await;

        // Content with an API key pattern — should be flagged sensitive
        let md = write_test_md(
            dir.path(),
            "secrets.md",
            "# Config\n\napi_key: sk-abc123456789012345678901234567890123456789\n\nDon't share this.",
        );

        rag.ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();

        let results = rag
            .search("api key config", 5, None, None, None)
            .await
            .unwrap();
        // Find the sensitive chunk — it should be redacted
        let has_redacted = results
            .iter()
            .any(|r| r.chunk.content.contains("[REDACTED"));
        assert!(
            has_redacted,
            "Sensitive chunk should be redacted in search results"
        );
    }

    #[tokio::test]
    async fn test_remove_source() {
        let (mut rag, dir) = test_rag_engine().await;

        let md = write_test_md(
            dir.path(),
            "removable.md",
            "# Remove\n\nThis will be removed.",
        );

        let source_id = rag
            .ingest_file(&md, "test", None, None, None)
            .await
            .unwrap()
            .unwrap();

        let removed = rag.remove_source(source_id).await.unwrap();
        assert!(removed, "Should return true for existing source");

        let sources = rag.list_sources(None).await.unwrap();
        assert!(sources.is_empty(), "Sources should be empty after removal");
    }

    #[tokio::test]
    async fn test_stats() {
        let (mut rag, dir) = test_rag_engine().await;

        let stats_before = rag.stats().await.unwrap();
        assert_eq!(stats_before.source_count, 0);
        assert_eq!(stats_before.chunk_count, 0);

        let md = write_test_md(
            dir.path(),
            "stats.md",
            "# Section A\n\nContent A.\n\n# Section B\n\nContent B.",
        );
        rag.ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();

        let stats_after = rag.stats().await.unwrap();
        assert_eq!(stats_after.source_count, 1);
        assert!(stats_after.chunk_count > 0);
    }

    #[tokio::test]
    async fn test_reindex_all() {
        let (mut rag, dir) = test_rag_engine().await;

        let md = write_test_md(
            dir.path(),
            "reindex.md",
            "# Topic A\n\nInformation about topic A.\n\n# Topic B\n\nDetails on topic B.",
        );
        rag.ingest_file(&md, "test", None, None, None)
            .await
            .unwrap();

        let stats = rag.stats().await.unwrap();
        let chunk_count_before = stats.chunk_count;

        // Simulate index loss (e.g. file deleted after restart) by
        // creating a fresh engine with empty HNSW, then reindexing.
        let provider = Box::new(MockEmbeddingProvider { dims: 32 });
        rag.reset_engine(provider).unwrap();

        let stats_after_reset = rag.stats().await.unwrap();
        assert_eq!(
            stats_after_reset.index_vectors, 0,
            "Index should be empty after reset"
        );

        let reindexed = rag.reindex_all().await.unwrap();
        assert_eq!(
            reindexed as i64, chunk_count_before,
            "Reindex should process all chunks"
        );
        assert!(
            rag.stats().await.unwrap().index_vectors > 0,
            "Index should have vectors after reindex"
        );
    }
}
