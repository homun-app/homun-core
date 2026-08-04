# Working Island — sincronizzazione live durevole (cross-turn) — Implementation Plan

> **For agentic workers:** eseguibile task-by-task. Spec: `docs/superpowers/specs/2026-07-10-working-island-live-sync-design.md`.

**Goal:** L'island legge Piano/Attività dal log durevole `turn_events` (proiezione cross-turn),
non più dai marker di testo lossy — così sopravvivono a fine-turno/reload/switch-thread e si
accumulano sul thread.

**Architecture:** Un metodo di proiezione nel crate `task-runtime` (dove vivono `turn_events`+`tasks`),
una route gateway sola-lettura, e il wiring client in `ChatView` che sostituisce
`persistedPlan`/`persistedActivity` come sorgente dell'island a riposo, combinando con il live WS.

**Tech Stack:** Rust (rusqlite, serde) + React/TS.

---

### Task 1: `ThreadActivityProjection` + `project_thread_activity` (task-runtime)

**Files:**
- Modify: `crates/task-runtime/src/types.rs` (nuovo struct serializzabile)
- Modify: `crates/task-runtime/src/store.rs` (metodo + test)

- [ ] **Step 1 — struct.** In `types.rs`, dopo `TurnEvent`:
```rust
/// Thread-level cockpit projection over the durable per-turn log (turn_events) for the
/// working island. Plans supersede (latest plan_update wins); activity accumulates across
/// ALL turns of the thread in chronological order (capped to bound the payload). This is
/// the single durable source the island reads at rest — text-markers are a lossy mirror.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadActivityProjection {
    pub plan_markdown: Option<String>,
    pub activity: Vec<String>,
    pub latest_turn_status: Option<String>,
    pub turn_count: usize,
}
```

- [ ] **Step 2 — failing test.** In `store.rs` tests, seed 2 chat_turn su un thread con
  turn_events (activity+plan_update su turno1, activity+plan_update su turno2), poi asserisci:
```rust
#[test]
fn project_thread_activity_accumulates_cross_turn_and_takes_latest_plan() {
    let store = Store::open_in_memory().unwrap();
    // turno 1
    let t1 = make_chat_turn("turn_a", "threadX", TaskStatus::Completed);
    store.insert_chat_turn(&t1, "threadX", "reqa", "interactive", "full").unwrap();
    store.append_turn_event("turn_a", 1, TurnEventKind::Activity, json!({"text":"A1"})).unwrap();
    store.append_turn_event("turn_a", 2, TurnEventKind::PlanUpdate, json!({"markdown":"- [ ] uno"})).unwrap();
    // turno 2 (più recente)
    let t2 = make_chat_turn("turn_b", "threadX", TaskStatus::Running);
    store.insert_chat_turn(&t2, "threadX", "reqb", "interactive", "full").unwrap();
    store.append_turn_event("turn_b", 1, TurnEventKind::Activity, json!({"text":"B1"})).unwrap();
    store.append_turn_event("turn_b", 2, TurnEventKind::PlanUpdate, json!({"markdown":"- [x] due"})).unwrap();
    let p = store.project_thread_activity("threadX", 200).unwrap();
    assert_eq!(p.activity, vec!["A1".to_string(), "B1".to_string()]);
    assert_eq!(p.plan_markdown.as_deref(), Some("- [x] due"));
    assert_eq!(p.turn_count, 2);
    assert_eq!(p.latest_turn_status.as_deref(), Some("running"));
}
```
  NB: verifica il nome reale dell'helper d'inserimento evento (grep `fn append_turn_event`/`fn record_turn_event`/`fn insert_turn_event` in store.rs) e di `make_chat_turn` (già esiste, riga ~1219) e `TaskStatus`. Se l'helper d'insert evento è privato/diverso, usalo com'è.

- [ ] **Step 3 — run test (fallisce):** `cargo test -p local-first-task-runtime project_thread_activity -- --nocapture` → FAIL (metodo assente).

