# Working island live-sync — design (B.2)

Data: 2026-07-03. Stato: **approvato** (brainstorming). Prossimo: writing-plans.

## Problema

La **working island** (`WorkspaceIsland` in `ChatView.tsx`) mostra piano/objective/step/activity del
turno corrente, ma li deriva dai messaggi **PERSISTED** (`messages`), non dallo stream live:

- `conversationPlan = useMemo(() => latestPlanMarkdown(messages), [messages])`
  ([ChatView.tsx:449](../../../apps/desktop/src/components/ChatView.tsx))
- `conversationActivity = useMemo(() => latestActivitySteps(messages), [messages])`

Conseguenza: durante un turno lungo (es. browse, piano multi-step) l'island **resta ferma** finché
il turno non finisce e il parent ricarica i messaggi persistiti → **lag percepito** nel "cockpit".

### Perché non si può semplicemente usare `threadMessages` (il vincolo di ADR 0022 C2)

`threadMessages = optimisticMessages ?? messages` cambia **ad ogni frame di delta** (il testo scorre
a ~60fps via `flushStreamingMessage`). Derivare l'island da lì farebbe girare `latestPlanMarkdown`
(scan di **tutti** gli N messaggi) ad ogni frame → **jank** su thread lunghi. Per questo ADR 0022 C2
legò *deliberatamente* island e artifact ai messaggi persisted. Il lag è il prezzo pagato per evitare
il churn.

## L'intuizione che scioglie il trade-off

Gli eventi strutturati `plan_update` e `activity` dello stream sono **sparsi**: arrivano solo su
`update_plan` / `step_advance` / azione-tool — una manciata per turno. **Solo i delta di testo sono
per-frame.** Quindi alimentare l'island *da quegli eventi sparsi* invece che ri-derivare dal testo dà
churn **~zero** — strettamente meglio di ciò che C2 evitava (che nasceva dal ri-derivare su ogni delta).

Forme degli eventi (verificate sul codice, `chatEventPartFromStream`):
- `plan_update` → `{ type: "plan_update"; markdown: string }` — **piano completo corrente** (si sostituisce).
- `activity` → `{ type: "activity"; text: string }` — **una riga step** (si appende).

## Approccio scelto: A — Live event-sourced

Scartati (in `docs`): **B** (derivazione throttled da `threadMessages` — resta O(N)/tick + latenza,
cerotto sopra la struttura) e **C** (overlay del solo messaggio streaming nel memo — intrecciato col
rebuild per-frame di `optimisticMessages`, la ref cambia ogni flush).

A è SOTA: event-sourcing da eventi sparsi = nessun churn per costruzione, riuso della pipeline
strutturata già esistente ("structured primary", STATO B1/B3), e la superficie diventa **spiegabile**
(deriva da un evento del motore, non dal testo renderizzato) — caposaldo #9.

## Design

### Unità e confini

1. **Reducer puro** `applyLiveEvent(state, part) → state` (nuovo, in un modulo lib, es.
   `lib/liveWorkspace.ts`):
   - stato: `{ plan: string | null; activity: string[] }`.
   - `plan_update` → `{ ...state, plan: part.markdown }` (sostituisce; markdown è il piano completo).
   - `activity` → `{ ...state, activity: [...state.activity, step(part.text)] }` (appende).
   - qualsiasi altro `type` → ritorna `state` invariato.
   - **Invariante di parità**: gli step prodotti da `activity` devono avere la **stessa forma** di
     quelli di `latestActivitySteps`/`parseActivitySteps` (stessa normalizzazione della riga ‹‹ACT››).
     La normalizzazione esatta si fissa nel plan, testata contro `parseActivitySteps`.
   - Niente React, niente I/O → **unit-test deterministici** (metodologia §5).

2. **Hook** `useLiveWorkspace()` (React, in `ChatView.tsx` o modulo vicino) che incapsula lo stato
   `{ plan, activity }` + `onStreamEvent(part)` (applica il reducer via `setState`) + `reset()`.
   È l'unico punto React; la logica vive nel reducer puro.

