# Working Island contestualizzata e persistente — Design

Data: 2026-07-08

## Contesto e problema

La "working island" (componente `WorkspaceIsland` in `apps/desktop/src/components/ChatView.tsx`,
il pannello flottante in alto a destra della chat) mostra le azioni del turno corrente
("Activity 5", "Step verified: ..."), ma:

1. **non e' permanente** — l'accumulo live viene azzerato a fine turno e al submit;
   la ricostruzione a riposo legge solo i marker dell'**ultimo** messaggio con `‹‹ACT››`,
   quindi lo storico delle azioni sparisce (o si riduce all'ultimo turno) dopo un reload;
2. **mescola cicli di vita diversi** — in 6 righe (Plan / Activity / Artifacts / Files /
   Goals / Memory) tiene insieme il *lavoro in corso* (effimero-ma-storicizzabile) e gli
   *output navigabili* (artefatti, file, screenshot: persistenti), sovraccaricando il cockpit.

Obiettivo: island **contestualizzata al thread/turno** e **permanente**, in modo che lo storico
delle azioni (tool eseguiti, step, artefatti prodotti, navigazioni browser) resti consultabile
dopo la fine del turno e dopo un reload, ancorato al thread.

Questo lavoro e' **ortogonale all'estrazione del motore** (ADR 0024) e non la tocca.

## Riferimenti

- `docs/superpowers/specs/2026-06-24-agentic-workspace-ux-design.md` — la visione UX padre
  (stato per-thread, chat al centro, deliverable di prima classe). Questo spec ne e' l'istanza
  sulla island.
- `docs/confronto-zcode-vs-homun.md` e l'app ZCode 3.2.1 (reference indicata dall'utente per
  grafica e interazioni del pannello di stato).
- ADR 0022 (memoria come layer condiviso) — gli artefatti sono gia' entita' di memoria.
- ADR 0025 (browser → `browse(goal)`) — la Fase 2 tocca lo stesso motore ma resta disaccoppiata
  (vedi sotto).
