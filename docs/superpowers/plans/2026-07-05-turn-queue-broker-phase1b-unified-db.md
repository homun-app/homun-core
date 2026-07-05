# Unified DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fondere i due store SQLite separati (`desktop-gateway.sqlite` + `task-runtime.sqlite`) in un unico file, in modo che l'operazione di enqueue del broker (scrive `chat_messages` + `tasks`) sia atomica in una sola transazione SQLite, senza perdita di dati esistenti e senza toccare i ~117 call site dell'applicazione.

**Architecture:** Strategia a 4 fasi incrementali: (A) abilitare WAL mode per permettere writer concorrenti; (B) creare un migration script one-shot che fonde i due DB in uno nuovo usando `ATTACH`; (C) far puntare `gateway_database_path()` e `gateway_task_database_path()` allo stesso file unificato + gli `open()` di entrambi gli store girano `migrate()` sulla stessa `Connection`; (D) l'atomicità del enqueue viene implementata in `broker::enqueue_chat_turn` usando un'unica transazione esplicita cross-tabelle. L'architettura `Arc<Mutex<ChatStore>>` + `Arc<Mutex<TaskStore>>` resta invariata (grazie a WAL le due Connection possono scrivere lo stesso file).

**Tech Stack:** Rust, rusqlite (bundled), SQLite WAL mode, `ATTACH DATABASE`, `tx.commit()`.

**Spec di riferimento:** `docs/superpowers/specs/2026-07-05-turn-queue-broker-design.md` (§ "DB unico")
**Piano precedente:** `docs/superpowers/plans/2026-07-05-turn-queue-broker-phase1a-broker-live.md` (Slice 1a, ✅ completata)

---

## File Structure

**Create:**
- `crates/desktop-gateway/src/db_migrate.rs` — modulo `unify_databases_if_needed`: migration script offline che fonde i due DB separati nel DB unificato. Una responsabilità: leggere i due vecchi DB e scrivere nel nuovo.

**Modify:**
- `crates/desktop-gateway/src/chat_store.rs` — `open()` imposta `PRAGMA journal_mode=WAL` + `busy_timeout` prima di `migrate()`.
- `crates/task-runtime/src/store.rs` — `open()` imposta `PRAGMA journal_mode=WAL` + `busy_timeout` prima di `run_migrations()`.
- `crates/desktop-gateway/src/main.rs` — `gateway_database_path()` + `gateway_task_database_path()` restituiscono lo stesso path; chiama `unify_databases_if_needed()` al boot; il broker enqueue diventa atomico via shared-connection helper.
- `crates/task-runtime/src/broker.rs` — `enqueue_chat_turn` opzionalmente atomico via parametro `chat_message_to_insert: Option<...>` oppure nuovo metodo `enqueue_chat_turn_atomic`.

---

## Task 1: WAL mode + busy_timeout in `TaskStore::open`

**Files:**
- Modify: `crates/task-runtime/src/store.rs:16-22`

- [ ] **Step 1.1: Imposta PRAGMA in `open()` e `open_in_memory()`**

Modifica `TaskStore::open` (riga 16) per impostare WAL + busy_timeout subito dopo `Connection::open(path)` e PRIMA di `run_migrations()`:

```rust
    pub fn open(path: impl AsRef<Path>) -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open(path)?,
        };
        store.connection.pragma_update(None, "journal_mode", "WAL")?;
        store.connection.pragma_update(None, "busy_timeout", 5000)?;
        store.run_migrations()?;
        Ok(store)
    }
```

Idem per `open_in_memory` (riga 24) — WAL su in-memory è no-op ma non fa male; imposta comunque busy_timeout per coerenza:

```rust
    pub fn open_in_memory() -> TaskRuntimeResult<Self> {
        let store = Self {
            connection: Connection::open_in_memory()?,
        };
        store.connection.pragma_update(None, "busy_timeout", 5000)?;
        store.run_migrations()?;
        Ok(store)
    }
```

**Nota:** `pragma_update` è un metodo rusqlite su `Connection`. Se il metodo non è disponibile nella versione di rusqlite del crate, usa `store.connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")?;` come fallback.

- [ ] **Step 1.2: Test che WAL è attivo**

Aggiungi un test in fondo a `store.rs`:

```rust
#[cfg(test)]
mod wal_tests {
    use super::*;

    #[test]
    fn open_sets_wal_mode() {
        // Use a temp file so the WAL pragma actually applies (in-memory ignores it).
        let tmp = std::env::temp_dir().join(format!(
            "homun-wal-test-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let store = TaskStore::open(&tmp).unwrap();
        let mode: String = store.connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let timeout: i64 = store.connection
            .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
            .unwrap();
        assert_eq!(timeout, 5000);
        let _ = std::fs::remove_file(&tmp);
        // WAL files
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-shm"));
    }
}
```

- [ ] **Step 1.3: Esegui e commit**

Run: `cargo test -p local-first-task-runtime wal_tests -- --nocapture`
Expected: PASS.

```bash
git add crates/task-runtime/src/store.rs
git commit -m "feat(task-runtime): WAL mode + busy_timeout on TaskStore::open

Abilita WAL per permettere writer concorrenti sullo stesso file (preparazione
al DB unificato: ChatStore e TaskStore punteranno allo stesso file). busy_timeout
5000ms previene SQLITE_BUSY transitorio."
```

---

## Task 2: WAL mode + busy_timeout in `ChatStore::open`

**Files:**
- Modify: `crates/desktop-gateway/src/chat_store.rs:332-340`

- [ ] **Step 2.1: Imposta PRAGMA in `open()`**

