use crate::{
    AutomationCandidateRecord, AutomationCandidateStatus, DataSensitivity, EncryptedJson,
    KeyProvider, MemoryAccessDecision, MemoryAccessRequest, MemoryBackupReport, MemoryEntity,
    MemoryEvent, MemoryEvidence, MemoryHealth, MemoryMaintenanceReport, MemoryRecord, MemoryRef,
    MemoryRefKind, MemoryRelation, MemoryRestoreMode, PrivacyDomain, RoutineRecord, UserId,
    VectorHit, WikiPage, WorkspaceId, current_timestamp, decrypt_json, encrypt_json,
};
use rusqlite::{Connection, Row, params};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

const SCHEMA_VERSION: u32 = 3;

/// ADR 0022 (Tappa 2) — modello di connessione dello store.
///
/// - `Single`: una `Connection` dietro `Mutex` (path legacy, `HOMUN_MEMORY_POOL`
///   OFF). Comportamento invariato: la concorrenza resta serializzata dal
///   `Mutex<MemoryFacade>` del gateway. Il `Mutex` interno serve solo a rendere
///   lo store `Sync` (come la variante Pooled) — non aggiunge contesa reale in
///   Single mode perché il facade è comunque dietro un mutex.
/// - `Pooled`: WAL mode con una writer dedicata + N reader. I read girano su
///   reader concorrenti (WAL: un read non blocca un write); le scritture
///   (learn/consolidate/backfill) non bloccano più il recall del turno.
enum Connections {
    Single(Mutex<Connection>),
    Pooled {
        writer: Mutex<Connection>,
        readers: Vec<Mutex<Connection>>,
        /// Indice round-robin per distribuire i read tra le reader.
        reader_idx: AtomicUsize,
    },
}

/// Maniglia su una `Connection` presa in prestito dal pool. Sempre `Guarded`
/// (un `MutexGuard`) — in entrambe le modalità la connection è dietro un Mutex.
/// Fa da `Deref` a `Connection`, così i metodi scrivono
/// `let conn = self.read_conn(); conn.execute(...)`.
enum ConnHandle<'a> {
    Guarded(MutexGuard<'a, Connection>),
}

impl std::ops::Deref for ConnHandle<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match self {
            ConnHandle::Guarded(guard) => guard,
        }
    }
}

pub struct SQLiteMemoryStore {
    conns: Connections,
    key_provider: Option<Box<dyn KeyProvider>>,
    db_path: Option<PathBuf>,
}

impl SQLiteMemoryStore {
    /// ADR 0022 (Tappa 2) — `true` quando `HOMUN_MEMORY_POOL=on`: lo store usa il
    /// pool WAL (writer + reader). Default OFF → `Single` (path legacy invariato).
    fn pool_enabled() -> bool {
        std::env::var("HOMUN_MEMORY_POOL")
            .map(|value| value == "1" || value.eq_ignore_ascii_case("on"))
            .unwrap_or(false)
    }

    /// Numero di reader nel pool (default 3). Letto una volta al costruttore.
    fn pool_reader_count() -> usize {
        std::env::var("HOMUN_MEMORY_POOL_READERS")
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .filter(|value: &usize| *value > 0)
            .unwrap_or(3)
    }

    /// Applica i PRAGMA WAL a una connection (writer o reader). WAL è persistente
    /// a livello di DB file, ma `synchronous`/`busy_timeout`/`foreign_keys` sono
    /// per-connection: vanno settati su ognuna.
    fn apply_wal_pragmas(conn: &Connection) -> Result<(), String> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        // synchronous=NORMAL è sicuro in WAL (nessun corruption; al max si perde
        // l'ultima transazione su crash). FULL aggiunge fsync per-statement.
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        // busy_timeout: se due writer competono (o un checkpoint), attende prima
        // di restituire SQLITE_BUSY. 5000ms copre il consolidation LLM.
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Costruisce il modello di connessione in base al flag. In Single mode una
    /// sola connection (legacy). In Pooled mode apre writer + N reader WAL.
    fn build_connections(
        in_memory: bool,
        path: &Option<PathBuf>,
    ) -> Result<Connections, String> {
        if !Self::pool_enabled() {
            let conn = Self::open_raw(in_memory, path)?;
            return Ok(Connections::Single(Mutex::new(conn)));
        }
        // Pooled: WAL richiede un file su disco (l'in-memory di SQLite non supporta
        // WAL multi-connection condivise). Se richiesto in-memory, cada su una
        // tempdir condivisa tra le connection del pool.
        let (writer_conn, readers_conns) = if in_memory {
            // WAL su in-memory non è condivisibile tra connection: per i test,
            // cada su Single (parità di behaviour, niente pool in-memory).
            // Questo è documentato: il pool è una ottimizzazione per il DB su disco.
            let conn = Self::open_raw(true, path)?;
            return Ok(Connections::Single(Mutex::new(conn)));
        } else {
            let writer = Self::open_raw(false, path)?;
            Self::apply_wal_pragmas(&writer)?;
            let reader_count = Self::pool_reader_count();
            let mut readers = Vec::with_capacity(reader_count);
            for _ in 0..reader_count {
                let r = Self::open_raw(false, path)?;
                Self::apply_wal_pragmas(&r)?;
                readers.push(r);
            }
            (writer, readers)
        };
        Ok(Connections::Pooled {
            writer: Mutex::new(writer_conn),
            readers: readers_conns.into_iter().map(Mutex::new).collect(),
            reader_idx: AtomicUsize::new(0),
        })
    }