- Piano turn-queue-broker: `docs/superpowers/plans/2026-07-05-turn-queue-broker-phase1b-unified-db.md`
  (introduce il concetto `chat_turn` con helper `active_chat_turn_for_thread` / `insert_chat_turn`:
  potenziale fonte gia' pronta del legame turno↔thread — da verificare, vedi Fase 1).

## Diagnosi (verificata sul codice)

Il punto chiave: **l'attivita' e' gia' persistita in modo durevole in due store; e' il percorso
di lettura della UI che si ferma al fallback dei marker.** Non serve un nuovo store.

### Cosa e' gia' durevole (server)

- **`turn_events`** (crate `task-runtime`, `~/.homun/homun.sqlite`): log per-turno append-only,
  strutturato, chiave `(turn_id, seq)`, `kind` tipizzato
  (`delta / reasoning / activity / plan_update / tool / done / error / cancelled / ...`).
  Schema in `crates/task-runtime/src/store.rs` (`turn_events(...)`); enum `TurnEventKind` in
  `crates/task-runtime/src/types.rs`. Scrittura via `emit_turn_event`
  (`crates/desktop-gateway/src/turn_executor.rs`), commentato come sink "durevole, per il resume
  dopo reconnect". **Endpoint di lettura gia' esistente**:
  `GET /api/chat/turns/{turn_id}/events?since=<cursor>` (`get_turn_events` in `main.rs`).
- **`chat_messages.event_parts_json`** (`crates/desktop-gateway/src/chat_store.rs`): al commit
  del messaggio, `event_parts_to_json` **estrae i marker `‹‹REASONING››` / `‹‹ACT››` / `‹‹PLAN››`
  (+ choice/vault/payment) dal testo** e li salva come parti strutturate; i marker grezzi
  restano anche in `chat_messages.text`. Riletti da `event_parts_from_row`.
- **Artefatti come entita' di memoria** (`memory.sqlite`): `remember_artifact_memory` /
  `upsert_artifact_memory_record` in `main.rs` scrivono un `memories` (`memory_type:"artifact"`)
  + una `entities` (`entity_type:"artifact"`, canonical key `artifact:{thread_slug}:{name}`) +
  metadati di lifecycle. I file vivono su disco in `~/.homun/artifacts/{thread_slug}/{name}`
  (`sandbox::artifacts_dir`). **Non esiste una tabella SQL `artifacts`.**
- **`tool_runs`** (`chat_store.rs`): audit log append-only delle tool run connettori/MCP
  (ts, thread_id, tool, ok, error_kind, duration_ms, summary), potato a finestra recente.

### Perche' la island "dimentica" (lato UI, `ChatView.tsx`)

- Stato live `liveActivitySteps` / `livePlanMarkdown` (`useState`), alimentato da due canali:
  la sottoscrizione WebSocket unificata (`wsSubscription.ts`, `turn.event` con
  `kind: activity | plan_update`) e il bridge NDJSON in `submitChat`
  (`listenChatStreamEvent` → `chatEventPartFromStream`).
- **Il live viene azzerato al submit e nel `finally` di fine turno.**
- Il fallback a riposo `latestActivitySteps(messages)` ri-parsa i marker **solo dall'ultimo
  messaggio** che contiene `‹‹ACT››` (non accumula sul thread); idem `latestPlanMarkdown`.
- Merge: `isStreaming ? live : persisted`.
- **La island non legge mai `turn_events`.** Il log piu' ricco e cross-turn e' ignorato.
- Esiste gia' `MessageActivity` (componente inline nel corpo del messaggio) — riusabile.

### Lacune reali (piccole)

- **G1** — `‹‹ARTIFACT››` **non** viene derivato in `event_parts` (raggiungibile solo via store
  memoria o testo grezzo).
- **G2** — le navigazioni browser sono solo label free-text (`‹‹ACT›› "Opening {url}"` in
  `main.rs`); nessun evento tipizzato (url/status/title).
- **G3** — **da verificare**: legame durevole turno↔thread↔messaggio. `turn_events` e' per
  `turn_id`; per enumerare l'attivita' di **tutto un thread** serve poter elencare i turni del
  thread e joinare i loro eventi. Il lavoro `chat_turn` del broker
  (`active_chat_turn_for_thread`, colonne `chat_turn` su `tasks`) potrebbe gia' fornire
  `thread_id` sul turno: **prima verificare lo schema broker corrente e convergere su quello**;
  aggiungere una colonna minima solo se il legame messaggio↔turno manca davvero.

## Riferimenti convergenti da ZCode (pattern, non codice)

- **Pannello = proiezione pura** su un event-log append-only (JSONL per sessione) rigiocato in
  uno snapshot. Nessuno stato nel pannello. → Homun ha gia' l'equivalente (`turn_events`).
- **Step "sottili"**: `{content, status, priority}`; la ricchezza (input/output/durata) vive sui
  **message parts** con `state` a unione discriminata
  `pending → running → completed{input, output, startedAt, completedAt}`. E' cio' che rende
  l'output espandibile per sempre (persistito sul part, non live-only).
- **Finestra auto-focus a 3 step**: con >6 step, centra 3 step sullo step corrente; il prima
  collassa in "Nascondi N completati", il dopo in "N in attesa"; si ri-centra al cambio piano.
- **Tre display mode** (auto / sempre espanso / capsula mini) + ogni sezione collassabile con
  chevron visibile all'hover e riassunto compatto da collassato.
- **Sezioni in ordine fisso, ciascuna solo se ha contenuto.**

## Decisione di design

**La `WorkspaceIsland` diventa una proiezione pura, ancorata al thread, che si idrata dagli store
durevoli gia' esistenti — nessun nuovo store (converge, don't duplicate).** La divisione del
lavoro:

- **Island = sintesi cross-turn (cockpit)**: Obiettivo + Piano (progresso accumulato sul thread)
  + Attivita' del turno corrente. Snella, alla ZCode.
- **Transcript = storia per-turno, inline, permanente**: l'attivita' di ogni turno passato vive
  come chip dentro il proprio messaggio (`MessageActivity`, reso da `event_parts`),
  espandibile per sempre.