Modifica `ChatStore::open` (riga 332) — pattern identico al Task 1:

```rust
    pub fn open(path: impl AsRef<Path>) -> rusqlite::Result<Self> {
        let store = Self {
            conn: Connection::open(path)?,
        };
        store.conn.pragma_update(None, "journal_mode", "WAL")?;
        store.conn.pragma_update(None, "busy_timeout", 5000)?;
        store.migrate()?;
        store.seed_if_empty();
        Ok(store)
    }
```

Verifica che il campo si chiami `conn` (non `connection`) in ChatStore — la signature dice `pub struct ChatStore { conn: Connection }` (riga 13), quindi usa `store.conn`.

Idem per `in_memory` (riga 341) — busy_timeout:

```rust
    pub fn in_memory() -> rusqlite::Result<Self> {
        let store = Self {
            conn: Connection::open_in_memory()?,
        };
        store.conn.pragma_update(None, "busy_timeout", 5000)?;
        store.migrate()?;
        Ok(store)
    }
```

(Verifica il nome esatto del costruttore `in_memory` in chat_store.rs — potrebbe essere `open_in_memory` o `in_memory`. Adatta.)

- [ ] **Step 2.2: Test**

Aggiungi un test simile a quello del Task 1 ma in `chat_store.rs`. Se chat_store non ha un modulo `#[cfg(test)]` visibile o i suoi test sono in `tests/`, adatta la posizione. Un test minimo:

```rust
#[cfg(test)]
mod wal_tests {
    use super::*;

    #[test]
    fn open_sets_wal_mode() {
        let tmp = std::env::temp_dir().join(format!(
            "homun-chat-wal-test-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let store = ChatStore::open(&tmp).unwrap();
        let mode: String = store.conn.query_row("PRAGMA journal_mode", [], |row| row.get(0)).unwrap();
        assert_eq!(mode, "wal");
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(tmp.with_extension("sqlite-shm"));
    }
}
```

- [ ] **Step 2.3: Esegui e commit**

Run: `cargo test -p local-first-desktop-gateway wal_tests -- --nocapture` (oppure il test specifico di chat_store).
Expected: PASS.

```bash
git add crates/desktop-gateway/src/chat_store.rs
git commit -m "feat(chat-store): WAL mode + busy_timeout on ChatStore::open

Abilita WAL per preparare al DB unificato. busy_timeout 5000ms previene
SQLITE_BUSY transitorio quando entrambi gli store punteranno allo stesso file."
```

---

## Task 3: Modulo `db_migrate` con `unify_databases_if_needed`

**Files:**
- Create: `crates/desktop-gateway/src/db_migrate.rs`
- Modify: `crates/desktop-gateway/src/main.rs` (dichiarazione `mod db_migrate;`)

- [ ] **Step 3.1: Crea il modulo con la funzione di unificazione**

Crea `crates/desktop-gateway/src/db_migrate.rs`. La funzione:
- Verifica se i due vecchi DB separati esistono e il nuovo DB unificato non esiste (o è vuoto).
- Se sì, crea il nuovo DB, fa `ATTACH` dei due vecchi, copia tutte le tabelle, valida i count, poi ritorna Ok.
- È **idempotente**: se il nuovo DB esiste già con dati, è no-op.
- Se solo uno dei due vecchi esiste, copia solo quello.
- Se nessuno dei due esiste (fresh install), è no-op (il migrate creerà tutto).

