use crate::{LinkedMemoryReadRef, MemoryReuseEnvelope};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinkedMemoryRepairPreview {
    pub audit_checksum: String,
    pub approval_token: String,
    pub contaminated_threads: u64,
    pub assistant_envelopes_to_backfill: u64,
    pub memories_to_remove: u64,
    pub episodes_to_remove: u64,
    pub derived_rows_to_rebuild: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkedMemoryRepairApplyResult {
    pub before: LinkedMemoryRepairPreview,
    pub after: LinkedMemoryRepairPreview,
    pub chat_backup_bytes: u64,
    pub memory_backup_bytes: u64,
    #[serde(skip_serializing)]
    pub affected_workspaces: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkedRepairFailureInjection {
    None,
    #[doc(hidden)]
    AfterChatMutation,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkedRepairError {
    StalePreview,
    ApprovalTokenMismatch,
    BackupPathInvalid,
    InjectedFailure,
    Database(String),
    Io(String),
}

impl fmt::Display for LinkedRepairError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StalePreview => formatter.write_str("linked-memory repair preview is stale"),
            Self::ApprovalTokenMismatch => {
                formatter.write_str("linked-memory repair approval token does not match")
            }
            Self::BackupPathInvalid => {
                formatter.write_str("linked-memory repair backup directory must be new")
            }
            Self::InjectedFailure => formatter.write_str("linked-memory repair injected failure"),
            Self::Database(error) => {
                write!(formatter, "linked-memory repair database error: {error}")
            }
            Self::Io(error) => write!(formatter, "linked-memory repair I/O error: {error}"),
        }
    }
}

impl std::error::Error for LinkedRepairError {}

impl From<rusqlite::Error> for LinkedRepairError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<std::io::Error> for LinkedRepairError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

#[derive(Debug, Default)]
struct RepairScan {
    contaminated_threads: BTreeSet<String>,
    envelope_updates: Vec<(String, String)>,
    memory_refs: Vec<String>,
    episode_refs: Vec<String>,
    embedding_refs: Vec<String>,
    evidence_memory_refs: Vec<String>,
    entity_refs: Vec<String>,
    relation_refs: Vec<String>,
    wiki_refs: Vec<String>,
    fts_refs: Vec<String>,
    affected_workspaces: BTreeSet<String>,
    revision_material: Vec<String>,
}

impl RepairScan {
    fn preview(&self) -> LinkedMemoryRepairPreview {
        let mut hasher = Sha256::new();
        hasher.update(b"homun-linked-memory-repair-v1\0");
        for value in &self.revision_material {
            hasher.update(value.as_bytes());
            hasher.update([0]);
        }
        let audit_checksum = format!("sha256:{}", hex_digest(hasher.finalize()));
        let approval_token = approval_token(&audit_checksum);
        LinkedMemoryRepairPreview {
            audit_checksum,
            approval_token,
            contaminated_threads: self.contaminated_threads.len() as u64,
            assistant_envelopes_to_backfill: self.envelope_updates.len() as u64,
            memories_to_remove: self.memory_refs.len() as u64,
            episodes_to_remove: self.episode_refs.len() as u64,
            derived_rows_to_rebuild: (self.embedding_refs.len()
                + self.evidence_memory_refs.len()
                + self.entity_refs.len()
                + self.relation_refs.len()
                + self.wiki_refs.len()
                + self.fts_refs.len()) as u64,
        }
    }
}

pub fn preview_linked_memory_repair(
    chat_path: &Path,
    memory_path: &Path,
) -> Result<LinkedMemoryRepairPreview, LinkedRepairError> {
    let connection = open_attached(chat_path, memory_path)?;
    Ok(scan_repair(&connection)?.preview())
}

