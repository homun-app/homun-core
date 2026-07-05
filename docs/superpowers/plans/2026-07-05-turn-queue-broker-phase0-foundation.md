# Turn Queue Broker — Phase 0 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Costruire le fondamenta del broker persistente: estendere `task-runtime` con il supporto `chat_turn` (colonne + indici), aggiungere le tabelle `turn_events` e `broker_meta`, implementare le primitive di recovery lease-aware (process generation), e predisporre il flag feature `HOMUN_TURN_BROKER`. Nessun behavior change in produzione (tutto dietro flag off + dual-write shadow opzionale).

**Architecture:** Si estende `task-runtime` (SQLite esistente) con colonne indicizzate per `chat_turn` e le tabelle `turn_events` + `broker_meta`. Le primitive broker (enqueue transazionale con 409-per-thread, recovery al boot con process generation, append/read eventi) vivono in un nuovo modulo `broker.rs` nel crate. Tutto è testato in isolamento; il gateway non è ancora toccato in produzione (collegamento = Fase 1).

**Tech Stack:** Rust, `rusqlite` (bundled), `time`, `serde_json`, `tokio::sync::Notify` (per primitive async, ma la Fase 0 è soprattutto store sincrono). Test con `#[cfg(test)]` e `TaskStore::open_in_memory()`.

**Spec di riferimento:** `docs/superpowers/specs/2026-07-05-turn-queue-broker-design.md`

**Scope di questo piano:** SOLO Fase 0. Le Fasi 1 (broker live), 2 (client migration + cleanup), 3 (future-proofing) avranno piani separati. Questo piano produce: schema esteso, primitive broker testate, recovery function, flag feature. Non abilita nulla in produzione di default.

---

## File Structure

**Create:**
- `crates/task-runtime/src/broker.rs` — primitive broker: `BrokerMeta` (process generation), `enqueue_chat_turn` (transazionale con 409-per-thread), `append_turn_event`/`read_turn_events`, `recover_at_boot`, `TurnEvent`/`ChatTurnInput`/`EnqueueError` types. Una responsabilità: orchestrare il lifecycle dei turni chat nello store.

**Modify:**
- `crates/task-runtime/src/store.rs` — estendere `run_migrations()` con colonne `chat_turn` + `turn_events` + `broker_meta`; helper `column_exists`/`table_exists` se mancanti; `insert_turn_event`/`read_turn_events`/`active_turn_for_thread`/`bump_process_generation`/`get_process_generation`.
- `crates/task-runtime/src/lib.rs` — re-export `broker` modulo + nuovi tipi pubblici.
- `crates/desktop-gateway/src/main.rs` — feature flag `HOMUN_TURN_BROKER` (default `off`) letto da env, helper `turn_broker_enabled()`. Solo predisposizione, nessun uso attivo.

**Test:**
- `crates/task-runtime/src/broker.rs` (`#[cfg(test)] mod tests`) — test unitari di tutte le primitive.

---

## Task 1: Migrazioni schema — colonne `chat_turn` su `tasks`

**Files:**
- Modify: `crates/task-runtime/src/store.rs:32-155` (estendere `run_migrations`)
- Test: `crates/task-runtime/src/store.rs` (test esistenti + nuovo test in fondo)

- [ ] **Step 1.1: Aggiungi helper `column_exists` e `table_exists` se non presenti**

Verifica prima se esistono già (lo spec dice che `chat_store.rs` ha `column_exists` ma `task-runtime/src/store.rs` potrebbe non averlo). Aggiungi in fondo a `store.rs`, prima di `enum_value`:

```rust
fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(cols) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let names = cols.query_map([], |row| row.get::<_, String>(1)).ok();
    names.map(|mut rows| rows.all().map(|vs| vs.iter().any(|v| v == column)).unwrap_or(false)).unwrap_or(false)
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        rusqlite::params![table],
        |_| Ok(()),
    ).is_ok()
}
```

- [ ] **Step 1.2: Estendi `run_migrations` con le colonne `chat_turn`**

Dopo l'`INSERT INTO task_runtime_metadata ... schema_version = '3'` esistente (riga ~149-151), aggiungi blocco guarded ALTER. Cambia anche il `INSERT` finale del metadata per portare `schema_version` a `'4'`:

```rust
            // ── schema_version 4: chat_turn support (broker Phase 0) ───────────────
            // Colonne indicizzate per i turni chat. Nelle righe non-chat_turn restano
            // NULL: la indicizzazione selettiva la fa l'indice parziale sottostante.
            ALTER TABLE tasks ADD COLUMN thread_id TEXT;
            ALTER TABLE tasks ADD COLUMN request_id TEXT;
            ALTER TABLE tasks ADD COLUMN source TEXT;
            ALTER TABLE tasks ADD COLUMN approval TEXT;
```

**Importante — gli ALTER non sono idempotenti in SQLite**: NON puoi usare `IF NOT EXISTS` sugli `ALTER TABLE ADD COLUMN`. Vanno eseguiti solo se la colonna manca. Quindi NON possono stare nell'`execute_batch` iniziale. Sostituisci la struttura: togli gli ALTER dal batch e aggiungili dopo, guarded singolarmente (vedi Step 1.3).

- [ ] **Step 1.3: Esegui gli ALTER guarded dopo il batch**

Subito dopo `self.connection.execute_batch(...)?;`, aggiungi:

```rust
        // ── chat_turn columns (schema_version 4). Guarded: idempotenti sui DB esistenti.
        let chat_turn_cols = ["thread_id", "request_id", "source", "approval"];
        for col in chat_turn_cols {
            if !column_exists(&self.connection, "tasks", col) {
                self.connection.execute(
                    &format!("ALTER TABLE tasks ADD COLUMN {col} TEXT"),
                    [],
                )?;
            }
        }
        // Indice parziale: solo le righe chat_turn (thread_id IS NOT NULL). Indicizza la
        // query del 409-per-thread (status queued/running) senza inquinarle con i task non-chat.
        if !index_exists(&self.connection, "idx_tasks_chat_turn_thread") {
            self.connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_tasks_chat_turn_thread
                    ON tasks(thread_id, status, kind)
                    WHERE thread_id IS NOT NULL",
                [],
            )?;
        }
```

Aggiungi anche l'helper `index_exists` vicino a `column_exists`:

```rust
fn index_exists(conn: &Connection, index_name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1",
        rusqlite::params![index_name],
        |_| Ok(()),
    ).is_ok()
}
```

- [ ] **Step 1.4: Aggiorna `schema_version` a `'4'`**

Cambia la riga finale del batch da `VALUES ('schema_version', '3')` a `VALUES ('schema_version', '4')`. L'`ON CONFLICT ... DO UPDATE` già presente sovrascrive.

- [ ] **Step 1.5: Scrivi il test di migrazione idempotente**

