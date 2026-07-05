# Client Migration to Broker Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrare il client desktop dal path `POST /api/chat/generate_stream` (HTTP NDJSON diretto) al nuovo path broker (`POST /api/chat/turns` + `GET /turns/{id}/stream`), dietro feature flag `HOMUN_TURN_BROKER`. Il broker diventa l'unica source of truth per la persistenza (rimuove `commit_prompt_result` lato client).

**Architecture:** Cambio chirurgico nel solo strato di trasporto (`coreBridge.ts`). `ChatView.tsx` non va toccato: continua a generare `request_id` client-side e a consumare gli stessi eventi NDJSON. Il bridge split la singola call in due: (a) `POST /turns` per l'enqueue, (b) `GET /turns/{id}/stream` per lo stream NDJSON. Il broker committa il messaggio assistant finalizzato; il client rimuove `commit_prompt_result`. Tutto dietro feature flag lato gateway (il bridge legge la stessa env / un endpoint di capability).

**Tech Stack:** TypeScript, React, `fetch` + `ReadableStream` (già usati), feature flag.

**Spec di riferimento:** `docs/superpowers/specs/2026-07-05-turn-queue-broker-design.md`
**Piani precedenti:** Phase 0 (✅), Slice 1a (✅), Phase 1b (✅), retry policy (✅), browser gating (✅)

---

## File Structure

**Modify:**
- `apps/desktop/src/lib/coreBridge.ts` — riscrivere `submitBrowserRuntimeChatPromptStream` (split in enqueue + stream), `resumeBrowserRuntimeChatPromptStream` (cambiare endpoint), `electronActiveStreams` (opzionale, futuro). ~80 righe.
- `apps/desktop/src/lib/chatApi.ts` — aggiungere `enqueueTurn` (POST /turns) e `openTurnStream` (GET /turns/{id}/stream). Riutilizzare `consumeChatStreamResponse` come reader NDJSON. ~40 righe.

**NOT touched:**
- `apps/desktop/src/components/ChatView.tsx` — zero modifiche funzionali (continua a generare `request_id`, consumare `CoreChatStreamEvent`, gestire optimistic messages).

---

## Task 1: `chatApi.enqueueTurn` — POST /api/chat/turns

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts`

- [ ] **Step 1.1: Aggiungi il tipo `EnqueueTurnResponse` e la funzione `enqueueTurn`**

In `apps/desktop/src/lib/chatApi.ts`, vicino alle altre funzioni di chat, aggiungi:

```typescript
/** Response body for POST /api/chat/turns. */
export interface EnqueueTurnResponse {
  turn_id: string;
  thread_id: string;
  request_id: string;
  status: "queued";
  position_in_queue: number;
}

/** Error body when the thread already has an active turn (HTTP 409). */
export interface ThreadBusyError {
  error: "thread_busy";
  thread_id: string;
  active_turn_id: string;
}

/**
 * Enqueue a chat turn via the broker. Returns the turn_id (which the client uses
 * to subscribe to the stream). Throws if the thread is busy (409) or on other
 * errors. The client passes its own request_id so the turn_id is prevedibile
 * (broker derives turn_id = `turn_{request_id}`).
 */
export async function enqueueTurn(
  threadId: string,
  requestId: string,
  prompt: string,
  options?: {
    visiblePrompt?: string;
    attachments?: unknown;
    mode?: string;
    model?: string;
    source?: string;
  }
): Promise<EnqueueTurnResponse> {
  const res = await gatewayJson<EnqueueTurnResponse | ThreadBusyError>(
    "POST",
    "/api/chat/turns",
    {
      thread_id: threadId,
      request_id: requestId,
      prompt,
      visible_prompt: options?.visiblePrompt,
      attachments: options?.attachments,
      mode: options?.mode,
      model: options?.model,
      source: options?.source ?? "interactive",
    }
  );
  if (res.status === 201) return res.body as EnqueueTurnResponse;
  if (res.status === 409) {
    const err = res.body as ThreadBusyError;
    throw new TurnBusyError(err.active_turn_id);
  }
  throw new Error(`enqueueTurn: unexpected status ${res.status}`);
}

/** Thrown by enqueueTurn when the thread already has an active turn. */
export class TurnBusyError extends Error {
  constructor(public readonly activeTurnId: string) {
    super(`thread is busy with another turn: ${activeTurnId}`);
    this.name = "TurnBusyError";
  }
}
```

**Verifica:** `gatewayJson` esiste già in `chatApi.ts` (è l'helper che fa fetch + parse JSON con gli header del gateway). Cerca la sua signature e adatta il codice sopra se necessario (potrebbe restituire `{ status, body }` oppure lanciare su non-2xx). Se lancia su 409, gestisci con try/catch invece di controllare `res.status`.

- [ ] **Step 1.2: Verifica compilazione TypeScript**

Run: `cd apps/desktop && npx tsc --noEmit` (oppure `npm run typecheck` se esiste).
Expected: nessun errore.

- [ ] **Step 1.3: Commit**

```bash
git add apps/desktop/src/lib/chatApi.ts
git commit -m "feat(chat-api): enqueueTurn — POST /api/chat/turns client helper

