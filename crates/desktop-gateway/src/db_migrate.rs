//! One-shot migration: fuse the two legacy SQLite files (desktop-gateway.sqlite
//! and task-runtime.sqlite) into a single unified database. Idempotent: if the
//! target is already populated, it's a no-op.

use rusqlite::{Connection, OptionalExtension};
use std::path::Path;

/// Tables owned by the legacy chat_store (desktop-gateway.sqlite).
const CHAT_TABLES: &[&str] = &[
    "settings", "chat_threads", "chat_messages", "remote_approvals",
    "task_thread_links", "channel_inbound_seen", "thread_attachments",
    "tool_runs", "suggestions", "contacts", "contact_identities",
    "contact_perimeters", "profiles", "contact_channel_profiles",
    "contact_relationships",
];

/// Tables owned by the legacy task_store (task-runtime.sqlite).
const TASK_TABLES: &[&str] = &[
    "task_runtime_metadata", "tasks", "task_dependencies", "resource_reservations",
    "task_checkpoints", "task_approvals", "automations", "automation_runs",
    "automation_event_dedup", "turn_events", "broker_meta",
];

/// Fuse the two legacy DBs into the unified target, if needed. Idempotent.
///
/// Decision logic:
/// - If `unified_path` exists AND has at least one row in `chat_threads` or `tasks`,
///   it's already populated → no-op.
/// - Else, if either legacy path exists, ATTACH it and copy all tables.
/// - Else (fresh install, no legacy), no-op — schema migrations create everything.
pub fn unify_databases_if_needed(
    legacy_chat_path: &Path,
    legacy_task_path: &Path,
    unified_path: &Path,
) -> Result<UnifyReport, UnifyError> {
    // Already-populated unified DB → no-op.
    if unified_path.exists() && is_unified_populated(unified_path)? {
        return Ok(UnifyReport::already_unified());
    }

    let chat_exists = legacy_chat_path.exists();
    let task_exists = legacy_task_path.exists();
    if !chat_exists && !task_exists {
        return Ok(UnifyReport::fresh_install()); // fresh install
    }

    // Step A: ensure legacy DBs are at latest schema (open each via its store).
    if chat_exists {
        let _ = crate::chat_store::ChatStore::open(legacy_chat_path)
            .map_err(|e| UnifyError::OpenChat(e.to_string()))?;
    }
    if task_exists {
        let _ = local_first_task_runtime::TaskStore::open(legacy_task_path)
            .map_err(|e| UnifyError::OpenTask(e.to_string()))?;
    }

    // Step B: create the unified schema by opening both stores on the unified path.
    // Each store's migrate() runs CREATE TABLE IF NOT EXISTS, so all tables land here.
    let _ = crate::chat_store::ChatStore::open(unified_path)
        .map_err(|e| UnifyError::OpenUnifiedChat(e.to_string()))?;
    let _ = local_first_task_runtime::TaskStore::open(unified_path)
        .map_err(|e| UnifyError::OpenUnifiedTask(e.to_string()))?;

    // Step C: ATTACH each legacy DB and copy rows.
    let conn = Connection::open(unified_path)?;
    let mut report = UnifyReport::default();

    if chat_exists {
        copy_legacy_into_unified(&conn, "legacy_chat", legacy_chat_path, CHAT_TABLES, &mut report.chat_rows)?;
    }
    if task_exists {
        copy_legacy_into_unified(&conn, "legacy_task", legacy_task_path, TASK_TABLES, &mut report.task_rows)?;
    }

    report.unified = true;
    Ok(report)
}

fn copy_legacy_into_unified(
    conn: &Connection,
    alias: &str,
    legacy_path: &Path,
    tables: &[&str],
    out: &mut std::collections::HashMap<String, usize>,
) -> Result<(), UnifyError> {
    conn.execute(
        &format!("ATTACH DATABASE '{}' AS {alias}", legacy_path.display()),
        [],
    )?;
    for table in tables {
        // Only copy if the table exists in the legacy.
        let exists: bool = conn
            .query_row(
                &format!("SELECT 1 FROM {alias}.sqlite_master WHERE type='table' AND name=?1"),
                rusqlite::params![table],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            continue;
        }
        // INSERT OR IGNORE: skip rows that would violate PK/UNIQUE constraints
        // (defensive against partial re-runs).
        let copied = conn.execute(
            &format!("INSERT OR IGNORE INTO main.{table} SELECT * FROM {alias}.{table}"),
            [],
        )?;
        out.insert((*table).to_string(), copied);
    }
    let _ = conn.execute(&format!("DETACH DATABASE {alias}"), []);
    Ok(())
}

