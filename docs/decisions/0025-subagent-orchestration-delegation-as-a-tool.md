# Decision 0025: Orchestrazione subagenti — delega-come-tool sul loop unico

Date: 2026-07-03

## Status

**Proposed.** Realizza la capacità che l'utente ha indicato come priorità ("come Codex crea/delega
subagenti automaticamente nei progetti"): il manager (motore #1) può **spawnare uno o più subagenti**
per delegare sotto-task parallelizzabili, ciascuno con il proprio loop bounded, e poi **sintetizzarne i
risultati nel proprio turno**. Converge su architettura esistente — **non** un secondo motore.

## Contesto — cosa Homun ha GIÀ (mappa 2026-07-03)

- **Motore #1** (`stream_chat_via_openai`, `main.rs:22224`) con chokepoint unico di dispatch tool
  **`execute_chat_tool`** (`main.rs:18945`) e loop a round bounded.
- **Envelope sandbox process-global**: `resolved_sandbox_mode()` (`main.rs:18772`) è una free-function letta
  al dispatch → **qualunque path riusi `execute_chat_tool` eredita il recinto ADR 0023 gratis**.
- **Task-runtime concorrente** (`local-first-task-runtime`): worker multipli (`HOMUN_TASK_WORKER_COUNT`),
  DAG (`task_dependencies`), lease, **`ResourceGovernor`** (cap `LlmInference`/`BrowserSession`),
  **`ApprovalGate`**, checkpoint. È il substrato di fan-out/collect già esistente.
- **Esecuzione subagent durabile**: `SubagentTask` (`subagents/types.rs:147`, con `parent_task_id` +
  `permission_envelope` + `budgets`), eseguita da `SubagentTaskExecutor` via registry `subagent.*` — ma
  **solo dal worker di background**, non dalla chat.
- **Loop agentico bounded**: `run_agentic_step` (`orchestrator/agentic.rs:69`) — 16 round read/gather, scelta
  tool vincolata a un **enum** + `fill_arguments` (tier-safe su modelli deboli, ADR 0018), **executor
  iniettato** (già riusabile con qualsiasi dispatch).
- **Una sola memoria + scope**: `MemoryRecallService` (`memory/src/service.rs:178`) con `MemoryScope ∈
  {Personal, Project(ws), Thread{project, thread_id}}` (`schema.rs:34`); `MemoryFacade` **single-writer**
  (WAL pool). I subagent durabili già scrivono **attraverso questa facade** (`memory_agent.rs:31`).
- **Classificazione envelope fail-closed**: `subagent_write_mode` / `validate_single_threaded_writes`
  (`subagent_workflow.rs:166/185`) — il design ADR 0018 Pilastro 3, già codificato.
- **Superficie di visibilità**: activity panel + stream tipizzato (`activity`/`plan_update`,
  `/api/local-computer/live`).

**Cosa MANCA** per lo spawn alla Codex: (a) un **tool chiamabile dal modello** (`spawn_subagent`/`task`) —
oggi delega solo un bottone umano (`create_task_from_chat_message`); (b) **fan-out + join dentro il turno**
del manager; (c) **threading dello scope memoria** del manager nel figlio (la facade lo supporta, ma nessun
codice passa lo scope del thread a un figlio spawnato).

## La decisione

**Aggiungere un tool `spawn_subagent` al chokepoint `execute_chat_tool`.** Il suo handler:
1. classifica l'intento via `subagent_write_mode` e **rifiuta le scritture** → i figli sono **read/gather**;
2. enfila N `SubagentTask` (`parent_task_id` = task del manager) nel **task-runtime**, sotto il
   `ResourceGovernor` e budget per-manager;