In fondo a `store.rs` (o nel `#[cfg(test)]` esistente se presente), aggiungi:

```rust
#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn migrations_run_idempotently_with_chat_turn_cols() {
        let store = TaskStore::open_in_memory().expect("open");
        // Le colonne esistono dopo la prima migrazione.
        for col in ["thread_id", "request_id", "source", "approval"] {
            assert!(column_exists(&store.connection, "tasks", col), "missing col {col}");
        }
        // Rieseguire le migrazioni non deve panicare (guarded ALTER).
        store.run_migrations().expect("idempotent re-run");
        assert_eq!(store.schema_version().unwrap(), 4);
    }

    #[test]
    fn chat_turn_index_exists() {
        let store = TaskStore::open_in_memory().expect("open");
        assert!(index_exists(&store.connection, "idx_tasks_chat_turn_thread"));
    }
}
```

- [ ] **Step 1.6: Esegui i test, verifica che passino**

Run: `cargo test -p local-first-task-runtime migration_tests -- --nocapture`
Expected: PASS (2 test). Se `column_exists`/`index_exists` non compilano per borrow su `store.connection` (campo privato), sposta i test **dentro** l'`impl TaskStore` o esponi un accessor `pub fn conn(&self) -> &Connection`. Più pulito: tieni i test nello stesso modulo e accedi a `store.connection` (i test `cfg(test)` nello stesso file vedono i campi privati).

- [ ] **Step 1.7: Commit**

```bash
git add crates/task-runtime/src/store.rs
git commit -m "feat(task-runtime): chat_turn columns + partial index (broker Phase 0)

Schema version 3 → 4. Aggiunge thread_id, request_id, source, approval
su tasks (guarded ALTER, idempotenti) + idx_tasks_chat_turn_thread
(indice parziale, solo righe chat_turn) per la query 409-per-thread."
```

---

## Task 2: Tabelle `turn_events` e `broker_meta`

**Files:**
- Modify: `crates/task-runtime/src/store.rs` (estendere `run_migrations` con nuove tabelle; helper di accesso)

- [ ] **Step 2.1: Aggiungi `turn_events` al batch di migrazione**

In `run_migrations`, dentro l'`execute_batch` iniziale (dopo `automation_event_dedup`, prima del `INSERT INTO task_runtime_metadata`), aggiungi:

```sql
            CREATE TABLE IF NOT EXISTS turn_events (
                event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
                turn_id     TEXT NOT NULL,
                seq         INTEGER NOT NULL,
                kind        TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                UNIQUE(turn_id, seq)
            );

            CREATE INDEX IF NOT EXISTS idx_turn_events_turn
                ON turn_events(turn_id, seq);
```

`CREATE TABLE IF NOT EXISTS` è idempotento → può stare nel batch senza guard.

- [ ] **Step 2.2: Aggiungi `broker_meta` al batch**

Subito dopo `turn_events`, nello stesso `execute_batch`:

```sql
            CREATE TABLE IF NOT EXISTS broker_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
```

- [ ] **Step 2.3: Verifica test esistenti ancora passano**

Run: `cargo test -p local-first-task-runtime`
Expected: tutti i test PASS (inclusi quelli del Task 1). Le nuove tabelle non rompono nulla.

- [ ] **Step 2.4: Commit**

```bash
git add crates/task-runtime/src/store.rs
git commit -m "feat(task-runtime): turn_events + broker_meta tables (broker Phase 0)

turn_events persiste lo stream di un turno (resume + working island).
broker_meta traccia process_generation per il recovery lease-aware."
```

---

## Task 3: Helper di accesso store per `turn_events`

**Files:**
- Modify: `crates/task-runtime/src/store.rs` (aggiungere metodi a `impl TaskStore`)

- [ ] **Step 3.1: Definisci i tipi `TurnEvent` e `TurnEventKind`**

In `types.rs` (dopo `AutomationRun` o in fondo, prima dei `pub struct TaskRecord`), aggiungi:

```rust
/// Una unità dello stream di un turno, persistita per il resume e la working island.
/// La semantica di `kind` rispecchia `liveWorkspace.ts` (replace su plan_update,
/// append su activity) — il client riduttore è preservato.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnEvent {
    pub event_id: i64,
    pub turn_id: String,
    pub seq: i64,
    pub kind: TurnEventKind,
    pub payload: Value,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnEventKind {
    Delta,
    Reasoning,
    Activity,
    PlanUpdate,
    Tool,
    Done,
    Error,
    Cancelled,
    Aborted,
}

impl TurnEventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            TurnEventKind::Delta => "delta",
            TurnEventKind::Reasoning => "reasoning",
            TurnEventKind::Activity => "activity",
            TurnEventKind::PlanUpdate => "plan_update",
            TurnEventKind::Tool => "tool",
            TurnEventKind::Done => "done",
            TurnEventKind::Error => "error",
            TurnEventKind::Cancelled => "cancelled",
            TurnEventKind::Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "delta" => Self::Delta,
            "reasoning" => Self::Reasoning,
            "activity" => Self::Activity,
            "plan_update" => Self::PlanUpdate,
            "tool" => Self::Tool,
            "done" => Self::Done,
            "error" => Self::Error,
            "cancelled" => Self::Cancelled,
            "aborted" => Self::Aborted,
            _ => return None,
        })
    }
}
```

- [ ] **Step 3.2: Aggiungi `insert_turn_event` a `impl TaskStore`**

In `store.rs`, dentro `impl TaskStore` (dopo `latest_checkpoint` per esempio), aggiungi:

```rust
    /// Accoda un evento al stream di un turno. Ritorna l'evento con seq/event_id assegnati.
    /// Il seq è monotono per turn_id (1-based). Usato dal broker per persistire ogni delta.
    pub fn insert_turn_event(
        &self,
        turn_id: &str,
        kind: TurnEventKind,
        payload: Value,
    ) -> TaskRuntimeResult<TurnEvent> {
        let now = OffsetDateTime::now_utc().unix_timestamp();
        // next seq per turn_id
        let seq: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM turn_events WHERE turn_id = ?1",
            params![turn_id],
            |row| row.get(0),
        )?;
        self.connection.execute(
            "INSERT INTO turn_events (turn_id, seq, kind, payload_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![turn_id, seq, kind.as_str(), serde_json::to_string(&payload)?, now],
        )?;
        let event_id = self.connection.last_insert_rowid();
        Ok(TurnEvent { event_id, turn_id: turn_id.to_string(), seq, kind, payload, created_at: now })
    }
```

Aggiorna gli `use` in cima a `store.rs`: il file importa già da `crate::{...}`; aggiungi `TurnEvent, TurnEventKind` a quella lista.

- [ ] **Step 3.3: Aggiungi `read_turn_events` (con `since`)**

Subito dopo `insert_turn_event`:

```rust
    /// Legge gli eventi di un turno con seq > since (per il resume dello stream).
    /// Ritornati in ordine di seq crescente.
    pub fn read_turn_events(&self, turn_id: &str, since: i64) -> TaskRuntimeResult<Vec<TurnEvent>> {
        let mut stmt = self.connection.prepare(
            "SELECT event_id, turn_id, seq, kind, payload_json, created_at
             FROM turn_events
             WHERE turn_id = ?1 AND seq > ?2
             ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![turn_id, since], |row| {
            let event_id: i64 = row.get(0)?;
            let turn_id: String = row.get(1)?;
            let seq: i64 = row.get(2)?;
            let kind_str: String = row.get(3)?;
            let payload_json: String = row.get(4)?;
            let created_at: i64 = row.get(5)?;
            Ok((event_id, turn_id, seq, kind_str, payload_json, created_at))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (event_id, turn_id, seq, kind_str, payload_json, created_at) = row?;
            let kind = TurnEventKind::parse(&kind_str)
                .ok_or_else(|| TaskRuntimeError::Store(format!("unknown turn_event kind: {kind_str}")))?;
            let payload: Value = serde_json::from_str(&payload_json)?;
            out.push(TurnEvent { event_id, turn_id, seq, kind, payload, created_at });
        }
        Ok(out)
    }
```

- [ ] **Step 3.4: Scrivi i test per `insert_turn_event` + `read_turn_events`**

Aggiungi un modulo test in fondo a `store.rs` (o estendi `migration_tests` con un nuovo modulo):

```rust
#[cfg(test)]
mod turn_event_tests {
    use super::*;
    use serde_json::json;

    fn store() -> TaskStore { TaskStore::open_in_memory().expect("open") }

    #[test]
    fn append_assigns_monotonic_seq_per_turn() {
        let s = store();
        let e1 = s.insert_turn_event("t1", TurnEventKind::Delta, json!({"text":"a"})).unwrap();
        let e2 = s.insert_turn_event("t1", TurnEventKind::Delta, json!({"text":"b"})).unwrap();
        let e3 = s.insert_turn_event("t2", TurnEventKind::Delta, json!({"text":"other"})).unwrap();
        assert_eq!(e1.seq, 1);
        assert_eq!(e2.seq, 2);
        assert_eq!(e3.seq, 1, "seq is per turn_id, independent across turns");
    }

    #[test]
    fn read_since_returns_only_newer_in_order() {
        let s = store();
        s.insert_turn_event("t1", TurnEventKind::Delta, json!({"i":1})).unwrap();
        s.insert_turn_event("t1", TurnEventKind::Activity, json!({"i":2})).unwrap();
        s.insert_turn_event("t1", TurnEventKind::PlanUpdate, json!({"i":3})).unwrap();
        let since1 = s.read_turn_events("t1", 1).unwrap();
        assert_eq!(since1.len(), 2);
        assert_eq!(since1[0].seq, 2);
        assert_eq!(since1[1].seq, 3);
        let since0 = s.read_turn_events("t1", 0).unwrap();
        assert_eq!(since0.len(), 3);
        assert_eq!(since0[2].kind, TurnEventKind::PlanUpdate);
    }

    #[test]
    fn kind_round_trips() {
        let s = store();
        for k in [TurnEventKind::Delta, TurnEventKind::Aborted, TurnEventKind::Cancelled] {
            s.insert_turn_event("t", k, json!({})).unwrap();
        }
        let events = s.read_turn_events("t", 0).unwrap();
        assert_eq!(events.iter().map(|e| e.kind).collect::<Vec<_>>(),
                   vec![TurnEventKind::Delta, TurnEventKind::Aborted, TurnEventKind::Cancelled]);
    }
}
```

- [ ] **Step 3.5: Esegui i test**

Run: `cargo test -p local-first-task-runtime turn_event_tests -- --nocapture`
Expected: PASS (3 test).

- [ ] **Step 3.6: Commit**

```bash
git add crates/task-runtime/src/store.rs crates/task-runtime/src/types.rs
git commit -m "feat(task-runtime): turn_events store API (insert + read_since)

insert_turn_event assegna seq monotono per turn_id; read_turn_events
recupera gli eventi con seq > since per il resume dello stream.
Tipi TurnEvent + TurnEventKind (serde snake_case, parse round-trip)."
```

---

## Task 4: `broker_meta` — process generation

**Files:**
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 4.1: Aggiungi `bump_process_generation` + `get_process_generation`**

In `impl TaskStore`, dopo i metodi `turn_events`:

```rust
    /// Incrementa e persiste la process_generation. Da chiamare UNA volta all'avvio del
    /// processo, prima di qualsiasi acquire. Identifica univocamente questa incarnazione
    /// del processo: i lease scritti da generation precedenti sono stale al boot.
    pub fn bump_process_generation(&self) -> TaskRuntimeResult<u64> {
        // read-modify-write in una sola tx esplicita (atomicità sul meta).
        let tx = self.connection.unchecked_transaction()?;
        let current: Option<String> = tx
            .query_row(
                "SELECT value FROM broker_meta WHERE key = 'process_generation'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let next: u64 = current
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1);
        tx.execute(
            "INSERT INTO broker_meta (key, value) VALUES ('process_generation', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![next.to_string()],
        )?;
        tx.commit()?;
        Ok(next)
    }

    /// La generation attualmente persistita (l'ultima che ha fatto bump).
    pub fn get_process_generation(&self) -> TaskRuntimeResult<u64> {
        let value: Option<String> = self.connection
            .query_row(
                "SELECT value FROM broker_meta WHERE key = 'process_generation'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        Ok(value.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0))
    }
```

- [ ] **Step 4.2: Test di monotonia e persistenza**

```rust
#[cfg(test)]
mod generation_tests {
    use super::*;

    #[test]
    fn bump_is_monotonic() {
        let s = TaskStore::open_in_memory().unwrap();
        assert_eq!(s.bump_process_generation().unwrap(), 1);
        assert_eq!(s.bump_process_generation().unwrap(), 2);
        assert_eq!(s.get_process_generation().unwrap(), 2);
    }
}
```

- [ ] **Step 4.3: Esegui e commit**

Run: `cargo test -p local-first-task-runtime generation_tests -- --nocapture`
Expected: PASS.

```bash
git add crates/task-runtime/src/store.rs
git commit -m "feat(task-runtime): process_generation in broker_meta

bump_process_generation incrementa e persiste atomicamente; identifica
l'incarnazione del processo per il recovery lease-aware (Fase 1)."
```

---

## Task 5: Query di appartenenza thread + helper `chat_turn` su `TaskStore`

**Files:**
- Modify: `crates/task-gateway/src/store.rs`

- [ ] **Step 5.1: Aggiungi `active_chat_turn_for_thread`**

Questa è la query che alimenta il 409-per-thread. In `impl TaskStore`:

```rust
    /// Ritorna il task_id del chat_turn attivo (queued/running) per un thread, se esiste.
    /// Usato dall'enqueue per il vincolo 1-turno-per-thread (409 se busy).
    /// Usa l'indice parziale idx_tasks_chat_turn_thread.
    pub fn active_chat_turn_for_thread(&self, thread_id: &str) -> TaskRuntimeResult<Option<String>> {
        let task_id: Option<String> = self.connection
            .query_row(
                "SELECT task_id FROM tasks
                 WHERE thread_id = ?1 AND kind = 'chat_turn'
                   AND status IN ('queued', 'running')
                 LIMIT 1",
                params![thread_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(task_id)
    }
```

- [ ] **Step 5.2: Aggiungi `insert_chat_turn` che scrive anche le colonne indicizzate**

Il `insert_task` esistente scrive solo le colonne originali. Aggiungiamo un metodo specializzato che popola anche `thread_id`/`request_id`/`source`/`approval`:

```rust
    /// Inserisce un chat_turn popolando anche le colonni indicizzate (thread_id, request_id,
    /// source, approval). Il task_json nel blob (gestito da insert_task) resta la source of
    /// truth per i campi non indicizzati.
    pub fn insert_chat_turn(
        &self,
        task: &TaskRecord,
        thread_id: &str,
        request_id: &str,
        source: &str,
        approval: &str,
    ) -> TaskRuntimeResult<()> {
        // prima insert_task (blob + colonne base), poi update delle colonne chat_turn
        self.insert_task(task)?;
        self.connection.execute(
            "UPDATE tasks SET thread_id = ?1, request_id = ?2, source = ?3, approval = ?4
             WHERE task_id = ?5 AND user_id = ?6 AND workspace_id = ?7",
            params![
                thread_id, request_id, source, approval,
                task.task_id.as_str(), task.user_id.as_str(), task.workspace_id.as_str(),
            ],
        )?;
        Ok(())
    }
```

- [ ] **Step 5.3: Test di `active_chat_turn_for_thread`**

```rust
#[cfg(test)]
mod chat_turn_query_tests {
    use super::*;
    use crate::{TaskPriority, TaskRecord};
    use serde_json::json;

    fn store() -> TaskStore { TaskStore::open_in_memory().unwrap() }

    fn make_chat_turn(task_id: &str, thread_id: &str, status: TaskStatus) -> TaskRecord {
        let mut t = TaskRecord::new(
            task_id,
            UserId::new("u"), WorkspaceId::new("w"),
            "chat_turn", format!("prompt for {thread_id}"),
            json!({}),
        );
        t.status = status;
        t.priority = TaskPriority::High;
        t
    }

    #[test]
    fn active_chat_turn_returns_none_when_empty() {
        let s = store();
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap(), None);
    }

    #[test]
    fn active_chat_turn_finds_queued_or_running() {
        let s = store();
        let t1 = make_chat_turn("t1", "thread_x", TaskStatus::Queued);
        s.insert_chat_turn(&t1, "thread_x", "chat_stream_1", "interactive", "full").unwrap();
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap().as_deref(), Some("t1"));

        // un secondo thread non collide
        let t2 = make_chat_turn("t2", "thread_y", TaskStatus::Running);
        s.insert_chat_turn(&t2, "thread_y", "chat_stream_2", "interactive", "full").unwrap();
        assert_eq!(s.active_chat_turn_for_thread("thread_y").unwrap().as_deref(), Some("t2"));
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap().as_deref(), Some("t1"));
    }

    #[test]
    fn active_chat_turn_ignores_completed() {
        let s = store();
        let t = make_chat_turn("t1", "thread_x", TaskStatus::Completed);
        s.insert_chat_turn(&t, "thread_x", "chat_stream_1", "interactive", "full").unwrap();
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap(), None,
            "completed turns do not block a new enqueue");
    }

    #[test]
    fn active_chat_turn_ignores_non_chat_turn_kind() {
        let s = store();
        let mut other = TaskRecord::new(
            "bg1", UserId::new("u"), WorkspaceId::new("w"),
            "background_job", "do thing", json!({}),
        );
        other.status = TaskStatus::Running;
        s.insert_task(&other).unwrap();
        // anche se thread_id fosse settato, kind != chat_turn → ignorato
        s.connection.execute(
            "UPDATE tasks SET thread_id = 'thread_x' WHERE task_id = 'bg1'", []).unwrap();
        assert_eq!(s.active_chat_turn_for_thread("thread_x").unwrap(), None);
    }
}
```

- [ ] **Step 5.4: Esegui e commit**

Run: `cargo test -p local-first-task-runtime chat_turn_query_tests -- --nocapture`
Expected: PASS (4 test).

```bash
git add crates/task-runtime/src/store.rs
git commit -m "feat(task-runtime): chat_turn query + insert helpers

active_chat_turn_for_thread usa l'indice parziale per il vincolo
1-turno-per-thread. insert_chat_turn popola le colonne indicizzate
(thread_id, request_id, source, approval)."
```

---

## Task 6: Modulo `broker` — enqueue transazionale con 409

**Files:**
- Create: `crates/task-runtime/src/broker.rs`
- Modify: `crates/task-runtime/src/lib.rs` (dichiarazione modulo + re-export)

- [ ] **Step 6.1: Crea `broker.rs` con i tipi dell'input + error**

