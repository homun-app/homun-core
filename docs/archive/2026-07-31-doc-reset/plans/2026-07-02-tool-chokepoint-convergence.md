# Chokepoint tool — piano di convergenza (ADR 0024 step 2, decomposto per rischio)

> **Per worker agentici:** SUB-SKILL: `superpowers:subagent-driven-development`. Ogni fase è
> behavior-preserving, dietro flag, con test di parità, e ritira la parallela solo quando la
> canonica è default (caposaldo #1/#5).

**Goal:** portare TUTTA l'esecuzione tool attraverso **un chokepoint unico** — dove [ADR 0023](../decisions/0023-sandbox-enforcement-and-unified-approval.md)
imporrà la sandbox e l'approval. Realizza lo step 2 di [ADR 0024](../decisions/0024-engine-extraction-from-monolith-gateway.md).

**Architettura:** introdurre un seam `ToolExecutor` (una funzione unica che il loop chiama per OGNI
tool), *inizialmente* wrapper del dispatch inline esistente (zero cambi di comportamento). Poi migrare
le famiglie di tool dietro il seam, **dalla più sicura alla più rischiosa**. La migrazione al
`CapabilityFacade` pieno (provider-ificazione) è l'ultima fase, non la prima.

**Perché decomposto così (dal map 2026-07-02):** il chat loop non usa affatto la facade; le 4 famiglie
sono dispatchate inline in un unico blocco for (main.rs `20422–23664`) come rami else-if sequenziali +
1 duplicato nell'orchestrator (`37735–37796`). Rischio per famiglia: **MCP/Composio bassi** (già
delegano a `run_mcp_chat_tool`/`composio_execute_tool` puliti), **browser medio** (~700 righe, stato
sessione/tab), **builtin alto** (~34 tool, ~1900 righe, accoppiamento a memoria/artefatti/piani —
e sono i tool file/shell critici per la sandbox). Lo stato del loop (`thread_browser_session`,
`opened_targets`, `last_snapshot`, `browser_used`, canale `activity`) va infilato nel contesto.

**Vincoli:** commit convenzionali, niente Co-Authored-By. Gate: `cargo test -p local-first-desktop-gateway`,
smoke live del turno chat (parità: stesso prompt → stessa risposta/tool-trace). Ogni fase dietro
`HOMUN_TOOL_CHOKEPOINT` (default off) finché la parità non è verificata.

---

## Fase 0 — Contratto (pura addizione, zero rischio)

**File:** nuovo `crates/desktop-gateway/src/tool_exec.rs` (o crate motore se già estratto).

- Definire `struct ToolCall { name: String, args: serde_json::Value, call_id: String }` e
  `enum ToolOutcome { Result(String), Refused(String), NeedsApproval(ApprovalCard) }` — i tipi del
  confine (allineati a `CapabilityCall`/`CapabilityCallResult` dove possibile per non duplicare).
- Definire il trait `ToolExecutor { fn execute(&mut self, ctx: &ToolCtx, call: ToolCall) -> ToolOutcome; }`.
- `ToolCtx` porta le dipendenze del turno **per riferimento/trait** (browser session handle, activity
  sink, scope memoria, read-only flag) — NON `AppState` intero.
- **Nessun wiring nel loop.** Solo i tipi + unit test dei tipi. Il seam esiste ma non è chiamato.
- Commit: `feat(gateway): ToolExecutor seam types (chokepoint fase 0)`.

## Fase 1 — Estrai il dispatch inline in UN chokepoint (behavior-preserving) — ✅ FATTA

> ✅ **FATTA (2026-07-02).** Dettaglio + decomposizione in [2026-07-02-fase1-chokepoint-extraction.md](2026-07-02-fase1-chokepoint-extraction.md).
> Commit `26410823`→`9feda778`→`5bc46bc5`→`680f8d20`. Chokepoint `execute_chat_tool(ctx, name, args_raw,
> call_id) -> String` (main.rs:18391), call-site unico 23815. Parità = compilatore + 452 test == baseline +
> verifica strutturale verbatim (golden live nondeterministici coi modelli disponibili → non usati). Aggiunto
> un campo `request` a `ChatToolCtx`; guardia blocked + post-processing (`browse_sources`/vault/`step_evidence`)
> + harness restano nel loop.

**File:** `crates/desktop-gateway/src/main.rs` (blocco `20422–23664`).

- Estrarre il blocco di dispatch tool del loop in **una funzione** `execute_chat_tool(ctx, call) ->
  ToolOutcome` che contiene ESATTAMENTE la logica inline attuale (le 4 famiglie come rami interni).
  Lo stato del loop diventa `ToolCtx` (borrow disgiunti). **Nessun cambio di comportamento**: è
  un'estrazione meccanica.
