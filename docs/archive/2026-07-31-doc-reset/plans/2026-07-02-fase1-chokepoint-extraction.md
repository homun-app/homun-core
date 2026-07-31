# Fase 1 — Estrazione del dispatch tool nel chokepoint `execute_chat_tool`

> **Per worker agentici:** SUB-SKILL RICHIESTA: `superpowers:subagent-driven-development`. Ogni task è
> behavior-preserving e ha come gate `cargo test -p local-first-desktop-gateway` **+ replay
> dell'harness di parità uguale ai golden**. Passi con checkbox (`- [ ]`).

> ✅ **COMPLETATA (2026-07-02).** Commit `26410823` (1.0 harness) → `9feda778` (1.0 oracolo stretto) →
> `5bc46bc5` (1.1 ChatToolCtx) → `680f8d20` (1.2 estrazione). Chokepoint = `execute_chat_tool` (main.rs:18391),
> call-site unico 23815. Gate: compilatore + 452 test (bin) + 6 (lib) == baseline + verifica strutturale
> verbatim. Golden live NON catturati (solo modelli deboli/cloud raggiungibili → nondeterministici; oracolo
> deterministico = compilatore+suite, vedi nota in fondo). Prossimo = Fase 2 del piano padre.

**Goal:** portare TUTTA l'esecuzione tool del chat loop attraverso **una** funzione
`execute_chat_tool(ctx, call)` — il chokepoint unico dove ADR 0023 aggancerà sandbox+approval —
**senza cambiare comportamento**, e in una forma che sopravvive ad ADR 0024 step 3.

**Architettura:** il dispatch inline (`stream_chat_via_openai`, blocco `20423–23666`, ~3200 righe,
~40 variabili condivise, 7 arm con effetti collaterali oltre al return) viene (1) osservato da un
harness di parità, (2) rifattorizzato per passare lo stato del turno via una struct `ChatToolCtx<'a>`
(prestiti disgiunti, scoped al dispatch loop), (3) sollevato verbatim in una funzione async. La firma
onesta è `-> String` (gli effetti collaterali passano per `ctx`, non per il return): l'enum
`ToolOutcome` di Fase 0 resta il **bersaglio**, non il tipo di ritorno di questa fase — ci si converge
in Fase 2–4 semplificando ogni famiglia.

**Tech Stack:** Rust, tokio, serde_json, rusqlite; crate `local-first-desktop-gateway`.

**Vincoli:** commit convenzionali, **niente Co-Authored-By**. NON toccare
`apps/desktop/scripts/check-ui-contract.mjs` (sessione concorrente). Nessun `--amend` su commit
già esistenti (commit forward-only: una sessione concorrente intesse la history).

**Mappa di riferimento (borrow-analysis 2026-07-02) — LA VERITÀ DA PRESERVARE:**
- Dispatch loop: `for call in &calls` **20423–23666**. Per-call parse: `name` (20424, ribindato 20444
  via `resolve_browser_chat_tool_name`), `args_raw: &str` (20429), `call_id: String` (20434).
- Result append: **23661–23665** `messages.push(json!({"role":"tool","tool_call_id":call_id,"content":result}))`.
- Unico `continue` interno: guard `workflow_route_blocked_tool_message` a **20457** (pusha un tool msg e continua).
- Lock: **solo** `browse_web_lock()` (`&'static tokio::Mutex<()>`, decl 25773) tenuto attraverso
  `chat_browser_call(...).await` negli arm browser. È deliberato (serializzazione globale) e sicuro
  (blocking già in `spawn_blocking`). **`&'static` → NON entra in `ctx`**; resta verbatim nell'arm.
  Nessun `std::sync` guard è tenuto attraverso await.
