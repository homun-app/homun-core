use crate::{
    AUTHORIZED_MEMORY_SEARCH_LIMIT_MAX, AutomationCandidateRecord, AutomationCandidateStatus,
    DataSensitivity, EncryptedJson, KeyProvider, MEMORY_SOURCE_CANDIDATE_PAGE_MAX,
    MemoryAccessDecision, MemoryAccessRequest, MemoryBackupReport, MemoryCollectionKey,
    MemoryEntity, MemoryEvent, MemoryEvidence, MemoryHealth, MemoryMaintenanceReport,
    MemoryPublicationCandidate, MemoryPublicationLink, MemoryPublicationProposal,
    MemoryPublicationReasonCode, MemoryPublicationResolution, MemoryPublicationStatus,
    MemoryRecord, MemoryRef, MemoryRefKind, MemoryRelation, MemoryRestoreMode,
    MemorySourceAccessEvent, MemorySourceAccessOutcome, MemorySourceCandidateProjection,
    MemorySourceGrant, MemorySourceGrantValidationError, PrivacyDomain, RoutineRecord,
    THREADS_WORKSPACE, UserId, VectorHit, WikiPage, WorkspaceId, contains_secret,
    current_timestamp, decrypt_json, encrypt_json, validate_memory_source_grant_intrinsic,
};
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

const SCHEMA_VERSION: u32 = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemorySourceGrantStoreError {
    Validation(String),
    Conflict(String),
    NotFound(String),
    Store(String),
}

pub type MemorySourceGrantStoreResult<T> = Result<T, MemorySourceGrantStoreError>;

