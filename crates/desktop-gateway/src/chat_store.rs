use local_first_desktop_gateway::{
    ChatMessage, ChatMessagesSnapshot, ChatThread, ChatThreadSnapshot, compact_thread_title,
    seeded_ready_message,
};
// The generic marker parsers live in the single `markers` module now; aliased so the local
// call sites read unchanged.
use local_first_desktop_gateway::markers::{bodies as marker_bodies, strip_blocks as strip_marker_blocks};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct ChatStore {
    conn: Connection,
}

/// A node on the active conversation path that has alternative siblings — drives
/// the ‹ n/m › branch switcher. `node_id` is the displayed message; `options` are
/// all of its parent's children (in creation order), each carrying the leaf to
/// activate to display that branch.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BranchPoint {
    pub node_id: String,
    pub active_index: usize,
    pub options: Vec<BranchOption>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BranchOption {
    pub child_id: String,
    pub leaf_id: String,
    pub label: Option<String>,
}

/// An ingested attachment persisted on a thread (text and/or page images).
#[derive(Debug, Clone)]
pub struct StoredAttachment {
    pub display_name: String,
    pub mime_type: String,
    pub text: Option<String>,
    pub images: Vec<String>,
}

/// One connector tool execution to append to the audit log (roadmap #6).
#[derive(Debug, Clone)]
pub struct ToolRunInput<'a> {
    pub thread_id: Option<&'a str>,
    pub tool: &'a str,
    /// "composio" | "mcp".
    pub kind: &'a str,
    pub ok: bool,
    /// classify_connector_error category on failure; None on success/unknown.
    pub error_kind: Option<&'a str>,
    pub duration_ms: Option<i64>,
    /// Short, redacted one-line preview (never raw secrets/args).
    pub summary: Option<&'a str>,
}

/// A recorded connector tool execution (newest-first in the panel).
#[derive(Debug, Clone)]
pub struct ToolRunRow {
    pub ts: i64,
    pub thread_id: Option<String>,
    pub tool: String,
    pub kind: String,
    pub ok: bool,
    pub error_kind: Option<String>,
    pub duration_ms: Option<i64>,
    pub summary: Option<String>,
}

/// A remote approval is a durable authorization request. Chat-originated
/// requests bind to the exact persisted confirmation card before they can be
/// delivered or executed; channel-only requests may opt out of that binding.
#[derive(Debug, Clone)]
pub struct RemoteApprovalInput<'a> {
    pub approval_id: &'a str,
    pub code: &'a str,
    pub tool: &'a str,
    pub arguments: &'a serde_json::Value,
    pub label: &'a str,
    pub thread_id: Option<&'a str>,
    pub requires_source: bool,
    pub expires_at: i64,
}

#[derive(Debug, Clone)]
pub struct RemoteApprovalRow {
    pub approval_id: String,
    pub code: String,
    pub tool: String,
    pub arguments: serde_json::Value,
    pub label: String,
    pub thread_id: Option<String>,
    pub source_message_id: Option<String>,
    pub requires_source: bool,
    pub status: String,
    pub expires_at: i64,
    pub dispatched_at: Option<i64>,
}

/// A proactive suggestion card to insert (ADR 0011 §7). `scope` = a workspace id
/// or "__personal__". `dedup_key` is the durable no-repeat key.
#[derive(Debug, Clone, Default)]
pub struct SuggestionInput {
    pub scope: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub rationale: String,
    /// Optional structured action the card proposes (JSON), gated by approval.
    pub proposed_action: Option<String>,
    /// Optional quick-reply options (JSON array of strings) for a QUESTION card —
    /// when engaged, they become clickable answers in the opened chat.
    pub choices: Option<String>,
    pub dedup_key: String,
    /// Unix epoch past which this card is stale (date-bound cards only; None = never
    /// expires). `gc_expired_suggestions` retires it once the date passes.
    pub relevant_until: Option<i64>,
}

/// A suggestion card as shown in the dashboard.
#[derive(Debug, Clone)]
pub struct SuggestionRow {
    pub id: i64,
    pub scope: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub rationale: String,
    pub proposed_action: Option<String>,
    /// Quick-reply options (JSON array of strings) for a question card, or None.
    pub choices: Option<String>,
    pub status: String,
    pub feedback: Option<String>,
    pub dedup_key: String,
    pub created_at: i64,
}

/// A curated contact (rubrica). Knowledge ABOUT them lives in the memory DB,
/// linked by handle (`channel:identifier`); this row is just the address-book entry.
#[derive(Debug, Clone)]
pub struct StoredContact {
    pub id: i64,
    pub name: String,
    pub nickname: Option<String>,
    pub notes: String,
    pub contact_type: String,
    pub is_self: bool,
    pub preferred_channel: Option<String>,
    pub avatar: Option<String>,
    pub entity_ref: Option<String>,
    /// '' = inherit the channel/global default; else automatic|draft|silent.
    pub response_mode: String,
    pub tone_of_voice: String,
    pub persona_instructions: String,
    /// Default named profile (P3); per-channel overrides may replace it.
    pub profile_id: Option<i64>,
    /// ISO date (YYYY-MM-DD), year optional ("--MM-DD" not supported: keep simple).
    pub birthday: Option<String>,
    pub identities: Vec<StoredContactIdentity>,
}

/// A reusable named persona ("Personale", "Lavoro") assignable to contacts.
#[derive(Debug, Clone)]
pub struct StoredProfile {
    pub id: i64,
    pub name: String,
    pub tone_of_voice: String,
    pub instructions: String,
}

/// One edge of the contact social graph, viewed from a specific contact.
#[derive(Debug, Clone)]
pub struct StoredRelationship {
    pub id: i64,
    pub other_contact_id: i64,
    pub other_name: String,
    pub relationship_type: String,
    /// true: "<contact> ha <other> come <type>" (edge starts at the contact).
    pub outgoing: bool,
}

#[derive(Debug, Clone)]
pub struct StoredRelationshipEdge {
    pub from_contact_id: i64,
    pub to_contact_id: i64,
    pub relationship_type: String,
}

#[derive(Debug, Clone)]
pub struct StoredContactIdentity {
    pub channel: String,
    pub identifier: String,
    pub label: Option<String>,
}

/// Per-contact isolation perimeter. `Default` = the safe deny-by-default profile a
/// contact gets when it has no explicit `contact_perimeters` row.
#[derive(Debug, Clone)]
pub struct StoredPerimeter {
    pub memory_scope: String,
    pub knowledge_folders: Vec<String>,
    pub tools_allowed: Vec<String>,
    pub tools_denied: Vec<String>,
    pub can_see_contacts: bool,
    pub can_see_calendar: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct ChatStoreMemoryBoundaryAudit {
    pub table: &'static str,
    pub graph_like: bool,
    pub canonical_policy: &'static str,
}

pub const CHAT_STORE_MEMORY_BOUNDARY_AUDIT: &[ChatStoreMemoryBoundaryAudit] = &[
    ChatStoreMemoryBoundaryAudit {
        table: "channel_inbound_seen",
        graph_like: false,
        canonical_policy: "operational inbound dedup; no semantic memory",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "chat_messages",
        graph_like: false,
        canonical_policy: "conversation log; durable facts are saved by MemoryFacade via saved_memory_ref",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "chat_threads",
        graph_like: false,
        canonical_policy: "conversation index and active pointer; workflow state lives in MemoryFacade open_loop",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "contact_channel_profiles",
        graph_like: false,
        canonical_policy: "routing/persona selection read-model; no semantic graph edge",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "contact_identities",
        graph_like: false,
        canonical_policy: "address-book handles for routing; contact knowledge lives in MemoryFacade",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "contact_perimeters",
        graph_like: false,
        canonical_policy: "privacy policy configuration; no semantic memory",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "contact_relationships",
        graph_like: true,
        canonical_policy: "mirrored into canonical MemoryRelation when both contacts have entity_ref; tombstoned on delete",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "contacts",
        graph_like: false,
        canonical_policy: "curated address-book entries; entity_ref points to canonical MemoryFacade entity",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "profiles",
        graph_like: false,
        canonical_policy: "reusable reply persona configuration; no semantic graph edge",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "remote_approvals",
        graph_like: false,
        canonical_policy: "authorization log; no semantic memory",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "settings",
        graph_like: false,
        canonical_policy: "local configuration; no semantic memory",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "suggestions",
        graph_like: false,
        canonical_policy: "proactive card read-model; accepted/dismissed outcomes write to MemoryFacade separately",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "task_thread_links",
        graph_like: false,
        canonical_policy: "task-to-thread routing; plan/workflow state lives in MemoryFacade open_loop",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "thread_attachments",
        graph_like: false,
        canonical_policy: "conversation attachment cache; produced deliverables are artifacts in MemoryFacade",
    },
    ChatStoreMemoryBoundaryAudit {
        table: "tool_runs",
        graph_like: false,
        canonical_policy: "connector execution telemetry; durable outcomes are explicit MemoryFacade records",
    },
];

impl Default for StoredPerimeter {
    fn default() -> Self {
        Self {
            memory_scope: "contact_only".to_string(),
            knowledge_folders: Vec::new(),
            tools_allowed: Vec::new(),
            tools_denied: Vec::new(),
            can_see_contacts: false,
            can_see_calendar: false,
        }
    }
}

fn json_string_list(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw)
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Row mapper for `suggestions` queries (column order must match the SELECTs).
fn map_suggestion(row: &rusqlite::Row) -> rusqlite::Result<SuggestionRow> {
    Ok(SuggestionRow {
        id: row.get(0)?,
        scope: row.get(1)?,
        kind: row.get(2)?,
        title: row.get(3)?,
        body: row.get(4)?,
        rationale: row.get(5)?,
        proposed_action: row.get(6)?,
        choices: row.get(7)?,
        status: row.get(8)?,
        feedback: row.get(9)?,
        dedup_key: row.get(10)?,
        created_at: row.get(11)?,
    })
}

impl ChatStore {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        // WAL enables concurrent readers + serialized writers — required when two
        // stores (chat + task) point at the same file. busy_timeout avoids transient
        // SQLITE_BUSY when the other writer is mid-commit.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;
        let store = Self { conn };
        store.migrate()?;
        store.seed_if_empty()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        // WAL is a no-op on in-memory DBs but busy_timeout still applies.
        conn.execute_batch("PRAGMA busy_timeout=5000;")?;
        let store = Self { conn };
        store.migrate()?;
        store.seed_if_empty()?;
        Ok(store)
    }