```rust
//! Turn broker: orchestrazione del lifecycle dei chat_turn nello store.
//! Phase 0: primitive sincrone testabili. Phase 1 le wrappa in un executor async.

use crate::{
    ChatTurnSource, TaskId, TaskPriority, TaskRecord, TaskStatus, TaskStore, TaskRuntimeError,
    TaskRuntimeResult, TurnEventKind, UserId, WorkspaceId,
};
use serde_json::{json, Value};
use time::OffsetDateTime;

/// L'input di un nuovo chat_turn. Prompt embedded per atomicità.
#[derive(Debug, Clone)]
pub struct ChatTurnInput {
    pub thread_id: String,
    pub request_id: String,
    pub prompt: String,
    pub visible_prompt: Option<String>,
    pub attachments: Option<Value>,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub source: ChatTurnSource,
    pub approval: TurnApproval,
}

/// Origine del turno. Discriminatore per executor + visibility nella coda.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTurnSource {
    Interactive,
    Automation,
    Channel,
    Connector,
}

impl ChatTurnSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Interactive => "interactive",
            Self::Automation => "automation",
            Self::Channel => "channel",
            Self::Connector => "connector",
        }
    }
}

/// Policy degli effetti ammessi. Mappa input_json.approval dell'executor esistente.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnApproval {
    Full,       // turni interattivi
    Confirm,    // automation con ApprovalPolicy::Confirm
    Autonomous, // automation con ApprovalPolicy::Autonomous
    ReadOnly,
}

impl TurnApproval {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Confirm => "confirm",
            Self::Autonomous => "autonomous",
            Self::ReadOnly => "read_only",
        }
    }
}

/// Errore di enqueue. ThreadBusy = 409 nel gateway.
#[derive(Debug)]
pub enum EnqueueError {
    ThreadBusy { thread_id: String, active_turn_id: String },
    Store(TaskRuntimeError),
}

impl From<TaskRuntimeError> for EnqueueError {
    fn from(e: TaskRuntimeError) -> Self { Self::Store(e) }
}

impl std::fmt::Display for EnqueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ThreadBusy { thread_id, active_turn_id } => write!(
                f, "thread {thread_id} already has an active turn ({active_turn_id})"
            ),
            Self::Store(e) => write!(f, "store error: {e}"),
        }
    }
}

impl std::error::Error for EnqueueError {}

/// Risultato di un enqueue riuscito.
#[derive(Debug, Clone)]
pub struct EnqueuedTurn {
    pub task_id: TaskId,
    pub thread_id: String,
    pub position_in_queue: u32,
}

/// Genera il task_id di un chat_turn. Stabile, debuggable.
pub fn chat_turn_task_id(request_id: &str) -> TaskId {
    // request_id è già univoco ("chat_stream_<ts>_<rand>" o "autorun_<uuid>");
    // usiamolo come base per il task_id, così il join turn_id ↔ request_id è diretto.
    TaskId::new(format!("turn_{request_id}"))
}

/// Enqueue transazionale: INSERT task(queued) + check vincolo 1-turno-per-thread.
/// Ritorna ThreadBusy se il thread ha già un chat_turn attivo.
pub fn enqueue_chat_turn(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    input: &ChatTurnInput,
) -> Result<EnqueuedTurn, EnqueueError> {
    // check preventivo (anche se c'è una race, la transazione sotto rafforza; il check
    // qui è per dare un errore chiaro prima di costruire il task).
    if let Some(active) = store.active_chat_turn_for_thread(&input.thread_id)? {
        return Err(EnqueueError::ThreadBusy {
            thread_id: input.thread_id.clone(),
            active_turn_id: active,
        });
    }

    let task_id = chat_turn_task_id(&input.request_id);
    let now = OffsetDateTime::now_utc();
    let input_json = json!({
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
        task_id.as_str(),
        user_id.clone(),
        workspace_id.clone(),
        "chat_turn",
        input.prompt.clone(),
        input_json,
    );
    task.status = TaskStatus::Queued;
    task.priority = match input.source {
        ChatTurnSource::Interactive => TaskPriority::High,
        ChatTurnSource::Channel => TaskPriority::Low,
        ChatTurnSource::Automation | ChatTurnSource::Connector => TaskPriority::Background,
    };
    task.created_at = now;
    task.updated_at = now;

    store.insert_chat_turn(
        &task,
        &input.thread_id,
        &input.request_id,
        input.source.as_str(),
        input.approval.as_str(),
    )?;

    // double-check post-insert: se una race ha inserito un secondo turno concorrente
    // per lo stesso thread, torniamo indietro. La SELECT + INSERT non è nella stessa
    // transazione qui (SQLite serialized aiuta ma non garantisce sotto WAL); il
    // double-check gestisce l'edge case in single-process.
    let actives = store.active_chat_turn_for_thread(&input.thread_id)?;
    if let Some(a) = actives {
        if a != task.task_id.as_str() {
            // race persa: un altro turno è subentrato. Rimuovi il nostro e ritorna busy.
            // (in single-process con mutex esterno questo non capita mai; tenuto per difesa)
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

    let position_in_queue = count_queued_chat_turns_for_thread(store, user_id, workspace_id, &input.thread_id)?;

    Ok(EnqueuedTurn { task_id, thread_id: input.thread_id.clone(), position_in_queue })
}

fn count_queued_chat_turns_for_thread(
    store: &TaskStore,
    _user_id: &UserId,
    _workspace_id: &WorkspaceId,
    thread_id: &str,
) -> TaskRuntimeResult<u32> {
    // helper privato: conta i chat_turn queued per dare un position_in_queue approssimativo.
    // (Sempre 0 o 1 con il vincolo 1-per-thread; tenuto per future estensioni FIFO multi.)
    let _ = store;
    let _ = thread_id;
    Ok(0)
}
```

**Nota:** il check `count_queued_chat_turns_for_thread` torna sempre 0 perché con 1-per-thread la coda è vuota o ha il turno appena inserito. È un placeholder onesto per la Fase 0 (la posizione in coda diventa rilevante se in futuro si rilassa il vincolo). Documentato.

- [ ] **Step 6.2: Testa l'enqueue con 409**

In fondo a `broker.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TaskStore, UserId, WorkspaceId};

    fn store() -> TaskStore { TaskStore::open_in_memory().unwrap() }
    fn input(request_id: &str, thread_id: &str) -> ChatTurnInput {
        ChatTurnInput {
            thread_id: thread_id.to_string(),
            request_id: request_id.to_string(),
            prompt: "hi".into(),
            visible_prompt: None,
            attachments: None,
            mode: None,
            model: None,
            source: ChatTurnSource::Interactive,
            approval: TurnApproval::Full,
        }
    }

    #[test]
    fn enqueue_succeeds_on_idle_thread() {
        let s = store();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        assert_eq!(r.thread_id, "t1");
        assert_eq!(r.task_id.as_str(), "turn_r1");
    }

    #[test]
    fn enqueue_returns_thread_busy_on_second_active_turn() {
        let s = store();
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        let err = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r2", "t1")).unwrap_err();
        match err {
            EnqueueError::ThreadBusy { thread_id, active_turn_id } => {
                assert_eq!(thread_id, "t1");
                assert_eq!(active_turn_id, "turn_r1");
            }
            other => panic!("expected ThreadBusy, got {other:?}"),
        }
    }

    #[test]
    fn enqueue_again_after_completion_succeeds() {
        let s = store();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        s.update_task_status(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w"),
                             TaskStatus::Completed, None).unwrap();
        // ora un nuovo enqueue sullo stesso thread deve passare
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r2", "t1"))
            .expect("enqueue succeeds after previous turn completed");
    }

    #[test]
    fn different_threads_do_not_collide() {
        let s = store();
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r1", "t1")).unwrap();
        enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &input("r2", "t2"))
            .expect("different threads are independent");
    }
}
```

- [ ] **Step 6.3: Registra il modulo in `lib.rs`**

Apri `crates/task-runtime/src/lib.rs`. Trova le dichiarazioni `mod` e aggiungi `pub mod broker;`. Trova il blocco `pub use` e aggiungi i nuovi tipi pubblici:

```rust
pub mod broker;
pub use broker::{ChatTurnInput, ChatTurnSource, EnqueueError, EnqueuedTurn, TurnApproval, chat_turn_task_id};
```

