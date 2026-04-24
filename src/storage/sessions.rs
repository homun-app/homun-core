use anyhow::{Context, Result};

use super::db::{Database, MessageRow, SessionListRow, SessionRow};

impl Database {
    /// Create or update a session record
    pub async fn upsert_session(&self, key: &str, last_consolidated: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO sessions (key, last_consolidated)
             VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET
                updated_at = datetime('now'),
                last_consolidated = excluded.last_consolidated",
        )
        .bind(key)
        .bind(last_consolidated)
        .execute(self.pool())
        .await
        .context("Failed to upsert session")?;

        Ok(())
    }

    /// Update the JSON metadata blob for a session.
    pub async fn set_session_metadata(&self, key: &str, metadata: &str) -> Result<()> {
        sqlx::query(
            "UPDATE sessions
             SET metadata = ?, updated_at = datetime('now')
             WHERE key = ?",
        )
        .bind(metadata)
        .bind(key)
        .execute(self.pool())
        .await
        .context("Failed to update session metadata")?;

        Ok(())
    }

    /// Get the profile_id for a session (returns None if unset).
    pub async fn get_session_profile_id(&self, key: &str) -> Option<i64> {
        sqlx::query_scalar::<_, Option<i64>>("SELECT profile_id FROM sessions WHERE key = ?")
            .bind(key)
            .fetch_optional(self.pool())
            .await
            .ok()
            .flatten()
            .flatten()
    }

    /// Set the profile_id for a session.
    pub async fn set_session_profile_id(&self, key: &str, profile_id: i64) -> Result<()> {
        sqlx::query(
            "UPDATE sessions SET profile_id = ?, updated_at = datetime('now') WHERE key = ?",
        )
        .bind(profile_id)
        .bind(key)
        .execute(self.pool())
        .await
        .context("Failed to set session profile_id")?;
        Ok(())
    }

    /// Delete a session and all related rows via cascade.
    pub async fn delete_session(&self, key: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM sessions WHERE key = ?")
            .bind(key)
            .execute(self.pool())
            .await
            .context("Failed to delete session")?;

        Ok(result.rows_affected() > 0)
    }

    /// Load session metadata
    pub async fn load_session(&self, key: &str) -> Result<Option<SessionRow>> {
        let row = sqlx::query_as::<_, SessionRow>(
            "SELECT key, created_at, updated_at, last_consolidated, metadata
             FROM sessions WHERE key = ?",
        )
        .bind(key)
        .fetch_optional(self.pool())
        .await
        .context("Failed to load session")?;

        Ok(row)
    }

    /// Persist or update a web chat run snapshot for restart-safe restore.
    pub async fn upsert_web_chat_run(
        &self,
        run: &crate::web::run_state::WebChatRunSnapshot,
    ) -> Result<()> {
        let events_json = serde_json::to_string(&run.events)
            .context("Failed to serialize web chat run events")?;

        sqlx::query(
            "INSERT INTO web_chat_runs (
                run_id, session_key, status, user_message, assistant_response,
                effective_model, events_json, error, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(run_id) DO UPDATE SET
                status = excluded.status,
                user_message = excluded.user_message,
                assistant_response = excluded.assistant_response,
                effective_model = excluded.effective_model,
                events_json = excluded.events_json,
                error = excluded.error,
                updated_at = excluded.updated_at",
        )
        .bind(&run.run_id)
        .bind(&run.session_key)
        .bind(&run.status)
        .bind(&run.user_message)
        .bind(&run.assistant_response)
        .bind(run.effective_model.as_deref())
        .bind(events_json)
        .bind(run.error.as_deref())
        .bind(&run.created_at)
        .bind(&run.updated_at)
        .execute(self.pool())
        .await
        .context("Failed to upsert web chat run")?;

        Ok(())
    }

    /// Load the latest web chat run eligible for UI rehydration.
    pub async fn load_restorable_web_chat_run(
        &self,
        session_key: &str,
    ) -> Result<Option<crate::web::run_state::WebChatRunSnapshot>> {
        let row = sqlx::query_as::<_, WebChatRunRow>(
            "SELECT
                run_id, session_key, status, user_message, assistant_response,
                effective_model, events_json, error, created_at, updated_at
             FROM web_chat_runs
             WHERE session_key = ?
               AND status IN ('running', 'stopping', 'failed')
             ORDER BY updated_at DESC
             LIMIT 1",
        )
        .bind(session_key)
        .fetch_optional(self.pool())
        .await
        .context("Failed to load restorable web chat run")?;

        row.map(TryInto::try_into).transpose()
    }

    /// Delete persisted web chat runs for a session.
    pub async fn delete_web_chat_runs(&self, session_key: &str) -> Result<u64> {
        let result = sqlx::query("DELETE FROM web_chat_runs WHERE session_key = ?")
            .bind(session_key)
            .execute(self.pool())
            .await
            .context("Failed to delete web chat runs")?;

        Ok(result.rows_affected())
    }

    /// Mark runs left open by a previous process as interrupted.
    pub async fn mark_incomplete_web_chat_runs_interrupted(&self) -> Result<u64> {
        let result = sqlx::query(
            "UPDATE web_chat_runs
             SET status = 'interrupted',
                 error = COALESCE(error, 'Run interrupted after process restart'),
                 updated_at = datetime('now')
             WHERE status IN ('running', 'stopping')",
        )
        .execute(self.pool())
        .await
        .context("Failed to interrupt stale web chat runs")?;

        Ok(result.rows_affected())
    }

    /// Append a message to a session
    pub async fn insert_message(
        &self,
        session_key: &str,
        role: &str,
        content: &str,
        tools_used: &[String],
    ) -> Result<()> {
        let tools_json = serde_json::to_string(tools_used).unwrap_or_else(|_| "[]".to_string());

        sqlx::query(
            "INSERT INTO messages (session_key, role, content, tools_used)
             VALUES (?, ?, ?, ?)",
        )
        .bind(session_key)
        .bind(role)
        .bind(content)
        .bind(tools_json)
        .execute(self.pool())
        .await
        .context("Failed to insert message")?;

        sqlx::query("UPDATE sessions SET updated_at = datetime('now') WHERE key = ?")
            .bind(session_key)
            .execute(self.pool())
            .await
            .context("Failed to touch session after message insert")?;

        Ok(())
    }

    /// Load the last N messages for a session, ordered oldest-first
    pub async fn load_messages(&self, session_key: &str, limit: u32) -> Result<Vec<MessageRow>> {
        let rows = sqlx::query_as::<_, MessageRow>(
            "SELECT id, session_key, role, content, tools_used, timestamp
             FROM (
                 SELECT * FROM messages
                 WHERE session_key = ?
                 ORDER BY id DESC
                 LIMIT ?
             ) sub
             ORDER BY id ASC",
        )
        .bind(session_key)
        .bind(limit)
        .fetch_all(self.pool())
        .await
        .context("Failed to load messages")?;

        Ok(rows)
    }

    /// Delete messages from a given ID onwards (for edit/resend truncation).
    pub async fn delete_messages_from(&self, session_key: &str, from_id: i64) -> Result<u64> {
        let result = sqlx::query("DELETE FROM messages WHERE session_key = ? AND id >= ?")
            .bind(session_key)
            .bind(from_id)
            .execute(self.pool())
            .await
            .context("Failed to truncate messages")?;
        Ok(result.rows_affected())
    }

    /// Count messages in a session
    pub async fn count_messages(&self, session_key: &str) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE session_key = ?")
            .bind(session_key)
            .fetch_one(self.pool())
            .await
            .context("Failed to count messages")?;

        Ok(count)
    }

    /// Count distinct sessions (by session_key in messages table).
    pub async fn count_sessions(&self) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(DISTINCT session_key) FROM messages")
            .fetch_one(self.pool())
            .await
            .context("Failed to count sessions")?;
        Ok(count)
    }

    /// Count all messages across all sessions.
    pub async fn count_all_messages(&self) -> Result<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages")
            .fetch_one(self.pool())
            .await
            .context("Failed to count all messages")?;
        Ok(count)
    }

    /// Delete all messages for a session (for /new command)
    pub async fn clear_messages(&self, session_key: &str) -> Result<()> {
        sqlx::query("DELETE FROM messages WHERE session_key = ?")
            .bind(session_key)
            .execute(self.pool())
            .await
            .context("Failed to clear messages")?;

        sqlx::query(
            "UPDATE sessions SET last_consolidated = 0, updated_at = datetime('now')
             WHERE key = ?",
        )
        .bind(session_key)
        .execute(self.pool())
        .await
        .context("Failed to reset session")?;

        Ok(())
    }

    /// List sessions by key prefix with lightweight message statistics.
    pub async fn list_sessions_by_prefix(
        &self,
        prefix_like: &str,
        limit: u32,
    ) -> Result<Vec<SessionListRow>> {
        let rows = sqlx::query_as::<_, SessionListRow>(
            "SELECT
                s.key,
                s.created_at,
                s.updated_at,
                s.metadata,
                (
                    SELECT COUNT(*)
                    FROM messages m
                    WHERE m.session_key = s.key
                      AND m.role IN ('user', 'assistant')
                ) AS message_count,
                (
                    SELECT m.content
                    FROM messages m
                    WHERE m.session_key = s.key
                      AND m.role = 'user'
                    ORDER BY m.id ASC
                    LIMIT 1
                ) AS first_user_message,
                (
                    SELECT m.content
                    FROM messages m
                    WHERE m.session_key = s.key
                      AND m.role IN ('user', 'assistant')
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS last_message_preview,
                (
                    SELECT m.timestamp
                    FROM messages m
                    WHERE m.session_key = s.key
                      AND m.role IN ('user', 'assistant')
                    ORDER BY m.id DESC
                    LIMIT 1
                ) AS last_message_at
             FROM sessions s
             WHERE s.key LIKE ?
               AND s.key NOT LIKE '%:orch:%'
             ORDER BY COALESCE(
                 (
                     SELECT m.timestamp
                     FROM messages m
                     WHERE m.session_key = s.key
                       AND m.role IN ('user', 'assistant')
                     ORDER BY m.id DESC
                     LIMIT 1
                 ),
                 s.updated_at
             ) DESC
             LIMIT ?",
        )
        .bind(prefix_like)
        .bind(limit)
        .fetch_all(self.pool())
        .await
        .context("Failed to list sessions by prefix")?;

        Ok(rows)
    }

    /// Load the oldest messages that would be pruned during compaction
    /// (all except the newest `keep_count`).
    pub async fn load_old_messages(
        &self,
        session_key: &str,
        keep_count: u32,
    ) -> Result<Vec<MessageRow>> {
        sqlx::query_as::<_, MessageRow>(
            "SELECT id, session_key, role, content, tools_used, timestamp
             FROM messages
             WHERE session_key = ? AND id NOT IN (
                 SELECT id FROM messages WHERE session_key = ?
                 ORDER BY id DESC LIMIT ?
             )
             ORDER BY id ASC",
        )
        .bind(session_key)
        .bind(session_key)
        .bind(keep_count)
        .fetch_all(self.pool())
        .await
        .context("Failed to load old messages")
    }

    /// Delete old messages, keeping only the newest `keep_count`.
    /// Returns the number of messages deleted.
    pub async fn delete_old_messages(&self, session_key: &str, keep_count: u32) -> Result<u64> {
        let result = sqlx::query(
            "DELETE FROM messages WHERE session_key = ? AND id NOT IN (
                SELECT id FROM messages WHERE session_key = ?
                ORDER BY id DESC LIMIT ?
            )",
        )
        .bind(session_key)
        .bind(session_key)
        .bind(keep_count)
        .execute(self.pool())
        .await
        .context("Failed to delete old messages")?;

        Ok(result.rows_affected())
    }
}

