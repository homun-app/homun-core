use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Pool, Sqlite};

/// Database connection pool and initialization.
///
/// All persistent data goes through here: sessions, messages, memories, cron jobs.
/// Uses sqlx with SQLite. Migrations are applied automatically on init.
#[derive(Clone)]
pub struct Database {
    pool: Pool<Sqlite>,
}

impl Database {
    /// Open (or create) the database at the given path and run migrations.
    pub async fn open(path: &Path) -> Result<Self> {
        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).with_context(|| {
                format!("Failed to create database directory {}", parent.display())
            })?;
        }

        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .foreign_keys(true);

        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await
            .with_context(|| format!("Failed to open database at {}", path.display()))?;

        // Run migrations
        Self::run_migrations(&pool).await?;

        tracing::info!(path = %path.display(), "Database initialized");

        Ok(Self { pool })
    }

    /// Run SQL migrations from the migrations/ directory.
    async fn run_migrations(pool: &Pool<Sqlite>) -> Result<()> {
        // Create migrations tracking table
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _migrations (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                applied_at TEXT NOT NULL DEFAULT (datetime('now'))
            )",
        )
        .execute(pool)
        .await
        .context("Failed to create migrations table")?;

        // Migration 001
        let migration_name = "001_initial";
        let already_applied: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = ?)")
                .bind(migration_name)
                .fetch_one(pool)
                .await
                .unwrap_or(false);

        if !already_applied {
            let sql = include_str!("../../migrations/001_initial.sql");

            // Strip SQL comments, then split and execute each statement
            let clean_sql: String = sql
                .lines()
                .map(|line| {
                    // Remove inline comments (but keep content before --)
                    if let Some(pos) = line.find("--") {
                        &line[..pos]
                    } else {
                        line
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");

            for statement in clean_sql.split(';') {
                let statement = statement.trim();
                if statement.is_empty() {
                    continue;
                }
                sqlx::query(statement)
                    .execute(pool)
                    .await
                    .with_context(|| {
                        format!(
                            "Migration failed: {}",
                            &statement[..statement.len().min(80)]
                        )
                    })?;
            }

            sqlx::query("INSERT INTO _migrations (name) VALUES (?)")
                .bind(migration_name)
                .execute(pool)
                .await
                .context("Failed to record migration")?;

            tracing::info!(migration = migration_name, "Applied database migration");
        }

        // Migration 002 — memory_chunks + FTS5
        Self::apply_migration(
            pool,
            "002_memory_chunks",
            include_str!("../../migrations/002_memory_chunks.sql"),
        )
        .await?;

        // Migration 003 — users + identities + webhook_tokens
        Self::apply_migration(
            pool,
            "003_users",
            include_str!("../../migrations/003_users.sql"),
        )
        .await?;

        // Migration 004 — token usage tracking
        Self::apply_migration(
            pool,
            "004_token_usage",
            include_str!("../../migrations/004_token_usage.sql"),
        )
        .await?;

        // Migration 005 — email pending queue for assisted approval flow
        Self::apply_migration(
            pool,
            "005_email_pending",
            include_str!("../../migrations/005_email_pending.sql"),
        )
        .await?;

        // Migration 006 — automations + runs
        Self::apply_migration(
            pool,
            "006_automations",
            include_str!("../../migrations/006_automations.sql"),
        )
        .await?;

        // Migration 007 — automation trigger fields
        Self::apply_migration(
            pool,
            "007_automation_triggers",
            include_str!("../../migrations/007_automation_triggers.sql"),
        )
        .await?;

        // Migration 008 — automation plan/dependencies metadata
        Self::apply_migration(
            pool,
            "008_automation_plan",
            include_str!("../../migrations/008_automation_plan.sql"),
        )
        .await?;

        // Migration 009 — persisted web chat runs for restart restore
        Self::apply_migration(
            pool,
            "009_web_chat_runs",
            include_str!("../../migrations/009_web_chat_runs.sql"),
        )
        .await?;

        // Migration 010 — effective model for persisted web chat runs
        Self::apply_migration(
            pool,
            "010_web_chat_run_model",
            include_str!("../../migrations/010_web_chat_run_model.sql"),
        )
        .await?;

        // Migration 011 — RAG knowledge base (sources + chunks + FTS5)
        Self::apply_migration(
            pool,
            "011_rag_knowledge",
            include_str!("../../migrations/011_rag_knowledge.sql"),
        )
        .await?;
        Self::apply_migration(
            pool,
            "012_rag_sensitive_chunks",
            include_str!("../../migrations/012_rag_sensitive_chunks.sql"),
        )
        .await?;
        Self::apply_migration(
            pool,
            "013_workflows",
            include_str!("../../migrations/013_workflows.sql"),
        )
        .await?;
        Self::apply_migration(
            pool,
            "014_automation_workflow",
            include_str!("../../migrations/014_automation_workflow.sql"),
        )
        .await?;
        Self::apply_migration(
            pool,
            "016_skill_audit",
            include_str!("../../migrations/016_skill_audit.sql"),
        )
        .await?;
        Self::apply_migration(
            pool,
            "017_web_auth",
            include_str!("../../migrations/017_web_auth.sql"),
        )
        .await?;
        Self::apply_migration(
            pool,
            "018_automation_flow",
            include_str!("../../migrations/018_automation_flow.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "019_vault_access_log",
            include_str!("../../migrations/019_vault_access_log.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "020_contacts",
            include_str!("../../migrations/020_contacts.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "021_pending_notify",
            include_str!("../../migrations/021_pending_notify.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "022_contact_tone",
            include_str!("../../migrations/022_contact_tone.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "023_persona",
            include_str!("../../migrations/023_persona.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "024_memory_contact_scope",
            include_str!("../../migrations/024_memory_contact_scope.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "025_contact_agent_override",
            include_str!("../../migrations/025_contact_agent_override.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "026_step_agent_id",
            include_str!("../../migrations/026_step_agent_id.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "027_memory_agent_scope",
            include_str!("../../migrations/027_memory_agent_scope.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "028_memory_importance",
            include_str!("../../migrations/028_memory_importance.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "029_memory_summaries",
            include_str!("../../migrations/029_memory_summaries.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "030_trusted_devices",
            include_str!("../../migrations/030_trusted_devices.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "031_token_expiry",
            include_str!("../../migrations/031_token_expiry.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "032_workflow_automation_link",
            include_str!("../../migrations/032_workflow_automation_link.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "033_drop_cron_jobs",
            include_str!("../../migrations/033_drop_cron_jobs.sql"),
        )
        .await?;

        // Migration 034 — profiles table + seed default
        Self::apply_migration(
            pool,
            "034_profiles",
            include_str!("../../migrations/034_profiles.sql"),
        )
        .await?;

        // Migration 035 — profile_id columns on memory, RAG, contacts, sessions
        Self::apply_migration(
            pool,
            "035_profile_scoping",
            include_str!("../../migrations/035_profile_scoping.sql"),
        )
        .await?;

        // Backfill profile_id after migration 035.
        // Done in Rust (not SQL) because ALTER TABLE + FTS5 content-sync triggers
        // cause SQLite to invalidate table names for DML in the same migration batch.
        Self::backfill_profile_ids(pool).await?;

        // Migration 036 — profile_id on automations and workflows
        Self::apply_migration(
            pool,
            "036_profile_scoping_phase2",
            include_str!("../../migrations/036_profile_scoping_phase2.sql"),
        )
        .await?;

        // Migration 037 — user_id on all parent-scoped tables + seed admin
        Self::apply_migration(
            pool,
            "037_user_profile_scoping",
            include_str!("../../migrations/037_user_profile_scoping.sql"),
        )
        .await?;

        // Backfill user_id on all existing records after migration 037.
        Self::backfill_user_ids(pool).await?;

        Self::apply_migration(
            pool,
            "038_profile_color",
            include_str!("../../migrations/038_profile_color.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "039_gateways",
            include_str!("../../migrations/039_gateways.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "040_contact_gateway_overrides",
            include_str!("../../migrations/040_contact_gateway_overrides.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "041_contact_perimeters",
            include_str!("../../migrations/041_contact_perimeters.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "042_namespaces",
            include_str!("../../migrations/042_namespaces.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "043_shared_resources",
            include_str!("../../migrations/043_shared_resources.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "044_mobile_pairing",
            include_str!("../../migrations/044_mobile_pairing.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "045_knowledge_watches",
            include_str!("../../migrations/045_knowledge_watches.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "046_mobile_notify_target",
            include_str!("../../migrations/046_mobile_notify_target.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "047_browser_allowed_sites",
            include_str!("../../migrations/047_browser_allowed_sites.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "048_contact_response_mode_inherit",
            include_str!("../../migrations/048_contact_response_mode_inherit.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "049_gateway_name_normalize",
            include_str!("../../migrations/049_gateway_name_normalize.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "050_profile_audit_columns",
            include_str!("../../migrations/050_profile_audit_columns.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "051_task_checkpoints",
            include_str!("../../migrations/051_task_checkpoints.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "052_settings",
            include_str!("../../migrations/052_settings.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "053_drop_business",
            include_str!("../../migrations/053_drop_business.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "054_cognition_metrics",
            include_str!("../../migrations/054_cognition_metrics.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "055_user_lifecycle",
            include_str!("../../migrations/055_user_lifecycle.sql"),
        )
        .await?;

        Self::apply_migration(
            pool,
            "056_internal_apps",
            include_str!("../../migrations/056_internal_apps.sql"),
        )
        .await?;

        Self::reassign_legacy_seed_admin_data(pool).await?;

        // One-shot backfill post-migration-050 (namespace isolation):
        // Chunks created by contacts before the namespace feature had `namespace = '_private'`
        // (the SQL column default). With the new structural filter in memory_search.rs,
        // contacts would stop seeing their own past memories. Fix: set them to '_public'.
        Self::backfill_contact_namespaces(pool).await?;

        Ok(())
    }

    /// Apply a named migration if not already applied.
    async fn apply_migration(pool: &Pool<Sqlite>, name: &str, sql: &str) -> Result<()> {
        let already_applied: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _migrations WHERE name = ?)")
                .bind(name)
                .fetch_one(pool)
                .await
                .unwrap_or(false);

        if already_applied {
            return Ok(());
        }

        // Strip SQL comments, then split into statements.
        // Handles BEGIN...END blocks (e.g. triggers) where inner semicolons
        // are part of the block, not statement separators.
        let clean_sql: String = sql
            .lines()
            .map(|line| {
                if let Some(pos) = line.find("--") {
                    &line[..pos]
                } else {
                    line
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        let statements = split_sql_statements(&clean_sql);

        for statement in &statements {
            let statement = statement.trim();
            if statement.is_empty() {
                continue;
            }
            sqlx::query(statement)
                .execute(pool)
                .await
                .with_context(|| {
                    format!(
                        "Migration {name} failed: {}",
                        &statement[..statement.len().min(80)]
                    )
                })?;
        }

        sqlx::query("INSERT INTO _migrations (name) VALUES (?)")
            .bind(name)
            .execute(pool)
            .await
            .context("Failed to record migration")?;

        tracing::info!(migration = name, "Applied database migration");
        Ok(())
    }

    /// Backfill NULL profile_id to the default profile (id=1).
    ///
    /// Runs as a separate step after migration 035 because SQLite's ALTER TABLE
    /// on tables with FTS5 content-sync triggers invalidates the table name
    /// for DML operations in the same migration batch.
    async fn backfill_profile_ids(pool: &Pool<Sqlite>) -> Result<()> {
        for table in &["memory_chunks", "rag_chunks", "contacts", "sessions"] {
            let sql = format!("UPDATE {table} SET profile_id = 1 WHERE profile_id IS NULL");
            let result = sqlx::query(&sql).execute(pool).await;
            match result {
                Ok(r) if r.rows_affected() > 0 => {
                    tracing::info!(table, rows = r.rows_affected(), "Backfilled profile_id");
                }
                Err(e) => {
                    tracing::warn!(table, error = %e, "Failed to backfill profile_id (table may not exist)");
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// Backfill NULL user_id to the default admin user on all parent-scoped tables.
    ///
    /// Also backfills profile_id on tables added in migration 037
    /// (memory_summaries, rag_sources, email_pending).
    async fn backfill_user_ids(pool: &Pool<Sqlite>) -> Result<()> {
        use crate::user::DEFAULT_ADMIN_USER_ID;

        // Tables that already had profile_id and now get user_id
        let user_only_tables = [
            "profiles",
            "memory_chunks",
            "rag_chunks",
            "contacts",
            "sessions",
            "automations",
            "workflows",
        ];

        for table in &user_only_tables {
            let sql = format!("UPDATE {table} SET user_id = ? WHERE user_id IS NULL");
            let result = sqlx::query(&sql)
                .bind(DEFAULT_ADMIN_USER_ID)
                .execute(pool)
                .await;
            match result {
                Ok(r) if r.rows_affected() > 0 => {
                    tracing::info!(table, rows = r.rows_affected(), "Backfilled user_id");
                }
                Err(e) => {
                    tracing::warn!(table, error = %e, "Failed to backfill user_id (table may not exist)");
                }
                _ => {}
            }
        }

        // Tables that got both user_id + profile_id in migration 037
        let both_tables = ["memory_summaries", "rag_sources", "email_pending"];

        for table in &both_tables {
            // Backfill user_id
            let sql = format!("UPDATE {table} SET user_id = ? WHERE user_id IS NULL");
            let result = sqlx::query(&sql)
                .bind(DEFAULT_ADMIN_USER_ID)
                .execute(pool)
                .await;
            match result {
                Ok(r) if r.rows_affected() > 0 => {
                    tracing::info!(table, rows = r.rows_affected(), "Backfilled user_id");
                }
                Err(e) => {
                    tracing::warn!(table, error = %e, "Failed to backfill user_id");
                }
                _ => {}
            }

            // Backfill profile_id to default (1)
            let sql = format!("UPDATE {table} SET profile_id = 1 WHERE profile_id IS NULL");
            let result = sqlx::query(&sql).execute(pool).await;
            match result {
                Ok(r) if r.rows_affected() > 0 => {
                    tracing::info!(table, rows = r.rows_affected(), "Backfilled profile_id");
                }
                Err(e) => {
                    tracing::warn!(table, error = %e, "Failed to backfill profile_id");
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Reassign data owned by the migration-seeded admin placeholder to the
    /// real first-run admin account when setup created a separate user.
    async fn reassign_legacy_seed_admin_data(pool: &Pool<Sqlite>) -> Result<()> {
        use crate::user::DEFAULT_ADMIN_USER_ID;

        let seed_has_password: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM users
             WHERE id = ? AND password_hash IS NOT NULL AND password_hash != ''",
        )
        .bind(DEFAULT_ADMIN_USER_ID)
        .fetch_one(pool)
        .await
        .unwrap_or(0);
        if seed_has_password > 0 {
            return Ok(());
        }

        let admin_ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM users
             WHERE id != ?
               AND enabled = 1
               AND password_hash IS NOT NULL
               AND password_hash != ''
               AND roles LIKE '%admin%'
             ORDER BY created_at ASC, id ASC",
        )
        .bind(DEFAULT_ADMIN_USER_ID)
        .fetch_all(pool)
        .await
        .context("Failed to find real admin users for legacy data reassignment")?;

        if admin_ids.len() != 1 {
            return Ok(());
        }
        let real_admin_id = &admin_ids[0];

        let tables = [
            "profiles",
            "memory_chunks",
            "rag_chunks",
            "contacts",
            "sessions",
            "automations",
            "workflows",
            "memory_summaries",
            "rag_sources",
            "email_pending",
        ];
        for table in &tables {
            let sql = format!("UPDATE {table} SET user_id = ? WHERE user_id = ?");
            let result = sqlx::query(&sql)
                .bind(real_admin_id)
                .bind(DEFAULT_ADMIN_USER_ID)
                .execute(pool)
                .await;
            match result {
                Ok(r) if r.rows_affected() > 0 => tracing::info!(
                    table,
                    rows = r.rows_affected(),
                    from = DEFAULT_ADMIN_USER_ID,
                    to = %real_admin_id,
                    "Reassigned legacy seed-admin data to real admin user"
                ),
                Err(e) => {
                    tracing::warn!(table, error = %e, "Failed to reassign legacy seed-admin data");
                }
                _ => {}
            }
        }

        Ok(())
    }

    /// Backfill namespace on memory chunks created by contacts before namespace isolation.
    ///
    /// Before the namespace feature, all chunks had `namespace = '_private'` (column default).
    /// With the structural filter in `memory_search.rs`, contacts cannot see `_private` chunks,
    /// so their past memories would vanish. This sets contact-owned chunks to `_public`.
    /// Idempotent: rows already `_public` are unaffected; no-op once all are fixed.
    async fn backfill_contact_namespaces(pool: &Pool<Sqlite>) -> Result<()> {
        let result = sqlx::query(
            "UPDATE memory_chunks SET namespace = '_public' \
             WHERE contact_id IS NOT NULL AND namespace = '_private'",
        )
        .execute(pool)
        .await;

        match result {
            Ok(r) if r.rows_affected() > 0 => {
                tracing::info!(
                    rows = r.rows_affected(),
                    "Backfilled contact memory_chunks namespace _private → _public"
                );
            }
            Err(e) => {
                tracing::warn!(error = %e, "Failed to backfill contact namespaces");
            }
            _ => {}
        }

        // Verification: ensure no contact-owned chunks remain _private
        let remaining: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM memory_chunks \
             WHERE contact_id IS NOT NULL AND namespace = '_private'",
        )
        .fetch_one(pool)
        .await
        .unwrap_or(-1);

        if remaining > 0 {
            tracing::error!(
                remaining,
                "Contact namespace backfill incomplete — chunks still _private"
            );
        }

        Ok(())
    }

    /// Get a reference to the connection pool
    pub fn pool(&self) -> &Pool<Sqlite> {
        &self.pool
    }

    // --- Memory operations ---

    /// Insert a consolidated memory
    pub async fn insert_memory(
        &self,
        session_key: Option<&str>,
        content: &str,
        memory_type: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO memories (session_key, content, memory_type) VALUES (?, ?, ?)")
            .bind(session_key)
            .bind(content)
            .bind(memory_type)
            .execute(&self.pool)
            .await
            .context("Failed to insert memory")?;

        Ok(())
    }

    /// Load all memories for a session (plus global memories)
    pub async fn load_memories(&self, session_key: &str) -> Result<Vec<MemoryRow>> {
        let rows = sqlx::query_as::<_, MemoryRow>(
            "SELECT id, session_key, content, memory_type, created_at
             FROM memories
             WHERE session_key IS NULL OR session_key = ?
             ORDER BY created_at ASC",
        )
        .bind(session_key)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load memories")?;

        Ok(rows)
    }

    /// Load the latest long-term memory content (type = 'long_term')
    pub async fn load_long_term_memory(&self) -> Result<Option<String>> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT content FROM memories
             WHERE memory_type = 'long_term' AND session_key IS NULL
             ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load long-term memory")?;

        Ok(row.map(|(c,)| c))
    }

    /// Replace the global long-term memory (upsert pattern)
    pub async fn upsert_long_term_memory(&self, content: &str) -> Result<()> {
        // Delete old global long-term memory, then insert fresh
        sqlx::query("DELETE FROM memories WHERE memory_type = 'long_term' AND session_key IS NULL")
            .execute(&self.pool)
            .await
            .context("Failed to clear old long-term memory")?;

        self.insert_memory(None, content, "long_term").await
    }

    // --- Automation operations ---

    // ═══════════════════════════════════════════════════════════════
    // MEMORY RETENTION - Prune old data based on retention policies
    // ═══════════════════════════════════════════════════════════════

    /// Prune old conversation messages based on retention policy.
    /// Returns the number of messages deleted.
    pub(crate) async fn prune_old_messages(&self, retention_days: u32) -> Result<u64> {
        if retention_days == 0 {
            return Ok(0); // Never prune
        }

        let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_str = cutoff.to_rfc3339();

        let result = sqlx::query("DELETE FROM messages WHERE timestamp < ?")
            .bind(&cutoff_str)
            .execute(&self.pool)
            .await
            .context("Failed to prune old messages")?;

        let deleted = result.rows_affected();
        if deleted > 0 {
            tracing::info!(
                deleted,
                retention_days,
                cutoff = %cutoff_str,
                "Pruned old conversation messages"
            );
        }
        Ok(deleted)
    }

    /// Prune old memory chunks (history entries) based on retention policy.
    /// Returns the number of chunks deleted.
    pub(crate) async fn prune_old_memory_chunks(&self, retention_days: u32) -> Result<u64> {
        if retention_days == 0 {
            return Ok(0); // Never prune
        }

        let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days as i64);
        let cutoff_date = cutoff.format("%Y-%m-%d").to_string();

        // Only prune history-type chunks, keep facts and instructions
        let result =
            sqlx::query("DELETE FROM memory_chunks WHERE date < ? AND memory_type = 'history'")
                .bind(&cutoff_date)
                .execute(&self.pool)
                .await
                .context("Failed to prune old memory chunks")?;

        let deleted = result.rows_affected();
        if deleted > 0 {
            tracing::info!(
                deleted,
                retention_days,
                cutoff = %cutoff_date,
                "Pruned old history chunks"
            );
        }
        Ok(deleted)
    }

    /// Run full memory cleanup based on retention policies.
    /// Returns summary of what was cleaned up.
    pub async fn run_memory_cleanup(
        &self,
        conversation_retention_days: u32,
        history_retention_days: u32,
    ) -> Result<MemoryCleanupResult> {
        let messages_deleted = self.prune_old_messages(conversation_retention_days).await?;
        let chunks_deleted = self.prune_old_memory_chunks(history_retention_days).await?;

        Ok(MemoryCleanupResult {
            messages_deleted,
            chunks_deleted,
        })
    }

    // ═══════════════════════════════════════════════════════════════
    // USER SYSTEM OPERATIONS
    // ═══════════════════════════════════════════════════════════════

    /// Create a new user with the given ID, username, and roles.
    pub async fn create_user(&self, id: &str, username: &str, roles: &[&str]) -> Result<()> {
        let roles_json = serde_json::to_string(roles).unwrap_or_else(|_| "[]".to_string());

        sqlx::query("INSERT INTO users (id, username, roles) VALUES (?, ?, ?)")
            .bind(id)
            .bind(username)
            .bind(roles_json)
            .execute(&self.pool)
            .await
            .context("Failed to create user")?;

        Ok(())
    }

    /// Load a user by their internal ID.
    pub async fn load_user(&self, id: &str) -> Result<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, username, roles, password_hash, enabled, must_change_password, created_at, updated_at, metadata
             FROM users WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load user")?;

        Ok(row)
    }

    /// Load a user by their username.
    pub async fn load_user_by_username(&self, username: &str) -> Result<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT id, username, roles, password_hash, enabled, must_change_password, created_at, updated_at, metadata
             FROM users WHERE username = ?",
        )
        .bind(username)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load user by username")?;

        Ok(row)
    }

    /// Load all users.
    pub async fn load_all_users(&self) -> Result<Vec<UserRow>> {
        let rows = sqlx::query_as::<_, UserRow>(
            "SELECT id, username, roles, password_hash, enabled, must_change_password, created_at, updated_at, metadata
             FROM users ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await
        .context("Failed to load users")?;

        Ok(rows)
    }

    /// Update a user's roles.
    pub async fn update_user_roles(&self, id: &str, roles: &[&str]) -> Result<bool> {
        let roles_json = serde_json::to_string(roles).unwrap_or_else(|_| "[]".to_string());

        let result =
            sqlx::query("UPDATE users SET roles = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(roles_json)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("Failed to update user roles")?;

        Ok(result.rows_affected() > 0)
    }

    /// Update whether a user can authenticate.
    pub async fn set_user_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        let result =
            sqlx::query("UPDATE users SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
                .bind(if enabled { 1 } else { 0 })
                .bind(id)
                .execute(&self.pool)
                .await
                .context("Failed to update user enabled flag")?;

        Ok(result.rows_affected() > 0)
    }

    /// Update whether a user must change password after login.
    pub async fn set_user_must_change_password(
        &self,
        id: &str,
        must_change_password: bool,
    ) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE users SET must_change_password = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(if must_change_password { 1 } else { 0 })
        .bind(id)
        .execute(&self.pool)
        .await
        .context("Failed to update user must_change_password flag")?;

        Ok(result.rows_affected() > 0)
    }

    /// Delete a user (cascades to identities and webhook tokens).
    pub async fn delete_user(&self, id: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM users WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("Failed to delete user")?;

        Ok(result.rows_affected() > 0)
    }

    // --- User identities ---

    /// Add a channel identity to a user.
    pub async fn add_user_identity(
        &self,
        user_id: &str,
        channel: &str,
        platform_id: &str,
        display_name: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO user_identities (user_id, channel, platform_id, display_name)
             VALUES (?, ?, ?, ?)",
        )
        .bind(user_id)
        .bind(channel)
        .bind(platform_id)
        .bind(display_name)
        .execute(&self.pool)
        .await
        .context("Failed to add user identity")?;

        Ok(())
    }

    /// Look up a user by their channel identity.
    pub async fn lookup_user_by_identity(
        &self,
        channel: &str,
        platform_id: &str,
    ) -> Result<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT u.id, u.username, u.roles, u.password_hash, u.enabled, u.must_change_password, u.created_at, u.updated_at, u.metadata
             FROM users u
             JOIN user_identities i ON u.id = i.user_id
             WHERE i.channel = ? AND i.platform_id = ?",
        )
        .bind(channel)
        .bind(platform_id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to lookup user by identity")?;

        Ok(row)
    }

    /// Load all identities for a user.
    pub async fn load_user_identities(&self, user_id: &str) -> Result<Vec<UserIdentityRow>> {
        let rows = sqlx::query_as::<_, UserIdentityRow>(
            "SELECT id, user_id, channel, platform_id, display_name, created_at
             FROM user_identities WHERE user_id = ?
             ORDER BY created_at ASC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load user identities")?;

        Ok(rows)
    }

    /// Remove a user identity.
    pub async fn remove_user_identity(
        &self,
        user_id: &str,
        channel: &str,
        platform_id: &str,
    ) -> Result<bool> {
        let result = sqlx::query(
            "DELETE FROM user_identities
             WHERE user_id = ? AND channel = ? AND platform_id = ?",
        )
        .bind(user_id)
        .bind(channel)
        .bind(platform_id)
        .execute(&self.pool)
        .await
        .context("Failed to remove user identity")?;

        Ok(result.rows_affected() > 0)
    }

    // --- Webhook tokens ---

    /// Create a new webhook token for a user.
    ///
    /// `expires_at` is an optional RFC-3339 timestamp; `None` means the token never expires.
    pub async fn create_webhook_token(
        &self,
        token: &str,
        user_id: &str,
        name: &str,
        scope: &str,
        expires_at: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO webhook_tokens (token, user_id, name, scope, expires_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(token)
        .bind(user_id)
        .bind(name)
        .bind(scope)
        .bind(expires_at)
        .execute(&self.pool)
        .await
        .context("Failed to create webhook token")?;

        Ok(())
    }

    /// Look up a webhook token and return the associated user.
    ///
    /// Returns `None` if the token is disabled or expired.
    pub async fn lookup_user_by_webhook_token(&self, token: &str) -> Result<Option<UserRow>> {
        let row = sqlx::query_as::<_, UserRow>(
            "SELECT u.id, u.username, u.roles, u.password_hash, u.enabled, u.must_change_password, u.created_at, u.updated_at, u.metadata
             FROM users u
             JOIN webhook_tokens wt ON u.id = wt.user_id
             WHERE wt.token = ? AND wt.enabled = 1 AND u.enabled = 1
               AND (wt.expires_at IS NULL OR wt.expires_at > datetime('now'))",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to lookup user by webhook token")?;

        Ok(row)
    }

    /// Update the last_used timestamp for a webhook token.
    pub async fn touch_webhook_token(&self, token: &str) -> Result<()> {
        sqlx::query("UPDATE webhook_tokens SET last_used = datetime('now') WHERE token = ?")
            .bind(token)
            .execute(&self.pool)
            .await
            .context("Failed to update webhook token last_used")?;

        Ok(())
    }

    /// Load all webhook tokens for a user.
    pub async fn load_webhook_tokens(&self, user_id: &str) -> Result<Vec<WebhookTokenRow>> {
        let rows = sqlx::query_as::<_, WebhookTokenRow>(
            "SELECT token, user_id, name, enabled, scope, last_used, created_at, expires_at
             FROM webhook_tokens WHERE user_id = ?
             ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load webhook tokens")?;

        Ok(rows)
    }

    /// Delete a webhook token.
    pub async fn delete_webhook_token(&self, token: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM webhook_tokens WHERE token = ?")
            .bind(token)
            .execute(&self.pool)
            .await
            .context("Failed to delete webhook token")?;

        Ok(result.rows_affected() > 0)
    }

    /// Toggle a webhook token's enabled state.
    pub async fn toggle_webhook_token(&self, token: &str, enabled: bool) -> Result<bool> {
        let result = sqlx::query("UPDATE webhook_tokens SET enabled = ? WHERE token = ?")
            .bind(enabled)
            .bind(token)
            .execute(&self.pool)
            .await
            .context("Failed to toggle webhook token")?;

        Ok(result.rows_affected() > 0)
    }

    /// Load a single webhook token by its value.
    pub async fn load_webhook_token(&self, token: &str) -> Result<Option<WebhookTokenRow>> {
        let row = sqlx::query_as::<_, WebhookTokenRow>(
            "SELECT token, user_id, name, enabled, scope, last_used, created_at, expires_at
             FROM webhook_tokens WHERE token = ?",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load webhook token")?;

        Ok(row)
    }

    /// Find a webhook token by its prefix (first 16 characters).
    ///
    /// Used by management endpoints that receive a `token_id` instead of the full token.
    pub async fn find_token_by_prefix(&self, prefix: &str) -> Result<Option<WebhookTokenRow>> {
        let pattern = format!("{prefix}%");
        let row = sqlx::query_as::<_, WebhookTokenRow>(
            "SELECT token, user_id, name, enabled, scope, last_used, created_at, expires_at
             FROM webhook_tokens WHERE token LIKE ?",
        )
        .bind(pattern)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to find webhook token by prefix")?;

        Ok(row)
    }

    // --- Mobile pairing ---

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_mobile_pairing_session(
        &self,
        id: &str,
        user_id: &str,
        status: &str,
        nonce_hash: &str,
        base_url: &str,
        server_fingerprint: &str,
        expires_at: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO mobile_pairing_sessions
             (id, user_id, status, nonce_hash, base_url, server_fingerprint, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(user_id)
        .bind(status)
        .bind(nonce_hash)
        .bind(base_url)
        .bind(server_fingerprint)
        .bind(expires_at)
        .execute(&self.pool)
        .await
        .context("Failed to insert mobile pairing session")?;

        Ok(())
    }

    pub async fn load_mobile_pairing_session(
        &self,
        id: &str,
    ) -> Result<Option<MobilePairingSessionRow>> {
        let row = sqlx::query_as::<_, MobilePairingSessionRow>(
            "SELECT id, user_id, status, nonce_hash, base_url, server_fingerprint,
                    device_name, platform, app_version, device_public_key, device_push_token,
                    device_id, created_at, claimed_at, approved_at, completed_at, expires_at
             FROM mobile_pairing_sessions
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load mobile pairing session")?;

        Ok(row)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn claim_mobile_pairing_session(
        &self,
        id: &str,
        device_name: &str,
        platform: &str,
        app_version: Option<&str>,
        device_public_key: Option<&str>,
        device_push_token: Option<&str>,
    ) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE mobile_pairing_sessions
             SET status = 'claimed',
                 device_name = ?,
                 platform = ?,
                 app_version = ?,
                 device_public_key = ?,
                 device_push_token = ?,
                 claimed_at = ?
             WHERE id = ? AND status = 'created'",
        )
        .bind(device_name)
        .bind(platform)
        .bind(app_version)
        .bind(device_public_key)
        .bind(device_push_token)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .context("Failed to claim mobile pairing session")?;

        Ok(result.rows_affected() > 0)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn approve_mobile_pairing_session(
        &self,
        pairing_id: &str,
        device_id: &str,
        user_id: &str,
        device_name: &str,
        platform: &str,
        app_version: Option<&str>,
        public_key: Option<&str>,
        push_token: Option<&str>,
        token: &str,
        token_name: &str,
        token_scope: &str,
        server_fingerprint: &str,
        can_emergency_stop: bool,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut tx = self
            .pool
            .begin()
            .await
            .context("Failed to start mobile pairing approval transaction")?;

        sqlx::query(
            "INSERT INTO webhook_tokens (token, user_id, name, scope, expires_at)
             VALUES (?, ?, ?, ?, NULL)",
        )
        .bind(token)
        .bind(user_id)
        .bind(token_name)
        .bind(token_scope)
        .execute(&mut *tx)
        .await
        .context("Failed to create mobile bearer token")?;

        sqlx::query(
            "INSERT INTO mobile_devices
             (id, user_id, name, platform, app_version, public_key, push_token, token,
              can_emergency_stop, server_fingerprint_at_pair, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(device_id)
        .bind(user_id)
        .bind(device_name)
        .bind(platform)
        .bind(app_version)
        .bind(public_key)
        .bind(push_token)
        .bind(token)
        .bind(can_emergency_stop)
        .bind(server_fingerprint)
        .bind(&now)
        .execute(&mut *tx)
        .await
        .context("Failed to create mobile device")?;

        sqlx::query(
            "UPDATE mobile_pairing_sessions
             SET status = 'approved', approved_at = ?, device_id = ?
             WHERE id = ?",
        )
        .bind(&now)
        .bind(device_id)
        .bind(pairing_id)
        .execute(&mut *tx)
        .await
        .context("Failed to mark mobile pairing session approved")?;

        tx.commit()
            .await
            .context("Failed to commit mobile pairing approval transaction")?;

        Ok(())
    }

    pub async fn complete_mobile_pairing_session(&self, id: &str) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE mobile_pairing_sessions
             SET status = 'completed', completed_at = ?
             WHERE id = ? AND status = 'approved'",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await
        .context("Failed to complete mobile pairing session")?;

        Ok(result.rows_affected() > 0)
    }

    pub async fn load_mobile_devices(&self, user_id: &str) -> Result<Vec<MobileDeviceRow>> {
        let rows = sqlx::query_as::<_, MobileDeviceRow>(
            "SELECT id, user_id, name, platform, app_version, public_key, push_token, token,
                    can_emergency_stop, server_fingerprint_at_pair, last_seen_at, created_at,
                    revoked_at, is_notify_target
             FROM mobile_devices
             WHERE user_id = ?
             ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load mobile devices")?;

        Ok(rows)
    }

    pub async fn load_mobile_device(&self, id: &str) -> Result<Option<MobileDeviceRow>> {
        let row = sqlx::query_as::<_, MobileDeviceRow>(
            "SELECT id, user_id, name, platform, app_version, public_key, push_token, token,
                    can_emergency_stop, server_fingerprint_at_pair, last_seen_at, created_at,
                    revoked_at, is_notify_target
             FROM mobile_devices
             WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load mobile device")?;

        Ok(row)
    }

    pub async fn load_mobile_device_by_token(
        &self,
        token: &str,
    ) -> Result<Option<MobileDeviceRow>> {
        let row = sqlx::query_as::<_, MobileDeviceRow>(
            "SELECT id, user_id, name, platform, app_version, public_key, push_token,
                    token, can_emergency_stop, server_fingerprint_at_pair, last_seen_at,
                    created_at, revoked_at, is_notify_target
             FROM mobile_devices
             WHERE token = ? AND revoked_at IS NULL",
        )
        .bind(token)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load mobile device by token")?;

        Ok(row)
    }

    pub async fn touch_mobile_device_by_token(&self, token: &str) -> Result<()> {
        sqlx::query(
            "UPDATE mobile_devices
             SET last_seen_at = ?
             WHERE token = ? AND revoked_at IS NULL",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(token)
        .execute(&self.pool)
        .await
        .context("Failed to update mobile device last_seen_at")?;

        Ok(())
    }

    /// Hard-delete a mobile device and its associated bearer token.
    ///
    /// Deleting the webhook_token cascades to the mobile_devices row (FK ON DELETE CASCADE).
    /// Also cleans up any pairing sessions linked to this device.
    pub async fn delete_mobile_device(&self, id: &str) -> Result<bool> {
        let mut tx = self
            .pool
            .begin()
            .await
            .context("Failed to start mobile device delete transaction")?;

        // Get the token before deleting (needed for webhook_tokens cleanup)
        let token_row =
            sqlx::query_scalar::<_, String>("SELECT token FROM mobile_devices WHERE id = ?")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await
                .context("Failed to look up mobile device token")?;

        let Some(token) = token_row else {
            return Ok(false);
        };

        // Clean up pairing sessions that reference this device
        sqlx::query("DELETE FROM mobile_pairing_sessions WHERE device_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await
            .context("Failed to delete mobile pairing sessions")?;

        // Delete the webhook token — cascades to mobile_devices row
        sqlx::query("DELETE FROM webhook_tokens WHERE token = ?")
            .bind(&token)
            .execute(&mut *tx)
            .await
            .context("Failed to delete mobile device token")?;

        tx.commit()
            .await
            .context("Failed to commit mobile device delete transaction")?;

        Ok(true)
    }

    /// Mark a mobile device as the default notification target.
    ///
    /// Only one device can be the notify target at a time.
    /// When `enabled` is true, unsets all other devices first.
    pub async fn set_mobile_notify_target(&self, device_id: &str, enabled: bool) -> Result<bool> {
        let mut tx = self
            .pool
            .begin()
            .await
            .context("Failed to start notify target transaction")?;

        if enabled {
            // Unset all other devices first
            sqlx::query(
                "UPDATE mobile_devices SET is_notify_target = 0 WHERE is_notify_target = 1",
            )
            .execute(&mut *tx)
            .await
            .context("Failed to clear existing notify target")?;
        }

        let result = sqlx::query(
            "UPDATE mobile_devices SET is_notify_target = ? WHERE id = ? AND revoked_at IS NULL",
        )
        .bind(i32::from(enabled))
        .bind(device_id)
        .execute(&mut *tx)
        .await
        .context("Failed to set mobile notify target")?;

        tx.commit()
            .await
            .context("Failed to commit notify target transaction")?;

        Ok(result.rows_affected() > 0)
    }

    /// Get the mobile device marked as the default notification target.
    pub async fn get_mobile_notify_target(&self) -> Result<Option<MobileDeviceRow>> {
        let row = sqlx::query_as::<_, MobileDeviceRow>(
            "SELECT id, user_id, name, platform, app_version, public_key, push_token,
                    token, can_emergency_stop, server_fingerprint_at_pair, last_seen_at,
                    created_at, revoked_at, is_notify_target
             FROM mobile_devices
             WHERE is_notify_target = 1 AND revoked_at IS NULL",
        )
        .fetch_optional(&self.pool)
        .await
        .context("Failed to get mobile notify target")?;

        Ok(row)
    }

    // --- User password ---

    /// Set the password hash for a user.
    pub async fn set_user_password_hash(&self, user_id: &str, hash: &str) -> Result<()> {
        sqlx::query(
            "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?",
        )
        .bind(hash)
        .bind(user_id)
        .execute(&self.pool)
        .await
        .context("Failed to set user password hash")?;

        Ok(())
    }

    /// Count users that have a password set (for web auth first-run detection).
    /// Returns 0 when no user has ever set up web credentials.
    pub async fn count_users_with_password(&self) -> Result<i64> {
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE password_hash IS NOT NULL")
                .fetch_one(&self.pool)
                .await
                .context("Failed to count users with password")?;

        Ok(count)
    }

    // --- Trusted devices (REM-3) ---

    /// Insert a new trusted device (pending approval).
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_trusted_device(
        &self,
        id: &str,
        user_id: &str,
        fingerprint: &str,
        name: &str,
        user_agent: &str,
        ip: &str,
        approval_code: &str,
    ) -> Result<()> {
        sqlx::query(
            "INSERT OR REPLACE INTO trusted_devices (id, user_id, fingerprint, name, user_agent, ip_at_login, approval_code)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(user_id)
        .bind(fingerprint)
        .bind(name)
        .bind(user_agent)
        .bind(ip)
        .bind(approval_code)
        .execute(&self.pool)
        .await
        .context("Failed to insert trusted device")?;
        Ok(())
    }

    /// Look up a trusted device by user + fingerprint.
    pub async fn load_trusted_device_by_fingerprint(
        &self,
        user_id: &str,
        fingerprint: &str,
    ) -> Result<Option<TrustedDeviceRow>> {
        let row = sqlx::query_as::<_, TrustedDeviceRow>(
            "SELECT id, user_id, fingerprint, name, user_agent, ip_at_login, created_at, approved_at, approval_code
             FROM trusted_devices WHERE user_id = ? AND fingerprint = ?",
        )
        .bind(user_id)
        .bind(fingerprint)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load trusted device by fingerprint")?;
        Ok(row)
    }

    /// Approve a pending device (set approved_at, clear code).
    pub async fn approve_trusted_device(&self, device_id: &str) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE trusted_devices SET approved_at = datetime('now'), approval_code = NULL WHERE id = ?",
        )
        .bind(device_id)
        .execute(&self.pool)
        .await
        .context("Failed to approve trusted device")?;
        Ok(result.rows_affected() > 0)
    }

    /// List all trusted devices for a user.
    pub async fn load_trusted_devices(&self, user_id: &str) -> Result<Vec<TrustedDeviceRow>> {
        let rows = sqlx::query_as::<_, TrustedDeviceRow>(
            "SELECT id, user_id, fingerprint, name, user_agent, ip_at_login, created_at, approved_at, approval_code
             FROM trusted_devices WHERE user_id = ? ORDER BY created_at DESC",
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load trusted devices")?;
        Ok(rows)
    }

    /// Delete a trusted device.
    pub async fn delete_trusted_device(&self, device_id: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM trusted_devices WHERE id = ?")
            .bind(device_id)
            .execute(&self.pool)
            .await
            .context("Failed to delete trusted device")?;
        Ok(result.rows_affected() > 0)
    }

    /// Find a pending device by user + approval code.
    pub async fn load_pending_device_by_code(
        &self,
        user_id: &str,
        code: &str,
    ) -> Result<Option<TrustedDeviceRow>> {
        let row = sqlx::query_as::<_, TrustedDeviceRow>(
            "SELECT id, user_id, fingerprint, name, user_agent, ip_at_login, created_at, approved_at, approval_code
             FROM trusted_devices WHERE user_id = ? AND approval_code = ? AND approved_at IS NULL",
        )
        .bind(user_id)
        .bind(code)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load pending device by code")?;
        Ok(row)
    }

    // --- Token usage ---

    pub async fn insert_token_usage(
        &self,
        session_key: &str,
        model: &str,
        provider: &str,
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO token_usage (session_key, model, provider, prompt_tokens, completion_tokens, total_tokens)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(session_key)
        .bind(model)
        .bind(provider)
        .bind(prompt_tokens as i64)
        .bind(completion_tokens as i64)
        .bind(total_tokens as i64)
        .execute(&self.pool)
        .await
        .context("Failed to insert token usage")?;
        Ok(())
    }

    pub async fn query_token_usage(
        &self,
        session_key: Option<&str>,
        since: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<TokenUsageAggRow>> {
        let mut sql = String::from(
            "SELECT model, provider,
                    SUM(prompt_tokens) as prompt_tokens,
                    SUM(completion_tokens) as completion_tokens,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as call_count
             FROM token_usage WHERE 1=1",
        );
        let mut binds: Vec<String> = Vec::new();

        if let Some(s) = session_key {
            sql.push_str(" AND session_key = ?");
            binds.push(s.to_string());
        }
        if let Some(s) = since {
            sql.push_str(" AND created_at >= ?");
            binds.push(s.to_string());
        }
        if let Some(u) = until {
            sql.push_str(" AND created_at <= ?");
            binds.push(u.to_string());
        }

        sql.push_str(" GROUP BY model, provider ORDER BY total_tokens DESC");

        let mut q = sqlx::query_as::<_, TokenUsageAggRow>(&sql);
        for b in &binds {
            q = q.bind(b);
        }

        q.fetch_all(&self.pool)
            .await
            .context("Failed to query token usage")
    }

    pub async fn query_token_usage_daily(
        &self,
        session_key: Option<&str>,
        since: Option<&str>,
        until: Option<&str>,
    ) -> Result<Vec<TokenUsageDailyRow>> {
        let mut sql = String::from(
            "SELECT DATE(created_at) as day,
                    SUM(prompt_tokens) as prompt_tokens,
                    SUM(completion_tokens) as completion_tokens,
                    SUM(total_tokens) as total_tokens,
                    COUNT(*) as call_count
             FROM token_usage WHERE 1=1",
        );
        let mut binds: Vec<String> = Vec::new();

        if let Some(s) = session_key {
            sql.push_str(" AND session_key = ?");
            binds.push(s.to_string());
        }
        if let Some(s) = since {
            sql.push_str(" AND created_at >= ?");
            binds.push(s.to_string());
        }
        if let Some(u) = until {
            sql.push_str(" AND created_at <= ?");
            binds.push(u.to_string());
        }

        sql.push_str(" GROUP BY DATE(created_at) ORDER BY day ASC");

        let mut q = sqlx::query_as::<_, TokenUsageDailyRow>(&sql);
        for b in &binds {
            q = q.bind(b);
        }

        q.fetch_all(&self.pool)
            .await
            .context("Failed to query daily token usage")
    }

    // ═══════════════════════════════════════════════════════════════
    // EMAIL PENDING — assisted approval flow
    // ═══════════════════════════════════════════════════════════════

    /// Insert a new email pending record (draft awaiting approval).
    pub async fn insert_email_pending(&self, row: &EmailPendingRow) -> Result<()> {
        sqlx::query(
            "INSERT INTO email_pending (id, account_name, from_address, subject, body_preview,
             message_id, draft_response, status, notify_session_key, created_at,
             profile_id, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)",
        )
        .bind(&row.id)
        .bind(&row.account_name)
        .bind(&row.from_address)
        .bind(&row.subject)
        .bind(&row.body_preview)
        .bind(&row.message_id)
        .bind(&row.draft_response)
        .bind(&row.status)
        .bind(&row.notify_session_key)
        .bind(row.profile_id)
        .bind(&row.user_id)
        .execute(&self.pool)
        .await
        .context("Failed to insert email_pending")?;
        Ok(())
    }

    /// Update the draft response for an existing pending email.
    pub async fn update_email_pending_draft(&self, id: &str, draft: &str) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE email_pending SET draft_response = ?, updated_at = datetime('now')
             WHERE id = ? AND status = 'pending'",
        )
        .bind(draft)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("Failed to update email_pending draft")?;
        Ok(result.rows_affected() > 0)
    }

    /// Change status of a pending email (e.g. pending → sent, pending → rejected).
    /// Only updates rows that are currently 'pending' for atomicity.
    pub async fn update_email_pending_status(&self, id: &str, status: &str) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE email_pending SET status = ?, updated_at = datetime('now')
             WHERE id = ? AND status = 'pending'",
        )
        .bind(status)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("Failed to update email_pending status")?;
        Ok(result.rows_affected() > 0)
    }

    /// Load all pending emails for a given notify session key, ordered FIFO.
    pub async fn load_pending_for_notify(&self, notify_key: &str) -> Result<Vec<EmailPendingRow>> {
        let rows = sqlx::query_as::<_, EmailPendingRow>(
            "SELECT id, account_name, from_address, subject, body_preview,
                    message_id, draft_response, status, notify_session_key,
                    created_at, updated_at, profile_id, user_id
             FROM email_pending
             WHERE notify_session_key = ? AND status = 'pending'
             ORDER BY created_at ASC",
        )
        .bind(notify_key)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load pending emails for notify")?;
        Ok(rows)
    }

    /// Load all pending email drafts (for startup recovery / re-notification).
    pub async fn load_all_pending_emails(&self) -> Result<Vec<EmailPendingRow>> {
        let rows = sqlx::query_as::<_, EmailPendingRow>(
            "SELECT id, account_name, from_address, subject, body_preview,
                    message_id, draft_response, status, notify_session_key,
                    created_at, updated_at, profile_id, user_id
             FROM email_pending
             WHERE status = 'pending'
             ORDER BY created_at ASC",
        )
        .fetch_all(&self.pool)
        .await
        .context("Failed to load all pending emails")?;
        Ok(rows)
    }

    /// Expire pending drafts older than the given number of days.
    /// Returns the count of expired rows.
    pub async fn expire_old_pending_emails(&self, max_age_days: i64) -> Result<u64> {
        let result = sqlx::query(
            "UPDATE email_pending SET status = 'expired', updated_at = datetime('now')
             WHERE status = 'pending'
               AND created_at < datetime('now', '-' || ? || ' days')",
        )
        .bind(max_age_days)
        .execute(&self.pool)
        .await
        .context("Failed to expire old pending emails")?;
        Ok(result.rows_affected())
    }

    /// Load a single email_pending record by ID.
    pub async fn load_email_pending_by_id(&self, id: &str) -> Result<Option<EmailPendingRow>> {
        let row = sqlx::query_as::<_, EmailPendingRow>(
            "SELECT id, account_name, from_address, subject, body_preview,
                    message_id, draft_response, status, notify_session_key,
                    created_at, updated_at, profile_id, user_id
             FROM email_pending WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to load email_pending by id")?;
        Ok(row)
    }

    // ── SKL-6: Skill Audit Logging ──────────────────────────────────

    /// Insert a skill activation audit record.
    ///
    /// activation_type: "tool_call" or "slash_command"
    pub async fn insert_skill_audit(
        &self,
        skill_name: &str,
        channel: &str,
        query: &str,
        activation_type: &str,
        profile_id: Option<i64>,
    ) -> Result<i64> {
        let row = sqlx::query_scalar::<_, i64>(
            "INSERT INTO skill_audit (skill_name, channel, query, activation_type, profile_id)
             VALUES (?, ?, ?, ?, ?)
             RETURNING id",
        )
        .bind(skill_name)
        .bind(channel)
        .bind(query)
        .bind(activation_type)
        .bind(profile_id)
        .fetch_one(&self.pool)
        .await
        .context("Failed to insert skill audit")?;
        Ok(row)
    }

    /// List recent skill audit entries, optionally filtered by profile.
    pub async fn list_skill_audits(
        &self,
        limit: i64,
        profile_id: Option<i64>,
    ) -> Result<Vec<SkillAuditRow>> {
        let profile_filter = match profile_id {
            Some(_) => " WHERE profile_id IS NULL OR profile_id = ?",
            None => "",
        };
        let sql = format!(
            "SELECT id, timestamp, skill_name, channel, query, activation_type, success \
             FROM skill_audit{profile_filter} ORDER BY id DESC LIMIT ?"
        );
        let mut q = sqlx::query_as::<_, SkillAuditRow>(&sql);
        if let Some(pid) = profile_id {
            q = q.bind(pid);
        }
        let rows = q
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .context("Failed to list skill audits")?;
        Ok(rows)
    }

    // ── VLT-4: Vault Access Audit Logging ─────────────────────────

    /// Insert a vault access audit record.
    pub async fn insert_vault_access(
        &self,
        key_name: &str,
        action: &str,
        source: &str,
        success: bool,
        user_agent: Option<&str>,
        profile_id: Option<i64>,
    ) -> Result<i64> {
        let row = sqlx::query_scalar::<_, i64>(
            "INSERT INTO vault_access_log (key_name, action, source, success, user_agent, profile_id)
             VALUES (?, ?, ?, ?, ?, ?)
             RETURNING id",
        )
        .bind(key_name)
        .bind(action)
        .bind(source)
        .bind(success as i32)
        .bind(user_agent)
        .bind(profile_id)
        .fetch_one(&self.pool)
        .await
        .context("Failed to insert vault access log")?;
        Ok(row)
    }

    /// List recent vault access log entries, optionally filtered by profile.
    pub async fn list_vault_access_log(
        &self,
        limit: i64,
        profile_id: Option<i64>,
    ) -> Result<Vec<VaultAccessLogRow>> {
        let profile_filter = match profile_id {
            Some(_) => " WHERE profile_id IS NULL OR profile_id = ?",
            None => "",
        };
        let sql = format!(
            "SELECT id, timestamp, key_name, action, source, success, user_agent \
             FROM vault_access_log{profile_filter} ORDER BY id DESC LIMIT ?"
        );
        let mut q = sqlx::query_as::<_, VaultAccessLogRow>(&sql);
        if let Some(pid) = profile_id {
            q = q.bind(pid);
        }
        let rows = q
            .bind(limit)
            .fetch_all(&self.pool)
            .await
            .context("Failed to list vault access log")?;
        Ok(rows)
    }

    // ── Browser allowed sites ───────────────────────────────────────

    /// List all browser allowed sites, ordered by domain.
    pub async fn list_browser_allowed_sites(&self) -> Result<Vec<BrowserAllowedSiteRow>> {
        let rows = sqlx::query_as::<_, BrowserAllowedSiteRow>(
            "SELECT domain, mode, added_by, created_at, notes
             FROM browser_allowed_sites ORDER BY domain",
        )
        .fetch_all(&self.pool)
        .await
        .context("Failed to list browser allowed sites")?;
        Ok(rows)
    }

    /// Get a single browser allowed site by domain.
    pub async fn get_browser_allowed_site(
        &self,
        domain: &str,
    ) -> Result<Option<BrowserAllowedSiteRow>> {
        let row = sqlx::query_as::<_, BrowserAllowedSiteRow>(
            "SELECT domain, mode, added_by, created_at, notes
             FROM browser_allowed_sites WHERE domain = ?",
        )
        .bind(domain)
        .fetch_optional(&self.pool)
        .await
        .context("Failed to get browser allowed site")?;
        Ok(row)
    }

    /// Insert or update a browser allowed site.
    pub async fn upsert_browser_allowed_site(
        &self,
        domain: &str,
        mode: &str,
        added_by: &str,
        notes: Option<&str>,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO browser_allowed_sites (domain, mode, added_by, notes)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(domain) DO UPDATE SET mode = excluded.mode, notes = excluded.notes",
        )
        .bind(domain)
        .bind(mode)
        .bind(added_by)
        .bind(notes)
        .execute(&self.pool)
        .await
        .context("Failed to upsert browser allowed site")?;
        Ok(())
    }

    /// Delete a browser allowed site. Returns true if a row was removed.
    pub async fn delete_browser_allowed_site(&self, domain: &str) -> Result<bool> {
        let result = sqlx::query("DELETE FROM browser_allowed_sites WHERE domain = ?")
            .bind(domain)
            .execute(&self.pool)
            .await
            .context("Failed to delete browser allowed site")?;
        Ok(result.rows_affected() > 0)
    }

    /// Load the allowlist as a fast domain→mode lookup map.
    ///
    /// Used to populate in-memory caches in the browser task planner
    /// and browser tool (avoids async DB calls on the hot path).
    pub async fn load_browser_allowlist(
        &self,
    ) -> Result<std::collections::HashMap<String, String>> {
        let rows =
            sqlx::query_as::<_, (String, String)>("SELECT domain, mode FROM browser_allowed_sites")
                .fetch_all(&self.pool)
                .await
                .context("Failed to load browser allowlist")?;
        Ok(rows.into_iter().collect())
    }

    // ── Task checkpoints (execution persistence) ──────────────

    /// Persist or update a task checkpoint for crash recovery.
    pub async fn upsert_task_checkpoint(
        &self,
        checkpoint: &crate::agent::TaskCheckpoint,
    ) -> Result<()> {
        let files_json =
            serde_json::to_string(&checkpoint.files_created).unwrap_or_else(|_| "[]".to_string());
        let data_json =
            serde_json::to_string(&checkpoint.completed_data).unwrap_or_else(|_| "[]".to_string());

        sqlx::query(
            "INSERT INTO task_checkpoints (id, session_key, profile_id, channel, chat_id,
                user_prompt, plan_json, files_created, completed_data, status, iteration,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
             ON CONFLICT(id) DO UPDATE SET
                plan_json = excluded.plan_json,
                files_created = excluded.files_created,
                completed_data = excluded.completed_data,
                status = excluded.status,
                iteration = excluded.iteration,
                updated_at = datetime('now')",
        )
        .bind(&checkpoint.id)
        .bind(&checkpoint.session_key)
        .bind(&checkpoint.profile_id)
        .bind(&checkpoint.channel)
        .bind(&checkpoint.chat_id)
        .bind(&checkpoint.user_prompt)
        .bind(&checkpoint.plan_json)
        .bind(&files_json)
        .bind(&data_json)
        .bind(&checkpoint.status)
        .bind(checkpoint.iteration as i64)
        .execute(&self.pool)
        .await
        .context("Failed to upsert task checkpoint")?;
        Ok(())
    }

    /// Load interrupted tasks for a given session or channel+chat_id.
    pub async fn load_interrupted_tasks(
        &self,
        session_key: &str,
    ) -> Result<Vec<crate::agent::TaskCheckpoint>> {
        let rows = sqlx::query_as::<
            _,
            (
                String,
                String,
                Option<String>,
                String,
                String,
                String,
                String,
                String,
                String,
                String,
                i64,
            ),
        >(
            "SELECT id, session_key, profile_id, channel, chat_id,
                    user_prompt, plan_json, files_created, completed_data, status, iteration
             FROM task_checkpoints
             WHERE session_key = ? AND status IN ('running', 'paused')
             ORDER BY updated_at DESC",
        )
        .bind(session_key)
        .fetch_all(&self.pool)
        .await
        .context("Failed to load interrupted tasks")?;

        Ok(rows
            .into_iter()
            .map(|r| crate::agent::TaskCheckpoint {
                id: r.0,
                session_key: r.1,
                profile_id: r.2,
                channel: r.3,
                chat_id: r.4,
                user_prompt: r.5,
                plan_json: r.6,
                files_created: serde_json::from_str(&r.7).unwrap_or_default(),
                completed_data: serde_json::from_str(&r.8).unwrap_or_default(),
                status: r.9,
                iteration: r.10 as u32,
            })
            .collect())
    }

    /// Delete a task checkpoint (after completion or cancellation).
    pub async fn delete_task_checkpoint(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM task_checkpoints WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("Failed to delete task checkpoint")?;
        Ok(())
    }

    /// Delete a task checkpoint by session key (after successful completion).
    pub async fn delete_task_checkpoint_by_session(&self, session_key: &str) -> Result<()> {
        sqlx::query("DELETE FROM task_checkpoints WHERE session_key = ?")
            .bind(session_key)
            .execute(&self.pool)
            .await
            .context("Failed to delete task checkpoint by session")?;
        Ok(())
    }

    /// Clean up stale task checkpoints (orphans from crashes).
    /// Removes completed tasks and running tasks older than 7 days.
    pub async fn cleanup_stale_task_checkpoints(&self) -> Result<u64> {
        let result = sqlx::query(
            "DELETE FROM task_checkpoints
             WHERE status IN ('completed', 'cancelled')
             OR (status = 'running' AND updated_at < datetime('now', '-7 days'))",
        )
        .execute(&self.pool)
        .await
        .context("Failed to cleanup stale task checkpoints")?;
        Ok(result.rows_affected())
    }

    // ─── Settings KV (DB overrides TOML) ──────────────────────────

    /// Load a config section's JSON blob from the settings table.
    ///
    /// Returns `None` when no row exists for this section (TOML default
    /// should be used). Returns `Some(json_string)` when a DB override
    /// is present.
    pub async fn get_settings_section(&self, section: &str) -> Result<Option<String>> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value_json FROM settings WHERE section = ?")
                .bind(section)
                .fetch_optional(&self.pool)
                .await
                .with_context(|| format!("Failed to read settings section '{section}'"))?;
        Ok(row.map(|(json,)| json))
    }

    /// Persist a config section as a JSON blob in the settings table.
    ///
    /// Uses `INSERT OR REPLACE` so the first write creates the row and
    /// subsequent writes update it. The `updated_at` column is always
    /// refreshed so operators can tell when a section was last changed.
    pub async fn set_settings_section(&self, section: &str, value_json: &str) -> Result<()> {
        sqlx::query(
            "INSERT INTO settings (section, value_json, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(section) DO UPDATE SET
               value_json = excluded.value_json,
               updated_at = excluded.updated_at",
        )
        .bind(section)
        .bind(value_json)
        .execute(&self.pool)
        .await
        .with_context(|| format!("Failed to write settings section '{section}'"))?;
        Ok(())
    }

    // ── Cognition metrics ──────────────────────────────────────────

    /// Record one cognition phase run (success or failure).
    pub async fn insert_cognition_metric(
        &self,
        model: &str,
        success: bool,
        elapsed_ms: u64,
        failure_reason: Option<&str>,
        tool_count: usize,
    ) -> Result<()> {
        sqlx::query(
            "INSERT INTO cognition_metrics (model, success, elapsed_ms, failure_reason, tool_count)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(model)
        .bind(success as i32)
        .bind(elapsed_ms as i64)
        .bind(failure_reason)
        .bind(tool_count as i64)
        .execute(&self.pool)
        .await
        .context("Failed to insert cognition metric")?;
        Ok(())
    }

    /// Query aggregated cognition metrics per model.
    ///
    /// Returns `(model, total_calls, successes, avg_elapsed_ms)` rows,
    /// optionally filtered to the last N days.
    pub async fn query_cognition_metrics(
        &self,
        last_days: Option<u32>,
    ) -> Result<Vec<CognitionMetricAggRow>> {
        let sql = if let Some(days) = last_days {
            format!(
                "SELECT model,
                        COUNT(*) as total_calls,
                        SUM(success) as successes,
                        CAST(AVG(elapsed_ms) AS INTEGER) as avg_elapsed_ms
                 FROM cognition_metrics
                 WHERE timestamp >= datetime('now', '-{days} days')
                 GROUP BY model
                 ORDER BY total_calls DESC"
            )
        } else {
            "SELECT model,
                    COUNT(*) as total_calls,
                    SUM(success) as successes,
                    CAST(AVG(elapsed_ms) AS INTEGER) as avg_elapsed_ms
             FROM cognition_metrics
             GROUP BY model
             ORDER BY total_calls DESC"
                .to_string()
        };
        let rows = sqlx::query_as::<_, CognitionMetricAggRow>(&sql)
            .fetch_all(&self.pool)
            .await
            .context("Failed to query cognition metrics")?;
        Ok(rows)
    }
}

/// Skill audit log row.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SkillAuditRow {
    pub id: i64,
    pub timestamp: String,
    pub skill_name: String,
    pub channel: String,
    pub query: Option<String>,
    pub activation_type: String,
    pub success: i64,
}

/// Vault access log row (VLT-4).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct VaultAccessLogRow {
    pub id: i64,
    pub timestamp: String,
    pub key_name: String,
    pub action: String,
    pub source: String,
    pub success: i64,
    pub user_agent: Option<String>,
}

/// Aggregated cognition metric row (per model).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct CognitionMetricAggRow {
    pub model: String,
    pub total_calls: i64,
    pub successes: i64,
    pub avg_elapsed_ms: i64,
}

/// Result of memory cleanup operation.
#[derive(Debug, Default)]
pub struct MemoryCleanupResult {
    pub messages_deleted: u64,
    pub chunks_deleted: u64,
}

// --- Row types for sqlx ---

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub key: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_consolidated: i64,
    pub metadata: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionListRow {
    pub key: String,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: String,
    pub message_count: i64,
    pub first_user_message: Option<String>,
    pub last_message_preview: Option<String>,
    pub last_message_at: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MessageRow {
    pub id: i64,
    pub session_key: String,
    pub role: String,
    pub content: String,
    pub tools_used: String,
    pub timestamp: String,
}

#[derive(Debug, sqlx::FromRow)]
pub struct MemoryRow {
    pub id: i64,
    pub session_key: Option<String>,
    pub content: String,
    pub memory_type: String,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemoryChunkRow {
    pub id: i64,
    pub date: String,
    pub source: String,
    pub heading: String,
    pub content: String,
    pub memory_type: String,
    pub created_at: String,
    /// Contact associated with this memory chunk (NULL = global).
    pub contact_id: Option<i64>,
    /// Agent that created this chunk (NULL = global, visible to all agents).
    pub agent_id: Option<String>,
    /// Importance score (1-5). 1=trivial, 3=normal, 5=critical.
    pub importance: i32,
    /// Profile this chunk belongs to (NULL = global, visible to all profiles).
    pub profile_id: Option<i64>,
    /// Namespace for access control (default: _private).
    #[sqlx(default)]
    pub namespace: String,
    /// User that owns this memory chunk.
    #[sqlx(default)]
    pub user_id: Option<String>,
}

/// A hierarchical summary of memory chunks over a time period.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MemorySummaryRow {
    pub id: i64,
    /// Period type: "week" or "month".
    pub period: String,
    /// Start date (inclusive), YYYY-MM-DD.
    pub start_date: String,
    /// End date (inclusive), YYYY-MM-DD.
    pub end_date: String,
    pub content: String,
    pub contact_id: Option<i64>,
    pub agent_id: Option<String>,
    pub created_at: String,
}

/// A trusted device record (REM-3).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct TrustedDeviceRow {
    pub id: String,
    pub user_id: String,
    pub fingerprint: String,
    pub name: String,
    pub user_agent: String,
    pub ip_at_login: String,
    pub created_at: String,
    /// NULL = pending approval, non-NULL = approved.
    pub approved_at: Option<String>,
    /// 6-digit approval code (cleared after approval).
    #[serde(skip_serializing)]
    pub approval_code: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct MobilePairingSessionRow {
    pub id: String,
    pub user_id: String,
    pub status: String,
    #[serde(skip_serializing)]
    pub nonce_hash: String,
    pub base_url: String,
    pub server_fingerprint: String,
    pub device_name: Option<String>,
    pub platform: Option<String>,
    pub app_version: Option<String>,
    pub device_public_key: Option<String>,
    pub device_push_token: Option<String>,
    pub device_id: Option<String>,
    pub created_at: String,
    pub claimed_at: Option<String>,
    pub approved_at: Option<String>,
    pub completed_at: Option<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct MobileDeviceRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub platform: String,
    pub app_version: Option<String>,
    #[serde(skip_serializing)]
    pub public_key: Option<String>,
    #[serde(skip_serializing)]
    pub push_token: Option<String>,
    #[serde(skip_serializing)]
    pub token: String,
    pub can_emergency_stop: bool,
    pub server_fingerprint_at_pair: String,
    pub last_seen_at: Option<String>,
    pub created_at: String,
    pub revoked_at: Option<String>,
    pub is_notify_target: bool,
}

// ─── RAG Knowledge Base Row Types ────────────────────────────────

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct RagSourceRow {
    pub id: i64,
    pub file_path: String,
    pub file_name: String,
    pub file_hash: String,
    pub doc_type: String,
    pub file_size: i64,
    pub chunk_count: i64,
    pub status: String,
    pub error_message: Option<String>,
    pub source_channel: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Namespace for access control (default: _private).
    #[sqlx(default)]
    pub namespace: String,
    /// Profile that owns this source (NULL = global).
    #[sqlx(default)]
    pub profile_id: Option<i64>,
    /// User that owns this source.
    #[sqlx(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct RagChunkRow {
    pub id: i64,
    pub source_id: i64,
    pub chunk_index: i64,
    pub heading: String,
    pub content: String,
    pub token_count: i64,
    pub sensitive: bool,
    pub created_at: String,
    /// Profile this chunk belongs to (NULL = global, visible to all profiles).
    pub profile_id: Option<i64>,
    /// User that owns this chunk.
    #[sqlx(default)]
    pub user_id: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AutomationRow {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub schedule: String,
    pub enabled: bool,
    pub status: String,
    pub deliver_to: Option<String>,
    pub trigger_kind: String,
    pub trigger_value: Option<String>,
    pub last_run: Option<String>,
    pub last_result: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub plan_json: Option<String>,
    pub dependencies_json: String,
    pub plan_version: i64,
    pub validation_errors: Option<String>,
    pub workflow_steps_json: Option<String>,
    pub flow_json: Option<String>,
    pub profile_id: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct AutomationUpdate {
    pub name: Option<String>,
    pub prompt: Option<String>,
    pub schedule: Option<String>,
    pub enabled: Option<bool>,
    pub status: Option<String>,
    /// Use `Some(None)` to clear `deliver_to`.
    pub deliver_to: Option<Option<String>>,
    pub trigger_kind: Option<String>,
    /// Use `Some(None)` to clear trigger value.
    pub trigger_value: Option<Option<String>>,
    pub last_result: Option<Option<String>>,
    /// Use `Some(None)` to clear plan JSON.
    pub plan_json: Option<Option<String>>,
    /// Use `Some(None)` to reset dependencies to an empty list.
    pub dependencies_json: Option<Option<String>>,
    pub plan_version: Option<i64>,
    /// Use `Some(None)` to clear validation errors.
    pub validation_errors: Option<Option<String>>,
    /// Use `Some(None)` to clear workflow steps.
    pub workflow_steps_json: Option<Option<String>>,
    /// Use `Some(None)` to clear flow_json (visual graph).
    pub flow_json: Option<Option<String>>,
    pub touch_last_run: bool,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct AutomationRunRow {
    pub id: String,
    pub automation_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub result: Option<String>,
}

// ═══════════════════════════════════════════════════════════════
// USER SYSTEM ROW TYPES
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub roles: String, // JSON array
    pub password_hash: Option<String>,
    pub enabled: i64,
    pub must_change_password: i64,
    pub created_at: String,
    pub updated_at: String,
    pub metadata: String, // JSON object
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserIdentityRow {
    pub id: i64,
    pub user_id: String,
    pub channel: String,
    pub platform_id: String,
    pub display_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct WebhookTokenRow {
    pub token: String,
    pub user_id: String,
    pub name: String,
    pub enabled: bool,
    pub scope: String,
    pub last_used: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct TokenUsageAggRow {
    pub model: String,
    pub provider: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub call_count: i64,
}

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct TokenUsageDailyRow {
    pub day: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub call_count: i64,
}

// ═══════════════════════════════════════════════════════════════
// EMAIL PENDING (assisted approval flow)
// ═══════════════════════════════════════════════════════════════

#[derive(Debug, Clone, sqlx::FromRow, Serialize)]
pub struct EmailPendingRow {
    pub id: String,
    pub account_name: String,
    pub from_address: String,
    pub subject: Option<String>,
    pub body_preview: Option<String>,
    pub message_id: Option<String>,
    pub draft_response: Option<String>,
    pub status: String, // pending | sent | rejected
    pub notify_session_key: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    /// Profile scoping (None = global).
    pub profile_id: Option<i64>,
    /// Owner user ID.
    pub user_id: Option<String>,
}

// ═══════════════════════════════════════════════════════════════
// BROWSER ALLOWED SITES
// ═══════════════════════════════════════════════════════════════

/// A browser allowed-site record with rendering mode.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct BrowserAllowedSiteRow {
    pub domain: String,
    /// `"headless"`, `"visible"`, or `"auto"`.
    pub mode: String,
    /// `"user"`, `"system"`, or `"approval"`.
    pub added_by: String,
    pub created_at: String,
    pub notes: Option<String>,
}

/// Split SQL into individual statements, respecting BEGIN...END blocks.
///
/// Standard `split(';')` breaks triggers and other compound statements
/// that contain semicolons inside `BEGIN...END` blocks. This parser
/// tracks nesting depth to correctly handle `CREATE TRIGGER ... BEGIN ... END;`.
fn split_sql_statements(sql: &str) -> Vec<String> {
    let mut statements = Vec::new();
    let mut current = String::new();
    let mut depth = 0_usize; // BEGIN/END nesting depth

    for line in sql.lines() {
        let upper = line.trim().to_uppercase();

        // Track BEGIN/END nesting
        if upper.ends_with("BEGIN") || upper == "BEGIN" {
            depth += 1;
        }

        current.push_str(line);
        current.push('\n');

        if depth > 0 {
            // Inside a BEGIN block — check for END
            if upper.starts_with("END;") || upper == "END;" {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    let stmt = current.trim().trim_end_matches(';').to_string();
                    if !stmt.is_empty() {
                        statements.push(stmt);
                    }
                    current.clear();
                }
            }
        } else if line.contains(';') {
            // Outside BEGIN block and line has semicolons — split
            let accumulated = std::mem::take(&mut current);
            let parts: Vec<&str> = accumulated.split(';').collect();
            for (i, part) in parts.iter().enumerate() {
                let trimmed = part.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if i < parts.len() - 1 {
                    // Complete statement (before a ';')
                    statements.push(trimmed.to_string());
                } else {
                    // Last fragment — carry over to next line
                    current = format!("{trimmed}\n");
                }
            }
        }
    }

    // Any remaining content
    let remaining = current.trim().to_string();
    if !remaining.is_empty() {
        statements.push(remaining);
    }

    statements
}

// ── Trait implementations ───────────────────────────────────────
// Each trait impl delegates to the identically-named inherent method
// via `Database::method(self, ...)` to avoid trait-vs-inherent ambiguity.

#[async_trait::async_trait]
impl super::traits::MemoryStore for Database {
    async fn insert_memory(
        &self,
        session_key: Option<&str>,
        content: &str,
        memory_type: &str,
    ) -> Result<()> {
        Database::insert_memory(self, session_key, content, memory_type).await
    }
    async fn load_memories(&self, session_key: &str) -> Result<Vec<MemoryRow>> {
        Database::load_memories(self, session_key).await
    }
    async fn load_long_term_memory(&self) -> Result<Option<String>> {
        Database::load_long_term_memory(self).await
    }
    async fn upsert_long_term_memory(&self, content: &str) -> Result<()> {
        Database::upsert_long_term_memory(self, content).await
    }
    async fn insert_memory_chunk(
        &self,
        date: &str,
        source: &str,
        heading: &str,
        content: &str,
        memory_type: &str,
        contact_id: Option<i64>,
        agent_id: Option<&str>,
        importance: i32,
        profile_id: Option<i64>,
        user_id: Option<&str>,
    ) -> Result<i64> {
        Database::insert_memory_chunk(
            self,
            date,
            source,
            heading,
            content,
            memory_type,
            contact_id,
            agent_id,
            importance,
            profile_id,
            user_id,
        )
        .await
    }
    async fn load_chunks_by_ids(&self, ids: &[i64]) -> Result<Vec<MemoryChunkRow>> {
        Database::load_chunks_by_ids(self, ids).await
    }
    async fn fts5_search(&self, query: &str, limit: usize) -> Result<Vec<(i64, f64)>> {
        Database::fts5_search(self, query, limit).await
    }
    async fn count_memory_chunks(&self) -> Result<i64> {
        Database::count_memory_chunks(self).await
    }
    async fn count_memory_chunks_for_profile(&self, profile_id: i64) -> Result<i64> {
        Database::count_memory_chunks_for_profile(self, profile_id).await
    }
    async fn list_memory_history(
        &self,
        limit: i64,
        offset: i64,
        profile_id: Option<i64>,
    ) -> Result<Vec<MemoryChunkRow>> {
        Database::list_memory_history(self, limit, offset, profile_id).await
    }
    async fn load_all_memory_chunks(&self) -> Result<Vec<MemoryChunkRow>> {
        Database::load_all_memory_chunks(self).await
    }
    async fn prune_memory_chunks_to_budget(
        &self,
        keep_count: u32,
        profile_id: Option<i64>,
    ) -> Result<Vec<i64>> {
        Database::prune_memory_chunks_to_budget(self, keep_count, profile_id).await
    }
    async fn load_chunks_in_range(
        &self,
        start_date: &str,
        end_date: &str,
    ) -> Result<Vec<MemoryChunkRow>> {
        Database::load_chunks_in_range(self, start_date, end_date).await
    }
    async fn reset_all_memory(&self) -> Result<()> {
        Database::reset_all_memory(self).await
    }
    async fn insert_memory_summary(
        &self,
        period: &str,
        start_date: &str,
        end_date: &str,
        content: &str,
        contact_id: Option<i64>,
        agent_id: Option<&str>,
        profile_id: Option<i64>,
        user_id: Option<&str>,
    ) -> Result<i64> {
        Database::insert_memory_summary(
            self, period, start_date, end_date, content, contact_id, agent_id, profile_id, user_id,
        )
        .await
    }
    async fn has_memory_summary(&self, period: &str, start_date: &str) -> Result<bool> {
        Database::has_memory_summary(self, period, start_date).await
    }
    async fn load_summaries_in_range(
        &self,
        start_date: &str,
        end_date: &str,
    ) -> Result<Vec<MemorySummaryRow>> {
        Database::load_summaries_in_range(self, start_date, end_date).await
    }
}

#[async_trait::async_trait]
impl super::traits::RagStore for Database {
    async fn insert_rag_source(
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
        Database::insert_rag_source(
            self,
            file_path,
            file_name,
            file_hash,
            doc_type,
            file_size,
            source_channel,
            profile_id,
            user_id,
            namespace,
        )
        .await
    }
    async fn find_rag_source_by_hash(&self, file_hash: &str) -> Result<Option<RagSourceRow>> {
        Database::find_rag_source_by_hash(self, file_hash).await
    }
    async fn find_rag_source_by_path(&self, file_path: &str) -> Result<Option<RagSourceRow>> {
        Database::find_rag_source_by_path(self, file_path).await
    }
    async fn update_rag_source_status(
        &self,
        id: i64,
        status: &str,
        error_message: Option<&str>,
        chunk_count: i64,
    ) -> Result<()> {
        Database::update_rag_source_status(self, id, status, error_message, chunk_count).await
    }
    async fn delete_rag_source(&self, id: i64) -> Result<bool> {
        Database::delete_rag_source(self, id).await
    }
    async fn delete_rag_source_for_user(&self, id: i64, user_id: &str) -> Result<bool> {
        Database::delete_rag_source_for_user(self, id, user_id).await
    }
    async fn list_rag_sources(&self) -> Result<Vec<RagSourceRow>> {
        Database::list_rag_sources(self).await
    }
    async fn list_rag_sources_for_profile(&self, profile_id: i64) -> Result<Vec<RagSourceRow>> {
        Database::list_rag_sources_for_profile(self, profile_id).await
    }
    async fn list_rag_sources_for_user(
        &self,
        user_id: &str,
        profile_id: Option<i64>,
    ) -> Result<Vec<RagSourceRow>> {
        Database::list_rag_sources_for_user(self, user_id, profile_id).await
    }
    async fn load_rag_source_for_user(
        &self,
        source_id: i64,
        user_id: &str,
    ) -> Result<Option<RagSourceRow>> {
        Database::load_rag_source_for_user(self, source_id, user_id).await
    }
    async fn count_rag_sources(&self) -> Result<i64> {
        Database::count_rag_sources(self).await
    }
    async fn count_rag_sources_for_user(
        &self,
        user_id: &str,
        profile_id: Option<i64>,
    ) -> Result<i64> {
        Database::count_rag_sources_for_user(self, user_id, profile_id).await
    }
    async fn insert_rag_chunk(
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
        Database::insert_rag_chunk(
            self,
            source_id,
            chunk_index,
            heading,
            content,
            token_count,
            sensitive,
            profile_id,
            user_id,
        )
        .await
    }
    async fn update_rag_chunk_heading(&self, chunk_id: i64, heading: &str) -> Result<()> {
        Database::update_rag_chunk_heading(self, chunk_id, heading).await
    }
    async fn load_rag_chunks_by_ids(&self, ids: &[i64]) -> Result<Vec<RagChunkRow>> {
        Database::load_rag_chunks_by_ids(self, ids).await
    }
    async fn load_rag_chunk_for_user(
        &self,
        chunk_id: i64,
        user_id: &str,
    ) -> Result<Option<RagChunkRow>> {
        Database::load_rag_chunk_for_user(self, chunk_id, user_id).await
    }
    async fn rag_fts5_search(&self, query: &str, limit: usize) -> Result<Vec<(i64, f64)>> {
        Database::rag_fts5_search(self, query, limit).await
    }
    async fn count_rag_chunks(&self) -> Result<i64> {
        Database::count_rag_chunks(self).await
    }
    async fn count_rag_chunks_for_user(
        &self,
        user_id: &str,
        profile_id: Option<i64>,
    ) -> Result<i64> {
        Database::count_rag_chunks_for_user(self, user_id, profile_id).await
    }
    async fn load_rag_chunks_by_source(&self, source_id: i64) -> Result<Vec<RagChunkRow>> {
        Database::load_rag_chunks_by_source(self, source_id).await
    }
    async fn delete_rag_chunks_by_source(&self, source_id: i64) -> Result<u64> {
        Database::delete_rag_chunks_by_source(self, source_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn test_db() -> (Database, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let db = Database::open(&db_path).await.unwrap();
        (db, dir)
    }

    #[test]
    fn test_split_sql_with_triggers() {
        let sql = r#"
CREATE TABLE IF NOT EXISTS foo (id INTEGER PRIMARY KEY);
CREATE INDEX IF NOT EXISTS idx_foo ON foo(id);

CREATE TRIGGER IF NOT EXISTS foo_ai AFTER INSERT ON foo BEGIN
    INSERT INTO bar(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS foo_ad AFTER DELETE ON foo BEGIN
    INSERT INTO bar(bar, rowid, content) VALUES ('delete', old.id, old.content);
END;
"#;
        let stmts = split_sql_statements(sql);
        assert_eq!(stmts.len(), 4, "Expected 4 statements, got: {stmts:#?}");
        assert!(stmts[0].contains("CREATE TABLE"));
        assert!(stmts[1].contains("CREATE INDEX"));
        assert!(stmts[2].contains("CREATE TRIGGER") && stmts[2].contains("AFTER INSERT"));
        assert!(stmts[3].contains("CREATE TRIGGER") && stmts[3].contains("AFTER DELETE"));
    }

    #[test]
    fn test_all_sql_migrations_are_registered() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let migrations_dir = root.join("migrations");
        let source = std::fs::read_to_string(root.join("src/storage/db.rs")).unwrap();

        let mut missing = Vec::new();
        for entry in std::fs::read_dir(migrations_dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("sql") {
                continue;
            }
            let name = path.file_stem().and_then(|stem| stem.to_str()).unwrap();
            if !source.contains(&format!("\"{name}\"")) {
                missing.push(name.to_string());
            }
        }

        missing.sort();
        assert!(
            missing.is_empty(),
            "SQL migration files not registered in Database::run_migrations: {missing:?}"
        );
    }

    #[tokio::test]
    async fn test_open_and_migrate() {
        let (db, _dir) = test_db().await;
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(db.pool())
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_idempotent_migrations() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("test.db");
        let _db1 = Database::open(&db_path).await.unwrap();
        let _db2 = Database::open(&db_path).await.unwrap();
    }

    #[tokio::test]
    async fn test_user_lifecycle_flags() {
        let (db, _dir) = test_db().await;

        db.create_user("user-lifecycle", "lifecycle", &["user"])
            .await
            .unwrap();
        let row = db.load_user("user-lifecycle").await.unwrap().unwrap();
        assert_eq!(row.enabled, 1);
        assert_eq!(row.must_change_password, 0);

        assert!(db.set_user_enabled("user-lifecycle", false).await.unwrap());
        assert!(db
            .set_user_must_change_password("user-lifecycle", true)
            .await
            .unwrap());

        let row = db.load_user("user-lifecycle").await.unwrap().unwrap();
        assert_eq!(row.enabled, 0);
        assert_eq!(row.must_change_password, 1);
    }

    #[tokio::test]
    async fn test_disabled_user_cannot_authenticate_with_webhook_token() {
        let (db, _dir) = test_db().await;

        db.create_user("disabled-token-user", "disabled-token", &["user"])
            .await
            .unwrap();
        db.create_webhook_token(
            "wh_disabled_user",
            "disabled-token-user",
            "Disabled User Token",
            "admin",
            None,
        )
        .await
        .unwrap();

        assert!(db
            .lookup_user_by_webhook_token("wh_disabled_user")
            .await
            .unwrap()
            .is_some());

        assert!(db
            .set_user_enabled("disabled-token-user", false)
            .await
            .unwrap());
        assert!(db
            .lookup_user_by_webhook_token("wh_disabled_user")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn test_reassigns_seed_admin_profiles_to_real_admin() {
        let (db, _dir) = test_db().await;

        db.create_user("real-admin", "real-admin", &["admin"])
            .await
            .unwrap();
        db.set_user_password_hash("real-admin", "salt:hash")
            .await
            .unwrap();

        Database::reassign_legacy_seed_admin_data(db.pool())
            .await
            .unwrap();

        let profiles = crate::profiles::db::load_profiles_for_user(db.pool(), "real-admin")
            .await
            .unwrap();
        assert!(profiles.iter().any(|profile| profile.slug == "default"));
        assert!(crate::profiles::db::load_profiles_for_user(
            db.pool(),
            crate::user::DEFAULT_ADMIN_USER_ID
        )
        .await
        .unwrap()
        .is_empty());
    }

    #[tokio::test]
    async fn test_session_crud() {
        let (db, _dir) = test_db().await;

        db.upsert_session("cli:default", 0).await.unwrap();

        let session = db.load_session("cli:default").await.unwrap().unwrap();
        assert_eq!(session.key, "cli:default");
        assert_eq!(session.last_consolidated, 0);

        db.upsert_session("cli:default", 5).await.unwrap();
        let session = db.load_session("cli:default").await.unwrap().unwrap();
        assert_eq!(session.last_consolidated, 5);
    }

    #[tokio::test]
    async fn test_web_chat_runs_persist_and_interrupt() {
        let (db, _dir) = test_db().await;
        db.upsert_session("web:test", 0).await.unwrap();

        let run = crate::web::run_state::WebChatRunSnapshot {
            run_id: "run_test_1".to_string(),
            session_key: "web:test".to_string(),
            status: "running".to_string(),
            user_message: "ciao".to_string(),
            effective_model: Some("openai/gpt-4o".to_string()),
            assistant_response: "parziale".to_string(),
            created_at: "2026-03-06T10:00:00Z".to_string(),
            updated_at: "2026-03-06T10:00:05Z".to_string(),
            events: vec![crate::web::run_state::WebChatRunEvent {
                event_type: "tool_start".to_string(),
                name: "browser".to_string(),
                tool_call: None,
            }],
            error: None,
            pending_blocks: Vec::new(),
        };

        db.upsert_web_chat_run(&run).await.unwrap();

        let restored = db
            .load_restorable_web_chat_run("web:test")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.run_id, run.run_id);
        assert_eq!(restored.status, "running");
        assert_eq!(restored.assistant_response, "parziale");
        assert_eq!(restored.events.len(), 1);

        // `interrupted` is no longer restorable (Option B: the final message
        // is already in chat history, replaying events for an interrupted run
        // would be confusing with no matching debugging need).
        let interrupted = db
            .mark_incomplete_web_chat_runs_interrupted()
            .await
            .unwrap();
        assert_eq!(interrupted, 1);

        let restored = db.load_restorable_web_chat_run("web:test").await.unwrap();
        assert!(
            restored.is_none(),
            "interrupted runs must not be returned by load_restorable_web_chat_run"
        );

        let deleted = db.delete_web_chat_runs("web:test").await.unwrap();
        assert_eq!(deleted, 1);
        assert!(db
            .load_restorable_web_chat_run("web:test")
            .await
            .unwrap()
            .is_none());
    }

    /// Regression test for the tab-reload double-render bug.
    ///
    /// Verifies the filter contract of `load_restorable_web_chat_run` (Option B):
    /// - `running` / `stopping` → restorable (live UI needs them)
    /// - `failed` → restorable (events are useful for debugging)
    /// - `completed` / `interrupted` → NOT restorable (history already has the text)
    #[tokio::test]
    async fn test_load_restorable_filter_by_status() {
        let (db, _dir) = test_db().await;

        fn make_run(
            run_id: &str,
            session_key: &str,
            status: &str,
        ) -> crate::web::run_state::WebChatRunSnapshot {
            crate::web::run_state::WebChatRunSnapshot {
                run_id: run_id.to_string(),
                session_key: session_key.to_string(),
                status: status.to_string(),
                user_message: "hi".to_string(),
                effective_model: None,
                assistant_response: String::new(),
                created_at: "2026-03-06T10:00:00Z".to_string(),
                updated_at: "2026-03-06T10:00:01Z".to_string(),
                events: Vec::new(),
                error: None,
                pending_blocks: Vec::new(),
            }
        }

        // running → returned
        db.upsert_session("web:running", 0).await.unwrap();
        db.upsert_web_chat_run(&make_run("r_running", "web:running", "running"))
            .await
            .unwrap();
        assert!(
            db.load_restorable_web_chat_run("web:running")
                .await
                .unwrap()
                .is_some(),
            "running runs must be restorable"
        );

        // stopping → returned
        db.upsert_session("web:stopping", 0).await.unwrap();
        db.upsert_web_chat_run(&make_run("r_stopping", "web:stopping", "stopping"))
            .await
            .unwrap();
        assert!(
            db.load_restorable_web_chat_run("web:stopping")
                .await
                .unwrap()
                .is_some(),
            "stopping runs must be restorable"
        );

        // failed → returned (Option B: rehydrate for debugging context)
        db.upsert_session("web:failed", 0).await.unwrap();
        db.upsert_web_chat_run(&make_run("r_failed", "web:failed", "failed"))
            .await
            .unwrap();
        assert!(
            db.load_restorable_web_chat_run("web:failed")
                .await
                .unwrap()
                .is_some(),
            "failed runs must be restorable (Option B)"
        );

        // completed → NOT returned (history has the final message)
        db.upsert_session("web:completed", 0).await.unwrap();
        db.upsert_web_chat_run(&make_run("r_completed", "web:completed", "completed"))
            .await
            .unwrap();
        assert!(
            db.load_restorable_web_chat_run("web:completed")
                .await
                .unwrap()
                .is_none(),
            "completed runs must NOT be restorable — this is the tab-reload bug guard"
        );

        // interrupted → NOT returned (same rationale as completed)
        db.upsert_session("web:interrupted", 0).await.unwrap();
        db.upsert_web_chat_run(&make_run("r_interrupted", "web:interrupted", "interrupted"))
            .await
            .unwrap();
        assert!(
            db.load_restorable_web_chat_run("web:interrupted")
                .await
                .unwrap()
                .is_none(),
            "interrupted runs must NOT be restorable"
        );
    }

    #[tokio::test]
    async fn test_messages() {
        let (db, _dir) = test_db().await;
        db.upsert_session("cli:test", 0).await.unwrap();

        db.insert_message("cli:test", "user", "Hello", &[])
            .await
            .unwrap();
        db.insert_message("cli:test", "assistant", "Hi!", &[])
            .await
            .unwrap();
        db.insert_message("cli:test", "user", "How are you?", &[])
            .await
            .unwrap();

        assert_eq!(db.count_messages("cli:test").await.unwrap(), 3);

        let msgs = db.load_messages("cli:test", 100).await.unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].role, "user");
        assert_eq!(msgs[0].content, "Hello");
        assert_eq!(msgs[2].content, "How are you?");

        // Load with limit (last 2)
        let msgs = db.load_messages("cli:test", 2).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "Hi!");
        assert_eq!(msgs[1].content, "How are you?");
    }

    #[tokio::test]
    async fn test_clear_messages() {
        let (db, _dir) = test_db().await;
        db.upsert_session("cli:test", 3).await.unwrap();
        db.insert_message("cli:test", "user", "msg1", &[])
            .await
            .unwrap();
        db.insert_message("cli:test", "assistant", "msg2", &[])
            .await
            .unwrap();

        db.clear_messages("cli:test").await.unwrap();

        assert_eq!(db.count_messages("cli:test").await.unwrap(), 0);
        let session = db.load_session("cli:test").await.unwrap().unwrap();
        assert_eq!(session.last_consolidated, 0);
    }

    #[tokio::test]
    async fn test_delete_old_messages() {
        let (db, _dir) = test_db().await;
        db.upsert_session("cli:test", 0).await.unwrap();

        for i in 0..10 {
            db.insert_message("cli:test", "user", &format!("msg{}", i), &[])
                .await
                .unwrap();
        }
        assert_eq!(db.count_messages("cli:test").await.unwrap(), 10);

        let deleted = db.delete_old_messages("cli:test", 3).await.unwrap();
        assert_eq!(deleted, 7);
        assert_eq!(db.count_messages("cli:test").await.unwrap(), 3);

        let msgs = db.load_messages("cli:test", 100).await.unwrap();
        assert_eq!(msgs[0].content, "msg7");
        assert_eq!(msgs[2].content, "msg9");
    }

    #[tokio::test]
    async fn test_load_old_messages() {
        let (db, _dir) = test_db().await;
        db.upsert_session("cli:test", 0).await.unwrap();

        for i in 0..10 {
            db.insert_message("cli:test", "user", &format!("msg{}", i), &[])
                .await
                .unwrap();
        }

        let old = db.load_old_messages("cli:test", 3).await.unwrap();
        assert_eq!(old.len(), 7);
        assert_eq!(old[0].content, "msg0");
        assert_eq!(old[6].content, "msg6");
    }

    #[tokio::test]
    async fn test_message_tools_used() {
        let (db, _dir) = test_db().await;
        db.upsert_session("cli:test", 0).await.unwrap();

        let tools = vec!["shell".to_string(), "file".to_string()];
        db.insert_message("cli:test", "assistant", "Done", &tools)
            .await
            .unwrap();

        let msgs = db.load_messages("cli:test", 1).await.unwrap();
        assert_eq!(msgs[0].tools_used, r#"["shell","file"]"#);
    }

    #[tokio::test]
    async fn test_automation_crud_and_runs() {
        let (db, _dir) = test_db().await;

        db.insert_automation(
            "auto-1",
            "Daily brief",
            "Send me a summary",
            "cron:0 9 * * *",
            true,
            "active",
            Some("cli:default"),
            "always",
            None,
            None, // profile_id
            None, // user_id
        )
        .await
        .unwrap();

        let rows = db.load_automations(None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "auto-1");
        assert_eq!(rows[0].name, "Daily brief");
        assert_eq!(rows[0].trigger_kind, "always");
        assert!(rows[0].trigger_value.is_none());

        let changed = db
            .update_automation(
                "auto-1",
                AutomationUpdate {
                    enabled: Some(false),
                    status: Some("paused".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(changed);

        let row = db.load_automation("auto-1").await.unwrap().unwrap();
        assert!(!row.enabled);
        assert_eq!(row.status, "paused");

        db.insert_automation_run("run-1", "auto-1", "queued", Some("queued"))
            .await
            .unwrap();
        db.complete_automation_run("run-1", "success", Some("ok"))
            .await
            .unwrap();
        db.insert_automation_run("run-2", "auto-1", "queued", Some("queued"))
            .await
            .unwrap();
        db.complete_automation_run("run-2", "error", Some("boom"))
            .await
            .unwrap();

        let last_success = db
            .load_last_successful_automation_result("auto-1", None)
            .await
            .unwrap();
        assert_eq!(last_success.as_deref(), Some("ok"));

        let runs = db.load_automation_runs("auto-1", 10).await.unwrap();
        assert_eq!(runs.len(), 2);
        let statuses = runs.iter().map(|r| r.status.as_str()).collect::<Vec<_>>();
        assert!(statuses.contains(&"success"));
        assert!(statuses.contains(&"error"));
        assert!(runs.iter().any(|r| r.result.as_deref() == Some("ok")));

        let deleted = db.delete_automation("auto-1").await.unwrap();
        assert!(deleted);
    }

    #[tokio::test]
    async fn test_session_profile_id_lifecycle() {
        let (db, _dir) = test_db().await;
        let key = "web:test-conv-1";

        // The default profile (id=1) is seeded by migrations.
        // Create a second profile for the switch test.
        let profile_b = crate::profiles::db::insert_profile(
            db.pool(),
            "work",
            "Work",
            "\u{1f4bc}",
            "#2563EB",
            "{}",
            None,
        )
        .await
        .unwrap();

        // Create session
        db.upsert_session(key, 0).await.unwrap();

        // Initially no profile_id set
        assert!(db.get_session_profile_id(key).await.is_none());

        // Set profile_id to default (id=1, seeded)
        db.set_session_profile_id(key, 1).await.unwrap();
        assert_eq!(db.get_session_profile_id(key).await, Some(1));

        // Switch to the second profile
        db.set_session_profile_id(key, profile_b).await.unwrap();
        assert_eq!(db.get_session_profile_id(key).await, Some(profile_b));

        // Another session is not affected
        let key2 = "web:test-conv-2";
        db.upsert_session(key2, 0).await.unwrap();
        assert!(db.get_session_profile_id(key2).await.is_none());
        assert_eq!(db.get_session_profile_id(key).await, Some(profile_b));
    }
}