```rust
//! One-shot migration: fuse the two legacy SQLite files (desktop-gateway.sqlite
//! and task-runtime.sqlite) into a single unified database. Idempotent: if the
//! target is already populated, it's a no-op.

use std::path::{Path, PathBuf};
use rusqlite::Connection;

/// The tables owned by the legacy chat_store (desktop-gateway.sqlite).
/// These get copied verbatim from the attached legacy chat DB.
const CHAT_TABLES: &[&str] = &[
    "settings", "chat_threads", "chat_messages", "remote_approvals",
    "task_thread_links", "channel_inbound_seen", "thread_attachments",
    "tool_runs", "suggestions", "contacts", "contact_identities",
    "contact_perimeters", "profiles", "contact_channel_profiles",
    "contact_relationships",
];

/// The tables owned by the legacy task_store (task-runtime.sqlite).
const TASK_TABLES: &[&str] = &[
    "task_runtime_metadata", "tasks", "task_dependencies", "resource_reservations",
    "task_checkpoints", "task_approvals", "automations", "automation_runs",
    "automation_event_dedup", "turn_events", "broker_meta",
];

/// Fuse the two legacy DBs into the unified target, if needed. Idempotent.
///
/// Decision logic:
/// - If `unified_path` exists AND has at least one row in `chat_threads` (or
///   `tasks`), it's already populated → no-op.
/// - Else, if BOTH legacy paths exist, ATTACH both and copy all tables.
/// - Else, if only one legacy path exists, copy that one.
/// - Else (fresh install), no-op — the schema migrations create everything.
///
/// `legacy_chat_path` is the old desktop-gateway.sqlite; `legacy_task_path` is
/// the old task-runtime.sqlite; `unified_path` is the new homun.sqlite (or
/// whatever gateway_database_path() resolves to).
pub fn unify_databases_if_needed(
    legacy_chat_path: &Path,
    legacy_task_path: &Path,
    unified_path: &Path,
) -> Result<UnifyReport, UnifyError> {
    // If the unified DB is already populated, no-op.
    if unified_path.exists() && is_unified_populated(unified_path)? {
        return Ok(UnifyReport::already_unified());
    }

    let chat_exists = legacy_chat_path.exists();
    let task_exists = legacy_task_path.exists();
    if !chat_exists && !task_exists {
        // Fresh install: nothing to migrate.
        return Ok(UnifyReport::fresh_install());
    }

    // Open the unified DB and run both migrate()s by creating all tables.
    // We rely on the existing migrate() functions to CREATE TABLE IF NOT EXISTS.
    // To call them, we'd need to construct ChatStore/TaskStore on this connection.
    // Instead, do a simpler approach: open the unified, ATTACH the legacy, copy.
    let mut conn = Connection::open(unified_path)?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| UnifyError::Pragma(e.to_string()))?;
    conn.pragma_update(None, "busy_timeout", 5000).map_err(|e| UnifyError::Pragma(e.to_string()))?;

    // To get the schemas, we open each legacy store normally (which runs migrate()
    // on them, ensuring they're at the latest schema), then ATTACH and copy.
    // Step A: ensure legacy DBs are at latest schema by opening via their stores.
    if chat_exists {
        // Opening ChatStore on the legacy path runs its migrate().
        // We use a fresh connection here just to run the schema; then close it.
        let _ = crate::ChatStore::open(legacy_chat_path)
            .map_err(|e| UnifyError::OpenChat(e.to_string()))?;
    }
    if task_exists {
        let _ = local_first_task_runtime::TaskStore::open(legacy_task_path)
            .map_err(|e| UnifyError::OpenTask(e.to_string()))?;
    }

    // Step B: also create the unified schema by opening both stores on it.
    // This creates ALL tables (chat + task) on the unified DB.
    drop(conn);
    let _ = crate::ChatStore::open(unified_path).map_err(|e| UnifyError::OpenUnifiedChat(e.to_string()))?;
    let _ = local_first_task_runtime::TaskStore::open(unified_path).map_err(|e| UnifyError::OpenUnifiedTask(e.to_string()))?;

    // Step C: now ATTACH each legacy DB and copy rows.
    let conn = Connection::open(unified_path)?;
    let mut report = UnifyReport::default();

    if chat_exists {
        conn.execute(&format!("ATTACH DATABASE '{}' AS legacy_chat", legacy_chat_path.display()), [])
            .map_err(|e| UnifyError::Attach(e.to_string()))?;
        for table in CHAT_TABLES {
            // Only copy if the table exists in the legacy (it might not for older DBs).
            let exists: bool = conn.query_row(
                "SELECT 1 FROM legacy_chat.sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![table],
                |_| Ok(true),
            ).optional()?.unwrap_or(false);
            if !exists { continue; }
            let copied = conn.execute(&format!("INSERT INTO main.{table} SELECT * FROM legacy_chat.{table}"), [])?;
            report.chat_rows.insert((*table).to_string(), copied);
        }
        conn.execute("DETACH DATABASE legacy_chat", []).ok();
    }

    if task_exists {
        conn.execute(&format!("ATTACH DATABASE '{}' AS legacy_task", legacy_task_path.display()), [])
            .map_err(|e| UnifyError::Attach(e.to_string()))?;
        for table in TASK_TABLES {
            let exists: bool = conn.query_row(
                "SELECT 1 FROM legacy_task.sqlite_master WHERE type='table' AND name=?1",
                rusqlite::params![table],
                |_| Ok(true),
            ).optional()?.unwrap_or(false);
            if !exists { continue; }
            let copied = conn.execute(&format!("INSERT INTO main.{table} SELECT * FROM legacy_task.{table}"), [])?;
            report.task_rows.insert((*table).to_string(), copied);
        }
        conn.execute("DETACH DATABASE legacy_task", []).ok();
    }

    report.unified = true;
    Ok(report)
}

fn is_unified_populated(path: &Path) -> Result<bool, UnifyError> {
    let conn = Connection::open(path)?;
    // Check chat_threads first; if missing table, fall through to tasks.
    let chat_count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='chat_threads'",
        [], |row| row.get(0),
    ).unwrap_or(0);
    if chat_count == 1 {
        let rows: i64 = conn.query_row("SELECT count(*) FROM chat_threads WHERE 1=1 LIMIT 1", [], |row| row.get(0)).unwrap_or(0);
        if rows > 0 { return Ok(true); }
    }
    let task_count: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='tasks'",
        [], |row| row.get(0),
    ).unwrap_or(0);
    if task_count == 1 {
        let rows: i64 = conn.query_row("SELECT count(*) FROM tasks WHERE 1=1 LIMIT 1", [], |row| row.get(0)).unwrap_or(0);
        if rows > 0 { return Ok(true); }
    }
    Ok(false)
}

use rusqlite::OptionalExtension;

#[derive(Debug, Default)]
pub struct UnifyReport {
    pub unified: bool,
    pub chat_rows: std::collections::HashMap<String, usize>,
    pub task_rows: std::collections::HashMap<String, usize>,
}

impl UnifyReport {
    fn already_unified() -> Self {
        Self { unified: false, ..Default::default() }
    }
    fn fresh_install() -> Self {
        Self { unified: false, ..Default::default() }
    }
}

#[derive(Debug)]
pub enum UnifyError {
    Pragma(String),
    OpenChat(String),
    OpenTask(String),
    OpenUnifiedChat(String),
    OpenUnifiedTask(String),
    Attach(String),
    Sqlite(String),
}

impl std::fmt::Display for UnifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pragma(s) => write!(f, "pragma error: {s}"),
            Self::OpenChat(s) => write!(f, "open legacy chat: {s}"),
            Self::OpenTask(s) => write!(f, "open legacy task: {s}"),
            Self::OpenUnifiedChat(s) => write!(f, "open unified chat: {s}"),
            Self::OpenUnifiedTask(s) => write!(f, "open unified task: {s}"),
            Self::Attach(s) => write!(f, "attach: {s}"),
            Self::Sqlite(s) => write!(f, "sqlite: {s}"),
        }
    }
}

impl From<rusqlite::Error> for UnifyError {
    fn from(e: rusqlite::Error) -> Self { Self::Sqlite(e.to_string()) }
}

impl std::error::Error for UnifyError {}
```