3. ogni figlio gira un **loop bounded read/gather riusando `run_agentic_step`**, il cui executor iniettato
   **delega a `execute_chat_tool`** (native tool-calling di motore #1) — **NON** il loop `generate_json` del
   "drive" (il motore ritirato da ADR 0021);
4. **joina** i risultati e li restituisce come blocco sintetizzabile **nel turno del manager**;
5. il **manager resta l'unico writer** (memoria + side-effect + approvazioni); i figli non scrivono.

Delega-come-**tool**, non come secondo motore: un solo loop guardato (ADR 0021), che *chiama* la delega come
qualunque altra capability. È l'equivalente Homun di come Claude Code/Codex spawnano subagenti da un tool.

### Ereditarietà (invarianti chiave)

- **Sandbox/approval**: i figli riusano `execute_chat_tool` → `resolved_sandbox_mode()` global li recinta
  automaticamente (ADR 0023). L'`permission_envelope` di ciascun figlio è **derivato dalla policy risolta del
  manager**, fail-closed (`subagent_workflow.rs`).
- **Memoria (caposaldo #1)**: si passa esplicitamente lo **`MemoryScope`** del manager (Thread/Project) a
  `brief`/`recall`/`learn` di ogni figlio → leggono/scrivono attraverso l'**UNICA** `MemoryFacade` nello
  **stesso scope**. Il write-back resta **single-threaded sul manager** (i figli producono evidenza, il
  manager la consolida). Il single-writer WAL è il backstop, non una licenza a parallelizzare le scritture.
- **Visibilità (ADR 0018 Pilastro 3)**: gli step di ogni figlio emettono eventi `activity`/`plan_update` sul
  thread del manager + riusano l'activity panel; ogni approvazione di side-effect di un figlio sale allo
  stesso `ApprovalGate`.

## Cosa si RIUSA (non si ricostruisce)

`run_agentic_step` (loop bounded), `SubagentTask` (+ `parent_task_id`/`envelope`/`budgets`),
`subagent_write_mode`/`validate_single_threaded_writes`, task-runtime (worker + governor + lease +
approval-gate), `MemoryScope::Thread` + facade single-writer, `resolved_sandbox_mode()` global, activity
stream. Il nuovo codice è **solo la colla di ingresso** (tool + fan-out/join + scope-threading).

## Cosa si COSTRUISCE (prima slice, 6 pezzi)

1. **Tool `spawn_subagent`** — schema + handler in `execute_chat_tool`; args `{goal, contract?, budget?}`;
   read/gather only (classificazione fail-closed).
2. **Fan-out/join del manager** sul task-runtime: enfila N figli (`parent_task_id`=manager), attende i
   risultati joinati sotto `ResourceGovernor`, ritorna un blocco sintetizzato nel turno.
3. **Loop figlio = `run_agentic_step`** con executor che delega a `execute_chat_tool` (non il `generate_json`
   del drive).
4. **Threading scope memoria**: passa lo `MemoryScope` del manager a ogni figlio; figli leggono via facade, il
   manager possiede il write-back (single-threaded).
5. **Ereditarietà envelope**: deriva l'`permission_envelope` di ogni figlio dalla policy risolta del manager
   (fail-closed); il sandbox axis è coperto dal global.
6. **Visibilità**: stream `activity`/`plan_update` dei figli sul thread del manager; approvazioni al gate.

Dietro un flag (`HOMUN_SUBAGENTS` default-off), behavior-preserving finché non validato; **validare su
modello debole** (gemma4) perché la delega deve reggere sul tier locale (caposaldo #2). Il flag si accende
solo dopo la eval bi-popolazione.

## Alternative considerate

- **Resuscitare il "drive" come motore di turno** (`orchestrator_drive_for_chat`/`Brain::drive`). **Respinta**:
  è esattamente il secondo motore che ADR 0021 ritira; il suo loop `generate_json` regredisce sui modelli
  deboli ("Format Tax"). Riusare `run_agentic_step` come **inner-loop scoped a un tool** è diverso e ammesso.
- **Solo task durabili di background** (lo stato attuale). Insufficiente: non c'è delega **in-turn** — il
  manager non può spawnare figli read/gather e bloccarsi sui risultati joinati dentro il proprio loop, che è
  ciò che rende l'esperienza "Codex-like".
- **Uno store/scope memoria parallelo per i figli.** Respinta per caposaldo #1: i figli passano per l'unica
  facade nello scope del manager; niente seconda verità.

## Conseguenze

- **Positivo**: capacità Codex-like (spawn automatico + delega + sintesi) senza nuovo motore; riusa il
  substrato concorrente e di memoria già maturo; envelope + recinto ereditati per costruzione; visibile.
- **Costo/rischi**: (a) **scope leakage** — un figlio che defaulta a Personal/altro workspace contaminerebbe
  (net-new, security-relevant → il threading esplicito dello scope è obbligatorio + testato); (b) **due-motori**
  se per sbaglio si cabla il drive (mitigato: il figlio delega a `execute_chat_tool`); (c) **scritture
  parallele** in memoria (mitigato: figli read/gather, manager unico writer, WAL backstop); (d) **esaurimento
  risorse/costo** — `LlmInference` governor default 1 → fan-out naive serializza/starva (mitigato: budget +
  limiti per-manager); (e) **tier debole** — loop figlio free-form regredisce (mitigato: enum + `fill_arguments`
  già tier-safe).
- **Invarianti**: un solo loop guardato (ADR 0021); una sola memoria/scope (caposaldo #1); envelope
  fail-closed (ADR 0018/0023); deve reggere sul tier locale (caposaldo #2).

## Sequenza

1. Slice 1 (i 6 pezzi sopra) dietro `HOMUN_SUBAGENTS`, con: test dello scope-threading (no leakage),
   test single-threaded-writes, validazione su gemma4 (fan-out read/gather + sintesi).
2. Poi: budget/governor tuning, visibilità raffinata, ed eventuale scope agentico oltre read/gather
   (scritture single-threaded + approval) — solo dopo che la slice read/gather è un punto fermo.

Piano d'implementazione: [plans/2026-07-03-subagent-orchestration-slice1.md](../superpowers/plans/2026-07-03-subagent-orchestration-slice1.md).
