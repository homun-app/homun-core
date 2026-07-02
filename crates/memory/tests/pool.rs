//! ADR 0022 (Tappa 2) — test del pool reader/writer WAL.
//!
//! WAL richiede un DB su disco (l'in-memory di SQLite non è condivisibile tra
//! connection), quindi questi test usano tempfile unici. Il flag `HOMUN_MEMORY_POOL`
//! è letto nel costruttore: i test lo settano/ripristinano con una guard.
//!
//! 1. Parità single-vs-pool (read, FTS search, embeddings).
//! 2. Concorrenza WAL (read concorrenti via reader pool mentre si scrive).
//! 3. `import_graphify_batch` in pool (transazione su writer senza deadlock).

use local_first_memory::{
    DataSensitivity, MemoryEntity, MemoryFacade, MemoryRecord, MemoryRef, MemoryRefKind,
    MemoryRelation, MemoryStatus, PrivacyDomain, SQLiteMemoryStore, UserId, WorkspaceId,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

/// Guard che setta `HOMUN_MEMORY_POOL=on` e al drop ripristina il valore
/// precedente. SAFETY: test isolato con tempfile unico; cargo serializza i
/// binari di test per crate, quindi nessun altro test del memory crate legge
/// questo flag in parallelo.
struct PoolFlag {
    prev: Option<String>,
}

impl PoolFlag {
    fn on() -> Self {
        let prev = std::env::var("HOMUN_MEMORY_POOL").ok();
        unsafe {
            std::env::set_var("HOMUN_MEMORY_POOL", "on");
        }
        Self { prev }
    }
}

impl Drop for PoolFlag {
    fn drop(&mut self) {
        unsafe {
            match &self.prev {
                Some(value) => std::env::set_var("HOMUN_MEMORY_POOL", value),
                None => std::env::remove_var("HOMUN_MEMORY_POOL"),
            }
        }
    }
}

fn temp_db(prefix: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "homun-pool-{prefix}-{}.sqlite",
        uuid::Uuid::new_v4().simple()
    ))
}

fn sample_memory(user: &UserId, ws: &WorkspaceId, text: &str) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::generated(MemoryRefKind::Memory, user.clone(), ws.clone()),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        memory_type: "fact".to_string(),
        text: text.to_string(),
        aliases: vec![],
        language_hints: vec![],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("general"),
        sensitivity: DataSensitivity::Public,
        metadata: serde_json::json!({}),
        created_at: "2026-07-01T00:00:00Z".to_string(),
        updated_at: "2026-07-01T00:00:00Z".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

/// Parità: conteggi e FTS search identici in Single e Pooled per lo stesso dataset.
#[test]
fn pool_and_single_produce_same_reads_and_fts() {
    let user = UserId::new("parity-user");
    let ws = WorkspaceId::new("proj-parity");

    // Single mode (flag OFF, default): write 2 memorie poi leggi sullo stesso store.
    let single_path = temp_db("single");
    let single_store = SQLiteMemoryStore::open(&single_path).unwrap();
    single_store
        .upsert_memory(&sample_memory(&user, &ws, "La decisione sul DB è Postgres"))
        .unwrap();
    single_store
        .upsert_memory(&sample_memory(&user, &ws, "Il preventivo Rossi è aperto"))
        .unwrap();
    let single_count = single_store.list_memories(&user, &ws).unwrap().len();
    let single_refs = single_store
        .search_memory_refs(&user, &ws, "preventivo")
        .unwrap();
    drop(single_store);

    // Pooled mode (flag ON).
    let _flag = PoolFlag::on();
    let pool_path = temp_db("pooled");
    {
        let store = SQLiteMemoryStore::open(&pool_path).unwrap();
        store
            .upsert_memory(&sample_memory(&user, &ws, "La decisione sul DB è Postgres"))
            .unwrap();
        store
            .upsert_memory(&sample_memory(&user, &ws, "Il preventivo Rossi è aperto"))
            .unwrap();
    }
    let pool_store = SQLiteMemoryStore::open(&pool_path).unwrap();
    let pool_count = pool_store.list_memories(&user, &ws).unwrap().len();
    let pool_refs = pool_store
        .search_memory_refs(&user, &ws, "preventivo")
        .unwrap();

    assert_eq!(single_count, pool_count, "stesso numero di memorie in single e pool");
    // I ref FTS non sono confrontabili per identità (MemoryRef::generated usa UUID
    // randomici per store indipendenti): la parità è sul NUMERO di hit FTS.
    assert_eq!(
        single_refs.len(),
        pool_refs.len(),
        "stesso numero di ref FTS in single e pool"
    );
    assert!(!pool_refs.is_empty(), "la FTS search deve trovare il preventivo");
}