E in `types.rs`, esporta `ChatTurnSource` lì (o nel modulo `broker` come sopra). **Decisione:** tenerlo in `broker` (più coeso); non inquinare `types.rs`. Quindi nel `pub use` sopra NON includere `ChatTurnSource` due volte (è già nel path `broker::`).

**Verifica compilazione**: il `broker.rs` importa `ChatTurnSource` da `crate::{...}` ma l'abbiamo definito _dentro_ `broker`. Correggi l'`use` in cima a `broker.rs` rimuovendo `ChatTurnSource` dalla lista di `crate::{...}` (è definito nello stesso file).

- [ ] **Step 6.4: Esegui i test**

Run: `cargo test -p local-first-task-runtime broker::tests -- --nocapture`
Expected: PASS (4 test). Se ci sono errori di borrow/import, correggi (verifica i path dei tipi: `UserId`, `WorkspaceId`, `TaskId`, `TaskStatus`, `TaskPriority`, `TaskRecord`, `TaskStore`, `TaskRuntimeError`, `TaskRuntimeResult`, `TurnEventKind` sono tutti in `crate::{}`).

- [ ] **Step 6.5: Commit**

```bash
git add crates/task-runtime/src/broker.rs crates/task-runtime/src/lib.rs
git commit -m "feat(task-runtime): broker module — enqueue with 1-turn-per-thread (409)

enqueue_chat_turn: transazionale, ritorna EnqueueError::ThreadBusy se il
thread ha già un chat_turn queued/running. TaskId derivato da request_id
(join diretto). Priority mapping: interactive=High, channel=Low,
automation/connector=Background."
```

---

## Task 7: Recovery lease-aware con process generation

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`

- [ ] **Step 7.1: Aggiungi `recover_chat_turns_at_boot`**

In `broker.rs`:

```rust
use time::OffsetDateTime;

/// Recovery lease-aware al boot. Da chiamare DOPO bump_process_generation.
///
/// Regola: ogni chat_turn Running il cui lease_owner NON appartiene alla generation
/// attuale è stale (il processo che lo teneva è morto). Lo rimettiamo in Queued,
/// azzeriamo il lease, e scriviamo un evento `aborted` in turn_events (così un client
/// ricollegato sa di scartare i delta precedenti dell'esecuzione abortita).
///
/// In single-process oggi: tutti i Running hanno generation precedente (siamo appena
/// partiti) → tutti tornano in Queued. Rispetta il LeaseManager anche in multi-process.
pub fn recover_chat_turns_at_boot(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    current_generation: u64,
) -> TaskRuntimeResult<Vec<TaskId>> {
    let mut recovered = Vec::new();
    for mut task in store.list_tasks(user_id, workspace_id)? {
        if task.kind != "chat_turn" || task.status != TaskStatus::Running {
            continue;
        }
        // lease_owner ha forma "<generation>:<worker_id>". Se la generation è quella
        // attuale, il worker è (teoricamente) ancora attivo: non toccare. In single-process
        // appena partiti questo ramo è impossibile — il controllo è per difesa futura.
        let owned_by_current = task
            .lease_owner
            .as_deref()
            .and_then(|o| o.split(':').next())
            .map(|g| g.parse::<u64>().ok() == Some(current_generation))
            .unwrap_or(false);
        if owned_by_current {
            continue;
        }

        // rilascia risorse, azzera lease, rimetti in coda
        store.release_resources(&task)?;
        task.status = TaskStatus::Queued;
        task.lease_owner = None;
        task.lease_expires_at = None;
        task.last_heartbeat_at = None;
        task.blocked_reason = Some("recovered at boot (stale lease)".into());
        task.updated_at = OffsetDateTime::now_utc();
        let task_id = task.task_id.clone();
        store.insert_chat_turn(
            &task,
            task.input_json.get("thread_id").and_then(|v| v.as_str()).unwrap_or(""),
            task.input_json.get("request_id").and_then(|v| v.as_str()).unwrap_or(""),
            task.input_json.get("source").and_then(|v| v.as_str()).unwrap_or("interactive"),
            task.input_json.get("approval").and_then(|v| v.as_str()).unwrap_or("full"),
        )?;

        // segnaposto aborted: il client ricollegato scarta i delta precedenti
        let turn_id = task_id.as_str().to_string();
        store.insert_turn_event(
            &turn_id,
            TurnEventKind::Aborted,
            serde_json::json!({
                "reason": "lease_expired_at_boot",
                "generation": current_generation,
            }),
        )?;

        recovered.push(task_id);
    }
    Ok(recovered)
}
```

- [ ] **Step 7.2: Test di recovery**

```rust
#[cfg(test)]
mod recovery_tests {
    use super::*;
    use crate::{TaskStore, UserId, WorkspaceId, broker::*, TaskRecord};
    use serde_json::json;
    use time::Duration;

    fn store() -> TaskStore { TaskStore::open_in_memory().unwrap() }

    fn seed_running_with_generation(store: &TaskStore, gen: u64) -> TaskId {
        // inserisce un chat_turn Running con lease_owner della generation indicata
        let mut t = TaskRecord::new(
            "turn_stale", UserId::new("u"), WorkspaceId::new("w"),
            "chat_turn", "prompt", json!({"thread_id":"t1","request_id":"r1","source":"interactive","approval":"full"}),
        );
        t.status = TaskStatus::Running;
        t.lease_owner = Some(format!("{gen}:worker_0"));
        t.lease_expires_at = Some(time::OffsetDateTime::now_utc() + Duration::minutes(5));
        store.insert_chat_turn(&t, "t1", "r1", "interactive", "full").unwrap();
        TaskId::new("turn_stale")
    }