- 7 hazard (effetti oltre il return string), da preservare esattamente:
  1. Side-write in `accumulated` (2° buffer): create_artifact, generate_image, render_deck,
     make_document, update_plan (`‹‹PLAN››`), e le 4 card (`‹‹MCP_CONFIRM››`/`‹‹COMPOSIO_CONFIRM››`/
     `‹‹FS_AUTHORIZE››`/`‹‹CONNECT_SUGGEST››`).
  2. `pending_confirm` (control-flow): settato dalle 4 card, letto DOPO il loop (23695) per chiudere il turno.
  3. `update_plan`/`step_advance` (22672–22829): muta `plan`, `step_evidence` (read+clear),
     `last_round_sig`/`repeat_count`/`progress_anchor_round`/`pending_compaction`, e fa `.await` di verifica.
  4. `find_capability` (22858–22958): muta `loaded_tools`, `tool_schemas`, `tool_trace` (attiva tool deferred).
  5. `browser_screenshot`: setta `pending_browser_image` → un 2° messaggio `role:"user"` pushato DOPO il loop (23681).
  6. Prima chiamata browser riassegna `base_url`/`model`/`api_key`/`endpoint` del turno (20538–20547).
  7. `recall_memory`: emette `GenerateStreamEvent::Recall` e setta `pending_vault_reveal_marker` (letto post-arm 23648).

---

## File Structure

- **Nuovo:** `crates/desktop-gateway/src/tool_trace_dump.rs` — helper harness (record + append jsonl,
  normalizzazione campi volatili). Responsabilità unica: osservazione di parità, gated da env.
- **Modifica:** `crates/desktop-gateway/src/main.rs`
  - `mod tool_trace_dump;` accanto a `mod tool_exec;` (riga 32).
  - `stream_chat_via_openai`: instrumentazione al confine del dispatch loop (Task 1.0); struct
    `ChatToolCtx<'a>` + threading (Task 1.1); estrazione in `execute_chat_tool` (Task 1.2).
- **Nuovo (golden, non compilati):** `crates/desktop-gateway/tests/golden/tool-trace/*.jsonl` +
  `COVERAGE.md` (quali scenari sono catturati live vs. solo code-review).

---

## Task 1.0 — Harness di parità (instrumentation + golden)

**Files:**
- Create: `crates/desktop-gateway/src/tool_trace_dump.rs`
- Create: `crates/desktop-gateway/tests/golden/tool-trace/COVERAGE.md`
- Modify: `crates/desktop-gateway/src/main.rs` (`mod` a riga ~33; instrumentation nel dispatch loop)

**Cosa cattura il record (i 7 hazard sono osservabili al confine del loop):**
```rust
// tool_trace_dump.rs
#[derive(serde::Serialize)]
pub struct ToolTraceRecord {
    pub round: usize,
    pub idx: usize,
    pub name: String,
    pub args_sha: String,      // sha256 di args_raw NORMALIZZATO
    pub result_sha: String,    // sha256 di result NORMALIZZATO
    pub result_len: usize,
    pub acc_delta_len: usize,  // accumulated.len() dopo - prima
    pub acc_markers: Vec<String>, // marker ‹‹…›› comparsi in accumulated durante l'arm
    pub pending_confirm: bool,
    pub msgs_pushed: usize,    // messages.len() dopo - prima (screenshot ⇒ 2)
}
```

**Normalizzazione (deterministica contro path/temp volatili):** prima dello sha, sostituire nel
testo: home dir → `~`, path assoluti sotto `~/.homun` e `$TMPDIR` → placeholder, ISO timestamp
(`\d{4}-\d{2}-\d{2}T…`) → `<TS>`, uuid → `<UUID>`. Helper `normalize(s: &str) -> String` con unit test.

**Estrazione marker:** `acc_markers` = tutti i token che matchano `‹‹[A-Z_]+›`  comparsi nel
`accumulated[prev_len..]` (il delta). Unit test con input sintetico.

**Env gate:** attivo solo se `std::env::var("HOMUN_TRACE_DUMP").as_deref() == Ok("1")`. Dump append
a `~/.homun/logs/tool-trace.jsonl` (riusare il resolver logs dir già esistente del P0; NON reinventare
la dir). Fallback inerte se la dir non è scrivibile (mai far crashare il turno per il dump).