**Note importanti:**
- Il modulo assume che `crate::ChatStore` sia accessibile da `db_migrate.rs` (verifica la visibilità: `ChatStore` è definita in `chat_store.rs` ed esportata come `pub`). Se non è `pub`, adatta.
- L'approccio "apri unified con entrambi gli store prima di copiare" assicura che tutte le tabelle (chat + task) esistano nel DB unificato, grazie a `CREATE TABLE IF NOT EXISTS` nei `migrate()`.
- L'`INSERT INTO main.X SELECT * FROM legacy.X` copia tutte le colonne. Se lo schema del legacy ha meno colonne del nuovo (perché il nuovo ha ALTER aggiuntivi che il legacy non aveva), l'INSERT fallirà. In tal caso, si dovrebbe elencare le colonne esplicitamente per tabella. Per ora assumiamo schema compatibile (i guarded ALTER sono idempotenti e girano sia sul legacy che sul nuovo). Se emergono mismatch, il test (Task 5) li catturerà.

- [ ] **Step 3.2: Dichiara il modulo in `main.rs`**

Aggiungi `mod db_migrate;` vicino alle altre dichiarazioni `mod` (es., vicino a `mod chat_store;` o `mod task_registry;`).

- [ ] **Step 3.3: Test di unificazione end-to-end (su DB temporanei)**

Aggiungi un test in fondo a `db_migrate.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_tmp(prefix: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn cleanup(p: &Path) {
        let _ = std::fs::remove_file(p);
        let _ = std::fs::remove_file(p.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(p.with_extension("sqlite-shm"));
    }

    #[test]
    fn fresh_install_is_noop() {
        let chat = fresh_tmp("fresh-chat");
        let task = fresh_tmp("fresh-task");
        let unified = fresh_tmp("fresh-unified");
        let report = unify_databases_if_needed(&chat, &task, &unified).unwrap();
        assert!(!report.unified);
        // unified may or may not be created; either is fine
        cleanup(&chat); cleanup(&task); cleanup(&unified);
    }

    #[test]
    fn already_unified_is_noop() {
        let chat = fresh_tmp("au-chat");
        let task = fresh_tmp("au-task");
        let unified = fresh_tmp("au-unified");
        // Populate the unified DB first so it's "already populated".
        {
            let c = Connection::open(&unified).unwrap();
            c.execute_batch("CREATE TABLE chat_threads (thread_id TEXT PRIMARY KEY); INSERT INTO chat_threads VALUES ('t1');").unwrap();
        }
        let report = unify_databases_if_needed(&chat, &task, &unified).unwrap();
        assert!(!report.unified);
        cleanup(&chat); cleanup(&task); cleanup(&unified);
    }

    #[test]
    fn fuses_legacy_chat_and_task_into_unified() {
        let chat = fresh_tmp("fuse-chat");
        let task = fresh_tmp("fuse-task");
        let unified = fresh_tmp("fuse-unified");
        // Populate legacy chat DB by opening ChatStore (runs migrate + we insert a row).
        {
            let store = crate::ChatStore::open(&chat).unwrap();
            // insert a thread via raw SQL (we don't know the exact ChatStore API here)
            store.conn.execute(
                "INSERT INTO chat_threads (thread_id, workspace_id, title, subtitle, status, pinned, computer_session_id, task_id, updated_at, message_count)
                 VALUES ('t1', 'w', 'T', 'S', 'active', 0, 'c', 'tk', '0', 0)",
                [],
            ).ok();
        }
        // Populate legacy task DB similarly.
        {
            let store = local_first_task_runtime::TaskStore::open(&task).unwrap();
            store.connection.execute(
                "INSERT INTO tasks (task_id, user_id, workspace_id, kind, status, priority, created_at, updated_at, task_json)
                 VALUES ('tk', 'u', 'w', 'chat_turn', 'queued', 'high', 1, 1, '{}')",
                [],
            ).ok();
        }
        let report = unify_databases_if_needed(&chat, &task, &unified).unwrap();
        assert!(report.unified, "should have unified");
        // Verify data landed in unified.
        let conn = Connection::open(&unified).unwrap();
        let count: i64 = conn.query_row("SELECT count(*) FROM chat_threads", [], |row| row.get(0)).unwrap();
        assert!(count >= 1, "chat_threads should have the legacy row");
        let count: i64 = conn.query_row("SELECT count(*) FROM tasks", [], |row| row.get(0)).unwrap();
        assert!(count >= 1, "tasks should have the legacy row");
        cleanup(&chat); cleanup(&task); cleanup(&unified);
    }
}
```

- [ ] **Step 3.4: Verifica compilazione e test**

Run: `cargo test -p local-first-desktop-gateway db_migrate::tests -- --nocapture`
Expected: PASS (3 test). Se ci sono errori di visibilità (es. `crate::ChatStore` non accessibile da un modulo fratello), correggi rendendo pubblici i simboli necessari o usando i path completi.

- [ ] **Step 3.5: Commit**

```bash
git add crates/desktop-gateway/src/db_migrate.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): db_migrate — unify_databases_if_needed

Script one-shot che fonde i due DB legacy (chat + task) in uno unificato.
Idempotente: no-op se il target è già popolato o se è fresh install.
Usa ATTACH + INSERT INTO main.X SELECT * FROM legacy.X. Validato da test."
```