### Wiring nelle 4 path di streaming

Le path che accumulano `streamEventParts` — `submitPrompt`, `resumeActiveStream`,
`streamRegeneratedAnswer`, `streamContinuetionIntoMessage` — chiamano `onStreamEvent(part)` **accanto**
a `streamEventParts = [...streamEventParts, part]`, e `reset()` a **inizio turno**. Un helper condiviso
evita la 5ª copia della logica: l'area è già duplicata (caposaldo #5 / metodologia §2 — convergere,
non aggiungere). Non si estende lo split di `ChatView` oltre questo (no refactor non correlato).

### Consumo nell'island

```
conversationPlan     = livePlan ?? latestPlanMarkdown(messages)
conversationActivity = liveActivity.length ? liveActivity : latestActivitySteps(messages)
```
`workspacePlanSteps` / `workspacePlanObjective` restano derivati da `conversationPlan` (già così) →
**objective e step diventano live gratis**, senza toccare `parsePlanSteps`/`parsePlanObjective`.

### Hand-off senza flicker (il punto delicato)

`reset()` avviene al **submit del turno successivo** e al **cambio thread** (`thread.threadId`), **NON**
a fine turno. Così `livePlan` resta *sticky* col suo ultimo valore finché il persisted non lo raggiunge:
a turno finito `latestPlanMarkdown(messages)` contiene lo stesso piano finale → `livePlan ?? persisted`
concordano → nessun buco né doppione. Al nuovo turno, `reset()` azzera prima che arrivi il primo
`plan_update`, e finché non arriva l'island mostra il persisted (che è il piano del turno precedente,
corretto) — nessuna finestra vuota.

### Scope (esplicito)

- **Live**: plan, objective, step, activity (il cockpit che l'utente vede muoversi).
- **Persisted (invariato, C2)**: **artifact** e `uploadedFiles`. Sono deliverable/input di fine-turno,
  non lag-sensitive → YAGNI + meno rischio. `conversationArtifacts` resta legato a `messages`.

## Error handling / edge

- Evento con `markdown`/`text` mancante o malformato → il reducer lo ignora (ritorna `state`), come già
  fa `normalizeChatEventParts`. Nessun throw nel path di streaming.
- Turno **annullato** (`cancelStreamingRequest`) o stream perso (resume expired): `livePlan` sticky è
  innocuo (il persisted subentra); il `reset()` del prossimo submit lo pulisce comunque.
- Thread switch mentre uno stream è attivo: `reset()` su cambio `threadId` evita che il piano di un
  thread perda in un altro.

## Testing

- **Unit (reducer)**: `plan_update` sostituisce; `activity` appende con la forma di `parseActivitySteps`;
  evento estraneo → no-op; malformato → no-op. Sequenza plan→activity→plan.
- **Parità**: liveActivity vs `latestActivitySteps` sullo stesso set di ‹‹ACT›› → stessi step.
- **Runtime (validare eseguendo, metodologia §6)**: app reale, turno browse multi-step → piano/objective/
  activity si muovono **live**; thread lungo → **nessun jank** (island non ricalcola per-frame);
  hand-off a fine turno → nessun flicker; annullo turno → nessun piano-fantasma.
- Gate: `npm run test:ui-contract`, `npm run build` (NON toccare `scripts/check-ui-contract.mjs` — vault).

## Caposaldi

- #5 (un solo motore/una sola logica): reducer condiviso, niente 5ª copia; riusa gli eventi strutturati.
- #9 (workspace agentico, superfici spiegabili/verificabili): l'island deriva dall'evento del motore.
- ADR 0022 C2: **non violato** — non si deriva da `threadMessages` per-frame; il churn resta evitato
  perché la sorgente sono eventi sparsi. Artifact restano persisted come prima.

## Non-goal

- Split di `ChatView.tsx` (9.4k) oltre l'helper live — debito tracciato a parte.
- Live per artifact/file — fuori scope, restano persisted.
- Transport/WebSocket (C5, differito).