    fn open_raw(in_memory: bool, path: &Option<PathBuf>) -> Result<Connection, String> {
        if in_memory {
            Connection::open_in_memory().map_err(|e| e.to_string())
        } else {
            let path = path
                .as_ref()
                .ok_or_else(|| "pool requires a database path".to_string())?;
            Connection::open(path).map_err(|e| e.to_string())
        }
    }

    /// Prende una connection per i READ. In Single mode è l'unica connection; in
    /// Pooled mode è una reader round-robin (lock individuale, read concorrenti).
    fn read_conn(&self) -> ConnHandle<'_> {
        match &self.conns {
            Connections::Single(conn) => ConnHandle::Guarded(
                conn.lock()
                    .map_err(|_| "memory single connection poisoned".to_string())
                    .expect("memory single connection poisoned"),
            ),
            Connections::Pooled { readers, reader_idx, .. } => {
                // Round-robin: ogni read prende la reader successiva. Se quella
                // specifica è occupata (altro read in corso su di essa), attende.
                let len = readers.len().max(1);
                let idx = reader_idx.fetch_add(1, Ordering::Relaxed) % len;
                let guard = readers[idx]
                    .lock()
                    .map_err(|_| "memory reader connection poisoned".to_string())
                    .expect("memory reader connection poisoned");
                ConnHandle::Guarded(guard)
            }
        }
    }

    /// Prende la connection WRITER. In Single mode è l'unica connection; in
    /// Pooled mode è la writer dedicata (lock unico — le scritture serializzano
    /// tra loro, come deve essere, ma NON bloccano i read in WAL mode).
    fn write_conn(&self) -> ConnHandle<'_> {
        match &self.conns {
            Connections::Single(conn) => ConnHandle::Guarded(
                conn.lock()
                    .map_err(|_| "memory single connection poisoned".to_string())
                    .expect("memory single connection poisoned"),
            ),
            Connections::Pooled { writer, .. } => {
                let guard = writer
                    .lock()
                    .map_err(|_| "memory writer connection poisoned".to_string())
                    .expect("memory writer connection poisoned");
                ConnHandle::Guarded(guard)
            }
        }
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conns = Self::build_connections(true, &None)?;
        let store = Self {
            conns,
            key_provider: None,
            db_path: None,
        };
        store.init()?;
        Ok(store)
    }

    pub fn open_in_memory_with_key_provider(
        key_provider: Box<dyn KeyProvider>,
    ) -> Result<Self, String> {
        let conns = Self::build_connections(true, &None)?;
        let store = Self {
            conns,
            key_provider: Some(key_provider),
            db_path: None,
        };
        store.init()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref().to_path_buf();
        let conns = Self::build_connections(false, &Some(path.clone()))?;
        let store = Self {
            conns,
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
        let conns = Self::build_connections(false, &Some(path.clone()))?;
        let store = Self {
            conns,
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
        let conn = self.read_conn();
        conn.query_row(
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
        // wal_checkpoint è una write (forza il flush del WAL): gira sulla writer.
        let conn = self.write_conn();
        conn.execute_batch("pragma wal_checkpoint(full);")
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
        let conn = self.write_conn();
        let integrity: String = conn
            .query_row("pragma integrity_check", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        self.rebuild_memory_search_index()?;
        Ok(MemoryMaintenanceReport {
            integrity_ok: integrity == "ok",
            fts_rebuilt: true,
        })
    }

    pub fn record_event(&self, event: &MemoryEvent) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
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
        let conn = self.read_conn();
        query_optional(
            &conn,
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
        let conn = self.write_conn();
        conn.execute(
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
        self.index_memory_on(&conn, memory)?;
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
        let conn = self.read_conn();
        query_optional(
            &conn,
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
        let conn = self.read_conn();
        let mut statement = conn
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
            if !self.is_tombstoned_on(&conn, &memory.reference, user_id, workspace_id)? {
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
        let conn = self.read_conn();
        let mut statement = conn
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
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
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
        let conn = self.read_conn();
        let mut statement = conn
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
        let conn = self.write_conn();
        self.rebuild_memory_search_index_on(&conn)
    }

    /// Rebuild FTS su una connection data (writer). Usato da init() che ha già
    /// il lock writer, per non riprenderlo.
    fn rebuild_memory_search_index_on(&self, conn: &Connection) -> Result<(), String> {
        conn.execute("delete from memory_search_fts", [])
            .map_err(|error| error.to_string())?;
        for memory in self.all_memories_for_index_on(conn)? {
            self.index_memory_on(conn, &memory)?;
        }
        Ok(())
    }

    pub fn list_entities(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryEntity>, String> {
        let conn = self.read_conn();
        let mut statement = conn
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
            if !self.is_tombstoned_on(&conn, &entity.reference, user_id, workspace_id)? {
                entities.push(entity);
            }
        }
        Ok(entities)
    }

    /// Like `list_entities` but INCLUDING tombstoned ones — the graph regeneration
    /// needs to see entities a previous orphan-sweep killed, so a live memory that
    /// mentions one can RESURRECT it (the sweep tombstoned it only because the
    /// forward-only linker had never connected it). Returns `(entity, tombstoned)`.
    pub fn list_entities_including_tombstoned(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<(MemoryEntity, bool)>, String> {
        let conn = self.read_conn();
        let mut statement = conn
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
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let entity = entity_from_row(row)?;
            let dead = self.is_tombstoned_on(&conn, &entity.reference, user_id, workspace_id)?;
            out.push((entity, dead));
        }
        Ok(out)
    }

    /// Re-point every relation of `from_ref` onto `to_ref` (entity merge): both the
    /// source and target sides. Mention edges get rebuilt by regeneration anyway, but
    /// re-pointing preserves hand-authored entity↔entity edges through the merge.
    pub fn repoint_relations(
        &self,
        from_ref: &MemoryRef,
        to_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), String> {
        let conn = self.write_conn();
        for col in ["source_ref", "target_ref"] {
            conn.execute(
                    &format!(
                        "update relations set {col} = ?1
                         where {col} = ?2 and user_id = ?3 and workspace_id = ?4"
                    ),
                    params![
                        to_ref.to_string(),
                        from_ref.to_string(),
                        user_id.as_str(),
                        workspace_id.as_str(),
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    /// Change a memory's type in place — e.g. promote a `decision` to `goal` when the
    /// user flags it as an objective (the LLM-free, language-agnostic path). Direct
    /// column update; the structured row stays canonical.
    pub fn set_memory_type(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        new_type: &str,
    ) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
                "update memories set memory_type = ?1, updated_at = current_timestamp \
                 where ref = ?2 and user_id = ?3 and workspace_id = ?4",
                params![
                    new_type,
                    reference.to_string(),
                    user_id.as_str(),
                    workspace_id.as_str()
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Drop all imported code-graph data for a scope (entities + relations tagged
    /// `metadata.source = "graphify"`). Called before a re-import so a rebuilt project
    /// graph replaces the old one instead of accumulating. Derived data → hard delete.
    pub fn clear_graphify(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), String> {
        let conn = self.write_conn();
        self.clear_graphify_on(&conn, user_id, workspace_id)
    }

    /// `clear_graphify` su una `&Connection` data. Usato da `import_graphify_batch`
    /// che ha già il lock writer (e una transazione aperta) — riprenderlo causerebbe
    /// deadlock in Pooled mode.
    fn clear_graphify_on(
        &self,
        conn: &Connection,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), String> {
        conn.execute(
                "delete from relations where user_id = ?1 and workspace_id = ?2
                 and json_extract(metadata_json, '$.source') = 'graphify'",
                params![user_id.as_str(), workspace_id.as_str()],
            )
            .map_err(|error| error.to_string())?;
        conn.execute(
                "delete from entities where user_id = ?1 and workspace_id = ?2
                 and json_extract(metadata_json, '$.source') = 'graphify'",
                params![user_id.as_str(), workspace_id.as_str()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Find imported code entities whose NAME matches any of the given terms — for the
    /// per-turn briefing's "these components already exist, don't recreate" section.
    /// One indexed-ish SQL scan (no loading 48k entities into Rust); returns
    /// (name, entity_type, source_file), capped. `terms` are matched case-insensitively
    /// as substrings.
    pub fn search_code_entities(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        terms: &[String],
        limit: usize,
    ) -> Result<Vec<(String, String, String)>, String> {
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let clauses = terms
            .iter()
            .map(|_| "lower(name) like ?")
            .collect::<Vec<_>>()
            .join(" or ");
        let sql = format!(
            "select name, entity_type, \
                coalesce(json_extract(metadata_json, '$.source_file'), '') \
             from entities \
             where user_id = ? and workspace_id = ? \
               and json_extract(metadata_json, '$.source') = 'graphify' \
               and ({clauses}) \
             limit {limit}"
        );
        let mut params: Vec<String> = vec![
            user_id.as_str().to_string(),
            workspace_id.as_str().to_string(),
        ];
        for term in terms {
            params.push(format!("%{}%", term.to_lowercase()));
        }
        let conn = self.read_conn();
        let mut statement = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(triple) = row {
                out.push(triple);
            }
        }
        Ok(out)
    }

    /// Replace a scope's imported code graph in ONE transaction: clears the prior
    /// graphify data, then bulk-inserts the new entities + relations. Batching is
    /// essential at scale — a big repo is tens of thousands of nodes/edges, and per-row
    /// autocommit would fsync each insert (minutes). One transaction = seconds.
    pub fn import_graphify_batch(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        entities: &[MemoryEntity],
        relations: &[MemoryRelation],
    ) -> Result<(usize, usize), String> {
        // Lock the writer ONCE for the whole transaction: BEGIN/COMMIT/ROLLBACK and
        // the per-row inserts must run on the SAME connection. The `*_on` helpers
        // take this `&Connection` directly — calling the public wrappers (which each
        // re-take the writer lock) inside a BEGIN would deadlock in Pooled mode.
        let conn = self.write_conn();
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let run = || -> Result<(usize, usize), String> {
            self.clear_graphify_on(&conn, user_id, workspace_id)?;
            for entity in entities {
                self.upsert_entity_on(&conn, entity)?;
            }
            for relation in relations {
                self.upsert_relation_on(&conn, relation)?;
            }
            Ok((entities.len(), relations.len()))
        };
        match run() {
            Ok(counts) => {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                Ok(counts)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Resurrect an entity: drop its tombstone so it reappears in the graph. Used by
    /// regeneration when a live memory references a wrongly-orphaned entity.
    pub fn untombstone_entity(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
                "delete from tombstones where ref = ?1 and user_id = ?2 and workspace_id = ?3",
                params![
                    reference.to_string(),
                    user_id.as_str(),
                    workspace_id.as_str()
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn upsert_entity(&self, entity: &MemoryEntity) -> Result<(), String> {
        let conn = self.write_conn();
        self.upsert_entity_on(&conn, entity)
    }

    /// `upsert_entity` su una `&Connection` data. Usato da `import_graphify_batch`
    /// (vedi `clear_graphify_on`) per non riprendere il lock writer dentro la tx.
    fn upsert_entity_on(
        &self,
        conn: &Connection,
        entity: &MemoryEntity,
    ) -> Result<(), String> {
        conn.execute(
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
        let conn = self.read_conn();
        query_optional(
            &conn,
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
        let conn = self.write_conn();
        self.upsert_relation_on(&conn, relation)
    }

    /// `upsert_relation` su una `&Connection` data. Usato da `import_graphify_batch`
    /// (vedi `clear_graphify_on`) per non riprendere il lock writer dentro la tx.
    fn upsert_relation_on(
        &self,
        conn: &Connection,
        relation: &MemoryRelation,
    ) -> Result<(), String> {
        conn.execute(
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

    /// Wipe the auto-derived "mentions" edges for a scope (those tagged
    /// `metadata.source = "mention-linker"`). The graph-regeneration invariant
    /// deletes these before re-deriving them from the live facts, so stale edges
    /// (from edited/merged memories) never accumulate. Hand-authored entity↔entity
    /// or decision edges are left untouched. Returns how many were removed.
    pub fn clear_mention_links(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<usize, String> {
        let conn = self.write_conn();
        conn.execute(
                "delete from relations
                 where user_id = ?1 and workspace_id = ?2 and relation_type = 'mentions'
                   and json_extract(metadata_json, '$.source') = 'mention-linker'",
                params![user_id.as_str(), workspace_id.as_str()],
            )
            .map_err(|error| error.to_string())
    }

    pub fn relations_for(
        &self,
        source_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRelation>, String> {
        let conn = self.read_conn();
        let mut statement = conn
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
        let conn = self.read_conn();
        let mut statement = conn
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
            if !self.is_tombstoned_on(&conn, &relation.reference, user_id, workspace_id)? {
                relations.push(relation);
            }
        }
        Ok(relations)
    }

    pub fn link_evidence(&self, evidence: &MemoryEvidence) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
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
        let conn = self.read_conn();
        let mut statement = conn
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
        let conn = self.write_conn();
        conn.execute(
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
        let conn = self.read_conn();
        let mut statement = conn
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

    pub fn search_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        query: &[f32],
        limit: usize,
    ) -> Result<Vec<VectorHit>, String> {
        let embeddings = self.list_embeddings(user_id, workspace_id)?;
        let index = crate::ExactMemoryVectorIndex::from_embeddings(embeddings)
            .map_err(|error| error.to_string())?;
        crate::MemoryVectorIndex::search(&index, query, limit).map_err(|error| error.to_string())
    }

    /// Memory refs in a scope that don't yet have an embedding (for lazy backfill).
    pub fn refs_without_embeddings(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        limit: usize,
    ) -> Result<Vec<MemoryRef>, String> {
        let conn = self.read_conn();
        let mut statement = conn
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
        let conn = self.write_conn();
        conn.execute(
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
        let conn = self.read_conn();
        conn.query_row(
            "select payload_json from memory_events where ref = ?1",
            [reference.to_string()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    }

    pub fn access_audit_count(&self) -> Result<u64, String> {
        let conn = self.read_conn();
        conn.query_row("select count(*) from access_audit", [], |row| row.get(0))
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
        let conn = self.read_conn();
        query_optional(
            &conn,
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
        let conn = self.read_conn();
        let mut statement = conn
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
            if !self.is_tombstoned_on(&conn, &page.reference, user_id, workspace_id)? {
                pages.push(page);
            }
        }
        Ok(pages)
    }

    pub fn upsert_routine(&self, routine: &RoutineRecord) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
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
        let conn = self.read_conn();
        query_optional(
            &conn,
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
        let conn = self.read_conn();
        let mut statement = conn
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
            if !self.is_tombstoned_on(&conn, &routine.reference, user_id, workspace_id)? {
                routines.push(routine);
            }
        }
        Ok(routines)
    }

    /// Targeted status transition for an automation candidate (approve/reject/
    /// execute/stale) — the gateway's "agisci" loop drives it. Scoped to user/ws.
    pub fn set_automation_candidate_status(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        status: &AutomationCandidateStatus,
    ) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
                "update automation_candidates set status = ?1, updated_at = ?2
                 where ref = ?3 and user_id = ?4 and workspace_id = ?5",
                params![
                    enum_name(status)?,
                    current_timestamp(),
                    reference.to_string(),
                    user_id.as_str(),
                    workspace_id.as_str(),
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn upsert_automation_candidate(
        &self,
        candidate: &AutomationCandidateRecord,
    ) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute(
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
        let conn = self.read_conn();
        let mut statement = conn
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
            if !self.is_tombstoned_on(&conn, &candidate.reference, user_id, workspace_id)? {
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
        let conn = self.write_conn();
        conn.execute(
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
        conn.execute(
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

    /// Hard purge ALL memory data for a workspace: memories, entities, relations,
    /// tombstones, embeddings, episodes. Called when a project workspace is deleted.
    /// This is a REAL delete (not soft/tombstone) — data is gone for good.
    pub fn purge_workspace(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<usize, String> {
        let (uid, wid) = (user_id.as_str(), workspace_id.as_str());
        let conn = self.write_conn();
        // Count memories before deleting for the return value.
        let count: u64 = conn
            .query_row(
                "SELECT COUNT(*) FROM memories WHERE user_id = ?1 AND workspace_id = ?2",
                (uid, wid),
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        for table in [
            "memories",
            "entities",
            "relations",
            "tombstones",
            "embeddings",
            "episodes",
            "wiki_pages",
        ] {
            conn.execute(
                    &format!("DELETE FROM {table} WHERE user_id = ?1 AND workspace_id = ?2"),
                    (uid, wid),
                )
                .map_err(|e| e.to_string())?;
        }
        Ok(count as usize)
    }

    /// Reclaims free space. Call periodically, NOT on every delete.
    pub fn vacuum(&self) -> Result<(), String> {
        let conn = self.write_conn();
        conn.execute_batch("VACUUM").map_err(|e| e.to_string())
    }

    fn is_tombstoned(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<bool, String> {
        let conn = self.read_conn();
        self.is_tombstoned_on(&conn, reference, user_id, workspace_id)
    }

    /// Variante su connection data. I metodi read/write che GIÀ tengono un guard
    /// (read_conn/write_conn) devono usare questa: in Single mode la connection è
    /// dietro un unico Mutex, quindi chiamare `is_tombstoned` (che re-prende il
    /// lock) deadlocka. Passando la connection già lockata si evita il re-entrancy.
    fn is_tombstoned_on(
        &self,
        conn: &Connection,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<bool, String> {
        let count: u64 = conn
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
        // init() crea lo schema + rebuild FTS: gira sulla writer (in pooled mode
        // i reader vedranno lo schema via WAL; init idempotente su reader è harmless).
        let conn = self.write_conn();
        conn
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
        // I sub-helper (ensure_column, rebuild) ricevono questa stessa connection
        // (lock unico su writer) — evita di riprendere il Mutex e fare deadlock.
        let conn_ref: &Connection = &conn;
        self.ensure_column_on(
            conn_ref,
            "memories",
            "created_at",
            "alter table memories add column created_at text not null default ''",
        )?;
        self.ensure_column_on(
            conn_ref,
            "memories",
            "updated_at",
            "alter table memories add column updated_at text not null default ''",
        )?;
        self.ensure_column_on(
            conn_ref,
            "memories",
            "last_seen_at",
            "alter table memories add column last_seen_at text",
        )?;
        self.ensure_column_on(
            conn_ref,
            "memories",
            "supersedes_json",
            "alter table memories add column supersedes_json text not null default '[]'",
        )?;
        self.ensure_column_on(
            conn_ref,
            "memories",
            "superseded_by",
            "alter table memories add column superseded_by text",
        )?;
        self.ensure_column_on(
            conn_ref,
            "memories",
            "correction_of",
            "alter table memories add column correction_of text",
        )?;
        conn.execute(
            "insert or replace into schema_metadata (key, value) values ('schema_version', ?1)",
            [SCHEMA_VERSION.to_string()],
        )
        .map_err(|error| error.to_string())?;
        self.rebuild_memory_search_index_on(conn_ref)?;
        Ok(())
    }

    fn ensure_column_on(
        &self,
        conn: &Connection,
        table: &str,
        column: &str,
        alter_sql: &str,
    ) -> Result<(), String> {
        let mut statement = conn
            .prepare(&format!("pragma table_info({table})"))
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let existing: String = row.get(1).map_err(|error| error.to_string())?;
            if existing == column {
                return Ok(());
            }
        }
        conn.execute(alter_sql, [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn count_table(&self, table: &str) -> Result<u64, String> {
        let sql = format!("select count(*) from {table}");
        let conn = self.read_conn();
        conn.query_row(&sql, [], |row| row.get(0))
            .map_err(|error| error.to_string())
    }

    /// Indicizza un memory nel FTS shadow table. Su connection data (usata da
    /// upsert_memory/init che hanno già il lock writer, per non riprenderlo e
    /// fare deadlock).
    fn index_memory_on(&self, conn: &Connection, memory: &MemoryRecord) -> Result<(), String> {
        conn.execute(
            "delete from memory_search_fts where ref = ?1",
            [memory.reference.to_string()],
        )
        .map_err(|error| error.to_string())?;
        conn.execute(
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

    fn all_memories_for_index_on(&self, conn: &Connection) -> Result<Vec<MemoryRecord>, String> {
        let mut statement = conn
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
        let q = fts_or_query("Why did we choose JSON instead of SQLite?");
        assert!(q.contains("\"json\""), "missing json: {q}");
        assert!(q.contains("\"sqlite\""), "missing sqlite: {q}");
        assert!(q.contains(" OR "), "not OR: {q}");
        assert!(!q.contains("\"of\""), "must not include token <3: {q}");
        assert_eq!(fts_or_query("?? !! a b"), "");
    }
}