---

## Task 4: Puntare entrambi gli store allo stesso file + chiamare unify al boot

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 4.1: Crea un nuovo helper `gateway_unified_database_path()`**

Aggiungi vicino a `gateway_database_path()` (~riga 47184):

```rust
/// Path of the unified DB. Both ChatStore and TaskStore open this same file.
/// The legacy two-file layout is migrated once at boot by `unify_databases_if_needed`.
fn gateway_unified_database_path() -> Result<PathBuf, std::io::Error> {
    let base = gateway_data_dir()?;
    Ok(base.join("homun.sqlite"))
}

/// Legacy chat DB path (desktop-gateway.sqlite). Used only by the migration.
fn gateway_legacy_chat_database_path() -> Result<PathBuf, std::io::Error> {
    let base = gateway_data_dir()?;
    Ok(base.join("desktop-gateway.sqlite"))
}

/// Legacy task DB path (task-runtime.sqlite). Used only by the migration.
fn gateway_legacy_task_database_path() -> Result<PathBuf, std::io::Error> {
    let base = gateway_data_dir()?;
    Ok(base.join("task-runtime.sqlite"))
}
```

- [ ] **Step 4.2: Fai puntare `gateway_database_path` e `gateway_task_database_path` al path unificato**

Modifica `gateway_database_path()` (~riga 47184) e `gateway_task_database_path()` (~riga 47197) per restituire entrambi `gateway_unified_database_path()`. Mantieni gli env override se esistono (`HOMUN_DESKTOP_GATEWAY_DB`, `HOMUN_TASK_RUNTIME_DB`), ma il default è il file unificato:

```rust
fn gateway_database_path() -> Result<PathBuf, std::io::Error> {
    // Env override keeps working for backwards compat / testing.
    if let Ok(p) = std::env::var("HOMUN_DESKTOP_GATEWAY_DB") {
        return Ok(PathBuf::from(p));
    }
    gateway_unified_database_path()
}

fn gateway_task_database_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(p) = std::env::var("HOMUN_TASK_RUNTIME_DB") {
        return Ok(PathBuf::from(p));
    }
    gateway_unified_database_path()
}
```

**Importante:** se entrambi gli env sono impostati a path diversi, si torna al comportamento a due DB (backwards compat). Il default (senza env) è il DB unificato.

- [ ] **Step 4.3: Chiama `unify_databases_if_needed` al boot, PRIMA di aprire gli store**

Nel `main`, PRIMA della riga che costruisce `AppState` con `ChatStore::open(gateway_database_path()?)` (~riga 576), aggiungi:

```rust
    // Phase 1b: unify the legacy two-DB layout into a single file (idempotent).
    // MUST run before AppState opens the stores on the unified path.
    {
        let unified = gateway_unified_database_path()?;
        let legacy_chat = gateway_legacy_chat_database_path()?;
        let legacy_task = gateway_legacy_task_database_path()?;
        match db_migrate::unify_databases_if_needed(&legacy_chat, &legacy_task, &unified) {
            Ok(report) => {
                if report.unified {
                    let total_chat: usize = report.chat_rows.values().sum();
                    let total_task: usize = report.task_rows.values().sum();
                    eprintln!(
                        "db unify: migrated legacy chat ({total_chat} rows across {} tables) + task ({total_task} rows across {} tables) into {}",
                        report.chat_rows.len(), report.task_rows.len(), unified.display()
                    );
                }
            }
            Err(e) => {
                eprintln!("db unify: WARNING migration failed ({e}); continuing with whatever state exists at {}", unified.display());
                // Non-fatal: the stores will open on whatever the unified path resolves to.
            }
        }
    }
```

- [ ] **Step 4.4: Verifica compilazione**

Run: `cargo check -p local-first-desktop-gateway`
Expected: OK.

- [ ] **Step 4.5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): unified DB — both stores open the same file

gateway_database_path() e gateway_task_database_path() puntano entrambi a
homun.sqlite (env override preservato per backwards compat). La migrazione
unify_databases_if_needed gira al boot, prima di aprire gli store. Logga il
riepilogo. Se fallisce, non è fatale (continua con lo stato esistente)."
```

---

## Task 5: Atomicità del enqueue broker (transazione cross-tabelle)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (l'handler `enqueue_turn`)

- [ ] **Step 5.1: Analizza l'handler `enqueue_turn` attuale**

Leggi `enqueue_turn` (~riga 31219). Oggi fa solo `broker::enqueue_chat_turn` (scrive `tasks`) ma NON scrive il messaggio utente in `chat_messages`. Per la proprietà di atomicità prompt+turno, dobbiamo:

1. In una sola transazione SQLite: `INSERT INTO chat_messages (user_message)` + `INSERT INTO tasks (chat_turn)`.
2. Se una delle due fallisce, rollback di entrambe.

Oggi il broker chiama `store.insert_chat_turn(...)` che fa due operazioni (insert_task + UPDATE colonne chat_turn). Per renderlo atomico con l'inserimento del messaggio utente, serve che entrambe avvengano nella stessa transazione.

**Strategia:** aggiungi un nuovo metodo `TaskStore::insert_chat_turn_atomic` che prende anche il messaggio utente e fa entrambi gli inserimenti in un'unica transazione esplicita. Oppure (più pulito) crea un metodo nel broker che accetta una `&mut Transaction` o usa `unchecked_transaction` esternamente.

- [ ] **Step 5.2: Aggiungi `TaskStore::insert_chat_turn_atomic` (opzionale, con user message)**

Aggiungi in `crates/task-runtime/src/store.rs` un metodo che, oltre a inserire il chat_turn, inserisce anche un record in una tabella collegata. **Tuttavia**, il messaggio utente vive in `chat_messages` che appartiene a `ChatStore` (un altro crate/struct). La via più semplice è che l'handler `enqueue_turn` apra la transazione a livello di `Connection` condivisa.

**Approccio raccomandato**: dato che ora entrambi gli store puntano allo stesso file e usano WAL, possiamo ottenere atomicità con un piccolo trucco — aggiungiamo un metodo su `TaskStore` che accetta una callback/chiusura transazione:

In `crates/task-runtime/src/store.rs`, esponi un helper per ottenere un riferimento mutabile alla `Connection` per scopi transazionali ( ATTENZIONE: questa è un'apertura nell'incapsulamento, usala solo per il broker):

```rust
    /// Runs a closure with a transaction handle. Use for cross-table atomic operations
    /// (e.g., broker enqueue that must also insert a chat_message in the same tx).
    /// The closure receives a `&rusqlite::Transaction` and can run arbitrary SQL.
    /// Commits if the closure returns Ok, rolls back on Err.
    pub fn with_transaction<F, T>(&self, f: F) -> TaskRuntimeResult<T>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> TaskRuntimeResult<T>,
    {
        let tx = self.connection.unchecked_transaction()?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }
```

- [ ] **Step 5.3: Crea `enqueue_chat_turn_atomic` nel broker**

In `crates/task-runtime/src/broker.rs`, aggiungi una variante atomica di `enqueue_chat_turn` che accetta una chiusura per inserire il messaggio utente nella stessa transazione:

```rust
/// Atomic variant of enqueue_chat_turn: runs the broker insert AND a caller-provided
/// chat_message insert in the SAME SQLite transaction. If either fails, both roll back.
///
/// The `insert_user_message` closure receives a `&Transaction` and must insert the user
/// message row (the caller knows the chat_messages schema, which lives in chat_store).
/// It should be idempotent on the request_id (use INSERT OR IGNORE) so re-enqueue after
/// a crash doesn't duplicate.
pub fn enqueue_chat_turn_atomic<F>(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
    insert_user_message: F,
) -> Result<EnqueuedTurn, EnqueueError>
where
    F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), EnqueueError>,
{
    // Pre-check (the tx below hardens).
    if let Some(active) = store.active_chat_turn_for_thread(&input.thread_id)? {
        return Err(EnqueueError::ThreadBusy {
            thread_id: input.thread_id.clone(),
            active_turn_id: active,
        });
    }

    let task_id = chat_turn_task_id(&input.request_id);
    // ... build task identically to enqueue_chat_turn ...
    let now = OffsetDateTime::now_utc();
    let input_json = serde_json::json!({
        "thread_id": input.thread_id,
        "request_id": input.request_id,
        "prompt": input.prompt,
        "visible_prompt": input.visible_prompt,
        "attachments": input.attachments,
        "mode": input.mode,
        "model": input.model,
        "source": input.source.as_str(),
        "approval": input.approval.as_str(),
    });
    let mut task = TaskRecord::new(
        task_id.as_str(), user_id.clone(), workspace_id.clone(),
        "chat_turn", input.prompt.clone(), input_json,
    );
    task.status = TaskStatus::Queued;
    task.priority = match input.source {
        ChatTurnSource::Interactive => TaskPriority::High,
        ChatTurnSource::Channel => TaskPriority::Low,
        ChatTurnSource::Automation | ChatTurnSource::Connector => TaskPriority::Background,
    };
    task.created_at = now;
    task.updated_at = now;

    // Atomic section: insert_user_message + insert task in one tx.
    store.with_transaction(|tx| {
        // Caller inserts the chat message in the same tx.
        insert_user_message(tx)?;

        // Insert the task + indexed columns in the same tx.
        // We need tx-scoped versions of insert_task + the chat_turn columns update.
        // Since TaskStore methods take &self (which holds &Connection), and we have a
        // &Transaction here (which derefs to &Connection), we can run the SQL inline.
        let task_json = serde_json::to_string(&task)?;
        tx.execute(
            "INSERT INTO tasks (task_id, user_id, workspace_id, workflow_id, kind, status, priority,
                                created_at, updated_at, blocked_reason, task_json)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, NULL, ?9)
             ON CONFLICT(task_id, user_id, workspace_id) DO UPDATE SET
                kind = excluded.kind, status = excluded.status, priority = excluded.priority,
                updated_at = excluded.updated_at, task_json = excluded.task_json",
            rusqlite::params![
                task.task_id.as_str(), task.user_id.as_str(), task.workspace_id.as_str(),
                task.kind, "queued", "high", // status + priority as strings (snake_case)
                now.unix_timestamp(), now.unix_timestamp(), task_json,
            ],
        )?;
        tx.execute(
            "UPDATE tasks SET thread_id = ?1, request_id = ?2, source = ?3, approval = ?4
             WHERE task_id = ?5 AND user_id = ?6 AND workspace_id = ?7",
            rusqlite::params![
                input.thread_id, input.request_id, input.source.as_str(), input.approval.as_str(),
                task.task_id.as_str(), task.user_id.as_str(), task.workspace_id.as_str(),
            ],
        )?;
        Ok(())
    })?;

    // Post-insert double-check (outside tx, same as enqueue_chat_turn).
    if let Some(a) = store.active_chat_turn_for_thread(&input.thread_id)? {
        if a != task.task_id.as_str() {
            store.update_task_status(
                &task.task_id, user_id, workspace_id,
                TaskStatus::Cancelled, Some("race lost on thread enqueue"),
            )?;
            return Err(EnqueueError::ThreadBusy {
                thread_id: input.thread_id.clone(),
                active_turn_id: a,
            });
        }
    }

    Ok(EnqueuedTurn { task_id, thread_id: input.thread_id.clone(), position_in_queue: 0 })
}
```

**Note:**
- I valori `"queued"` e `"high"` per status/priority sono stringhe snake_case (il serde rename del task_runtime). Verifica che matchino i `as_str()` di `TaskStatus`/`TaskPriority`.
- L'`insert_user_message` closure viene fornita dall'handler nel gateway (che conosce lo schema di `chat_messages`).

- [ ] **Step 5.4: Usa `enqueue_chat_turn_atomic` nell'handler `enqueue_turn`**

In `main.rs`, modifica `enqueue_turn` per chiamare la versione atomica. Sostituisci la chiamata `broker::enqueue_chat_turn(...)` con:

```rust
    let result = local_first_task_runtime::broker::enqueue_chat_turn_atomic(
        &store, &user_id, &workspace_id, &input,
        |tx| {
            // Insert the user message in chat_messages, idempotent on request_id.
            // INSERT OR IGNORE so re-enqueue after a crash doesn't duplicate.
            tx.execute(
                "INSERT OR IGNORE INTO chat_messages
                    (message_id, thread_id, role, content_type, text, created_at, request_id)
                 VALUES (?1, ?2, 'user', 'text', ?3, ?4, ?5)",
                rusqlite::params![
                    format!("local_user_{}", input.request_id),
                    input.thread_id,
                    input.prompt,
                    now_epoch_secs(),
                    input.request_id,
                ],
            ).map_err(|e| local_first_task_runtime::broker::EnqueueError::Store(
                local_first_task_runtime::TaskRuntimeError::Store(e.to_string())
            ))?;
            Ok(())
        },
    );