    #[test]
    fn recover_requeues_stale_running_from_previous_generation() {
        let s = store();
        seed_running_with_generation(&s, 1);
        let gen = s.bump_process_generation().unwrap(); // ora gen = 1 (fresh boot simulato: ma noi vogliamo gen attuale = 2)
        // per simulare "siamo la generation 2 e il lease è della 1":
        let gen_now = s.bump_process_generation().unwrap();
        assert_eq!(gen_now, 2);
        let recovered = recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen_now).unwrap();
        assert_eq!(recovered.len(), 1);
        // ora è Queued
        let t = s.get_task(&TaskId::new("turn_stale"), &UserId::new("u"), &WorkspaceId::new("w")).unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Queued);
        assert!(t.lease_owner.is_none());
        // ed è stato scritto l'evento aborted
        let events = s.read_turn_events("turn_stale", 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, TurnEventKind::Aborted);
    }

    #[test]
    fn recover_does_not_touch_current_generation_running() {
        let s = store();
        let gen_now = s.bump_process_generation().unwrap(); // 1
        seed_running_with_generation(&s, gen_now); // lease della generation attuale
        let recovered = recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen_now).unwrap();
        assert!(recovered.is_empty(), "current-generation leases are left alone");
    }

    #[test]
    fn recover_ignores_completed_chat_turns() {
        let s = store();
        let mut t = TaskRecord::new(
            "turn_done", UserId::new("u"), WorkspaceId::new("w"),
            "chat_turn", "prompt", json!({"thread_id":"t1","request_id":"r2","source":"interactive","approval":"full"}),
        );
        t.status = TaskStatus::Completed;
        s.insert_chat_turn(&t, "t1", "r2", "interactive", "full").unwrap();
        let gen = s.bump_process_generation().unwrap();
        let recovered = recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen).unwrap();
        assert!(recovered.is_empty());
    }

    #[test]
    fn recover_ignores_non_chat_turn_running() {
        let s = store();
        let mut other = TaskRecord::new(
            "bg1", UserId::new("u"), WorkspaceId::new("w"),
            "background_job", "thing", json!({}),
        );
        other.status = TaskStatus::Running;
        s.insert_task(&other).unwrap();
        let gen = s.bump_process_generation().unwrap();
        let recovered = recover_chat_turns_at_boot(&s, &UserId::new("u"), &WorkspaceId::new("w"), gen).unwrap();
        assert!(recovered.is_empty(), "non-chat_turn tasks are not the broker's business");
    }
}
```

- [ ] **Step 7.3: Esegui e commit**

Run: `cargo test -p local-first-task-runtime recovery_tests -- --nocapture`
Expected: PASS (4 test).

```bash
git add crates/task-runtime/src/broker.rs
git commit -m "feat(task-runtime): recover_chat_turns_at_boot (lease-aware)

Recovery lease-aware con process generation. Running chat_turn con lease
di generation precedente → Queued + evento aborted. In single-process oggi
tutti i Running tornano in Queued (siamo appena partiti). Rispetta i lease
della generation attuale (difesiva per multi-process futuro)."
```

---

## Task 8: Cancellation primitive (DB flag + notice hook)

**Files:**
- Modify: `crates/task-runtime/src/broker.rs`

- [ ] **Step 8.1: Aggiungi `cancel_chat_turn` (DB flag) + `mark_chat_turn_event`**

In `broker.rs`. La cancellation completa è ibrida (DB flag + Notify in-process). Il Notify vive nel gateway (Fase 1), qui forniamo solo la primitiva store-side + un hook astratto per il notify:

```rust
/// Hook di notifica cancel: il gateway (Fase 1) lo implementa con un tokio::sync::Notify
/// per-turn_id nel registry degli executor attivi. Phase 0: no-op default.
/// L'executor riceve il cancel via questo canale (istantaneo) + via DB poll (fallback).
pub trait CancelNotify: Send + Sync {
    fn notify_cancel(&self, turn_id: &str);
}

/// Cancel no-op di default (Phase 0: il notify è in-process nel gateway, non qui).
pub struct NoopCancelNotify;
impl CancelNotify for NoopCancelNotify {
    fn notify_cancel(&self, _turn_id: &str) {}
}

/// Marca un chat_turn come Cancelled (source of truth durevole) e notifica l'executor
/// in-process via hook. Idempotente: se già terminal (Completed/Failed/Cancelled) è no-op.
/// Scrive un evento cancelled in turn_events per i subscriber.
pub fn cancel_chat_turn(
    store: &TaskStore,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    task_id: &TaskId,
    notify: &dyn CancelNotify,
) -> TaskRuntimeResult<bool> {
    let Some(mut task) = store.get_task(task_id, user_id, workspace_id)? else {
        return Ok(false);
    };
    if matches!(task.status, TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled) {
        return Ok(false); // idempotente
    }
    let now = OffsetDateTime::now_utc();
    task.status = TaskStatus::Cancelled;
    task.blocked_reason = Some("cancelled by user/server".into());
    task.updated_at = now;
    let thread_id = task.input_json.get("thread_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let request_id = task.input_json.get("request_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let source = task.input_json.get("source").and_then(|v| v.as_str()).unwrap_or("interactive");
    let approval = task.input_json.get("approval").and_then(|v| v.as_str()).unwrap_or("full");
    store.insert_chat_turn(&task, &thread_id, &request_id, source, approval)?;
    store.insert_turn_event(
        task_id.as_str(),
        TurnEventKind::Cancelled,
        serde_json::json!({ "reason": "user_cancel", "at": now.unix_timestamp() }),
    )?;
    // notifica l'executor in-process (istantaneo); no-op se non attivo
    notify.notify_cancel(task_id.as_str());
    Ok(true)
}
```

- [ ] **Step 8.2: Test cancellation**

```rust
#[cfg(test)]
mod cancel_tests {
    use super::*;
    use crate::{TaskStore, UserId, WorkspaceId, broker::*, TaskStatus};
    use std::sync::{Arc, Mutex};

    struct RecordingNotify { turns: Arc<Mutex<Vec<String>>> }
    impl CancelNotify for RecordingNotify {
        fn notify_cancel(&self, turn_id: &str) { self.turns.lock().unwrap().push(turn_id.into()); }
    }

    #[test]
    fn cancel_marks_cancelled_and_writes_event_and_notifies() {
        let s = TaskStore::open_in_memory().unwrap();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"),
            &ChatTurnInput { thread_id: "t1".into(), request_id: "r1".into(), prompt: "hi".into(),
                visible_prompt: None, attachments: None, mode: None, model: None,
                source: ChatTurnSource::Interactive, approval: TurnApproval::Full }).unwrap();
        let turns = Arc::new(Mutex::new(Vec::new()));
        let notify = RecordingNotify { turns: turns.clone() };
        let ok = cancel_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &r.task_id, &notify).unwrap();
        assert!(ok);
        let t = s.get_task(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w")).unwrap().unwrap();
        assert_eq!(t.status, TaskStatus::Cancelled);
        let events = s.read_turn_events(&r.task_id.as_str(), 0).unwrap();
        assert!(events.iter().any(|e| e.kind == TurnEventKind::Cancelled));
        assert_eq!(turns.lock().unwrap().clone(), vec![r.task_id.as_str().to_string()]);
    }

    #[test]
    fn cancel_is_idempotent_on_terminal() {
        let s = TaskStore::open_in_memory().unwrap();
        let r = enqueue_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"),
            &ChatTurnInput { thread_id: "t1".into(), request_id: "r1".into(), prompt: "hi".into(),
                visible_prompt: None, attachments: None, mode: None, model: None,
                source: ChatTurnSource::Interactive, approval: TurnApproval::Full }).unwrap();
        s.update_task_status(&r.task_id, &UserId::new("u"), &WorkspaceId::new("w"),
            TaskStatus::Completed, None).unwrap();
        let notify = NoopCancelNotify;
        let ok = cancel_chat_turn(&s, &UserId::new("u"), &WorkspaceId::new("w"), &r.task_id, &notify).unwrap();
        assert!(!ok, "no-op on already-terminal turn");
    }
}
```

- [ ] **Step 8.3: Esegui e commit**

Run: `cargo test -p local-first-task-runtime cancel_tests -- --nocapture`
Expected: PASS (2 test).

```bash
git add crates/task-runtime/src/broker.rs
git commit -m "feat(task-runtime): cancel_chat_turn primitive (DB flag + notify hook)