pub fn apply_linked_memory_repair(
    chat_path: &Path,
    memory_path: &Path,
    backup_directory: &Path,
    approved: &LinkedMemoryRepairPreview,
    failure_injection: LinkedRepairFailureInjection,
) -> Result<LinkedMemoryRepairApplyResult, LinkedRepairError> {
    let current = preview_linked_memory_repair(chat_path, memory_path)?;
    if approved.audit_checksum != current.audit_checksum
        || approved.contaminated_threads != current.contaminated_threads
        || approved.assistant_envelopes_to_backfill != current.assistant_envelopes_to_backfill
        || approved.memories_to_remove != current.memories_to_remove
        || approved.episodes_to_remove != current.episodes_to_remove
        || approved.derived_rows_to_rebuild != current.derived_rows_to_rebuild
    {
        return Err(LinkedRepairError::StalePreview);
    }
    if approved.approval_token != current.approval_token {
        return Err(LinkedRepairError::ApprovalTokenMismatch);
    }
    if backup_directory.as_os_str().is_empty() || backup_directory.exists() {
        return Err(LinkedRepairError::BackupPathInvalid);
    }
    fs::create_dir_all(backup_directory)?;

    checkpoint_database(chat_path)?;
    checkpoint_database(memory_path)?;
    let chat_backup = backup_directory.join("homun.sqlite");
    let memory_backup = backup_directory.join("memory.sqlite");
    let chat_backup_bytes = fs::copy(chat_path, &chat_backup)?;
    let memory_backup_bytes = fs::copy(memory_path, &memory_backup)?;

    let connection = open_attached(chat_path, memory_path)?;
    connection.execute_batch("begin immediate")?;
    let apply_result = (|| -> Result<(RepairScan, Vec<String>), LinkedRepairError> {
        ensure_chat_reuse_column(&connection)?;
        let scan = scan_repair(&connection)?;
        if scan.preview() != current {
            return Err(LinkedRepairError::StalePreview);
        }
        let affected_workspaces = scan.affected_workspaces.iter().cloned().collect::<Vec<_>>();

        for (message_id, envelope_json) in &scan.envelope_updates {
            connection.execute(
                "update chat_messages set memory_reuse_json = ?1 where id = ?2",
                params![envelope_json, message_id],
            )?;
        }
        if failure_injection == LinkedRepairFailureInjection::AfterChatMutation {
            return Err(LinkedRepairError::InjectedFailure);
        }

        delete_refs(
            &connection,
            "memory.memory_embeddings",
            "ref",
            &scan.embedding_refs,
        )?;
        delete_refs(
            &connection,
            "memory.memory_evidence",
            "memory_ref",
            &scan.evidence_memory_refs,
        )?;
        delete_refs(&connection, "memory.relations", "ref", &scan.relation_refs)?;
        delete_refs(&connection, "memory.entities", "ref", &scan.entity_refs)?;
        delete_refs(&connection, "memory.wiki_pages", "ref", &scan.wiki_refs)?;
        let mut memories = scan.memory_refs.clone();
        memories.extend(scan.episode_refs.iter().cloned());
        delete_refs(&connection, "memory.memories", "ref", &memories)?;
        rebuild_fts(&connection)?;
        quick_check(&connection, "main")?;
        quick_check(&connection, "memory")?;
        Ok((scan, affected_workspaces))
    })();

    let (_, affected_workspaces) = match apply_result {
        Ok(value) => {
            connection.execute_batch("commit")?;
            value
        }
        Err(error) => {
            let _ = connection.execute_batch("rollback");
            return Err(error);
        }
    };
    let after = preview_linked_memory_repair(chat_path, memory_path)?;
    Ok(LinkedMemoryRepairApplyResult {
        before: current,
        after,
        chat_backup_bytes,
        memory_backup_bytes,
        affected_workspaces,
    })
}

fn open_attached(chat_path: &Path, memory_path: &Path) -> Result<Connection, LinkedRepairError> {
    let connection = Connection::open(chat_path)?;
    connection.busy_timeout(std::time::Duration::from_secs(10))?;
    connection.execute(
        "attach database ?1 as memory",
        [memory_path.to_string_lossy().as_ref()],
    )?;
    Ok(connection)
}

fn checkpoint_database(path: &Path) -> Result<(), LinkedRepairError> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(10))?;
    connection.execute_batch("pragma wal_checkpoint(full)")?;
    Ok(())
}

