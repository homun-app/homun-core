//! Database operations for the RAG knowledge base.
//!
//! Extension `impl Database` following the pattern in `contacts/db.rs`.
//! Handles source and chunk CRUD + FTS5 search.

use anyhow::{Context, Result};

use crate::storage::{Database, RagChunkRow, RagSourceRow};

/// A monitored folder configuration for automatic RAG ingestion.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, sqlx::FromRow)]
pub struct KnowledgeWatch {
    pub id: i64,
    pub path: String,
    pub recursive: i64,
    pub enabled: i64,
    pub profile_id: Option<i64>,
    pub namespace: String,
    /// JSON array of contact IDs that can see ingested content.
    pub contact_ids: String,
    pub created_at: String,
    pub updated_at: String,
}

impl KnowledgeWatch {
    /// Parse contact_ids JSON into a Vec<i64>.
    pub fn contacts(&self) -> Vec<i64> {
        serde_json::from_str(&self.contact_ids).unwrap_or_default()
    }

    /// Whether this watch is recursive.
    pub fn is_recursive(&self) -> bool {
        self.recursive != 0
    }

    /// Whether this watch is enabled.
    pub fn is_enabled(&self) -> bool {
        self.enabled != 0
    }
}

impl Database {
    // ─── RAG Knowledge Base ──────────────────────────────────────

