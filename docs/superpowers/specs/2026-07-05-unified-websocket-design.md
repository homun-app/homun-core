# Unified WebSocket — Single Persistent Channel Design

**Data:** 2026-07-05
**Stato:** Design (approvato)
**Spec correlate:** `2026-07-05-turn-queue-broker-design.md`, `2026-07-05-browser-parallelism-fase2-3-design.md`

## TL;DR

Oggi il client e il gateway comunicano su 4 canali paralleli frammentati: NDJSON per-turno, NDJSON events long-lived, 12 polling HTTP, e ~120 endpoint REST. Questo design li unifica in un **singolo WebSocket persistente** (`/api/ws`) che porta tutti gli eventi (turn.delta/activity/plan/reasoning/done, computer.live, thread.updated, task.queue_changed). I comandi REST restano HTTP. Sostituisce completamente il path NDJSON legacy. Risolve: isola live, computer live, titolo, reasoning visibile, niente più polling.

## Problema

L'architettura di comunicazione attuale è frammentata in 4 canali:

1. **NDJSON per-turno** (`/generate_stream` o `/turns/{id}/stream`) — streaming token + activity + plan + done. Si chiude a fine turno. Shape diversa tra legacy e broker.
2. **NDJSON events** (`/api/events`) — push di 3 tipi evento (`thread.updated`, `thread.turn_started`, `project_graph.ready`). Long-lived con auto-reconnect. Non porta contenuto, solo "qualcosa è cambiato".
3. **12 polling HTTP** (1s-5min) — refresh messaggi (2.5s), refresh coda task (4s), stato computer (600ms-2.5s), status canali, ecc. Ridondante, latente, spreca risorse.
4. **~120 endpoint REST on-demand** — comandi: crea thread, settings, providers, skills, memory, ecc. Va bene così.

L'unica WebSocket esistente è il proxy noVNC per il pixel-stream del browser (binario, separato).

### Conseguenze della frammentazione

- **Isola non mostra activity in tempo reale** — parsia il testo persistito invece di ricevere eventi live.
- **Computer panel latente** — polling ogni 600ms-2.5s invece di push immediato.
- **Titolo della chat non si aggiorna** — race tra persistenza e refresh.
- **Reasoning non visibile** — embeddato nel testo senza una vista dedicata.
- **12 polling ridondanti** — spreco di risorse, latenza artificiale.

## Obiettivi

- **Singolo WebSocket persistente** `/api/ws` aperto al boot, che porta tutti gli eventi.
- **Enqueue REST + push sul WS**: il client invia il prompt via REST, il server pusha gli eventi del turno sul WS.
- **Resume con seq tracking**: dopo reload/disconnect, il client manda `resume` e il server replaya gli eventi dal DB.
- **Computer.live sul WS**: niente più polling per il computer panel.
- **Rimuovi legacy**: il path NDJSON (`/generate_stream`, `/stream_resume`) viene rimosso. Il broker è l'unico path.

## Non-obiettivi

- **REST on-demand resta HTTP** — i ~120 endpoint di comandi non vanno sul WS.
- **noVNC WS resta separato** — pixel stream binario VNC, non JSON.
- **WS bidirezionale per comandi** — il client invia solo `resume`/`pong` sul WS. I comandi (enqueue, cancel, settings) restano REST.
- **Electron IPC** — non trasporta dati di chat. Resta limitato al OS (folder picker, keep-awake, ecc.).

## Architettura

```
┌─────────────┐                        ┌──────────────┐
│   Client    │                        │   Gateway    │
│ (Electron)  │     GET /api/ws        │   (axum)     │
│  WSSubscription ───────────────────► │  ws_gateway  │
│  (apre al boot,                      │  (registry   │
│   persistente)        ◄───────────── │   di subs)   │
│                        WS events     │              │
│             │                        │              │
│  dispatch:  │                        │  fonti:      │
│  - turn.*   │                        │  - broker    │
│  - computer.*│                       │    turn_events│
│  - thread.* │                        │    + WS pub  │
│  - task.*   │                        │  - computer   │
│             │                        │    live state │
│             │                        │  - publish_   │
│             │                        │    app_event  │
└─────────────┘                        └──────────────┘
```

### Cosa SOSTITUISCE

