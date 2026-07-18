# Memory, Vault, and Project Graph Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere verificabile e convergente l'intero ciclo di memoria di Homun: import del grafo progetto senza duplicati, cancellazione completa degli scope, audit Memory/Vault privo di contenuti sensibili, repair esplicito con backup e prove end-to-end su memoria locale, fonti collegate e Vault.

**Architecture:** La normalizzazione Graphify e i controlli di integrità vivono nei crate proprietari dei dati (`memory` e `vault`); il gateway orchestra staging, commit, fingerprint, eventi, cancellazione multi-store e API locali. Ogni import sostituisce la proiezione Graphify in una singola transazione e pubblica gli artefatti solo dopo il commit. L'audit è sempre read-only e restituisce solo conteggi/identificatori tecnici; il repair parte in dry-run, richiede un token legato al report, crea backup consistenti e applica solo azioni nominate.

**Tech Stack:** Rust 2024, rusqlite/SQLite + FTS5, Axum, serde/serde_json, sha2, Graphify sandbox, test Rust seriali per SQLite e gateway.

---

## Vincoli di esecuzione

- Lavorare nel worktree `/Users/fabio/Projects/Homun/app/.worktrees/memory-vault-graph-hardening` sul branch `fabio/memory-vault-graph-hardening`.
- Non toccare né aggiungere al commit `/Users/fabio/Projects/Homun/app/homun-tablet-full.png`.
- Applicare TDD a ogni task: test rosso, implementazione minima, test verde, commit dedicato.
- Non aggiungere trailer `Co-Authored-By`.
- Non introdurre un indice univoco globale sulle relazioni semantiche: identità ed evidenze diverse possono rappresentare relazioni omonime. La convergenza Graphify è garantita da ref deterministiche e replacement transazionale.
- Non modificare automaticamente i database reali durante audit, startup o migrazione.
- Non unire automaticamente memorie semantiche duplicate e non eliminare scope sconosciuti senza una specifica azione approvata.
- Qualunque prova sui dati reali usa prima copie consistenti; l'apply sui file `~/.homun/*.sqlite` è un checkpoint separato che richiede approvazione esplicita.

## Baseline verificata prima dell'implementazione

- `RUST_TEST_THREADS=1 cargo test -p local-first-memory -p local-first-vault -- --test-threads=1`: 238 Memory + 20 Vault passati.
- `cargo test -p local-first-desktop-gateway vault_ -- --test-threads=1`: 29 passati.
- `cargo test -p local-first-desktop-gateway project_graph_ -- --test-threads=1`: 3 passati.
- La baseline ha warning preesistenti, ma nessun fallimento nei percorsi in scope.

## Mappa dei file

### Nuovi file

- `crates/memory/src/integrity.rs` — report read-only, checksum e piano/azioni di repair locale.
- `crates/memory/tests/integrity_audit.rs` — fixture SQLite corrotte e assenza di contenuti nel report.
- `crates/memory/tests/integrity_repair.rs` — dry-run, token, backup e azioni nominate.
- `crates/memory/tests/workspace_purge.rs` — purge transazionale completo e rollback.
- `crates/vault/src/integrity.rs` — report Vault metadata-only e backup consistente.
- `crates/vault/tests/integrity_audit.rs` — orfani, algoritmi, chiavi vietate e no plaintext.
- `crates/desktop-gateway/src/project_graph_commit.rs` — staging/publish del grafo con seam iniettabili per i test.
- `crates/desktop-gateway/src/integrity_api.rs` — DTO puri per audit/preview/apply.

### File modificati

- `crates/memory/src/graphify.rs` — parser/normalizzatore canonico, ref deterministiche e report tipizzato.
- `crates/memory/src/store.rs` — replacement Graphify, audit, repair e purge transazionali.
- `crates/memory/src/facade.rs` — boundary tipizzati e invalidazione delle cache derivate.
- `crates/memory/src/lib.rs` — esporta `integrity`.
- `crates/memory/tests/graphify_adapter.rs` — duplicati, dangling, riordino, checksum e rollback.
- `crates/vault/src/store.rs` — audit/backup senza esporre la connection.
- `crates/vault/src/lib.rs` — esporta `integrity`.
- `crates/desktop-gateway/src/main.rs` — import tipizzato, build fail-closed, route integrity e purge registry-last.
- `crates/desktop-gateway/src/lib.rs` — esporta i moduli puri testabili dal gateway.
- `docs/architecture/memory.md` e `docs/MEMORIA.md` — invarianti, audit e procedura operativa.

## Task 1: Normalizzare il grafo Graphify in modo deterministico

**Files:**
- Modify: `crates/memory/src/graphify.rs`
- Modify: `crates/memory/tests/graphify_adapter.rs`

- [ ] **Step 1: Scrivere i test rossi per duplicati, dangling e ordine**

Aggiungere una fixture con due copie dello stesso nodo, tre copie dello stesso arco, un arco dangling e le stesse entry in ordine inverso:

```rust
#[test]
fn graphify_normalization_collapses_duplicates_and_reports_dangling_links() {
    let graph = serde_json::json!({
        "nodes": [
            {"id":"a","label":"a()","source_file":"src/a.rs"},
            {"id":"a","label":"a()","source_file":"src/a.rs"},
            {"id":"b","label":"b()","source_file":"src/b.rs"}
        ],
        "links": [
            {"source":"a","target":"b","relation":"calls"},
            {"source":"a","target":"b","relation":"calls"},
            {"source":"a","target":"b","relation":"calls"},
            {"source":"a","target":"missing","relation":"calls"}
        ]
    });
    let normalized = normalize_graphify_value(
        &graph,
        &UserId::new("local-user"),
        &WorkspaceId::new("project-a"),
        PrivacyDomain::new("personal"),
        DataSensitivity::Internal,
    ).unwrap();

    assert_eq!(normalized.report.input_nodes, 3);
    assert_eq!(normalized.report.unique_nodes, 2);
    assert_eq!(normalized.report.duplicate_nodes, 1);
    assert_eq!(normalized.report.input_edges, 4);
    assert_eq!(normalized.report.unique_edges, 1);
    assert_eq!(normalized.report.duplicate_edges, 2);
    assert_eq!(normalized.report.dangling_edges, 1);
    assert_eq!(normalized.entities.len(), 2);
    assert_eq!(normalized.relations.len(), 1);
}

#[test]
fn graphify_checksum_and_refs_do_not_depend_on_input_order() {
    let forward = normalize_fixture(false);
    let reversed = normalize_fixture(true);
    assert_eq!(forward.report.checksum, reversed.report.checksum);
    assert_eq!(forward.entities, reversed.entities);
    assert_eq!(forward.relations, reversed.relations);
}
```

- [ ] **Step 2: Eseguire i test e verificare il rosso**

Run: `cargo test -p local-first-memory --test graphify_adapter graphify_normalization -- --nocapture`

Expected: FAIL perché `normalize_graphify_value` e il report non esistono.

- [ ] **Step 3: Introdurre i tipi pubblici e la normalizzazione canonica**