- [ ] **Step 1: test unità `normalize` + `extract_markers`** (TDD: rossi prima).
```rust
#[test] fn normalize_strips_home_temp_ts_uuid() {
    let s = "wrote /Users/x/.homun/artifacts/2026-07-02T10:00:00Z/deadbeef-....png";
    let n = normalize(s);
    assert!(!n.contains("/Users/x")); assert!(n.contains("<TS>"));
}
#[test] fn extract_markers_finds_all() {
    let acc = "text ‹‹ARTIFACT›› more ‹‹PLAN›› end";
    assert_eq!(extract_markers("text ".len(), acc), vec!["‹‹ARTIFACT››","‹‹PLAN››"]);
}
```
- [ ] **Step 2: implementa `tool_trace_dump.rs`** (record, `normalize`, `extract_markers`,
  `append(record)` gated + inerte-on-failure). `#![allow(dead_code)]` finché wired.
- [ ] **Step 3: run test** `cargo test -p local-first-desktop-gateway tool_trace_dump` → PASS.
- [ ] **Step 4: wiring instrumentation al confine del loop.** In `stream_chat_via_openai`, dentro
  `for call in &calls`, catturare `let acc_before = accumulated.len(); let msgs_before = messages.len();`
  all'inizio del corpo; dopo il calcolo di `result` e PRIMA/DOPO il push finale (23661), costruire e
  `append` il `ToolTraceRecord` (usando `pending_confirm`, i due delta, `extract_markers`). Zero
  effetti quando l'env è off. **Nessun'altra logica cambia.**
- [ ] **Step 5: `cargo test -p local-first-desktop-gateway`** → verde come baseline (435+ test).
- [ ] **Step 6: cattura golden per gli scenari ESEGUIBILI in ambiente.** Con `HOMUN_TRACE_DUMP=1`,
  eseguire i turni disponibili e salvare le jsonl risultanti in `tests/golden/tool-trace/`:
  - `builtin.jsonl` — write_file→read_file (SEMPRE eseguibile, nessun connettore; **prioritario**, è il
    target sandbox).
  - `browse.jsonl`, `shot.jsonl` — se il sidecar browser è disponibile (come nei test P0).
  - `mcp.jsonl`, `card.jsonl` — solo se i connettori MCP/Composio sono configurati.
  In `COVERAGE.md` elencare ESPLICITAMENTE quali sono catturati live e quali restano coperti solo da
  code-review del diff (principio "no silent caps"). Il coordinatore fornirà i comandi/prompt esatti.
- [ ] **Step 7: commit** `test(gateway): tool-trace parity harness (HOMUN_TRACE_DUMP) + goldens`.

**Gate del task:** `cargo test` verde + almeno `builtin.jsonl` catturato e stabile su 2 run identici.

---

## Task 1.1 — `ChatToolCtx<'a>` + threading nel blocco ANCORA INLINE

**Files:** Modify `crates/desktop-gateway/src/main.rs` (`stream_chat_via_openai`, dispatch loop).

**Regola aurea:** **nessuna logica si sposta**. Si introduce la struct e si sostituiscono gli accessi
alle variabili con `ctx.<campo>` DENTRO il blocco `20423–23666`. Il compilatore è l'oracolo primario:
se compila con la struct threadata e i test/golden restano identici, il rename è corretto.