fn scan_repair(connection: &Connection) -> Result<RepairScan, LinkedRepairError> {
    let mut scan = RepairScan::default();
    scan_chat(connection, &mut scan)?;
    scan_memory(connection, &mut scan)?;
    scan.revision_material.sort();
    Ok(scan)
}

fn scan_chat(connection: &Connection, scan: &mut RepairScan) -> Result<(), LinkedRepairError> {
    let envelope_column =
        if column_exists(connection, "main", "chat_messages", "memory_reuse_json")? {
            "coalesce(memory_reuse_json, '')"
        } else {
            "''"
        };
    let mut statement = connection.prepare(&format!(
        "select id, thread_id, coalesce(event_parts_json, ''), {envelope_column}
           from chat_messages where role = 'assistant' order by id"
    ))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let message_id: String = row.get(0)?;
        let thread_id: String = row.get(1)?;
        let event_parts_json: String = row.get(2)?;
        let current_envelope: String = row.get(3)?;
        let Some(envelope) = linked_envelope_from_event_parts(&event_parts_json) else {
            continue;
        };
        scan.contaminated_threads.insert(thread_id.clone());
        let encoded = serde_json::to_string(&envelope)
            .map_err(|error| LinkedRepairError::Database(error.to_string()))?;
        let current_value = serde_json::from_str::<serde_json::Value>(&current_envelope).ok();
        let desired_value = serde_json::from_str::<serde_json::Value>(&encoded).ok();
        if current_value != desired_value {
            scan.envelope_updates.push((message_id.clone(), encoded));
        }
        scan.revision_material.push(format!(
            "chat:{message_id}:{thread_id}:{}:{}",
            hash_text(&event_parts_json),
            hash_text(&current_envelope)
        ));
    }
    Ok(())
}

fn ensure_chat_reuse_column(connection: &Connection) -> Result<(), LinkedRepairError> {
    if !column_exists(connection, "main", "chat_messages", "memory_reuse_json")? {
        connection.execute(
            "alter table chat_messages add column memory_reuse_json text",
            [],
        )?;
    }
    Ok(())
}

