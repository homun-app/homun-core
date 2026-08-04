# Design — Working Island: sincronizzazione live durevole (cross-turn)

Data: 2026-07-10. Chiude il buco residuo del redesign island (Fase 1 già su `main`):
la **sincronizzazione**. L'island riflette lo stato (Obiettivo → Piano → Attività) solo
mentre il turno gira; appena finisce lo streaming, o al reload, o cambiando thread, il
**Piano sparisce** e l'attività resta stantia. È demo-critical perché "si vede".

## Problema (root cause, verificata su codice + DB reale)

L'island legge piano/attività da **fonti a-riposo lossy** invece che dal log durevole
canonico del broker:

- `persistedPlan = latestPlanMarkdown(messages)` legge `‹‹PLAN››` dal testo del messaggio
  o da `event_parts_json`. Sul DB reale: `‹‹PLAN››` presente in **1/6** messaggi assistant,
  `event_parts_json` **NULL su tutti** → `persistedPlan` quasi sempre **vuoto**.
- `persistedActivity = latestActivitySteps(messages)` legge `‹‹ACT››` dal testo (presente
  5/6) ma tiene **solo l'ultimo messaggio** — nessun accumulo sul thread; la headline mostra
  l'ultima `‹‹ACT››` verbatim → su un turno concluso legge come "in corso".

Il live funziona (WS `turn.event` → `liveActivitySteps`/`livePlanMarkdown`), quindi il difetto
è "funziona-mentre-gira-poi-si-rompe": `conversationPlan = isStreaming && livePlanMarkdown ?
livePlanMarkdown : persistedPlan` e `persistedPlan` è vuoto a riposo.

La fonte durevole e **completa** esiste già: `turn_events` (homun.sqlite: 634 `activity` +
115 `plan_update`, ~5 giorni di storia), collegata al thread via `tasks(thread_id,
kind='chat_turn')` con indice dedicato `idx_tasks_chat_turn_thread`. Stesso bug-class della
`SandboxReadOnlyCard` (`8eb420de`): si leggeva un canale effimero/lossy invece del durevole.

## Decisione

**L'island diventa una PROIEZIONE sul log canonico `turn_events`**, non sui marker di testo.
Nessun nuovo store (converge, don't duplicate): `turn_events` è già la fonte di verità del
broker; i marker nel testo sono un mirror parziale che va ritirato come sorgente dell'island.

### Catena durevole (già esistente, solo da esporre)

```
thread_id → tasks (kind='chat_turn', ORDER BY created_at)  →  turn_id
turn_id   → turn_events (kind IN activity|plan_update, ORDER BY seq)  →  attività + piano
```

`tasks` e `turn_events` vivono nella stessa `homun.sqlite` → una singola JOIN aggrega la
proiezione dell'INTERO thread (accumulo cross-turn):

```sql
SELECT te.kind, te.payload_json, t.status, t.created_at
FROM turn_events te JOIN tasks t ON t.task_id = te.turn_id
WHERE t.thread_id = ?1 AND t.kind = 'chat_turn'
  AND te.kind IN ('activity','plan_update')
ORDER BY t.created_at ASC, te.seq ASC
```

### Contract (endpoint)

`GET /api/chat/threads/{thread_id}/activity` →

```json
{
  "plan_markdown": "…markdown dell'ULTIMO plan_update del thread… | null",
  "activity": ["passo1", "passo2", "…"],
  "latest_turn_status": "completed|running|queued|failed|cancelled|null",
  "turn_count": 12
}
```

Semantica di aggregazione (nel crate `task-runtime`, dove vivono le tabelle):
- **Piano** = "latest wins": il markdown dell'ultimo `plan_update` del thread (un piano è un
  documento vivo che evolve, non si accumula). `null` se nessun turno ha piano.
- **Attività** = concatenazione cronologica dei `payload.text` dei soli eventi `activity` di
  tutti i turni del thread, in ordine. **Cap agli ultimi 200** step (bound sul payload; thread
  lunghi non fanno esplodere la risposta) — quando si tronca, si tiene la CODA (gli step più
  recenti) e lo si documenta nel commento del metodo.
- **latest_turn_status** = `status` del turno più recente (per distinguere live vs concluso →
  spegne la headline "sembra-in-corso").

### Wiring client (ChatView)

Nuovi stati: `projectedActivity: string[]`, `projectedPlan: string | null`,
`latestTurnStatus: string | null`. Fetch dell'endpoint:
- al **mount / cambio thread** (ricostruzione a-riposo),
- sul turno **`done`** (folda il turno appena concluso nella proiezione + `setLiveActivitySteps([])`).

Composizione (sostituisce `persistedPlan`/`persistedActivity` come sorgente island):
- `conversationActivity = isStreaming ? [...projectedActivity, ...liveActivitySteps] : projectedActivity`
- `conversationPlan = livePlanMarkdown ?? projectedPlan`

`projectedActivity` è fetchato PRIMA che il turno corrente inizi → durante lo streaming è lo
stato dei turni PRECEDENTI; `liveActivitySteps` porta il turno corrente. Su `done` si
ri-fetcha (ora include il turno concluso) e si azzera il live → nessun doppio conteggio.

L'inline `MessageActivity` del transcript resta invariato (legge i marker `‹‹ACT››` per
messaggio, che persistono, e funziona) — è per-messaggio, separato dalla proiezione cockpit.

L'Obiettivo è già durevole (via `/api/memory/goals` → `projectObjective`) — invariato.

## Fasi (gated, demo prima)

- **Fase 1 (demo-critical):** store method `project_thread_activity` + endpoint + wiring client
  → Piano/Attività/status durevoli e accumulati cross-turn, sopravvivono a fine-turno/reload/
  switch-thread. Test store (JOIN + aggregazione) + test aggregazione (latest-plan, cap) +
  smoke live.
- **Fase 2 (disaccoppiata):** navigazioni browser tipizzate (`turn_events` `browse_nav`
  `{url,status,title}`) → chip UI (cfr [[homun-browser-stealth-architecture]]). Fuori da questo
  incremento.

## Testing

- **Store (unit, task-runtime):** seed tasks+turn_events di 2 turni su un thread → `project_thread_activity`
  ritorna attività concatenate in ordine, piano = ultimo plan_update, status = ultimo turno, cap onorato.
- **Endpoint:** thread noto → 200 con lo shape; thread inesistente/vuoto → `{plan_markdown:null, activity:[], …}`.
- **UI-contract + electron:** l'island mostra il piano a riposo (nessuno streaming); dopo reload
  il piano/Progress persistono; la headline non dice "in corso" su turno `completed`.
- **Live smoke:** turno con piano multi-step → island live; a fine turno il piano RESTA; ⌘R → RESTA;
  nuovo turno → attività accumulata sopra la precedente.

## Non-goal (YAGNI)

- Nessuna paginazione dei turni (cap a 200 step basta per la demo e oltre).
- Nessun ritiro dei marker `‹‹ACT››`/`‹‹PLAN››` dal testo (il transcript inline li usa ancora;
  la loro presenza non fa danno — semplicemente non sono più la sorgente dell'island).
- Nessun fix a `event_parts_json = NULL` in questo incremento (è il mirror che stiamo bypassando;
  il canale canonico è `turn_events`). Resta un debito noto separato.