Cancellation durevole: status=Cancelled + evento cancelled + hook CancelNotify.
Idempotente sui terminali. Il notify in-process (tokio Notify) è nel gateway,
qui è astratto via trait (NoopCancelNotify di default in Phase 0)."
```

---

## Task 9: Feature flag `HOMUN_TURN_BROKER` nel gateway

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 9.1: Aggiungi l'helper `turn_broker_enabled`**

Trova un punto coerente con gli altri env helper (vicino a `task_executor_worker_enabled` ~`main.rs:32772-32779` o `max_concurrent_turns`). Aggiungi:

```rust
/// Feature flag per il turn broker. Default OFF in Phase 0 (nessun behavior change).
/// ON abilita il path broker per i chat_turn (Phase 1). Letto una volta all'avvio.
fn turn_broker_enabled() -> bool {
    matches!(
        std::env::var("HOMUN_TURN_BROKER").as_deref(),
        Ok("1") | Ok("on") | Ok("true")
    )
}
```

- [ ] **Step 9.2: Logga lo stato del flag al boot**

Trova il blocco di log iniziali in `main` (vicino ad altri `tracing::info!` di startup) e aggiungi:

```rust
tracing::info!("turn broker: enabled={} (HOMUN_TURN_BROKER); Phase 0 = foundation primitives only", turn_broker_enabled());
```

- [ ] **Step 9.3: Verifica che il gateway compili**

Run: `cargo check -p homun-desktop-gateway`
Expected: compilazione OK. Il flag è predisposto ma non ancora usato per deviare il flusso (sarà la Fase 1 a usarlo).

- [ ] **Step 9.4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): HOMUN_TURN_BROKER feature flag (Phase 0, default off)

Predisposizione del flag. Default off = nessun behavior change. Phase 1 lo
userà per deviare i chat_turn nel broker. Loggato al boot per diagnostica."
```

---

## Task 10: Self-review e smoke test finale

- [ ] **Step 10.1: Esegui TUTTI i test del crate `task-runtime`**

Run: `cargo test -p local-first-task-runtime`
Expected: tutti i test PASS (incluse le suite esistenti che non devono regredire).

- [ ] **Step 10.2: Verifica la migrazione su un DB esistente (simulazione)**

Crea un test di integrazione (o uno script) che apre un DB pre-migrazione (con `schema_version='3'`, niente colonne `chat_turn`) e verifica che `run_migrations()` lo porti a `'4'` senza perdere dati:

```rust
#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn upgrades_v3_to_v4_adding_chat_turn_cols() {
        // crea un DB con schema v3 (senza le colonne chat_turn)
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            CREATE TABLE task_runtime_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO task_runtime_metadata VALUES ('schema_version', '3');
            CREATE TABLE tasks (
                task_id TEXT NOT NULL, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
                workflow_id TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL,
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                blocked_reason TEXT, task_json TEXT NOT NULL,
                PRIMARY KEY (task_id, user_id, workspace_id)
            );
            INSERT INTO tasks VALUES ('t', 'u', 'w', NULL, 'old_kind', 'queued', 'normal',
                                      1, 1, NULL, '{}');
        ").unwrap();
        // salva e riapri come TaskStore per runnare le migrazioni
        let tmp = tempfile::NamedTempFile::new().unwrap();
        conn.execute_batch(&format!("VACUUM INTO '{}'", tmp.path().display())).unwrap();
        let store = TaskStore::open(tmp.path()).unwrap();
        assert_eq!(store.schema_version().unwrap(), 4);
        for col in ["thread_id", "request_id", "source", "approval"] {
            assert!(column_exists(&store.connection, "tasks", col));
        }
        // dato esistente preservato
        let t = store.get_task(&TaskId::new("t"), &UserId::new("u"), &WorkspaceId::new("w")).unwrap().unwrap();
        assert_eq!(t.kind, "old_kind");
    }
}
```

Se `tempfile` non è una dev-dependency di `task-runtime`, aggiungila in `Cargo.toml` sotto `[dev-dependencies]`, oppure usa un path in `std::env::temp_dir()` con un nome univoco per evitare la dipendenza.

- [ ] **Step 10.3: Verifica `cargo build` dell'intero workspace**

Run: `cargo build --workspace`
Expected: compilazione OK senza warning nuovi.

- [ ] **Step 10.4: Commit finale della Fase 0**

```bash
git add -A
git commit -m "test(task-runtime): upgrade v3→v4 preserves existing data

Smoke test: apertura di un DB v3, migrazione a v4, verifica che le righe
esistenti siano preservate e le colonne chat_turn presenti. Fase 0 completa."
```

---

## Definition of Done — Fase 0

- [ ] Schema `tasks` esteso con `thread_id`, `request_id`, `source`, `approval` + indice parziale `idx_tasks_chat_turn_thread`; `schema_version = 4`.
- [ ] Tabelle `turn_events` e `broker_meta` create.
- [ ] Store API: `insert_turn_event`, `read_turn_events`, `bump_process_generation`, `get_process_generation`, `active_chat_turn_for_thread`, `insert_chat_turn`.
- [ ] Modulo `broker`: `enqueue_chat_turn` (con `EnqueueError::ThreadBusy`), `recover_chat_turns_at_boot`, `cancel_chat_turn`, tipi `ChatTurnInput`/`ChatTurnSource`/`TurnApproval`/`EnqueuedTurn`/`CancelNotify`.
- [ ] Tutti i test PASS; migrazione v3→v4 verificata non distruttiva.
- [ ] Feature flag `HOMUN_TURN_BROKER` predisposto nel gateway (default off).
- [ ] **Nessun behavior change in produzione** (tutto dietro flag + nessun collegamento attivo al flusso chat esistente).

## Cosa NON è in questo piano (Fasi successive)

- **Fase 1**: collegare `generate_stream` al broker (thin shim), estendere il worker pool a `chat_turn`, estendere `run_agent_turn_into_message` con fan-out su `turn_events` + broadcast, rimuovere `turn_priority` semaforo + `browse_web_lock`, browser preemption nel governor, HTTP API `POST /turns` + `GET /turns/{id}/stream`.
- **Fase 2**: migrazione client a nuovo path, rimozione `promptSubmitting` come source of truth, working island alimentata da `turn_events`, cleanup `wait_if_busy` + `generate_stream` shim.
- **Fase 3**: multi-process, WebSocket multiplex, backpressure, working island multi-thread.

Ogni Fase è un piano separato con la propria Definition of Done.
