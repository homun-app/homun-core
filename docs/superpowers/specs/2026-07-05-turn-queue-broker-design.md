# Turn Queue Broker — Server-Owned Chat Turn Orchestration

**Data:** 2026-07-05
**Stato:** Design (in attesa di approvazione)
**ADR di riferimento:** ADR 0026 (server-owned turn lifecycle)
**Spec correlate:** `2026-07-03-working-island-live-sync-design.md`, `2026-07-03-turn-trace-observability-design.md`, `2026-07-04-chat-integrity-and-exec-visibility-design.md`

## TL;DR

Oggi i turni chat sono gestiti da un semaforo globale (`turn_priority::acquire_turn_slot`) + uno stato osservativo in memoria (`turn_status`), con il client che fa da guardiano (1 turno/thread via `promptSubmitting`). Questo design lo **rifonda**: un **broker persistente** unico basato su `task-runtime` diventa il source of truth per tutti i turni — interattivi, automation, channel — con coda durevole su SQLite, recovery lease-aware al boot, concorrenza governata da `ResourceGovernor`, e stream separato dall'invio. Qualsiasi client (desktop oggi, app domani, CLI) sopra lo stesso contratto.

## Problema

La gestione attuale ha gap strutturali documentati (`crates/desktop-gateway/src/turn_priority.rs:1-23`, `turn_status.rs:1-7`):

1. **Semaforo solo globale**, non per-thread: due turni sullo stesso thread possono girare in parallelo e correre sul transcript. Il vincolo "1 turno/thread" è delegato interamente al client (`ChatView.tsx:321` `promptSubmitting`).
2. **`wait_if_busy` è codice morto** (`lib.rs:89`, mai letto in ammissione): il campo esiste ma non difende nulla.
3. **Niente durabilità**: al crash/restart, tutti i turni in corso e in coda sono persi. Lo stato del turno è in-memory (`turn_status::registry`, `Mutex<HashMap>`).
4. **Connessione HTTP tenuta aperta** durante l'attesa in coda (`acquire_turn_slot().await` dentro `stream_chat_via_openai`).
5. **Browser serializzato da un mutex ad-hoc** (`browse_web_lock`, `main.rs:27276`), non osservabile, non persistente.
6. **Working island ephemeral**: lo stato live vive in React (`useLiveWorkspace`), per-thread attivo; perso al cambio thread, non resume-able dopo reload se non tramite parser di testo sul messaggio finalizzato.
7. **Automation e turni interattivi su due path**: le automation passano già per la coda `task-runtime` (`kind=proactive_prompt`), ma i turni interattivi la bypassano (`generate_stream` → `stream_chat_via_openai` diretto). Duplicazione concettuale.

L'utente sta "mettendo una serie di pezze che non funziona". Questo design separa la gestione turni dalla UI e la rende totalmente server-owned.

## Obiettivi

- **Broker persistente unico** (RabbitMQ-style): coda su SQLite, recovery al boot, stato-checking, sopprime/riprende ciò che è sospeso.
- **Server-owned**: il server possiede l'agent-loop. Il client (qualunque esso sia) invia e riceve lo stream, non governa.
- **1 turno attivo per thread** difeso dal server (409 Conflict se busy).
- **DB unico** (messaggi + turni + automations + lease in un solo file SQLite) → atomicità "prompt utente + accodamento turno".
- **Automation unificate**: `kind=chat_turn` con `source` discriminatorio, migrando `proactive_prompt` esistenti.
- **Working island broker-alimentata** via `turn_events` persistenti (single-thread per ora).
- **Client-agnostic**: il contratto HTTP/WS deve bastare per attaccarci qualsiasi client.
- **Reversibilità**: rollout incrementale in fasi shippable, niente big-bang.

## Non-obiettivi (espliciti)