fn column_exists(
    connection: &Connection,
    database: &str,
    table: &str,
    expected: &str,
) -> Result<bool, LinkedRepairError> {
    let mut statement = connection.prepare(&format!("pragma {database}.table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns.iter().any(|column| column == expected))
}

fn linked_envelope_from_event_parts(raw: &str) -> Option<MemoryReuseEnvelope> {
    let parts = serde_json::from_str::<Vec<serde_json::Value>>(raw).ok()?;
    let mut saw_linked_evidence = false;
    let mut malformed = false;
    let mut reads = BTreeMap::<(String, String, u64, String, String), LinkedMemoryReadRef>::new();
    for part in parts {
        if part.get("type").and_then(serde_json::Value::as_str) != Some("recall") {
            continue;
        }
        let Some(hits) = part
            .get("payload")
            .and_then(|payload| payload.get("hits"))
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };
        for hit in hits {
            let has_grant = hit
                .get("grant_id")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if !has_grant {
                continue;
            }
            saw_linked_evidence = true;
            let required = || -> Option<LinkedMemoryReadRef> {
                let string = |key: &str| {
                    hit.get(key)
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                };
                Some(LinkedMemoryReadRef {
                    source_workspace_id: string("source_workspace_id")?,
                    grant_id: string("grant_id")?,
                    policy_version: hit
                        .get("policy_version")?
                        .as_u64()
                        .filter(|value| *value > 0)?,
                    memory_ref: string("ref")?,
                    source_revision: string("source_revision")?,
                })
            }();
            if let Some(read) = required {
                let key = (
                    read.source_workspace_id.clone(),
                    read.grant_id.clone(),
                    read.policy_version,
                    read.memory_ref.clone(),
                    read.source_revision.clone(),
                );
                reads.insert(key, read);
            } else {
                malformed = true;
            }
        }
    }
    if !saw_linked_evidence {
        return None;
    }
    if malformed || reads.is_empty() {
        Some(MemoryReuseEnvelope::blocked_unknown())
    } else {
        Some(MemoryReuseEnvelope::user_input_only(
            reads.into_values().collect(),
        ))
    }
}

fn scan_memory(connection: &Connection, scan: &mut RepairScan) -> Result<(), LinkedRepairError> {
    if scan.contaminated_threads.is_empty() {
        return Ok(());
    }
    let mut statement = connection.prepare(
        "select ref, workspace_id, metadata_json, updated_at from memory.memories order by ref",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    for row in rows {
        let (reference, workspace, metadata_json, revision) = row?;
        let metadata =
            serde_json::from_str::<serde_json::Value>(&metadata_json).unwrap_or_default();
        let Some(thread_id) = metadata
            .get("thread_id")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        if !scan.contaminated_threads.contains(thread_id) || !is_automatic_derivative(&metadata) {
            continue;
        }
        scan.affected_workspaces.insert(workspace.clone());
        scan.revision_material.push(format!(
            "memory:{reference}:{workspace}:{revision}:{}",
            hash_text(&metadata_json)
        ));
        if workspace == "__threads__" {
            scan.episode_refs.push(reference);
        } else {
            scan.memory_refs.push(reference);
        }
    }

    let removed = scan
        .memory_refs
        .iter()
        .chain(scan.episode_refs.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    scan.embedding_refs = existing_refs(connection, "memory.memory_embeddings", "ref", &removed)?;
    scan.evidence_memory_refs =
        existing_refs(connection, "memory.memory_evidence", "memory_ref", &removed)?;
    scan.fts_refs = existing_refs(connection, "memory.memory_search_fts", "ref", &removed)?;

    scan.entity_refs = scan_structured_table(connection, "entities", &scan.contaminated_threads)?;
    let removed_entities = scan.entity_refs.iter().cloned().collect::<BTreeSet<_>>();
    let all_removed = removed
        .iter()
        .chain(removed_entities.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    scan.relation_refs = scan_relations(connection, &scan.contaminated_threads, &all_removed)?;
    scan.wiki_refs = scan_wiki(connection, &all_removed)?;
    Ok(())
}

fn is_automatic_derivative(metadata: &serde_json::Value) -> bool {
    let source = metadata
        .get("source")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let adapter = metadata
        .get("adapter")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if source == "graphify" || adapter == "graphify" {
        return false;
    }
    !matches!(
        source.as_str(),
        "manual" | "user" | "user_authored" | "memory_ui" | "publication"
    )
}

fn scan_structured_table(
    connection: &Connection,
    table: &str,
    threads: &BTreeSet<String>,
) -> Result<Vec<String>, LinkedRepairError> {
    let sql = format!("select ref, metadata_json from memory.{table} order by ref");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut refs = Vec::new();
    for row in rows {
        let (reference, metadata_json) = row?;
        let metadata =
            serde_json::from_str::<serde_json::Value>(&metadata_json).unwrap_or_default();
        if metadata
            .get("thread_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|thread| threads.contains(thread))
            && is_automatic_derivative(&metadata)
        {
            refs.push(reference);
        }
    }
    Ok(refs)
}

fn scan_relations(
    connection: &Connection,
    threads: &BTreeSet<String>,
    removed: &BTreeSet<String>,
) -> Result<Vec<String>, LinkedRepairError> {
    let mut statement = connection.prepare(
        "select ref, source_ref, target_ref, evidence_json, metadata_json
           from memory.relations order by ref",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut refs = Vec::new();
    for row in rows {
        let (reference, source_ref, target_ref, evidence_json, metadata_json) = row?;
        let metadata =
            serde_json::from_str::<serde_json::Value>(&metadata_json).unwrap_or_default();
        if !is_automatic_derivative(&metadata) {
            continue;
        }
        let structured_thread = metadata
            .get("thread_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|thread| threads.contains(thread));
        let evidence_removed = json_array_intersects(&evidence_json, removed);
        if structured_thread
            || removed.contains(&source_ref)
            || removed.contains(&target_ref)
            || evidence_removed
        {
            refs.push(reference);
        }
    }
    Ok(refs)
}

fn scan_wiki(
    connection: &Connection,
    removed: &BTreeSet<String>,
) -> Result<Vec<String>, LinkedRepairError> {
    let mut statement =
        connection.prepare("select ref, linked_refs_json from memory.wiki_pages order by ref")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut refs = Vec::new();
    for row in rows {
        let (reference, links) = row?;
        if json_array_intersects(&links, removed) {
            refs.push(reference);
        }
    }
    Ok(refs)
}

fn json_array_intersects(raw: &str, values: &BTreeSet<String>) -> bool {
    serde_json::from_str::<Vec<String>>(raw)
        .ok()
        .is_some_and(|items| items.into_iter().any(|item| values.contains(&item)))
}

fn existing_refs(
    connection: &Connection,
    table: &str,
    column: &str,
    candidates: &BTreeSet<String>,
) -> Result<Vec<String>, LinkedRepairError> {
    let sql = format!("select 1 from {table} where {column} = ?1 limit 1");
    let mut found = Vec::new();
    for reference in candidates {
        if connection
            .query_row(&sql, [reference], |_| Ok(()))
            .optional()?
            .is_some()
        {
            found.push(reference.clone());
        }
    }
    Ok(found)
}

fn delete_refs(
    connection: &Connection,
    table: &str,
    column: &str,
    refs: &[String],
) -> Result<(), LinkedRepairError> {
    let sql = format!("delete from {table} where {column} = ?1");
    for reference in refs {
        connection.execute(&sql, [reference])?;
    }
    Ok(())
}

fn rebuild_fts(connection: &Connection) -> Result<(), LinkedRepairError> {
    connection.execute("delete from memory.memory_search_fts", [])?;
    let aliases_exist = connection
        .prepare("pragma memory.table_info(memories)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .iter()
        .any(|column| column == "aliases_json");
    let aliases = if aliases_exist {
        "coalesce((select group_concat(value, ' ') from json_each(memories.aliases_json)), '')"
    } else {
        "''"
    };
    connection.execute(
        &format!(
            "insert into memory.memory_search_fts(ref, user_id, workspace_id, text, aliases)
             select ref, user_id, workspace_id, text, {aliases} from memory.memories"
        ),
        [],
    )?;
    Ok(())
}

fn quick_check(connection: &Connection, database: &str) -> Result<(), LinkedRepairError> {
    let result: String =
        connection.query_row(&format!("pragma {database}.quick_check"), [], |row| {
            row.get(0)
        })?;
    if result != "ok" {
        return Err(LinkedRepairError::Database(format!(
            "{database} quick_check failed"
        )));
    }
    Ok(())
}

fn approval_token(checksum: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"homun-linked-memory-repair-approval-v1\0");
    hasher.update(checksum.as_bytes());
    format!("sha256:{}", hex_digest(hasher.finalize()))
}

fn hash_text(value: &str) -> String {
    hex_digest(Sha256::digest(value.as_bytes()))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{Connection, params};
    use std::fs;
    use std::path::{Path, PathBuf};

    const SENTINEL: &str = "NEBULA-7429";

    struct Fixture {
        root: PathBuf,
        chat: PathBuf,
        memory: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "homun-linked-repair-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir_all(&root).unwrap();
            let chat = root.join("homun.sqlite");
            let memory = root.join("memory.sqlite");
            seed_chat(&chat);
            seed_memory(&memory);
            Self { root, chat, memory }
        }

        fn backup_dir(&self, suffix: &str) -> PathBuf {
            self.root.join(format!("backup-{suffix}"))
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn seed_chat(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "create table chat_threads (
                thread_id text primary key,
                workspace_id text not null
             );
             create table chat_messages (
                id text primary key,
                thread_id text not null,
                role text not null,
                text text not null,
                event_parts_json text,
                memory_reuse_json text
             );",
        )
        .unwrap();
        conn.execute(
            "insert into chat_threads values ('thread-linked', 'consumer-project')",
            [],
        )
        .unwrap();
        let parts = serde_json::json!([{
            "type": "recall",
            "payload": { "hits": [{
                "ref": "memory:owner:source-project:source-fact",
                "text": SENTINEL,
                "source_workspace_id": "source-project",
                "grant_id": "grant-1",
                "policy_version": 4,
                "source_revision": "sha256:source-rev"
            }] }
        }]);
        conn.execute(
            "insert into chat_messages values (?1, ?2, 'assistant', ?3, ?4, null)",
            params![
                "assistant-linked",
                "thread-linked",
                SENTINEL,
                parts.to_string()
            ],
        )
        .unwrap();
        conn.execute(
            "insert into chat_messages values ('user-linked', 'thread-linked', 'user', 'keep transcript', null, null)",
            [],
        )
        .unwrap();
    }

    fn seed_memory(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "create table memories (
                ref text primary key,
                user_id text not null,
                workspace_id text not null,
                text text not null,
                metadata_json text not null,
                updated_at text not null
             );
             create table memory_embeddings (
                ref text primary key,
                user_id text not null,
                workspace_id text not null,
                vector blob not null
             );
             create virtual table memory_search_fts using fts5(
                ref unindexed, user_id unindexed, workspace_id unindexed, text, aliases
             );
             create table memory_evidence (memory_ref text, evidence_ref text, note text);
             create table entities (
                ref text primary key, user_id text not null, workspace_id text not null,
                metadata_json text not null
             );
             create table relations (
                ref text primary key, user_id text not null, workspace_id text not null,
                source_ref text not null, target_ref text not null,
                evidence_json text not null, metadata_json text not null
             );
             create table wiki_pages (
                ref text primary key, user_id text not null, workspace_id text not null,
                linked_refs_json text not null
             );
             create table memory_source_grants (grant_id text primary key);
             create table memory_source_access_events (ref text primary key);",
        )
        .unwrap();

        let automatic = serde_json::json!({"thread_id":"thread-linked","source":"desktop_chat"});
        let manual = serde_json::json!({"thread_id":"thread-linked","source":"manual"});
        let graphify = serde_json::json!({"thread_id":"thread-linked","source":"graphify"});
        for (reference, workspace, text, metadata) in [
            ("memory:auto", "consumer-project", SENTINEL, automatic),
            (
                "memory:episode",
                "__threads__",
                SENTINEL,
                serde_json::json!({"thread_id":"thread-linked","source":"desktop_chat"}),
            ),
            ("memory:manual", "consumer-project", "keep manual", manual),
            (
                "memory:graphify",
                "consumer-project",
                "keep code graph",
                graphify,
            ),
        ] {
            conn.execute(
                "insert into memories values (?1, 'owner', ?2, ?3, ?4, 'rev-1')",
                params![reference, workspace, text, metadata.to_string()],
            )
            .unwrap();
            conn.execute(
                "insert into memory_search_fts values (?1, 'owner', ?2, ?3, '')",
                params![reference, workspace, text],
            )
            .unwrap();
        }
        conn.execute(
            "insert into memory_embeddings values ('memory:auto', 'owner', 'consumer-project', x'00')",
            [],
        )
        .unwrap();
        conn.execute(
            "insert into entities values ('entity:auto', 'owner', 'consumer-project', ?1)",
            [
                serde_json::json!({"thread_id":"thread-linked","source":"desktop_chat"})
                    .to_string(),
            ],
        )
        .unwrap();
        conn.execute(
            "insert into relations values ('relation:auto', 'owner', 'consumer-project', 'memory:auto', 'entity:auto', '[]', ?1)",
            [serde_json::json!({"thread_id":"thread-linked","source":"desktop_chat"}).to_string()],
        )
        .unwrap();
        conn.execute(
            "insert into relations values ('relation:graphify', 'owner', 'consumer-project', 'memory:graphify', 'memory:graphify', '[]', ?1)",
            [serde_json::json!({"source":"graphify"}).to_string()],
        )
        .unwrap();
        conn.execute(
            "insert into wiki_pages values ('wiki:auto', 'owner', 'consumer-project', '[\"memory:auto\"]')",
            [],
        )
        .unwrap();
        conn.execute("insert into memory_source_grants values ('grant-1')", [])
            .unwrap();
        conn.execute(
            "insert into memory_source_access_events values ('access-1')",
            [],
        )
        .unwrap();
    }

    fn scalar(path: &Path, sql: &str) -> i64 {
        Connection::open(path)
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn linked_memory_repair_preview_is_metadata_only_and_checksum_bound() {
        let fixture = Fixture::new();
        let preview = preview_linked_memory_repair(&fixture.chat, &fixture.memory).unwrap();

        assert_eq!(preview.contaminated_threads, 1);
        assert_eq!(preview.assistant_envelopes_to_backfill, 1);
        assert_eq!(preview.memories_to_remove, 1);
        assert_eq!(preview.episodes_to_remove, 1);
        assert!(preview.derived_rows_to_rebuild >= 4);
        assert!(!preview.audit_checksum.is_empty());
        assert!(!preview.approval_token.is_empty());
        assert!(!serde_json::to_string(&preview).unwrap().contains(SENTINEL));

        let mut stale = preview.clone();
        stale.audit_checksum = "sha256:wrong".to_string();
        let error = apply_linked_memory_repair(
            &fixture.chat,
            &fixture.memory,
            &fixture.backup_dir("stale"),
            &stale,
            LinkedRepairFailureInjection::None,
        )
        .unwrap_err();
        assert_eq!(error, LinkedRepairError::StalePreview);
    }

    #[test]
    fn linked_memory_repair_is_backed_up_conservative_and_idempotent() {
        let fixture = Fixture::new();
        let preview = preview_linked_memory_repair(&fixture.chat, &fixture.memory).unwrap();
        let result = apply_linked_memory_repair(
            &fixture.chat,
            &fixture.memory,
            &fixture.backup_dir("apply"),
            &preview,
            LinkedRepairFailureInjection::None,
        )
        .unwrap();

        assert!(result.chat_backup_bytes > 0);
        assert!(result.memory_backup_bytes > 0);
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from memories where ref = 'memory:auto'"
            ),
            0
        );
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from memories where ref = 'memory:episode'"
            ),
            0
        );
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from memories where ref = 'memory:manual'"
            ),
            1
        );
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from memories where ref = 'memory:graphify'"
            ),
            1
        );
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from relations where ref = 'relation:graphify'"
            ),
            1
        );
        assert_eq!(
            scalar(&fixture.memory, "select count(*) from memory_source_grants"),
            1
        );
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from memory_source_access_events"
            ),
            1
        );
        assert_eq!(
            scalar(&fixture.chat, "select count(*) from chat_messages"),
            2
        );

        let envelope: String = Connection::open(&fixture.chat)
            .unwrap()
            .query_row(
                "select memory_reuse_json from chat_messages where id = 'assistant-linked'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(envelope.contains("user_input_only"));
        assert!(envelope.contains("grant-1"));

        let second = preview_linked_memory_repair(&fixture.chat, &fixture.memory).unwrap();
        assert_eq!(second.assistant_envelopes_to_backfill, 0);
        assert_eq!(second.memories_to_remove, 0);
        assert_eq!(second.episodes_to_remove, 0);
        assert_eq!(second.derived_rows_to_rebuild, 0);
    }

    #[test]
    fn linked_memory_repair_rolls_back_both_databases_on_failure() {
        let fixture = Fixture::new();
        let preview = preview_linked_memory_repair(&fixture.chat, &fixture.memory).unwrap();
        let error = apply_linked_memory_repair(
            &fixture.chat,
            &fixture.memory,
            &fixture.backup_dir("rollback"),
            &preview,
            LinkedRepairFailureInjection::AfterChatMutation,
        )
        .unwrap_err();
        assert_eq!(error, LinkedRepairError::InjectedFailure);
        assert_eq!(
            scalar(
                &fixture.memory,
                "select count(*) from memories where ref = 'memory:auto'"
            ),
            1
        );
        assert_eq!(
            scalar(
                &fixture.chat,
                "select count(*) from chat_messages where memory_reuse_json is null"
            ),
            2
        );
    }
}