- [ ] **Step 4 — implementa.** In `store.rs`:
```rust
/// See ThreadActivityProjection. One JOIN turn_events⋈tasks(thread_id) — both live in the
/// same sqlite — gives all activity+plan events across the thread's turns in order; we fold
/// them (append activity, keep last plan) and read the latest turn's status separately.
pub fn project_thread_activity(
    &self,
    thread_id: &str,
    activity_cap: usize,
) -> TaskRuntimeResult<ThreadActivityProjection> {
    let mut stmt = self.connection.prepare(
        "SELECT te.kind, te.payload_json
         FROM turn_events te JOIN tasks t ON t.task_id = te.turn_id
         WHERE t.thread_id = ?1 AND t.kind = 'chat_turn'
           AND te.kind IN ('activity','plan_update')
         ORDER BY t.created_at ASC, te.seq ASC",
    )?;
    let rows = stmt.query_map(params![thread_id], |row| {
        let kind: String = row.get(0)?;
        let payload: String = row.get(1)?;
        Ok((kind, payload))
    })?;
    let mut activity: Vec<String> = Vec::new();
    let mut plan_markdown: Option<String> = None;
    for row in rows {
        let (kind, payload_json) = row?;
        let payload: Value = serde_json::from_str(&payload_json)?;
        match kind.as_str() {
            "activity" => {
                if let Some(text) = payload.get("text").and_then(|v| v.as_str()) {
                    let text = text.trim();
                    if !text.is_empty() { activity.push(text.to_string()); }
                }
            }
            "plan_update" => {
                if let Some(md) = payload.get("markdown").and_then(|v| v.as_str()) {
                    if !md.trim().is_empty() { plan_markdown = Some(md.to_string()); }
                }
            }
            _ => {}
        }
    }
    // Bound the payload: keep the most recent `activity_cap` steps (the tail).
    if activity.len() > activity_cap {
        activity.drain(0..activity.len() - activity_cap);
    }
    // Latest turn status + count (indexed by idx_tasks_chat_turn_thread).
    let latest_turn_status: Option<String> = self.connection.query_row(
        "SELECT status FROM tasks WHERE thread_id = ?1 AND kind = 'chat_turn'
         ORDER BY created_at DESC LIMIT 1",
        params![thread_id],
        |row| row.get(0),
    ).optional()?;
    let turn_count: i64 = self.connection.query_row(
        "SELECT COUNT(*) FROM tasks WHERE thread_id = ?1 AND kind = 'chat_turn'",
        params![thread_id], |row| row.get(0),
    )?;
    Ok(ThreadActivityProjection {
        plan_markdown,
        activity,
        latest_turn_status,
        turn_count: turn_count as usize,
    })
}
```
  Importa `ThreadActivityProjection` nel modulo. Verifica `.optional()` (rusqlite OptionalExtension già in uso a riga ~905/911).

- [ ] **Step 5 — run test (passa):** `cargo test -p local-first-task-runtime project_thread_activity` → PASS.

- [ ] **Step 6 — commit:** `feat(island): durable cross-turn activity/plan projection over turn_events (task-runtime)`

---

### Task 2: Route gateway `GET /api/chat/threads/{id}/activity`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (route + handler)

- [ ] **Step 1 — route.** Accanto a `/api/chat/threads/{thread_id}/messages` (riga ~927):
```rust
.route("/api/chat/threads/{thread_id}/activity", get(thread_activity_projection))
```

- [ ] **Step 2 — handler.** Vicino a `get_turn_events` (riga ~31714):
```rust
/// GET /api/chat/threads/{thread_id}/activity — durable cockpit projection for the working
/// island: latest plan + activity accumulated across the thread's turns + latest turn status.
/// Reads turn_events (canonical) via the indexed tasks(thread_id) join — NOT message-text markers.
async fn thread_activity_projection(
    Path(thread_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<local_first_task_runtime::types::ThreadActivityProjection>, GatewayError> {
    let store = state.task_store.lock().map_err(|e| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "broker_store_lock",
        message: format!("lock: {e}"),
    })?;
    let projection = store
        .project_thread_activity(&thread_id, 200)
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "thread_activity",
            message: format!("{e}"),
        })?;
    Ok(Json(projection))
}
```
  Verifica il path reale del tipo (`local_first_task_runtime::types::ThreadActivityProjection` o re-export). Grep `use local_first_task_runtime` in main.rs per lo stile d'import.

