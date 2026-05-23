use crate::{
    DataSensitivity, EncryptedJson, KeyProvider, MemoryAccessDecision, MemoryAccessRequest,
    MemoryEntity, MemoryEvent, MemoryEvidence, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryRelation, PrivacyDomain, UserId, WikiPage, WorkspaceId, decrypt_json, encrypt_json,
};
use rusqlite::{Connection, Row};
use std::path::Path;
use std::str::FromStr;

pub struct SQLiteMemoryStore {
    conn: Connection,
    key_provider: Option<Box<dyn KeyProvider>>,
}

impl SQLiteMemoryStore {
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
        let store = Self {
            conn,
            key_provider: None,
        };
        store.init()?;
        Ok(store)
    }

    pub fn open_in_memory_with_key_provider(
        key_provider: Box<dyn KeyProvider>,
    ) -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
        let store = Self {
            conn,
            key_provider: Some(key_provider),
        };
        store.init()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        let store = Self {
            conn,
            key_provider: None,
        };
        store.init()?;
        Ok(store)
    }

    pub fn record_event(&self, event: &MemoryEvent) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into memory_events (
                    ref, user_id, workspace_id, timestamp, source, event_type, payload_json,
                    privacy_domain, sensitivity
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                (
                    event.reference.to_string(),
                    event.user_id.as_str(),
                    event.workspace_id.as_str(),
                    &event.timestamp,
                    &event.source,
                    &event.event_type,
                    self.payload_to_storage(
                        &event.user_id,
                        &event.workspace_id,
                        event.sensitivity,
                        &event.payload,
                    )?,
                    event.privacy_domain.as_str(),
                    enum_name(&event.sensitivity)?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_event(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<MemoryEvent>, String> {
        if self.is_tombstoned(reference, user_id, workspace_id)? {
            return Ok(None);
        }
        query_optional(
            &self.conn,
            "select ref, user_id, workspace_id, timestamp, source, event_type, payload_json,
                    privacy_domain, sensitivity
             from memory_events
             where ref = ?1 and user_id = ?2 and workspace_id = ?3",
            (
                reference.to_string(),
                user_id.as_str().to_string(),
                workspace_id.as_str().to_string(),
            ),
            |row| self.event_from_row(row),
        )
    }

    pub fn upsert_memory(&self, memory: &MemoryRecord) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into memories (
                    ref, user_id, workspace_id, memory_type, text, aliases_json,
                    language_hints_json, confidence, status, privacy_domain, sensitivity,
                    metadata_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                (
                    memory.reference.to_string(),
                    memory.user_id.as_str(),
                    memory.workspace_id.as_str(),
                    &memory.memory_type,
                    &memory.text,
                    serde_json::to_string(&memory.aliases).map_err(|error| error.to_string())?,
                    serde_json::to_string(&memory.language_hints)
                        .map_err(|error| error.to_string())?,
                    memory.confidence,
                    enum_name(&memory.status)?,
                    memory.privacy_domain.as_str(),
                    enum_name(&memory.sensitivity)?,
                    serde_json::to_string(&memory.metadata).map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_memory(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<MemoryRecord>, String> {
        if self.is_tombstoned(reference, user_id, workspace_id)? {
            return Ok(None);
        }
        query_optional(
            &self.conn,
            "select ref, user_id, workspace_id, memory_type, text, aliases_json,
                    language_hints_json, confidence, status, privacy_domain, sensitivity,
                    metadata_json
             from memories
             where ref = ?1 and user_id = ?2 and workspace_id = ?3",
            (
                reference.to_string(),
                user_id.as_str().to_string(),
                workspace_id.as_str().to_string(),
            ),
            memory_from_row,
        )
    }

    pub fn list_memories(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, memory_type, text, aliases_json,
                        language_hints_json, confidence, status, privacy_domain, sensitivity,
                        metadata_json
                 from memories
                 where user_id = ?1 and workspace_id = ?2
                 order by ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut memories = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let memory = memory_from_row(row)?;
            if !self.is_tombstoned(&memory.reference, user_id, workspace_id)? {
                memories.push(memory);
            }
        }
        Ok(memories)
    }

    pub fn list_entities(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryEntity>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, entity_type, name, canonical_key,
                        aliases_json, privacy_domain, sensitivity, metadata_json
                 from entities
                 where user_id = ?1 and workspace_id = ?2
                 order by ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut entities = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let entity = entity_from_row(row)?;
            if !self.is_tombstoned(&entity.reference, user_id, workspace_id)? {
                entities.push(entity);
            }
        }
        Ok(entities)
    }

    pub fn upsert_entity(&self, entity: &MemoryEntity) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into entities (
                    ref, user_id, workspace_id, entity_type, name, canonical_key,
                    aliases_json, privacy_domain, sensitivity, metadata_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                (
                    entity.reference.to_string(),
                    entity.user_id.as_str(),
                    entity.workspace_id.as_str(),
                    &entity.entity_type,
                    &entity.name,
                    &entity.canonical_key,
                    serde_json::to_string(&entity.aliases).map_err(|error| error.to_string())?,
                    entity.privacy_domain.as_str(),
                    enum_name(&entity.sensitivity)?,
                    serde_json::to_string(&entity.metadata).map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_entity(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<MemoryEntity>, String> {
        if self.is_tombstoned(reference, user_id, workspace_id)? {
            return Ok(None);
        }
        query_optional(
            &self.conn,
            "select ref, user_id, workspace_id, entity_type, name, canonical_key,
                    aliases_json, privacy_domain, sensitivity, metadata_json
             from entities
             where ref = ?1 and user_id = ?2 and workspace_id = ?3",
            (
                reference.to_string(),
                user_id.as_str().to_string(),
                workspace_id.as_str().to_string(),
            ),
            entity_from_row,
        )
    }

    pub fn upsert_relation(&self, relation: &MemoryRelation) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into relations (
                    ref, user_id, workspace_id, source_ref, relation_type, target_ref,
                    confidence, privacy_domain, sensitivity, evidence_json, metadata_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                (
                    relation.reference.to_string(),
                    relation.user_id.as_str(),
                    relation.workspace_id.as_str(),
                    relation.source_ref.to_string(),
                    &relation.relation_type,
                    relation.target_ref.to_string(),
                    relation.confidence,
                    relation.privacy_domain.as_str(),
                    enum_name(&relation.sensitivity)?,
                    serde_json::to_string(&relation.evidence).map_err(|error| error.to_string())?,
                    serde_json::to_string(&relation.metadata).map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn relations_for(
        &self,
        source_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRelation>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, source_ref, relation_type, target_ref,
                        confidence, privacy_domain, sensitivity, evidence_json, metadata_json
                 from relations
                 where source_ref = ?1 and user_id = ?2 and workspace_id = ?3
                 order by ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((
                source_ref.to_string(),
                user_id.as_str().to_string(),
                workspace_id.as_str().to_string(),
            ))
            .map_err(|error| error.to_string())?;
        let mut relations = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            relations.push(relation_from_row(row)?);
        }
        Ok(relations)
    }

    pub fn list_relations(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRelation>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, source_ref, relation_type, target_ref,
                        confidence, privacy_domain, sensitivity, evidence_json, metadata_json
                 from relations
                 where user_id = ?1 and workspace_id = ?2
                 order by ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut relations = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let relation = relation_from_row(row)?;
            if !self.is_tombstoned(&relation.reference, user_id, workspace_id)? {
                relations.push(relation);
            }
        }
        Ok(relations)
    }

    pub fn link_evidence(&self, evidence: &MemoryEvidence) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into memory_evidence (memory_ref, evidence_ref, note)
                 values (?1, ?2, ?3)",
                (
                    evidence.memory_ref.to_string(),
                    evidence.evidence_ref.to_string(),
                    &evidence.note,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn evidence_for(
        &self,
        memory_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryEvidence>, String> {
        if memory_ref.user_id != *user_id || memory_ref.workspace_id != *workspace_id {
            return Ok(vec![]);
        }
        let mut statement = self
            .conn
            .prepare(
                "select memory_ref, evidence_ref, note
                 from memory_evidence
                 where memory_ref = ?1
                 order by evidence_ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query([memory_ref.to_string()])
            .map_err(|error| error.to_string())?;
        let mut evidence = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            evidence.push(MemoryEvidence {
                memory_ref: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
                evidence_ref: parse_ref(
                    row.get::<_, String>(1).map_err(|error| error.to_string())?,
                )?,
                note: row.get(2).map_err(|error| error.to_string())?,
            });
        }
        Ok(evidence)
    }

    pub fn record_wiki_page(&self, page: &WikiPage) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into wiki_pages (
                    ref, user_id, workspace_id, path, title, body, linked_refs_json,
                    privacy_domain, sensitivity
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                (
                    page.reference.to_string(),
                    page.user_id.as_str(),
                    page.workspace_id.as_str(),
                    &page.path,
                    &page.title,
                    &page.body,
                    serde_json::to_string(&page.linked_refs).map_err(|error| error.to_string())?,
                    page.privacy_domain.as_str(),
                    enum_name(&page.sensitivity)?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn record_access_decision(
        &self,
        request: &MemoryAccessRequest,
        decision: &MemoryAccessDecision,
    ) -> Result<MemoryRef, String> {
        let reference = MemoryRef::generated(
            MemoryRefKind::Audit,
            request.user_id.clone(),
            request.workspace_id.clone(),
        );
        self.conn
            .execute(
                "insert into access_audit (
                    ref, user_id, workspace_id, actor_id, purpose, decision, reasons_json
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    reference.to_string(),
                    request.user_id.as_str(),
                    request.workspace_id.as_str(),
                    &request.actor_id,
                    &request.purpose,
                    enum_name(&decision.kind)?,
                    serde_json::to_string(&decision.reasons).map_err(|error| error.to_string())?,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(reference)
    }

    pub fn raw_event_payload_for_test(&self, reference: &MemoryRef) -> Result<String, String> {
        self.conn
            .query_row(
                "select payload_json from memory_events where ref = ?1",
                [reference.to_string()],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn access_audit_count(&self) -> Result<u64, String> {
        self.conn
            .query_row("select count(*) from access_audit", [], |row| row.get(0))
            .map_err(|error| error.to_string())
    }

    pub fn get_wiki_page(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<WikiPage>, String> {
        if self.is_tombstoned(reference, user_id, workspace_id)? {
            return Ok(None);
        }
        query_optional(
            &self.conn,
            "select ref, user_id, workspace_id, path, title, body, linked_refs_json,
                    privacy_domain, sensitivity
             from wiki_pages
             where ref = ?1 and user_id = ?2 and workspace_id = ?3",
            (
                reference.to_string(),
                user_id.as_str().to_string(),
                workspace_id.as_str().to_string(),
            ),
            wiki_page_from_row,
        )
    }

    pub fn list_wiki_pages(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<WikiPage>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, path, title, body, linked_refs_json,
                        privacy_domain, sensitivity
                 from wiki_pages
                 where user_id = ?1 and workspace_id = ?2
                 order by path",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut pages = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let page = wiki_page_from_row(row)?;
            if !self.is_tombstoned(&page.reference, user_id, workspace_id)? {
                pages.push(page);
            }
        }
        Ok(pages)
    }

    pub fn tombstone(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        reason: &str,
    ) -> Result<(), String> {
        if reference.user_id != *user_id || reference.workspace_id != *workspace_id {
            return Err("cannot tombstone ref outside user/workspace".to_string());
        }
        self.conn
            .execute(
                "insert or replace into tombstones (ref, user_id, workspace_id, reason)
                 values (?1, ?2, ?3, ?4)",
                (
                    reference.to_string(),
                    user_id.as_str(),
                    workspace_id.as_str(),
                    reason,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn is_tombstoned(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<bool, String> {
        let count: u64 = self
            .conn
            .query_row(
                "select count(*) from tombstones where ref = ?1 and user_id = ?2 and workspace_id = ?3",
                (
                    reference.to_string(),
                    user_id.as_str(),
                    workspace_id.as_str(),
                ),
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        Ok(count > 0)
    }

    fn payload_to_storage(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        sensitivity: DataSensitivity,
        payload: &serde_json::Value,
    ) -> Result<String, String> {
        if sensitivity < DataSensitivity::Confidential {
            return serde_json::to_string(payload).map_err(|error| error.to_string());
        }

        let Some(key_provider) = &self.key_provider else {
            return Err("sensitive payload requires key provider".to_string());
        };
        let encrypted = encrypt_json(key_provider.as_ref(), user_id, workspace_id, payload)?;
        serde_json::to_string(&encrypted).map_err(|error| error.to_string())
    }

    fn payload_from_storage(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        payload_json: &str,
    ) -> Result<serde_json::Value, String> {
        let value: serde_json::Value =
            serde_json::from_str(payload_json).map_err(|error| error.to_string())?;
        if value
            .get("encrypted")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
        {
            let Some(key_provider) = &self.key_provider else {
                return Err("encrypted payload requires key provider".to_string());
            };
            let encrypted: EncryptedJson =
                serde_json::from_value(value).map_err(|error| error.to_string())?;
            return decrypt_json(key_provider.as_ref(), user_id, workspace_id, &encrypted);
        }
        Ok(value)
    }

    fn event_from_row(&self, row: &Row<'_>) -> Result<MemoryEvent, String> {
        let reference = parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?;
        let user_id = UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?);
        let workspace_id =
            WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?);
        let payload_json: String = row.get(6).map_err(|error| error.to_string())?;

        Ok(MemoryEvent {
            reference,
            user_id: user_id.clone(),
            workspace_id: workspace_id.clone(),
            timestamp: row.get(3).map_err(|error| error.to_string())?,
            source: row.get(4).map_err(|error| error.to_string())?,
            event_type: row.get(5).map_err(|error| error.to_string())?,
            payload: self.payload_from_storage(&user_id, &workspace_id, &payload_json)?,
            privacy_domain: PrivacyDomain::new(
                row.get::<_, String>(7).map_err(|error| error.to_string())?,
            ),
            sensitivity: enum_from_name(
                row.get::<_, String>(8).map_err(|error| error.to_string())?,
            )?,
        })
    }

    fn init(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "create table if not exists memory_events (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    timestamp text not null,
                    source text not null,
                    event_type text not null,
                    payload_json text not null,
                    privacy_domain text not null,
                    sensitivity text not null
                );
                create index if not exists idx_memory_events_scope on memory_events(user_id, workspace_id);

                create table if not exists memories (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    memory_type text not null,
                    text text not null,
                    aliases_json text not null,
                    language_hints_json text not null,
                    confidence real not null,
                    status text not null,
                    privacy_domain text not null,
                    sensitivity text not null,
                    metadata_json text not null
                );
                create index if not exists idx_memories_scope on memories(user_id, workspace_id);

                create table if not exists entities (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    entity_type text not null,
                    name text not null,
                    canonical_key text not null,
                    aliases_json text not null,
                    privacy_domain text not null,
                    sensitivity text not null,
                    metadata_json text not null
                );
                create unique index if not exists idx_entities_canonical
                    on entities(user_id, workspace_id, canonical_key);

                create table if not exists relations (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    source_ref text not null,
                    relation_type text not null,
                    target_ref text not null,
                    confidence real not null,
                    privacy_domain text not null,
                    sensitivity text not null,
                    evidence_json text not null,
                    metadata_json text not null
                );
                create index if not exists idx_relations_source on relations(user_id, workspace_id, source_ref);

                create table if not exists memory_evidence (
                    memory_ref text not null,
                    evidence_ref text not null,
                    note text not null,
                    primary key(memory_ref, evidence_ref)
                );

                create table if not exists wiki_pages (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    path text not null,
                    title text not null,
                    body text not null,
                    linked_refs_json text not null,
                    privacy_domain text not null,
                    sensitivity text not null
                );

                create table if not exists access_audit (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    actor_id text not null,
                    purpose text not null,
                    decision text not null,
                    reasons_json text not null,
                    created_at text not null default current_timestamp
                );

                create table if not exists tombstones (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    reason text not null,
                    created_at text not null default current_timestamp
                );",
            )
            .map_err(|error| error.to_string())
    }
}

fn query_optional<T, P, F>(
    conn: &Connection,
    sql: &str,
    params: P,
    mapper: F,
) -> Result<Option<T>, String>
where
    P: rusqlite::Params,
    F: FnOnce(&Row<'_>) -> Result<T, String>,
{
    let mut statement = conn.prepare(sql).map_err(|error| error.to_string())?;
    let mut rows = statement.query(params).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => mapper(row).map(Some),
        None => Ok(None),
    }
}

fn memory_from_row(row: &Row<'_>) -> Result<MemoryRecord, String> {
    Ok(MemoryRecord {
        reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
        user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        workspace_id: WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?),
        memory_type: row.get(3).map_err(|error| error.to_string())?,
        text: row.get(4).map_err(|error| error.to_string())?,
        aliases: serde_json::from_str(&row.get::<_, String>(5).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
        language_hints: serde_json::from_str(
            &row.get::<_, String>(6).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        confidence: row.get(7).map_err(|error| error.to_string())?,
        status: enum_from_name(row.get::<_, String>(8).map_err(|error| error.to_string())?)?,
        privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(9).map_err(|error| error.to_string())?,
        ),
        sensitivity: enum_from_name(
            row.get::<_, String>(10)
                .map_err(|error| error.to_string())?,
        )?,
        metadata: serde_json::from_str(
            &row.get::<_, String>(11)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
    })
}

fn entity_from_row(row: &Row<'_>) -> Result<MemoryEntity, String> {
    Ok(MemoryEntity {
        reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
        user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        workspace_id: WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?),
        entity_type: row.get(3).map_err(|error| error.to_string())?,
        name: row.get(4).map_err(|error| error.to_string())?,
        canonical_key: row.get(5).map_err(|error| error.to_string())?,
        aliases: serde_json::from_str(&row.get::<_, String>(6).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
        privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(7).map_err(|error| error.to_string())?,
        ),
        sensitivity: enum_from_name(row.get::<_, String>(8).map_err(|error| error.to_string())?)?,
        metadata: serde_json::from_str(
            &row.get::<_, String>(9).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
    })
}

fn relation_from_row(row: &Row<'_>) -> Result<MemoryRelation, String> {
    Ok(MemoryRelation {
        reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
        user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        workspace_id: WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?),
        source_ref: parse_ref(row.get::<_, String>(3).map_err(|error| error.to_string())?)?,
        relation_type: row.get(4).map_err(|error| error.to_string())?,
        target_ref: parse_ref(row.get::<_, String>(5).map_err(|error| error.to_string())?)?,
        confidence: row.get(6).map_err(|error| error.to_string())?,
        privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(7).map_err(|error| error.to_string())?,
        ),
        sensitivity: enum_from_name(row.get::<_, String>(8).map_err(|error| error.to_string())?)?,
        evidence: serde_json::from_str(
            &row.get::<_, String>(9).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        metadata: serde_json::from_str(
            &row.get::<_, String>(10)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
    })
}

fn wiki_page_from_row(row: &Row<'_>) -> Result<WikiPage, String> {
    Ok(WikiPage {
        reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
        user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        workspace_id: WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?),
        path: row.get(3).map_err(|error| error.to_string())?,
        title: row.get(4).map_err(|error| error.to_string())?,
        body: row.get(5).map_err(|error| error.to_string())?,
        linked_refs: serde_json::from_str(
            &row.get::<_, String>(6).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(7).map_err(|error| error.to_string())?,
        ),
        sensitivity: enum_from_name(row.get::<_, String>(8).map_err(|error| error.to_string())?)?,
    })
}

fn parse_ref(value: String) -> Result<MemoryRef, String> {
    MemoryRef::from_str(&value)
}

fn enum_name<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_value(value)
        .map_err(|error| error.to_string())?
        .as_str()
        .map(ToString::to_string)
        .ok_or_else(|| "enum did not serialize to string".to_string())
}

fn enum_from_name<T: serde::de::DeserializeOwned>(value: String) -> Result<T, String> {
    serde_json::from_value(serde_json::Value::String(value)).map_err(|error| error.to_string())
}