In `graphify.rs` aggiungere:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectGraphImportReport {
    pub input_nodes: usize,
    pub unique_nodes: usize,
    pub duplicate_nodes: usize,
    pub malformed_nodes: usize,
    pub input_edges: usize,
    pub unique_edges: usize,
    pub duplicate_edges: usize,
    pub malformed_edges: usize,
    pub dangling_edges: usize,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectGraphImportError {
    InvalidRoot,
    InvalidJson(String),
    Store(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedProjectGraph {
    pub entities: Vec<MemoryEntity>,
    pub relations: Vec<MemoryRelation>,
    pub report: ProjectGraphImportReport,
}
```

Implementare `normalize_graphify_value` con queste regole:

- `BTreeMap<String, CanonicalNode>` per i nodi; ID vuoto/non-stringa incrementa `malformed_nodes`.
- La ref entità è `MemoryRefKind::Entity` con local id `graphify:node:<sha256(JSON(["code", node_id]))>`; `canonical_key` resta `code:<node_id>`.
- Per duplicati con stesso ID scegliere il candidato con serializzazione canonica lessicograficamente minore, così il risultato non dipende dall'ordine.
- La chiave arco è `(source_id, relation_type, target_id)` in un `BTreeMap`; default relazione `connects`.
- Arco malformato e arco con endpoint assente sono conteggiati e non importati.
- La ref relazione è `graphify:edge:<sha256(JSON([source, relation, target]))>`.
- A parità di chiave arco scegliere il candidato con confidence maggiore, poi metadata canonici lessicograficamente minori.
- Il checksum è SHA-256 della serializzazione JSON delle identità e dei metadata normalizzati già ordinati.
- Nei metadata di ogni record salvare `source="graphify"`; non salvare payload sorgente arbitrari.

- [ ] **Step 4: Rendere `GraphifyImport::import_artifacts` un adapter del normalizzatore**

Leggere `graph.json` in `serde_json::Value`, chiamare `normalize_graphify_value` e rimuovere il secondo percorso di mapping manuale. Mantenere `GraphifyImportSummary` per compatibilità, aggiungendo il campo `report: ProjectGraphImportReport`; `entity_refs` e `relation_refs` sono ricavati direttamente dai vettori normalizzati.

- [ ] **Step 5: Eseguire tutti i test Graphify**

Run: `cargo test -p local-first-memory --test graphify_adapter -- --nocapture`

Expected: PASS; i test esistenti continuano a vedere metadata `adapter/source`, file sorgente e relazione `calls`.

- [ ] **Step 6: Commit**

```bash
git add crates/memory/src/graphify.rs crates/memory/tests/graphify_adapter.rs
git commit -m "feat(memory): normalize project graphs deterministically"
```

## Task 2: Sostituzione Graphify transazionale e rollback osservabile

**Files:**
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/tests/graphify_adapter.rs`

- [ ] **Step 1: Scrivere il test rosso di convergenza dopo due import**

```rust
#[test]
fn importing_the_same_graph_twice_converges_to_the_same_rows() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let facade = MemoryFacade::new(store);
    let first = facade.import_graphify_value(&user(), &workspace(), &duplicate_graph()).unwrap();
    let second = facade.import_graphify_value(&user(), &workspace(), &duplicate_graph()).unwrap();

    assert_eq!(first.checksum, second.checksum);
    assert_eq!(facade.list_entities_for_ui(&user(), &workspace()).unwrap().len(), 2);
    assert_eq!(facade.list_relations_for_ui(&user(), &workspace()).unwrap().len(), 1);
}
```

- [ ] **Step 2: Scrivere il test rosso di rollback**

Usare un file SQLite temporaneo e un trigger che fallisca l'insert della nuova relazione. Importare prima il grafo valido, installare il trigger, tentare un secondo import e verificare che checksum logico e righe precedenti siano invariati:

```rust
assert!(facade.import_graphify_value(&user, &workspace, &changed_graph).is_err());
assert_eq!(entity_refs(&facade), old_entity_refs);
assert_eq!(relation_refs(&facade), old_relation_refs);
```

- [ ] **Step 3: Verificare il rosso**

Run: `cargo test -p local-first-memory --test graphify_adapter importing_the_same_graph -- --nocapture`

Expected: FAIL perché il facade non espone ancora l'import canonico tipizzato.

- [ ] **Step 4: Implementare il boundary unico nel facade/store**

In `MemoryFacade` aggiungere:

```rust
pub fn import_graphify_value(
    &self,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    graph: &serde_json::Value,
) -> MemoryResult<ProjectGraphImportReport>
```

La funzione normalizza prima di aprire la transazione, poi chiama un metodo store che:

1. usa `TransactionBehavior::Immediate` invece di `BEGIN` manuale;
2. elimina solo righe `metadata.source='graphify'` dello scope;
3. inserisce entità e relazioni normalizzate;
4. esegue un controllo interno che i conteggi scritti coincidano con il report;
5. committa oppure effettua rollback automatico al drop della transazione.

Dopo il commit, il facade incrementa `briefing_generation` e invalida gli indici vettoriali derivati dello scope. Gli errori vengono propagati come `MemoryError`, mai convertiti in `(0, 0)`.

- [ ] **Step 5: Eseguire test mirati e suite Memory**

Run: `cargo test -p local-first-memory --test graphify_adapter -- --nocapture`

Run: `RUST_TEST_THREADS=1 cargo test -p local-first-memory -- --test-threads=1`

Expected: PASS, 238 test preesistenti più i nuovi.

- [ ] **Step 6: Commit**

```bash
git add crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/graphify_adapter.rs
git commit -m "fix(memory): replace graphify projections atomically"
```

## Task 3: Build del grafo fail-closed con staging, fingerprint ed evento corretti

**Files:**
- Create: `crates/desktop-gateway/src/project_graph_commit.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Scrivere test rossi per failure e successo**

Nel nuovo modulo definire test con directory temporanee e closure iniettabili:

```rust
#[test]
fn failed_import_keeps_previous_artifacts_and_fingerprint() {
    seed_published_graph("old", "fp-old");
    let result = stage_project_graph_build(&paths(), "fp-new", write_new_graph, |_| {
        Err(ProjectGraphCommitError::Import("forced".into()))
    });
    assert!(result.is_err());
    assert_eq!(read_published_graph(), "old");
    assert_eq!(read_fingerprint(), "fp-old");
    assert!(!ready_event_was_emitted());
}

#[test]
fn successful_import_publishes_artifacts_then_fingerprint_once() {
    let report = stage_project_graph_build(&paths(), "fp-new", write_new_graph, import_ok).unwrap();
    assert_eq!(report.unique_nodes, 2);
    assert_eq!(read_published_graph(), "new");
    assert_eq!(read_fingerprint(), "fp-new");
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-desktop-gateway project_graph_commit -- --nocapture`

Expected: FAIL perché il modulo non esiste.

- [ ] **Step 3: Implementare lo staging**

`stage_project_graph_build` deve:

- creare una directory sorella `.staging-<uuid>` sotto `graphify-out`;
- eseguire Graphify esclusivamente nello staging;
- verificare presenza e JSON di `graph.json`;
- invocare l'import tipizzato sul valore staged;
- se l'import fallisce, rimuovere solo lo staging e lasciare intatti artefatti/fingerprint pubblicati;
- dopo il commit DB, pubblicare gli artefatti con rename locale e scrivere `.fingerprint` via file temporaneo + rename;
- restituire `ProjectGraphImportReport`; non pubblicare eventi nel modulo puro.

- [ ] **Step 4: Collegare `build_project_graph` al nuovo boundary**

Cambiare la firma da `fn build_project_graph(...)` a:

```rust
fn build_project_graph(
    state: &AppState,
    workspace_id: &str,
    folder: &str,
    subpath: Option<&str>,
) -> Result<Option<ProjectGraphImportReport>, ProjectGraphBuildError>
```

`Ok(None)` significa fingerprint invariato. Solo `Ok(Some(report))` scrive il log di conteggio ed emette `project_graph.ready`. `project_graph_ensure` continua asincrono, ma emette un evento `project_graph.failed` con codice tecnico e senza path sensibili quando riceve `Err`. Eliminare `import_graphify_value` dal gateway e il suo `.unwrap_or((0, 0))`.

- [ ] **Step 5: Eseguire i test gateway mirati**

Run: `cargo test -p local-first-desktop-gateway project_graph_ -- --test-threads=1`

Expected: PASS, inclusi failure preservation, doppio build e ready-once.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/project_graph_commit.rs crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(gateway): publish project graphs only after committed import"
```

## Task 4: Purge Memory completo, transazionale e idempotente

**Files:**
- Create: `crates/memory/tests/workspace_purge.rs`
- Modify: `crates/memory/src/operations.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`

- [ ] **Step 1: Scrivere una fixture che popoli ogni tabella dello scope**

Popolare tramite API pubbliche memorie, eventi, embedding, entità, relazioni, wiki, routine, automazioni, audit, grant consumer/source e publication; usare una seconda connection solo per FTS/evidence e per installare un trigger di errore.

```rust
#[test]
fn purge_workspace_removes_every_owned_or_cross_scope_row() {
    let report = facade.purge_workspace(&user, &deleted).unwrap();
    assert!(report.total_deleted > 0);
    assert_scope_absent(&db_path, "local-user", "deleted-project");
    assert_scope_intact(&db_path, "local-user", "kept-project");
}

#[test]
fn purge_workspace_rolls_back_every_table_on_failure() {
    install_failure_trigger(&db_path, "memory_events");
    assert!(facade.purge_workspace(&user, &deleted).is_err());
    assert_eq!(scope_snapshot(&db_path, &deleted), before);
}
```

- [ ] **Step 2: Verificare che il test riproduca il difetto**

Run: `cargo test -p local-first-memory --test workspace_purge -- --nocapture`

Expected: FAIL con `no such table: embeddings`; dimostra che il purge attuale non è atomico né allineato allo schema.

- [ ] **Step 3: Aggiungere `WorkspacePurgeReport`**

In `operations.rs`:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspacePurgeReport {
    pub workspace_id: String,
    pub rows_by_table: BTreeMap<String, usize>,
    pub total_deleted: usize,
}
```

- [ ] **Step 4: Riscrivere `SQLiteMemoryStore::purge_workspace` in una transazione Immediate**

Usare i nomi reali e questo ordine logico:

1. eliminare `memory_evidence` collegata alle ref dello scope;
2. eliminare child di grant, grant consumer/source e relativi `memory_source_access_events`;
3. eliminare `memory_publication_links` e proposte dove source o destination appartengono allo scope;
4. eliminare `memory_search_fts` per user/workspace;
5. eliminare `memory_embeddings`, `relations`, `entities`, `wiki_pages`, `routines`, `automation_candidates`, `access_audit`, `tombstones`, `memory_events`, `memories`;
6. verificare nello stesso transaction handle che nessuna tabella scope-aware contenga ancora lo scope;
7. commit e report per tabella.

Per link/proposte serializzati usare `json_extract(..., '$.workspace_id')`; se un JSON è malformato il purge deve fallire e fare rollback, non ignorarlo.

- [ ] **Step 5: Invalidare tutte le cache dopo il commit**

Nel facade, dopo il report riuscito, rimuovere cache dense locali/authorized dello scope e `briefing_generations` relativo. Nessuna invalidazione anticipata prima del commit.

- [ ] **Step 6: Eseguire test purge e suite Memory**

Run: `cargo test -p local-first-memory --test workspace_purge -- --nocapture`

Run: `RUST_TEST_THREADS=1 cargo test -p local-first-memory -- --test-threads=1`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/memory/src/operations.rs crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/workspace_purge.rs
git commit -m "fix(memory): purge workspace data transactionally"
```

## Task 5: Cancellazione progetto registry-last e retry-safe nel gateway

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Scrivere test rossi sulla semantica registry-last**

Estrarre un orchestratore testabile con trait/closure per i tre store e il filesystem:

```rust
#[test]
fn workspace_registry_is_kept_when_any_purge_step_fails() {
    let result = delete_workspace_transaction(&mut fixture, "project-a", failing_memory_purge);
    assert!(result.is_err());
    assert!(fixture.registry_contains("project-a"));
}

#[test]
fn successful_delete_removes_graph_cache_and_registry_last() {
    delete_workspace_transaction(&mut fixture, "project-a", all_ok).unwrap();
    assert!(!fixture.graph_cache_exists("project-a"));
    assert!(!fixture.registry_contains("project-a"));
    assert_eq!(fixture.operation_order.last().unwrap(), "save_registry");
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-desktop-gateway workspace_delete_ -- --test-threads=1`

Expected: FAIL perché oggi `workspaces.json` è salvato prima del purge e gli errori sono ignorati.

- [ ] **Step 3: Rendere `purge_workspace_data` fallibile e completa**

Cambiare la firma in `Result<GatewayWorkspacePurgeReport, GatewayError>`. Mantenere gli store in ordine idempotente:

1. chat store;
2. task store;
3. memory facade usando esclusivamente `gateway_memory_user_id()` e `MemoryWorkspaceId::new(workspace_id)`;
4. rimozione ricorsiva di `graphify_out_dir(workspace_id)`;
5. nessun log-success per step falliti.

Il task user resta quello canonico del task-runtime esistente; non riusare quel valore per Memory.

- [ ] **Step 4: Spostare il salvataggio registry alla fine**

`delete_workspace` deve prima validare e costruire in memoria il nuovo `WorkspacesFile`, poi eseguire il purge. Solo dopo il successo aggiorna active workspace, salva `workspaces.json` e restituisce 200. Su errore restituisce 500 con codice `workspace_purge_failed`, mantiene il progetto visibile e consente retry.

- [ ] **Step 5: Eseguire i test mirati**

Run: `cargo test -p local-first-desktop-gateway workspace_delete_ -- --test-threads=1`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "fix(gateway): make workspace deletion retry safe"
```

## Task 6: Audit read-only completo della memoria

**Files:**
- Create: `crates/memory/src/integrity.rs`
- Create: `crates/memory/tests/integrity_audit.rs`
- Modify: `crates/memory/src/lib.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`

- [ ] **Step 1: Scrivere test rossi con corruzioni sintetiche**

Su un DB temporaneo valido, inserire con una seconda connection: relazione Graphify duplicata con ref diversa, relazione dangling, embedding orfano, riga FTS mancante, wiki link mancante, memoria attiva duplicata e scope non registrato.

```rust
#[test]
fn audit_counts_corruption_without_returning_user_content() {
    let report = facade.audit_integrity(&known_scopes()).unwrap();
    assert_eq!(report.graphify_relation_duplicate_extras, 1);
    assert_eq!(report.dangling_relations, 1);
    assert_eq!(report.orphan_embeddings, 1);
    assert_eq!(report.memories_missing_fts, 1);
    assert_eq!(report.missing_wiki_links, 1);
    assert_eq!(report.active_memory_duplicate_extras, 1);
    assert_eq!(report.unknown_scope_rows, 1);
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("PRIVATE_SENTINEL"));
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-memory --test integrity_audit -- --nocapture`

Expected: FAIL perché `MemoryIntegrityReport` non esiste.

- [ ] **Step 3: Definire il report metadata-only**

In `integrity.rs` definire sezioni serializzabili:

```rust
pub struct MemoryIntegrityReport {
    pub generated_at: String,
    pub schema_version: u32,
    pub integrity_ok: bool,
    pub foreign_key_violations: u64,
    pub rows_by_table: BTreeMap<String, u64>,
    pub relation_duplicate_groups: u64,
    pub relation_duplicate_extras: u64,
    pub canonical_entity_duplicate_groups: u64,
    pub canonical_entity_duplicate_extras: u64,
    pub graphify_relation_duplicate_groups: u64,
    pub graphify_relation_duplicate_extras: u64,
    pub dangling_relations: u64,
    pub orphan_embeddings: u64,
    pub orphan_evidence_links: u64,
    pub memories_missing_fts: u64,
    pub stale_fts_rows: u64,
    pub missing_wiki_links: u64,
    pub invalid_json_rows: u64,
    pub active_memory_duplicate_groups: u64,
    pub active_memory_duplicate_extras: u64,
    pub unknown_scopes: Vec<UnknownScopeCount>,
    pub active_source_grants: u64,
    pub expired_but_active_grants: u64,
    pub revoked_grant_inconsistencies: u64,
    pub orphan_grant_children: u64,
    pub checksum: String,
}
```

`UnknownScopeCount` contiene solo `workspace_id` e conteggi, mai testo/ref di memoria. Il checksum deriva dal report senza `generated_at`.

- [ ] **Step 4: Implementare query read-only su una singola read connection**

Eseguire `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, conteggi schema, duplicate canonical entity, duplicati per tupla `(user_id, workspace_id, source_ref, relation_type, target_ref)`, dangling contro l'unione `memories/entities`, orfani embedding/evidence, differenze FTS, link wiki via `json_each`, JSON invalidi, duplicate attive via hash/normalizzazione SQL, scope non registrati e coerenza dei grant (child orfani, scadenza, revoca). Errori JSON/SQL rendono l'audit `Err`; non devono essere convertiti in zero.

- [ ] **Step 5: Eseguire test audit e suite Memory**

Run: `cargo test -p local-first-memory --test integrity_audit -- --nocapture`

Run: `RUST_TEST_THREADS=1 cargo test -p local-first-memory -- --test-threads=1`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/memory/src/integrity.rs crates/memory/src/lib.rs crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/integrity_audit.rs
git commit -m "feat(memory): add read only integrity audit"
```

## Task 7: Audit e backup metadata-only del Vault

**Files:**
- Create: `crates/vault/src/integrity.rs`
- Create: `crates/vault/tests/integrity_audit.rs`
- Modify: `crates/vault/src/lib.rs`
- Modify: `crates/vault/src/store.rs`

- [ ] **Step 1: Scrivere test rossi per orfani, algoritmi e plaintext**

Usare un DB file temporaneo; creare un record valido tramite API, poi una secret row orfana e metadata con chiave vietata tramite seconda connection.

```rust
#[test]
fn vault_audit_reports_structure_without_secret_values() {
    let report = store.audit_integrity().unwrap();
    assert!(report.integrity_ok);
    assert_eq!(report.orphan_secret_rows, 1);
    assert_eq!(report.forbidden_metadata_key_rows, 1);
    assert_eq!(report.keyring_algorithms["xchacha20poly1305-syskey-v1"], 1);
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("VAULT_SECRET_SENTINEL"));
    assert!(!encoded.contains("ciphertext"));
    assert!(!encoded.contains("nonce"));
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-vault --test integrity_audit -- --nocapture`

Expected: FAIL perché audit e report non esistono.

- [ ] **Step 3: Implementare `VaultIntegrityReport`**

Il report contiene solo: integrity/FK, record totali, secret rows totali, orfani secret, record senza materiale (informativo), duplicate `(category, normalized_label)`, metadata JSON invalidi, chiavi vietate, conteggi degli algoritmi keyring/secret e checksum. La scansione ricorsiva delle chiavi metadata rifiuta almeno `cvv`, `cvc`, `pin`, `password`, `secret`, `token`, `raw_value`; non restituisce il path o il valore trovato.

- [ ] **Step 4: Aggiungere backup consistente**

Salvare `db_path: Option<PathBuf>` in `SQLiteVaultStore`, come già fa Memory. Implementare `backup_to` usando SQLite `VACUUM INTO` o backup API mentre il mutex è detenuto; rifiutare `open_in_memory`. Il report espone source/destination/bytes, mai chiavi o payload.

- [ ] **Step 5: Eseguire test Vault completi**

Run: `cargo test -p local-first-vault -- --test-threads=1`

Expected: PASS, 20 test preesistenti più i nuovi.

- [ ] **Step 6: Commit**

```bash
git add crates/vault/src/integrity.rs crates/vault/src/lib.rs crates/vault/src/store.rs crates/vault/tests/integrity_audit.rs
git commit -m "feat(vault): add metadata only integrity audit"
```

## Task 8: Repair Memory esplicito, preview-first e con backup

**Files:**
- Create: `crates/memory/tests/integrity_repair.rs`
- Modify: `crates/memory/src/integrity.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`

- [ ] **Step 1: Scrivere test rossi per preview e protezioni**

```rust
#[test]
fn repair_preview_never_mutates_and_binds_actions_to_audit_checksum() {
    let before = file_hash(&db_path);
    let preview = facade.preview_integrity_repair(&known, requested_actions()).unwrap();
    assert_eq!(file_hash(&db_path), before);
    assert!(!preview.approval_token.is_empty());
    assert_eq!(preview.audit_checksum, facade.audit_integrity(&known).unwrap().checksum);
}

#[test]
fn repair_refuses_stale_token_and_missing_backup() {
    assert!(matches!(
        facade.apply_integrity_repair(stale_request()),
        Err(MemoryError::Policy(_))
    ));
}
```

- [ ] **Step 2: Definire azioni ammesse e vietare intent generici**

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MemoryRepairAction {
    RemoveGraphifyDuplicateRelations { workspace_id: WorkspaceId },
    RemoveOrphanEmbeddings,
    RemoveOrphanEvidenceLinks,
    RemoveMissingWikiLinks,
    RebuildFts,
    PurgeUnknownWorkspace { workspace_id: WorkspaceId },
}
```

Non aggiungere `MergeDuplicateMemories`: le duplicate semantiche restano segnalazioni da revisionare.

- [ ] **Step 3: Implementare preview e token**

La preview ricalcola l'audit, convalida ogni azione, stima righe coinvolte e calcola `approval_token = sha256(audit_checksum + canonical_actions)`. Non apre transazioni write e non crea backup.

- [ ] **Step 4: Implementare apply fail-closed**

L'apply richiede token, checksum e azioni identici alla preview; ricalcola l'audit immediatamente, rifiuta drift, crea un backup in una destinazione esplicita e poi applica tutte le azioni DB-local in una singola transazione. Al termine ricostruisce l'audit e restituisce before/after + backup report. Per Graphify mantiene una sola ref per tupla in modo deterministico; per evidence/wiki rimuove solo link il cui target non esiste; per scope sconosciuti usa lo stesso purge del Task 4.

- [ ] **Step 5: Eseguire test repair e suite Memory**

Run: `cargo test -p local-first-memory --test integrity_repair -- --nocapture`

Run: `RUST_TEST_THREADS=1 cargo test -p local-first-memory -- --test-threads=1`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/memory/src/integrity.rs crates/memory/src/store.rs crates/memory/src/facade.rs crates/memory/tests/integrity_repair.rs
git commit -m "feat(memory): add preview first integrity repair"
```

## Task 9: API locale di audit/repair e stato dei grafi registrati

**Files:**
- Create: `crates/desktop-gateway/src/integrity_api.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Scrivere test rossi delle route**

Montare un router di test con store temporanei:

```rust
#[tokio::test]
async fn integrity_audit_returns_counts_and_graph_freshness_without_content() {
    let response = get_json(app(), "/api/integrity/audit").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.json()["memory"]["integrity_ok"], true);
    assert_eq!(response.json()["vault"]["integrity_ok"], true);
    assert!(!response.body_text().contains("PRIVATE_SENTINEL"));
}

#[tokio::test]
async fn repair_apply_requires_matching_preview_token_and_confirmation() {
    assert_eq!(post_apply_without_confirm(app()).await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(post_apply_with_stale_token(app()).await.status(), StatusCode::CONFLICT);
}
```

- [ ] **Step 2: Verificare il rosso**

Run: `cargo test -p local-first-desktop-gateway integrity_ -- --test-threads=1`

Expected: FAIL perché le route non esistono.

- [ ] **Step 3: Aggiungere le route**

- `GET /api/integrity/audit`: audit Memory + Vault + stato dei grafi per i soli workspace registrati.
- `POST /api/integrity/repair/preview`: azioni esplicite, risposta con stime, checksum e token.
- `POST /api/integrity/repair/apply`: richiede `confirm=true`, token/checksum/actions identici e directory backup sotto `~/.homun/backups/integrity/<timestamp>`.

Le route ereditano autenticazione locale già applicata al router. Nessuna risposta include testo memoria, metadata raw, nonce, ciphertext, secret ref o path progetto assoluti.

- [ ] **Step 4: Calcolare freshness del grafo**

Per ogni workspace registrato con folder, restituire `missing|fresh|stale|invalid`, fingerprint salvato/corrente in forma hashata, checksum importato se disponibile e conteggi del report. Non avviare Graphify durante GET. L'azione gateway `RefreshProjectGraph { workspace_id }` è disponibile solo nella preview/apply e usa il percorso fail-closed del Task 3.

- [ ] **Step 5: Eseguire test route e gateway mirati**

Run: `cargo test -p local-first-desktop-gateway integrity_ -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway project_graph_ -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway workspace_delete_ -- --test-threads=1`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/integrity_api.rs crates/desktop-gateway/src/lib.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): expose local integrity audit and repair"
```

## Task 10: Prove end-to-end dei contratti Memory, linked sources e Vault

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/memory/tests/graphify_adapter.rs`
- Modify: `crates/memory/tests/multi_source_recall.rs`

- [ ] **Step 1: Aggiungere il ciclo progetto esistente → doppia analisi → modifica**

Con una mini-repo fixture, usare un Graphify runner finto che produce: duplicati/dangling al primo output, stesso grafo riordinato al secondo, simbolo aggiunto/rimosso al terzo. Verificare:

- primo e secondo build: stesso checksum e stesse ref, zero extra nel DB;
- terzo build: diff esatta di nodi/archi;
- simbolo rimosso assente dopo replacement;
- failure import: vecchio fingerprint e artefatti invariati, nessun ready.

- [ ] **Step 2: Aggiungere il ciclo semantico completo**

Creare fact, decision, goal e open-loop nello scope progetto; applicare estrazione entità/relazioni, proiettare wiki e richiamare. Asserire che ogni hit strutturato conservi `source_workspace_id`, grant/policy quando linked e ref originaria; il testo formattato non deve essere usato per inferire la provenienza.

- [ ] **Step 3: Verificare isolamento, grant e revoca**

Nel test multi-source:

1. progetto B non vede personale/progetto A senza grant;
2. grant esplicito consente solo la collezione scelta;
3. deny individuale prevale;
4. revoke rende il richiamo fail-closed nello stesso processo;
5. cache authorized viene invalidata e nessun hit già cacheato riappare.

- [ ] **Step 4: Verificare il ciclo Vault sintetico nel gateway**

Estendere i test esistenti per coprire in un unico scenario: proposal → save cifrato → duplicate identical → key conflict → recall metadata marker → reveal autorizzato → delete. Interrogare il DB solo per provare che `VAULT_SECRET_SENTINEL` non compare in `vault_records`, PIN verifier, log/eventi o risposta recall; è ammesso esclusivamente come plaintext temporaneo prima della cifratura e come valore restituito dal reveal autorizzato nel test.

- [ ] **Step 5: Eseguire i test end-to-end mirati**

Run: `cargo test -p local-first-memory --test graphify_adapter -- --nocapture`

Run: `cargo test -p local-first-memory --test multi_source_recall -- --nocapture`

Run: `cargo test -p local-first-desktop-gateway vault_end_to_end_ -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway project_graph_end_to_end_ -- --test-threads=1`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs crates/memory/tests/graphify_adapter.rs crates/memory/tests/multi_source_recall.rs
git commit -m "test(memory): cover graph recall grants and vault end to end"
```

## Task 11: Documentazione, dry-run su copie reali e gate finale

**Files:**
- Modify: `docs/architecture/memory.md`
- Modify: `docs/MEMORIA.md`

- [ ] **Step 1: Documentare invarianti e procedura**

Descrivere:

- identità canonica di nodi/archi Graphify;
- replacement transazionale e ordine import → publish → fingerprint → ready;
- isolamento default e grant espliciti con provenance;
- audit metadata-only;
- preview/token/backup/apply;
- purge registry-last;
- distinzione tra duplicate Graphify riparabili automaticamente e duplicate semantiche solo revisionabili.

- [ ] **Step 2: Verificare una copia consistente dei database reali**

Creare una directory temporanea owner-only. Con l'app chiusa o tramite backup SQLite consistente, copiare `memory.sqlite` e `vault.sqlite`; eseguire la nuova API/service di audit sulle copie. Salvare solo report JSON redatti nella directory temporanea e verificare che non contengano estratti di memoria o segreti.

Expected sullo snapshot noto: integrity OK; duplicate Graphify e orfani conteggiati; Vault senza orfani secret. I numeri esatti possono cambiare e non vanno fissati nei test.

- [ ] **Step 3: Generare il preview di repair solo sulle copie**

Richiedere:

- rimozione duplicate Graphify per gli scope registrati;
- rimozione embedding orfani;
- rimozione evidence e link wiki orfani;
- rebuild FTS;
- refresh dei grafi registrati stale.

Non includere purge degli scope sconosciuti e non includere merge di memorie. Applicare il repair alla copia, rieseguire audit e verificare che gli indicatori target vadano a zero senza cambiare i conteggi semantici non target.

- [ ] **Step 4: Eseguire formattazione e gate completi**

Run: `cargo fmt --all -- --check`

Run: `RUST_TEST_THREADS=1 cargo test -p local-first-memory -p local-first-vault -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway integrity_ -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway project_graph_ -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway workspace_delete_ -- --test-threads=1`

Run: `cargo test -p local-first-desktop-gateway vault_ -- --test-threads=1`

Run: `cargo clippy -p local-first-memory -p local-first-vault -p local-first-desktop-gateway --all-targets -- -D warnings`

Expected: tutti i test passano. Se `clippy -D warnings` fallisce solo per warning preesistenti fuori diff, registrare il baseline separatamente e correggere comunque ogni warning introdotto dal branch; non dichiarare quel comando verde.

- [ ] **Step 5: Controllare diff e assenza di dati sensibili**

Run: `git diff --check`

Run: `git status --short`

Run: `rg -n "VAULT_SECRET_SENTINEL|PRIVATE_SENTINEL" crates docs`

Run: `git diff --name-only | rg "homun-tablet-full.png"`

Expected: i sentinel compaiono solo nelle fixture/assertion di test dedicate; nessun match nei file di produzione e nessuna immagine nel diff. Il worktree è pulito dopo il commit.

- [ ] **Step 6: Aggiornare documentazione e commit**

```bash
git add docs/architecture/memory.md docs/MEMORIA.md
git commit -m "docs: document memory integrity operations"
```

- [ ] **Step 7: Fermarsi prima dei database reali**

Presentare il report before/after ottenuto dalle copie, il percorso dei backup che verrebbe usato e le azioni esatte. Chiedere approvazione separata prima di applicare qualunque repair a `~/.homun/memory.sqlite`, `~/.homun/vault.sqlite` o alle cache Graphify reali.

## Criteri di accettazione finali

- Due analisi identiche dello stesso progetto producono lo stesso checksum, le stesse ref e nessuna riga extra.
- Input Graphify duplicato/dangling è conteggiato, normalizzato e non contamina il DB.
- Un errore di import conserva la proiezione precedente, non avanza fingerprint e non emette ready.
- La cancellazione progetto usa `local-user`, ripulisce tutte le tabelle/cross-link/cache e rimuove il registry solo alla fine.
- Audit Memory/Vault è read-only, ripetibile e non serializza contenuti, secret, nonce o ciphertext.
- Repair richiede preview coerente, token, backup e azioni nominate; nessuna riparazione automatica allo startup.
- Memoria personale/progetti restano isolati salvo grant diretto; revoca e cache invalidation sono fail-closed.
- Vault salva il valore solo cifrato, gestisce dedup/conflitto/reveal/delete e non espone plaintext in memoria ordinaria o audit.
- La suite finale distingue chiaramente test verdi, warning preesistenti e qualunque gate non eseguito.
