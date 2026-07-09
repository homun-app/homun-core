# Decision 0024: Estrazione del motore agentico dal gateway monolitico — il gateway diventa postino

Date: 2026-07-02

## Status

**Accepted — COMPLETO** (2026-07-08, `50ed7ec6`; confermato dall'audit di riconciliazione 2026-07-09).
Il loop agentico vive **solo** in `crates/engine::agent_loop::run_turn`, chiamato **incondizionatamente** da
`run_agent_rounds`; la copia inline e il flag `HOMUN_ENGINE_CRATE` sono **cancellati** ("un loop, nessun flag").

Definisce la **separazione motore/gateway**: estrarre il loop agentico (`stream_chat_via_openai`)
e l'esecuzione dei tool dal monolite `crates/desktop-gateway/src/main.rs` in un **crate motore**
dedicato, con un **unico chokepoint** per l'esecuzione dei tool. Il gateway HTTP resta il *postino*
(routing, auth, streaming), non il proprietario della logica d'agente.

**È il prerequisito** dichiarato da [0023](0023-sandbox-enforcement-and-unified-approval.md) (il recinto
sandbox vive sul chokepoint di esecuzione tool — che oggi non esiste come punto unico). **Realizza
fisicamente** la direzione di [0021](0021-single-guarded-loop-planning-as-tool.md) (motore #1 = il loop
guardato canonico: qui viene *ricollocato*, non riprogettato) e si compone con
[0022](0022-memory-as-out-of-path-service.md) (memoria fuori dal percorso). È la traduzione in ADR della
lezione strutturale di [confronto-zcode-vs-homun.md](../confronto-zcode-vs-homun.md) §7.1 ("stacca il
loop dal gateway in un crate/servizio separato") e [confronto-codex-produzione.md](../confronto-codex-produzione.md).

## Perché questa decisione esiste

Due sistemi indipendenti — **ZCode** (z.ai, CLI JSON-RPC su stdio) e **Codex** (OpenAI, binario Rust
`app-server` su unix socket) — hanno fatto la **stessa** scelta: il motore d'agente sta **fuori** dalla
UI/host, che fa da postino. Homun è l'eccezione: tutto vive in un processo, con il loop **inline** nel
gateway. Prove dal codice (2026-07-02):

- `crates/desktop-gateway/src/main.rs` è a **57.527 righe**; il loop `stream_chat_via_openai` è inline
  (righe ~18325–24064, ~5.700 righe).
- L'esecuzione dei tool è dispatchata per nome in **più `match name` sparsi** (righe 4321, 5639, 20638,
  37325, 37621) — **non** c'è un punto unico "esegui questo tool".
- Eppure i pezzi **canonici esistono già** nei crate: `capabilities` (`CapabilityFacade`, `registry`,
  `policy`, `mcp`, `provider`) e `orchestrator` (`brain`, `driver`, `planner`, `step_executor`,
  `agentic`). Il loop inline del gateway è la **parallela** da far convergere sulla canonica, non una
  terza da creare (caposaldo #5 — il difetto sistemico "due implementazioni, la canonica dormiente").

Conseguenze del non-farlo: il chokepoint del recinto sandbox (0023) non esiste; il loop non è testabile
in isolamento; il monolite cresce; ogni sottosistema paga la mancanza di confini.

## La decisione

### Cosa si estrae, e dove

Un **crate motore** (nome di lavoro `local-first-engine`) che possiede il **ciclo ReAct guardato** (il
motore #1 di 0021): recall memoria → prompt → chiamata modello → parsing tool-call → **esecuzione tool
al chokepoint** → osserva → itera → sintesi. Il crate NON possiede HTTP, auth, né lo streaming di
trasporto: quelli restano nel gateway.

**Il chokepoint unico**: tutti i `match name` sparsi convergono su **`CapabilityFacade::call_tool`**
(già canonico in `crates/capabilities`). È il **solo** punto che esegue un tool — ed è dove
[0023](0023-sandbox-enforcement-and-unified-approval.md) impone il recinto e consulta l'approval policy.
La convergenza dei dispatch sparsi su questo punto è metà del valore di questa ADR.

### Il confine (contratto motore ↔ gateway)

Il motore riceve un **contesto iniettato** (non l'intero `AppState`): le sue dipendenze come **trait**
(pattern già usato da 0022 per memoria e da `capabilities`/`orchestrator`):
- `MemoryRecallService` (già trait, 0022) — brief/recall/learn;
- `CapabilityExecutor` (astrae `CapabilityFacade::call_tool`) — il chokepoint tool;
- `ModelClient` — la chiamata al modello (astrae reqwest/provider);
- store necessari (chat, task) dietro trait stretti, non `Arc<Mutex<…>>` concreti.

Così `AppState` (21 campi oggi) **non attraversa** il confine: il gateway costruisce gli impl concreti e
li inietta. Il motore resta **puro e testabile** (niente reqwest/tokio-runtime hardcoded), come già fa
il crate `memory` dopo 0022 Tappa 4.

### Transport — staged: crate-in-process PRIMA, processo satellite POI

Decisione onesta sul trade-off (dove ZCode/Codex vanno oltre):

1. **Fase A — crate in-process (questa ADR).** Il motore è un crate chiamato dal gateway nello stesso
   processo. Vantaggi immediati **senza** IPC: chokepoint unico (sandbox-ready), loop testabile, monolite
   ridotto. È il taglio a valore massimo / rischio minimo.
2. **Fase B — processo satellite (follow-on, ADR separata).** Solo se serve **blast-radius isolation**
   (come `app-server`/CLI di Codex/ZCode: un crash del motore non tira giù il gateway). Aggiunge un
   transport come decisione di primo livello (unix socket + JSON-RPC; capnweb è la scelta enterprise di
   Codex). NON in questa ADR: la Fase A dà già il chokepoint che sblocca 0023.

Questo evita il "big bang" e rende ogni passo validabile — coerente col metodo (modularizzare
incrementalmente quando si tocca un'area).

## Alternative considerate

- **Lasciare il loop inline, estrarre solo un `execute_tool()` locale.** Darebbe il chokepoint sandbox
  senza estrarre il loop. Ma non risolve testabilità/dimensione né la convergenza sui crate canonici, e
  lascia il difetto "due implementazioni". Respinta: mezzo passo che non chiude il debito.
- **Saltare diretto al processo satellite (Fase B senza Fase A).** È dove arrivano ZCode/Codex, ma
  introduce IPC + serializzazione del confine prima di aver stabilizzato il confine stesso. Respinta:
  prima si definisce il contratto in-process (cheap da iterare), poi lo si mette su un socket.
- **Un nuovo crate motore da zero.** Violerebbe il caposaldo #5: `orchestrator`/`capabilities` **sono**
  la canonica. Il motore estratto **riusa** quei crate; non li duplica.

## Conseguenze

- **Positivo:** nasce il chokepoint unico tool → sblocca 0023 (sandbox); il loop diventa testabile in
  isolamento (mock di `ModelClient`/`CapabilityExecutor`); il monolite `main.rs` cala di ~5.700 righe +
  i `match` sparsi; il confine è un contratto tipizzato, non `AppState` opaco; converge la parallela sulla
  canonica (caposaldo #5).
- **Costo:** rischio di regressione nell'estrarre 5.700 righe con molte dipendenze da `AppState`; va fatto
  **incrementale e behavior-preserving**, dietro flag, con parità verificata turno-per-turno.
- **Invarianti preservati:** il loop è quello di 0021 (nessun secondo motore); memoria off-path (0022);
  local-first (caposaldo #3); l'harness possiede il control-flow (caposaldo #2).

## Sequenza d'implementazione (incrementale, behavior-preserving, gated)

1. **Contratto:** definire i trait del confine (`CapabilityExecutor`, `ModelClient`) nel crate motore;
   il gateway ne fornisce gli impl. Nessun comportamento cambia.
2. **Chokepoint:** convergere i `match name` sparsi (4321/5639/20638/37325/37621) su
   `CapabilityFacade::call_tool` via `CapabilityExecutor`. Test di parità per ogni tool migrato.
3. **Loop:** spostare `stream_chat_via_openai` nel crate motore come funzione che prende il contesto
   iniettato; `main.rs` conserva solo il wiring HTTP→motore. Dietro flag `HOMUN_ENGINE_CRATE`, parità
   verificata (stesso output turno-per-turno) prima di rendere default.
4. **Pulizia:** rimuovere la parallela inline una volta che il crate è default (caposaldo #1 igiene).
5. **(Fase B, ADR futura):** valutare il processo satellite se serve blast-radius isolation.

## Addendum 2026-07-07 — l'ordinamento è stato corretto leggendo il codice reale

L'estrazione è **iniziata** (commit `842df465`). Leggendo il codice (5 giorni dopo la stesura) due
premesse della sequenza sopra **non reggono** e vanno emendate:

- **Il passo 2 "chokepoint via `CapabilityFacade::call_tool`" è sbagliato per la realtà attuale.**
  `execute_chat_tool` **è già** l'unico entry del dispatch tool della chat, ma (a) è **intrecciato con
  `ChatToolCtx`** — eseguire un tool muta l'intero contesto del turno (tab browser, messaggi, piano,
  eventi via `tx`), NON è un puro `name+args → result`; e (b) i suoi ~53 rami sono **built-in del
  gateway** (`update_plan`, `browser_navigate`, `generate_image`, `make_deck`…), NON provider del
  `CapabilityFacade` (che serve capability REGISTRATE Composio/MCP con `list_tools`). Convergerli su
  `call_tool` significherebbe registrare ogni built-in come capability esterna: refactor semantico
  enorme e probabilmente sbagliato. **Conseguenza:** il seam `CapabilityExecutor` (il cui impl-gateway
  È `execute_chat_tool`) si estrae **INSIEME** al corpo del loop (passo 3), non prima — non può
  diventare un trait pulito finché è legato a `ctx`.

- **Ordine reale per accoppiamento (mappa delle dipendenze, easiest→hardest):** piano puro (fatto,
  inc 3) → **`ModelClient`** (chiamata modello: `build_chat_payload` + retry/fallback + collector;
  serve solo `http` + 2 cache ollama) → event sink → `execute_chat_tool` + round loop (il grosso,
  20+ `state.clone()` verso memory/chat/task/capability/browser). Quindi l'inc 4 reale è il
  **`ModelClient`**; il chokepoint tool viaggia con l'inc 5. Wrinkle noto del `ModelClient`: il
  fallback provider **muta** `model/base_url/endpoint/api_key` a metà turno → `generate` deve
  restituire (o prendere `&mut`) la config effettiva, ed emette eventi ‹‹ACT›› di retry/fallback →
  serve il sink.

- Stato ADR 0022 (`MemoryRecallService` come trait iniettabile) è **pronto** da usare come port
  memoria del confine (risponde alla domanda aperta "ordine vs 0022").

## Domande aperte

- **Granularità dei trait store:** quali store attraversano davvero il confine del loop (chat, task) e
  quali restano lato gateway? Va tracciato leggendo le dipendenze reali di `stream_chat_via_openai`.
- **Streaming:** il loop produce eventi (`GenerateStreamEvent`); il canale sync→async attuale
  (`tokio::mpsc`) resta il confine di streaming o va ridefinito col contratto?
- **Ordine vs 0022/0023:** memoria off-path (0022) e questa estrazione toccano lo stesso percorso —
  vanno sequenziate (prima 0022 stabilizza il `MemoryRecallService`, che è già un trait pronto da
  iniettare?) o intrecciate con cura.
- **Fase B transport:** se/quando si va a processo separato, unix socket + JSON-RPC (semplice) vs
  capnweb/Cap'n-Proto (perf, scelta di Codex)? Decisione rimandata alla ADR di Fase B.