| Oggi | Domani |
|---|---|
| NDJSON `/turns/{id}/stream` | `turn.*` eventi sul WS |
| NDJSON `/api/events` (3 tipi) | `thread.*` + `task.*` sul WS |
| 12 polling HTTP (messaggi, computer, queue, canali) | push sul WS |
| `subscribeAppEvents` (fetch+reader long-lived) | WS connection |
| `listenChatStreamEvent` (pub/sub in-process) | WS event dispatch |
| `/stream_resume/{request_id}` | `resume` message sul WS |
| `/generate_stream` (legacy NDJSON) | rimosso — broker unico path |
| `/api/chat/broker_enabled` | rimosso — broker sempre on |

### Cosa RESTA HTTP

I ~120 endpoint REST on-demand (comandi: crea thread, settings, providers, enqueue, cancel, memory, ecc.). Sono comandi request/response, non stream. Non ha senso metterli sul WS.

### Cosa RESTA SEPARATO

Il WS noVNC (`/api/computer/novnc/websockify`) — è pixel stream binario VNC, non JSON. Resta come è.

## Protocollo dei messaggi

Ogni messaggio WS è un JSON con un campo `type` (namespace con punto).

### Server → Client

| `type` | Payload | Sorgente |
|---|---|---|
| `hello` | `{session_id}` | connection stabilita |
| `ping` | `{}` | keepalive (ogni 30s) |
| `turn.delta` | `{turn_id, thread_id, text, seq}` | broker fanout |
| `turn.activity` | `{turn_id, thread_id, text, seq}` | broker fanout |
| `turn.plan_update` | `{turn_id, thread_id, markdown, seq}` | broker fanout |
| `turn.reasoning` | `{turn_id, thread_id, text, seq}` | broker fanout |
| `turn.tool_result` | `{turn_id, thread_id, payload, seq}` | broker fanout |
| `turn.done` | `{turn_id, thread_id, assistant_message_id, user_message_id, seq}` | broker executor |
| `turn.queued` | `{turn_id, thread_id, detail, seq}` | governor waiting |
| `turn.retry` | `{turn_id, attempt, max_attempts, backoff_seconds, seq}` | retry handler |
| `turn.error` | `{turn_id, message, seq}` | broker executor |
| `computer.live` | `{active, novnc_url, activity, steps, terminal_active, terminal}` | contained computer |
| `thread.updated` | `{thread_id, workspace}` | publish_app_event |
| `thread.turn_started` | `{thread_id, turn_id, source, title, user_message_id, assistant_message_id}` | publish_app_event |
| `task.queue_changed` | `{queue_size, running_count}` | task scheduler |
| `resume.ack` | `{turn_id, from_seq, to_seq}` | resume response |
| `resume.done` | `{turn_id, status, last_seq}` | turno terminato |

### Client → Server

| `type` | Payload | Scopo |
|---|---|---|
| `resume` | `{turn_id, since}` | Richiede replay eventi con seq > since |
| `pong` | `{}` | Risposta al ping |

### `turn.delta` e i marker `‹‹ACT››`/`‹‹REASONING››`

Il server pusha `turn.delta` con il testo **così come il gateway lo emette** — marker `‹‹ACT››`, `‹‹REASONING››` embeddati. Il client li accumula in `streamedText` (come nel path legacy), e:

- L'isola parsia `‹‹ACT››` da `streamedText` live (come faceva nel path legacy)
- Il reasoning viene strippato dal testo visibile ma mostrato in un pannello dedicato (se serve)
- A fine turno, il testo finalizzato (sanitizzato) arriva dal refresh del backend

**Niente adapter, niente mapping lossy.** Il WS è trasparente: passa il testo del gateway così com'è.

## Lifecycle, Reconnect, Resume

### Lifecycle della connection

```
Boot del client (App.tsx)
    │
    ▼
WSSubscription.connect()
    │
    ├── WS aperto → server manda {type: "hello", session_id}
    │
    ├── Registra subscribers locali:
    │   ├── ChatView → onTurnEvent(turn_id, event)
    │   ├── ChatComputerPanel → onComputerLive(state)
    │   └── App → onThreadUpdated / onTaskQueueChanged
    │
    ├── (persistente per tutta la sessione)
    │
    └── Disconnect/raggio ↻
            │
            ▼
        Reconnect con backoff (1s → 2s → 4s → 8s, cap 30s)
            │
            ▼
        WS riaperto → client manda resume per ogni turn attivo
            │
            ▼
        Server replaya turn_events (seq > lastSeq) + riattacca live
```

### Reconnect: cosa succede lato server

Il server non mantiene stato per-sessione tra le disconnessioni. Quando un WS si chiude:
- Il broker **continua a eseguire** il turno (il WS non è possessivo — già progettato così nel broker design).
- Gli eventi vengono persistiti su `turn_events` (durevoli).
- Quando il client si riconnette e manda `resume`, il server legge `turn_events` dal DB con `seq > since` e li invia, poi attacca il broadcast live.

