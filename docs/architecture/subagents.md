# Subagenti — orchestrazione delega-come-tool (slice-1)

Data: 2026-07-03. Implementa [ADR 0025](../decisions/0025-subagent-orchestration-delegation-as-a-tool.md).
Dietro flag **`HOMUN_SUBAGENTS`** (default-off). La priorità dell'utente ("come Codex crea/delega
subagenti specializzati"), portata convergendo sull'infrastruttura esistente — **non** un secondo motore.

## Forma (delega-come-tool, un solo loop)

Il manager (motore #1) chiama il tool **`spawn_subagent`** come qualunque capability. L'handler fa **fan-out
sequenziale** di sotto-task **read/gather**, ne **joina** i risultati e li **sintetizza** nel proprio turno.
Ogni figlio gira un loop bounded riusando `run_agentic_step` (l'orchestrator), il cui executor **delega a
`execute_chat_tool`** (native tool-calling di motore #1) — NON il loop `generate_json` del "drive" ritirato.
Il **manager resta l'unico writer**: i figli raccolgono, il manager agisce.

```
manager turn ─ spawn_subagent(tasks=[{goal,role?,contract?}])
                 └─ per task (sequenziale):
                      child ctx (read_only, buffer freschi, thread_id del manager)
                      run_chat_subagent → run_agentic_step(gather_tools) ──(block_in_place+block_on)──▶ execute_chat_tool
                      → SubagentResult{findings, evidence}
                 └─ synthesize_subagent_results → blocco testo nel turno del manager
```

## Moduli

- **`crates/desktop-gateway/src/subagent_child.rs`**: `run_chat_subagent` (wrapper su `run_agentic_step`),
  `child_gather_tools`/`is_child_read_gather_tool`/`CHILD_READ_GATHER_TOOLS`/`CHILD_FORBIDDEN_TOOLS` (allowlist
  **fail-closed default-deny**), `synthesize_subagent_results`, `subagent_role_to_registry_role`,
  `MAX_SUBAGENT_CHILDREN=4`.
- **`main.rs`**: `spawn_subagent_tool_schema()`, `subagents_enabled()`, `run_spawn_subagent` (fan-out/join +
  bridge async→sync), `loaded_capability_tools_for_subagents`, il branch dispatch in `execute_chat_tool`.

## Invarianti di sicurezza (verificati in review)

- **Figli read/gather-only** su **3 assi indipendenti**: name-allowlist default-deny (esclude anche i writer
  `NonFilesystem`: MCP/Composio/`write_file`/`edit_file`/`apply_patch`/`record_decision`/`forget_memory`), footprint
  guard (Write/Exec → deny), re-check al dispatch. Ctx figlio `read_only: true` = terzo strato.
- **No scope-leakage memoria**: il figlio richiama via `recall_memory`, che deriva lo scope dal global
  `MEMORY_WORKSPACE` settato dal turno del manager a inizio turno; i figli girano inline/sequenziali nello stesso
  turno e **non lo mutano mai** → ereditano lo scope del manager (Thread/Project, mai Personal-by-default, mai
  altro workspace). Nessun tool di scrittura memoria è child-gatherable.
- **No fan-out annidato** (depth 1): `spawn_subagent` assente dall'allowlist figlio + footprint guard + il branch
  short-circuita su `ctx.read_only`. Breadth ≤ `MAX_SUBAGENT_CHILDREN`.
- **Envelope sandbox ereditato gratis**: `resolved_sandbox_mode()` è process-global; i figli riusando
  `execute_chat_tool` ereditano il recinto ADR 0023.
- **Sessione browser calda del manager protetta**: un figlio `read_only` non fa `take_thread_browser_session`
  (spawna un sidecar throwaway) → non ruba/uccide la sessione calda del thread.

## Bridge async→sync

`run_agentic_step` ha un executor **sincrono**; `execute_chat_tool` è **async** e il ctx figlio è **non-Send**.
Il figlio gira dentro **`tokio::task::block_in_place` + `Handle::current().block_on(...)`** (runtime multi-thread):
migra gli altri task off-worker, tiene `&mut child_ctx` sullo stesso thread (no Send), e permette il re-entry in
async. Il `ModelRouter` (non-Send) è costruito **dentro** `block_in_place` così non attraversa un `.await` (il
compilatore lo impone: `stream_chat_via_openai` gira come task axum Send). Precedente provato: il browse path
(`orchestrator_drive_for_chat`) fa la stessa cosa.

## Specializzazione (routing modello-per-ruolo)

Ogni task può portare un `role` opzionale (`explorer`/`research`→`browser`, `coding`, `memory`, `vision`,
`orchestrator`). `subagent_role_to_registry_role` lo mappa a un ruolo del registry; il figlio risolve il modello
via `resolve_role_for_task(goal, ruolo)` (goal-aware). **Default = eredita il modello del manager** (niente
escalation di costo silenziosa, come Codex); fail-safe al modello del manager se il ruolo non ha modello eleggibile.
È model-SELECTION only: l'envelope read/gather non cambia.

## Concorrenza (stato e follow-up)

Slice-1 = **sequenziale**. Su locale `active_llm_concurrency()` = 1 → i figli si serializzerebbero comunque, quindi
sequenziale è behavioralmente identico ed evita di condividere `ChatToolCtx &mut` tra figli concorrenti. **Follow-up:**
concorrenza cloud-aware (semaforo = `active_llm_concurrency`, cloud=4) per fan-out parallelo reale. Vedi ADR 0025 §
"Concorrenza, routing modello e specializzazione".

## Stato

Tasks 0-3 **costruiti + revisionati + security-audited + unit-testati** (23 test subagent) + pushati (PR #103).
**Validazione rimanente (pre-merge):** eval flag-on end-to-end su **modello debole (gemma4)** — il manager spawna
figli read/gather e sintetizza (caposaldo #2: deve reggere sul tier locale). Il flag resta default-off finché
questa eval non è verde. **Follow-up:** concorrenza cloud-aware; visibilità per-step raffinata (attività figli sul
thread del manager oltre l'`‹‹ACT››` corrente); scope agentico oltre read/gather (scritture single-threaded + approval).