- [ ] **Step 3 — build:** `cargo build -p local-first-desktop-gateway` → OK.
- [ ] **Step 4 — smoke curl:** con token, `GET /api/chat/threads/<un thread reale>/activity` → 200 con `{plan_markdown, activity, latest_turn_status, turn_count}`.
- [ ] **Step 5 — commit:** `feat(island): thread activity projection endpoint`

---

### Task 3: Client — fetch + tipo

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts` (fetch)
- Modify: `apps/desktop/src/lib/coreBridge.ts` (re-export, se il pattern lo richiede)

- [ ] **Step 1 — tipo + fetch** in `chatApi.ts`:
```ts
export interface ThreadActivityProjection {
  plan_markdown: string | null;
  activity: string[];
  latest_turn_status: string | null;
  turn_count: number;
}
export async function fetchThreadActivity(threadId: string): Promise<ThreadActivityProjection> {
  return gatewayJson<ThreadActivityProjection>(
    `/api/chat/threads/${encodeURIComponent(threadId)}/activity`,
  );
}
```
- [ ] **Step 2 — build UI:** `npm run build` (in apps/desktop) → tsc OK.
- [ ] **Step 3 — commit:** `feat(island): client fetch for thread activity projection`

---

### Task 4: ChatView — l'island legge la proiezione durevole

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1 — stato.** Vicino a `liveActivitySteps` (riga ~321):
```ts
const [projectedActivity, setProjectedActivity] = useState<string[]>([]);
const [projectedPlan, setProjectedPlan] = useState<string | null>(null);
```
- [ ] **Step 2 — fetch effect.** Fetcha la proiezione al cambio thread e quando lo streaming FINISCE
  (mai durante lo streaming, per non doppiare col live):
```ts
// The working island's durable at-rest source: the cross-turn projection over turn_events.
// Fetched on thread change and when a turn ends (isStreaming → false) so the just-finished
// turn folds in. NOT during streaming — liveActivitySteps carries the active turn; fetching
// mid-stream would double-count the current turn's events.
useEffect(() => {
  let cancelled = false;
  const load = () => {
    fetchThreadActivity(thread.threadId)
      .then((p) => {
        if (cancelled) return;
        setProjectedActivity(p.activity);
        setProjectedPlan(p.plan_markdown);
      })
      .catch(() => { /* projection is best-effort; live + persisted fallback cover it */ });
  };
  if (!isStreaming) load();
  return () => { cancelled = true; };
}, [thread.threadId, isStreaming]);
```
  (`isStreaming` è già definito a riga ~489; se l'effect è sopra la sua definizione, spostare l'effect
  sotto o derivare `isStreaming` prima. Verifica l'ordine di dichiarazione.)

- [ ] **Step 3 — sorgente island.** Sostituisci le righe `conversationActivity`/`conversationPlan` (~490-491):
```ts
const conversationPlan = isStreaming
  ? (livePlanMarkdown ?? projectedPlan ?? persistedPlan)
  : (projectedPlan ?? persistedPlan);
const conversationActivity = isStreaming
  ? [...projectedActivity, ...liveActivitySteps]
  : (projectedActivity.length > 0 ? projectedActivity : persistedActivity);
```
  (Mantiene `persistedPlan`/`persistedActivity` come fallback per turni che hanno i marker nel testo.)

- [ ] **Step 4 — build UI:** `npm run build` → tsc OK.
- [ ] **Step 5 — ui-contract:** `npm run test:ui-contract` → verde.
- [ ] **Step 6 — commit:** `feat(island): island reads durable cross-turn projection at rest`

---

### Task 5: Validazione live (solo app DEV)

- [ ] Quitta l'app installata `/Applications/homun.app` (rimuove il confound a due app).
- [ ] Rebuild dev se serve; guida dalla UI dev: un turno con piano/deliverable.
- [ ] Verifica a schermo: island mostra Piano+Attività DURANTE → RESTA a fine turno → RESTA dopo ⌘R.
- [ ] Secondo turno stesso thread → attività ACCUMULATA sopra la precedente; piano aggiornato.
- [ ] Pulisci eventuali file di test dalla root del repo.

---

## Note d'esecuzione
- Verifica i nomi reali via grep prima d'usarli (helper insert-evento, `Store::open_in_memory`,
  `TaskStatus`, path del tipo) — i numeri di riga invecchiano.
- Nessun push finché non richiesto. Commit su main, niente `Co-Authored-By`.