impl MemorySourceGrantStoreError {
    fn store(error: impl ToString) -> Self {
        Self::Store(error.to_string())
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemoryPublicationStoreError {
    Validation(String),
    Conflict(String),
    NotFound(String),
    Store(String),
}

pub type MemoryPublicationStoreResult<T> = Result<T, MemoryPublicationStoreError>;

impl MemoryPublicationStoreError {
    fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict(message.into())
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    fn store(error: impl ToString) -> Self {
        Self::Store(error.to_string())
    }
}

pub(crate) fn validate_memory_source_grant(grant: &MemorySourceGrant) -> Result<i64, String> {
    validate_memory_source_grant_intrinsic(grant).map_err(|error| match error {
        MemorySourceGrantValidationError::EmptyGrantId => {
            "memory source grant grant id cannot be empty".to_string()
        }
        MemorySourceGrantValidationError::EmptyConsumerUser => {
            "memory source grant consumer user cannot be empty".to_string()
        }
        MemorySourceGrantValidationError::EmptyConsumerWorkspace => {
            "memory source grant consumer workspace cannot be empty".to_string()
        }
        MemorySourceGrantValidationError::EmptySourceUser => {
            "memory source grant source user cannot be empty".to_string()
        }
        MemorySourceGrantValidationError::EmptySourceWorkspace => {
            "memory source grant source workspace cannot be empty".to_string()
        }
        MemorySourceGrantValidationError::EmptyCreatedBy => {
            "memory source grant created by cannot be empty".to_string()
        }
        MemorySourceGrantValidationError::ReservedConsumerScope => {
            "memory source grant consumer must be a project workspace".to_string()
        }
        MemorySourceGrantValidationError::ReservedSourceScope => {
            "thread memory cannot be a linked source".to_string()
        }
        MemorySourceGrantValidationError::SourceEqualsConsumer => {
            "memory source grant cannot link a workspace to itself".to_string()
        }
        MemorySourceGrantValidationError::CrossUserSourceNotSupported => {
            "cross-user memory source grants are not supported".to_string()
        }
        MemorySourceGrantValidationError::EmptySourcePolicy => {
            "memory source grant must allow a collection or override".to_string()
        }
        MemorySourceGrantValidationError::InvalidOverrideKind => {
            "memory source grant overrides require memory refs".to_string()
        }
        MemorySourceGrantValidationError::OverrideOutsideSource => {
            "memory source grant override is outside the declared source".to_string()
        }
        MemorySourceGrantValidationError::InvalidPolicyVersion => {
            "memory source grant policy version must be positive".to_string()
        }
    })?;

    let policy_version = i64::try_from(grant.policy_version)
        .map_err(|_| "memory source grant policy version exceeds SQLite i64".to_string())?;
    if policy_version < 1 {
        return Err("memory source grant policy version must be positive".to_string());
    }
    if grant.revoked_at.is_none() && policy_version == i64::MAX {
        return Err("active memory source grant policy version has no revoke headroom".to_string());
    }
    Ok(policy_version)
}

fn validate_persisted_memory_source_grant(
    grant: &MemorySourceGrant,
) -> MemorySourceGrantStoreResult<()> {
    validate_memory_source_grant(grant)
        .map(|_| ())
        .map_err(|message| {
            MemorySourceGrantStoreError::Store(format!(
                "invalid persisted memory source grant {}: {message}",
                grant.id
            ))
        })
}

fn validate_memory_source_access_event(event: &MemorySourceAccessEvent) -> Result<(), String> {
    if uuid::Uuid::parse_str(event.id.trim()).is_err()
        || event.consumer_user_id.as_str().trim().is_empty()
        || event.consumer_workspace_id.as_str().trim().is_empty()
        || event.source_workspace_id.as_str().trim().is_empty()
    {
        return Err("invalid memory source access event identity".to_string());
    }
    match event.grant_id.as_deref() {
        None if event.policy_version != 0 => {
            return Err("local memory source access must use policy version zero".to_string());
        }
        Some(grant_id) if grant_id.trim().is_empty() || event.policy_version == 0 => {
            return Err(
                "linked memory source access requires grant and policy version".to_string(),
            );
        }
        _ => {}
    }
    let reason_allowed = match event.outcome {
        MemorySourceAccessOutcome::Allow => event.reason == "allowed",
        MemorySourceAccessOutcome::Deny => event.reason == "intent_not_selected",
        MemorySourceAccessOutcome::Degraded => matches!(
            event.reason.as_str(),
            "source_unavailable"
                | "policy_changed"
                | "policy_revalidation_failed"
                | "audit_unavailable"
        ),
    };
    if !reason_allowed {
        return Err("invalid memory source access reason code".to_string());
    }
    if event.injected_refs.len() > event.candidate_count {
        return Err("memory source access injected refs exceed candidates".to_string());
    }
    let mut unique_refs = HashSet::new();
    for value in &event.injected_refs {
        let reference = MemoryRef::from_str(value)
            .map_err(|_| "memory source access payload must contain refs only".to_string())?;
        if reference.kind != MemoryRefKind::Memory
            || reference.user_id != event.consumer_user_id
            || reference.workspace_id != event.source_workspace_id
            || !unique_refs.insert(reference)
        {
            return Err("memory source access injected ref is outside source".to_string());
        }
    }
    Ok(())
}

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

impl std::ops::DerefMut for ConnHandle<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
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
    /// ADR 0022 (Tappa 2) + ADR 0027 (move 2) — il pool WAL (writer dedicata + N
    /// reader) è ora il path di DEFAULT: le letture girano concorrenti su reader
    /// separati, solo le scritture serializzano brevemente. Questo, con la rimozione
    /// del `Mutex<MemoryFacade>` esterno (ADR 0027 move 1), impedisce a uno sweep o
    /// briefing di SCRITTURA di bloccare gli handler HTTP di LETTURA (il freeze del
    /// 2026-07-09). `HOMUN_MEMORY_POOL=off` resta come escape-hatch verso `Single`.
    fn pool_enabled() -> bool {
        std::env::var("HOMUN_MEMORY_POOL")
            .map(|value| !(value == "0" || value.eq_ignore_ascii_case("off")))
            .unwrap_or(true)
    }

    /// Numero di reader nel pool (default 3). Letto una volta al costruttore.
    fn pool_reader_count() -> usize {
        std::env::var("HOMUN_MEMORY_POOL_READERS")
            .ok()
            .and_then(|value| value.trim().parse().ok())
            .filter(|value: &usize| *value > 0)
            .unwrap_or(3)
    }

    /// Applica i PRAGMA comuni a ogni connection, incluse Single e in-memory.
    fn apply_common_pragmas(conn: &Connection) -> Result<(), String> {
        conn.pragma_update(None, "busy_timeout", 5000)
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Applica i soli PRAGMA specifici di WAL a writer e reader file-backed.
    fn apply_wal_pragmas(conn: &Connection) -> Result<(), String> {
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        // synchronous=NORMAL è sicuro in WAL (nessun corruption; al max si perde
        // l'ultima transazione su crash). FULL aggiunge fsync per-statement.
        conn.pragma_update(None, "synchronous", "NORMAL")
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Costruisce il modello di connessione in base al flag. In Single mode una
    /// sola connection (legacy). In Pooled mode apre writer + N reader WAL.
    fn build_connections(in_memory: bool, path: &Option<PathBuf>) -> Result<Connections, String> {
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
        let conn = if in_memory {
            Connection::open_in_memory().map_err(|e| e.to_string())?
        } else {
            let path = path
                .as_ref()
                .ok_or_else(|| "pool requires a database path".to_string())?;
            Connection::open(path).map_err(|e| e.to_string())?
        };
        Self::apply_common_pragmas(&conn)?;
        Ok(conn)
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
            Connections::Pooled {
                readers,
                reader_idx,
                ..
            } => {
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

    pub fn upsert_memory_source_grant(
        &self,
        grant: &MemorySourceGrant,
    ) -> MemorySourceGrantStoreResult<()> {
        let policy_version =
            validate_memory_source_grant(grant).map_err(MemorySourceGrantStoreError::Validation)?;
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemorySourceGrantStoreError::store)?;

        let mut existing = {
            let mut statement = transaction
                .prepare(
                    "select id, consumer_user_id, consumer_workspace_id, source_user_id,
                            source_workspace_id, max_sensitivity, expires_at, revoked_at,
                            policy_version, created_by, created_at, updated_at
                     from memory_source_grants where id = ?1",
                )
                .map_err(MemorySourceGrantStoreError::store)?;
            let mut rows = statement
                .query([grant.id.as_str()])
                .map_err(MemorySourceGrantStoreError::store)?;
            rows.next()
                .map_err(MemorySourceGrantStoreError::store)?
                .map(memory_source_grant_base_from_row)
                .transpose()
                .map_err(MemorySourceGrantStoreError::store)?
        };

        if let Some(existing) = &mut existing {
            load_memory_source_grant_children(&transaction, existing)
                .map_err(MemorySourceGrantStoreError::store)?;
            if existing == grant {
                transaction
                    .commit()
                    .map_err(MemorySourceGrantStoreError::store)?;
                return Ok(());
            }

            let identity_matches = existing.consumer_user_id == grant.consumer_user_id
                && existing.consumer_workspace_id == grant.consumer_workspace_id
                && existing.source_user_id == grant.source_user_id
                && existing.source_workspace_id == grant.source_workspace_id
                && existing.created_by == grant.created_by
                && existing.created_at == grant.created_at;
            if !identity_matches {
                return Err(MemorySourceGrantStoreError::validation(format!(
                    "memory source grant {} immutable identity mismatch",
                    grant.id
                )));
            }
            if existing.revoked_at.is_some() {
                return Err(MemorySourceGrantStoreError::validation(
                    "revoked memory source grants are immutable; use a new grant id",
                ));
            }
            if grant.revoked_at.is_some() {
                return Err(MemorySourceGrantStoreError::validation(
                    "memory source grants must be revoked through the scoped revoke operation",
                ));
            }
            let expected_version = existing.policy_version.checked_add(1).ok_or_else(|| {
                MemorySourceGrantStoreError::validation(
                    "memory source grant policy version cannot advance",
                )
            })?;
            if grant.policy_version != expected_version {
                return Err(MemorySourceGrantStoreError::conflict(format!(
                    "memory source grant update requires policy version {expected_version}"
                )));
            }
        }

        if grant.revoked_at.is_none() {
            let duplicate_id = transaction
                .query_row(
                    "select id from memory_source_grants
                     where consumer_user_id = ?1 and consumer_workspace_id = ?2
                       and source_user_id = ?3 and source_workspace_id = ?4
                       and revoked_at is null and id <> ?5
                     limit 1",
                    params![
                        grant.consumer_user_id.as_str(),
                        grant.consumer_workspace_id.as_str(),
                        grant.source_user_id.as_str(),
                        grant.source_workspace_id.as_str(),
                        grant.id.as_str(),
                    ],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(MemorySourceGrantStoreError::store)?;
            if duplicate_id.is_some() {
                return Err(MemorySourceGrantStoreError::conflict(
                    "duplicate_active_source",
                ));
            }
        }

        transaction
            .execute(
                "insert into memory_source_grants (
                    id, consumer_user_id, consumer_workspace_id, source_user_id,
                    source_workspace_id, max_sensitivity, expires_at, revoked_at,
                    policy_version, created_by, created_at, updated_at
                 ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 on conflict(id) do update set
                    max_sensitivity = excluded.max_sensitivity,
                    expires_at = excluded.expires_at,
                    policy_version = excluded.policy_version,
                    updated_at = excluded.updated_at",
                params![
                    grant.id,
                    grant.consumer_user_id.as_str(),
                    grant.consumer_workspace_id.as_str(),
                    grant.source_user_id.as_str(),
                    grant.source_workspace_id.as_str(),
                    enum_name(&grant.max_sensitivity)
                        .map_err(MemorySourceGrantStoreError::store)?,
                    grant.expires_at,
                    grant.revoked_at,
                    policy_version,
                    grant.created_by,
                    grant.created_at,
                    grant.updated_at,
                ],
            )
            .map_err(MemorySourceGrantStoreError::store)?;
        transaction
            .execute(
                "delete from memory_source_grant_collections where grant_id = ?1",
                [grant.id.as_str()],
            )
            .map_err(MemorySourceGrantStoreError::store)?;
        transaction
            .execute(
                "delete from memory_source_grant_overrides where grant_id = ?1",
                [grant.id.as_str()],
            )
            .map_err(MemorySourceGrantStoreError::store)?;

        for collection in &grant.collections {
            transaction
                .execute(
                    "insert into memory_source_grant_collections (grant_id, collection_key)
                     values (?1, ?2)",
                    (
                        grant.id.as_str(),
                        enum_name(collection).map_err(MemorySourceGrantStoreError::store)?,
                    ),
                )
                .map_err(MemorySourceGrantStoreError::store)?;
        }
        for (reference, effect) in &grant.overrides {
            let reference_json =
                serde_json::to_string(reference).map_err(MemorySourceGrantStoreError::store)?;
            transaction
                .execute(
                    "insert into memory_source_grant_overrides (grant_id, memory_ref, effect)
                     values (?1, ?2, ?3)",
                    (
                        grant.id.as_str(),
                        reference_json,
                        enum_name(effect).map_err(MemorySourceGrantStoreError::store)?,
                    ),
                )
                .map_err(MemorySourceGrantStoreError::store)?;
        }

        transaction
            .commit()
            .map_err(MemorySourceGrantStoreError::store)
    }

    pub fn list_memory_source_grants(
        &self,
        consumer_user_id: &UserId,
        consumer_workspace_id: &WorkspaceId,
    ) -> MemorySourceGrantStoreResult<Vec<MemorySourceGrant>> {
        let conn = self.read_conn();
        let transaction = conn
            .unchecked_transaction()
            .map_err(MemorySourceGrantStoreError::store)?;
        let mut grants = {
            let mut statement = transaction
                .prepare(
                    "select id, consumer_user_id, consumer_workspace_id, source_user_id,
                            source_workspace_id, max_sensitivity, expires_at, revoked_at,
                            policy_version, created_by, created_at, updated_at
                     from memory_source_grants
                     where consumer_user_id = ?1 and consumer_workspace_id = ?2
                     order by id",
                )
                .map_err(MemorySourceGrantStoreError::store)?;
            let mut rows = statement
                .query((consumer_user_id.as_str(), consumer_workspace_id.as_str()))
                .map_err(MemorySourceGrantStoreError::store)?;
            let mut grants = Vec::new();
            while let Some(row) = rows.next().map_err(MemorySourceGrantStoreError::store)? {
                grants.push(
                    memory_source_grant_base_from_row(row)
                        .map_err(MemorySourceGrantStoreError::store)?,
                );
            }
            grants
        };
        for grant in &mut grants {
            load_memory_source_grant_children(&transaction, grant)
                .map_err(MemorySourceGrantStoreError::store)?;
            validate_persisted_memory_source_grant(grant)?;
        }
        transaction
            .commit()
            .map_err(MemorySourceGrantStoreError::store)?;
        Ok(grants)
    }

    pub fn get_memory_source_grant(
        &self,
        consumer_user_id: &UserId,
        consumer_workspace_id: &WorkspaceId,
        id: &str,
    ) -> MemorySourceGrantStoreResult<Option<MemorySourceGrant>> {
        let conn = self.read_conn();
        let transaction = conn
            .unchecked_transaction()
            .map_err(MemorySourceGrantStoreError::store)?;
        let mut grant = {
            let mut statement = transaction
                .prepare(
                    "select id, consumer_user_id, consumer_workspace_id, source_user_id,
                            source_workspace_id, max_sensitivity, expires_at, revoked_at,
                            policy_version, created_by, created_at, updated_at
                     from memory_source_grants
                     where consumer_user_id = ?1 and consumer_workspace_id = ?2 and id = ?3",
                )
                .map_err(MemorySourceGrantStoreError::store)?;
            let mut rows = statement
                .query((
                    consumer_user_id.as_str(),
                    consumer_workspace_id.as_str(),
                    id,
                ))
                .map_err(MemorySourceGrantStoreError::store)?;
            rows.next()
                .map_err(MemorySourceGrantStoreError::store)?
                .map(memory_source_grant_base_from_row)
                .transpose()
                .map_err(MemorySourceGrantStoreError::store)?
        };
        if let Some(grant) = &mut grant {
            load_memory_source_grant_children(&transaction, grant)
                .map_err(MemorySourceGrantStoreError::store)?;
            validate_persisted_memory_source_grant(grant)?;
        }
        transaction
            .commit()
            .map_err(MemorySourceGrantStoreError::store)?;
        Ok(grant)
    }

    pub fn revoke_memory_source_grant(
        &self,
        consumer_user_id: &UserId,
        consumer_workspace_id: &WorkspaceId,
        id: &str,
        revoked_at: i64,
    ) -> MemorySourceGrantStoreResult<()> {
        if consumer_user_id.as_str().trim().is_empty()
            || consumer_workspace_id.as_str().trim().is_empty()
            || id.trim().is_empty()
        {
            return Err(MemorySourceGrantStoreError::validation(
                "scoped memory source grant revoke requires consumer and grant id",
            ));
        }
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction()
            .map_err(MemorySourceGrantStoreError::store)?;
        let current = {
            let mut statement = transaction
                .prepare(
                    "select policy_version, revoked_at from memory_source_grants
                     where consumer_user_id = ?1 and consumer_workspace_id = ?2 and id = ?3",
                )
                .map_err(MemorySourceGrantStoreError::store)?;
            let mut rows = statement
                .query((
                    consumer_user_id.as_str(),
                    consumer_workspace_id.as_str(),
                    id,
                ))
                .map_err(MemorySourceGrantStoreError::store)?;
            rows.next()
                .map_err(MemorySourceGrantStoreError::store)?
                .map(|row| {
                    Ok::<_, MemorySourceGrantStoreError>((
                        row.get::<_, i64>(0)
                            .map_err(MemorySourceGrantStoreError::store)?,
                        row.get::<_, Option<i64>>(1)
                            .map_err(MemorySourceGrantStoreError::store)?,
                    ))
                })
                .transpose()?
        }
        .ok_or_else(|| {
            MemorySourceGrantStoreError::NotFound(format!("memory source grant {id} not found"))
        })?;
        if current.1.is_some() {
            transaction
                .commit()
                .map_err(MemorySourceGrantStoreError::store)?;
            return Ok(());
        }
        let next_version = current.0.checked_add(1).ok_or_else(|| {
            MemorySourceGrantStoreError::validation(
                "memory source grant policy version cannot advance for revoke",
            )
        })?;
        if current.0 < 1 {
            return Err(MemorySourceGrantStoreError::store(
                "persisted memory source grant policy version is invalid",
            ));
        }
        let changed = transaction
            .execute(
                "update memory_source_grants
             set revoked_at = ?4, policy_version = ?5, updated_at = ?6
             where consumer_user_id = ?1 and consumer_workspace_id = ?2 and id = ?3
               and revoked_at is null and policy_version = ?7",
                params![
                    consumer_user_id.as_str(),
                    consumer_workspace_id.as_str(),
                    id,
                    revoked_at,
                    next_version,
                    current_timestamp(),
                    current.0,
                ],
            )
            .map_err(MemorySourceGrantStoreError::store)?;
        if changed != 1 {
            return Err(MemorySourceGrantStoreError::conflict(
                "memory source grant changed concurrently during revoke",
            ));
        }
        transaction
            .commit()
            .map_err(MemorySourceGrantStoreError::store)
    }

    pub fn create_memory_publication_proposal(
        &self,
        proposal: &MemoryPublicationProposal,
    ) -> MemoryPublicationStoreResult<()> {
        validate_memory_publication_proposal(proposal)
            .map_err(MemoryPublicationStoreError::validation)?;
        let source_ref_json = publication_ref_json(&proposal.source_ref)
            .map_err(MemoryPublicationStoreError::store)?;
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryPublicationStoreError::store)?;

        let already_linked = transaction
            .query_row(
                "select exists(select 1 from memory_publication_links where source_ref_json = ?1)",
                [&source_ref_json],
                |row| row.get::<_, bool>(0),
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if already_linked {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_already_published",
            ));
        }
        let already_pending = transaction
            .query_row(
                "select exists(
                    select 1 from memory_publication_proposals
                    where source_ref_json = ?1 and status = 'pending'
                 )",
                [&source_ref_json],
                |row| row.get::<_, bool>(0),
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if already_pending {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_already_pending",
            ));
        }

        transaction
            .execute(
                "insert into memory_publication_proposals (
                    id, proposal_version, source_ref_json, source_user_id, source_workspace_id,
                    destination_user_id, destination_workspace_id, proposed_text,
                    proposed_memory_type, proposed_collection, proposed_privacy_domain,
                    proposed_sensitivity, source_revision, candidate_json, resolution_json, status, reason_code,
                    failure_reason, proposed_by, decided_by, created_at, updated_at
                 ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
                params![
                    &proposal.id,
                    proposal.proposal_version,
                    source_ref_json,
                    proposal.source_user_id.as_str(),
                    proposal.source_workspace_id.as_str(),
                    proposal.destination_user_id.as_str(),
                    proposal.destination_workspace_id.as_str(),
                    &proposal.proposed_text,
                    &proposal.proposed_memory_type,
                    enum_name(&proposal.proposed_collection)
                        .map_err(MemoryPublicationStoreError::store)?,
                    proposal.proposed_privacy_domain.as_str(),
                    enum_name(&proposal.proposed_sensitivity)
                        .map_err(MemoryPublicationStoreError::store)?,
                    &proposal.source_revision,
                    proposal
                        .candidate
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(MemoryPublicationStoreError::store)?,
                    proposal
                        .resolution
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(MemoryPublicationStoreError::store)?,
                    enum_name(&proposal.status).map_err(MemoryPublicationStoreError::store)?,
                    enum_name(&proposal.reason_code).map_err(MemoryPublicationStoreError::store)?,
                    proposal.failure_reason.as_deref(),
                    &proposal.proposed_by,
                    proposal.decided_by.as_deref(),
                    &proposal.created_at,
                    &proposal.updated_at,
                ],
            )
            .map_err(|error| {
                if error.to_string().contains("UNIQUE constraint failed") {
                    MemoryPublicationStoreError::conflict("publication_already_exists")
                } else {
                    MemoryPublicationStoreError::store(error)
                }
            })?;
        transaction
            .commit()
            .map_err(MemoryPublicationStoreError::store)
    }

    pub fn get_memory_publication_proposal(
        &self,
        id: &str,
    ) -> MemoryPublicationStoreResult<Option<MemoryPublicationProposal>> {
        if id.trim().is_empty() {
            return Err(MemoryPublicationStoreError::validation(
                "publication proposal id cannot be empty",
            ));
        }
        let conn = self.read_conn();
        let proposal = query_optional(
            &conn,
            "select id, proposal_version, source_ref_json, source_user_id, source_workspace_id,
                    destination_user_id, destination_workspace_id, proposed_text,
                    proposed_memory_type, proposed_collection, proposed_privacy_domain,
                    proposed_sensitivity, source_revision, candidate_json, resolution_json, status, reason_code,
                    failure_reason, proposed_by, decided_by, created_at, updated_at
             from memory_publication_proposals where id = ?1",
            [id],
            memory_publication_proposal_from_row,
        )
        .map_err(MemoryPublicationStoreError::store)?;
        if let Some(proposal) = &proposal {
            validate_persisted_memory_publication_proposal(proposal)
                .map_err(MemoryPublicationStoreError::store)?;
        }
        Ok(proposal)
    }

    /// Returns the one pending publication that currently owns a source ref.
    /// Publication creation takes the writer transaction before inserting, so
    /// this read is only a resumability hint; callers still handle a concurrent
    /// insert by reloading the winner after `publication_already_pending`.
    pub fn pending_memory_publication_for_source(
        &self,
        source_ref: &MemoryRef,
    ) -> MemoryPublicationStoreResult<Option<MemoryPublicationProposal>> {
        let conn = self.read_conn();
        let proposal = query_optional(
            &conn,
            "select id, proposal_version, source_ref_json, source_user_id, source_workspace_id,
                    destination_user_id, destination_workspace_id, proposed_text,
                    proposed_memory_type, proposed_collection, proposed_privacy_domain,
                    proposed_sensitivity, source_revision, candidate_json, resolution_json, status, reason_code,
                    failure_reason, proposed_by, decided_by, created_at, updated_at
             from memory_publication_proposals
             where source_ref_json = ?1 and status = 'pending'
             order by created_at, id
             limit 1",
            [publication_ref_json(source_ref).map_err(MemoryPublicationStoreError::store)?],
            memory_publication_proposal_from_row,
        )
        .map_err(MemoryPublicationStoreError::store)?;
        proposal
            .as_ref()
            .map(validate_persisted_memory_publication_proposal)
            .transpose()
            .map_err(MemoryPublicationStoreError::store)?;
        Ok(proposal)
    }

    /// Updates only a pending proposal. The caller supplies an already
    /// revalidated proposal from the facade; this transaction still protects
    /// against ownership, state, and identity changes between read and write.
    pub fn update_memory_publication_proposal(
        &self,
        proposal: &MemoryPublicationProposal,
        actor: &str,
        expected_version: u64,
    ) -> MemoryPublicationStoreResult<MemoryPublicationProposal> {
        validate_memory_publication_proposal(proposal)
            .map_err(MemoryPublicationStoreError::validation)?;
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryPublicationStoreError::store)?;
        let stored = load_memory_publication_proposal_on(&transaction, &proposal.id)?
            .ok_or_else(|| MemoryPublicationStoreError::not_found("publication_not_found"))?;
        if actor != stored.proposed_by || actor != stored.source_user_id.as_str() {
            return Err(MemoryPublicationStoreError::validation(
                "publication_actor_mismatch",
            ));
        }
        if stored.status != MemoryPublicationStatus::Pending {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_not_pending",
            ));
        }
        let next_version = expected_version.checked_add(1).ok_or_else(|| {
            MemoryPublicationStoreError::validation("publication_version_invalid")
        })?;
        if stored.proposal_version != expected_version || proposal.proposal_version != next_version
        {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_conflict",
            ));
        }
        if stored.source_ref != proposal.source_ref
            || stored.source_user_id != proposal.source_user_id
            || stored.source_workspace_id != proposal.source_workspace_id
            || stored.destination_user_id != proposal.destination_user_id
            || stored.destination_workspace_id != proposal.destination_workspace_id
            || stored.source_revision != proposal.source_revision
            || stored.proposed_by != proposal.proposed_by
            || stored.created_at != proposal.created_at
        {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_changed_concurrently",
            ));
        }
        let changed = transaction
            .execute(
                "update memory_publication_proposals
                 set proposed_text = ?2, proposed_memory_type = ?3, proposed_collection = ?4,
                     proposed_privacy_domain = ?5, proposed_sensitivity = ?6, candidate_json = ?7,
                     resolution_json = null, reason_code = ?8, updated_at = ?9, proposal_version = ?10
                 where id = ?1 and status = 'pending' and proposal_version = ?11",
                params![
                    &proposal.id,
                    &proposal.proposed_text,
                    &proposal.proposed_memory_type,
                    enum_name(&proposal.proposed_collection)
                        .map_err(MemoryPublicationStoreError::store)?,
                    proposal.proposed_privacy_domain.as_str(),
                    enum_name(&proposal.proposed_sensitivity)
                        .map_err(MemoryPublicationStoreError::store)?,
                    proposal
                        .candidate
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()
                        .map_err(MemoryPublicationStoreError::store)?,
                    enum_name(&proposal.reason_code).map_err(MemoryPublicationStoreError::store)?,
                    &proposal.updated_at,
                    proposal.proposal_version,
                    expected_version,
                ],
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if changed != 1 {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_changed_concurrently",
            ));
        }
        let updated = load_memory_publication_proposal_on(&transaction, &proposal.id)?
            .ok_or_else(|| MemoryPublicationStoreError::store("publication disappeared"))?;
        transaction
            .commit()
            .map_err(MemoryPublicationStoreError::store)?;
        Ok(updated)
    }

    pub fn get_memory_publication_link(
        &self,
        source_ref: &MemoryRef,
    ) -> MemoryPublicationStoreResult<Option<MemoryPublicationLink>> {
        let source_ref_json =
            publication_ref_json(source_ref).map_err(MemoryPublicationStoreError::store)?;
        let conn = self.read_conn();
        query_optional(
            &conn,
            "select source_ref_json, destination_ref_json, approved_by, created_at
             from memory_publication_links where source_ref_json = ?1",
            [&source_ref_json],
            memory_publication_link_from_row,
        )
        .map_err(MemoryPublicationStoreError::store)
    }

    pub fn set_memory_publication_resolution(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
        resolution: &MemoryPublicationResolution,
        updated_at: &str,
    ) -> MemoryPublicationStoreResult<MemoryPublicationProposal> {
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryPublicationStoreError::store)?;
        let proposal = load_memory_publication_proposal_on(&transaction, id)?
            .ok_or_else(|| MemoryPublicationStoreError::not_found("publication_not_found"))?;
        if actor != proposal.proposed_by || actor != proposal.source_user_id.as_str() {
            return Err(MemoryPublicationStoreError::validation(
                "publication_actor_mismatch",
            ));
        }
        if proposal.status != MemoryPublicationStatus::Pending {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_not_pending",
            ));
        }
        let next_version = expected_version.checked_add(1).ok_or_else(|| {
            MemoryPublicationStoreError::validation("publication_version_invalid")
        })?;
        if proposal.proposal_version != expected_version {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_conflict",
            ));
        }
        let changed = transaction
            .execute(
                "update memory_publication_proposals
                 set resolution_json = ?2, updated_at = ?3, proposal_version = ?4
                 where id = ?1 and status = 'pending' and proposal_version = ?5",
                params![
                    id,
                    serde_json::to_string(resolution)
                        .map_err(MemoryPublicationStoreError::store)?,
                    updated_at,
                    next_version,
                    expected_version,
                ],
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if changed != 1 {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_changed_concurrently",
            ));
        }
        let updated = load_memory_publication_proposal_on(&transaction, id)?
            .ok_or_else(|| MemoryPublicationStoreError::store("publication disappeared"))?;
        transaction
            .commit()
            .map_err(MemoryPublicationStoreError::store)?;
        Ok(updated)
    }

    pub fn reject_memory_publication(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
        updated_at: &str,
    ) -> MemoryPublicationStoreResult<MemoryPublicationProposal> {
        if actor.trim().is_empty() {
            return Err(MemoryPublicationStoreError::validation(
                "publication actor cannot be empty",
            ));
        }
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryPublicationStoreError::store)?;
        let proposal = load_memory_publication_proposal_on(&transaction, id)?
            .ok_or_else(|| MemoryPublicationStoreError::not_found("publication_not_found"))?;
        if actor != proposal.proposed_by || actor != proposal.source_user_id.as_str() {
            return Err(MemoryPublicationStoreError::validation(
                "publication_actor_mismatch",
            ));
        }
        if proposal.status == MemoryPublicationStatus::Rejected {
            if proposal.proposal_version != expected_version {
                return Err(MemoryPublicationStoreError::conflict(
                    "publication_conflict",
                ));
            }
            transaction
                .commit()
                .map_err(MemoryPublicationStoreError::store)?;
            return Ok(proposal);
        }
        if proposal.status != MemoryPublicationStatus::Pending {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_not_pending",
            ));
        }
        let next_version = expected_version.checked_add(1).ok_or_else(|| {
            MemoryPublicationStoreError::validation("publication_version_invalid")
        })?;
        if proposal.proposal_version != expected_version {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_conflict",
            ));
        }
        let changed = transaction
            .execute(
                "update memory_publication_proposals
                 set status = 'rejected', reason_code = 'rejected', decided_by = ?2, updated_at = ?3,
                     proposal_version = ?4
                 where id = ?1 and status = 'pending' and proposal_version = ?5",
                params![id, actor, updated_at, next_version, expected_version],
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if changed != 1 {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_changed_concurrently",
            ));
        }
        let rejected = load_memory_publication_proposal_on(&transaction, id)?
            .ok_or_else(|| MemoryPublicationStoreError::store("publication disappeared"))?;
        transaction
            .commit()
            .map_err(MemoryPublicationStoreError::store)?;
        Ok(rejected)
    }

    pub fn mark_memory_publication_failed(
        &self,
        id: &str,
        actor: &str,
        expected_version: u64,
        failure_reason: &str,
        updated_at: &str,
    ) -> MemoryPublicationStoreResult<Option<MemoryPublicationProposal>> {
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryPublicationStoreError::store)?;
        let next_version = expected_version.checked_add(1).ok_or_else(|| {
            MemoryPublicationStoreError::validation("publication_version_invalid")
        })?;
        let changed = transaction
            .execute(
                "update memory_publication_proposals
                 set status = 'failed', reason_code = 'publication_failed', failure_reason = ?3,
                     decided_by = ?2, updated_at = ?4, proposal_version = ?5
                 where id = ?1 and status = 'pending' and proposal_version = ?6",
                params![
                    id,
                    actor,
                    sanitize_publication_failure_reason(failure_reason),
                    updated_at,
                    next_version,
                    expected_version,
                ],
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if changed != 1 {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_conflict",
            ));
        }
        let result = load_memory_publication_proposal_on(&transaction, id)?;
        transaction
            .commit()
            .map_err(MemoryPublicationStoreError::store)?;
        Ok(result)
    }

    /// Commits every visible side effect of publication in a single SQLite
    /// transaction. A stale proposal state, duplicate link, or failed statement
    /// rolls back the destination write and source alias together.
    pub fn commit_publication(
        &self,
        proposal: &MemoryPublicationProposal,
        destination: &MemoryRecord,
        source_with_alias: &MemoryRecord,
        link: &MemoryPublicationLink,
        expected_source: &MemoryRecord,
        expected_source_evidence: &[MemoryEvidence],
        expected_destination_scope: &[MemoryRecord],
    ) -> MemoryPublicationStoreResult<MemoryPublicationProposal> {
        let mut conn = self.write_conn();
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(MemoryPublicationStoreError::store)?;
        let stored = load_memory_publication_proposal_on(&transaction, &proposal.id)?
            .ok_or_else(|| MemoryPublicationStoreError::not_found("publication_not_found"))?;
        if stored != *proposal || stored.status != MemoryPublicationStatus::Pending {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_not_pending",
            ));
        }
        if destination.user_id != proposal.destination_user_id
            || destination.workspace_id != proposal.destination_workspace_id
            || source_with_alias.reference != proposal.source_ref
            || source_with_alias.user_id != proposal.source_user_id
            || source_with_alias.workspace_id != proposal.source_workspace_id
            || link.source_ref != proposal.source_ref
            || link.destination_ref != destination.reference
            || link.approved_by != proposal.proposed_by
        {
            return Err(MemoryPublicationStoreError::validation(
                "publication transaction scope mismatch",
            ));
        }

        // The facade's policy/candidate check happens before this writer lock is
        // acquired. Re-read its complete inputs under the same IMMEDIATE
        // transaction that owns the writes, so a source mutation, tombstone, or
        // destination conflict cannot slip between validation and commit.
        let source = visible_memory_exact_on(
            &transaction,
            &proposal.source_ref,
            &proposal.source_user_id,
            &proposal.source_workspace_id,
        )
        .map_err(MemoryPublicationStoreError::store)?;
        if source.as_ref() != Some(expected_source) {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_source_changed",
            ));
        }
        let source_evidence = evidence_for_on(&transaction, &proposal.source_ref)
            .map_err(MemoryPublicationStoreError::store)?;
        if source_evidence != expected_source_evidence {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_source_changed",
            ));
        }
        let destination_scope = visible_memories_in_scope_on(
            &transaction,
            &proposal.destination_user_id,
            &proposal.destination_workspace_id,
        )
        .map_err(MemoryPublicationStoreError::store)?;
        if destination_scope != expected_destination_scope {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_conflict",
            ));
        }

        upsert_memory_on(&transaction, destination).map_err(MemoryPublicationStoreError::store)?;
        self.index_memory_on(&transaction, destination)
            .map_err(MemoryPublicationStoreError::store)?;
        upsert_memory_on(&transaction, source_with_alias)
            .map_err(MemoryPublicationStoreError::store)?;
        self.index_memory_on(&transaction, source_with_alias)
            .map_err(MemoryPublicationStoreError::store)?;
        transaction
            .execute(
                "insert into memory_publication_links(
                    source_ref_json, destination_ref_json, approved_by, created_at
                 ) values (?1, ?2, ?3, ?4)",
                params![
                    publication_ref_json(&link.source_ref)
                        .map_err(MemoryPublicationStoreError::store)?,
                    publication_ref_json(&link.destination_ref)
                        .map_err(MemoryPublicationStoreError::store)?,
                    &link.approved_by,
                    &link.created_at,
                ],
            )
            .map_err(|error| {
                if error.to_string().contains("UNIQUE constraint failed") {
                    MemoryPublicationStoreError::conflict("publication_already_published")
                } else {
                    MemoryPublicationStoreError::store(error)
                }
            })?;
        let changed = transaction
            .execute(
                "update memory_publication_proposals
                 set status = 'approved', reason_code = 'approved', failure_reason = null,
                     decided_by = ?2, updated_at = ?3, proposal_version = proposal_version + 1
                 where id = ?1 and status = 'pending' and proposal_version = ?4",
                params![
                    &proposal.id,
                    &link.approved_by,
                    &link.created_at,
                    proposal.proposal_version,
                ],
            )
            .map_err(MemoryPublicationStoreError::store)?;
        if changed != 1 {
            return Err(MemoryPublicationStoreError::conflict(
                "publication_changed_concurrently",
            ));
        }
        let approved = load_memory_publication_proposal_on(&transaction, &proposal.id)?
            .ok_or_else(|| MemoryPublicationStoreError::store("publication disappeared"))?;
        transaction
            .commit()
            .map_err(MemoryPublicationStoreError::store)?;
        Ok(approved)
    }

    pub fn record_memory_source_access(
        &self,
        event: &MemorySourceAccessEvent,
    ) -> Result<(), String> {
        validate_memory_source_access_event(event)?;
        let policy_version =
            i64::try_from(event.policy_version).map_err(|error| error.to_string())?;
        let candidate_count =
            i64::try_from(event.candidate_count).map_err(|error| error.to_string())?;
        let outcome = match event.outcome {
            MemorySourceAccessOutcome::Allow => "allow",
            MemorySourceAccessOutcome::Deny => "deny",
            MemorySourceAccessOutcome::Degraded => "degraded",
        };
        let conn = self.write_conn();
        conn.execute(
            "insert into memory_source_access_events (
                id, consumer_user_id, consumer_workspace_id, source_workspace_id,
                grant_id, policy_version, turn_id, outcome, reason, candidate_count,
                injected_refs_json, created_at
             ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                &event.id,
                event.consumer_user_id.as_str(),
                event.consumer_workspace_id.as_str(),
                event.source_workspace_id.as_str(),
                event.grant_id.as_deref(),
                policy_version,
                event.turn_id.as_deref(),
                outcome,
                &event.reason,
                candidate_count,
                serde_json::to_string(&event.injected_refs).map_err(|error| error.to_string())?,
                event.created_at,
            ],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn last_memory_source_access(
        &self,
        grant_id: &str,
    ) -> Result<Option<MemorySourceAccessEvent>, String> {
        if grant_id.trim().is_empty() {
            return Err("memory source access grant id cannot be empty".to_string());
        }
        let conn = self.read_conn();
        let event = query_optional(
            &conn,
            "select id, consumer_user_id, consumer_workspace_id, source_workspace_id,
                    grant_id, policy_version, turn_id, outcome, reason, candidate_count,
                    injected_refs_json, created_at
             from memory_source_access_events
             where grant_id = ?1
             order by created_at desc, rowid desc
             limit 1",
            [grant_id],
            memory_source_access_from_row,
        )?;
        if let Some(event) = &event {
            validate_memory_source_access_event(event)?;
        }
        Ok(event)
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
        self.rebuild_memory_search_index_on(&conn)?;
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
        upsert_memory_on(&conn, memory)?;
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

    /// Linked-recall exact-ref read. Memory row and tombstone visibility are
    /// evaluated by one SQL statement on one connection/snapshot.
    pub(crate) fn get_visible_memory_exact(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<MemoryRecord>, String> {
        if reference.user_id != *user_id || reference.workspace_id != *workspace_id {
            return Ok(None);
        }
        let conn = self.read_conn();
        query_optional(
            &conn,
            "select m.ref, m.user_id, m.workspace_id, m.memory_type, m.text, m.aliases_json,
                    m.language_hints_json, m.confidence, m.status, m.privacy_domain,
                    m.sensitivity, m.metadata_json, m.created_at, m.updated_at,
                    m.last_seen_at, m.supersedes_json, m.superseded_by, m.correction_of
             from memories m
             where m.ref = ?1 and m.user_id = ?2 and m.workspace_id = ?3
               and not exists (
                   select 1 from tombstones t
                   where t.ref = m.ref
                     and t.user_id = m.user_id
                     and t.workspace_id = m.workspace_id
               )",
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

    /// Active source-picker memories for one exact owner/workspace scope.
    ///
    /// Candidate and Confirmed are the only picker-visible lifecycle states.
    /// Secret, tombstoned, and oversized payloads are omitted in SQL before any
    /// Rust materialization; callers still perform full payload secret scanning.
    pub fn list_memory_source_candidates(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        offset: usize,
        limit: usize,
    ) -> Result<Vec<MemorySourceCandidateProjection>, String> {
        const TEXT_MAX_BYTES: i64 = 32 * 1024;
        const METADATA_MAX_BYTES: i64 = 32 * 1024;

        let limit = limit.min(MEMORY_SOURCE_CANDIDATE_PAGE_MAX);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit).map_err(|error| error.to_string())?;
        let offset = i64::try_from(offset).unwrap_or(i64::MAX);
        let conn = self.read_conn();
        let mut statement = conn
            .prepare(
                "select m.ref, m.memory_type, m.text, m.sensitivity, m.metadata_json
                 from memories m
                 where m.user_id = ?1 and m.workspace_id = ?2
                   and m.status in ('candidate', 'confirmed')
                   and m.sensitivity <> 'secret'
                   and length(cast(m.text as blob)) <= ?3
                   and length(cast(m.metadata_json as blob)) <= ?4
                   and not exists (
                       select 1 from tombstones t
                       where t.ref = m.ref
                         and t.user_id = m.user_id
                         and t.workspace_id = m.workspace_id
                   )
                 order by m.ref
                 limit ?5 offset ?6",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = statement
            .query(params![
                user_id.as_str(),
                workspace_id.as_str(),
                TEXT_MAX_BYTES,
                METADATA_MAX_BYTES,
                limit,
                offset,
            ])
            .map_err(|error| error.to_string())?;
        let mut candidates = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            candidates.push(MemorySourceCandidateProjection {
                reference: parse_ref(row.get::<_, String>(0).map_err(|error| error.to_string())?)?,
                memory_type: row.get(1).map_err(|error| error.to_string())?,
                text: row.get(2).map_err(|error| error.to_string())?,
                sensitivity: enum_from_name(
                    row.get::<_, String>(3).map_err(|error| error.to_string())?,
                )?,
                metadata: serde_json::from_str(
                    &row.get::<_, String>(4).map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?,
            });
        }
        Ok(candidates)
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

    /// Query-local lexical index populated only with records accepted by
    /// `allows`. Records are streamed from SQLite into a TEMP FTS table on the
    /// same guarded read connection, so denied records cannot affect BM25
    /// statistics, ordering or the result limit. No ref list is materialized
    /// in Rust and the returned page is hard-capped.
    pub(crate) fn search_memory_refs_filtered<F>(
        &self,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
        query: &str,
        limit: usize,
        offset: usize,
        mut allows: F,
    ) -> Result<(Vec<MemoryRef>, usize), String>
    where
        F: FnMut(&MemoryRecord) -> bool,
    {
        let fts = fts_or_query(query);
        let limit = limit.min(AUTHORIZED_MEMORY_SEARCH_LIMIT_MAX);
        if fts.is_empty() || limit == 0 {
            return Ok((Vec::new(), 0));
        }
        let limit = i64::try_from(limit).map_err(|error| error.to_string())?;
        let offset = i64::try_from(offset).unwrap_or(i64::MAX);
        let conn = self.read_conn();
        conn.execute_batch(
            "create virtual table if not exists temp.authorized_memory_search_fts using fts5(
                 ref unindexed,
                 text
             );
             delete from temp.authorized_memory_search_fts;",
        )
        .map_err(|error| error.to_string())?;

        let mut run = || -> Result<(Vec<MemoryRef>, usize), String> {
            let mut records_statement = conn
                .prepare(
                    "select m.ref, m.user_id, m.workspace_id, m.memory_type, m.text,
                            m.aliases_json, m.language_hints_json, m.confidence, m.status,
                            m.privacy_domain, m.sensitivity, m.metadata_json, m.created_at,
                            m.updated_at, m.last_seen_at, m.supersedes_json,
                            m.superseded_by, m.correction_of
                     from memories m
                     where m.user_id = ?1 and m.workspace_id = ?2
                       and not exists (
                           select 1 from tombstones t
                           where t.ref = m.ref
                             and t.user_id = m.user_id
                             and t.workspace_id = m.workspace_id
                       )
                     order by m.ref",
                )
                .map_err(|error| error.to_string())?;
            let mut insert_statement = conn
                .prepare(
                    "insert into temp.authorized_memory_search_fts (ref, text)
                     values (?1, ?2)",
                )
                .map_err(|error| error.to_string())?;
            let mut rows = records_statement
                .query((user_id.as_str(), workspace_id.as_str()))
                .map_err(|error| error.to_string())?;
            while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                let memory = memory_from_row(row)?;
                if !allows(&memory) {
                    continue;
                }
                insert_statement
                    .execute((memory.reference.to_string(), memory.text))
                    .map_err(|error| error.to_string())?;
            }
            drop(rows);
            drop(insert_statement);
            drop(records_statement);

            let total = conn
                .query_row(
                    "select count(*)
                     from temp.authorized_memory_search_fts
                     where authorized_memory_search_fts match ?1",
                    [fts.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())?;
            let total = usize::try_from(total).map_err(|error| error.to_string())?;
            let mut search_statement = conn
                .prepare(
                    "select ref
                     from temp.authorized_memory_search_fts
                     where authorized_memory_search_fts match ?1
                     order by bm25(authorized_memory_search_fts), text, ref
                     limit ?2 offset ?3",
                )
                .map_err(|error| error.to_string())?;
            let mut search_rows = search_statement
                .query((fts.as_str(), limit, offset))
                .map_err(|error| error.to_string())?;
            let mut refs = Vec::new();
            while let Some(row) = search_rows.next().map_err(|error| error.to_string())? {
                refs.push(parse_ref(
                    row.get::<_, String>(0).map_err(|error| error.to_string())?,
                )?);
            }
            Ok((refs, total))
        };

        let result = run();
        let cleanup = conn
            .execute("delete from temp.authorized_memory_search_fts", [])
            .map(|_| ())
            .map_err(|error| error.to_string());
        match (result, cleanup) {
            (Ok(page), Ok(())) => Ok(page),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
        }
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
    fn upsert_entity_on(&self, conn: &Connection, entity: &MemoryEntity) -> Result<(), String> {
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

    pub(crate) fn get_visible_entity_exact(
        &self,
        reference: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Option<MemoryEntity>, String> {
        if reference.user_id != *user_id || reference.workspace_id != *workspace_id {
            return Ok(None);
        }
        let conn = self.read_conn();
        query_optional(
            &conn,
            "select e.ref, e.user_id, e.workspace_id, e.entity_type, e.name,
                    e.canonical_key, e.aliases_json, e.privacy_domain, e.sensitivity,
                    e.metadata_json
             from entities e
             where e.ref = ?1 and e.user_id = ?2 and e.workspace_id = ?3
               and not exists (
                   select 1 from tombstones t
                   where t.ref = e.ref
                     and t.user_id = e.user_id
                     and t.workspace_id = e.workspace_id
               )",
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

    /// Linked-recall relation read with tombstone visibility in the same SQL
    /// statement/snapshot as the relation rows.
    pub(crate) fn visible_relations_for_exact(
        &self,
        source_ref: &MemoryRef,
        user_id: &UserId,
        workspace_id: &WorkspaceId,
    ) -> Result<Vec<MemoryRelation>, String> {
        if source_ref.user_id != *user_id || source_ref.workspace_id != *workspace_id {
            return Ok(Vec::new());
        }
        let conn = self.read_conn();
        let mut statement = conn
            .prepare(
                "select r.ref, r.user_id, r.workspace_id, r.source_ref, r.relation_type,
                        r.target_ref, r.confidence, r.privacy_domain, r.sensitivity,
                        r.evidence_json, r.metadata_json
                 from relations r
                 where r.source_ref = ?1 and r.user_id = ?2 and r.workspace_id = ?3
                   and not exists (
                       select 1 from tombstones t
                       where t.ref = r.ref
                         and t.user_id = r.user_id
                         and t.workspace_id = r.workspace_id
                   )
                 order by r.ref",
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
                serde_json::to_string(&routine.schedule_hint).map_err(|error| error.to_string())?,
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
        let mut conn = self.write_conn();
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
                );

                create table if not exists memory_source_grants (
                    id text primary key,
                    consumer_user_id text not null,
                    consumer_workspace_id text not null,
                    source_user_id text not null,
                    source_workspace_id text not null,
                    max_sensitivity text not null,
                    expires_at integer,
                    revoked_at integer,
                    policy_version integer not null check(
                        typeof(policy_version) = 'integer'
                        and policy_version >= 1
                        and policy_version <= 9223372036854775807
                    ),
                    created_by text not null,
                    created_at text not null,
                    updated_at text not null
                );
                create index if not exists idx_memory_source_grants_consumer
                    on memory_source_grants(consumer_user_id, consumer_workspace_id, revoked_at);

                create table if not exists memory_source_grant_collections (
                    grant_id text not null references memory_source_grants(id) on delete cascade,
                    collection_key text not null,
                    primary key(grant_id, collection_key)
                );

                create table if not exists memory_source_grant_overrides (
                    grant_id text not null references memory_source_grants(id) on delete cascade,
                    memory_ref text not null,
                    effect text not null check(effect in ('allow', 'deny')),
                    primary key(grant_id, memory_ref)
                );

                create table if not exists memory_source_access_events (
                    id text primary key,
                    consumer_user_id text not null,
                    consumer_workspace_id text not null,
                    source_workspace_id text not null,
                    grant_id text,
                    policy_version integer not null,
                    turn_id text,
                    outcome text not null check(outcome in ('allow', 'deny', 'degraded')),
                    reason text not null,
                    candidate_count integer not null check(candidate_count >= 0),
                    injected_refs_json text not null,
                    created_at integer not null
                );
                create index if not exists idx_memory_source_access_consumer
                    on memory_source_access_events(
                        consumer_user_id, consumer_workspace_id, created_at
                    );
                create index if not exists idx_memory_source_access_grant
                    on memory_source_access_events(grant_id, created_at);

                create table if not exists memory_publication_proposals (
                    id text primary key,
                    proposal_version integer not null default 1 check(proposal_version >= 1),
                    source_ref_json text not null,
                    source_user_id text not null,
                    source_workspace_id text not null,
                    destination_user_id text not null,
                    destination_workspace_id text not null,
                    proposed_text text not null,
                    proposed_memory_type text not null,
                    proposed_collection text not null,
                    proposed_privacy_domain text not null,
                    proposed_sensitivity text not null,
                    source_revision text not null default 'legacy_unverifiable',
                    candidate_json text,
                    resolution_json text,
                    status text not null check(status in ('pending', 'approved', 'rejected', 'failed')),
                    reason_code text not null,
                    failure_reason text,
                    proposed_by text not null,
                    decided_by text,
                    created_at text not null,
                    updated_at text not null
                );
                create index if not exists idx_memory_publication_proposals_source
                    on memory_publication_proposals(source_ref_json, status);

                create table if not exists memory_publication_links (
                    source_ref_json text primary key,
                    destination_ref_json text not null,
                    approved_by text not null,
                    created_at text not null
                );
                create unique index if not exists idx_memory_publication_links_destination_source
                    on memory_publication_links(destination_ref_json, source_ref_json);",
            )
            .map_err(|error| error.to_string())?;
        // I sub-helper (ensure_column, rebuild) ricevono questa stessa connection
        // (lock unico su writer) — evita di riprendere il Mutex e fare deadlock.
        Self::install_memory_source_active_index_on(&mut conn)?;
        let legacy_publication_collection_missing = !Self::table_has_column_on(
            &conn,
            "memory_publication_proposals",
            "proposed_collection",
        )?;
        self.ensure_column_on(
            &conn,
            "memories",
            "created_at",
            "alter table memories add column created_at text not null default ''",
        )?;
        self.ensure_column_on(
            &conn,
            "memories",
            "updated_at",
            "alter table memories add column updated_at text not null default ''",
        )?;
        self.ensure_column_on(
            &conn,
            "memories",
            "last_seen_at",
            "alter table memories add column last_seen_at text",
        )?;
        self.ensure_column_on(
            &conn,
            "memories",
            "supersedes_json",
            "alter table memories add column supersedes_json text not null default '[]'",
        )?;
        self.ensure_column_on(
            &conn,
            "memories",
            "superseded_by",
            "alter table memories add column superseded_by text",
        )?;
        self.ensure_column_on(
            &conn,
            "memories",
            "correction_of",
            "alter table memories add column correction_of text",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "proposed_collection",
            "alter table memory_publication_proposals add column proposed_collection text not null default 'knowledge'",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "candidate_json",
            "alter table memory_publication_proposals add column candidate_json text",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "resolution_json",
            "alter table memory_publication_proposals add column resolution_json text",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "reason_code",
            "alter table memory_publication_proposals add column reason_code text not null default 'pending'",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "failure_reason",
            "alter table memory_publication_proposals add column failure_reason text",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "source_revision",
            "alter table memory_publication_proposals add column source_revision text not null default 'legacy_unverifiable'",
        )?;
        self.ensure_column_on(
            &conn,
            "memory_publication_proposals",
            "proposal_version",
            "alter table memory_publication_proposals add column proposal_version integer not null default 1",
        )?;
        conn.execute(
            "update memory_publication_proposals
             set proposal_version = 1
             where proposal_version is null or proposal_version < 1",
            [],
        )
        .map_err(|error| error.to_string())?;
        Self::backfill_legacy_publication_proposals_on(
            &mut conn,
            legacy_publication_collection_missing,
        )?;
        Self::fail_closed_legacy_pending_publications_on(&mut conn)?;
        conn.execute(
            "insert or replace into schema_metadata (key, value) values ('schema_version', ?1)",
            [SCHEMA_VERSION.to_string()],
        )
        .map_err(|error| error.to_string())?;
        self.rebuild_memory_search_index_on(&conn)?;
        Ok(())
    }

    fn install_memory_source_active_index_on(conn: &mut Connection) -> Result<(), String> {
        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let has_legacy_duplicates = transaction
            .query_row(
                "select exists(
                    select 1 from memory_source_grants
                    where revoked_at is null
                    group by consumer_user_id, consumer_workspace_id,
                             source_user_id, source_workspace_id
                    having count(*) > 1
                    limit 1
                 )",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;

        // Pre-index v4 databases may contain ambiguous links. Preserve their
        // history and defer the index until a scoped revoke resolves the conflict;
        // the resolver remains fail-closed while duplicates exist.
        if !has_legacy_duplicates {
            transaction
                .execute(
                    "create unique index if not exists idx_memory_source_grants_active_source
                     on memory_source_grants(
                         consumer_user_id, consumer_workspace_id,
                         source_user_id, source_workspace_id
                     ) where revoked_at is null",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }

        transaction.commit().map_err(|error| error.to_string())
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

    fn table_has_column_on(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
        let mut statement = conn
            .prepare(&format!("pragma table_info({table})"))
            .map_err(|error| error.to_string())?;
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            if row.get::<_, String>(1).map_err(|error| error.to_string())? == column {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Old v4 publication tables did not persist typed candidate/resolution or
    /// terminal reason fields. Migrate them exactly once; malformed legacy refs
    /// are deliberately preserved as malformed candidate JSON so later reads
    /// fail closed instead of silently widening publication behavior.
    fn backfill_legacy_publication_proposals_on(
        conn: &mut Connection,
        legacy_publication_collection_missing: bool,
    ) -> Result<(), String> {
        let already_backfilled = conn
            .query_row(
                "select exists(
                    select 1 from schema_metadata
                    where key = 'memory_publication_proposal_backfill_v2'
                 )",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())?;
        if already_backfilled {
            return Ok(());
        }
        let has_legacy_duplicate =
            Self::table_has_column_on(conn, "memory_publication_proposals", "duplicate_ref_json")?;
        if !has_legacy_duplicate {
            conn.execute(
                "insert into schema_metadata(key, value)
                 values ('memory_publication_proposal_backfill_v2', 'not_needed')",
                [],
            )
            .map_err(|error| error.to_string())?;
            return Ok(());
        }

        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let rows = {
            let mut statement = transaction
                .prepare(
                    "select id, status, proposed_memory_type, duplicate_ref_json
                     from memory_publication_proposals order by id",
                )
                .map_err(|error| error.to_string())?;
            let mut rows = statement.query([]).map_err(|error| error.to_string())?;
            let mut values = Vec::new();
            while let Some(row) = rows.next().map_err(|error| error.to_string())? {
                values.push((
                    row.get::<_, String>(0).map_err(|error| error.to_string())?,
                    row.get::<_, String>(1).map_err(|error| error.to_string())?,
                    row.get::<_, String>(2).map_err(|error| error.to_string())?,
                    row.get::<_, Option<String>>(3)
                        .map_err(|error| error.to_string())?,
                ));
            }
            values
        };
        for (id, status, proposed_memory_type, duplicate_ref_json) in rows {
            let proposed_collection = legacy_publication_collection_missing.then(|| {
                MemoryCollectionKey::from_legacy_memory_type(&proposed_memory_type)
                    .and_then(|collection| enum_name(&collection).ok())
                    .unwrap_or_else(|| match proposed_memory_type.as_str() {
                        // A legacy fact has no metadata to distinguish Profile
                        // from Knowledge, so it must not be guessed.
                        "fact" => "legacy_ambiguous_collection".to_string(),
                        // Unknown legacy types must make this row unreadable
                        // instead of silently treating it as generic knowledge.
                        _ => "legacy_unknown".to_string(),
                    })
            });
            let (candidate_json, reason_code, failure_reason) = match status.as_str() {
                "approved" => (None, "approved", None),
                "rejected" => (None, "rejected", None),
                "failed" => (None, "publication_failed", Some("legacy_failure")),
                "pending" => match duplicate_ref_json {
                    Some(raw) => match serde_json::from_str::<MemoryRef>(&raw) {
                        Ok(destination_ref) => (
                            Some(
                                serde_json::to_string(
                                    &MemoryPublicationCandidate::CompatibleDuplicate {
                                        destination_ref,
                                    },
                                )
                                .map_err(|error| error.to_string())?,
                            ),
                            "publication_duplicate_compatible",
                            None,
                        ),
                        Err(_) => (Some(raw), "publication_duplicate_compatible", None),
                    },
                    None => (None, "pending", None),
                },
                _ => (None, "pending", None),
            };
            transaction
                .execute(
                    "update memory_publication_proposals
                     set proposed_collection = case when ?2 then ?3 else proposed_collection end,
                         candidate_json = ?4, resolution_json = null, reason_code = ?5,
                         failure_reason = ?6
                     where id = ?1",
                    params![
                        id,
                        legacy_publication_collection_missing,
                        proposed_collection,
                        candidate_json,
                        reason_code,
                        failure_reason
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute(
                "insert into schema_metadata(key, value)
                 values ('memory_publication_proposal_backfill_v2', 'complete')",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())
    }

    /// A pre-revision pending proposal cannot prove that the source seen in its
    /// preview is still the source approved later. Preserve it for audit, but
    /// require the user to create a fresh proposal instead of guessing.
    fn fail_closed_legacy_pending_publications_on(conn: &mut Connection) -> Result<(), String> {
        conn.execute(
            "update memory_publication_proposals
             set status = 'failed', reason_code = 'publication_failed',
                 failure_reason = 'publication_source_changed',
                 decided_by = coalesce(decided_by, proposed_by),
                 updated_at = updated_at
             where status = 'pending' and source_revision = 'legacy_unverifiable'",
            [],
        )
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

/// Exact record visibility check on an already-owned connection. Publication
/// commit uses this after taking its IMMEDIATE transaction, avoiding a second
/// mutex acquisition and keeping the tombstone check in the same snapshot.
fn visible_memory_exact_on(
    conn: &Connection,
    reference: &MemoryRef,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) -> Result<Option<MemoryRecord>, String> {
    query_optional(
        conn,
        "select m.ref, m.user_id, m.workspace_id, m.memory_type, m.text, m.aliases_json,
                m.language_hints_json, m.confidence, m.status, m.privacy_domain,
                m.sensitivity, m.metadata_json, m.created_at, m.updated_at,
                m.last_seen_at, m.supersedes_json, m.superseded_by, m.correction_of
         from memories m
         where m.ref = ?1 and m.user_id = ?2 and m.workspace_id = ?3
           and not exists (
               select 1 from tombstones t
               where t.ref = m.ref
                 and t.user_id = m.user_id
                 and t.workspace_id = m.workspace_id
           )",
        (
            reference.to_string(),
            user_id.as_str().to_string(),
            workspace_id.as_str().to_string(),
        ),
        memory_from_row,
    )
}

/// A deterministic, full-scope destination snapshot. This intentionally
/// compares more than the selected candidate: any concurrent insert, update,
/// or tombstone in the destination scope invalidates the approval preview.
fn visible_memories_in_scope_on(
    conn: &Connection,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
) -> Result<Vec<MemoryRecord>, String> {
    let mut statement = conn
        .prepare(
            "select m.ref, m.user_id, m.workspace_id, m.memory_type, m.text, m.aliases_json,
                    m.language_hints_json, m.confidence, m.status, m.privacy_domain,
                    m.sensitivity, m.metadata_json, m.created_at, m.updated_at,
                    m.last_seen_at, m.supersedes_json, m.superseded_by, m.correction_of
             from memories m
             where m.user_id = ?1 and m.workspace_id = ?2
               and not exists (
                   select 1 from tombstones t
                   where t.ref = m.ref
                     and t.user_id = m.user_id
                     and t.workspace_id = m.workspace_id
               )
             order by m.ref",
        )
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query((user_id.as_str(), workspace_id.as_str()))
        .map_err(|error| error.to_string())?;
    let mut memories = Vec::new();
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        memories.push(memory_from_row(row)?);
    }
    Ok(memories)
}

fn evidence_for_on(
    conn: &Connection,
    memory_ref: &MemoryRef,
) -> Result<Vec<MemoryEvidence>, String> {
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
            evidence_ref: parse_ref(row.get::<_, String>(1).map_err(|error| error.to_string())?)?,
            note: row.get(2).map_err(|error| error.to_string())?,
        });
    }
    Ok(evidence)
}

/// Writes a memory through an already-open SQLite connection. Callers that own a
/// transaction (publication) use this instead of re-entering `upsert_memory` and
/// taking the writer mutex recursively.
fn upsert_memory_on(conn: &Connection, memory: &MemoryRecord) -> Result<(), String> {
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
            serde_json::to_string(&memory.language_hints).map_err(|error| error.to_string())?,
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
    Ok(())
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

fn memory_source_access_from_row(row: &Row<'_>) -> Result<MemorySourceAccessEvent, String> {
    let outcome = match row
        .get::<_, String>(7)
        .map_err(|error| error.to_string())?
        .as_str()
    {
        "allow" => MemorySourceAccessOutcome::Allow,
        "deny" => MemorySourceAccessOutcome::Deny,
        "degraded" => MemorySourceAccessOutcome::Degraded,
        value => return Err(format!("unknown memory source access outcome: {value}")),
    };
    Ok(MemorySourceAccessEvent {
        id: row.get(0).map_err(|error| error.to_string())?,
        consumer_user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        consumer_workspace_id: WorkspaceId::new(
            row.get::<_, String>(2).map_err(|error| error.to_string())?,
        ),
        source_workspace_id: WorkspaceId::new(
            row.get::<_, String>(3).map_err(|error| error.to_string())?,
        ),
        grant_id: row.get(4).map_err(|error| error.to_string())?,
        policy_version: u64::try_from(row.get::<_, i64>(5).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
        turn_id: row.get(6).map_err(|error| error.to_string())?,
        outcome,
        reason: row.get(8).map_err(|error| error.to_string())?,
        candidate_count: usize::try_from(row.get::<_, i64>(9).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
        injected_refs: serde_json::from_str(
            &row.get::<_, String>(10)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?,
        created_at: row.get(11).map_err(|error| error.to_string())?,
    })
}

fn publication_ref_json(reference: &MemoryRef) -> Result<String, String> {
    serde_json::to_string(reference).map_err(|error| error.to_string())
}

fn publication_ref_from_json(value: String) -> Result<MemoryRef, String> {
    serde_json::from_str(&value).map_err(|error| error.to_string())
}

fn validate_memory_publication_proposal(
    proposal: &MemoryPublicationProposal,
) -> Result<(), String> {
    if proposal.id.trim().is_empty()
        || proposal.proposal_version == 0
        || proposal.proposed_by.trim().is_empty()
        || proposal.source_user_id.as_str().trim().is_empty()
        || proposal.source_workspace_id.as_str().trim().is_empty()
        || proposal.destination_user_id.as_str().trim().is_empty()
        || proposal.destination_workspace_id.as_str().trim().is_empty()
        || proposal.proposed_text.trim().is_empty()
        || proposal.proposed_memory_type.trim().is_empty()
        || proposal.source_revision.trim().is_empty()
    {
        return Err("publication proposal has an empty required field".to_string());
    }
    if proposal.status != MemoryPublicationStatus::Pending || proposal.decided_by.is_some() {
        return Err("new publication proposal must be pending and undecided".to_string());
    }
    if proposal.source_ref.kind != MemoryRefKind::Memory
        || proposal.source_ref.user_id != proposal.source_user_id
        || proposal.source_ref.workspace_id != proposal.source_workspace_id
    {
        return Err("publication proposal source ref does not match scope".to_string());
    }
    if proposal.proposed_by != proposal.source_user_id.as_str()
        || proposal.source_user_id != proposal.destination_user_id
        || proposal.source_workspace_id == proposal.destination_workspace_id
        || proposal.source_workspace_id.as_str() == THREADS_WORKSPACE
        || proposal.destination_workspace_id.as_str() == THREADS_WORKSPACE
    {
        return Err("publication proposal source and destination are not allowed".to_string());
    }
    if proposal.proposed_sensitivity == DataSensitivity::Secret
        || contains_secret(&serde_json::json!({ "text": proposal.proposed_text }))
    {
        return Err("publication proposal contains a secret payload".to_string());
    }
    if proposal.failure_reason.is_some() {
        return Err("new publication proposal cannot carry a failure reason".to_string());
    }
    validate_publication_candidate_and_resolution(proposal)?;
    Ok(())
}

fn validate_publication_candidate_and_resolution(
    proposal: &MemoryPublicationProposal,
) -> Result<(), String> {
    let candidate_ref = match &proposal.candidate {
        Some(MemoryPublicationCandidate::CompatibleDuplicate { destination_ref })
        | Some(MemoryPublicationCandidate::Conflict { destination_ref }) => Some(destination_ref),
        None => None,
    };
    if let Some(reference) = candidate_ref {
        if reference.kind != MemoryRefKind::Memory
            || reference.user_id != proposal.destination_user_id
            || reference.workspace_id != proposal.destination_workspace_id
        {
            return Err("publication candidate is outside destination".to_string());
        }
    }
    match (&proposal.resolution, candidate_ref) {
        (None, _) => {}
        (Some(MemoryPublicationResolution::CreateNew), _) => {}
        (
            Some(MemoryPublicationResolution::UpdateExisting { destination_ref }),
            Some(candidate_ref),
        ) if destination_ref == candidate_ref
            && destination_ref.kind == MemoryRefKind::Memory
            && destination_ref.user_id == proposal.destination_user_id
            && destination_ref.workspace_id == proposal.destination_workspace_id => {}
        _ => return Err("publication resolution does not match candidate".to_string()),
    }
    Ok(())
}

fn validate_persisted_memory_publication_proposal(
    proposal: &MemoryPublicationProposal,
) -> Result<(), String> {
    let mut intrinsic = proposal.clone();
    intrinsic.status = MemoryPublicationStatus::Pending;
    intrinsic.decided_by = None;
    intrinsic.failure_reason = None;
    // Legacy terminal rows are retained for audit, while legacy pending rows are
    // migrated to Failed. Do not reject a terminal audit row merely because it
    // predates revision tracking.
    if intrinsic.source_revision == "legacy_unverifiable" {
        intrinsic.source_revision = "legacy_terminal".to_string();
    }
    validate_memory_publication_proposal(&intrinsic)?;
    match proposal.status {
        MemoryPublicationStatus::Pending => {
            if proposal.decided_by.is_some() || proposal.failure_reason.is_some() {
                return Err("pending publication has a terminal state payload".to_string());
            }
            if proposal.source_revision == "legacy_unverifiable" {
                return Err("pending publication source revision is unverifiable".to_string());
            }
            let expected = match proposal.candidate {
                Some(MemoryPublicationCandidate::CompatibleDuplicate { .. }) => {
                    MemoryPublicationReasonCode::PublicationDuplicateCompatible
                }
                Some(MemoryPublicationCandidate::Conflict { .. }) => {
                    MemoryPublicationReasonCode::PublicationConflict
                }
                None => MemoryPublicationReasonCode::Pending,
            };
            if proposal.reason_code != expected {
                return Err("pending publication has an invalid reason code".to_string());
            }
        }
        MemoryPublicationStatus::Approved => {
            if proposal
                .decided_by
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
                || proposal.reason_code != MemoryPublicationReasonCode::Approved
                || proposal.failure_reason.is_some()
            {
                return Err("approved publication has an invalid terminal state".to_string());
            }
        }
        MemoryPublicationStatus::Rejected => {
            if proposal
                .decided_by
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
                || proposal.reason_code != MemoryPublicationReasonCode::Rejected
                || proposal.failure_reason.is_some()
            {
                return Err("rejected publication has an invalid terminal state".to_string());
            }
        }
        MemoryPublicationStatus::Failed => {
            if proposal
                .decided_by
                .as_deref()
                .unwrap_or_default()
                .trim()
                .is_empty()
                || proposal.reason_code != MemoryPublicationReasonCode::PublicationFailed
                || proposal
                    .failure_reason
                    .as_deref()
                    .unwrap_or_default()
                    .trim()
                    .is_empty()
            {
                return Err("failed publication has an invalid terminal state".to_string());
            }
        }
    }
    Ok(())
}

fn sanitize_publication_failure_reason(reason: &str) -> &'static str {
    match reason {
        "publication_conflict" => "publication_conflict",
        "publication_source_not_found" => "publication_source_not_found",
        "publication_source_changed" => "publication_source_changed",
        "publication_duplicate_changed" => "publication_duplicate_changed",
        "secret_never_shareable" => "secret_never_shareable",
        "vault_payload_never_shareable" => "vault_payload_never_shareable",
        "publication_not_pending" => "publication_not_pending",
        _ => "publication_failed",
    }
}

fn memory_publication_proposal_from_row(
    row: &Row<'_>,
) -> Result<MemoryPublicationProposal, String> {
    Ok(MemoryPublicationProposal {
        id: row.get(0).map_err(|error| error.to_string())?,
        proposal_version: row.get(1).map_err(|error| error.to_string())?,
        source_ref: publication_ref_from_json(row.get(2).map_err(|error| error.to_string())?)?,
        source_user_id: UserId::new(row.get::<_, String>(3).map_err(|error| error.to_string())?),
        source_workspace_id: WorkspaceId::new(
            row.get::<_, String>(4).map_err(|error| error.to_string())?,
        ),
        destination_user_id: UserId::new(
            row.get::<_, String>(5).map_err(|error| error.to_string())?,
        ),
        destination_workspace_id: WorkspaceId::new(
            row.get::<_, String>(6).map_err(|error| error.to_string())?,
        ),
        proposed_text: row.get(7).map_err(|error| error.to_string())?,
        proposed_memory_type: row.get(8).map_err(|error| error.to_string())?,
        proposed_collection: enum_from_name(
            row.get::<_, String>(9).map_err(|error| error.to_string())?,
        )?,
        proposed_privacy_domain: PrivacyDomain::new(
            row.get::<_, String>(10)
                .map_err(|error| error.to_string())?,
        ),
        proposed_sensitivity: enum_from_name(
            row.get::<_, String>(11)
                .map_err(|error| error.to_string())?,
        )?,
        source_revision: row.get(12).map_err(|error| error.to_string())?,
        candidate: row
            .get::<_, Option<String>>(13)
            .map_err(|error| error.to_string())?
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()?,
        resolution: row
            .get::<_, Option<String>>(14)
            .map_err(|error| error.to_string())?
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()?,
        status: enum_from_name(
            row.get::<_, String>(15)
                .map_err(|error| error.to_string())?,
        )?,
        reason_code: enum_from_name(
            row.get::<_, String>(16)
                .map_err(|error| error.to_string())?,
        )?,
        failure_reason: row.get(17).map_err(|error| error.to_string())?,
        proposed_by: row.get(18).map_err(|error| error.to_string())?,
        decided_by: row.get(19).map_err(|error| error.to_string())?,
        created_at: row.get(20).map_err(|error| error.to_string())?,
        updated_at: row.get(21).map_err(|error| error.to_string())?,
    })
}

fn memory_publication_link_from_row(row: &Row<'_>) -> Result<MemoryPublicationLink, String> {
    Ok(MemoryPublicationLink {
        source_ref: publication_ref_from_json(row.get(0).map_err(|error| error.to_string())?)?,
        destination_ref: publication_ref_from_json(row.get(1).map_err(|error| error.to_string())?)?,
        approved_by: row.get(2).map_err(|error| error.to_string())?,
        created_at: row.get(3).map_err(|error| error.to_string())?,
    })
}

fn load_memory_publication_proposal_on(
    conn: &Connection,
    id: &str,
) -> MemoryPublicationStoreResult<Option<MemoryPublicationProposal>> {
    let proposal = query_optional(
        conn,
        "select id, proposal_version, source_ref_json, source_user_id, source_workspace_id,
                    destination_user_id, destination_workspace_id, proposed_text,
                    proposed_memory_type, proposed_collection, proposed_privacy_domain,
                    proposed_sensitivity, source_revision, candidate_json, resolution_json, status, reason_code,
                    failure_reason, proposed_by, decided_by, created_at, updated_at
         from memory_publication_proposals where id = ?1",
        [id],
        memory_publication_proposal_from_row,
    )
    .map_err(MemoryPublicationStoreError::store)?;
    if let Some(proposal) = &proposal {
        validate_persisted_memory_publication_proposal(proposal)
            .map_err(MemoryPublicationStoreError::store)?;
    }
    Ok(proposal)
}

fn memory_source_grant_base_from_row(row: &Row<'_>) -> Result<MemorySourceGrant, String> {
    Ok(MemorySourceGrant {
        id: row.get(0).map_err(|error| error.to_string())?,
        consumer_user_id: UserId::new(row.get::<_, String>(1).map_err(|error| error.to_string())?),
        consumer_workspace_id: WorkspaceId::new(
            row.get::<_, String>(2).map_err(|error| error.to_string())?,
        ),
        source_user_id: UserId::new(row.get::<_, String>(3).map_err(|error| error.to_string())?),
        source_workspace_id: WorkspaceId::new(
            row.get::<_, String>(4).map_err(|error| error.to_string())?,
        ),
        collections: BTreeSet::new(),
        max_sensitivity: enum_from_name(
            row.get::<_, String>(5).map_err(|error| error.to_string())?,
        )?,
        overrides: HashMap::new(),
        expires_at: row.get(6).map_err(|error| error.to_string())?,
        revoked_at: row.get(7).map_err(|error| error.to_string())?,
        policy_version: u64::try_from(row.get::<_, i64>(8).map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?,
        created_by: row.get(9).map_err(|error| error.to_string())?,
        created_at: row.get(10).map_err(|error| error.to_string())?,
        updated_at: row.get(11).map_err(|error| error.to_string())?,
    })
}

fn load_memory_source_grant_children(
    conn: &Connection,
    grant: &mut MemorySourceGrant,
) -> Result<(), String> {
    let mut collection_statement = conn
        .prepare(
            "select collection_key from memory_source_grant_collections
             where grant_id = ?1 order by collection_key",
        )
        .map_err(|error| error.to_string())?;
    let mut collection_rows = collection_statement
        .query([grant.id.as_str()])
        .map_err(|error| error.to_string())?;
    while let Some(row) = collection_rows.next().map_err(|error| error.to_string())? {
        let collection =
            enum_from_name(row.get::<_, String>(0).map_err(|error| error.to_string())?)?;
        if !grant.collections.insert(collection) {
            return Err(format!(
                "duplicate collection for memory source grant {}",
                grant.id
            ));
        }
    }
    drop(collection_rows);
    drop(collection_statement);

    let mut override_statement = conn
        .prepare(
            "select memory_ref, effect from memory_source_grant_overrides
             where grant_id = ?1 order by memory_ref",
        )
        .map_err(|error| error.to_string())?;
    let mut override_rows = override_statement
        .query([grant.id.as_str()])
        .map_err(|error| error.to_string())?;
    while let Some(row) = override_rows.next().map_err(|error| error.to_string())? {
        let reference_json: String = row.get(0).map_err(|error| error.to_string())?;
        let reference = serde_json::from_str(&reference_json).map_err(|error| error.to_string())?;
        let effect = enum_from_name(row.get::<_, String>(1).map_err(|error| error.to_string())?)?;
        if grant.overrides.insert(reference, effect).is_some() {
            return Err(format!(
                "duplicate override reference for memory source grant {}",
                grant.id
            ));
        }
    }
    Ok(())
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

#[cfg(test)]
mod connection_pragma_tests {
    use super::{Connections, SQLiteMemoryStore};

    fn assert_foreign_key_constraint_is_enforced(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "create table fk_parent_for_test (id integer primary key);
             create table fk_child_for_test (
                parent_id integer not null references fk_parent_for_test(id)
             );",
        )
        .unwrap();
        assert!(
            conn.execute("insert into fk_child_for_test (parent_id) values (999)", [],)
                .is_err(),
            "orphan child insert must be rejected"
        );
    }

    #[test]
    fn in_memory_single_connection_enforces_foreign_keys() {
        let store = SQLiteMemoryStore::open_in_memory().unwrap();
        assert!(matches!(&store.conns, Connections::Single(_)));
        let conn = store.write_conn();
        assert_foreign_key_constraint_is_enforced(&conn);
    }

    #[test]
    fn file_backed_pooled_writer_and_reader_enforce_foreign_keys() {
        let path = std::env::temp_dir().join(format!(
            "local-first-memory-fk-pool-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let store = SQLiteMemoryStore::open(&path).unwrap();
        assert!(matches!(&store.conns, Connections::Pooled { .. }));
        {
            let writer = store.write_conn();
            assert_foreign_key_constraint_is_enforced(&writer);
        }
        {
            let reader = store.read_conn();
            assert_eq!(
                reader
                    .query_row("pragma foreign_keys", [], |row| row.get::<_, i64>(0))
                    .unwrap(),
                1
            );
        }
        drop(store);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }
}