Nuovo helper per enqueue via broker. Ritorna turn_id. Throw TurnBusyError
su 409 (thread già attivo). Il client passa il proprio request_id così il
turn_id è prevedibile (turn_{request_id})."
```

---

## Task 2: `chatApi.openTurnStream` — GET /turns/{id}/stream

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts`

- [ ] **Step 2.1: Aggiungi `openTurnStream`**

In `chatApi.ts`, aggiungi una funzione che apre il NDJSON stream del broker e restituisce un `ReadableStream` (o un async iterator di righe). Riutilizza il pattern di `consumeChatStreamResponse` se possibile:

```typescript
/**
 * Subscribe to a turn's event stream (NDJSON). Replays buffered events with
 * seq > since, then streams live events. The caller parses each line as a
 * { type, ... } JSON object (same schema as the old generate_stream events).
 *
 * Returns the raw Response so the caller can read the body with getReader().
 * Closing the connection does NOT cancel the turn (subscribe is non-possessive).
 */
export async function openTurnStream(
  turnId: string,
  since: number = 0
): Promise<Response> {
  const url = `${DESKTOP_GATEWAY_URL}/api/chat/turns/${encodeURIComponent(turnId)}/stream?since=${since}`;
  const res = await fetch(url, {
    headers: gatewayHeaders(),
  });
  if (!res.ok) {
    throw new Error(`openTurnStream: HTTP ${res.status}`);
  }
  return res;
}
```

**Verifica:** `DESKTOP_GATEWAY_URL` e `gatewayHeaders()` esistono già in `chatApi.ts` o `gatewayConfig.ts`. Adatta gli import.

- [ ] **Step 2.2: Commit**

```bash
git add apps/desktop/src/lib/chatApi.ts
git commit -m "feat(chat-api): openTurnStream — GET /turns/{id}/stream NDJSON subscriber

Subscribe non-possessivo: replay eventi con seq > since, poi live. Ritorna
la Response raw per getReader(). Chiusura del client NON cancella il turno."
```

---