- **Output navigabili fuori dalla island**: Artefatti / File / Screenshot / Attivita' in
  background spostati nel menu "…" (come Claude Code). Sono viste sulle sorgenti esistenti
  (entita' memoria, disco), non nuovi store.

### Perche' SOTA (decisioni di prodotto risolte)

- **Storia dei turni passati → inline nel transcript, non timeline-switcher nella island.** Il
  transcript E' gia' la timeline cronologica, scrollabile, permanente: uno switcher nella island
  duplicherebbe quella navigazione (anti-pattern "converge, don't duplicate" a livello UX) e
  separerebbe il "come" (attivita') dal "cosa" (la risposta di quel turno). Riusa `MessageActivity`.
- **Navigazioni browser → strutturarle al layer evento, in Fase 2, disaccoppiate da ADR 0025.**
  Lasciarle free-text tradisce la promessa di ispezionabilita' proprio dove conta. Ma la
  persistenza strutturata vive **a monte del motore browser**: basta emettere un `turn_events`
  tipizzato dove oggi si emette la label. Nessuna dipendenza da `browse(goal)`/0025.

## Composizione UI target (island)

Gerarchia dall'alto (ogni blocco compare **solo se ha contenuto**):

1. **Header**: nome sezione ("Attivita'") + controlli display-mode (auto / espanso / capsula) +
   collapse. Chevron di sezione visibile all'hover; da collassato mostra un riassunto compatto
   (es. `N/M ✓` per il Piano).
2. **Obiettivo** (testo): blocco leggero fissato in cima, `surface-1`, label "Obiettivo" + testo
   dell'objective. **Condizionale**: mostrato solo se il turno/thread ha un obiettivo reale
   (piano long-horizon presente). Un Q&A breve non renderizza un blocco vuoto.
3. **Piano / Progress**: checklist con **finestra auto-focus a 3 step** (ZCode):
   - "Nascondi N completati" (collassabile) sopra;
   - finestra di 3 step centrata sul corrente (spinner + evidenziazione accent + freccia);
   - "N in attesa" (collassabile) sotto;
   - stato → stile: `pending` = testo attenuato + cerchio vuoto; `in_progress` = testo pieno +
     spinner; `completed` = testo attenuato **barrato** + check verde.
   - Fonte dati: piano accumulato sul thread (vedi Modello dati), **non** i marker dell'ultimo
     messaggio.
4. **Attivita' (turno corrente)**: chip come adattatori presentazionali sui part/eventi
   (`Explore · N file`, `Browser · N nav`, `SubAgent · <tipo>`, `Thought · Ns`), espandibili;
   l'output resta apribile perche' persistito sul part. A fine turno l'attivita' e' "sigillata"
   inline nel proprio messaggio (transcript).
5. **Footer**: ancora "Turno N · storico permanente sul thread".

Il menu "…" (fuori dalla island) espone: **Artefatti**, **File**, **Screenshot**,
**Attivita' in background** (+ le voci esistenti: Apri in, Rinomina, Archivia, ...).

## Modello dati e flusso

Nessuno store nuovo. La island e il transcript sono **proiezioni** su:

- `turn_events` — sorgente dell'attivita' e del `plan_update`, cross-turn, per il thread.
- `chat_messages.event_parts_json` — parti strutturate per-messaggio (l'attivita' inline del
  transcript).
- entita' memoria `entity_type:"artifact"` + file su disco — sorgente del menu Artefatti/File.
- `tool_runs` — audit opzionale.

Flusso di idratazione (a riposo / reload):

1. All'apertura di un thread, enumerare i suoi turni e leggere i relativi `turn_events`
   (endpoint esistente esteso a livello thread, es. `GET /api/chat/threads/{id}/activity`, oppure
   riuso del legame `chat_turn`→`turn_events` — vedi G3).
2. Ridurre gli eventi in: piano accumulato (ultimo `plan_update` per turno, o rollup), attivita'
   per turno, obiettivo corrente.
3. La island rende il rollup cross-turn; il transcript rende l'attivita' per-messaggio da
   `event_parts`.

Durante lo streaming resta il path live (WS/NDJSON) come oggi, ma **non piu' distruttivo**: a
fine turno non si azzera perdendo tutto, si converge sul persistito (che ora e' completo).

## Fase 1 — read-path, goal, piano cross-turn, persistenza inline

Sblocca il ~90% del valore usando dati **gia' strutturati**. Prevalentemente cancellazione e
ricablaggio di lettura, rischio basso, nessun impatto sul motore.

1. **Enumerazione thread→turni** (G3): verificare lo schema `chat_turn` del broker; se fornisce
   `thread_id` sul turno, riusarlo; altrimenti aggiungere il legame minimo
   turno↔thread(↔messaggio). Esporre una lettura a livello thread dei `turn_events`.
2. **Island legge il persistito cross-turn**: sostituire `latestActivitySteps/latestPlanMarkdown`
   (solo-ultimo-messaggio) con una proiezione sui `turn_events`/`event_parts` di tutto il thread.
   Non azzerare distruttivamente il live a fine turno: convergere sul persistito.
3. **Transcript permanente**: assicurare che `MessageActivity` renda da `event_parts` per **ogni**
   messaggio assistant (non solo l'ultimo), cosi' lo scroll mostra l'attivita' di ogni turno.
4. **Obiettivo (testo)**: derivare l'objective dal piano long-horizon quando presente; render
   condizionale.
5. **Finestra a 3 step + display mode + sezioni condizionali**: portare la UI al target sopra.
6. **G1 — ARTIFACT in event_parts**: derivare `‹‹ARTIFACT››` in `event_parts_to_json`
   (`chat_store.rs`) **oppure** leggere gli artefatti dalle entita' memoria per il menu; scegliere
   la via che evita duplicazione con lo store memoria (preferenza: menu legge memoria; event_parts
   solo se serve al rendering inline).
7. **Spostare Artefatti/File/Screenshot/Attivita'-in-background nel menu "…"**, rimuovendoli dalla
   island. Screenshot = filtro sulla stessa sorgente artefatti/file (`~/.homun/artifacts/...`).

## Fase 2 — navigazioni browser strutturate

Piccola, isolata, disaccoppiata da ADR 0025.

1. Dove oggi si emette `‹‹ACT›› "Opening {url}"` (`main.rs`), emettere **in piu'** un `turn_events`
   tipizzato con payload `{url, status, title}` (nuovo `kind` o payload di `tool`/`activity`
   strutturato). Additivo, behavior-preserving.
2. La label free-text si **deriva** dal payload per retro-compatibilita'.
3. Il chip "Browser · N nav" passa da testo a URL/status (come nel mockup), espandibile e
   permanente come gli altri.

## Fuori scope (non-goal)

- Checkpoint / rewind / time-travel (l'approccio C event-sourced completo): rimandato, si
  sovrappone all'estrazione del motore.
- Refactor `browse(goal)` / ADR 0025: la Fase 2 non lo richiede.
- Qualsiasi nuovo store di attivita': esplicitamente escluso.
- Riprogettazione del menu "…" oltre l'aggiunta delle 4 voci di output.

## Rischi e gate di test

- **Regressione streaming**: il path live non deve rompersi rendendo il persistito non
  distruttivo. Test: turno che stream-a attivita', poi reload → stessa attivita' presente.
- **G3 sbagliato layer**: non inventare un legame turno↔thread se il broker lo fornisce gia' →
  verificare prima (grep/read schema `chat_turn`).
- **Doppia sorgente artefatti**: evitare che il menu duplichi lo store memoria; il menu e' una
  vista.
- Gate deterministici del progetto: `cargo test -p local-first-desktop-gateway`,
  `npm run test:ui-contract`, `npm run build`. Ogni fix porta un test (metodologia).
- `ChatView.tsx` e' gia' ~9.4k righe (candidato allo split): estrarre la nuova island e la
  proiezione in moduli dedicati invece di ingrassare il file.

## Ancore nel codice (ri-verificare i simboli, i numeri di riga invecchiano)

- UI: `apps/desktop/src/components/ChatView.tsx` — `WorkspaceIsland`, `MessageActivity`,
  `latestActivitySteps` / `latestPlanMarkdown` / `parseArtifacts`, merge `isStreaming ? live :
  persisted`, sottoscrizione `turn.event`, `submitChat`/`listenChatStreamEvent`.
- UI: `apps/desktop/src/lib/wsSubscription.ts`, `apps/desktop/src/lib/markers.ts`.
- Server: `crates/task-runtime/src/store.rs` (`turn_events`), `crates/task-runtime/src/types.rs`
  (`TurnEventKind`), `crates/desktop-gateway/src/turn_executor.rs` (`emit_turn_event`),
  `crates/desktop-gateway/src/chat_store.rs` (`event_parts_to_json`, `tool_runs`),
  `crates/desktop-gateway/src/main.rs` (`get_turn_events`, `remember_artifact_memory`, marker
  browser).
