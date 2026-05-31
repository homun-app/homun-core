use local_first_desktop_gateway::{
    ChatMessage, ChatMessagesSnapshot, ChatThread, ChatThreadSnapshot, compact_thread_title,
    seeded_ready_message,
};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct ChatStore {
    conn: Connection,
}

impl ChatStore {
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        let store = Self { conn };
        store.migrate()?;
        store.seed_if_empty()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
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
            Some(thread_id) => thread_id,
            None => self.first_thread_id(workspace_id)?.unwrap_or_default(),
        };
        let mut stmt = self.conn.prepare(
            "select thread_id, title, subtitle, status, pinned, computer_session_id, task_id,
                    updated_at, message_count
               from chat_threads
              where workspace_id = ?1
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
            title: "Nuovo compito".to_string(),
            subtitle: "Chat locale".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp.clone(),
            message_count: 1,
        };
        self.insert_thread(&thread, workspace_id)?;
        self.insert_message(
            &thread.thread_id,
            &seeded_ready_message(&thread.thread_id, timestamp),
        )?;
        self.set_active_thread(workspace_id, &thread.thread_id)?;
        Ok(thread)
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

    pub fn messages(&self, thread_id: &str) -> rusqlite::Result<ChatMessagesSnapshot> {
        let mut stmt = self.conn.prepare(
            "select id, role, text, timestamp, metadata, metrics_json, feedback,
                    saved_memory_ref, linked_task_id, linked_automation_ref
               from chat_messages
              where thread_id = ?1
              order by rowid asc",
        )?;
        let messages = stmt
            .query_map(params![thread_id], message_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ChatMessagesSnapshot {
            thread_id: thread_id.to_string(),
            messages,
        })
    }

    pub fn thread(&self, thread_id: &str) -> rusqlite::Result<Option<ChatThread>> {
        self.conn
            .query_row(
                "select thread_id, title, subtitle, status, pinned, computer_session_id, task_id,
                        updated_at, message_count
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
                        updated_at, message_count
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
                        saved_memory_ref, linked_task_id, linked_automation_ref
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
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        self.insert_message(thread_id, user_message)?;
        self.insert_message(thread_id, assistant_message)?;
        self.update_thread_after_messages(thread_id, Some(&user_message.text))?;
        self.messages(thread_id)
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

    pub fn append_assistant_message(
        &self,
        thread_id: &str,
        message: &ChatMessage,
    ) -> rusqlite::Result<ChatMessagesSnapshot> {
        self.insert_message(thread_id, message)?;
        self.update_thread_after_messages(thread_id, None)?;
        self.messages(thread_id)
    }

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
                foreign key(thread_id) references chat_threads(thread_id) on delete cascade
            );

            create index if not exists idx_chat_messages_thread
                on chat_messages(thread_id);

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
        Ok(())
    }

    fn column_exists(&self, table: &str, column: &str) -> rusqlite::Result<bool> {
        let mut stmt = self
            .conn
            .prepare(&format!("pragma table_info({table})"))?;
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
            title: "Nuovo compito".to_string(),
            subtitle: "Chat locale".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: "computer_active_prompt".to_string(),
            task_id: "task_prompt_session".to_string(),
            updated_at: timestamp.clone(),
            message_count: 1,
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
            title: "Nuovo compito".to_string(),
            subtitle: "Chat locale".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp.clone(),
            message_count: 1,
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
                updated_at, message_count, workspace_id
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
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
            ],
        )?;
        Ok(())
    }

    /// Resolves the project a thread belongs to, defaulting to 'default' for
    /// threads that predate workspace scoping or are unknown.
    fn workspace_for_thread(&self, thread_id: &str) -> rusqlite::Result<String> {
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
        self.conn.execute(
            "insert or ignore into chat_messages (
                id, thread_id, role, text, timestamp, metadata, metrics_json, feedback,
                saved_memory_ref, linked_task_id, linked_automation_ref
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
            ],
        )?;
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
                    linked_automation_ref = ?9
              where id = ?10 and thread_id = ?11",
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
            (Some("Nuovo compito"), Some(prompt)) if !prompt.trim().is_empty() => {
                compact_thread_title(prompt)
            }
            (Some(title), _) => title.to_string(),
            _ => "Nuovo compito".to_string(),
        };
        self.conn.execute(
            "update chat_threads
                set title = ?1, subtitle = ?2, updated_at = ?3, message_count = ?4
              where thread_id = ?5",
            params![
                title,
                "Modello locale",
                current_timestamp_seconds(),
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
                "select thread_id from chat_threads
                  where workspace_id = ?1
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
    Ok(ChatThread {
        thread_id: row.get(0)?,
        title: row.get(1)?,
        subtitle: row.get(2)?,
        status: row.get(3)?,
        pinned: row.get::<_, i64>(4)? != 0,
        computer_session_id: row.get(5)?,
        task_id: row.get(6)?,
        updated_at: row.get(7)?,
        message_count: row.get::<_, i64>(8)? as u32,
    })
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
        attachments: Vec::new(),
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
    fn store_seeds_and_commits_chat_messages() {
        let store = ChatStore::in_memory().unwrap();
        let thread = store.create_thread("default").unwrap();
        let timestamp = current_timestamp_seconds();
        let user = ChatMessage {
            id: "user_1".to_string(),
            role: "user".to_string(),
            text: "dimmi una barzelletta".to_string(),
            timestamp: timestamp.clone(),
            metadata: None,
            metrics: None,
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
        };
        let assistant = ChatMessage {
            id: "assistant_1".to_string(),
            role: "assistant".to_string(),
            text: "Certo.".to_string(),
            timestamp,
            metadata: Some("Modello locale".to_string()),
            metrics: Some(serde_json::json!({"generation_tokens": 2})),
            feedback: None,
            saved_memory_ref: None,
            linked_task_id: None,
            linked_automation_ref: None,
            attachments: Vec::new(),
        };

        let messages = store
            .commit_prompt_result(&thread.thread_id, &user, &assistant)
            .unwrap();
        assert_eq!(messages.messages.len(), 3);
        assert_eq!(store.threads("default").unwrap().active_thread_id, thread.thread_id);
        assert!(
            store
                .threads("default")
                .unwrap()
                .threads
                .iter()
                .any(|item| item.title == "dimmi una barzelletta")
        );
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
        assert!(alpha_view.threads.iter().all(|t| t.thread_id == alpha.thread_id));
        assert!(beta_view.threads.iter().all(|t| t.thread_id == beta.thread_id));
        assert!(!alpha_view.threads.iter().any(|t| t.thread_id == beta.thread_id));

        // Active pointer is independent per project.
        assert_eq!(alpha_view.active_thread_id, alpha.thread_id);
        assert_eq!(beta_view.active_thread_id, beta.thread_id);

        // The seeded 'default' project is isolated from both.
        let default_view = store.threads("default").unwrap();
        assert!(!default_view.threads.iter().any(|t| t.thread_id == alpha.thread_id
            || t.thread_id == beta.thread_id));

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