    pub fn threads(&self, workspace_id: &str) -> rusqlite::Result<ChatThreadSnapshot> {
        // A project is never empty: switching to a brand-new project should land
        // on a usable thread immediately, mirroring the initial 'default' seed.
        let count: i64 = self.conn.query_row(
            "select count(*) from chat_threads where workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )?;
        if count == 0 {
            self.seed_workspace(workspace_id)?;
        }
        let active_thread_id = match self.setting(&active_thread_setting_key(workspace_id))? {
            // The retired "homun" thread is inert data, never a landing thread: redirect a
            // stale pointer (or an unset one) to the first real thread and persist the
            // correction so the app stops re-landing on Homun at every launch.
            Some(thread_id) if thread_id != "homun" => thread_id,
            _ => {
                let first = self.first_thread_id(workspace_id)?.unwrap_or_default();
                if !first.is_empty() {
                    self.set_active_thread(workspace_id, &first)?;
                }
                first
            }
        };
        let mut stmt = self.conn.prepare(
            "select thread_id, title, subtitle, status, pinned, computer_session_id, task_id,
                    updated_at, message_count, source, channel_recipient, workspace_id
               from chat_threads
              where workspace_id = ?1 and thread_id <> 'homun'
              order by pinned desc, cast(updated_at as integer) desc, rowid desc",
        )?;
        let threads = stmt
            .query_map(params![workspace_id], thread_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ChatThreadSnapshot {
            active_thread_id,
            threads,
        })
    }

    pub fn create_thread(&self, workspace_id: &str) -> rusqlite::Result<ChatThread> {
        let timestamp = current_timestamp_seconds();
        let thread_id = format!("thread_{}_{}", timestamp, monotonic_suffix());
        let thread = ChatThread {
            thread_id: thread_id.clone(),
            workspace_id: Some(workspace_id.to_string()),
            title: "New task".to_string(),
            subtitle: "Local chat".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp.clone(),
            message_count: 1,
            source: None,
            channel_recipient: None,
        };
        self.insert_thread(&thread, workspace_id)?;
        self.insert_message(
            &thread.thread_id,
            &seeded_ready_message(&thread.thread_id, timestamp),
        )?;
        self.set_active_thread(workspace_id, &thread.thread_id)?;
        Ok(thread)
    }

    /// Find-or-create the persistent thread for a channel contact (one thread per
    /// contact). Tagged with `source` so the UI badges it. No seeded "ready"
    /// message — the first real message is the inbound one.
    pub fn find_or_create_channel_thread(
        &self,
        workspace_id: &str,
        source: &str,
        sender: &str,
        title: &str,
    ) -> rusqlite::Result<ChatThread> {
        let thread_id = format!("channel_{source}_{sender}");
        if let Some(thread) = self.thread(&thread_id)? {
            return Ok(thread);
        }
        let timestamp = current_timestamp_seconds();
        let thread = ChatThread {
            thread_id: thread_id.clone(),
            workspace_id: Some(workspace_id.to_string()),
            title: title.to_string(),
            subtitle: format!("Canale {source}"),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp,
            message_count: 0,
            source: Some(source.to_string()),
            channel_recipient: None,
        };
        self.insert_thread(&thread, workspace_id)?;
        Ok(thread)
    }

    pub fn set_channel_thread_recipient(
        &self,
        thread_id: &str,
        recipient: &str,
    ) -> rusqlite::Result<()> {
        let recipient = recipient.trim();
        if recipient.is_empty() {
            return Ok(());
        }
        let current = self
            .conn
            .query_row(
                "select channel_recipient from chat_threads where thread_id = ?1",
                params![thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        if !should_replace_channel_recipient(current.as_deref(), recipient) {
            return Ok(());
        }
        self.conn.execute(
            "update chat_threads set channel_recipient = ?1 where thread_id = ?2",
            params![recipient, thread_id],
        )?;
        Ok(())
    }

    pub fn select_thread(&self, thread_id: &str) -> rusqlite::Result<ChatThreadSnapshot> {
        let workspace_id = self.workspace_for_thread(thread_id)?;
        self.set_active_thread(&workspace_id, thread_id)?;
        self.threads(&workspace_id)
    }

    pub fn set_pinned(
        &self,
        thread_id: &str,
        pinned: bool,
    ) -> rusqlite::Result<ChatThreadSnapshot> {
        self.conn.execute(
            "update chat_threads set pinned = ?1, updated_at = ?2 where thread_id = ?3",
            params![pinned as i64, current_timestamp_seconds(), thread_id],
        )?;
        self.threads(&self.workspace_for_thread(thread_id)?)
    }

    pub fn rename_thread(
        &self,
        thread_id: &str,
        title: &str,
    ) -> rusqlite::Result<ChatThreadSnapshot> {
        self.conn.execute(
            "update chat_threads set title = ?1, updated_at = ?2 where thread_id = ?3",
            params![title, current_timestamp_seconds(), thread_id],
        )?;
        self.threads(&self.workspace_for_thread(thread_id)?)
    }

    pub fn set_status(
        &self,
        thread_id: &str,
        status: &str,
    ) -> rusqlite::Result<ChatThreadSnapshot> {
        self.conn.execute(
            "update chat_threads set status = ?1, updated_at = ?2 where thread_id = ?3",
            params![status, current_timestamp_seconds(), thread_id],
        )?;
        self.threads(&self.workspace_for_thread(thread_id)?)
    }

    pub fn delete_thread(&self, thread_id: &str) -> rusqlite::Result<ChatThreadSnapshot> {
        // Capture the project before the row is gone so we re-scope correctly.
        let workspace_id = self.workspace_for_thread(thread_id)?;
        self.conn.execute(
            "delete from chat_messages where thread_id = ?1",
            params![thread_id],
        )?;
        self.conn.execute(
            "delete from task_thread_links where thread_id = ?1",
            params![thread_id],
        )?;
        self.conn.execute(
            "delete from chat_threads where thread_id = ?1",
            params![thread_id],
        )?;
        let active_key = active_thread_setting_key(&workspace_id);
        if self.setting(&active_key)?.as_deref() == Some(thread_id) {
            if let Some(next_thread_id) = self.first_thread_id(&workspace_id)? {
                self.set_active_thread(&workspace_id, &next_thread_id)?;
            } else {
                // Last thread in this project deleted — reseed a default thread
                // for it so the project is never empty.
                self.seed_workspace(&workspace_id)?;
            }
        }
        self.threads(&workspace_id)
    }

    /// Cascading purge of ALL chat data for a workspace: threads, messages,
    /// task-thread links, and the workspace's settings row. Called when a
    /// project workspace is deleted (`delete_workspace`). Unlike
    /// `delete_thread`, this does NOT reseed — the workspace is gone for good.
    /// Returns the number of threads removed.
    pub fn purge_workspace(&self, workspace_id: &str) -> rusqlite::Result<usize> {
        let thread_ids: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("select thread_id from chat_threads where workspace_id = ?1")?;
            let rows = stmt.query_map(params![workspace_id], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let count = thread_ids.len();
        for thread_id in &thread_ids {
            self.conn.execute(
                "delete from chat_messages where thread_id = ?1",
                params![thread_id],
            )?;
            self.conn.execute(
                "delete from task_thread_links where thread_id = ?1",
                params![thread_id],
            )?;
        }
        self.conn.execute(
            "delete from chat_threads where workspace_id = ?1",
            params![workspace_id],
        )?;
        self.conn.execute(
            "delete from chat_settings where key = ?1",
            params![active_thread_setting_key(workspace_id)],
        )?;
        Ok(count)
    }

    /// Reclaims free space from the SQLite file. Call periodically (boot / 24h),
    /// NOT on every delete. VACUUM cannot run inside a transaction.
    pub fn vacuum(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch("VACUUM")?;
        Ok(())
    }

    pub fn messages(&self, thread_id: &str) -> rusqlite::Result<ChatMessagesSnapshot> {
        // Load every row once, in rowid order (the historical linear order, which is
        // also the fallback). We pull `parent_id` too so the displayed conversation
        // can be resolved as the path root→active_leaf without extra queries.
        let mut stmt = self.conn.prepare(
            "select id, role, text, timestamp, metadata, metrics_json, feedback,
                    saved_memory_ref, linked_task_id, linked_automation_ref, attachments_json,
                    event_parts_json, parent_id
               from chat_messages
              where thread_id = ?1
              order by rowid asc",
        )?;
        let mut order: Vec<String> = Vec::new();
        let mut parents: HashMap<String, Option<String>> = HashMap::new();
        let mut by_id: HashMap<String, ChatMessage> = HashMap::new();
        let rows = stmt.query_map(params![thread_id], |row| {
            let parent: Option<String> = row.get(12)?;
            Ok((message_from_row(row)?, parent))
        })?;
        for row in rows {
            let (message, parent) = row?;
            order.push(message.id.clone());
            parents.insert(message.id.clone(), parent);
            by_id.insert(message.id.clone(), message);
        }
        drop(stmt);

        let ordered_ids = self.displayed_path(thread_id, &order, &parents);
        let messages = ordered_ids
            .into_iter()
            .filter_map(|id| by_id.remove(&id))
            .collect();
        Ok(ChatMessagesSnapshot {
            thread_id: thread_id.to_string(),
            messages,
        })
    }

    /// Ids of the conversation to display, as the path root→`active_leaf_id`. With
    /// branches this is a SUBSET of the thread's rows (the inactive siblings are
    /// hidden). Falls back to `order` (rowid order — the historical linear view)
    /// only when the tree can't yield a path at all: no leaf recorded, or a
    /// broken/cyclic chain. For a linear thread the walk equals rowid order, so
    /// reads stay identical to before branching.
    fn displayed_path(
        &self,
        thread_id: &str,
        order: &[String],
        parents: &HashMap<String, Option<String>>,
    ) -> Vec<String> {
        let leaf: Option<String> = self
            .conn
            .query_row(
                "select active_leaf_id from chat_threads where thread_id = ?1",
                params![thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .ok()
            .flatten()
            .flatten();
        let mut chain: Vec<String> = Vec::new();
        if let Some(mut cur) = leaf {
            let mut seen: HashSet<String> = HashSet::new();
            loop {
                // Ancestor not among the thread's rows, or a cycle → give up, fall back.
                if !parents.contains_key(&cur) || !seen.insert(cur.clone()) {
                    chain.clear();
                    break;
                }
                chain.push(cur.clone());
                match parents.get(&cur).cloned().flatten() {
                    Some(parent) => cur = parent,
                    None => break,
                }
            }
            chain.reverse();
        }
        if chain.is_empty() {
            order.to_vec()
        } else {
            chain
        }
    }

    /// Unix-seconds timestamp of the most recent message in a thread (None when
    /// the thread has no messages). Per-contact watermark for channel
    /// history-recovery: a recovered message older-or-equal to this was already
    /// handled and must not be replied to again.
    pub fn latest_message_timestamp(&self, thread_id: &str) -> rusqlite::Result<Option<i64>> {
        self.conn.query_row(
            "select max(cast(timestamp as integer)) from chat_messages where thread_id = ?1",
            params![thread_id],
            |row| row.get::<_, Option<i64>>(0),
        )
    }

    pub fn thread(&self, thread_id: &str) -> rusqlite::Result<Option<ChatThread>> {
        self.conn
            .query_row(
                "select thread_id, title, subtitle, status, pinned, computer_session_id, task_id,
                        updated_at, message_count, source, channel_recipient
                   from chat_threads
                  where thread_id = ?1",
                params![thread_id],
                thread_from_row,
            )
            .optional()
    }

    pub fn thread_by_task_id(&self, task_id: &str) -> rusqlite::Result<Option<ChatThread>> {
        // Primary (legacy single-task) match wins: a thread's own task_id.
        if let Some(thread) = self
            .conn
            .query_row(
                "select thread_id, title, subtitle, status, pinned, computer_session_id, task_id,
                        updated_at, message_count, source, channel_recipient
                   from chat_threads
                  where task_id = ?1",
                params![task_id],
                thread_from_row,
            )
            .optional()?
        {
            return Ok(Some(thread));
        }
        // Fallback (A1.2): a member task materialized by the Brain — resolve its
        // owning thread through the link table.
        match self.thread_id_for_member_task(task_id)? {
            Some(thread_id) => self.thread(&thread_id),
            None => Ok(None),
        }
    }

    pub fn message(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> rusqlite::Result<Option<ChatMessage>> {
        self.conn
            .query_row(
                "select id, role, text, timestamp, metadata, metrics_json, feedback,
                        saved_memory_ref, linked_task_id, linked_automation_ref, attachments_json,
                        event_parts_json
                   from chat_messages
                  where thread_id = ?1 and id = ?2",
                params![thread_id, message_id],
                message_from_row,
            )
            .optional()
    }

    pub fn link_message_task(
        &self,
        thread_id: &str,
        message_id: &str,
        task_id: &str,
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        self.conn.execute(
            "update chat_messages
                set linked_task_id = ?1
              where thread_id = ?2 and id = ?3",
            params![task_id, thread_id, message_id],
        )?;
        self.messages(thread_id)
    }

    pub fn commit_prompt_result(
        &self,
        thread_id: &str,
        user_message: &ChatMessage,
        assistant_message: &ChatMessage,
        branch_from_id: Option<&str>,
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        // Edit-as-branch: attach the new turn as a SIBLING of `branch_from_id` by
        // re-rooting the active leaf at that message's parent before inserting. The
        // old branch stays in the tree, reachable via the sibling switcher. Without
        // `branch_from_id` this is a plain append onto the current leaf (today's
        // linear behavior).
        if let Some(branch_from) = branch_from_id {
            let parent = self.parent_of(thread_id, branch_from)?;
            self.set_active_leaf(thread_id, parent.as_deref())?;
        }
        self.insert_message(thread_id, user_message)?;
        self.update_thread_after_messages(thread_id, Some(&user_message.text))?;
        self.insert_message(thread_id, assistant_message)?;
        self.update_thread_after_messages(thread_id, None)?;
        self.messages(thread_id)
    }

    /// Commit a regenerated answer as a SIBLING of the previous one: re-root the
    /// active leaf at the prompting user message, then hang the new assistant
    /// message off it. The earlier answer is preserved as an alternative branch.
    pub fn commit_regenerated_answer(
        &self,
        thread_id: &str,
        user_message_id: &str,
        assistant_message: &ChatMessage,
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        self.set_active_leaf(thread_id, Some(user_message_id))?;
        self.insert_message(thread_id, assistant_message)?;
        self.update_thread_after_messages(thread_id, None)?;
        self.messages(thread_id)
    }

    /// Point a thread's displayed path at a specific leaf (the ‹ n/m › switcher).
    /// `None` clears the pointer (the read path then falls back to rowid order).
    pub fn set_active_leaf(&self, thread_id: &str, leaf_id: Option<&str>) -> rusqlite::Result<()> {
        self.conn.execute(
            "update chat_threads set active_leaf_id = ?1 where thread_id = ?2",
            params![leaf_id, thread_id],
        )?;
        Ok(())
    }

    /// Name (or clear, with `None`) a branch — the label rides on the branch's head
    /// node and shows in the switcher (Phase 4, for the coding workflow).
    pub fn set_branch_label(
        &self,
        thread_id: &str,
        message_id: &str,
        label: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "update chat_messages set branch_label = ?1 where thread_id = ?2 and id = ?3",
            params![label, thread_id, message_id],
        )?;
        Ok(())
    }

    fn parent_of(&self, thread_id: &str, message_id: &str) -> rusqlite::Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "select parent_id from chat_messages where thread_id = ?1 and id = ?2",
                params![thread_id, message_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Children of a node (or the roots, when `parent` is `None`), in creation order.
    fn children_of(&self, thread_id: &str, parent: Option<&str>) -> rusqlite::Result<Vec<String>> {
        match parent {
            Some(parent) => {
                let mut stmt = self.conn.prepare(
                    "select id from chat_messages
                      where thread_id = ?1 and parent_id = ?2
                      order by rowid asc",
                )?;
                stmt.query_map(params![thread_id, parent], |row| row.get(0))?
                    .collect()
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "select id from chat_messages
                      where thread_id = ?1 and parent_id is null
                      order by rowid asc",
                )?;
                stmt.query_map(params![thread_id], |row| row.get(0))?
                    .collect()
            }
        }
    }

    /// Follow the most-recently-created child down from `node` to a leaf — the head
    /// of a sibling resolves to the tip of its branch, which is what the switcher
    /// activates when you select it.
    fn subtree_leaf(&self, thread_id: &str, node: &str) -> rusqlite::Result<String> {
        let mut cur = node.to_string();
        let mut guard = 0usize;
        loop {
            let child: Option<String> = self
                .conn
                .query_row(
                    "select id from chat_messages
                      where thread_id = ?1 and parent_id = ?2
                      order by rowid desc limit 1",
                    params![thread_id, cur],
                    |row| row.get(0),
                )
                .optional()?;
            match child {
                Some(child) => cur = child,
                None => break,
            }
            guard += 1;
            if guard > 100_000 {
                break;
            }
        }
        Ok(cur)
    }

    fn branch_label_of(
        &self,
        thread_id: &str,
        message_id: &str,
    ) -> rusqlite::Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "select branch_label from chat_messages where thread_id = ?1 and id = ?2",
                params![thread_id, message_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    /// Ids of the active path root→leaf (lean walk, no row payload).
    fn active_path_ids(&self, thread_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut cur: Option<String> = self
            .conn
            .query_row(
                "select active_leaf_id from chat_threads where thread_id = ?1",
                params![thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let mut chain: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        while let Some(id) = cur {
            if !seen.insert(id.clone()) {
                break;
            }
            cur = self.parent_of(thread_id, &id)?;
            chain.push(id);
        }
        chain.reverse();
        Ok(chain)
    }

    /// Every branch point on the current active path: the nodes whose parent has
    /// more than one child, with the options needed to switch between them.
    pub fn branch_options(&self, thread_id: &str) -> rusqlite::Result<Vec<BranchPoint>> {
        let path = self.active_path_ids(thread_id)?;
        let mut out: Vec<BranchPoint> = Vec::new();
        for node in &path {
            let parent = self.parent_of(thread_id, node)?;
            let children = self.children_of(thread_id, parent.as_deref())?;
            if children.len() < 2 {
                continue;
            }
            let active_index = children.iter().position(|c| c == node).unwrap_or(0);
            let mut options: Vec<BranchOption> = Vec::with_capacity(children.len());
            for child in &children {
                options.push(BranchOption {
                    leaf_id: self.subtree_leaf(thread_id, child)?,
                    label: self.branch_label_of(thread_id, child)?,
                    child_id: child.clone(),
                });
            }
            out.push(BranchPoint {
                node_id: node.clone(),
                active_index,
                options,
            });
        }
        Ok(out)
    }

    pub fn commit_continuation_result(
        &self,
        thread_id: &str,
        message_id: &str,
        assistant_message: &ChatMessage,
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        self.upsert_message(thread_id, message_id, assistant_message)?;
        self.update_thread_after_messages(thread_id, None)?;
        self.messages(thread_id)
    }

    /// Records the durable memory reference on a message after an explicit
    /// "save to memory", so the UI can show it as saved across reloads.
    pub fn set_message_saved_memory_ref(
        &self,
        thread_id: &str,
        message_id: &str,
        memory_ref: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "update chat_messages set saved_memory_ref = ?1 where thread_id = ?2 and id = ?3",
            params![memory_ref, thread_id, message_id],
        )?;
        Ok(())
    }

    /// Overwrites a message's text in place (used to mark a pending action as
    /// executed so the confirmation card never reopens on reload).
    pub fn set_message_text(
        &self,
        thread_id: &str,
        message_id: &str,
        text: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "update chat_messages set text = ?1 where thread_id = ?2 and id = ?3",
            params![text, thread_id, message_id],
        )?;
        Ok(())
    }

    pub fn append_assistant_message(
        &self,
        thread_id: &str,
        message: &ChatMessage,
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        self.insert_message(thread_id, message)?;
        self.update_thread_after_messages(thread_id, None)?;
        self.messages(thread_id)
    }

    /// Store a remote approval before a card is streamed. It is deliberately
    /// not executable until a chat-originated request has later been bound to
    /// the assistant message that contains its exact marker.
    pub fn create_remote_approval(&self, input: &RemoteApprovalInput<'_>) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert into remote_approvals (
                approval_id, code, tool, arguments_json, label, thread_id,
                source_message_id, requires_source, status, created_at,
                expires_at, dispatched_at
             ) values (?1, ?2, ?3, ?4, ?5, ?6, null, ?7, 'pending', ?8, ?9, null)",
            params![
                input.approval_id,
                input.code,
                input.tool,
                input.arguments.to_string(),
                input.label,
                input.thread_id,
                if input.requires_source { 1 } else { 0 },
                Self::now_secs(),
                input.expires_at,
            ],
        )?;
        Ok(())
    }

    /// Bind an approval to the exact assistant message that persisted its
    /// confirmation card. A different source can never overwrite this binding.
    pub fn bind_remote_approval_source(
        &self,
        approval_id: &str,
        thread_id: &str,
        message_id: &str,
    ) -> rusqlite::Result<Option<RemoteApprovalRow>> {
        self.conn.execute(
            "update remote_approvals
                set source_message_id = ?1
              where approval_id = ?2
                and thread_id = ?3
                and status = 'pending'
                and source_message_id is null",
            params![message_id, approval_id, thread_id],
        )?;
        self.remote_approval_by_id(approval_id)
    }

    /// Read a pending approval by its public short code, expiring stale rows as
    /// part of the lookup so channel control words cannot activate old work.
    pub fn pending_remote_approval(
        &self,
        code: &str,
    ) -> rusqlite::Result<Option<RemoteApprovalRow>> {
        let now = Self::now_secs();
        self.conn.execute(
            "update remote_approvals
                set status = 'expired'
              where status = 'pending' and expires_at <= ?1",
            params![now],
        )?;
        self.remote_approval_by_code_status(code, "pending")
    }

    /// Claim a pending approval exactly once. The caller must validate source
    /// provenance before calling this transition.
    pub fn claim_remote_approval(
        &self,
        approval_id: &str,
    ) -> rusqlite::Result<Option<RemoteApprovalRow>> {
        let changed = self.conn.execute(
            "update remote_approvals
                set status = 'executing'
              where approval_id = ?1
                and status = 'pending'
                and expires_at > ?2",
            params![approval_id, Self::now_secs()],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        self.remote_approval_by_id(approval_id)
    }

    pub fn complete_remote_approval(
        &self,
        approval_id: &str,
        status: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "update remote_approvals
                set status = ?1, resolved_at = ?2
              where approval_id = ?3 and status = 'executing'",
            params![status, Self::now_secs(), approval_id],
        )?;
        Ok(())
    }

    pub fn cancel_remote_approval_by_code(&self, code: &str) -> rusqlite::Result<bool> {
        let changed = self.conn.execute(
            "update remote_approvals
                set status = 'cancelled', resolved_at = ?1
              where code = ?2 and status = 'pending'",
            params![Self::now_secs(), code.trim().to_ascii_uppercase()],
        )?;
        Ok(changed > 0)
    }

    /// An in-app confirmation wins over its remote counterpart, preventing a
    /// later Telegram tap from replaying the same action.
    pub fn supersede_remote_approval(&self, approval_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "update remote_approvals
                set status = 'superseded', resolved_at = ?1
              where approval_id = ?2 and status = 'pending'",
            params![Self::now_secs(), approval_id],
        )?;
        Ok(())
    }

    pub fn mark_remote_approval_dispatched(&self, approval_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "update remote_approvals
                set dispatched_at = ?1
              where approval_id = ?2 and status = 'pending'",
            params![Self::now_secs(), approval_id],
        )?;
        Ok(())
    }

    fn remote_approval_by_id(
        &self,
        approval_id: &str,
    ) -> rusqlite::Result<Option<RemoteApprovalRow>> {
        self.conn
            .query_row(
                "select approval_id, code, tool, arguments_json, label, thread_id,
                        source_message_id, requires_source, status, expires_at, dispatched_at
                   from remote_approvals where approval_id = ?1",
                params![approval_id],
                remote_approval_from_row,
            )
            .optional()
    }

    fn remote_approval_by_code_status(
        &self,
        code: &str,
        status: &str,
    ) -> rusqlite::Result<Option<RemoteApprovalRow>> {
        self.conn
            .query_row(
                "select approval_id, code, tool, arguments_json, label, thread_id,
                        source_message_id, requires_source, status, expires_at, dispatched_at
                   from remote_approvals
                  where code = ?1 and status = ?2",
                params![code.trim().to_ascii_uppercase(), status],
                remote_approval_from_row,
            )
            .optional()
    }

    // ---- Contact book (curated rubrica) -------------------------------------

    fn now_secs() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    /// Read/write a plain settings flag (used e.g. for the one-shot backfill guard).
    pub fn flag(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.setting(key)
    }
    pub fn set_flag(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert into settings(key, value) values(?1, ?2)
             on conflict(key) do update set value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ── Plugin/addon enabled-state (ADR 0011 §6/§10-A) ──────────────────────────
    // A plugin is enabled by default; disabling persists "0". The same flag gates
    // the plugin's UI (nav+panel) AND its engine — detaching makes all three vanish.

    /// True unless the plugin was explicitly disabled. Default-on so a freshly
    /// shipped addon works without setup.
    pub fn plugin_enabled(&self, id: &str) -> bool {
        self.flag(&format!("plugin:{id}:enabled"))
            .ok()
            .flatten()
            .map(|v| v != "0")
            .unwrap_or(true)
    }

    pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> rusqlite::Result<()> {
        self.set_flag(
            &format!("plugin:{id}:enabled"),
            if enabled { "1" } else { "0" },
        )
    }

    pub fn contact_id_by_identity(
        &self,
        channel: &str,
        identifier: &str,
    ) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "select contact_id from contact_identities where channel = ?1 and identifier = ?2",
                params![channel, identifier],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn create_contact(
        &self,
        name: &str,
        contact_type: &str,
        is_self: bool,
        notes: &str,
        entity_ref: Option<&str>,
    ) -> rusqlite::Result<i64> {
        let now = Self::now_secs();
        self.conn.execute(
            "insert into contacts(name, contact_type, is_self, notes, entity_ref, created_at, updated_at)
             values(?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![name, contact_type, is_self as i64, notes, entity_ref, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn add_identity(
        &self,
        contact_id: i64,
        channel: &str,
        identifier: &str,
        label: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert or ignore into contact_identities(contact_id, channel, identifier, label)
             values(?1, ?2, ?3, ?4)",
            params![contact_id, channel, identifier, label],
        )?;
        Ok(())
    }

    pub fn remove_identity(&self, channel: &str, identifier: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "delete from contact_identities where channel = ?1 and identifier = ?2",
            params![channel, identifier],
        )?;
        Ok(())
    }

    /// Resolve an inbound (channel, sender) to a contact, creating a curated row on
    /// first contact. This is the curation boundary: only people who actually message
    /// us (or are added by hand) become contacts — never chat-mentioned persons.
    pub fn ensure_contact_for_identity(
        &self,
        channel: &str,
        identifier: &str,
        display: &str,
        is_self: bool,
        entity_ref: Option<&str>,
    ) -> rusqlite::Result<i64> {
        if let Some(id) = self.contact_id_by_identity(channel, identifier)? {
            if is_self {
                let now = Self::now_secs();
                self.conn.execute(
                    "update contacts
                     set contact_type = 'self', is_self = 1, entity_ref = coalesce(?1, entity_ref),
                         updated_at = ?2
                     where id = ?3",
                    params![entity_ref, now, id],
                )?;
            }
            return Ok(id);
        }
        let name = if display.trim().is_empty() {
            identifier
        } else {
            display.trim()
        };
        let contact_type = if is_self { "self" } else { "unknown" };
        let id = self.create_contact(name, contact_type, is_self, "", entity_ref)?;
        self.add_identity(id, channel, identifier, None)?;
        Ok(id)
    }

    /// Handles ("channel:identifier") for a contact — used to read memory episodes/facts
    /// from the memory DB, which keys conversation memory by handle.
    pub fn contact_handles(&self, contact_id: i64) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("select channel, identifier from contact_identities where contact_id = ?1")?;
        let rows = stmt.query_map(params![contact_id], |row| {
            Ok(format!(
                "{}:{}",
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?
            ))
        })?;
        rows.collect()
    }

    fn identities_for(&self, contact_id: i64) -> rusqlite::Result<Vec<StoredContactIdentity>> {
        let mut stmt = self.conn.prepare(
            "select channel, identifier, label from contact_identities where contact_id = ?1 order by id",
        )?;
        let rows = stmt.query_map(params![contact_id], |row| {
            Ok(StoredContactIdentity {
                channel: row.get(0)?,
                identifier: row.get(1)?,
                label: row.get(2)?,
            })
        })?;
        rows.collect()
    }

    pub fn contact_by_id(&self, id: i64) -> rusqlite::Result<Option<StoredContact>> {
        type ContactRow = (
            String,
            Option<String>,
            String,
            String,
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            String,
            String,
            Option<i64>,
            Option<String>,
        );
        let row: Option<ContactRow> = self
            .conn
            .query_row(
                "select name, nickname, notes, contact_type, is_self, preferred_channel, avatar,
                        entity_ref, response_mode, tone_of_voice, persona_instructions,
                        profile_id, birthday
                 from contacts where id = ?1",
                params![id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            name,
            nickname,
            notes,
            contact_type,
            is_self,
            preferred_channel,
            avatar,
            entity_ref,
            response_mode,
            tone_of_voice,
            persona_instructions,
            profile_id,
            birthday,
        )) = row
        else {
            return Ok(None);
        };
        Ok(Some(StoredContact {
            id,
            name,
            nickname,
            notes,
            // The owner card: honor BOTH the flag and the user-facing type "self"
            // ("Sono io" set from the UI type select) — the owner bypass must never
            // miss because only one of the two was set.
            is_self: is_self != 0 || contact_type == "self",
            contact_type,
            preferred_channel,
            avatar,
            entity_ref,
            response_mode,
            tone_of_voice,
            persona_instructions,
            profile_id,
            birthday,
            identities: self.identities_for(id)?,
        }))
    }

    pub fn list_contacts(&self) -> rusqlite::Result<Vec<StoredContact>> {
        let mut stmt = self
            .conn
            .prepare("select id from contacts order by lower(name)")?;
        let ids: Vec<i64> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(contact) = self.contact_by_id(id)? {
                out.push(contact);
            }
        }
        Ok(out)
    }

    pub fn update_contact(
        &self,
        id: i64,
        name: Option<&str>,
        nickname: Option<&str>,
        notes: Option<&str>,
        contact_type: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = Self::now_secs();
        if let Some(v) = name {
            self.conn.execute(
                "update contacts set name = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = nickname {
            self.conn.execute(
                "update contacts set nickname = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = notes {
            self.conn.execute(
                "update contacts set notes = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = contact_type {
            // Keep the owner flag in sync with the user-facing type ("Sono io").
            self.conn.execute(
                "update contacts set contact_type = ?1, is_self = ?2, updated_at = ?3 where id = ?4",
                params![v, (v == "self") as i64, now, id],
            )?;
        }
        Ok(())
    }

    /// Re-point a contact's graph entity_ref (used when the owner's fragmented
    /// identities are unified into person:self — the self-contact must follow).
    pub fn set_contact_entity_ref(&self, id: i64, entity_ref: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "update contacts set entity_ref = ?1, updated_at = ?2 where id = ?3",
            params![entity_ref, Self::now_secs(), id],
        )?;
        Ok(())
    }

    /// Merge `absorbed` into `survivor`: move its identities (drop UNIQUE collisions),
    /// then delete it. Memory-side relinking is done by the caller via entity_ref.
    pub fn merge_contacts(&self, survivor: i64, absorbed: i64) -> rusqlite::Result<()> {
        if survivor == absorbed {
            return Ok(());
        }
        let mut stmt = self.conn.prepare(
            "select channel, identifier, label from contact_identities where contact_id = ?1",
        )?;
        let moved: Vec<(String, String, Option<String>)> = stmt
            .query_map(params![absorbed], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for (channel, identifier, label) in moved {
            self.conn.execute(
                "insert or ignore into contact_identities(contact_id, channel, identifier, label)
                 values(?1, ?2, ?3, ?4)",
                params![survivor, channel, identifier, label],
            )?;
        }
        self.conn
            .execute("delete from contacts where id = ?1", params![absorbed])?;
        Ok(())
    }

    /// Remove a contact and its channel identities (explicit cascade — SQLite FK
    /// enforcement isn't assumed to be on).
    pub fn delete_contact(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "delete from contact_identities where contact_id = ?1",
            params![id],
        )?;
        self.conn
            .execute("delete from contacts where id = ?1", params![id])?;
        Ok(())
    }

    /// Update the persona/tone/response-mode fields (None = leave unchanged).
    pub fn update_contact_persona(
        &self,
        id: i64,
        tone_of_voice: Option<&str>,
        persona_instructions: Option<&str>,
        response_mode: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = Self::now_secs();
        if let Some(v) = tone_of_voice {
            self.conn.execute(
                "update contacts set tone_of_voice = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = persona_instructions {
            self.conn.execute(
                "update contacts set persona_instructions = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = response_mode {
            self.conn.execute(
                "update contacts set response_mode = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        Ok(())
    }

    /// Per-contact response mode for an inbound (channel, sender). None = unknown
    /// sender or inherit ('') → the caller falls back to the global policy.
    pub fn contact_response_mode(
        &self,
        channel: &str,
        identifier: &str,
    ) -> rusqlite::Result<Option<String>> {
        let mode: Option<String> = self
            .conn
            .query_row(
                "select c.response_mode from contacts c
                 join contact_identities i on i.contact_id = c.id
                 where i.channel = ?1 and i.identifier = ?2",
                params![channel, identifier],
                |row| row.get(0),
            )
            .optional()?;
        Ok(mode.filter(|m| !m.trim().is_empty()))
    }

    /// The curated contact's display name for a channel identity, if one exists.
    /// Used to label "recently seen" chat ids cleanly instead of the thread title
    /// (which can be the text of a message).
    pub fn contact_name_for_identity(
        &self,
        channel: &str,
        identifier: &str,
    ) -> rusqlite::Result<Option<String>> {
        let name: Option<String> = self
            .conn
            .query_row(
                "select c.name from contacts c
                 join contact_identities i on i.contact_id = c.id
                 where i.channel = ?1 and i.identifier = ?2",
                params![channel, identifier],
                |row| row.get(0),
            )
            .optional()?;
        Ok(name.filter(|n| !n.trim().is_empty()))
    }

    /// The contact's isolation perimeter; a missing row = the safe default.
    pub fn perimeter_or_default(&self, contact_id: i64) -> StoredPerimeter {
        let row: Option<(String, String, String, String, i64, i64)> = self
            .conn
            .query_row(
                "select memory_scope, knowledge_folders, tools_allowed, tools_denied,
                        can_see_contacts, can_see_calendar
                 from contact_perimeters where contact_id = ?1",
                params![contact_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .ok()
            .flatten();
        let Some((memory_scope, folders, allowed, denied, see_contacts, see_calendar)) = row else {
            return StoredPerimeter::default();
        };
        StoredPerimeter {
            memory_scope,
            knowledge_folders: json_string_list(&folders),
            tools_allowed: json_string_list(&allowed),
            tools_denied: json_string_list(&denied),
            can_see_contacts: see_contacts != 0,
            can_see_calendar: see_calendar != 0,
        }
    }

    pub fn set_perimeter(&self, contact_id: i64, p: &StoredPerimeter) -> rusqlite::Result<()> {
        let to_json =
            |list: &Vec<String>| serde_json::to_string(list).unwrap_or_else(|_| "[]".into());
        self.conn.execute(
            "insert into contact_perimeters(
                contact_id, memory_scope, knowledge_folders, tools_allowed, tools_denied,
                can_see_contacts, can_see_calendar, updated_at
             ) values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             on conflict(contact_id) do update set
                memory_scope = excluded.memory_scope,
                knowledge_folders = excluded.knowledge_folders,
                tools_allowed = excluded.tools_allowed,
                tools_denied = excluded.tools_denied,
                can_see_contacts = excluded.can_see_contacts,
                can_see_calendar = excluded.can_see_calendar,
                updated_at = excluded.updated_at",
            params![
                contact_id,
                p.memory_scope,
                to_json(&p.knowledge_folders),
                to_json(&p.tools_allowed),
                to_json(&p.tools_denied),
                p.can_see_contacts as i64,
                p.can_see_calendar as i64,
                Self::now_secs(),
            ],
        )?;
        Ok(())
    }

    // ---- Named profiles (P3) ------------------------------------------------

    pub fn list_profiles(&self) -> rusqlite::Result<Vec<StoredProfile>> {
        let mut stmt = self.conn.prepare(
            "select id, name, tone_of_voice, instructions from profiles order by lower(name)",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(StoredProfile {
                id: row.get(0)?,
                name: row.get(1)?,
                tone_of_voice: row.get(2)?,
                instructions: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    pub fn profile_by_id(&self, id: i64) -> rusqlite::Result<Option<StoredProfile>> {
        self.conn
            .query_row(
                "select id, name, tone_of_voice, instructions from profiles where id = ?1",
                params![id],
                |row| {
                    Ok(StoredProfile {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        tone_of_voice: row.get(2)?,
                        instructions: row.get(3)?,
                    })
                },
            )
            .optional()
    }

    pub fn create_profile(
        &self,
        name: &str,
        tone_of_voice: &str,
        instructions: &str,
    ) -> rusqlite::Result<i64> {
        let now = Self::now_secs();
        self.conn.execute(
            "insert into profiles(name, tone_of_voice, instructions, created_at, updated_at)
             values(?1, ?2, ?3, ?4, ?4)",
            params![name, tone_of_voice, instructions, now],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn update_profile(
        &self,
        id: i64,
        name: Option<&str>,
        tone_of_voice: Option<&str>,
        instructions: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = Self::now_secs();
        if let Some(v) = name {
            self.conn.execute(
                "update profiles set name = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = tone_of_voice {
            self.conn.execute(
                "update profiles set tone_of_voice = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = instructions {
            self.conn.execute(
                "update profiles set instructions = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        Ok(())
    }

    /// Delete a profile and detach it everywhere (no FK on the ALTERed column).
    pub fn delete_profile(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "update contacts set profile_id = null where profile_id = ?1",
            params![id],
        )?;
        self.conn.execute(
            "delete from contact_channel_profiles where profile_id = ?1",
            params![id],
        )?;
        self.conn
            .execute("delete from profiles where id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_contact_profile(
        &self,
        contact_id: i64,
        profile_id: Option<i64>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "update contacts set profile_id = ?1, updated_at = ?2 where id = ?3",
            params![profile_id, Self::now_secs(), contact_id],
        )?;
        Ok(())
    }

    /// None removes the override for that channel.
    pub fn set_channel_profile(
        &self,
        contact_id: i64,
        channel: &str,
        profile_id: Option<i64>,
    ) -> rusqlite::Result<()> {
        match profile_id {
            Some(pid) => {
                self.conn.execute(
                    "insert into contact_channel_profiles(contact_id, channel, profile_id)
                     values(?1, ?2, ?3)
                     on conflict(contact_id, channel) do update set profile_id = excluded.profile_id",
                    params![contact_id, channel, pid],
                )?;
            }
            None => {
                self.conn.execute(
                    "delete from contact_channel_profiles where contact_id = ?1 and channel = ?2",
                    params![contact_id, channel],
                )?;
            }
        }
        Ok(())
    }

    pub fn channel_profile_overrides(
        &self,
        contact_id: i64,
    ) -> rusqlite::Result<Vec<(String, i64)>> {
        let mut stmt = self.conn.prepare(
            "select channel, profile_id from contact_channel_profiles where contact_id = ?1",
        )?;
        let rows = stmt.query_map(params![contact_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    /// Reply-time persona resolution: (contact, channel) override → the contact's
    /// default profile → None (caller falls back to the inline fields).
    pub fn resolve_profile_for(&self, contact_id: i64, channel: &str) -> Option<StoredProfile> {
        let by_channel: Option<i64> = self
            .conn
            .query_row(
                "select profile_id from contact_channel_profiles
                 where contact_id = ?1 and channel = ?2",
                params![contact_id, channel],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        let pid = by_channel.or_else(|| {
            self.conn
                .query_row(
                    "select profile_id from contacts where id = ?1",
                    params![contact_id],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .optional()
                .ok()
                .flatten()
                .flatten()
        })?;
        self.profile_by_id(pid).ok().flatten()
    }

    // ---- Relationships (P3) -------------------------------------------------

    pub fn add_relationship(
        &self,
        from_contact_id: i64,
        to_contact_id: i64,
        relationship_type: &str,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert or ignore into contact_relationships(from_contact_id, to_contact_id, relationship_type)
             values(?1, ?2, ?3)",
            params![from_contact_id, to_contact_id, relationship_type],
        )?;
        Ok(())
    }

    pub fn remove_relationship(&self, id: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "delete from contact_relationships where id = ?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn relationship_by_id(&self, id: i64) -> rusqlite::Result<Option<StoredRelationshipEdge>> {
        self.conn
            .query_row(
                "select from_contact_id, to_contact_id, relationship_type
                 from contact_relationships where id = ?1",
                params![id],
                |row| {
                    Ok(StoredRelationshipEdge {
                        from_contact_id: row.get(0)?,
                        to_contact_id: row.get(1)?,
                        relationship_type: row.get(2)?,
                    })
                },
            )
            .optional()
    }

    /// Both directions, with the other side's display name resolved.
    pub fn relationships_for(&self, contact_id: i64) -> rusqlite::Result<Vec<StoredRelationship>> {
        let mut stmt = self.conn.prepare(
            "select r.id, c.id, c.name, r.relationship_type, (r.from_contact_id = ?1) as outgoing
             from contact_relationships r
             join contacts c on c.id = case when r.from_contact_id = ?1
                                            then r.to_contact_id else r.from_contact_id end
             where r.from_contact_id = ?1 or r.to_contact_id = ?1
             order by c.name",
        )?;
        let rows = stmt.query_map(params![contact_id], |row| {
            Ok(StoredRelationship {
                id: row.get(0)?,
                other_contact_id: row.get(1)?,
                other_name: row.get(2)?,
                relationship_type: row.get(3)?,
                outgoing: row.get::<_, i64>(4)? != 0,
            })
        })?;
        rows.collect()
    }

    pub fn set_contact_birthday(
        &self,
        contact_id: i64,
        birthday: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "update contacts set birthday = ?1, updated_at = ?2 where id = ?3",
            params![birthday, Self::now_secs(), contact_id],
        )?;
        Ok(())
    }
    // The contact "Cosa so" facts used to be a distilled JSON cache here
    // (`facts_json`). It now lives in the memory GRAPH (facts linked to the
    // contact's entity), so the cache + its accessors were removed. The `facts_json`
    // column stays in the schema, inert, to avoid a destructive migration.

    fn migrate(&self) -> rusqlite::Result<()> {
        self.conn.execute_batch(
            "
            create table if not exists settings (
                key text primary key,
                value text not null
            );

            create table if not exists chat_threads (
                thread_id text primary key,
                title text not null,
                subtitle text not null,
                status text not null,
                pinned integer not null default 0,
                computer_session_id text not null,
                task_id text not null,
                updated_at text not null,
                message_count integer not null default 0
            );

            create table if not exists chat_messages (
                id text primary key,
                thread_id text not null,
                role text not null,
                text text not null,
                timestamp text not null,
                metadata text,
                metrics_json text,
                feedback text,
                saved_memory_ref text,
                linked_task_id text,
                linked_automation_ref text,
                attachments_json text,
                event_parts_json text,
                foreign key(thread_id) references chat_threads(thread_id) on delete cascade
            );

            create index if not exists idx_chat_messages_thread
                on chat_messages(thread_id);

            -- Remote approvals are durable, auditable authorization requests.
            -- A chat-originated row is not executable until source_message_id
            -- identifies the exact persisted confirmation card.
            create table if not exists remote_approvals (
                approval_id text primary key,
                code text not null unique,
                tool text not null,
                arguments_json text not null,
                label text not null,
                thread_id text,
                source_message_id text,
                requires_source integer not null default 1,
                status text not null,
                created_at integer not null,
                expires_at integer not null,
                dispatched_at integer,
                resolved_at integer
            );

            create index if not exists idx_remote_approvals_code_status
                on remote_approvals(code, status);
            create index if not exists idx_remote_approvals_thread_source
                on remote_approvals(thread_id, source_message_id);

            -- A1.2: a chat thread owns ONE Local Computer session but may drive
            -- MANY durable tasks (the OrchestratorBrain materializes N steps from
            -- a single prompt). chat_threads.task_id stays the legacy single
            -- 'primary' task; this side table maps every additional member task
            -- back to its owning thread so the executor's session/chat surfacing
            -- (thread_by_task_id) resolves them too.
            create table if not exists task_thread_links (
                task_id text primary key,
                thread_id text not null,
                foreign key(thread_id) references chat_threads(thread_id) on delete cascade
            );

            create index if not exists idx_task_thread_links_thread
                on task_thread_links(thread_id);

            -- C: channel inbound dedup. Every inbound channel message (live or
            -- recovered from a WhatsApp history sync) is keyed by
            -- channel + message_id and recorded here on first sight. A second
            -- arrival (e.g. a live message re-appearing in a later history sync)
            -- is detected as a duplicate and dropped WITHOUT a second auto-reply.
            create table if not exists channel_inbound_seen (
                dedup_key text primary key,
                seen_at integer not null
            );

            -- Attachment persistence: a file attached in chat is ingested ONCE
            -- (text extraction / page rasterization) and its representation is
            -- stored here, keyed by thread, so it stays available across turns
            -- (no re-attach) and the model gets a manifest of available files.
            -- One row per (thread, filename) — re-attaching the same name replaces
            -- it. No FK: persistence must succeed for any thread_id, even one not
            -- yet in chat_threads, and the working set always includes this turn's
            -- files as a fallback.
            create table if not exists thread_attachments (
                id integer primary key autoincrement,
                thread_id text not null,
                display_name text not null,
                mime_type text not null,
                extracted_text text,
                images_json text not null default '[]',
                created_at integer not null
            );

            create index if not exists idx_thread_attachments_thread
                on thread_attachments(thread_id);

            -- Audit log of connector tool executions (Composio + MCP) — powers the
            -- connector status panel (roadmap #6). Append-only; pruned to a recent
            -- window. error_kind mirrors classify_connector_error
            -- (auth/rate_limit/forbidden/unavailable/other) so the UI can flag a
            -- broken connector at a glance.
            create table if not exists tool_runs (
                id integer primary key autoincrement,
                ts integer not null,
                thread_id text,
                tool text not null,
                kind text not null,
                ok integer not null,
                error_kind text,
                duration_ms integer,
                summary text
            );

            create index if not exists idx_tool_runs_ts on tool_runs(ts desc);

            -- Proactive SUGGESTIONS (ADR 0011 §7): the shared card surface for the
            -- proactive supervisor (and, later, addons). NOT a chat — discrete,
            -- dismissible cards in a dashboard, scope-tagged (a workspace id, or
            -- '__personal__'). `kind` is free text the model chooses (no rule
            -- catalog). `dedup_key` powers the durable no-repeat (a dismissed card
            -- must never reappear). `status`: pending|accepted|dismissed|snoozed.
            -- `feedback`: liked|disliked (+note) → conditions future suggestions.
            create table if not exists suggestions (
                id integer primary key autoincrement,
                scope text not null,
                kind text not null default '',
                title text not null,
                body text not null default '',
                rationale text not null default '',
                proposed_action text,
                choices text,
                status text not null default 'pending',
                feedback text,
                feedback_note text,
                dedup_key text not null default '',
                created_at integer not null,
                updated_at integer not null
            );

            create index if not exists idx_suggestions_scope_status
                on suggestions(scope, status);
            create index if not exists idx_suggestions_dedup
                on suggestions(scope, dedup_key);

            -- Contact book (curated rubrica). A contact is a person we communicate
            -- with — created from a channel identity (someone messaged us) or added
            -- by hand — NOT every person merely mentioned in chat. Knowledge ABOUT a
            -- contact stays in the memory DB, linked by handle (channel:identifier).
            create table if not exists contacts (
                id integer primary key autoincrement,
                name text not null,
                nickname text,
                notes text not null default '',
                contact_type text not null default 'unknown',
                is_self integer not null default 0,
                preferred_channel text,
                avatar text,
                entity_ref text,
                facts_json text not null default '{}',
                created_at integer not null,
                updated_at integer not null
            );

            -- Channel identities: the (channel, identifier) handles that route an
            -- inbound message to a contact. UNIQUE is the dedup spine + O(1) lookup.
            create table if not exists contact_identities (
                id integer primary key autoincrement,
                contact_id integer not null references contacts(id) on delete cascade,
                channel text not null,
                identifier text not null,
                label text,
                unique(channel, identifier)
            );

            create index if not exists idx_contact_identities_lookup
                on contact_identities(channel, identifier);
            create index if not exists idx_contact_identities_contact
                on contact_identities(contact_id);

            -- Per-contact isolation perimeter (deny-by-default). A contact WITHOUT a
            -- row uses safe defaults: contact_only memory, no other contacts/calendar
            -- mentioned, no tool restrictions beyond the channel read-only policy.
            create table if not exists contact_perimeters (
                contact_id integer primary key references contacts(id) on delete cascade,
                memory_scope text not null default 'contact_only',
                knowledge_folders text not null default '[]',
                tools_allowed text not null default '[]',
                tools_denied text not null default '[]',
                can_see_contacts integer not null default 0,
                can_see_calendar integer not null default 0,
                updated_at integer not null
            );

            -- Named profiles (P3): reusable personas ('Personale', 'Lavoro', …) a
            -- contact can adopt instead of inline tone/instructions. Resolution
            -- cascade at reply time: per-(contact, channel) override → the
            -- contact's default profile → the contact's inline fields.
            create table if not exists profiles (
                id integer primary key autoincrement,
                name text not null,
                tone_of_voice text not null default '',
                instructions text not null default '',
                created_at integer not null,
                updated_at integer not null
            );

            -- 'Marco on company Telegram → Work profile': per-channel override.
            create table if not exists contact_channel_profiles (
                contact_id integer not null references contacts(id) on delete cascade,
                channel text not null,
                profile_id integer not null,
                primary key(contact_id, channel)
            );

            -- Social graph between curated contacts ('Laura is Marco's wife').
            create table if not exists contact_relationships (
                id integer primary key autoincrement,
                from_contact_id integer not null references contacts(id) on delete cascade,
                to_contact_id integer not null references contacts(id) on delete cascade,
                relationship_type text not null,
                unique(from_contact_id, to_contact_id, relationship_type)
            );

            ",
        )?;

        // P4.1: chat threads are scoped to a project (workspace). Older DBs
        // predate the column — add it additively (existing rows fall into the
        // 'default' project). `create table if not exists` never alters an
        // existing table, so this explicit, guarded ALTER is required.
        if !self.column_exists("chat_threads", "workspace_id")? {
            self.conn.execute(
                "alter table chat_threads add column workspace_id text not null default 'default'",
                [],
            )?;
        }
        self.conn.execute(
            "create index if not exists idx_chat_threads_workspace
                on chat_threads(workspace_id)",
            [],
        )?;
        // M8: channel-originated threads carry their origin ("whatsapp"/"telegram");
        // in-app chats leave it NULL. Additive, guarded ALTER.
        if !self.column_exists("chat_threads", "source")? {
            self.conn
                .execute("alter table chat_threads add column source text", [])?;
        }
        // Channel-originated threads also remember where app-side replies should
        // be mirrored. This is intentionally thread-scoped: a WhatsApp/Telegram
        // conversation in the app must continue on the originating channel.
        if !self.column_exists("chat_threads", "channel_recipient")? {
            self.conn.execute(
                "alter table chat_threads add column channel_recipient text",
                [],
            )?;
        }
        // Contacts P2: per-contact persona/tone + response mode. response_mode '' =
        // inherit the channel/global default (backward compatible: existing contacts
        // keep today's allowlist behavior until the user customizes them).
        if !self.column_exists("contacts", "response_mode")? {
            self.conn.execute(
                "alter table contacts add column response_mode text not null default ''",
                [],
            )?;
        }
        if !self.column_exists("contacts", "tone_of_voice")? {
            self.conn.execute(
                "alter table contacts add column tone_of_voice text not null default ''",
                [],
            )?;
        }
        if !self.column_exists("contacts", "persona_instructions")? {
            self.conn.execute(
                "alter table contacts add column persona_instructions text not null default ''",
                [],
            )?;
        }
        // Contacts P3: default named profile + birthday (rubrica data).
        if !self.column_exists("contacts", "profile_id")? {
            self.conn
                .execute("alter table contacts add column profile_id integer", [])?;
        }
        if !self.column_exists("contacts", "birthday")? {
            self.conn
                .execute("alter table contacts add column birthday text", [])?;
        }
        // Proactivity Fix 2: question cards can carry quick-reply options (JSON array)
        // rendered as clickable answers when the card is engaged. Additive, guarded ALTER
        // (on existing DBs the column lands physically last; harmless — every read names
        // columns explicitly in the SELECT, so map_suggestion's index 7 stays correct).
        if !self.column_exists("suggestions", "choices")? {
            self.conn
                .execute("alter table suggestions add column choices text", [])?;
        }
        // Time-boxed suggestions: when a card hinges on a date (a trip on the 30th, a
        // deadline), the proactive generator records the date past which it's noise as a
        // unix epoch. `gc_expired_suggestions` retires those once the date passes, so a
        // stale "finalize your 30 June trip" card auto-trashes instead of lingering.
        // Additive + nullable (NULL = never expires); guarded ALTER.
        if !self.column_exists("suggestions", "relevant_until")? {
            self.conn.execute(
                "alter table suggestions add column relevant_until integer",
                [],
            )?;
        }
        // Chat branching foundation (non-destructive edit/regenerate — roadmap
        // "Evoluzioni future"). The history becomes a TREE: `chat_messages.parent_id`
        // points at the message a node hangs off (NULL = a root) and
        // `chat_threads.active_leaf_id` marks the leaf of the displayed path
        // (root→leaf). Both additive + nullable; for today's linear threads the
        // path equals rowid order, so reads stay byte-identical until branching
        // writes ship.
        if !self.column_exists("chat_messages", "parent_id")? {
            self.conn
                .execute("alter table chat_messages add column parent_id text", [])?;
        }
        if !self.column_exists("chat_threads", "active_leaf_id")? {
            self.conn.execute(
                "alter table chat_threads add column active_leaf_id text",
                [],
            )?;
        }
        self.conn.execute(
            "create index if not exists idx_chat_messages_parent
                on chat_messages(parent_id)",
            [],
        )?;
        // Phase 4: a branch can be named (e.g. a coding alternative). The label lives
        // on the sibling's head node and surfaces in the ‹ n/m › switcher.
        if !self.column_exists("chat_messages", "branch_label")? {
            self.conn
                .execute("alter table chat_messages add column branch_label text", [])?;
        }
        if !self.column_exists("chat_messages", "attachments_json")? {
            self.conn.execute(
                "alter table chat_messages add column attachments_json text",
                [],
            )?;
        }
        if !self.column_exists("chat_messages", "event_parts_json")? {
            self.conn.execute(
                "alter table chat_messages add column event_parts_json text",
                [],
            )?;
        }
        self.backfill_chat_tree()?;
        Ok(())
    }

    /// One-shot backfill of the chat tree on DBs that predate branching: every
    /// existing thread is linear, so chain each message's `parent_id` to its
    /// rowid-predecessor and point the thread's `active_leaf_id` at its last
    /// message. Guarded by a settings flag so it runs exactly once; the per-row
    /// `… is null` guards make it additionally idempotent and never clobber a
    /// value a live insert may already have set.
    fn backfill_chat_tree(&self) -> rusqlite::Result<()> {
        if self.flag("chat_tree_backfilled")?.as_deref() == Some("1") {
            return Ok(());
        }
        let thread_ids: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("select distinct thread_id from chat_messages")?;
            let ids = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ids
        };
        for thread_id in &thread_ids {
            let ids: Vec<String> = {
                let mut stmt = self.conn.prepare(
                    "select id from chat_messages where thread_id = ?1 order by rowid asc",
                )?;
                let ids = stmt
                    .query_map(params![thread_id], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                ids
            };
            let mut prev: Option<String> = None;
            for id in &ids {
                if let Some(parent) = &prev {
                    self.conn.execute(
                        "update chat_messages set parent_id = ?1
                          where id = ?2 and thread_id = ?3 and parent_id is null",
                        params![parent, id, thread_id],
                    )?;
                }
                prev = Some(id.clone());
            }
            if let Some(last) = ids.last() {
                self.conn.execute(
                    "update chat_threads set active_leaf_id = ?1
                      where thread_id = ?2 and active_leaf_id is null",
                    params![last, thread_id],
                )?;
            }
        }
        self.set_flag("chat_tree_backfilled", "1")?;
        Ok(())
    }

    fn column_exists(&self, table: &str, column: &str) -> rusqlite::Result<bool> {
        let mut stmt = self.conn.prepare(&format!("pragma table_info({table})"))?;
        let mut found = false;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == column {
                found = true;
                break;
            }
        }
        Ok(found)
    }

    /// Records a channel inbound message as seen, keyed by "{channel}:{message_id}".
    /// Returns `true` if the key was NEWLY inserted (first time we see this
    /// message), `false` if it already existed (a duplicate — e.g. a live message
    /// re-arriving inside a later history sync). Callers treat `false` as
    /// "already handled; do not record or auto-reply again", which makes the
    /// inbound pipeline idempotent across the live and history-recovery paths.
    pub fn mark_inbound_seen(&self, key: &str) -> rusqlite::Result<bool> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let inserted = self.conn.execute(
            "insert or ignore into channel_inbound_seen (dedup_key, seen_at) values (?1, ?2)",
            params![key, now],
        )?;
        Ok(inserted == 1)
    }

    /// Stores (or replaces) an ingested attachment for a thread. Keyed by filename:
    /// re-attaching the same name overwrites the prior content. Empty thread_id is
    /// rejected (no global bucket).
    pub fn upsert_thread_attachment(
        &self,
        thread_id: &str,
        display_name: &str,
        mime_type: &str,
        text: Option<&str>,
        images: &[String],
    ) -> rusqlite::Result<()> {
        if thread_id.trim().is_empty() {
            return Ok(());
        }
        self.conn.execute(
            "delete from thread_attachments where thread_id = ?1 and display_name = ?2",
            params![thread_id, display_name],
        )?;
        let images_json = serde_json::to_string(images).unwrap_or_else(|_| "[]".to_string());
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "insert into thread_attachments
                (thread_id, display_name, mime_type, extracted_text, images_json, created_at)
             values (?1, ?2, ?3, ?4, ?5, ?6)",
            params![thread_id, display_name, mime_type, text, images_json, now],
        )?;
        Ok(())
    }

    /// All attachments persisted for a thread, oldest first.
    pub fn thread_attachments(&self, thread_id: &str) -> rusqlite::Result<Vec<StoredAttachment>> {
        let mut stmt = self.conn.prepare(
            "select display_name, mime_type, extracted_text, images_json
               from thread_attachments
              where thread_id = ?1
              order by created_at asc, id asc",
        )?;
        let rows = stmt
            .query_map(params![thread_id], |row| {
                let display_name: String = row.get(0)?;
                let mime_type: String = row.get(1)?;
                let text: Option<String> = row.get(2)?;
                let images_json: String = row.get(3)?;
                let images: Vec<String> = serde_json::from_str(&images_json).unwrap_or_default();
                Ok(StoredAttachment {
                    display_name,
                    mime_type,
                    text,
                    images,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Append one connector tool execution to the audit log (roadmap #6). Best-effort:
    /// logging must never break a tool call, so callers ignore the result. Bounds the
    /// table to the most recent ~1000 rows so it never grows unboundedly.
    pub fn record_tool_run(&self, run: &ToolRunInput) -> rusqlite::Result<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "insert into tool_runs (ts, thread_id, tool, kind, ok, error_kind, duration_ms, summary)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                now,
                run.thread_id,
                run.tool,
                run.kind,
                run.ok as i64,
                run.error_kind,
                run.duration_ms,
                run.summary,
            ],
        )?;
        // Retain only the most recent runs (cheap, runs rarely).
        self.conn.execute(
            "delete from tool_runs where id <= (
                select max(id) from tool_runs
             ) - 1000",
            [],
        )?;
        Ok(())
    }

    /// Recent connector tool executions, newest first (for the status panel).
    pub fn recent_tool_runs(&self, limit: usize) -> rusqlite::Result<Vec<ToolRunRow>> {
        let mut stmt = self.conn.prepare(
            "select ts, thread_id, tool, kind, ok, error_kind, duration_ms, summary
               from tool_runs order by id desc limit ?1",
        )?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok(ToolRunRow {
                    ts: row.get(0)?,
                    thread_id: row.get(1)?,
                    tool: row.get(2)?,
                    kind: row.get(3)?,
                    ok: row.get::<_, i64>(4)? != 0,
                    error_kind: row.get(5)?,
                    duration_ms: row.get(6)?,
                    summary: row.get(7)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    // ── Proactive suggestions (ADR 0011 §7) ────────────────────────────────────

    /// True if a suggestion with this dedup_key already exists in the scope, in
    /// ANY status — so a dismissed card never reappears (durable no-repeat).
    pub fn suggestion_dedup_exists(&self, scope: &str, dedup_key: &str) -> rusqlite::Result<bool> {
        if dedup_key.trim().is_empty() {
            return Ok(false);
        }
        let n: i64 = self.conn.query_row(
            "select count(*) from suggestions where scope = ?1 and dedup_key = ?2",
            params![scope, dedup_key],
            |row| row.get(0),
        )?;
        Ok(n > 0)
    }

    /// (dedup_key, title) of recent cards in this scope, ANY status, newest first.
    /// Feeds the FUZZY anti-re-propose check (Fix 3): the exact dedup_key misses
    /// paraphrases — the supervisor's anchor varies across runs ("tappo" vs "tappo
    /// moto") — so a card already accepted or dismissed must not come back reworded.
    pub fn recent_suggestion_anchors(
        &self,
        scope: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare(
            "select dedup_key, title from suggestions where scope = ?1
               order by id desc limit ?2",
        )?;
        let rows = stmt.query_map(params![scope, limit as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect()
    }

    /// Inserts a suggestion card (pending). Caller checks `suggestion_dedup_exists`
    /// first. Returns the new id.
    pub fn insert_suggestion(&self, s: &SuggestionInput) -> rusqlite::Result<i64> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "insert into suggestions
                (scope, kind, title, body, rationale, proposed_action, choices, status, dedup_key, created_at, updated_at, relevant_until)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?9, ?10)",
            params![
                s.scope,
                s.kind,
                s.title,
                s.body,
                s.rationale,
                s.proposed_action,
                s.choices,
                s.dedup_key,
                now,
                s.relevant_until,
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Auto-trash date-bound suggestions whose `relevant_until` has passed: a
    /// "finalize your 30 June trip" card is pure noise on 6 July. Marked `stale` (not
    /// deleted) so feedback/history stay intact; the dashboard only shows `pending`, so
    /// they disappear. Returns how many were retired. Cheap; safe to call on every read.
    pub fn gc_expired_suggestions(&self) -> rusqlite::Result<usize> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "update suggestions set status = 'stale', updated_at = ?1
               where status = 'pending' and relevant_until is not null and relevant_until < ?1",
            params![now],
        )
    }

    /// Pending suggestions, newest first. `scope` None = all scopes; with a scope,
    /// only that scope. (The dashboard shows pending; status filters come later.)
    pub fn pending_suggestions(
        &self,
        scope: Option<&str>,
        limit: usize,
    ) -> rusqlite::Result<Vec<SuggestionRow>> {
        // Retire date-expired cards before listing, so the board never shows a card
        // whose date has already passed.
        let _ = self.gc_expired_suggestions();
        let mut stmt;
        let rows = if let Some(scope) = scope {
            stmt = self.conn.prepare(
                "select id, scope, kind, title, body, rationale, proposed_action, choices, status, feedback, dedup_key, created_at
                   from suggestions where status = 'pending' and scope = ?1
                   order by id desc limit ?2",
            )?;
            stmt.query_map(params![scope, limit as i64], map_suggestion)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            stmt = self.conn.prepare(
                "select id, scope, kind, title, body, rationale, proposed_action, choices, status, feedback, dedup_key, created_at
                   from suggestions where status = 'pending'
                   order by id desc limit ?1",
            )?;
            stmt.query_map(params![limit as i64], map_suggestion)?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows)
    }

    pub fn suggestion(&self, id: i64) -> rusqlite::Result<Option<SuggestionRow>> {
        self.conn
            .query_row(
                "select id, scope, kind, title, body, rationale, proposed_action, choices, status, feedback, dedup_key, created_at
                   from suggestions where id = ?1",
                params![id],
                map_suggestion,
            )
            .optional()
    }

    /// Count of pending suggestions per scope (for the zen "+N" badge).
    pub fn pending_suggestion_counts(&self) -> rusqlite::Result<Vec<(String, i64)>> {
        let mut stmt = self.conn.prepare(
            "select scope, count(*) from suggestions where status = 'pending' group by scope",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Acts on a card: status (accepted|dismissed|snoozed) + optional feedback
    /// (liked|disliked + note). Feedback conditions future suggestions (ADR 0011 §7).
    pub fn set_suggestion_status(
        &self,
        id: i64,
        status: &str,
        feedback: Option<&str>,
        feedback_note: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        self.conn.execute(
            "update suggestions set status = ?2, feedback = ?3, feedback_note = ?4, updated_at = ?5
             where id = ?1",
            params![id, status, feedback, feedback_note, now],
        )?;
        Ok(())
    }

    /// Recent feedback signals for a scope (ADR 0011 §7, the adaptive loop): cards
    /// the user marked liked/disliked, newest first. The supervisor reads these to
    /// calibrate future suggestions — privilege the style of the liked, avoid the
    /// disliked. Returns (feedback, kind, title).
    pub fn recent_feedback(
        &self,
        scope: &str,
        limit: usize,
    ) -> rusqlite::Result<Vec<(String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "select feedback, kind, title from suggestions
             where scope = ?1 and feedback is not null and feedback <> ''
             order by updated_at desc limit ?2",
        )?;
        let rows = stmt.query_map(params![scope, limit as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect()
    }

    /// Prunes channel dedup entries older than `max_age_secs` (best-effort
    /// housekeeping; the table only needs to remember the recent offline window
    /// plus a margin). Returns the number of rows removed.
    pub fn prune_inbound_seen(&self, max_age_secs: i64) -> rusqlite::Result<usize> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let cutoff = now.saturating_sub(max_age_secs);
        self.conn.execute(
            "delete from channel_inbound_seen where seen_at < ?1",
            params![cutoff],
        )
    }

    /// Links an additional (non-primary) task to a thread so it resolves via
    /// [`thread_by_task_id`]. Used by the Brain materialize path, where one
    /// prompt fans out into N durable tasks that must all surface into the
    /// thread's single Local Computer session and chat. Idempotent.
    pub fn link_task_to_thread(&self, task_id: &str, thread_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert or replace into task_thread_links (task_id, thread_id) values (?1, ?2)",
            params![task_id, thread_id],
        )?;
        Ok(())
    }

    /// Lists every member task linked to a thread (Brain fan-out). Used to
    /// aggregate progress across the N tasks driving the thread's one session.
    pub fn member_task_ids_for_thread(&self, thread_id: &str) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("select task_id from task_thread_links where thread_id = ?1")?;
        let ids = stmt
            .query_map(params![thread_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }

    /// Resolves the owning thread for a member task id via the link table.
    /// Returns `None` when the task is not a linked member (e.g. it is a
    /// thread's primary task, resolved by [`thread_by_task_id`] directly).
    fn thread_id_for_member_task(&self, task_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "select thread_id from task_thread_links where task_id = ?1",
                params![task_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }

    fn seed_if_empty(&self) -> rusqlite::Result<()> {
        let count: i64 = self
            .conn
            .query_row("select count(*) from chat_threads", [], |row| row.get(0))?;
        if count > 0 {
            return Ok(());
        }

        // First-ever seed keeps the legacy fixed ids in the 'default' project.
        let timestamp = current_timestamp_seconds();
        let thread = ChatThread {
            thread_id: "thread_active_prompt".to_string(),
            workspace_id: Some("default".to_string()),
            title: "New task".to_string(),
            subtitle: "Local chat".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: "computer_active_prompt".to_string(),
            task_id: "task_prompt_session".to_string(),
            updated_at: timestamp.clone(),
            message_count: 1,
            source: None,
            channel_recipient: None,
        };
        self.insert_thread(&thread, "default")?;
        self.insert_message(
            &thread.thread_id,
            &seeded_ready_message(&thread.thread_id, timestamp),
        )?;
        self.set_active_thread("default", &thread.thread_id)
    }

    /// Reseeds a fresh default thread for a specific project — used when its
    /// last thread is deleted, so a project is never empty.
    fn seed_workspace(&self, workspace_id: &str) -> rusqlite::Result<()> {
        let timestamp = current_timestamp_seconds();
        let thread_id = format!("thread_{}_{}", timestamp, monotonic_suffix());
        let thread = ChatThread {
            thread_id: thread_id.clone(),
            workspace_id: Some(workspace_id.to_string()),
            title: "New task".to_string(),
            subtitle: "Local chat".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp.clone(),
            message_count: 1,
            source: None,
            channel_recipient: None,
        };
        self.insert_thread(&thread, workspace_id)?;
        self.insert_message(
            &thread.thread_id,
            &seeded_ready_message(&thread.thread_id, timestamp),
        )?;
        self.set_active_thread(workspace_id, &thread.thread_id)
    }

    fn insert_thread(&self, thread: &ChatThread, workspace_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert or replace into chat_threads (
                thread_id, title, subtitle, status, pinned, computer_session_id, task_id,
                updated_at, message_count, workspace_id, source, channel_recipient
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                thread.thread_id,
                thread.title,
                thread.subtitle,
                thread.status,
                thread.pinned as i64,
                thread.computer_session_id,
                thread.task_id,
                thread.updated_at,
                thread.message_count,
                workspace_id,
                thread.source,
                thread.channel_recipient,
            ],
        )?;
        Ok(())
    }

    /// Resolves the project a thread belongs to, defaulting to 'default' for
    /// threads that predate workspace scoping or are unknown.
    pub fn workspace_for_thread(&self, thread_id: &str) -> rusqlite::Result<String> {
        Ok(self
            .conn
            .query_row(
                "select workspace_id from chat_threads where thread_id = ?1",
                params![thread_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| "default".to_string()))
    }

    fn insert_message(&self, thread_id: &str, message: &ChatMessage) -> rusqlite::Result<()> {
        // Tree linkage: a new message extends the thread's currently-active path,
        // hanging off its `active_leaf_id` (the message shown as last). For a linear
        // thread this is simply "the previous message". Branching (a future phase)
        // will set `parent_id` to a non-leaf node explicitly; here we always follow
        // the active leaf, so today's behavior is unchanged.
        let parent_id: Option<String> = self
            .conn
            .query_row(
                "select active_leaf_id from chat_threads where thread_id = ?1",
                params![thread_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let inserted = self.conn.execute(
            "insert or ignore into chat_messages (
                id, thread_id, role, text, timestamp, metadata, metrics_json, feedback,
                saved_memory_ref, linked_task_id, linked_automation_ref, attachments_json,
                parent_id, event_parts_json
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                message.id,
                thread_id,
                message.role,
                message.text,
                message.timestamp,
                message.metadata,
                metrics_to_json(message)?,
                message.feedback,
                message.saved_memory_ref,
                message.linked_task_id,
                message.linked_automation_ref,
                attachments_to_json(message)?,
                parent_id,
                event_parts_to_json(message)?,
            ],
        )?;
        // Advance the active leaf only when a row was actually inserted —
        // `insert or ignore` is a no-op on a duplicate id and must not move the
        // pointer (which would corrupt the displayed path).
        if inserted == 1 {
            self.conn.execute(
                "update chat_threads set active_leaf_id = ?1 where thread_id = ?2",
                params![message.id, thread_id],
            )?;
        }
        Ok(())
    }

    fn upsert_message(
        &self,
        thread_id: &str,
        message_id: &str,
        message: &ChatMessage,
    ) -> rusqlite::Result<()> {
        let changed = self.conn.execute(
            "update chat_messages
                set role = ?1, text = ?2, timestamp = ?3, metadata = ?4, metrics_json = ?5,
                    feedback = ?6, saved_memory_ref = ?7, linked_task_id = ?8,
                    linked_automation_ref = ?9, attachments_json = ?10, event_parts_json = ?11
              where id = ?12 and thread_id = ?13",
            params![
                message.role,
                message.text,
                message.timestamp,
                message.metadata,
                metrics_to_json(message)?,
                message.feedback,
                message.saved_memory_ref,
                message.linked_task_id,
                message.linked_automation_ref,
                attachments_to_json(message)?,
                event_parts_to_json(message)?,
                message_id,
                thread_id,
            ],
        )?;
        if changed == 0 {
            self.insert_message(thread_id, message)?;
        }
        Ok(())
    }

    fn update_thread_after_messages(
        &self,
        thread_id: &str,
        user_prompt: Option<&str>,
    ) -> rusqlite::Result<()> {
        let message_count: i64 = self.conn.query_row(
            "select count(*) from chat_messages where thread_id = ?1",
            params![thread_id],
            |row| row.get(0),
        )?;
        let current_title: Option<String> = self
            .conn
            .query_row(
                "select title from chat_threads where thread_id = ?1",
                params![thread_id],
                |row| row.get(0),
            )
            .optional()?;
        let title = match (current_title.as_deref(), user_prompt) {
            (Some("New task" | "Nuovo compito"), Some(prompt)) if !prompt.trim().is_empty() => {
                compact_thread_title(prompt)
            }
            (Some(title), _) => title.to_string(),
            _ => "New task".to_string(),
        };
        let last_activity = self
            .latest_message_timestamp(thread_id)?
            .map(|ts| ts.to_string())
            .unwrap_or_else(current_timestamp_seconds);
        self.conn.execute(
            "update chat_threads
                set title = ?1, subtitle = ?2, updated_at = ?3, message_count = ?4
              where thread_id = ?5",
            params![
                title,
                "Local model",
                last_activity,
                message_count,
                thread_id
            ],
        )?;
        Ok(())
    }

    fn setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "select value from settings where key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
    }

    fn set_active_thread(&self, workspace_id: &str, thread_id: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "insert into settings(key, value) values(?1, ?2)
             on conflict(key) do update set value = excluded.value",
            params![active_thread_setting_key(workspace_id), thread_id],
        )?;
        Ok(())
    }

    fn first_thread_id(&self, workspace_id: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                // The retired "homun" thread is inert data, never a landing thread.
                "select thread_id from chat_threads
                  where workspace_id = ?1 and thread_id <> 'homun'
                 order by pinned desc, cast(updated_at as integer) desc, rowid desc
                 limit 1",
                params![workspace_id],
                |row| row.get(0),
            )
            .optional()
    }
}

/// Per-project settings key for the active thread pointer. Keeping it
/// workspace-scoped means switching projects never points chat at a thread that
/// lives in a different project.
fn active_thread_setting_key(workspace_id: &str) -> String {
    format!("active_thread_id::{workspace_id}")
}

fn thread_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatThread> {
    let workspace_id = if row.as_ref().column_count() > 11 {
        row.get::<_, Option<String>>(11)?
    } else {
        None
    };
    Ok(ChatThread {
        thread_id: row.get(0)?,
        workspace_id,
        title: row.get(1)?,
        subtitle: row.get(2)?,
        status: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        computer_session_id: row.get(5)?,
        task_id: row.get(6)?,
        updated_at: row.get(7)?,
        message_count: row.get::<_, i64>(8)? as u32,
        source: row.get::<_, Option<String>>(9)?,
        channel_recipient: row.get::<_, Option<String>>(10)?,
    })
}

fn should_replace_channel_recipient(current: Option<&str>, next: &str) -> bool {
    let next = next.trim();
    if next.is_empty() {
        return false;
    }
    let Some(current) = current.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };
    let current_is_whatsapp_pn = current.ends_with("@s.whatsapp.net");
    let next_is_whatsapp_pn = next.ends_with("@s.whatsapp.net");
    if current_is_whatsapp_pn && !next_is_whatsapp_pn {
        return false;
    }
    true
}

fn message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatMessage> {
    let metrics_json: Option<String> = row.get(5)?;
    Ok(ChatMessage {
        id: row.get(0)?,
        role: row.get(1)?,
        text: row.get(2)?,
        timestamp: row.get(3)?,
        metadata: row.get(4)?,
        metrics: metrics_json
            .map(|json| serde_json::from_str(&json).map_err(json_error))
            .transpose()?,
        feedback: row.get(6)?,
        saved_memory_ref: row.get(7)?,
        linked_task_id: row.get(8)?,
        linked_automation_ref: row.get(9)?,
        attachments: attachments_from_row(row, 10)?,
        event_parts: event_parts_from_row(row, 11)?,
    })
}

fn remote_approval_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RemoteApprovalRow> {
    let arguments_json: String = row.get(3)?;
    Ok(RemoteApprovalRow {
        approval_id: row.get(0)?,
        code: row.get(1)?,
        tool: row.get(2)?,
        arguments: serde_json::from_str(&arguments_json).unwrap_or(serde_json::Value::Null),
        label: row.get(4)?,
        thread_id: row.get(5)?,
        source_message_id: row.get(6)?,
        requires_source: row.get::<_, i64>(7)? != 0,
        status: row.get(8)?,
        expires_at: row.get(9)?,
        dispatched_at: row.get(10)?,
    })
}

fn metrics_to_json(message: &ChatMessage) -> rusqlite::Result<Option<String>> {
    message
        .metrics
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(json_error)
}

fn attachments_to_json(message: &ChatMessage) -> rusqlite::Result<Option<String>> {
    if message.attachments.is_empty() {
        Ok(None)
    } else {
        serde_json::to_string(&message.attachments)
            .map(Some)
            .map_err(json_error)
    }
}

fn event_parts_to_json(message: &ChatMessage) -> rusqlite::Result<Option<String>> {
    if !message.event_parts.is_empty() {
        return serde_json::to_string(&message.event_parts)
            .map(Some)
            .map_err(json_error);
    }
    let text = &message.text;
    let text_without_reasoning = strip_marker_blocks(text, "REASONING");
    let mut parts = Vec::new();
    push_text_marker_part(text, &mut parts, "REASONING", "reasoning", "text");
    push_text_marker_part(
        &text_without_reasoning,
        &mut parts,
        "ACT",
        "activity",
        "text",
    );
    push_text_marker_part(
        &text_without_reasoning,
        &mut parts,
        "PLAN",
        "plan_update",
        "markdown",
    );
    push_json_marker_part(
        &text_without_reasoning,
        &mut parts,
        "CHOICES",
        "choice_prompt",
    );
    push_json_marker_part(
        &text_without_reasoning,
        &mut parts,
        "VAULT_PROPOSE",
        "vault_propose",
    );
    push_json_marker_part(
        &text_without_reasoning,
        &mut parts,
        "VAULT_REVEAL",
        "vault_reveal",
    );
    push_json_marker_part(
        &text_without_reasoning,
        &mut parts,
        "PAYMENT_APPROVAL",
        "payment_approval",
    );
    if parts.is_empty() {
        Ok(None)
    } else {
        serde_json::to_string(&parts).map(Some).map_err(json_error)
    }
}

fn push_text_marker_part(
    text: &str,
    parts: &mut Vec<serde_json::Value>,
    marker: &str,
    event_type: &str,
    field: &str,
) {
    for body in marker_bodies(text, marker) {
        parts.push(serde_json::json!({
            "type": event_type,
            field: body,
        }));
    }
}

fn push_json_marker_part(
    text: &str,
    parts: &mut Vec<serde_json::Value>,
    marker: &str,
    event_type: &str,
) {
    for body in marker_bodies(text, marker) {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&body) {
            parts.push(serde_json::json!({
                "type": event_type,
                "payload": payload,
            }));
        }
    }
}

fn attachments_from_row(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Vec<serde_json::Value>> {
    let attachments_json: Option<String> = row.get(index)?;
    attachments_json
        .filter(|json| !json.trim().is_empty())
        .map(|json| serde_json::from_str(&json).map_err(json_error))
        .transpose()
        .map(|attachments| attachments.unwrap_or_default())
}

fn event_parts_from_row(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<Vec<serde_json::Value>> {
    let event_parts_json: Option<String> = row.get(index)?;
    event_parts_json
        .filter(|json| !json.trim().is_empty())
        .map(|json| serde_json::from_str(&json).map_err(json_error))
        .transpose()
        .map(|event_parts| event_parts.unwrap_or_default())
}

fn json_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

fn current_timestamp_seconds() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .to_string()
}

fn monotonic_suffix() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suggestions_dedup_list_and_act() {
        let store = ChatStore::in_memory().unwrap();
        let mk = |scope: &str, key: &str, title: &str| SuggestionInput {
            scope: scope.to_string(),
            kind: "info".to_string(),
            title: title.to_string(),
            dedup_key: key.to_string(),
            ..Default::default()
        };
        // Insert two in a project scope + one personal.
        let id1 = store.insert_suggestion(&mk("proj", "k1", "Primo")).unwrap();
        store
            .insert_suggestion(&mk("proj", "k2", "Secondo"))
            .unwrap();
        store
            .insert_suggestion(&mk("__personal__", "p1", "Personale"))
            .unwrap();

        // Dedup is per (scope, key), any status.
        assert!(store.suggestion_dedup_exists("proj", "k1").unwrap());
        assert!(!store.suggestion_dedup_exists("proj", "kX").unwrap());

        // Pending list scoped + counts.
        assert_eq!(
            store.pending_suggestions(Some("proj"), 50).unwrap().len(),
            2
        );
        assert_eq!(store.pending_suggestions(None, 50).unwrap().len(), 3);
        let counts = store.pending_suggestion_counts().unwrap();
        assert_eq!(
            counts.iter().find(|(s, _)| s == "proj").map(|(_, n)| *n),
            Some(2)
        );

        // Dismiss one → drops out of pending but dedup still blocks it (durable no-repeat).
        store
            .set_suggestion_status(id1, "dismissed", Some("disliked"), None)
            .unwrap();
        assert_eq!(
            store.pending_suggestions(Some("proj"), 50).unwrap().len(),
            1
        );
        assert!(store.suggestion_dedup_exists("proj", "k1").unwrap());
    }

    #[test]
    fn plugin_enabled_defaults_on_and_toggles() {
        let store = ChatStore::in_memory().unwrap();
        // Default-on: a freshly shipped addon works without setup.
        assert!(store.plugin_enabled("proattivita"));
        // Disable persists "0" → off; re-enable → on.
        store.set_plugin_enabled("proattivita", false).unwrap();
        assert!(!store.plugin_enabled("proattivita"));
        store.set_plugin_enabled("proattivita", true).unwrap();
        assert!(store.plugin_enabled("proattivita"));
        // Independent per id.
        assert!(store.plugin_enabled("invoicing"));
    }

    #[test]
    fn local_store_tables_have_explicit_memory_boundary_audit() {
        let store = ChatStore::in_memory().unwrap();
        let mut stmt = store
            .conn
            .prepare(
                "select name from sqlite_master
                 where type = 'table' and name not like 'sqlite_%'
                 order by name",
            )
            .unwrap();
        let actual: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        let audited: Vec<String> = CHAT_STORE_MEMORY_BOUNDARY_AUDIT
            .iter()
            .map(|entry| entry.table.to_string())
            .collect();

        assert_eq!(
            actual, audited,
            "every local ChatStore table must declare whether it is UX/ops only or converges into canonical MemoryFacade"
        );
        assert_eq!(
            CHAT_STORE_MEMORY_BOUNDARY_AUDIT
                .iter()
                .filter(|entry| entry.graph_like)
                .map(|entry| (entry.table, entry.canonical_policy))
                .collect::<Vec<_>>(),
            vec![(
                "contact_relationships",
                "mirrored into canonical MemoryRelation when both contacts have entity_ref; tombstoned on delete"
            )],
            "graph-like read-model tables need explicit canonical memory convergence"
        );
    }

    #[test]
    fn recent_feedback_returns_acted_cards_scoped() {
        let store = ChatStore::in_memory().unwrap();
        let mk = |scope: &str, key: &str, title: &str| SuggestionInput {
            scope: scope.to_string(),
            kind: "follow-up".to_string(),
            title: title.to_string(),
            dedup_key: key.to_string(),
            ..Default::default()
        };
        let liked = store
            .insert_suggestion(&mk("proj", "k1", "Useful"))
            .unwrap();
        let disliked = store.insert_suggestion(&mk("proj", "k2", "Noise")).unwrap();
        store
            .insert_suggestion(&mk("proj", "k3", "Untouched"))
            .unwrap();
        let personal = store
            .insert_suggestion(&mk("__personal__", "p1", "Other scope"))
            .unwrap();
        store
            .set_suggestion_status(liked, "accepted", Some("liked"), None)
            .unwrap();
        store
            .set_suggestion_status(disliked, "dismissed", Some("disliked"), None)
            .unwrap();
        store
            .set_suggestion_status(personal, "dismissed", Some("disliked"), None)
            .unwrap();

        // Only acted cards of the scope, newest first; the untouched one is excluded.
        let fb = store.recent_feedback("proj", 10).unwrap();
        assert_eq!(fb.len(), 2);
        assert!(fb.iter().any(|(f, _, t)| f == "liked" && t == "Useful"));
        assert!(fb.iter().any(|(f, _, t)| f == "disliked" && t == "Noise"));
        // Scope isolation: the personal feedback doesn't leak into proj.
        assert_eq!(store.recent_feedback("__personal__", 10).unwrap().len(), 1);
    }

    #[test]
    fn store_seeds_and_commits_chat_messages() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let timestamp = current_timestamp_seconds();
        let user = ChatMessage {
            id: "user_1".to_string(),
            role: "user".to_string(),
            text: "tell me a joke".to_string(),
            timestamp: timestamp.clone(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
        };
        let assistant = ChatMessage {
            id: "assistant_1".to_string(),
            role: "assistant".to_string(),
            text: "Sure.".to_string(),
            timestamp,
            metadata: Some("Local model".to_string()),
            metrics: Some(serde_json::json!({"generation_tokens": 2})),
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
        };

        let messages = store
            .commit_prompt_result(&thread.thread_id, &user, &assistant, None)
            .unwrap();
        assert_eq!(messages.messages.len(), 3);
        assert_eq!(
            store.threads("default").unwrap().active_thread_id,
            thread.thread_id
        );
        assert!(
            store
                .threads("default")
                .unwrap()
                .threads
                .iter()
                .any(|item| item.title == "joke")
        );
    }

    #[test]
    fn committed_chat_message_derives_event_parts_for_legacy_markers() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let assistant = ChatMessage {
            id: "assistant_with_plan".to_string(),
            role: "assistant".to_string(),
            text: "‹‹PLAN››- [x] Done‹‹/PLAN››".to_string(),
            timestamp: current_timestamp_seconds(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
        };

        store.insert_message(&thread.thread_id, &assistant).unwrap();
        let event_parts_json: Option<String> = store
            .conn
            .query_row(
                "select event_parts_json from chat_messages where id = ?1",
                params![assistant.id],
                |row| row.get(0),
            )
            .unwrap();
        let parts: serde_json::Value =
            serde_json::from_str(&event_parts_json.expect("event parts stored")).unwrap();
        assert_eq!(parts[0]["type"], "plan_update");
        assert_eq!(parts[0]["markdown"], "- [x] Done");

        let snapshot = store.messages(&thread.thread_id).unwrap();
        let reloaded = snapshot
            .messages
            .iter()
            .find(|message| message.id == assistant.id)
            .expect("assistant message reloaded");
        let public_json = serde_json::to_value(reloaded).unwrap();
        assert_eq!(public_json["event_parts"][0]["type"], "plan_update");
        assert_eq!(public_json["event_parts"][0]["markdown"], "- [x] Done");
    }

    #[test]
    fn committed_chat_message_ignores_card_markers_inside_reasoning() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let assistant = ChatMessage {
            id: "assistant_reasoning_quotes_choice".to_string(),
            role: "assistant".to_string(),
            text: "‹‹REASONING››I quoted a marker: ```\n‹‹CHOICES››{\"question\":\"Hidden?\",\"options\":[\"Yes\",\"No\"]}‹‹/CHOICES››\n```‹‹/REASONING››\nVisible answer.".to_string(),
            timestamp: current_timestamp_seconds(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
        };

        store.insert_message(&thread.thread_id, &assistant).unwrap();
        let snapshot = store.messages(&thread.thread_id).unwrap();
        let reloaded = snapshot
            .messages
            .iter()
            .find(|message| message.id == assistant.id)
            .expect("assistant message reloaded");
        assert!(
            reloaded
                .event_parts
                .iter()
                .all(|part| part["type"] != "choice_prompt"),
            "quoted CHOICES inside reasoning must not render as a live choice card: {:?}",
            reloaded.event_parts
        );
        assert!(
            reloaded
                .event_parts
                .iter()
                .any(|part| part["type"] == "reasoning")
        );
    }

    #[test]
    fn committed_chat_message_preserves_explicit_event_parts_without_markers() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let assistant = ChatMessage {
            id: "assistant_with_choices".to_string(),
            role: "assistant".to_string(),
            text: "Choose one.".to_string(),
            timestamp: current_timestamp_seconds(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: vec![serde_json::json!({
                "type": "choice_prompt",
                "payload": {
                    "question": "",
                    "multi": false,
                    "options": ["Yes", "No"]
                }
            })],
        };

        store
            .append_assistant_message(&thread.thread_id, &assistant)
            .unwrap();
        let snapshot = store.messages(&thread.thread_id).unwrap();
        let reloaded = snapshot
            .messages
            .iter()
            .find(|message| message.id == assistant.id)
            .expect("assistant message reloaded");
        assert_eq!(reloaded.text, "Choose one.");
        assert_eq!(reloaded.event_parts[0]["type"], "choice_prompt");
        assert_eq!(reloaded.event_parts[0]["payload"]["options"][0], "Yes");
    }

    #[test]
    fn committed_chat_message_attachments_survive_reload() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let attachment = serde_json::json!({
            "artifact_id": "pending_1",
            "title_redacted": "Sales Kickoff Slides.pptx",
            "kind": "file",
            "size_bytes": 27600,
            "preview_available": false,
            "privacy_domain": "local_files"
        });
        let user = ChatMessage {
            id: "user_with_file".to_string(),
            role: "user".to_string(),
            text: "use this template".to_string(),
            timestamp: current_timestamp_seconds(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: vec![attachment.clone()],
            event_parts: Vec::new(),
        };
        let assistant = mk_message("assistant_after_file", "assistant");

        store
            .commit_prompt_result(&thread.thread_id, &user, &assistant, None)
            .unwrap();
        let reloaded = store.messages(&thread.thread_id).unwrap();

        let persisted_user = reloaded
            .messages
            .iter()
            .find(|message| message.id == "user_with_file")
            .unwrap();
        assert_eq!(persisted_user.attachments, vec![attachment]);
    }

    #[test]
    fn chat_thread_title_is_synthesized_from_first_user_prompt() {
        assert_eq!(
            compact_thread_title(
                "Crea una presentazione pitch per Homun usando il template_ref monet/startup"
            ),
            "presentazione pitch Homun template ref"
        );
        assert_eq!(
            compact_thread_title(
                "Dimmi che versione di Homun sto usando e se ci sono aggiornamenti disponibili."
            ),
            "versione Homun aggiornamenti disponibili"
        );
    }

    #[test]
    fn selecting_thread_does_not_change_activity_timestamp() {
        let store = ChatStore::in_memory().unwrap();
        let first = store.create_thread("default").unwrap();
        let _second = store.create_thread("default").unwrap();

        let before = store
            .threads("default")
            .unwrap()
            .threads
            .into_iter()
            .find(|thread| thread.thread_id == first.thread_id)
            .unwrap()
            .updated_at;

        let snap = store.select_thread(&first.thread_id).unwrap();
        let after = snap
            .threads
            .into_iter()
            .find(|thread| thread.thread_id == first.thread_id)
            .unwrap()
            .updated_at;

        assert_eq!(snap.active_thread_id, first.thread_id);
        assert_eq!(after, before);
    }

    #[test]
    fn channel_thread_remembers_reply_recipient_for_app_side_continuity() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store
            .find_or_create_channel_thread("default", "whatsapp", "sender-lid", "WhatsApp · Fabio")
            .unwrap();
        assert_eq!(thread.source.as_deref(), Some("whatsapp"));
        assert_eq!(thread.channel_recipient, None);

        store
            .set_channel_thread_recipient(&thread.thread_id, "393331234567@s.whatsapp.net")
            .unwrap();
        let reloaded = store.thread(&thread.thread_id).unwrap().unwrap();
        assert_eq!(
            reloaded.channel_recipient.as_deref(),
            Some("393331234567@s.whatsapp.net")
        );

        store
            .set_channel_thread_recipient(&thread.thread_id, "393331234567@lid")
            .unwrap();
        let updated = store.thread(&thread.thread_id).unwrap().unwrap();
        assert_eq!(
            updated.channel_recipient.as_deref(),
            Some("393331234567@s.whatsapp.net")
        );

        let scheduled = store
            .find_or_create_channel_thread("default", "scheduled", "task", "Scheduled")
            .unwrap();
        store
            .set_channel_thread_recipient(&scheduled.thread_id, "task")
            .unwrap();
        assert_eq!(
            store
                .thread(&scheduled.thread_id)
                .unwrap()
                .unwrap()
                .channel_recipient
                .as_deref(),
            Some("task")
        );
    }

    #[test]
    fn channel_thread_recipient_does_not_downgrade_whatsapp_pn_to_lid() {
        assert!(super::should_replace_channel_recipient(
            None,
            "393@s.whatsapp.net"
        ));
        assert!(super::should_replace_channel_recipient(
            Some("393@lid"),
            "393@s.whatsapp.net"
        ));
        assert!(!super::should_replace_channel_recipient(
            Some("393@s.whatsapp.net"),
            "393@lid"
        ));
        assert!(super::should_replace_channel_recipient(
            Some("telegram-old"),
            "telegram-new"
        ));
    }

    #[test]
    fn remote_approval_persists_binding_and_claims_once() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let approval_id = "approval-test";
        let args = serde_json::json!({ "path": "/tmp/a", "content": "x" });
        store
            .create_remote_approval(&RemoteApprovalInput {
                approval_id,
                code: "ABC123",
                tool: "mcp__filesystem__create",
                arguments: &args,
                label: "create file",
                thread_id: Some(&thread.thread_id),
                requires_source: true,
                expires_at: ChatStore::now_secs() + 600,
            })
            .unwrap();

        let pending = store.pending_remote_approval("ABC123").unwrap().unwrap();
        assert!(pending.requires_source);
        assert_eq!(pending.source_message_id, None);

        let assistant = ChatMessage {
            id: "assistant_confirm".to_string(),
            role: "assistant".to_string(),
            text: format!(
                "I need your confirmation\n‹‹MCP_CONFIRM››{}‹‹/MCP_CONFIRM››",
                serde_json::json!({
                    "approval_id": approval_id,
                    "tool": "mcp__filesystem__create",
                    "arguments": args,
                })
            ),
            timestamp: current_timestamp_seconds(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
        };
        store
            .append_assistant_message(&thread.thread_id, &assistant)
            .unwrap();
        let bound = store
            .bind_remote_approval_source(approval_id, &thread.thread_id, &assistant.id)
            .unwrap()
            .unwrap();
        assert_eq!(
            bound.source_message_id.as_deref(),
            Some("assistant_confirm")
        );

        assert!(store.claim_remote_approval(approval_id).unwrap().is_some());
        assert!(store.claim_remote_approval(approval_id).unwrap().is_none());
    }

    fn mk_message(id: &str, role: &str) -> ChatMessage {
        ChatMessage {
            id: id.to_string(),
            role: role.to_string(),
            text: format!("{id} text"),
            timestamp: current_timestamp_seconds(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
            event_parts: Vec::new(),
        }
    }

    #[test]
    fn message_lookup_reads_attachment_column() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let message = mk_message("assistant_lookup", "assistant");
        store
            .append_assistant_message(&thread.thread_id, &message)
            .unwrap();

        let loaded = store
            .message(&thread.thread_id, "assistant_lookup")
            .unwrap()
            .expect("message");

        assert_eq!(loaded.id, "assistant_lookup");
        assert!(loaded.attachments.is_empty());
    }

    #[test]
    fn chat_tree_links_parents_and_active_leaf() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let tid = thread.thread_id.clone();
        // The seed "ready" message is the root of the thread.
        let seed_id = store.messages(&tid).unwrap().messages[0].id.clone();

        store
            .commit_prompt_result(
                &tid,
                &mk_message("user_1", "user"),
                &mk_message("assistant_1", "assistant"),
                None,
            )
            .unwrap();
        store
            .append_assistant_message(&tid, &mk_message("assistant_2", "assistant"))
            .unwrap();

        // Displayed order == the root→leaf path == insertion order (still linear).
        let ids: Vec<String> = store
            .messages(&tid)
            .unwrap()
            .messages
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(
            ids,
            vec![
                seed_id.clone(),
                "user_1".to_string(),
                "assistant_1".to_string(),
                "assistant_2".to_string(),
            ]
        );

        // active_leaf tracks the last inserted message.
        let leaf: Option<String> = store
            .conn
            .query_row(
                "select active_leaf_id from chat_threads where thread_id = ?1",
                params![tid],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaf.as_deref(), Some("assistant_2"));

        // parent chain is linear: a2→a1→u1→seed→NULL.
        let parent = |id: &str| -> Option<String> {
            store
                .conn
                .query_row(
                    "select parent_id from chat_messages where id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(parent("assistant_2").as_deref(), Some("assistant_1"));
        assert_eq!(parent("assistant_1").as_deref(), Some("user_1"));
        assert_eq!(parent("user_1").as_deref(), Some(seed_id.as_str()));
        assert_eq!(parent(&seed_id), None);

        // A duplicate id (insert-or-ignore no-op) must NOT move the active leaf.
        store
            .append_assistant_message(&tid, &mk_message("assistant_2", "assistant"))
            .unwrap();
        let leaf_after: Option<String> = store
            .conn
            .query_row(
                "select active_leaf_id from chat_threads where thread_id = ?1",
                params![tid],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaf_after.as_deref(), Some("assistant_2"));
    }

    #[test]
    fn chat_tree_backfill_linearizes_legacy_rows() {
        let store = ChatStore::in_memory().unwrap();
        // Simulate a pre-branching DB: a bare thread + rows with no parent/leaf.
        store
            .conn
            .execute(
                "insert into chat_threads
                    (thread_id, title, subtitle, status, computer_session_id, task_id, updated_at)
                 values ('legacy', 'T', 'S', 'active', 'c', 't', '0')",
                [],
            )
            .unwrap();
        for id in ["m1", "m2", "m3"] {
            store
                .conn
                .execute(
                    "insert into chat_messages (id, thread_id, role, text, timestamp)
                     values (?1, 'legacy', 'user', 'x', '0')",
                    params![id],
                )
                .unwrap();
        }
        // Re-arm the one-shot guard and run the backfill.
        store.set_flag("chat_tree_backfilled", "0").unwrap();
        store.backfill_chat_tree().unwrap();

        let parent = |id: &str| -> Option<String> {
            store
                .conn
                .query_row(
                    "select parent_id from chat_messages where id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(parent("m1"), None, "first message is the root");
        assert_eq!(parent("m2").as_deref(), Some("m1"));
        assert_eq!(parent("m3").as_deref(), Some("m2"));

        let leaf: Option<String> = store
            .conn
            .query_row(
                "select active_leaf_id from chat_threads where thread_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leaf.as_deref(), Some("m3"));

        // And the rebuilt path renders in linear order.
        let ids: Vec<String> = store
            .messages("legacy")
            .unwrap()
            .messages
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(
            ids,
            vec!["m1".to_string(), "m2".to_string(), "m3".to_string()]
        );
    }

    #[test]
    fn chat_tree_edit_and_regenerate_create_sibling_branches() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let tid = thread.thread_id.clone();
        let seed_id = store.messages(&tid).unwrap().messages[0].id.clone();
        let path = |s: &ChatStore| -> Vec<String> {
            s.messages(&tid)
                .unwrap()
                .messages
                .into_iter()
                .map(|m| m.id)
                .collect()
        };

        // Original turn.
        store
            .commit_prompt_result(
                &tid,
                &mk_message("u1", "user"),
                &mk_message("a1", "assistant"),
                None,
            )
            .unwrap();
        assert_eq!(
            path(&store),
            vec![seed_id.clone(), "u1".into(), "a1".into()]
        );

        // Edit the user message → a SIBLING turn; the old branch is preserved.
        store
            .commit_prompt_result(
                &tid,
                &mk_message("u1b", "user"),
                &mk_message("a1b", "assistant"),
                Some("u1"),
            )
            .unwrap();
        assert_eq!(
            path(&store),
            vec![seed_id.clone(), "u1b".into(), "a1b".into()]
        );

        // The switcher sees two alternatives at the user node.
        let points = store.branch_options(&tid).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].node_id, "u1b");
        assert_eq!(points[0].active_index, 1);
        let children: Vec<&str> = points[0]
            .options
            .iter()
            .map(|o| o.child_id.as_str())
            .collect();
        assert_eq!(children, vec!["u1", "u1b"]);
        // Selecting the first option activates the ORIGINAL branch's leaf.
        assert_eq!(points[0].options[0].leaf_id, "a1");

        // Switch back to the original branch (non-destructive: edit branch still there).
        store
            .set_active_leaf(&tid, Some(&points[0].options[0].leaf_id))
            .unwrap();
        assert_eq!(
            path(&store),
            vec![seed_id.clone(), "u1".into(), "a1".into()]
        );

        // Regenerate the answer under u1 → a sibling answer.
        store
            .commit_regenerated_answer(&tid, "u1", &mk_message("a1r", "assistant"))
            .unwrap();
        assert_eq!(
            path(&store),
            vec![seed_id.clone(), "u1".into(), "a1r".into()]
        );
        let points = store.branch_options(&tid).unwrap();
        // Two branch points now: the user node and the answer node.
        assert_eq!(points.len(), 2);
        let answer = points.iter().find(|p| p.node_id == "a1r").unwrap();
        assert_eq!(answer.active_index, 1);
        let answer_children: Vec<&str> =
            answer.options.iter().map(|o| o.child_id.as_str()).collect();
        assert_eq!(answer_children, vec!["a1", "a1r"]);

        // Phase 4: a named branch surfaces its label in the switcher.
        store
            .set_branch_label(&tid, "a1r", Some("variante B"))
            .unwrap();
        let points = store.branch_options(&tid).unwrap();
        let answer = points.iter().find(|p| p.node_id == "a1r").unwrap();
        let labelled = answer.options.iter().find(|o| o.child_id == "a1r").unwrap();
        assert_eq!(labelled.label.as_deref(), Some("variante B"));
    }

    #[test]
    fn thread_attachments_persist_and_replace_by_name() {
        let store = ChatStore::in_memory().unwrap();
        let tid = "thread_x";
        store
            .upsert_thread_attachment(
                tid,
                "patente.pdf",
                "application/pdf",
                Some("(scan)"),
                &["data:image/jpeg;base64,AAA".to_string()],
            )
            .unwrap();
        store
            .upsert_thread_attachment(tid, "note.txt", "text/plain", Some("ciao"), &[])
            .unwrap();
        let all = store.thread_attachments(tid).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].display_name, "patente.pdf");
        assert_eq!(all[0].images.len(), 1);
        assert_eq!(all[1].text.as_deref(), Some("ciao"));
        // Re-attaching the same filename REPLACES (one row per name).
        store
            .upsert_thread_attachment(
                tid,
                "patente.pdf",
                "application/pdf",
                Some("(updated)"),
                &[],
            )
            .unwrap();
        let all = store.thread_attachments(tid).unwrap();
        assert_eq!(
            all.len(),
            2,
            "still 2 files, patente.pdf replaced not duplicated"
        );
        let patente = all
            .iter()
            .find(|a| a.display_name == "patente.pdf")
            .unwrap();
        assert_eq!(patente.text.as_deref(), Some("(updated)"));
        assert!(patente.images.is_empty());
        // Empty thread_id is a no-op (no global bucket).
        store
            .upsert_thread_attachment("", "x", "y", None, &[])
            .unwrap();
        assert!(store.thread_attachments("").unwrap().is_empty());
    }

    #[test]
    fn threads_are_scoped_per_project_with_independent_active_pointer() {
        let store = ChatStore::in_memory().unwrap();
        // The in-memory store seeds one thread into 'default'.
        let alpha = store.create_thread("project_alpha").unwrap();
        let beta = store.create_thread("project_beta").unwrap();

        let alpha_view = store.threads("project_alpha").unwrap();
        let beta_view = store.threads("project_beta").unwrap();

        // Each project sees only its own thread — no cross-project leakage.
        assert!(
            alpha_view
                .threads
                .iter()
                .all(|t| t.thread_id == alpha.thread_id)
        );
        assert!(
            beta_view
                .threads
                .iter()
                .all(|t| t.thread_id == beta.thread_id)
        );
        assert!(
            !alpha_view
                .threads
                .iter()
                .any(|t| t.thread_id == beta.thread_id)
        );

        // Active pointer is independent per project.
        assert_eq!(alpha_view.active_thread_id, alpha.thread_id);
        assert_eq!(beta_view.active_thread_id, beta.thread_id);

        // The seeded 'default' project is isolated from both.
        let default_view = store.threads("default").unwrap();
        assert!(
            !default_view
                .threads
                .iter()
                .any(|t| t.thread_id == alpha.thread_id || t.thread_id == beta.thread_id)
        );

        // Deleting alpha's only thread reseeds alpha (never empty) without
        // touching beta.
        let after_delete = store.delete_thread(&alpha.thread_id).unwrap();
        assert_eq!(after_delete.threads.len(), 1);
        assert_ne!(after_delete.threads[0].thread_id, alpha.thread_id);
        assert_eq!(store.threads("project_beta").unwrap().threads.len(), 1);
    }

    #[test]
    fn member_tasks_resolve_to_owning_thread_without_shadowing_primary() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();

        // Brain materializes N member tasks for the same prompt/thread.
        store
            .link_task_to_thread("orchestrator_req_s1", &thread.thread_id)
            .unwrap();
        store
            .link_task_to_thread("orchestrator_req_s2", &thread.thread_id)
            .unwrap();

        // Every member task resolves back to the one owning thread.
        for member in ["orchestrator_req_s1", "orchestrator_req_s2"] {
            let resolved = store.thread_by_task_id(member).unwrap();
            assert_eq!(
                resolved.map(|t| t.thread_id),
                Some(thread.thread_id.clone()),
                "member task {member} should resolve to its thread",
            );
        }

        // The legacy primary task_id still resolves directly (link table is a
        // fallback, it must not shadow the primary match).
        let primary = store.thread_by_task_id(&thread.task_id).unwrap();
        assert_eq!(primary.map(|t| t.thread_id), Some(thread.thread_id.clone()));

        // Unknown ids stay unresolved.
        assert!(store.thread_by_task_id("nope").unwrap().is_none());

        // Deleting the thread also clears its task links.
        store.delete_thread(&thread.thread_id).unwrap();
        assert!(
            store
                .thread_by_task_id("orchestrator_req_s1")
                .unwrap()
                .is_none()
        );
    }
}

#[cfg(test)]
mod wal_tests {
    use super::*;

    #[test]
    fn open_sets_wal_mode() {
        let tmp = std::env::temp_dir().join(format!(
            "homun-chat-wal-test-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = ChatStore::open(&tmp).unwrap();
        let mode: String = store
            .conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let timeout: i64 = store
            .conn
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 5000);
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-shm"));
    }
}