- Multi-thread nella working island (future work, fuori scope: il broker lo abilita ma non lo implementa).
- Multi-process / horizontal scaling come requisito (il design lo **non preclude** tramite process generation + lease-aware recovery, ma non è nel scope di consegna).
- Resume di un agent-loop da metà (checkpoint mid-turn): un turno rimesso in coda riparte da capo.
- Backpressure sullo stream come requisito (future work: spill su DB se client lento).

## Architettura

```
                          ┌─────────────────────────────────────┐
   POST /api/chat/turns   │   homun.sqlite  (UNICO)             │
   (qualunque client)     │   ├── chat_threads / chat_messages  │
        ───────────────►  │   ├── tasks  (kind=chat_turn|...)   │
                          │   │     + source discriminator      │
                          │   ├── turn_events                   │
                          │   ├── turn_leases / process_meta     │
                          │   ├── automations / automation_runs │
                          │   └── resource_reservations         │
                          └──────────────┬──────────────────────┘
                                         │  (1 transazione atomica:
                                         │   INSERT msg + INSERT turn)
                                         ▼
                          ┌─────────────────────────────────────┐
                          │   TURN BROKER (task-runtime esteso) │
                          │   • enqueue (priority, per-thread)  │
                          │   • worker pool (N, lease-backed)   │
                          │   • resource governor (browser,LLM) │
                          │   • recovery al boot                │
                          └──────────────┬──────────────────────┘
                                         │ spawn turn executor
                                         ▼
                          ┌─────────────────────────────────────┐
                          │   TURN EXECUTOR (server-owned)      │
                          │   agent-loop esistente              │
                          │   → INSERT turn_events              │
                          │   → broadcast delta su turn_id      │
                          └──────────────┬──────────────────────┘
                                         ▼
                          ┌─────────────────────────────────────┐
                          │   SUBSCRIBERS                       │
                          │   GET /turns/{id}/stream            │
                          │   (replay turn_events + live)       │
                          │   client si attacca/si stacca       │
                          │   → alimenta la working island      │
                          └─────────────────────────────────────┘
```

### Spostamento del source of truth

| Aspetto | Oggi | Con il broker |
|---|---|---|
| Stato del turno | `turn_status::registry` (in-memory `Mutex<HashMap>`) | `tasks.status` (SQLite, persistente) |
| Coda | coda interna del `Semaphore::acquire().await` | tabella `tasks WHERE status='queued'`, ordinata per priorità + created_at |
| Concorrenza globale | `turn_priority::acquire_turn_slot` (semaforo) | `ResourceGovernor` + worker pool |
| Concorrenza per-thread | `promptSubmitting` lato client (non difeso dal server) | `SELECT … WHERE status IN ('queued','running')` dentro la transazione di enqueue → 409 |
| Browser condiviso | `browse_web_lock` (`tokio::Mutex<()>`) | `ResourceGovernor` per `BrowserSession` + preemption |
| Foreground/background | `fg_active()` (`AtomicUsize`) + `yield_to_foreground` | `TaskPriority` nel scheduler + preemption nel governor |
| Stream | WebSocket submit (possessivo: la connessione = il turno) | `GET /turns/{id}/stream` subscribe (non possessivo, resume-able) |
| Island | `useLiveWorkspace` (React ephemeral, per-thread attivo) | sottoscrizione a `turn_events` (persistente, resume-able) |
| Automation vs interattivo | due path (`proactive_prompt` queue vs `generate_stream` diretto) | un unico `kind=chat_turn` con `source` discriminatorio |

## Modello dati

### DB unificato: `homun.sqlite`

Un singolo file SQLite sostituisce `desktop-gateway.sqlite` + `task-runtime.sqlite`. La apertura in `AppState` (`main.rs:637-638`) viene unificata. La migrazione dei dati esistenti avviene a freddo in Fase 0 (vedi §Strategia di migrazione).

### Tabella `tasks` (estesa, riusata da task-runtime)

Lo schema esistente (`task-runtime/src/store.rs:40-53`) viene esteso con colonne specifiche per `chat_turn` tramite ALTER guarded (pattern già usato in `chat_store.rs:2159-2254`):

