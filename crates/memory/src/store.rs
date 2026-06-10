use crate::{
    AutomationCandidateRecord, DataSensitivity, EncryptedJson, KeyProvider, MemoryAccessDecision,
    MemoryAccessRequest, MemoryBackupReport, MemoryEntity, MemoryEvent, MemoryEvidence,
    MemoryHealth, MemoryMaintenanceReport, MemoryRecord, MemoryRef, MemoryRefKind, MemoryRelation,
    MemoryRestoreMode, PrivacyDomain, RoutineRecord, UserId, WikiPage, WorkspaceId, decrypt_json,
    encrypt_json,
};
use rusqlite::{Connection, Row, params};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;

const SCHEMA_VERSION: u32 = 3;

pub struct SQLiteMemoryStore {
    conn: Connection,
    key_provider: Option<Box<dyn KeyProvider>>,
    db_path: Option<PathBuf>,
}

impl SQLiteMemoryStore {
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|error| error.to_string())?;
        let store = Self {
            conn,
            key_provider: None,
            db_path: None,
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
            db_path: None,
        };
        store.init()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let conn = Connection::open(&path).map_err(|error| error.to_string())?;
        let store = Self {
            conn,
            key_provider: None,
            db_path: Some(path),
        };
        store.init()?;
        Ok(store)
    }

    pub fn open_with_key_provider(
        path: impl AsRef<Path>,
        key_provider: Box<dyn KeyProvider>,
    ) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let conn = Connection::open(&path).map_err(|error| error.to_string())?;
        let store = Self {
            conn,
            key_provider: Some(key_provider),
            db_path: Some(path),
        };
        store.init()?;
        Ok(store)
    }

    pub fn run_migrations(&self) -> Result<(), String> {
        self.init()
    }

    pub fn schema_version(&self) -> Result<u32, String> {
        self.conn
            .query_row(
                "select value from schema_metadata where key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?
            .parse::<u32>()
            .map_err(|error| error.to_string())
    }

    pub fn health(&self) -> Result<MemoryHealth, String> {
        Ok(MemoryHealth {
            schema_version: self.schema_version()?,
            total_events: self.count_table("memory_events")?,
            total_memories: self.count_table("memories")?,
            total_entities: self.count_table("entities")?,
            total_relations: self.count_table("relations")?,
            total_wiki_pages: self.count_table("wiki_pages")?,
            access_audit_count: self.access_audit_count()?,
        })
    }

    pub fn backup_to(&self, destination: impl AsRef<Path>) -> Result<MemoryBackupReport, String> {
        let Some(source_path) = &self.db_path else {
            return Err("memory backup requires file-backed store".to_string());
        };
        let destination_path = destination.as_ref().to_path_buf();
        if let Some(parent) = destination_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        self.conn
            .execute_batch("pragma wal_checkpoint(full);")
            .map_err(|error| error.to_string())?;
        let bytes_copied =
            fs::copy(source_path, &destination_path).map_err(|error| error.to_string())?;
        Ok(MemoryBackupReport {
            source_path: source_path.clone(),
            destination_path,
            bytes_copied,
        })
    }

    pub fn restore_from_backup(
        backup_path: impl AsRef<Path>,
        target_path: impl AsRef<Path>,
        mode: MemoryRestoreMode,
    ) -> Result<MemoryBackupReport, String> {
        let backup_path = backup_path.as_ref().to_path_buf();
        let target_path = target_path.as_ref().to_path_buf();
        if target_path.exists() && mode == MemoryRestoreMode::RefuseIfTargetExists {
            return Err("restore target already exists".to_string());
        }
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes_copied =
            fs::copy(&backup_path, &target_path).map_err(|error| error.to_string())?;
        Ok(MemoryBackupReport {
            source_path: backup_path,
            destination_path: target_path,
            bytes_copied,
        })
    }

    pub fn run_maintenance(&self) -> Result<MemoryMaintenanceReport, String> {
        let integrity: String = self
            .conn
            .query_row("pragma integrity_check", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        self.rebuild_memory_search_index()?;
        Ok(MemoryMaintenanceReport {
            integrity_ok: integrity == "ok",
            fts_rebuilt: true,
        })
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
                    metadata_json, created_at, updated_at, last_seen_at, supersedes_json,
                    superseded_by, correction_of
                ) values (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                    ?16, ?17, ?18
                )",
                params![
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
                    &memory.created_at,
                    &memory.updated_at,
                    memory.last_seen_at.as_deref(),
                    serde_json::to_string(&memory.supersedes).map_err(|error| error.to_string())?,
                    memory.superseded_by.as_ref().map(ToString::to_string),
                    memory.correction_of.as_ref().map(ToString::to_string),
                ],
            )
            .map_err(|error| error.to_string())?;
        self.index_memory(memory)?;
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
                    metadata_json, created_at, updated_at, last_seen_at, supersedes_json,
                    superseded_by, correction_of
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
                        metadata_json, created_at, updated_at, last_seen_at, supersedes_json,
                        superseded_by, correction_of
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

    /// Texts of memories the user FORGOT (status deleted/rejected) in a scope.
    /// Deliberately bypasses the tombstone filter `list_memories` applies — these
    /// rows persist and are exactly the "suppression list" for a permanent forget
    /// (so a still-live source can't resurrect a forgotten fact).
    pub fn list_forgotten_texts(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<String>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select text from memories
                 where user_id = ?1 and workspace_id = ?2
                   and status in ('deleted', 'rejected')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map((user_id.as_str(), workspace_id.as_str()), |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    pub fn search_memory_refs(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        query: &str,
    ) -> Result<Vec<MemoryRef>, String> {
        // A bare multi-word string given to FTS5 MATCH is an implicit AND of ALL tokens
        // — so a natural-language question ("Perché abbiamo scelto JSON invece di
        // SQLite?") only matches a record containing EVERY word, which almost never
        // happens → no recall. Build an OR query over the significant terms instead;
        // bm25 ranks the most relevant first.
        let fts = fts_or_query(query);
        if fts.is_empty() {
            return Ok(Vec::new());
        }
        let mut statement = self
            .conn
            .prepare(
                "select ref
                 from memory_search_fts
                 where memory_search_fts match ?1
                   and user_id = ?2
                   and workspace_id = ?3
                 order by bm25(memory_search_fts), text, ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((fts.as_str(), user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut refs = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            refs.push(parse_ref(
                row.get::<_, String>(0).map_err(|error| error.to_string())?,
            )?);
        }
        Ok(refs)
    }

    pub fn rebuild_memory_search_index(&self) -> Result<(), String> {
        self.conn
            .execute("delete from memory_search_fts", [])
            .map_err(|error| error.to_string())?;
        for memory in self.all_memories_for_index()? {
            self.index_memory(&memory)?;
        }
        Ok(())
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

    /// Store (or replace) the embedding vector for a memory. Vectors are f32 little-
    /// endian BLOBs; similarity is computed in-process (brute-force cosine is fine at
    /// local single-user scale).
    pub fn upsert_embedding(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        model: &str,
        vector: &[f32],
    ) -> Result<(), String> {
        let bytes: Vec<u8> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
        self.conn
            .execute(
                "insert into memory_embeddings(ref, user_id, workspace_id, model, dim, vector, updated_at)
                 values(?1, ?2, ?3, ?4, ?5, ?6, current_timestamp)
                 on conflict(ref) do update set
                   model = ?4, dim = ?5, vector = ?6, updated_at = current_timestamp",
                params![
                    reference.to_string(),
                    user_id.as_str(),
                    workspace_id.as_str(),
                    model,
                    vector.len() as i64,
                    bytes,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// All (ref, vector) pairs in a scope, for cosine similarity (dedup / recall).
    pub fn list_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<(MemoryRef, Vec<f32>)>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, vector from memory_embeddings where user_id = ?1 and workspace_id = ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map((user_id.as_str(), workspace_id.as_str()), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
            })
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (ref_string, bytes) = row.map_err(|error| error.to_string())?;
            let reference = parse_ref(ref_string)?;
            let vector = bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            out.push((reference, vector));
        }
        Ok(out)
    }

    /// Memory refs in a scope that don't yet have an embedding (for lazy backfill).
    pub fn refs_without_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        limit: usize,
    ) -> Result<Vec<MemoryRef>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select m.ref from memories m
                 left join memory_embeddings e on e.ref = m.ref
                 where m.user_id = ?1 and m.workspace_id = ?2 and e.ref is null
                 limit ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                (user_id.as_str(), workspace_id.as_str(), limit as i64),
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(parse_ref(row.map_err(|error| error.to_string())?)?);
        }
        Ok(out)
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
        _decision: &MemoryAccessDecision,
    ) -> Result<MemoryRef, String> {
        // Audit recording disabled (per product decision): the access log produced
        // mostly opaque, low-value entries. The access DECISION is still computed and
        // enforced by callers — this just stops persisting it to `access_audit`.
        // Re-enable by restoring the INSERT below if a real audit viewer is built.
        Ok(MemoryRef::generated(
            MemoryRefKind::Audit,
            request.user_id.clone(),
            request.workspace_id.clone(),
        ))
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

    pub fn upsert_routine(&self, routine: &RoutineRecord) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into routines (
                    ref, user_id, workspace_id, name, intent, confidence, status,
                    schedule_hint_json, privacy_domain, sensitivity, evidence_json,
                    metadata_json, created_at, updated_at
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                (
                    routine.reference.to_string(),
                    routine.user_id.as_str(),
                    routine.workspace_id.as_str(),
                    &routine.name,
                    &routine.intent,
                    routine.confidence,
                    enum_name(&routine.status)?,
                    serde_json::to_string(&routine.schedule_hint)
                        .map_err(|error| error.to_string())?,
                    routine.privacy_domain.as_str(),
                    enum_name(&routine.sensitivity)?,
                    serde_json::to_string(&routine.evidence).map_err(|error| error.to_string())?,
                    serde_json::to_string(&routine.metadata).map_err(|error| error.to_string())?,
                    &routine.created_at,
                    &routine.updated_at,
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_routine(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<RoutineRecord>, String> {
        if self.is_tombstoned(reference, user_id, workspace_id)? {
            return Ok(None);
        }
        query_optional(
            &self.conn,
            "select ref, user_id, workspace_id, name, intent, confidence, status,
                    schedule_hint_json, privacy_domain, sensitivity, evidence_json,
                    metadata_json, created_at, updated_at
             from routines
             where ref = ?1 and user_id = ?2 and workspace_id = ?3",
            (
                reference.to_string(),
                user_id.as_str().to_string(),
                workspace_id.as_str().to_string(),
            ),
            routine_from_row,
        )
    }

    pub fn list_routines(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<RoutineRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, name, intent, confidence, status,
                        schedule_hint_json, privacy_domain, sensitivity, evidence_json,
                        metadata_json, created_at, updated_at
                 from routines
                 where user_id = ?1 and workspace_id = ?2
                 order by updated_at desc, ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut routines = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let routine = routine_from_row(row)?;
            if !self.is_tombstoned(&routine.reference, user_id, workspace_id)? {
                routines.push(routine);
            }
        }
        Ok(routines)
    }

    pub fn upsert_automation_candidate(
        &self,
        candidate: &AutomationCandidateRecord,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "insert or replace into automation_candidates (
                    ref, user_id, workspace_id, routine_ref, title, summary, trigger,
                    actions_json, risk_level, autonomy_level, status, privacy_domain,
                    sensitivity, evidence_json, proposal_json, created_at, updated_at
                ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    candidate.reference.to_string(),
                    candidate.user_id.as_str(),
                    candidate.workspace_id.as_str(),
                    candidate.routine_ref.as_ref().map(ToString::to_string),
                    &candidate.title,
                    &candidate.summary,
                    &candidate.trigger,
                    serde_json::to_string(&candidate.actions).map_err(|error| error.to_string())?,
                    enum_name(&candidate.risk_level)?,
                    candidate.autonomy_level,
                    enum_name(&candidate.status)?,
                    candidate.privacy_domain.as_str(),
                    enum_name(&candidate.sensitivity)?,
                    serde_json::to_string(&candidate.evidence).map_err(|error| error.to_string())?,
                    serde_json::to_string(&candidate.proposal_json).map_err(|error| error.to_string())?,
                    &candidate.created_at,
                    &candidate.updated_at,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn list_automation_candidates(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<AutomationCandidateRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, routine_ref, title, summary, trigger,
                        actions_json, risk_level, autonomy_level, status, privacy_domain,
                        sensitivity, evidence_json, proposal_json, created_at, updated_at
                 from automation_candidates
                 where user_id = ?1 and workspace_id = ?2
                 order by updated_at desc, ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query((user_id.as_str(), workspace_id.as_str()))
            .map_err(|error| error.to_string())?;
        let mut candidates = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let candidate = automation_candidate_from_row(row)?;
            if !self.is_tombstoned(&candidate.reference, user_id, workspace_id)? {
                candidates.push(candidate);
            }
        }
        Ok(candidates)
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
        // Cascade: a dead ref must not keep edges in the graph — drop every
        // relation touching it (memory→entity "mentions", entity↔entity links).
        // Both delete paths (delete_memory and tombstone_entity) funnel through
        // here, so this single seam keeps the relations table free of danglers.
        self.conn
            .execute(
                "delete from relations
                 where user_id = ?1 and workspace_id = ?2
                   and (source_ref = ?3 or target_ref = ?3)",
                (
                    user_id.as_str(),
                    workspace_id.as_str(),
                    reference.to_string(),
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
                "create table if not exists schema_metadata (
                    key text primary key,
                    value text not null
                );

                create table if not exists memory_events (
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
                    metadata_json text not null,
                    created_at text not null default current_timestamp,
                    updated_at text not null default current_timestamp,
                    last_seen_at text,
                    supersedes_json text not null default '[]',
                    superseded_by text,
                    correction_of text
                );
                create index if not exists idx_memories_scope on memories(user_id, workspace_id);

                create table if not exists memory_embeddings (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    model text not null,
                    dim integer not null,
                    vector blob not null,
                    updated_at text not null default current_timestamp
                );
                create index if not exists idx_memory_embeddings_scope
                    on memory_embeddings(user_id, workspace_id);

                create virtual table if not exists memory_search_fts using fts5(
                    ref unindexed,
                    user_id unindexed,
                    workspace_id unindexed,
                    text,
                    aliases
                );

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

                create table if not exists routines (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    name text not null,
                    intent text not null,
                    confidence real not null,
                    status text not null,
                    schedule_hint_json text not null,
                    privacy_domain text not null,
                    sensitivity text not null,
                    evidence_json text not null,
                    metadata_json text not null,
                    created_at text not null,
                    updated_at text not null
                );
                create index if not exists idx_routines_scope on routines(user_id, workspace_id);

                create table if not exists automation_candidates (
                    ref text primary key,
                    user_id text not null,
                    workspace_id text not null,
                    routine_ref text,
                    title text not null,
                    summary text not null,
                    trigger text not null,
                    actions_json text not null,
                    risk_level text not null,
                    autonomy_level integer not null,
                    status text not null,
                    privacy_domain text not null,
                    sensitivity text not null,
                    evidence_json text not null,
                    proposal_json text not null,
                    created_at text not null,
                    updated_at text not null
                );
                create index if not exists idx_automation_candidates_scope
                    on automation_candidates(user_id, workspace_id);

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
            .map_err(|error| error.to_string())?;
        self.ensure_column(
            "memories",
            "created_at",
            "alter table memories add column created_at text not null default ''",
        )?;
        self.ensure_column(
            "memories",
            "updated_at",
            "alter table memories add column updated_at text not null default ''",
        )?;
        self.ensure_column(
            "memories",
            "last_seen_at",
            "alter table memories add column last_seen_at text",
        )?;
        self.ensure_column(
            "memories",
            "supersedes_json",
            "alter table memories add column supersedes_json text not null default '[]'",
        )?;
        self.ensure_column(
            "memories",
            "superseded_by",
            "alter table memories add column superseded_by text",
        )?;
        self.ensure_column(
            "memories",
            "correction_of",
            "alter table memories add column correction_of text",
        )?;
        self.conn
            .execute(
                "insert or replace into schema_metadata (key, value) values ('schema_version', ?1)",
                [SCHEMA_VERSION.to_string()],
            )
            .map_err(|error| error.to_string())?;
        self.rebuild_memory_search_index()?;
        Ok(())
    }

    fn ensure_column(&self, table: &str, column: &str, alter_sql: &str) -> Result<(), String> {
        let mut statement = self
            .conn
            .prepare(&format!("pragma table_info({table})"))
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let existing: String = row.get(1).map_err(|error| error.to_string())?;
            if existing == column {
                return Ok(());
            }
        }
        self.conn
            .execute(alter_sql, [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn count_table(&self, table: &str) -> Result<u64, String> {
        let sql = format!("select count(*) from {table}");
        self.conn
            .query_row(&sql, [], |row| row.get(0))
            .map_err(|error| error.to_string())
    }

    fn index_memory(&self, memory: &MemoryRecord) -> Result<(), String> {
        self.conn
            .execute(
                "delete from memory_search_fts where ref = ?1",
                [memory.reference.to_string()],
            )
            .map_err(|error| error.to_string())?;
        self.conn
            .execute(
                "insert into memory_search_fts (ref, user_id, workspace_id, text, aliases)
                 values (?1, ?2, ?3, ?4, ?5)",
                (
                    memory.reference.to_string(),
                    memory.user_id.as_str(),
                    memory.workspace_id.as_str(),
                    &memory.text,
                    memory.aliases.join(" "),
                ),
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn all_memories_for_index(&self) -> Result<Vec<MemoryRecord>, String> {
        let mut statement = self
            .conn
            .prepare(
                "select ref, user_id, workspace_id, memory_type, text, aliases_json,
                        language_hints_json, confidence, status, privacy_domain, sensitivity,
                        metadata_json, created_at, updated_at, last_seen_at, supersedes_json,
                        superseded_by, correction_of
                 from memories
                 order by ref",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        let mut memories = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            memories.push(memory_from_row(row)?);
        }
        Ok(memories)
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
        created_at: row.get(12).map_err(|error| error.to_string())?,
        updated_at: row.get(13).map_err(|error| error.to_string())?,
        last_seen_at: row.get(14).map_err(|error| error.to_string())?,
        supersedes: parse_refs_json(
            row.get::<_, String>(15)
                .map_err(|error| error.to_string())?,
        )?,
        superseded_by: parse_optional_ref(row.get(16).map_err(|error| error.to_string())?)?,
        correction_of: parse_optional_ref(row.get(17).map_err(|error| error.to_string())?)?,
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

fn routine_from_row(row: &Row<'_>) -> Result<RoutineRecord, String> {
    Ok(RoutineRecord {
        reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
        user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        workspace_id: WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?),
        name: row.get(3).map_err(|error| error.to_string())?,
        intent: row.get(4).map_err(|error| error.to_string())?,
        confidence: row.get(5).map_err(|error| error.to_string())?,
        status: enum_from_name(row.get::<_, String>(6).map_err(|error| error.to_string())?)?,
        schedule_hint: serde_json::from_str(
            &row.get::<_, String>(7).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(8).map_err(|error| error.to_string())?,
        ),
        sensitivity: enum_from_name(row.get::<_, String>(9).map_err(|error| error.to_string())?)?,
        evidence: serde_json::from_str(
            &row.get::<_, String>(10)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        metadata: serde_json::from_str(
            &row.get::<_, String>(11)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        created_at: row.get(12).map_err(|error| error.to_string())?,
        updated_at: row.get(13).map_err(|error| error.to_string())?,
    })
}

fn automation_candidate_from_row(row: &Row<'_>) -> Result<AutomationCandidateRecord, String> {
    Ok(AutomationCandidateRecord {
        reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
        user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        workspace_id: WorkspaceId::new(row.get::<_, String>(2).map_err(|error| error.to_string())?),
        routine_ref: parse_optional_ref(row.get(3).map_err(|error| error.to_string())?)?,
        title: row.get(4).map_err(|error| error.to_string())?,
        summary: row.get(5).map_err(|error| error.to_string())?,
        trigger: row.get(6).map_err(|error| error.to_string())?,
        actions: serde_json::from_str(&row.get::<_, String>(7).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
        risk_level: enum_from_name(row.get::<_, String>(8).map_err(|error| error.to_string())?)?,
        autonomy_level: row.get(9).map_err(|error| error.to_string())?,
        status: enum_from_name(
            row.get::<_, String>(10)
                .map_err(|error| error.to_string())?,
        )?,
        privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(11)
                .map_err(|error| error.to_string())?,
        ),
        sensitivity: enum_from_name(
            row.get::<_, String>(12)
                .map_err(|error| error.to_string())?,
        )?,
        evidence: serde_json::from_str(
            &row.get::<_, String>(13)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        proposal_json: serde_json::from_str(
            &row.get::<_, String>(14)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        created_at: row.get(15).map_err(|error| error.to_string())?,
        updated_at: row.get(16).map_err(|error| error.to_string())?,
    })
}

fn parse_ref(value: String) -> Result<MemoryRef, String> {
    MemoryRef::from_str(&value)
}

fn parse_optional_ref(value: Option<String>) -> Result<Option<MemoryRef>, String> {
    value.as_deref().map(MemoryRef::from_str).transpose()
}

fn parse_refs_json(value: String) -> Result<Vec<MemoryRef>, String> {
    serde_json::from_str(&value).map_err(|error| error.to_string())
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

/// Builds an FTS5 OR query from the significant terms of a (possibly natural-language)
/// string. Each term is double-quoted so punctuation/accents can't break the MATCH
/// syntax, and joined with OR — recall should surface records matching ANY key term
/// (ranked by bm25), not require every word. Terms shorter than 3 chars (articles,
/// prepositions) are dropped; the term count is capped. Returns "" when nothing
/// searchable remains.
fn fts_or_query(raw: &str) -> String {
    let terms: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|term| term.chars().count() >= 3)
        .take(24)
        .map(|term| format!("\"{}\"", term.to_lowercase()))
        .collect();
    terms.join(" OR ")
}

#[cfg(test)]
mod fts_query_tests {
    use super::fts_or_query;

    #[test]
    fn or_query_from_natural_language_question() {
        let q = fts_or_query("Perché abbiamo scelto JSON invece di SQLite?");
        assert!(q.contains("\"json\""), "manca json: {q}");
        assert!(q.contains("\"sqlite\""), "manca sqlite: {q}");
        assert!(q.contains(" OR "), "non è OR: {q}");
        assert!(!q.contains("\"di\""), "non deve includere token <3: {q}");
        assert_eq!(fts_or_query("?? !! a b"), "");
    }
}