## Task 3: Riscrivere `submitBrowserRuntimeChatPromptStream` nel bridge

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts:3769-3927`

- [ ] **Step 3.1: Riscrivi la funzione per usare enqueue + stream**

La funzione oggi fa una singola POST a `/generate_stream`. La nuova versione:
1. `chatApi.enqueueTurn(...)` → ottiene `turn_id`
2. `chatApi.openTurnStream(turnId, 0)` → NDJSON stream
3. Loop sul reader (come oggi, riga 3817-3869) — emette `notifyChatStreamDelta`/`notifyChatStreamEvent`
4. Quando vede evento `done` → costruisci `CorePromptSubmissionResult` dal payload `done`
5. **Rimuovi** le chiamate `commitChatPromptResult`/`commitChatContinuetionResult` (riga 3917-3924) — il broker committa nel DB

Il pattern del reader NDJSON è identico a oggi (`coreBridge.ts:3817-3869`); cambia solo la fonte (turn stream invece di generate_stream response) e i campi del `done` payload.

```typescript
async function submitBrowserRuntimeChatPromptStream(
  requestId: string,
  threadId: string,
  sessionId: string,
  prompt: string,
  attachments: unknown[] | undefined,
  visiblePrompt: string | undefined,
  model: string | undefined,
  images: string[],
  mode: string | undefined,
  branchFromId: string | undefined,
): Promise<CorePromptSubmissionResult> {
  // 1. Enqueue via broker
  const enqueued = await chatApi.enqueueTurn(threadId, requestId, prompt, {
    visiblePrompt,
    attachments: attachments?.length ? attachments : undefined,
    mode,
    model,
  });

  // 2. Subscribe to the turn stream
  const streamResponse = await chatApi.openTurnStream(enqueued.turn_id, 0);
  const reader = streamResponse.body!.getReader();
  const decoder = new TextDecoder();

  // 3. NDJSON loop (stesso pattern di oggi)
  let buffer = "";
  let result: CorePromptSubmissionResult | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const evt = JSON.parse(line);
      // Dispatch ai listener (stesso schema di oggi)
      if (evt.kind === "delta" || evt.type === "delta") {
        chatApi.notifyChatStreamDelta({
          request_id: requestId,
          type: "delta",
          delta: evt.payload?.text ?? evt.text ?? "",
        });
      } else if (evt.kind === "done" || evt.type === "done") {
        // Costruisci il result dal payload done
        result = {
          request_id: requestId,
          assistant_message: {
            id: evt.payload?.assistant_message_id ?? `local_assistant_${requestId}`,
            text: evt.payload?.text ?? "",
            role: "assistant",
            timestamp: String(Math.floor(Date.now() / 1000)),
            metadata: null,
            metrics: evt.payload?.metrics ?? null,
            feedback: null,
            saved_memory_ref: null,
            linked_task_id: null,
            linked_automation_ref: null,
            attachments: [],
          },
          effective_model: model ?? "",
        };
      } else if (evt.kind && evt.kind !== "seq") {
        // activity, plan_update, reasoning, tool, retry, queued, error, cancelled
        chatApi.notifyChatStreamEvent({
          request_id: requestId,
          type: evt.kind,
          ...(evt.payload ?? {}),
        });
      }
    }
  }

  if (!result) {
    throw new Error("turn stream ended without a done event");
  }
  // NOTA: nessun commit_chat_prompt_result — il broker ha già persistito.
  return result;
}
```

**Importante — adatta alle API reali:** la signature di `notifyChatStreamDelta`/`notifyChatStreamEvent` va verificata in `chatApi.ts`. Il mapping `evt.kind` (broker, snake_case) → `type` (CoreChatStreamEvent, snake_case) è quasi 1:1 ma alcuni nomi differiscono (`plan_update` vs `plan_update`, `tool` vs `tool_result`). Verifica `parseBrowserStreamEvent` (`coreBridge.ts:4187-4210`) per il mapping esatto e riusalo invece di riscriverlo inline.

**Rimuovi esplicitamente** le righe `commitChatPromptResult`/`commitChatContinuetionResult`/`commitChatRegeneratedResult` (~3917-3924).

- [ ] **Step 3.2: Verifica typecheck**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: nessun errore (adatta i tipi se `CorePromptSubmissionResult` ha campi diversi).

- [ ] **Step 3.3: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(core-bridge): submitBrowserRuntimeChatPromptStream — broker path

Split in enqueue (POST /turns) + subscribe (GET /turns/{id}/stream NDJSON).
Rimuove commit_prompt_result (broker è source of truth, persiste lui).
Parser NDJSON riusato. ChatView non cambia: continua a consumare gli stessi
CoreChatStreamEvent."
```

---

## Task 4: Riscrivere `resumeBrowserRuntimeChatPromptStream`

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts:3952-4051`

- [ ] **Step 4.1: Cambia l'endpoint da `stream_resume/{requestId}` a `turns/{turnId}/stream`**

La funzione oggi fa `GET /api/chat/stream_resume/{requestId}`. Con il broker, il resume è `GET /api/chat/turns/{turn_id}/stream?since=N` dove `turn_id = turn_{request_id}` e `since` è l'ultimo seq visto (0 per un resume fresco, oppure letto dal marker localStorage se lo estendiamo).

Per ora, `since = 0` (replay completo). Il `turn_id` si deriva dal `requestId` salvato nel resume marker: `turn_{requestId}`.

```typescript
async function resumeBrowserRuntimeChatPromptStream(
  requestId: string,
  threadId: string,
  sessionId: string,
  userText: string,
  assistantMessageId: string,
  commitResult: boolean,
): Promise<CorePromptSubmissionResult> {
  const turnId = `turn_${requestId}`;
  const streamResponse = await chatApi.openTurnStream(turnId, 0);
  // ... stesso NDJSON loop di submitBrowserRuntimeChatPromptStream (Task 3) ...
  // NOTA: commitResult è ora ignorato — il broker committa sempre lui.
}
```

Riusa lo stesso loop del Task 3 (idealmente estrai una funzione `consumeTurnStream(reader, requestId)` condivisa da submit e resume).

- [ ] **Step 4.2: Commit**

```bash
git add apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(core-bridge): resumeBrowserRuntimeChatPromptStream — broker resume

Endpoint cambia da stream_resume/{requestId} a turns/turn_{requestId}/stream.
turn_id derivato dal request_id nel resume marker. since=0 (replay completo).
commitResult ignorato (broker è source of truth)."
```

---

## Task 5: Feature flag lato client + smoke test

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts` (letture del flag)
- Modify: `apps/desktop/src/lib/gatewayConfig.ts` (esposizione del flag)

- [ ] **Step 5.1: Esponi lo stato del flag broker al client**

Il client deve sapere se il gateway ha il broker attivo per scegliere il path. Due opzioni:
- (a) Endpoint `GET /api/chat/broker_enabled` → `{ enabled: boolean }`
- (b) Il client legge una env esposta via Electron preload (se il desktop è Electron)