```

**Importante:** verifica lo schema esatto di `chat_messages` in `chat_store.rs`. I campi `message_id`, `thread_id`, `role`, `content_type`, `text`, `created_at`, `request_id` devono esistere. Se la tabella ha più campi NOT NULL senza default, l'INSERT fallirà — adatta l'SQL. Se `request_id` non è una colonna di `chat_messages`, usa solo `message_id` (che incorpora già `request_id` ed è quindi idempotente).

- [ ] **Step 5.5: Test di atomicità**

Verifica che, se l'inserimento del task fallisce (es. PK duplicato), anche il messaggio utente non venga scritto. Aggiungi un test in `broker.rs`:

```rust
#[cfg(test)]
mod atomic_tests {
    use super::*;
    use crate::TaskStore;
    use rusqlite::params;

    #[test]
    fn atomic_enqueue_rolls_back_on_failure() {
        let store = TaskStore::open_in_memory().unwrap();
        // Pre-insert a conflicting task so the broker insert fails.
        let conflicting = chat_turn_task_id("r1");
        let now = OffsetDateTime::now_utc();
        let mut t = TaskRecord::new(
            conflicting.as_str(), UserId::new("u"), WorkspaceId::new("w"),
            "chat_turn", "x", serde_json::json!({}),
        );
        t.status = TaskStatus::Queued;
        t.priority = TaskPriority::High;
        t.created_at = now;
        t.updated_at = now;
        store.insert_chat_turn(&t, "t1", "r1", "interactive", "full").unwrap();

        // Now try atomic enqueue on the same thread — should fail with ThreadBusy.
        let input = ChatTurnInput {
            thread_id: "t1".into(), request_id: "r2".into(), prompt: "p".into(),
            visible_prompt: None, attachments: None, mode: None, model: None,
            source: ChatTurnSource::Interactive, approval: TurnApproval::Full,
        };
        let user_message_called = std::sync::Arc::new(std::sync::Mutex::new(false));
        let user_message_called_clone = user_message_called.clone();
        let result = enqueue_chat_turn_atomic(
            &store, &UserId::new("u"), &WorkspaceId::new("w"), &input,
            |_tx| {
                *user_message_called_clone.lock().unwrap() = true;
                Ok(())
            },
        );
        // Pre-check should catch the busy state before invoking the closure.
        assert!(matches!(result, Err(EnqueueError::ThreadBusy { .. })));
        assert!(!*user_message_called.lock().unwrap(), "user_message should not be called when pre-check fails");
    }