### Resume: il protocollo preciso

**Client → Server:**
```json
{"type": "resume", "turn_id": "turn_chat_stream_...", "since": 15}
```

**Server risposta:**
```json
{"type": "resume.ack", "turn_id": "turn_chat_stream_...", "from_seq": 16, "to_seq": 23}
```
Poi invia immediatamente gli eventi 16-23 (replay dal DB), poi continua con il live broadcast se il turno è ancora attivo.

**Se il turno è già terminato** (completed/failed/cancelled):
```json
{"type": "resume.done", "turn_id": "turn_chat_stream_...", "status": "completed", "last_seq": 23}
```
Il client sa che non ci saranno altri eventi live e può refreshare il messaggio finalizzato dal backend con `GET /threads/{id}/messages`.

### Resume marker (localStorage)

Oggi il client salva `{requestId, userText, assistantMessageId}` in localStorage per il resume dopo reload. Con il WS:

```typescript
interface ResumeMarker {
  turnId: string;      // nuovo: il turn_id del broker
  requestId: string;   // legacy: per compatibilità
  lastSeq: number;     // nuovo: ultimo seq ricevuto (per il replay)
  userText: string;
  assistantMessageId: string;
}
```

Al reload, il client:
1. Apre il WS (al boot)
2. Legge il resume marker del thread attivo
3. Se c'è un `turnId` con `lastSeq`, manda `{type: "resume", turn_id, since: lastSeq}`
4. Riceve il replay + live, ricostruisce lo stato dell'isola e del testo streaming

### Seq tracking

Ogni evento `turn.*` ha un campo `seq` (monotono per turn_id, già esistente in `turn_events`). Il client:
- Mantiene `lastSeq[turnId]` in memoria
- Aggiorna ad ogni evento ricevuto
- Usa `lastSeq` nel resume marker per il replay
- Ignora eventi con `seq <= lastSeq` (dedup, in caso di race tra replay e live)

### Backpressure

Se il client è lento a consumare (es. rendering pesante), il WS bufferizza. Se il buffer si riempie, il server **può scartare eventi `turn.delta` non critici** (il testo finale è comunque persistito). Gli eventi strutturali (`turn.done`, `turn.activity`, `turn.plan_update`) non vengono mai scartati. Questo è il comportamento del `broadcast::Sender` di tokio con `Lagged` — già usato dal broker.

### Ping/Pong (keepalive)

Il server manda un `{type: "ping"}` ogni 30s. Il client risponde con `{type: "pong"}`. Se il server non riceve pong entro 10s, chiude la connection (triggera reconnect). Questo rileva WS zombie (es. laptop in sleep, rete cambiata).

## `ws_gateway` — modulo server-side

### Struttura

Un nuovo modulo nel gateway che gestisce la WebSocket unica. È composto da tre parti:

- **Registry** — `Arc<WsRegistry>` long-lived in `AppState`. Mantiene `HashMap<session_id, mpsc::Sender<ServerMessage>>` dei WS attivi.
- **Funzioni publish_** — chiamate dal broker (`publish_turn_event`), dal computer (`publish_computer_live`), e da `publish_app_event` (`publish_app_event_ws`).
- **Handler** — `GET /api/ws` (axum `WebSocketUpgrade` + loop di send/recv).

### Registry dei subscriber

```rust
pub struct WsRegistry {
    subscribers: Mutex<HashMap<String, mpsc::Sender<ServerMessage>>>,
}
```

`try_send` per il fan-out: se un subscriber è lento, l'evento viene scartato per quello. Il client recupera con il resume.

### Funzioni di publish

```rust
impl WsRegistry {
    pub fn publish_turn_event(&self, turn_id: &str, event: TurnWsEvent) { ... }
    pub fn publish_computer_live(&self, live: ComputerLiveState) { ... }
    pub fn publish_app_event(&self, event: AppEvent) { ... }
    fn broadcast(&self, msg: ServerMessage) {
        // try_send a ogni subscriber (non bloccante)
    }
}
```

### Integrazione con il broker

Il broker oggi chiama `emit_turn_event` (che persiste su `turn_events` + broadcast per-turn_id). **Cambia così:**

```rust
fn emit_turn_event(store, ws_registry, turn_id, kind, payload) {
    let event = store.insert_turn_event(turn_id, kind, payload)?;  // persiste
    let ws_event = TurnWsEvent::from(event);                        // mappa per il WS
    ws_registry.publish_turn_event(turn_id, ws_event);              // fan-out WS
}
```