    /// Insert a new document source. Returns the source ID.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_rag_source(
        &self,
        file_path: &str,
        file_name: &str,
        file_hash: &str,
        doc_type: &str,
        file_size: i64,
        source_channel: Option<&str>,
        profile_id: Option<i64>,
        user_id: Option<&str>,
        namespace: Option<&str>,
    ) -> Result<i64> {
        let ns = namespace.unwrap_or("_private");
        let result = sqlx::query(
            "INSERT INTO rag_sources (file_path, file_name, file_hash, doc_type, file_size, source_channel, profile_id, user_id, namespace)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(file_path)
        .bind(file_name)
        .bind(file_hash)
        .bind(doc_type)
        .bind(file_size)
        .bind(source_channel)
        .bind(profile_id)
        .bind(user_id)
        .bind(ns)
        .execute(self.pool())
        .await
        .context("Failed to insert RAG source")?;

        Ok(result.last_insert_rowid())
    }

    /// Update the namespace of an existing source.
    pub async fn update_rag_source_namespace(&self, id: i64, namespace: &str) -> Result<()> {
        sqlx::query("UPDATE rag_sources SET namespace = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(namespace)
            .bind(id)
            .execute(self.pool())
            .await
            .context("Failed to update RAG source namespace")?;
        Ok(())
    }

    /// Find a source by its content hash (deduplication).
    pub async fn find_rag_source_by_hash(&self, file_hash: &str) -> Result<Option<RagSourceRow>> {
        let row = sqlx::query_as::<_, RagSourceRow>(
            "SELECT id, file_path, file_name, file_hash, doc_type, file_size,
                    chunk_count, status, error_message, source_channel, created_at, updated_at, profile_id
             FROM rag_sources WHERE file_hash = ?",
        )
        .bind(file_hash)
        .fetch_optional(self.pool())
        .await
        .context("Failed to find RAG source by hash")?;

        Ok(row)
    }

    /// Find a source by its file path.
    pub async fn find_rag_source_by_path(&self, file_path: &str) -> Result<Option<RagSourceRow>> {
        let row = sqlx::query_as::<_, RagSourceRow>(
            "SELECT id, file_path, file_name, file_hash, doc_type, file_size,
                    chunk_count, status, error_message, source_channel, created_at, updated_at, profile_id
             FROM rag_sources WHERE file_path = ?",
        )
        .bind(file_path)
        .fetch_optional(self.pool())
        .await
        .context("Failed to find RAG source by path")?;

        Ok(row)
    }

    /// Update source processing status and chunk count.
    pub async fn update_rag_source_status(
        &self,
        id: i64,
        status: &str,
        error_message: Option<&str>,
        chunk_count: i64,
    ) -> Result<()> {
        sqlx::query(
            "UPDATE rag_sources SET status = ?, error_message = ?, chunk_count = ?,
                    updated_at = datetime('now') WHERE id = ?",
        )
        .bind(status)
        .bind(error_message)
        .bind(chunk_count)
        .bind(id)
        .execute(self.pool())
        .await
        .context("Failed to update RAG source status")?;

        Ok(())
    }

    /// Delete a source and its chunks. Returns true if deleted.
    pub async fn delete_rag_source(&self, id: i64) -> Result<bool> {
        let result = sqlx::query("DELETE FROM rag_sources WHERE id = ?")
            .bind(id)
            .execute(self.pool())
            .await
            .context("Failed to delete RAG source")?;

        Ok(result.rows_affected() > 0)
    }

    /// List all document sources.
    pub async fn list_rag_sources(&self) -> Result<Vec<RagSourceRow>> {
        let rows = sqlx::query_as::<_, RagSourceRow>(
            "SELECT id, file_path, file_name, file_hash, doc_type, file_size,
                    chunk_count, status, error_message, source_channel, created_at, updated_at, profile_id
             FROM rag_sources ORDER BY created_at DESC",
        )
        .fetch_all(self.pool())
        .await
        .context("Failed to list RAG sources")?;

        Ok(rows)
    }

    /// List document sources filtered by profile.
    ///
    /// Returns sources matching the given profile plus global sources (profile_id IS NULL).
    pub async fn list_rag_sources_for_profile(
        &self,
        profile_id: i64,
    ) -> Result<Vec<RagSourceRow>> {
        let rows = sqlx::query_as::<_, RagSourceRow>(
            "SELECT id, file_path, file_name, file_hash, doc_type, file_size,
                    chunk_count, status, error_message, source_channel, created_at, updated_at, profile_id
             FROM rag_sources
             WHERE profile_id = ? OR profile_id IS NULL
             ORDER BY created_at DESC",
        )
        .bind(profile_id)
        .fetch_all(self.pool())
        .await
        .context("Failed to list RAG sources for profile")?;

        Ok(rows)
    }

    /// Insert a document chunk. Returns the chunk ID.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_rag_chunk(
        &self,
        source_id: i64,
        chunk_index: i64,
        heading: &str,
        content: &str,
        token_count: i64,
        sensitive: bool,
        profile_id: Option<i64>,
        user_id: Option<&str>,
    ) -> Result<i64> {
        let result = sqlx::query(
            "INSERT INTO rag_chunks (source_id, chunk_index, heading, content, token_count, sensitive, profile_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(source_id)
        .bind(chunk_index)
        .bind(heading)
        .bind(content)
        .bind(token_count)
        .bind(sensitive)
        .bind(profile_id)
        .bind(user_id)
        .execute(self.pool())
        .await
        .context("Failed to insert RAG chunk")?;

        Ok(result.last_insert_rowid())
    }

    /// Update a chunk's heading (after LLM enrichment).
    pub async fn update_rag_chunk_heading(&self, chunk_id: i64, heading: &str) -> Result<()> {
        sqlx::query("UPDATE rag_chunks SET heading = ? WHERE id = ?")
            .bind(heading)
            .bind(chunk_id)
            .execute(self.pool())
            .await
            .context("Failed to update RAG chunk heading")?;
        Ok(())
    }

    /// Load chunks by their IDs (for vector search result hydration).
    pub async fn load_rag_chunks_by_ids(&self, ids: &[i64]) -> Result<Vec<RagChunkRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders: Vec<String> = ids.iter().map(|_| "?".to_string()).collect();
        let query = format!(
            "SELECT id, source_id, chunk_index, heading, content, token_count, sensitive, created_at, profile_id
             FROM rag_chunks WHERE id IN ({})
             ORDER BY created_at DESC",
            placeholders.join(",")
        );

        let mut q = sqlx::query_as::<_, RagChunkRow>(&query);
        for id in ids {
            q = q.bind(id);
        }

        let rows = q
            .fetch_all(self.pool())
            .await
            .context("Failed to load RAG chunks by IDs")?;

        Ok(rows)
    }

    /// Full-text search on RAG chunks. Returns (chunk_id, bm25_score).
    pub async fn rag_fts5_search(&self, query: &str, limit: usize) -> Result<Vec<(i64, f64)>> {
        let rows: Vec<(i64, f64)> = sqlx::query_as(
            "SELECT rowid, rank
             FROM rag_fts
             WHERE rag_fts MATCH ?
             ORDER BY rank
             LIMIT ?",
        )
        .bind(query)
        .bind(limit as i64)
        .fetch_all(self.pool())
        .await
        .context("RAG FTS5 search failed")?;

        Ok(rows)
    }

    /// Count total RAG chunks.
    pub async fn count_rag_chunks(&self) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rag_chunks")
            .fetch_one(self.pool())
            .await
            .context("Failed to count RAG chunks")?;
        Ok(count)
    }

    /// Count total document sources.
    pub async fn count_rag_sources(&self) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM rag_sources")
            .fetch_one(self.pool())
            .await
            .context("Failed to count RAG sources")?;
        Ok(count)
    }

    /// Load all chunks for a specific source.
    pub async fn load_rag_chunks_by_source(&self, source_id: i64) -> Result<Vec<RagChunkRow>> {
        let rows = sqlx::query_as::<_, RagChunkRow>(
            "SELECT id, source_id, chunk_index, heading, content, token_count, sensitive, created_at, profile_id
             FROM rag_chunks WHERE source_id = ? ORDER BY chunk_index",
        )
        .bind(source_id)
        .fetch_all(self.pool())
        .await
        .context("Failed to load RAG chunks by source")?;

        Ok(rows)
    }

    /// Delete all chunks for a source. Returns count deleted.
    pub async fn delete_rag_chunks_by_source(&self, source_id: i64) -> Result<u64> {
        let result = sqlx::query("DELETE FROM rag_chunks WHERE source_id = ?")
            .bind(source_id)
            .execute(self.pool())
            .await
            .context("Failed to delete RAG chunks by source")?;

        Ok(result.rows_affected())
    }

    // ─── Knowledge Watches (Monitored Folders) ────────────────────

    /// Insert a new knowledge watch. Returns the watch ID.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_knowledge_watch(
        &self,
        path: &str,
        recursive: bool,
        profile_id: Option<i64>,
        namespace: &str,
        contact_ids: &str,
    ) -> Result<i64> {
        let result = sqlx::query(
            "INSERT INTO knowledge_watches (path, recursive, profile_id, namespace, contact_ids)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(path)
        .bind(recursive as i64)
        .bind(profile_id)
        .bind(namespace)
        .bind(contact_ids)
        .execute(self.pool())
        .await
        .context("Failed to insert knowledge watch")?;

        Ok(result.last_insert_rowid())
    }

    /// Load a knowledge watch by ID.
    pub async fn load_knowledge_watch(&self, id: i64) -> Result<Option<KnowledgeWatch>> {
        let row = sqlx::query_as::<_, KnowledgeWatch>(
            "SELECT id, path, recursive, enabled, profile_id, namespace, contact_ids, created_at, updated_at
             FROM knowledge_watches WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(self.pool())
        .await
        .context("Failed to load knowledge watch")?;

        Ok(row)
    }

    /// List all knowledge watches.
    pub async fn list_knowledge_watches(&self) -> Result<Vec<KnowledgeWatch>> {
        let rows = sqlx::query_as::<_, KnowledgeWatch>(
            "SELECT id, path, recursive, enabled, profile_id, namespace, contact_ids, created_at, updated_at
             FROM knowledge_watches ORDER BY created_at DESC",
        )
        .fetch_all(self.pool())
        .await
        .context("Failed to list knowledge watches")?;

        Ok(rows)
    }

    /// List only enabled knowledge watches (for the watcher at startup).
    pub async fn list_enabled_knowledge_watches(&self) -> Result<Vec<KnowledgeWatch>> {
        let rows = sqlx::query_as::<_, KnowledgeWatch>(
            "SELECT id, path, recursive, enabled, profile_id, namespace, contact_ids, created_at, updated_at
             FROM knowledge_watches WHERE enabled = 1 ORDER BY id",
        )
        .fetch_all(self.pool())
        .await
        .context("Failed to list enabled knowledge watches")?;

        Ok(rows)
    }

    /// Update a knowledge watch. Returns true if the row was found.
    #[allow(clippy::too_many_arguments)]
    pub async fn update_knowledge_watch(
        &self,
        id: i64,
        path: &str,
        recursive: bool,
        enabled: bool,
        profile_id: Option<i64>,
        namespace: &str,
        contact_ids: &str,
    ) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE knowledge_watches SET path = ?, recursive = ?, enabled = ?,
                    profile_id = ?, namespace = ?, contact_ids = ?,
                    updated_at = datetime('now')
             WHERE id = ?",
        )
        .bind(path)
        .bind(recursive as i64)
        .bind(enabled as i64)
        .bind(profile_id)
        .bind(namespace)
        .bind(contact_ids)
        .bind(id)
        .execute(self.pool())
        .await
        .context("Failed to update knowledge watch")?;

        Ok(result.rows_affected() > 0)
    }

    /// Delete a knowledge watch. Returns true if deleted.
    pub async fn delete_knowledge_watch(&self, id: i64) -> Result<bool> {
        let result = sqlx::query("DELETE FROM knowledge_watches WHERE id = ?")
            .bind(id)
            .execute(self.pool())
            .await
            .context("Failed to delete knowledge watch")?;

        Ok(result.rows_affected() > 0)
    }

    /// Count sources whose file_path starts with a given prefix.
    ///
    /// Used to show how many documents were ingested from a monitored folder.
    pub async fn count_sources_by_path_prefix(&self, prefix: &str) -> Result<i64> {
        let pattern = format!("{prefix}%");
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM rag_sources WHERE file_path LIKE ?")
                .bind(&pattern)
                .fetch_one(self.pool())
                .await
                .context("Failed to count sources by path prefix")?;
        Ok(count)
    }
}