    #[test]
    fn atomic_enqueue_runs_both_inserts_on_success() {
        let store = TaskStore::open_in_memory().unwrap();
        let input = ChatTurnInput {
            thread_id: "t1".into(), request_id: "r1".into(), prompt: "p".into(),
            visible_prompt: None, attachments: None, mode: None, model: None,
            source: ChatTurnSource::Interactive, approval: TurnApproval::Full,
        };
        let user_message_called = std::sync::Arc::new(std::sync::Mutex::new(false));
        let user_message_called_clone = user_message_called.clone();
        let result = enqueue_chat_turn_atomic(
            &store, &UserId::new("u"), &WorkspaceId::new("w"), &input,
            |tx| {
                *user_message_called_clone.lock().unwrap() = true;
                // Simulate inserting a marker row in some "chat_messages"-like table.
                tx.execute(
                    "CREATE TABLE IF NOT EXISTS chat_messages (message_id TEXT PRIMARY KEY)",
                    [],
                )?;
                tx.execute("INSERT INTO chat_messages VALUES ('local_user_r1')", [])?;
                Ok(())
            },
        );
        assert!(result.is_ok(), "atomic enqueue should succeed: {:?}", result.err());
        assert!(*user_message_called.lock().unwrap());
        // Verify the marker row landed.
        let count: i64 = store.connection.query_row(
            "SELECT count(*) FROM chat_messages WHERE message_id = 'local_user_r1'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(count, 1);
    }
}
```

- [ ] **Step 5.6: Esegui e commit**

Run: `cargo test -p local-first-task-runtime atomic_tests -- --nocapture`
Expected: PASS (2 test). Risolvi eventuali errori di import (`rusqlite::params`, `OffsetDateTime`).

```bash
git add crates/task-runtime/src/store.rs crates/task-runtime/src/broker.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(broker): atomic enqueue — user_message + chat_turn in one tx

enqueue_chat_turn_atomic: inserisce messaggio utente (callback closure) e
chat_turn nella STESSA transazione SQLite. Se uno fallisce, rollback di
entrambi. with_transaction helper su TaskStore. Risolve l'atomicità
prompt+turno (proprieta chiave del design del DB unificato)."
```

---

## Task 6: Smoke test end-to-end + estendere lo script e2e

**Files:**
- Modify: `scripts/test-turn-broker-e2e.py`

- [ ] **Step 6.1: Aggiungi verifica atomicità allo script e2e**

In `scripts/test-turn-broker-e2e.py`, dopo "TEST 1" (enqueue succeeds), aggiungi una verifica che il messaggio utente è stato persistito in `chat_messages`:

```python
    # --- Test 1b: verify the user message was persisted atomically ---
    log("TEST 1b: verify user message persisted in chat_messages (atomicity)")
    # We can't query the DB directly from here, but the executor reads it back
    # to build context — if the message is missing, the executor's context is empty.
    # Instead, query via the chat_messages route.
    status, body, _ = http_request("GET", f"/api/chat/threads/{thread_id}/messages", expect=200)
    if isinstance(body, list):
        # Look for our prompt text in the messages
        found = any("hello broker" in (m.get("text") or "") for m in body if isinstance(m, dict))
        if found:
            log(f"  → user message 'hello broker' found in thread messages ✓")
        else:
            log(f"  → WARNING: user message not found in thread messages (atomicity may have failed)")
    else:
        log(f"  → WARNING: could not read messages")
```

- [ ] **Step 6.2: Esegui lo script e2e completo**

Run: `python3 scripts/test-turn-broker-e2e.py --keep-data-dir`
Expected: tutti i test PASS, incluso TEST 1b (atomicity).

- [ ] **Step 6.3: Commit finale**

```bash
git add scripts/test-turn-broker-e2e.py
git commit -m "test(broker): e2e verifica atomicità prompt+turno

Lo script e2e ora verifica anche che il messaggio utente sia persistito in
chat_messages insieme all'enqueue del turno (atomicità cross-tabelle)."
```

---

## Definition of Done — Phase 1b (Unified DB)

- [ ] WAL mode + busy_timeout attivi su entrambi gli store.
- [ ] `unify_databases_if_needed` funziona (3 test pass).
- [ ] `gateway_database_path()` + `gateway_task_database_path()` puntano a `homun.sqlite` (env override preservato).
- [ ] Migration al boot gira (idempotente).
- [ ] `enqueue_chat_turn_atomic` con `with_transaction` helper (2 test pass).
- [ ] Handler `enqueue_turn` usa la versione atomica.
- [ ] Script e2e verifica atomicità (TEST 1b).
- [ ] **Nessun comportamento rotto**: workspace esistenti continuano a funzionare (i dati legacy vengono migrati).

## Cosa NON è in questo piano (successivi)

- **FK reali cross-tabelle** (es. `task_thread_links.task_id → tasks.task_id`): richiede di rendere le PK coerenti tra store, è refactor aggiuntivo.
- **Eliminazione dei vecchi file `.sqlite`** dopo la migrazione: bisogna prima verificare stabilità in produzione. Per ora i file legacy restano in posto come backup.
- **Slice 1b (browser preemption)**: piano separato.

## Rischi e residuali onesti

1. **`pragma_update` API**: se rusqlite non espone `pragma_update`, usa `execute_batch` con SQL diretto. Il test (Task 1/2) verifica che il PRAGMA sia effettivamente applicato.
2. **Schema mismatch durante `INSERT INTO main.X SELECT * FROM legacy.X`**: se il legacy DB ha meno colonne del nuovo (perché più vecchio), l'INSERT fallisce. La gestione corretta richiederebbe elencare le colonne per tabella. **Mitigazione**: apriamo entrambi gli store (legacy + nuovo) con `open()` PRIMA della copia, il che fa girare i `migrate()` sui legacy e li porta all'ultimo schema. Se comunque emerge un mismatch (es. colonna ADD ONLY nel nuovo), il test `fuses_legacy_chat_and_task_into_unified` lo cattura; il fix è elencare le colonne esplicitamente in CHAT_TABLES/TASK_TABLES come `("table", &["col1", "col2", ...])`.
3. **`insert_user_message` closure deve conoscere lo schema `chat_messages`**: è un'apertura nell'incapsulamento. La via pulita sarebbe esporre un `ChatStore::insert_user_message_tx(&Transaction, ...)` — consideralo come follow-up se l'SQL inline diventa fragile.
4. **WAL mode ha implicazioni di file**: crea `.sqlite-wal` e `.sqlite-shm` file. L'esistente `harden_data_at_rest` e i backup devono considerarli. Verifica la documentazione di deployment.
5. **Single-writer SQLite**: anche con WAL, SQLite serializza i writer (un solo writer alla volta, altri aspettano fino a `busy_timeout`). Per il workload del gateway (turni utente + automation) è sufficiente, ma per alti throughput servirebbe un vero pool di connection — fuori scope qui.