/// Concorrenza WAL: N thread leggono (via reader pool del facade) mentre 1
/// thread scrive. Il facade è Send+Sync (i suoi Mutex proteggono il pool), così
/// può essere condiviso tra thread. Nessun deadlock, nessun panic, stato finale
/// coerente (21 memorie = seed + 20).
#[test]
fn pool_concurrent_reads_do_not_block_writer_and_stay_consistent() {
    let _flag = PoolFlag::on();
    let path = temp_db("concurrent");
    let user = UserId::new("concurrent-user");
    let ws = WorkspaceId::new("proj-concurrent");

    let facade = std::sync::Arc::new(MemoryFacade::new(
        SQLiteMemoryStore::open(&path).unwrap(),
    ));
    // Seed iniziale.
    facade
        .upsert_memory(&sample_memory(&user, &ws, "stato iniziale"))
        .unwrap();

    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let read_count = std::sync::Arc::new(AtomicUsize::new(0));

    let mut handles = Vec::new();
    // 4 reader thread: leggono via il reader pool del facade (non bloccano il writer).
    for _ in 0..4 {
        let facade = facade.clone();
        let stop = stop.clone();
        let errors = errors.clone();
        let read_count = read_count.clone();
        let user = user.clone();
        let ws = ws.clone();
        handles.push(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match facade.list_memories_for_ui(&user, &ws) {
                    Ok(_) => {
                        read_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => errors.lock().unwrap().push(format!("read error: {e}")),
                }
            }
        }));
    }

    // 1 writer thread: 20 scritture.
    let facade_w = facade.clone();
    let errors_w = errors.clone();
    let user_w = user.clone();
    let ws_w = ws.clone();
    let writer = std::thread::spawn(move || {
        for i in 0..20 {
            if let Err(e) =
                facade_w.upsert_memory(&sample_memory(&user_w, &ws_w, &format!("write #{i}")))
            {
                errors_w.lock().unwrap().push(format!("write error: {e}"));
            }
        }
    });

    writer.join().expect("writer thread panicked");
    stop.store(true, Ordering::Relaxed);
    for handle in handles {
        handle.join().expect("reader thread panicked");
    }

    let errors = errors.lock().unwrap();
    assert!(errors.is_empty(), "errori durante read/write concorrenti: {errors:?}");
    assert!(
        read_count.load(Ordering::Relaxed) > 0,
        "i reader devono aver completato almeno una lettura"
    );

    // Stato finale: 21 memorie (seed + 20).
    let final_count = facade.list_memories_for_ui(&user, &ws).unwrap().len();
    assert_eq!(final_count, 21, "tutte le scritture devono essere persistite");
}

/// `import_graphify_batch` (BEGIN/COMMIT) in pool mode: gira sulla writer senza
/// deadlock. È il caso ibrido più delicato (transazione + sub-chiamate).
#[test]
fn pool_import_graphify_batch_runs_on_writer_without_deadlock() {
    let _flag = PoolFlag::on();
    let path = temp_db("graphify");
    let user = UserId::new("graph-user");
    let ws = WorkspaceId::new("proj-graph");

    let store = SQLiteMemoryStore::open(&path).unwrap();
    let entity = MemoryEntity {
        reference: MemoryRef::generated(MemoryRefKind::Entity, user.clone(), ws.clone()),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        entity_type: "function".to_string(),
        name: "main".to_string(),
        canonical_key: "fn::main".to_string(),
        aliases: vec![],
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Public,
        metadata: serde_json::json!({}),
    };
    let relation = MemoryRelation {
        reference: MemoryRef::generated(MemoryRefKind::Relation, user.clone(), ws.clone()),
        user_id: user.clone(),
        workspace_id: ws.clone(),
        source_ref: entity.reference.clone(),
        relation_type: "calls".to_string(),
        target_ref: entity.reference.clone(),
        confidence: 1.0,
        privacy_domain: PrivacyDomain::new("work"),
        sensitivity: DataSensitivity::Public,
        evidence: vec![],
        metadata: serde_json::json!({}),
    };

    // Deve completare (non deadlockare) e riportare i conteggi.
    let (ents, rels) = store
        .import_graphify_batch(&user, &ws, &[entity], &[relation])
        .expect("import_graphify_batch non deve deadlockare in pool mode");
    assert_eq!(ents, 1);
    assert_eq!(rels, 1);

    // La read post-import vede l'entità (via reader pool).
    let found = store.list_entities(&user, &ws).unwrap();
    assert_eq!(found.len(), 1, "l'entità importata deve essere leggibile");
}

/// Embeddings roundtrip in pool mode: upsert + search.
#[test]
fn pool_embeddings_upsert_and_search_roundtrip() {
    let _flag = PoolFlag::on();
    let path = temp_db("embeddings");
    let user = UserId::new("embed-user");
    let ws = WorkspaceId::new("proj-embed");
    let store = SQLiteMemoryStore::open(&path).unwrap();

    let r1 = MemoryRef::generated(MemoryRefKind::Memory, user.clone(), ws.clone());
    let r2 = MemoryRef::generated(MemoryRefKind::Memory, user.clone(), ws.clone());
    store
        .upsert_embedding(&r1, &user, &ws, "test", &[0.1, 0.2, 0.3])
        .unwrap();
    store
        .upsert_embedding(&r2, &user, &ws, "test", &[0.9, 0.8, 0.7])
        .unwrap();

    let hits = store
        .search_embeddings(&user, &ws, &[0.95, 0.85, 0.75], 2)
        .unwrap();
    assert_eq!(hits.len(), 2, "search_embeddings deve trovare entrambi i vector");
    // Il più simile alla query [0.95,0.85,0.75] è r2.
    assert_eq!(hits[0].memory_ref, r2);
}