```sql
-- colonne esistenti (invariate)
task_id, user_id, workspace_id, kind, status, priority,
created_at, updated_at, blocked_reason, task_json,
lease_owner, lease_expires_at, last_heartbeat_at,
not_before, deadline, expires_at, recurrence, ...

-- nuove colonne specifiche chat_turn (guarded ALTER)
thread_id        TEXT,   -- FK chat_threads + vincolo 1-turno-per-thread
request_id       TEXT,   -- "chat_stream_..." id stabile client↔server
prompt_text      TEXT,   -- prompt originale embedded (atomicità)
attachments_json TEXT,
visible_prompt   TEXT,
turn_result_json TEXT,   -- esito finalizzato (metrics, message_ids)
source           TEXT,   -- "interactive" | "automation" | "channel" | "connector"
approval         TEXT,   -- "full" | "confirm" | "autonomous" | "read_only"
```

**Perché `prompt_text` embedded nel task**: la scrittura del prompt e l'accodamento del turno diventano la stessa operazione. Insieme al messaggio utente in `chat_messages` (stessa transazione, stesso DB), si ottiene atomicità totale — nessun prompt perso o duplicato in caso di crash tra le scritture.

### Tabella `turn_events` (nuova)

Persistenza dello stream per il resume e l'alimentazione della working island:

```sql
CREATE TABLE IF NOT EXISTS turn_events (
  event_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,           -- monotono per turn_id
  kind        TEXT NOT NULL,              -- delta|reasoning|activity|plan_update|tool|done|error|cancelled|aborted
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE(turn_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, seq);
```

**Semantica conservata da `liveWorkspace.ts:31-45`**: `plan_update` = replace dell'ultimo piano, `activity` = append di uno step. Il protocollo `turn_events` persiste i due tipi di evento così come sono; il parser `parsePlanSteps` (`ChatView.tsx:3660`) resta valido.

**Marker di abort**: quando un turno viene rimesso in `Queued` per lease scaduto, si scrive un evento `kind=aborted` con `payload={ reason, last_seq }`. Un client ricollegato lo vede e sa di scartare i delta precedenti dell'esecuzione abortita.

### Tabella `broker_meta` (nuova)

Traccia la `process_generation` per il recovery lease-aware:

```sql
CREATE TABLE IF NOT EXISTS broker_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- riga: ('process_generation', '<u64 monotono>')
```

Ad ogni avvio del processo, `process_generation` viene incrementata e persistita. Quando un worker acquisisce un turno, scrive `lease_owner = "<generation>:<worker_id>"`. Al boot, `recover_at_boot()` rimette in `Queued` tutti i `Running` il cui `lease_owner` non inizia con la generation attuale.

### Tabelle riusate invariate

`chat_threads`, `chat_messages` (con le loro estensioni: `parent_id`, `active_leaf_id`), `automations`, `automation_runs`, `automation_event_dedup`, `task_dependencies`, `resource_reservations`, `task_checkpoints`, `task_approvals` — tutte migrate nel DB unificato, schema invariato.

## Lifecycle del turno

State machine deterministica; le transizioni sono validate dal broker, mai fidarsi dell'executor.

```
                         POST /api/chat/turns
                                  │
                                  ▼
                            ┌──────────┐
                            │  QUEUED  │ ◄── stato iniziale (persistito)
                            └────┬─────┘
                  worker lease   │
                 ┌───────────────┘
                 ▼
            ┌──────────┐   recovery (lease scaduto)
            │ RUNNING  │ ─────────────────────────► QUEUED (riparte da capo)
            └────┬─────┘                              + evento kind=aborted
       done/err  │  cancel/abort                      scritto in turn_events
        ┌────────┴────────┐
        ▼                 ▼
  ┌──────────┐      ┌──────────┐
  │ COMPLETED│      │ CANCELLED│   (anche FAILED — errore non recuperabile)
  └──────────┘      └──────────┘
   terminali: non toccati dal broker
```