Una sola funzione: persiste + pubblica. Niente più broadcast channel separato, niente più NDJSON stream handler. Il WS è il canale unico.

### Integrazione con `publish_app_event`

La funzione esistente `publish_app_event(event)` viene estesa a pubblicare anche sul WS:

```rust
fn publish_app_event(state: &AppState, event: Value) {
    // Path esistente: broadcast NDJSON (tenuto per transizione)
    if let Some(tx) = app_events_tx() { let _ = tx.send(event.to_string()); }
    // Nuovo: pubblica sul WS registry
    state.ws_registry.publish_app_event(event);
}
```

### Integrazione con il contained computer

Il gateway, quando il computer cambia stato (session update, step completato, browser apertura), chiama:

```rust
state.ws_registry.publish_computer_live(live_state);
```

Il client riceve `computer.live` sul WS e aggiorna il pannello. Niente più polling.

## `WSSubscription` — modulo client-side

### La classe

Un nuovo modulo `lib/wsSubscription.ts` che gestisce la singola connection WS persistente:

```typescript
class WSSubscription {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private handlers = new Set<ServerEventHandler>();
  private lastSeqByTurn = new Map<string, number>();
  private pingTimeout: ReturnType<typeof setTimeout> | null = null;

  connect(token: string): void { ... }
  subscribe(handler: ServerEventHandler): () => void { ... }
  resume(turnId: string): void { ... }
  private scheduleReconnect(): void { ... } // backoff 1s→2s→4s→8s, cap 30s
  private startPingWatchdog(): void { ... } // 45s timeout
}

export const wsSubscription = new WSSubscription(); // singleton
```

### Come si collega ai componenti

**App.tsx** (boot):
```typescript
useEffect(() => {
  wsSubscription.connect(gatewayToken);
  return () => wsSubscription.disconnect();
}, []);
```

**ChatView** (turn events — filter per turn_id):
```typescript
useEffect(() => {
  const unsub = wsSubscription.subscribe((msg) => {
    if (msg.turn_id !== currentTurnId) return;
    switch (msg.type) {
      case "turn.delta": streamedText += msg.text; break;
      case "turn.activity": setLiveActivitySteps(prev => [...prev, msg.text]); break;
      case "turn.plan_update": setLivePlanMarkdown(msg.markdown); break;
      case "turn.reasoning": /* reasoning visibile */ break;
      case "turn.done": refreshMessages(); break;
      case "turn.queued": case "turn.retry": /* mostra stato */ break;
    }
  });
  return unsub;
}, [currentTurnId]);
```

**ChatComputerPanel** (computer live — no più polling):
```typescript
useEffect(() => {
  const unsub = wsSubscription.subscribe((msg) => {
    if (msg.type === "computer.live") setLive(msg);
  });
  return unsub;
}, []);
```

**App** (thread.updated, task.queue_changed):
```typescript
useEffect(() => {
  const unsub = wsSubscription.subscribe((msg) => {
    if (msg.type === "thread.updated") refreshChatReadModels(msg.thread_id);
    if (msg.type === "task.queue_changed") loadTaskQueue();
  });
  return unsub;
}, []);
```

### Cosa viene RIMOSSO

| Oggi | Domani |
|---|---|
| `subscribeAppEvents` (fetch+reader NDJSON `/api/events`) | `wsSubscription.subscribe` |
| `listenChatStreamEvent` (pub/sub in-process) | `wsSubscription.subscribe` (filter per turn_id) |
| Polling messaggi 2.5s (`App.tsx:1336`) | push `thread.updated` → refresh singolo |
| Polling active_streams 4s (`App.tsx:1304`) | push `task.queue_changed` + `turn.*` status |
| Polling computer 600ms-2.5s (`ChatComputerPanel:89`) | push `computer.live` |
| Polling task queue 4s | push `task.queue_changed` |
| NDJSON `/turns/{id}/stream` handler | WS turn events |
| `/stream_resume/{request_id}` handler | WS `resume` message |
| `/api/events` NDJSON handler | WS (rimosso dopo transizione) |
| `/generate_stream` (legacy) | rimosso — broker unico path |
| `/api/chat/broker_enabled` | rimosso — broker sempre on |

### La questione del titolo (fix side-effect)

Con il WS, `thread.updated` arriva **subito** dopo che il broker persiste il messaggio. Il client, ricevendo `thread.updated`, fa `refreshChatReadModels` che legge i messaggi aggiornati. A quel punto `persistAutoTitleForCompletedTurn` può essere chiamato con il testo corretto. Il problema del titolo scompare perché non c'è più race tra persistenza e refresh.