#[derive(Debug, sqlx::FromRow)]
struct WebChatRunRow {
    run_id: String,
    session_key: String,
    status: String,
    user_message: String,
    assistant_response: String,
    effective_model: Option<String>,
    events_json: String,
    error: Option<String>,
    created_at: String,
    updated_at: String,
}

impl TryFrom<WebChatRunRow> for crate::web::run_state::WebChatRunSnapshot {
    type Error = anyhow::Error;

    fn try_from(row: WebChatRunRow) -> Result<Self, Self::Error> {
        let events = serde_json::from_str(&row.events_json)
            .context("Failed to deserialize web chat run events")?;
        Ok(Self {
            run_id: row.run_id,
            session_key: row.session_key,
            status: row.status,
            user_message: row.user_message,
            effective_model: row.effective_model,
            assistant_response: row.assistant_response,
            created_at: row.created_at,
            updated_at: row.updated_at,
            events,
            error: row.error,
            // DB-persisted runs never have live pending blocks; gates only
            // exist in-memory while the agent is actively waiting.
            pending_blocks: Vec::new(),
        })
    }
}

#[async_trait::async_trait]
impl super::traits::SessionStore for Database {
    async fn upsert_session(&self, key: &str, last_consolidated: i64) -> Result<()> {
        Database::upsert_session(self, key, last_consolidated).await
    }
    async fn load_session(&self, key: &str) -> Result<Option<SessionRow>> {
        Database::load_session(self, key).await
    }
    async fn delete_session(&self, key: &str) -> Result<bool> {
        Database::delete_session(self, key).await
    }
    async fn list_sessions_by_prefix(
        &self,
        prefix_like: &str,
        limit: u32,
    ) -> Result<Vec<SessionListRow>> {
        Database::list_sessions_by_prefix(self, prefix_like, limit).await
    }
    async fn set_session_metadata(&self, key: &str, metadata: &str) -> Result<()> {
        Database::set_session_metadata(self, key, metadata).await
    }
    async fn insert_message(
        &self,
        session_key: &str,
        role: &str,
        content: &str,
        tools_used: &[String],
    ) -> Result<()> {
        Database::insert_message(self, session_key, role, content, tools_used).await
    }
    async fn load_messages(&self, session_key: &str, limit: u32) -> Result<Vec<MessageRow>> {
        Database::load_messages(self, session_key, limit).await
    }
    async fn count_messages(&self, session_key: &str) -> Result<i64> {
        Database::count_messages(self, session_key).await
    }
    async fn clear_messages(&self, session_key: &str) -> Result<()> {
        Database::clear_messages(self, session_key).await
    }
    async fn load_old_messages(
        &self,
        session_key: &str,
        keep_count: u32,
    ) -> Result<Vec<MessageRow>> {
        Database::load_old_messages(self, session_key, keep_count).await
    }
    async fn delete_old_messages(&self, session_key: &str, keep_count: u32) -> Result<u64> {
        Database::delete_old_messages(self, session_key, keep_count).await
    }
}