**Definizione struct (campi dalla borrow-analysis; l'implementer aggiusta lifetime/tipi esatti col
compilatore).** `mut` = prestito mutabile, gli altri condivisi:
```
struct ChatToolCtx<'a> {
  // --- mutati dagli arm ---
  messages: &'a mut Vec<serde_json::Value>,
  accumulated: &'a mut String,
  browser_session: &'a mut Option<BrowserAutomationClient<BrowserSidecarSession>>,
  browser_used: &'a mut bool,
  last_snapshot: &'a mut String,
  pending_browser_image: &'a mut Option<String>,
  browser_tool_call_ids: &'a mut BTreeSet<String>,
  current_target: &'a mut String,
  opened_targets: &'a mut Vec<String>,
  nav_failures: &'a mut HashMap<String, u32>,
  browse_sources: &'a mut Vec<String>,
  plan: &'a mut ExecutionPlan,
  step_evidence: &'a mut Vec<String>,
  tool_trace: &'a mut Vec<String>,
  loaded_tools: &'a mut BTreeSet<String>,
  tool_schemas: &'a mut Vec<serde_json::Value>,
  last_round_sig: &'a mut String,
  repeat_count: &'a mut u32,
  progress_anchor_round: &'a mut usize,
  pending_compaction: &'a mut bool,
  pending_vault_reveal_marker: &'a mut Option<String>,
  pending_confirm: &'a mut bool,
  base_url: &'a mut String,
  model: &'a mut String,
  api_key: &'a mut Option<String>,
  endpoint: &'a mut String,
  // --- letti soltanto ---
  state: &'a AppState,          // era `&state_owned`
  tx: &'a StreamSink,           // per emit_stream_event
  thread_id: Option<&'a str>,
  prompt: &'a str,
  read_only: bool,
  channel_owner: bool,
  contact_only: bool,
  can_see_contacts: bool,
  can_see_calendar: bool,
  autonomous: bool,
  composio_writes: &'a HashSet<String>,
  catalog_index: &'a [(String, String, serde_json::Value)],
  capability_corpus: &'a [CapabilityEntry],
  automation_user_id: &'a str,
  automation_workspace_id: &'a str,
  turn_scaffold: &'a scaffold::Scaffold,
  floor_acting: bool,
  round: usize,                 // per-round (ctx ricostruito ad ogni giro)
}
```
Nota: `capability_route_for_runtime` è usato dalla guard pre-arm (`workflow_route_blocked_tool_message`);
se la guard resta nel corpo del loop (vedi Task 1.2), non serve in ctx.

- [ ] **Step 1: definisci `ChatToolCtx<'a>`** sopra `stream_chat_via_openai` (o vicino). Solo la struct.
- [ ] **Step 2: costruisci `ctx` dentro il round loop, subito prima di `for call in &calls`,** in uno
  scope che si chiude col loop (così i prestiti si rilasciano prima delle letture post-loop a 23672/23695).
```rust
{
  let mut ctx = ChatToolCtx {
    messages: &mut messages, accumulated: &mut accumulated,
    browser_session: &mut browser_session, /* …tutti i campi… */
    base_url: &mut base_url, model: &mut model, api_key: &mut api_key, endpoint: &mut endpoint,
    state: &state_owned, tx: &tx, /* …read-only… */ round,
  };
  for call in &calls { /* corpo: variabili → ctx.<campo> */ }
} // ctx droppato → prestiti liberi
```
- [ ] **Step 3: sostituisci gli accessi nel corpo** (`messages`→`ctx.messages`, `accumulated`→
  `ctx.accumulated`, `browser_session`→`ctx.browser_session`, …). **Solo rename.** La guard `continue`
  a 20457 e il parse pre-arm restano dove sono (usano `ctx.tool_trace` ecc.).
- [ ] **Step 4: `cargo build -p local-first-desktop-gateway`** → compila (il compilatore valida i prestiti disgiunti).
- [ ] **Step 5: `cargo test -p local-first-desktop-gateway`** → verde (identico alla baseline).
- [ ] **Step 6: parità** — con `HOMUN_TRACE_DUMP=1` ri-esegui gli scenari catturati in Task 1.0;
  `diff` contro i golden → **byte-identici**. Se differiscono, un rename ha cambiato un accesso: correggi.
- [ ] **Step 7: commit** `refactor(gateway): thread ChatToolCtx through inline tool dispatch (fase 1a)`.

