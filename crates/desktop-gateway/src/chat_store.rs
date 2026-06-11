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

/// An ingested attachment persisted on a thread (text and/or page images).
#[derive(Debug, Clone)]
pub struct StoredAttachment {
    pub display_name: String,
    pub mime_type: String,
    pub text: Option<String>,
    pub images: Vec<String>,
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
                    updated_at, message_count, source
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
            source: None,
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
            title: title.to_string(),
            subtitle: format!("Canale {source}"),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp,
            message_count: 0,
            source: Some(source.to_string()),
        };
        self.insert_thread(&thread, workspace_id)?;
        Ok(thread)
    }

    /// The dedicated proactive "Homun" thread — the assistant's home (personal scope).
    /// Fixed id so the persona injection can detect it; pinned to stay at the top.
    pub fn find_or_create_homun_thread(&self, workspace_id: &str) -> rusqlite::Result<ChatThread> {
        let thread_id = "homun".to_string();
        if let Some(thread) = self.thread(&thread_id)? {
            // Ensure Homun lives in the requested (personal/base) workspace — migrate it
            // if it was created elsewhere (e.g. under a project), otherwise it won't show
            // in the personal thread list and navigation falls back to another thread.
            self.conn.execute(
                "update chat_threads set workspace_id = ?1 \
                 where thread_id = 'homun' and workspace_id <> ?1",
                params![workspace_id],
            )?;
            return Ok(thread);
        }
        let timestamp = current_timestamp_seconds();
        let thread = ChatThread {
            thread_id: thread_id.clone(),
            title: "Homun".to_string(),
            subtitle: "Il tuo assistente".to_string(),
            status: "active".to_string(),
            pinned: true,
            computer_session_id: format!("computer_{thread_id}"),
            task_id: format!("task_{thread_id}"),
            updated_at: timestamp,
            message_count: 0,
            source: Some("homun".to_string()),
        };
        self.insert_thread(&thread, workspace_id)?;
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
                        updated_at, message_count, source
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
                        updated_at, message_count, source
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
    ) -> rusqlite::Result<i64> {
        if let Some(id) = self.contact_id_by_identity(channel, identifier)? {
            return Ok(id);
        }
        let name = if display.trim().is_empty() { identifier } else { display.trim() };
        let id = self.create_contact(name, "unknown", false, "", None)?;
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
        let mut stmt = self.conn.prepare("select id from contacts order by lower(name)")?;
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
            self.conn
                .execute("update contacts set name = ?1, updated_at = ?2 where id = ?3", params![v, now, id])?;
        }
        if let Some(v) = nickname {
            self.conn.execute(
                "update contacts set nickname = ?1, updated_at = ?2 where id = ?3",
                params![v, now, id],
            )?;
        }
        if let Some(v) = notes {
            self.conn
                .execute("update contacts set notes = ?1, updated_at = ?2 where id = ?3", params![v, now, id])?;
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
        let mut stmt = self
            .conn
            .prepare("select channel, identifier, label from contact_identities where contact_id = ?1")?;
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
        self.conn
            .execute("delete from contact_identities where contact_id = ?1", params![id])?;
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
        let to_json = |list: &Vec<String>| serde_json::to_string(list).unwrap_or_else(|_| "[]".into());
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
            self.conn
                .execute("update profiles set name = ?1, updated_at = ?2 where id = ?3", params![v, now, id])?;
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
        self.conn.execute("delete from profiles where id = ?1", params![id])?;
        Ok(())
    }

    pub fn set_contact_profile(&self, contact_id: i64, profile_id: Option<i64>) -> rusqlite::Result<()> {
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

    pub fn channel_profile_overrides(&self, contact_id: i64) -> rusqlite::Result<Vec<(String, i64)>> {
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
        self.conn
            .execute("delete from contact_relationships where id = ?1", params![id])?;
        Ok(())
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

    pub fn set_contact_birthday(&self, contact_id: i64, birthday: Option<&str>) -> rusqlite::Result<()> {
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

    // ------------------------------------------------------ curiosity backlog

    /// Queue a mined curiosity (status 'pending').
    pub fn insert_curiosity(
        &self,
        text: &str,
        topic: &str,
        rationale: &str,
        source_refs_json: &str,
    ) -> rusqlite::Result<i64> {
        self.conn.execute(
            "insert into curiosities(status, text, topic, rationale, source_refs, created_at)
             values('pending', ?1, ?2, ?3, ?4, ?5)",
            params![text, topic, rationale, source_refs_json, Self::now_secs()],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Oldest pending curiosity (FIFO: earliest mined is asked first).
    pub fn next_pending_curiosity(&self) -> rusqlite::Result<Option<(i64, String)>> {
        self.conn
            .query_row(
                "select id, text from curiosities where status = 'pending'
                 order by id asc limit 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
    }

    pub fn pending_curiosities(&self) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
        let mut stmt = self.conn.prepare(
            "select id, text, topic, rationale from curiosities
             where status = 'pending' order by id asc",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect()
    }

    pub fn pending_curiosity_count(&self) -> rusqlite::Result<i64> {
        self.conn.query_row(
            "select count(*) from curiosities where status = 'pending'",
            [],
            |row| row.get(0),
        )
    }

    /// All texts ever queued (any status) — the durable dedup horizon for mining:
    /// delivered AND dismissed must never be re-mined.
    pub fn all_curiosity_texts(&self) -> rusqlite::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("select text from curiosities")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    pub fn mark_curiosity(&self, id: i64, status: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "update curiosities set status = ?1,
                    delivered_at = case when ?1 = 'delivered' then ?2 else delivered_at end
             where id = ?3",
            params![status, Self::now_secs(), id],
        )?;
        Ok(())
    }

    /// One-shot bootstrap flag helper reuse: see `flag`/`set_flag`.

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

            -- 'Marco su Telegram aziendale → profilo Lavoro': per-channel override.
            create table if not exists contact_channel_profiles (
                contact_id integer not null references contacts(id) on delete cascade,
                channel text not null,
                profile_id integer not null,
                primary key(contact_id, channel)
            );

            -- Social graph between curated contacts ('Laura è la moglie di Marco').
            create table if not exists contact_relationships (
                id integer primary key autoincrement,
                from_contact_id integer not null references contacts(id) on delete cascade,
                to_contact_id integer not null references contacts(id) on delete cascade,
                relationship_type text not null,
                unique(from_contact_id, to_contact_id, relationship_type)
            );

            -- Homun's persistent curiosity backlog: questions/proposals mined from
            -- memory, doled out ONE per check-in. The queue itself is the durable
            -- no-repeat: delivered/dismissed rows are never re-asked nor re-mined.
            create table if not exists curiosities (
                id integer primary key autoincrement,
                status text not null default 'pending',
                text text not null,
                topic text not null default '',
                rationale text not null default '',
                source_refs text not null default '[]',
                created_at integer not null,
                delivered_at integer
            );
            create index if not exists idx_curiosities_status on curiosities(status);
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
                Ok(StoredAttachment { display_name, mime_type, text, images })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
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
            title: "Nuovo compito".to_string(),
            subtitle: "Chat locale".to_string(),
            status: "active".to_string(),
            pinned: false,
            computer_session_id: "computer_active_prompt".to_string(),
            task_id: "task_prompt_session".to_string(),
            updated_at: timestamp.clone(),
            message_count: 1,
            source: None,
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
            source: None,
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
                updated_at, message_count, workspace_id, source
            ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
        source: row.get::<_, Option<String>>(9)?,
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
    fn thread_attachments_persist_and_replace_by_name() {
        let store = ChatStore::in_memory().unwrap();
        let tid = "thread_x";
        store
            .upsert_thread_attachment(tid, "patente.pdf", "application/pdf", Some("(scan)"), &[
                "data:image/jpeg;base64,AAA".to_string(),
            ])
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
            .upsert_thread_attachment(tid, "patente.pdf", "application/pdf", Some("(updated)"), &[])
            .unwrap();
        let all = store.thread_attachments(tid).unwrap();
        assert_eq!(all.len(), 2, "still 2 files, patente.pdf replaced not duplicated");
        let patente = all.iter().find(|a| a.display_name == "patente.pdf").unwrap();
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