Per il web/desktop generico, l'endpoint è più pulito. Aggiungi in `chatApi.ts`:

```typescript
export async function isBrokerEnabled(): Promise<boolean> {
  try {
    const res = await fetch(`${DESKTOP_GATEWAY_URL}/api/chat/broker_enabled`, {
      headers: gatewayHeaders(),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body.enabled === true;
  } catch {
    return false;
  }
}
```

E lato gateway (in `main.rs`), aggiungi la route dietro il check esistente:

```rust
.route("/api/chat/broker_enabled", get(|| async move {
    Json(serde_json::json!({ "enabled": turn_broker_enabled() }))
}))
```

(Questa route NON va dietro il flag — deve essere sempre visibile così il client può decidere.)

- [ ] **Step 5.2: Branch nel bridge sul flag**

In `submitChatPromptStream` (entry point pubblico del bridge), aggiungi il branch:

```typescript
async function submitChatPromptStream(...): Promise<CorePromptSubmissionResult> {
  if (await chatApi.isBrokerEnabled()) {
    return submitBrowserRuntimeChatPromptStream(...);  // nuovo path broker
  }
  // ... path legacy esistente (generate_stream) ...
}
```

Cache il risultato del flag per la sessione (non fare la GET ad ogni submit).

- [ ] **Step 5.3: Smoke test manuale**

Avvia il gateway con `HOMUN_TURN_BROKER=on`. Avvia il desktop. Invia un prompt. Verifica:
- Il prompt viene inviato (visible nel thread)
- Lo streaming funziona (delta appaiono nell'UI)
- Il messaggio assistant finalizzato appare a fine turno
- L'isola mostra activity/plan se il turno ne produce
- Il tasto Stop funziona (cancel)

Avvia con flag OFF. Verifica che il path legacy funziona ancora (regression test).

- [ ] **Step 5.4: Commit**

```bash
git add apps/desktop/src/lib/ apps/desktop/src/lib/gatewayConfig.ts crates/desktop-gateway/src/main.rs
git commit -m "feat(client): broker feature flag + path selection

GET /api/chat/broker_enabled dice al client se usare il path broker.
submitChatPromptStream brancha sul flag (cache per sessione). Smoke test
on/off verificato. Path legacy preservato."
```

---

## Definition of Done

- [ ] `chatApi.enqueueTurn` (POST /turns) + `openTurnStream` (GET /turns/{id}/stream) esistono.
- [ ] `submitBrowserRuntimeChatPromptStream` usa enqueue + stream (rimuove commit_prompt_result).
- [ ] `resumeBrowserRuntimeChatPromptStream` usa il nuovo endpoint.
- [ ] `isBrokerEnabled()` + route `/broker_enabled` + branch nel bridge.
- [ ] **ChatView.tsx non toccato** (zero modifiche funzionali).
- [ ] Smoke test on: broker path funziona end-to-end (invio → stream → done → persistito).
- [ ] Smoke test off: path legacy funziona (regression).

## Rischi e residuali onesti

1. **Mappatura eventi broker → CoreChatStreamEvent**: il broker emette `{kind: "delta", payload: {text}}` mentre il client oggi si aspetta `{type: "delta", delta: "..."}`. Il mapping va verificato per ogni tipo di evento (delta/reasoning/activity/plan_update/tool/error/done/retry/queued). Il parser esistente `parseBrowserStreamEvent` potrebbe non riconoscere i nuovi `retry`/`queued` — vanno aggiunti o ignorati gracefully.
2. **`done` payload**: il broker oggi emette `{kind: "done", payload: {assistant_message_id, user_message_id}}` ma NON include il testo dell'assistant. Il client oggi si aspetta `result.assistant_message.text` dal `done`. Soluzione: il client fa un `GET /api/chat/threads/{tid}/messages` dopo il `done` per leggere il testo finalizzato (il polling 2.5s già lo fa, ma per la UX serve immediato — aggiungere una refresh esplicita dopo `done`).
3. **Cancel**: oggi il client chiude il WebSocket. Con il broker, il cancel è `DELETE /turns/{id}`. Il bridge deve mappare `cancelActiveStreaming` → `DELETE` invece di chiudere la connessione (che NON cancella più).
4. **`activeStreams`**: la sidebar busy dot oggi polla `GET /api/chat/active_streams`. Con il broker, l'equivalente è `GET /api/chat/turns?status=streaming` o il polling di `turn_statuses`. Da migrare in un task futuro.
5. **Optimistic messages**: il client crea `local_user_{requestId}` e `local_assistant_{requestId}`. Il broker crea `local_user_{requestId}` (atomico) e l'executor crea il placeholder assistant. Potrebbe esserci un duplicato se l'optimistic lato client e quello lato broker collidono — verificare che `INSERT OR IGNORE` gestisca il caso.