- Il loop ora chiama `execute_chat_tool(...)` invece del blocco inline. Il chokepoint è REALE (un solo
  punto d'ingresso) — è qui che la sandbox/approval di 0023 si aggancerà.
- ⚠️ Rischio: lo stato coupling (map). Fare la borrow-analysis prima; se un ramo tiene un guard mutex
  attraverso un await, mantenere la struttura a 3 fasi (sync → await off-lock → sync) già usata altrove.
- Gate: `cargo test` + smoke di parità (stesso prompt browse/builtin/mcp → stessa risposta). Dietro
  flag solo se il rischio di regressione lo richiede; altrimenti behavior-preserving diretto con test.
- Commit: `refactor(gateway): extract chat tool dispatch into single chokepoint (fase 1)`.

## Fase 2 — Converge le famiglie pulite (MCP + Composio) sul CapabilityFacade

**Preconditions:** MCP e Composio hanno GIÀ provider; il dispatch delega già a funzioni pulite.

- Dentro `execute_chat_tool`, instradare i rami MCP e Composio a `CapabilityFacade::call_tool(
  CapabilityCall{provider, tool_name, args})` invece delle chiamate dirette `run_mcp_chat_tool`/
  `composio_execute_tool`.
- **Spostare le confirmation card nel policy layer** (`CapabilityPolicy::tool_access` → decisione che
  include "needs approval"), così l'approval è deciso al chokepoint, non nel ramo.
- Test di parità per-tool (MCP: un tool noto; Composio: un write gated). Gate + smoke.
- Commit: `refactor(gateway): route MCP+Composio tools through CapabilityFacade (fase 2)`.

## Fase 3 — Provider browser + converge i due path browser

**File:** `crates/capabilities` (provider) + main.rs (chat browser `20638–21350` + orchestrator
`37735–37796`).

- Definire `BrowserCapabilityProvider` che espone i 6 tool browser e delega all'esecutore sidecar
  condiviso (`chat_browser_call`/`call_shared_browser_sidecar`). **Riuso**, non terza copia (il
  provider chiama l'esecutore durevole esistente).
- Instradare ENTRAMBI i path browser (chat loop + orchestrator executor) al provider via facade →
  chiude il duplicato #5 del map.
- Preservare stato sessione/tab/snapshot nel `ToolCtx`. Gate + smoke browse live (navigate→snapshot→act
  sul browser visibile, come i test P0).
- Commit: `feat(capabilities): BrowserCapabilityProvider + converge both browser paths (fase 3)`.

## Fase 4 — Provider builtin (la fase ad alto rischio, decomposta ancora)

**File:** `crates/capabilities` (provider) + main.rs builtins (`21356–23351`).

I ~34 builtin NON si migrano in blocco. Sotto-fasi per cluster, ognuna con parità:
- **4a — file/shell** (`read_file`/`write_file`/`edit_file`/`list_files`/`list_directory`/
  `read_text_file`/`run_in_project`/`run_in_sandbox`): PRIORITÀ — sono i tool su cui la sandbox 0023
  deve mordere. Migrare per primi in `BuiltinCapabilityProvider`, iniettando i servizi di stato
  (niente global). Gate stretto.
- **4b — memoria/piano** (`recall_memory`/`record_decision`/`forget_memory`/`update_plan`/
  `step_advance`/`query_code_graph`/`query_git_history`): dipendono da `MemoryRecallService` (già
  trait, 0022) → iniettare.
- **4c — artefatti/deck/deliverable** (`create_artifact`/`save_artifact`/`render_deck`/`make_deck`/
  `make_document`/`generate_image`/`get_brand_kit`).
- **4d — resto** (`github_search`/`use_skill`/`create_skill`/`find_capability`/automazioni/schedule/
  addon).
- Ogni sotto-fase: provider arm + routing + parità + ritiro del ramo inline. Commit per sotto-fase.

## Fase 5 — Pulizia + sandbox-ready

- Ritirare il dispatch inline residuo (caposaldo #1). Il chokepoint è ora `CapabilityFacade::call_tool`
  per TUTTE le famiglie.
- Verificare che `execute_chat_tool` sia il solo punto d'esecuzione → **pronto per ADR 0023** (la
  sandbox si aggancia lì, un solo posto).
- Aggiornare `architecture/capability-registry.md` + STATO. Marcare ADR 0024 step 2 fatto.

---

## Ordine di esecuzione e checkpoint

Fase 0 → 1 → 2 sono il **primo blocco** (seam + chokepoint reale + famiglie pulite): a fine blocco il
chat loop ha un chokepoint unico con MCP/Composio già canonici, e la parità è verificata sul path
live. **Checkpoint con l'utente qui** prima delle fasi 3–4 (browser + builtin), che toccano il codice
più accoppiato e vanno validate live con cura.

Fase 3 → 4 (browser + builtin) sono il grosso del rischio: una sotto-fase alla volta, ognuna gated e
validata, mai due famiglie insieme.

## Fuori scope (esplicito)

- Spostare le 5.700 righe del loop in un crate (ADR 0024 step 3) — viene DOPO che il chokepoint è unico.
- La sandbox stessa (ADR 0023) — si implementa quando il chokepoint di fase 5 è pronto.
- Il processo satellite (ADR 0024 Fase B).