fn is_unified_populated(path: &Path) -> Result<bool, UnifyError> {
    let conn = Connection::open(path)?;
    for table in ["chat_threads", "tasks"] {
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![table],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        if !exists {
            continue;
        }
        let rows: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| row.get(0))
            .unwrap_or(0);
        if rows > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

#[derive(Debug, Default)]
pub struct UnifyReport {
    pub unified: bool,
    pub chat_rows: std::collections::HashMap<String, usize>,
    pub task_rows: std::collections::HashMap<String, usize>,
}

impl UnifyReport {
    fn already_unified() -> Self {
        Self { unified: false, ..Default::default() }
    }
    fn fresh_install() -> Self {
        Self { unified: false, ..Default::default() }
    }
}

#[derive(Debug)]
pub enum UnifyError {
    OpenChat(String),
    OpenTask(String),
    OpenUnifiedChat(String),
    OpenUnifiedTask(String),
    Sqlite(String),
}

impl std::fmt::Display for UnifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::OpenChat(s) => write!(f, "open legacy chat: {s}"),
            Self::OpenTask(s) => write!(f, "open legacy task: {s}"),
            Self::OpenUnifiedChat(s) => write!(f, "open unified chat: {s}"),
            Self::OpenUnifiedTask(s) => write!(f, "open unified task: {s}"),
            Self::Sqlite(s) => write!(f, "sqlite: {s}"),
        }
    }
}

impl From<rusqlite::Error> for UnifyError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sqlite(e.to_string())
    }
}

impl std::error::Error for UnifyError {}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_tmp(prefix: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn cleanup(p: &Path) {
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_file(p.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(p.with_extension("sqlite-shm"));
    }

    #[test]
    fn fresh_install_is_noop() {
        let chat = fresh_tmp("fresh-chat");
        let task = fresh_tmp("fresh-task");
        let unified = fresh_tmp("fresh-unified");
        let report = unify_databases_if_needed(&chat, &task, &unified).unwrap();
        assert!(!report.unified);
        cleanup(&chat);
        cleanup(&task);
        cleanup(&unified);
    }

    #[test]
    fn already_unified_is_noop() {
        let chat = fresh_tmp("au-chat");
        let task = fresh_tmp("au-task");
        let unified = fresh_tmp("au-unified");
        // Populate the unified DB first so it's "already populated".
        {
            let c = Connection::open(&unified).unwrap();
            c.execute_batch(
                "CREATE TABLE chat_threads (thread_id TEXT PRIMARY KEY);
                 INSERT INTO chat_threads VALUES ('t1');",
            )
            .unwrap();
        }
        let report = unify_databases_if_needed(&chat, &task, &unified).unwrap();
        assert!(!report.unified);
        cleanup(&chat);
        cleanup(&task);
        cleanup(&unified);
    }

    #[test]
    fn fuses_legacy_chat_and_task_into_unified() {
        let chat = fresh_tmp("fuse-chat");
        let task = fresh_tmp("fuse-task");
        let unified = fresh_tmp("fuse-unified");
        // Populate legacy chat DB by opening ChatStore (runs migrate, creating the
        // schema), then insert a row via a fresh connection (the store's `conn`
        // field is private, so we don't touch it).
        {
            let _store = crate::chat_store::ChatStore::open(&chat).unwrap();
            let c = Connection::open(&chat).unwrap();
            c.execute(
                "INSERT INTO chat_threads (thread_id, title, subtitle, status, pinned, computer_session_id, task_id, updated_at, message_count)
                 VALUES ('t1', 'T', 'S', 'active', 0, 'c', 'tk', '0', 0)",
                [],
            )
            .unwrap();
        }
        {
            let _store = local_first_task_runtime::TaskStore::open(&task).unwrap();
            let c = Connection::open(&task).unwrap();
            c.execute(
                "INSERT INTO tasks (task_id, user_id, workspace_id, kind, status, priority, created_at, updated_at, task_json)
                 VALUES ('tk', 'u', 'w', 'chat_turn', 'queued', 'high', 1, 1, '{}')",
                [],
            )
            .unwrap();
        }
        let report = unify_databases_if_needed(&chat, &task, &unified).unwrap();
        assert!(report.unified, "should have unified");
        let conn = Connection::open(&unified).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM chat_threads", [], |row| row.get(0))
            .unwrap();
        assert!(count >= 1, "chat_threads should have the legacy row");
        let count: i64 = conn
            .query_row("SELECT count(*) FROM tasks", [], |row| row.get(0))
            .unwrap();
        assert!(count >= 1, "tasks should have the legacy row");
        cleanup(&chat);
        cleanup(&task);
        cleanup(&unified);
    }
}