## Strategia di migrazione

Il WS viene introdotto come **nuovo canale**, e il legacy viene rimosso contemporaneamente (approccio "clean break" scelto). Il rollout è in 4 fasi:

### Fase A — WS gateway server-side
- Crea `ws_gateway` modulo (registry + handler + publish).
- Registra route `GET /api/ws`.
- Integra `publish_turn_event` nel broker fanout.
- Integra `publish_app_event` e `publish_computer_live`.
- **Test**: handler di test che apre un WS e verifica che gli eventi arrivino.

### Fase B — WSSubscription client-side
- Crea `lib/wsSubscription.ts`.
- Connetti al boot in `App.tsx`.
- **Non rimuovere ancora il polling** — coesistenza temporanea per verificare che il WS funziona.

### Fase C — Migrare i subscriber
- ChatView: sostituisci `listenChatStreamEvent` con `wsSubscription.subscribe`.
- ChatComputerPanel: sostituisci polling con `wsSubscription.subscribe`.
- App: sostituisci `subscribeAppEvents` con `wsSubscription.subscribe`.
- Rimuovi i 12 polling `setInterval`.
- Implementa resume dopo reload.

### Fase D — Cleanup legacy
- Rimuovi `/generate_stream` handler (o shim che reindirizza al broker).
- Rimuovi `/stream_resume` handler.
- Rimuovi `/api/events` NDJSON handler.
- Rimuovi `/api/chat/broker_enabled` (broker sempre on).
- Rimuovi `HOMUN_TURN_BROKER` flag (sempre on).
- Rimuovi `turn_broker_enabled()` e tutti i branch condizionali.
- Rimuovi `parseTurnStreamEventAsLegacy` adapter (non più necessario).
- Rimuovi codice morto WebSocket in `chatApi.ts` (`consumeChatWebSocketStream`, `chatStreamWebSocketUrl`).

## Rischi e residuali onesti

1. **Rimozione completa del legacy** (Fase D) è un breaking change. Se il WS ha un bug, non c'è fallback. Mitigazione: testare le Fasi A-C attentamente prima della D. Tenere il legacy dietro flag come safety net durante le prime ore di produzione.

2. **Backpressure su WS**: `try_send` scarta eventi per subscriber lenti. Il client recupera con il resume, ma durante il recupero potrebbe vedere un "salto" nel testo streaming. Mitigazione: il testo finalizzato è sempre persistito, quindi il salto è temporaneo.

3. **12 polling rimossi**: alcuni polling (canali Telegram/WhatsApp status, system status, update check) sono meno frequenti (2.5-5min) e potrebbero non valere la pena di migrare al WS. Considerato mantenerli come polling residuale (a basso costo) se il WS non li supporta nativamente. Decisione: migrare al WS solo i polling ad alta frequenza (computer, messaggi, task queue). I polling a bassa frequenza (canali, update) restano HTTP.

4. **`turn.reasoning` come evento separato**: oggi il reasoning è embeddato come delta con marker `‹‹REASONING››`. Il WS lo passa così (trasparente). Se in futuro si vuole un pannello reasoning dedicato, il client dovrà parsare i marker dal delta (come fa oggi per `‹‹ACT››`). Non c'è un evento `turn.reasoning` separato — è un delta con un marker. Questo è coerente col path legacy e non richiede modifiche al gateway.

5. **Multi-finestra Electron**: se l'utente apre due finestre, ha due WS indipendenti. Entrambi ricevono gli stessi eventi (fan-out). Ognuno filtra per il proprio `turn_id` attivo. Va bene ma ogni WS ha il suo `lastSeq` — se le finestre guardano lo stesso turno, possono avere seq divergenti durante il resume. Non è un problema di correttezza (il DB è la verità), ma potrebbe causare un replay parziale nella seconda finestra.

## Open questions (per l'implementazione)

- **`task.queue_changed` frequenza**: il task scheduler polla ogni 1s. Se pubblichiamo a ogni cambiamento, il WS potrebbe essere rumoroso. Considera debounce o pubblicazione solo su cambiamenti significativi (count change, non ogni tick).
- **`computer.live` cadenza**: oggi il computer panel polla ogni 600ms-2.5s. Il push dovrebbe avvenire solo quando lo stato cambia davvero (non ogni 600ms). Il gateway deve rilevare i cambiamenti e pubblicare solo quelli.