---

## Task 1.2 — Solleva il blocco in `execute_chat_tool` (chokepoint reale)

**Files:** Modify `crates/desktop-gateway/src/main.rs`.

- [ ] **Step 1: crea la funzione** con firma:
```rust
async fn execute_chat_tool(ctx: &mut ChatToolCtx<'_>, call: &serde_json::Value) -> String
```
  Sposta **verbatim** dentro: il parse per-call (`name`/`args_raw`/`call_id`, incluso il ribind
  `resolve_browser_chat_tool_name`) e l'intera espressione `let result = if … else { … };`, poi
  `result` come valore di ritorno. Gli arm browser mantengono `browse_web_lock().lock().await` verbatim.
- [ ] **Step 2: gestisci la guard `continue`.** Il ramo `workflow_route_blocked_tool_message` (20449–
  20458) pusha un tool msg e fa `continue`. Per non cambiare comportamento, farlo restituire una stringa
  sentinella gestita dal loop, OPPURE lasciare quel check nel loop PRIMA della chiamata a
  `execute_chat_tool` (preferito: mantiene la funzione = solo dispatch). Documenta la scelta nel commit.
- [ ] **Step 3: il loop chiama il chokepoint:**
```rust
for call in &calls {
  // (eventuale guard workflow-route qui, se lasciata fuori)
  let acc_before = ctx.accumulated.len(); let msgs_before = ctx.messages.len(); // per l'harness
  let result = execute_chat_tool(&mut ctx, call).await;
  // append tool msg (verbatim da 23661) + record harness (verbatim da Task 1.0)
}
```
  Il push finale del tool msg e l'`append` dell'harness restano al confine del loop (stesso oracolo).
- [ ] **Step 4: `cargo build`** → compila. ⚠️ Se emergono conflitti di prestito che inline non c'erano,
  è perché due campi di `ctx` sono usati simultaneamente in un'espressione: risolvi con binding
  intermedi (`let x = ctx.foo; …`), **mai** clonando stato che prima era condiviso per riferimento
  (cambierebbe il comportamento). Se un arm tiene `ctx.browser_session.take()` attraverso un await,
  preserva la disciplina take/re-store esistente.
- [ ] **Step 5: `cargo test -p local-first-desktop-gateway`** → verde.
- [ ] **Step 6: parità** — `HOMUN_TRACE_DUMP=1` su tutti gli scenari catturati → `diff` byte-identico ai golden.
- [ ] **Step 7: smoke live** (coordinatore): un turno reale per famiglia disponibile (almeno builtin
  file + browse se il sidecar c'è), verifica risposta sensata + nessun panic in `~/.homun/logs`.
- [ ] **Step 8: commit** `refactor(gateway): extract chat tool dispatch into execute_chat_tool chokepoint (fase 1b)`.

---

## Fine Fase 1 — aggiornamenti

- [ ] Aggiorna `docs/STATO.md` (voce ⭐ RIPRESA): Fase 1 fatta, chokepoint `execute_chat_tool` è il solo
  punto di dispatch del chat loop; prossimo = Fase 2 (route MCP+Composio via `CapabilityFacade`).
- [ ] Aggiorna `docs/plans/2026-07-02-tool-chokepoint-convergence.md`: spunta Fase 1, nota il file di
  dettaglio e i golden.
- [ ] Aggiorna memoria `homun-p0-production-hygiene.md` (LINEA ATTIVA).
- [ ] **Checkpoint utente** prima della Fase 2 (come da piano padre).

## Fuori scope (esplicito)

- Convergenza al `CapabilityFacade` / provider-ificazione (Fasi 2–4).
- Unificazione dei due path browser (Fase 3) — il duplicato orchestrator (`37736–37796`) NON si tocca qui.
- Hoist owned dello stato-turno (ADR 0024 step 3) — il `ChatToolCtx` a prestiti è il ponte fino a lì.
- La sandbox stessa (ADR 0023).