| Stato | Significato | Persistito | Recovery al boot |
|---|---|---|---|
| `Queued` | in coda, attesa slot | sì | candidato all'esecuzione |
| `Running` | worker attivo (con lease) | sì + `lease_owner`, `lease_expires_at` | se lease di generation precedente → `Queued` |
| `Completed` | finito con successo, esito scritto | sì | terminale, ignorato |
| `Failed` | errore non recuperabile | sì | terminale |
| `Cancelled` | annullato da utente/server | sì | terminale |

**No resume mid-turn**: un `Running` rimesso in `Queued` riparte da capo (niente checkpoint dell'agent-loop). Il prompt è embedded nel task, quindi non c'è perdita di input. Gli `turn_events` dell'esecuzione abortita vengono marcati con un evento `kind=aborted`.

## Concorrenza — tre livelli in cascada

### Livello 1 — Vincolo per-thread (409 se busy, transazionale)

All'enqueue (`POST /turns`), dentro la **stessa transazione** che inserisce il task:

```sql
BEGIN;
  INSERT INTO chat_messages (user_message con request_id stabile);
  SELECT 1 FROM tasks
    WHERE thread_id = :tid
      AND kind = 'chat_turn'
      AND status IN ('queued','running')
    LIMIT 1;
  -- se esiste → ROLLBACK + rispondi 409 Conflict { error: "thread_busy", active_turn_id }
  -- se non esiste → INSERT INTO tasks (status='queued', prompt_text=…) + COMMIT
END;
```

Transazionale, indipendente dal client. Anche due chiamate simultanee non passano entrambe.

### Livello 2 — Scheduling globale (worker pool con priorità)

`TaskScheduler::ready_tasks` (`task-runtime/src/scheduler.rs:11-47`) già esiste e fa esattamente questo:
- ordina per `(priority DESC, created_at ASC)` → FIFO dentro la stessa priorità
- salta i task `Running`
- rispetta il `ResourceGovernor` (livello 3)

Worker pool N (env `HOMUN_TASK_WORKER_COUNT`, default 3), poll-loop 1Hz con `spawn_blocking`, ognuno prende un task alla volta e ne acquisisce il lease. **Questo meccanismo viene semplicemente esteso a `kind=chat_turn`** — non si scrive nulla di nuovo.

### Livello 3 — Risorse condivise (ResourceGovernor)

`ResourceGovernor` con `conservative_defaults()` (`task-runtime/src/resources.rs:14-26`): `LlmInference=1`, `BrowserSession=1`, `ComputerSession=1`. Quando un turno ha bisogno del browser, chiama `mark_waiting_if_unavailable` → va in `WaitingResource` finché la risorsa non si libera. **Sostituisce completamente** `browse_web_lock` + `acquire_browse_lock_queued`.

### Priorità e foreground/background

L'`AtomicUsize` `fg_active()` viene **rimosso**. Sostituito da `TaskPriority` (`task-runtime/src/types.rs:98-106`):

| Origine turno | Priorità |
|---|---|
| Turno utente in-app (`POST /turns` da client) | `High` |
| Continuazione/regenerate utente | `High` |
| Automation schedulata in background | `Background` |
| Turno da channel (`channel_*`) | `Low` |
| ConnectorPoll automation | `Background` |

**Preemption del browser** (l'unica logica nuova nel governor, ~50 righe): quando un task `High` richiede una risorsa `BrowserSession` tenuta da un task `Background`/`Low`, il `ResourceGovernor` notifica al detentore di rilasciare. Si implementa con un `tokio::sync::Notify` per `resource_class` + un campo `held_by_priority` nella risorsa. Il detentore a priorità inferiore interrompe il suo step corrente, rilascia la risorsa, torna in `WaitingResource`.

## Recovery al boot

Funzione `recover_at_boot()`, eseguita **prima** di aprire ai client:

```
incrementa e persisti process_generation in broker_meta

PER OGNI task WHERE kind='chat_turn':
  se status = 'Running':
    se lease_owner NON inizia con la generation attuale
       → status='Queued', clear lease_owner/lease_expires_at
       → INSERT turn_events(turn_id, kind='aborted', payload={reason:'lease_expired'})
    se lease_owner inizia con la generation attuale
       → impossibile in single-process (siamo appena partiti); lascia Running come difesa difensiva
  se status = 'Queued' → lascia, sarà preso dal worker poll
  se status in (Completed/Failed/Cancelled) → ignora
```

**Reconcile con `chat_messages`**: ogni `chat_turn` rimesso in `Queued` ha già `prompt_text` embedded. Il messaggio utente può essere già in `chat_messages` (persist-on-send pre-broker, o scritto nella stessa transazione di enqueue) — il broker lo riconosce via `request_id` (`INSERT OR IGNORE`) e non lo duplica.

## Cancellation

`DELETE /api/chat/turns/{turn_id}` → ibrido (notify istantaneo + DB flag):

```rust
fn cancel_turn(turn_id):
  1. UPDATE tasks SET status='Cancelled' WHERE task_id=?   // durevole, source of truth
  2. if let Some(notify) = executor_registry[turn_id] {
        notify.notify_one()                                 // istantaneo in-process
     }
```

L'agent-loop, ad ogni iterazione, fa `select!` tra lo step e `notify.notified()`; in parallelo, ogni N step rilegge `tasks.status` come fallback. Quando vede il cancel, interrompe pulitamente: scrive un `turn_event kind=cancelled`, aggiorna `turn_result_json`, rilascia il lease e le risorse.

## API server (il nuovo contratto "client-agnostic")

### Ammissione

```
POST /api/chat/turns                          → 201 + TurnView
  body: { thread_id, prompt, attachments?, visible_prompt?,
          mode?, model?, priority?, approval? }
  - 1 transazione: INSERT user msg + INSERT task(queued)
  - se esiste già chat_turn queued/running per thread_id
    → 409 Conflict { error: "thread_busy", active_turn_id }

GET  /api/chat/turns?thread_id=…&status=…     → [TurnView]
GET  /api/chat/turns/{turn_id}                → TurnView
DELETE /api/chat/turns/{turn_id}              → 202 (cancel)
```

### Streaming (subscribe, non possessivo)

```
GET /api/chat/turns/{turn_id}/stream          → NDJSON/SSE
  - replay: scarica turn_events con seq > ?since=…
  - live:   si attacca al broadcast channel del turn_id
  - chiusura del client NON interrompe il turno

GET /api/chat/turns/{turn_id}/events?since=…  → [TurnEvent] (batch)
  - per recupero a blocchi senza stream live
```

### Osservabilità

```
GET /api/chat/threads/{tid}/turn              → TurnView | null
  (il "turno attivo" di un thread: queued o running)
GET /api/chat/turn_statuses                   → [mantenuto per retrocompat, proiezione di tasks]
```

### TurnView (la proiezione che il client usa)

```ts
{
  turn_id, thread_id, request_id,
  status: "queued" | "running" | "completed" | "failed" | "cancelled",
  phase?:  "running" | "waiting_resource" | "waiting_browser",  // detail dentro running
  detail?: string,
  position_in_queue?: number,    // solo se queued
  priority: "background" | "low" | "normal" | "high",
  source:  "interactive" | "automation" | "channel" | "connector",
  created_at, updated_at,
  result?: { message_ids, metrics }  // solo se completed
}
```

### Endpoint legacy

`POST /api/chat/generate_stream` viene mantenuto come **thin shim** durante la transizione: internamente chiama `POST /turns` + apre lo stream. Rimosso a fine Fase 2.

## Working Island — integrazione via turn_events

**Oggi** (`WorkspaceIsland`, `ChatView.tsx:2431`): alimentata dallo stream WebSocket via `useLiveWorkspace`. Due sole categorie di evento: `plan_update` (replace del piano) e `activity` (append step). Il `turn_status` registry non la alimenta.

**Con il broker**: la island legge da `turn_events` invece che dal WebSocket. Conserva il riduttore `applyLiveEvent` (`liveWorkspace.ts:31-45`) così com'è — la semantica replace/append è preservata nel protocollo.

### Cosa cambia

- I quattro siti di feed (`ChatView.tsx:812, 1042, 1365-1368, 1683-1686`) e i `reset()` (`716, 1004, 1312, 1534-1536`) vengono rimpiazzati da una sottoscrizione a `GET /turns/{turn_id}/events?since=…`.
- **L'hand-off sticky** (oggi: `liveWorkspace` non resettato a fine turno, solo al prossimo submit, per evitare flicker) cade naturalmente: gli eventi persistono oltre la fine del turno. L'island mostra l'ultimo piano finché non arriva un nuovo `turn_id`. Il workaround proprietario viene eliminato.
- **Resume dopo reload**: oggi si appoggia a marker `localStorage` + parser di testo sul messaggio finalizzato (`latestPlanMarkdown`, `latestActivitySteps`). Con il broker: `localStorage { turn_id, last_seq }` + `GET /turns/{id}/events?since=last_seq`. Più robusto.

### Cosa NON cambia (scope conservativo)

- **Single-thread**: l'island resta legata al thread attivo (`key={threadId}` in `App.tsx:1463`). Mostrare thread in background è future work — il broker lo abilita (gli eventi sono query-able per `turn_id`) ma non lo implementa.
- **Parser del piano**: `parsePlanSteps` (regex sul markdown) resta valido.
- **Rendering**: il componente `WorkspaceIsland` stesso non cambia, cambia solo la sorgente eventi.

## Automation — unificazione su `kind=chat_turn`

**Ritrovato chiave**: le automation passano **già** per la coda persistente `task-runtime`. Ogni automation produce oggi un `TaskRecord{kind:"proactive_prompt"}` (`materialize_automation_task` `main.rs:9781`, `fire_channel_event_automations` `main.rs:10628`, `connector_fire_run` `main.rs:10364`), eseguito da `execute_proactive_prompt_task` (`main.rs:33657`) che chiama `stream_chat_via_openai` — la stessa funzione dei turni interattivi.

### Unificazione (U2)

Tutto diventa `kind=chat_turn` con `source` discriminatorio:

| source | origine | approval default | priority |
|---|---|---|---|
| `interactive` | `POST /turns` da client | `full` | `High` |
| `automation` | Schedule automation | da `Automation.approval` | `Background` |
| `channel` | Event ChannelMessage | da `Automation.approval` | `Low` |
| `connector` | Event ConnectorPoll | da `Automation.approval` | `Background` |

**L'executor `execute_proactive_prompt_task` viene generalizzato** in `execute_chat_turn_task` che legge `source` e `approval` da `input_json` e applica la tool policy corrispondente. La logica di risoluzione thread (`proactive_thread_plan` `main.rs:33602`), `start_visible_conversation_turn` (`main.rs:30175`), `run_agent_turn_into_message` (`main.rs:30362`) si riusano.

**Estensione necessaria a `run_agent_turn_into_message`**: oggi fa "drain → messaggio" (consume lo stream, nessun fan-out live). Per supportare i turni interattivi via broker deve essere estesa a emettere **anche** ogni delta/event su `turn_events` (INSERT) e sul broadcast channel per-`turn_id` (fan-out live ai subscriber). La semantica diventa: per ogni evento dello stream → `INSERT turn_events` + `broadcast.send` + accumulo per il messaggio finalizzato. Questo preserva sia il drain-to-message (durability del risultato) sia lo stream live (UX). È l'adattamento centrale del path di esecuzione.

### Migrazione `proactive_prompt` → `chat_turn`

In Fase 0 (migrazione a freddo): ogni task esistente con `kind='proactive_prompt'` viene riscritto a `kind='chat_turn'` con `source` derivato dal `input_json.source` esistente (`"channel_event"` → `channel`, `"connector_poll"` → `connector`, default → `automation`).

### Visibilità nella coda

`humanize_task_kind` (`main.rs:46776`) e `is_internal_task_kind` (`main.rs:46762`) vengono aggiornati: `chat_turn` con `source='interactive'` viene nascosto (come gli altri task interni del thread), mentre `chat_turn` con `source!='interactive'` resta visibile (etichettato "Automation" come oggi per `proactive_prompt`).

## Strategia di migrazione (rollout incrementale)

Tre fasi, ciascuna shippable e revertibile.

### Fase 0 — Foundation (nessun behavior change)

- Crea `homun.sqlite` con schema unificato (estende `task-runtime` con `kind`-aware, `turn_events`, `broker_meta`, colonne `chat_turn`).
- **Migration script** che copia `chat_store` + `task-runtime` esistenti nel nuovo DB. Dieta: thread, messaggi, task esistenti (con rename `proactive_prompt` → `chat_turn`).
- **Dual-write shadow**: ogni nuovo messaggio/turno scritto sia nel vecchio store sia nel nuovo, con confronto a regime.
- Boot recovery + lease + ResourceGovernor per `chat_turn` attivi, ma **dietro feature flag** `HOMUN_TURN_BROKER=off` (default off).
- **Exit criterion**: dual-write verificato, zero divergenze, test di recovery passano.

### Fase 1 — Broker live per i turni (flag on, client vecchio)

- `HOMUN_TURN_BROKER=on` → `POST /turns` diventa il path reale; `generate_stream` diventa thin shim (enqueue + stream).
- Worker pool esteso a `chat_turn`. `turn_priority` semaforo rimosso, `browse_web_lock` rimosso (sostituito da ResourceGovernor).
- `turn_status` registry mantenuto come proiezione read-only di `tasks` (per non rompere il poll dei client vecchi).
- **Exit criterion**: turni funzionano end-to-end via broker; behavior equivalente al vecchio sistema; metriche (latenza, throughput) in linea o migliori.

### Fase 2 — Client nuovo path + cleanup

- Desktop migrato a `POST /turns` + subscribe separato.
- Rimosso `promptSubmitting`-as-source-of-truth (diventa derivato dal server). Rimosso `wait_if_busy` (codice morto). Rimossa la shim `generate_stream`. Rimossa la tabella `turn_status` in-memory.
- Working island migrata a `turn_events` (rimossi i quattro siti di feed WebSocket + `reset()`).
- **Exit criterion**: un client "bare" (curl, o mini-app) riesce a fare un turno end-to-end usando solo il nuovo contratto.

### Fase 3 — Future-proofing (post-stabilizzazione, opzionale)

- Multi-process readiness (la generation-aware recovery la supporta già).
- WebSocket multiplex (un unico WS per tutti i turn_i di un client, utile per app mobile).
- Backpressure sullo stream (client lento → spill su DB).
- Working island multi-thread (cockpit dei thread in background).

## Componenti — destino finale

| Componente oggi | Destino |
|---|---|
| `turn_priority::acquire_turn_slot` (semaforo globale) | **Rimosso** → ResourceGovernor + worker pool |
| `turn_priority::yield_to_foreground` + `fg_active()` | **Rimosso** → priority nel scheduler + browser preemption |
| `turn_status::*` (registry in-memory) | **Rimosso** → `tasks.status` + `turn_events` |
| `browse_web_lock` + `acquire_browse_lock_queued` | **Rimosso** → ResourceGovernor `BrowserSession` |
| `wait_if_busy` (codice morto) | **Rimosso** → 409 del broker |
| `generate_stream` (entry point) | **Thin shim temporaneo** → rimosso a fine Fase 2 |
| `TaskStore`/`LeaseManager`/`TaskScheduler`/`ResourceGovernor` | **Riusati così come sono**, estesi a `chat_turn` |
| `start_task_executor_worker` | **Esteso** a `chat_turn` (executor `execute_chat_turn_task`) |
| `execute_proactive_prompt_task` | **Generalizzato** in `execute_chat_turn_task` (source-aware) |
| `useLiveWorkspace` + siti di feed WebSocket | **Migrati** a sottoscrizione `turn_events` |
| `promptSubmitting` lato client | **Divenuto** derivato dal server (UX gate, non source of truth) |
| `latestPlanMarkdown`/`latestActivitySteps` (parser fallback) | **Riusati** come fallback persistente su `turn_events` |

## Testing

- **Unit**: lifecycle state machine (transizioni valide/rifiutate); `recover_at_boot` con vari stati + generation; 409 se busy transazionale (due enqueue concorrenti, uno solo passa); broker priority ordering.
- **Integrazione**: end-to-end interactive turn via broker; automation Schedule → `chat_turn` con `source=automation`; ChannelMessage → `source=channel`; ConnectorPoll → `source=connector`; browser preemption (task `High` aspetta che task `Background` rilasci entro timeout); cancel via Notify + DB flag; stream resume dopo disconnect (`since=seq`); recovery al boot con lease scaduto.
- **Migrazione**: script di migrazione su un DB di produzione-copia; verifica conteggi righe, integrità referenziale, rename `proactive_prompt` → `chat_turn`.
- **Shadow comparison** (Fase 0): ogni write confrontata tra vecchio e nuovo store; alert su divergenza.

## Rischi e residuali onesti

1. **Migration dei dati esistenti**: il dual-write in Fase 0 ha un costo (ogni write ×2). Temporaneo ma da misurare; se `chat_store` è grosso, migrazione a freddo con server fermo. Lo spec assume migrazione a freddo (più sicura), ma la decisione finale è in Fase 0.
2. **Browser preemption** (~50 righe nuove nel governor): unico pezzo di logica non banale scritto da zero. Test di integrazione dedicato: task `High` richiede browser tenuto da `Background`; entro timeout (es. 5s) il `Background` rilascia e l'`High` procede. Da definire: cosa fa il `Background` dopo aver rilasciato ( torna in `WaitingResource` e riprende quando si libera).
3. **Write amplification di `turn_events`**: ogni delta = 1 INSERT. Per turni molto lunghi può essere significativo. **Euristica di retention** (da definire in implementazione): eventi `delta`/`reasoning` consolidati dopo `done` (keep dei `plan_update`/`activity`/`done`/`error`/`cancelled` finali); spill su DB con batch ogni N eventi o su checkpoint temporale; pulizia periodica dei `turn_events` di turni terminali più vecchi di X giorni.
4. **No resume mid-turn**: un turno rimesso in coda riparte da capo. Onestamente dichiarato nei non-obiettivi. Se diventa un problema, Fase futura con checkpoint dell'agent-loop.
5. **Thick shim `generate_stream` in Fase 1**: introduce un layer di traduzione che va testato a parte. È temporaneo ma va rimosso tempestivamente in Fase 2 per non accumulare debito.
6. **Single-process assumption per il recovery**: il design **non preclude** il multi-process (process generation + lease-aware), ma in single-process oggi la regola "tutti i `Running` di generation precedente tornano `Queued`" è quella che gira. Se si introducesse un secondo processo senza adattare il recovery, si avrebbero race sul lease. Documentato.

## Open questions (per l'implementazione)

- **Retention dei `turn_events`**: quale policy esatta? (proposta: keep tutto fino a `done`, poi consolida + purge dopo 7 giorni per turni terminali)
- **Comportamento del `Background` dopo preemption del browser**: torna in `WaitingResource` automaticamente, o fallisce/riprova con backoff?
- **Migrazione a freddo vs a caldo**: la Fase 0 assume a freddo (server fermo). Confermare in base alla dimensione del DB di produzione.
- **WebSocket multiplex vs una connessione per stream**: decisione rinviata a Fase 3, ma l'API `GET /turns/{id}/stream` già supporta entrambi i modelli.
