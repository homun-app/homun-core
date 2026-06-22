# Homun — Sviluppo (hub vivo)

> **Punto d'ingresso unico.** Da qui si parte e si torna. Questo file è SEMPRE
> aggiornato: se cambia una scelta importante, si aggiorna qui (o nel doc linkato).
> Ultimo aggiornamento: 2026-06-22.

## North Star

Un assistente **local-first** desktop (macOS/Win/Linux) che non è una chat passiva:
osserva, capisce richieste naturali, sceglie strumenti in modo governato, esegue
task anche lunghi (coda/approval/checkpoint), mostra cosa fa (Chat + Local Computer)
e costruisce una **memoria verificabile**. Modello mentale: un apprendista che
osserva, propone, esegue con permesso e diventa maestro operativo. Direzione di
prodotto: avvicinarsi a **Manus** per le PMI (deliverable reali), restando
**local-first** e **capable-first** ma funzionante anche su modelli **locali/deboli**.

## I capisaldi (vincolanti) → [CAPISALDI.md](CAPISALDI.md)

1. Memoria = differenziatore e **layer condiviso** (tutto vi passa, mai store paralleli).
2. Orchestrazione = proprietà dell'**harness**, gira sul tier locale; il motore è il prodotto.
3. Local-first + privacy-by-design.
4. Ciclo di vita dei **deliverable** ≠ chat; artefatti = entità di memoria.
5. Un solo motore / grafo / store: convergere, non duplicare.
6. Stato e control-flow di **codice**; il modello riempie slot vincolati (3 invarianti del piano).
7. Niente keyword/regex; verità verificabile.
8. La memoria cattura il **PERCHÉ** e i **loop aperti**, e collega TUTTO nel grafo (verificabile via eval).

## Mappa della documentazione (una fonte per ogni cosa)

| Domanda | Dove |
|---|---|
| **Principi** (cosa non si viola) | [CAPISALDI.md](CAPISALDI.md) |
| **Scelte precise** (perché abbiamo deciso X) | [decisions/](decisions/) — ADR 0001-0016 (immutabili) |
| **Com'è fatto** (architettura + diagrammi) | [architecture/](architecture/) — overview + memory + agent-loop + plugins + system-map |
| **Dove siamo / cosa manca** (backlog corrente) | [plans/2026-06-22-…](plans/2026-06-22-batch-1042-artifacts-memory.md) |
| **La memoria** (visione + struttura) | [memory-vision.md](memory-vision.md) · [memory-architecture.md](memory-architecture.md) |
| **Prodotto / distribuzione / self-host** | [PRODUCT_LOOP.md](PRODUCT_LOOP.md) · [distribution.md](distribution.md) · [self-host.md](self-host.md) · [release-macos.md](release-macos.md) |
| **Storico** (changelog, vecchi piani, snapshot) | [archive/](archive/) — non più "corrente", solo memoria storica |

## Stato esecuzione — "SEI QUI" (aggiornato 2026-06-22, anti-compattazione)

> Se il contesto si è compattato: rileggi QUESTO blocco + il
> [backlog](plans/2026-06-22-batch-1042-artifacts-memory.md) (gli stati ☐/✅ = i loop
> aperti) e sei di nuovo sul filo. Stesso principio della memoria di Homun (caposaldo #8).

- **Pubblicato:** **v0.1.1043** = memoria coerente (WS5.7: estrattore cattura i *finding*
  inclusi i **negativi** + `open_loop` completi) + **WS5.4a** (open_loop nel briefing
  always-on: `gather_open_loops` + sezione "OPEN LOOPS" in cima a `format_memory_block`).
  *(v1042 aveva WS3 + WS8.1 eval + WS5.2 embed-everything + WS5.3 open_loop.)*
- **DA VERIFICARE IN-APP (gate, modifiche memoria CORE):** re-test Rossi su 1043 →
  (1) chat B deve ricordare anche **"nessun file ancora"** (WS5.7); (2) una chat **NUOVA**
  deve mostrare i loop aperti **senza** nominare il topic (WS5.4a). L'eval headless non
  copre recall/briefing.
- **In locale, 4 commit → v1044 (verde RICONFERMATO, no trailer):** 3 slice WS1-F2 motore
  piano (✅ slice 1 `merge_plan` per `id`, fallback titolo · ✅ slice 1b prompt eco `id` ·
  ✅ slice 2 **`step_advance(id,status)`**: progresso per id **senza re-inviare il piano**,
  weak-model-proof, riusa merge+F2-verify) **+ 1 commit doc**. Delta vs v1043 = **solo Rust**
  (`desktop-gateway/src/main.rs`); test piano **8/8 verdi** (incl. le 3 invarianti del #6 +
  verify-gate F2). Chiude alla radice il gonfiore del piano.
- **DECISO (2026-06-22): opzione (1) — build+run v1044 in-app.** Non per preferenza ma per
  *gate*: 2 modifiche-cuore non verificate impilate (memoria 1043 + motore-piano) → (2)/(3)
  ne impilerebbero una **terza**. Run: `cd apps/desktop && npm run electron:dev` — electron
  fa `cargo run -p local-first-desktop-gateway` **da HEAD = v1044** (nessun bump/tag: il
  tag *è* il publish, solo su comando). Un solo run copre memoria 1043 **e** piano.
- **GATE in-app — RISULTATO (2026-06-22, modello `kimi-k2.6:cloud`):**
  · ✅ **Memoria 1043 VERIFICATA → chiusa**: chat B ha ricordato *"il file del preventivo
  non è stato ancora trovato"* (WS5.7, finding **negativo**); una chat **NUOVA** ha mostrato
  **2** loop aperti (preventivo Rossi + bug gateway browser-headless) **senza** nominare il
  topic (WS5.4a). · ❌ **`demo-piano` fermo a 2/5** (cartella + `note.md`) sia su
  `kimi-k2.6:cloud` sia su **gemma** — causa CORRETTA sotto (NON "piano non creato": è
  approval-resume).
- **ROOT CAUSE — CORRETTA (la "plan-trigger" di prima era SBAGLIATA):** `demo-piano` non si
  ferma per "piano non creato". Si ferma perché la **prima scrittura**
  (`mcp__filesystem__create` ∈ `composio_writes`) attiva una **card di conferma**
  (`‹‹MCP_CONFIRM››`, :13340-13367) + instradamento **Telegram** (`deliver_remote_approval`) +
  `pending_confirm=true` → il turno **muore a :13518**. Dopo l'**approvazione**,
  `execute_pending_approval` (:21029) esegue **la sola azione** e la card diventa "✓ MCP tool
  executed" (riscrittura post-approvazione `rewrite_mcp_confirm_to_done` :22315) → **nessuna
  continuazione**. `‹‹PLAN››=0` è una *conseguenza* (il turno muore prima di pianificare), non
  la causa. **È l'APPROVAL-RESUME gap (WS6 6.1b), previsto dall'utente.** *(Mio errore: dedotto
  "no approval" dalla tabella `task_approvals` — meccanismo task-runtime — ma il confirm MCP
  in-chat usa `create_pending_approval`, mappa in-memory SENZA thread, che lì non scrive. Il
  thread B ha lo stesso "✓ MCP tool executed" → stesso path.)*
- **slice 2.5 (commit `4706d7a`) — RICLASSIFICATA, NON è questo il fix:** guard simmetrico @
  :13534 (`else if plan.is_empty() && turn_used_tools && task_appears_incomplete(...)` → nudge
  a creare il piano). Corretta + **unit-verde 8/8**, la **TENGO**, ma copre un caso *diverso e
  più stretto*: stop multi-step **senza** confirm-gate (tool usati, niente piano). **NON**
  risolve `demo-piano` (`pending_confirm` rompe a :13518, *prima* del suo guard) → **in-app NON
  verificata**, non ha passato il gate. ⚠️ Side-note UI: turni cloud etichettati "Local model".
- **WS6 6.1b (APPROVAL-RESUME) — cut #2 persist+publish (commit `6b0b9c7`), GATE IN-APP PENDENTE:** dopo
  un'azione confirm-gated approvata, rientrare nel loop del thread via **`run_agent_turn(state,
  thread_id, prompt, policy)`** (:17078, già usato da :16528 canale e :19360 autorun). Due rami:
  (a) **in-app** `mcp_execute` (:22259) ha già `thread_id`+`message_id` → `spawn(run_agent_turn)`
  dopo exec; (b) **Telegram** → aggiungere `thread_id` a `PendingApproval` (:21063) propagato da
  `create_pending_approval` (:21078) ← `deliver_remote_approval` (:21082) ← :13362, poi
  `run_agent_turn`. Frizione "approva ogni scrittura" già coperta da **Policy B `allow_server`**
  (:22273). Blocca **ogni** deliverable che scrive file → **priorità su slice 3 / WS2**.
  **IMPLEMENTATO:** `thread_id` in `PendingApproval` + helper `resume_thread_after_approval` →
  `run_agent_turn(...,"full")`; agganciato a `mcp_execute` (in-app) e `execute_pending_approval`
  (Telegram). **Gate:** riavviare `electron:dev` (codice nuovo), gemma, cancellare `~/demo-piano`,
  prompt demo-piano, **approvare la 1ª scrittura** (con "always allow this server" per non
  confermare ogni step) → il task deve **continuare** fino a **5/5**.
  **cut #1 GATE FALLITO (2026-06-22):** `run_agent_turn` drena lo stream e il resume **scartava**
  il risultato → niente in chat ("approva su Telegram ma non cambia nulla"). **cut #2 FATTO
  (commit `6b0b9c7`):** il resume ora **persiste** il risultato (`append_assistant_message`) +
  **pubblica `thread.updated`** (pattern del canale inbound :16544) → la chat si aggiorna via
  **refresh**, per approvazioni **sia in-app sia Telegram** (server-side, no frontend). Catena
  multi-scrittura: la continuazione si ferma alla 2ª confirm → la card è nel testo persistito →
  riappare in-app + nuovo msg Telegram → approvi → riprende, un'approvazione per volta.
  *(Limite noto: refresh, non token-live; nessun indicatore "sta lavorando" durante il turno.)*
  **Blocco Telegram diagnosticato (2026-06-22):** il bridge attivo era un processo orfano della
  build installata (19 giugno), rimasto in ascolto su `:18767` durante il run dev. Inviava le
  card ma conservava un `TG_GATEWAY_TOKEN` diverso da quello del gateway locale corrente. Prova
  read-only: `GET /api/channels/telegram/status` col token del bridge → **401**; col token del
  gateway corrente → **200**. Il bridge ignora la risposta della POST callback, quindi il tap
  sembra non fare nulla. Da fare prima del gate Telegram: lifecycle/handshake che riagganci o
  rimpiazzi un sidecar orfano senza riusare credenziali stale, più diagnostica redatta dello
  status callback. Il resume 6.1b non è ancora falsificato da Telegram.
  **Lifecycle Telegram IMPLEMENTATO e verificato tecnicamente (2026-06-22):** bridge con target
  callback mutabile + `POST /configure-gateway` autenticato loopback (commit `1ab8a53`);
  gateway rebind→fallback legacy dopo il bind HTTP (commit `793ca9c`) + wait limitato per il
  proprio child in avvio (commit `417ee95`). Test: bridge **6/6**; gateway **151 passati, 1
  ignorato**; entrambi i binari buildano. Runtime in Electron: bridge installato stale sostituito,
  riavvio successivo logga `reconfigured existing sidecar`, e `POST .../telegram/connect` ritorna
  `{"ok":true,"reconfigured":true}`. **GATE funzionale 6.1b PASSATO (2026-06-22, Gemma +
  Telegram):** dopo aver fornito `~/demo-piano` come path base, il thread ha emesso la confirm MCP
  per `note.md`, poi una seconda per `riepilogo.md`, e ha infine persistito il messaggio “Il task è
  completo”. Prove dirette: esistono `~/demo-piano/note.md` e `~/demo-piano/riepilogo.md`; nel
  thread `thread_1782134906_1782134906142839000` `chat_messages` registra i marker di confirm e
  l’esito finale. **6.1b chiusa. Prossima decisione, non ancora presa:** WS6.1c (feedback/UX
  Telegram: stato in esecuzione + esito callback) oppure **Path B** (scritture routine nel
  workspace senza confirm, gate solo per azioni sensibili/esterne).
- **Path B DECISO e in corso (2026-06-22):** Filesystem MCP è una capacità globale collegata una
  sola volta; il progetto della chat fornisce automaticamente la root ad ogni
  chiamata. Implementati manifest/jail/authority in-root e la direttiva runtime
  che espone la root assoluta al modello (mai chiedere una cartella o un reconnect
  per una chat già in progetto). **Gate runtime Electron PASSATO su
  `kimi-k2.6:cloud`:** nel thread
  `thread_1782138001_1782138001354628000` del progetto `test-homun`,
  `mcp__filesystem__create` ha creato
  `/Users/fabio/Desktop/test-homun/path-b-gate/note.md` (`una`, `due`, `tre`)
  senza `MCP_CONFIRM`; file e `chat_messages` verificati. Gateway:
  **156 passati, 1 ignorato**. Correzione successiva: per un path fuori root la
  direttiva ora impone al modello di chiamare comunque il Filesystem MCP con il
  path assoluto e spiega che sarà il runtime a mostrare la card — non deve
  inventare indisponibilità del connettore né proporre il salvataggio nel
  progetto. Runtime Kimi: il thread
  `thread_1782139063_1782139063946466000` ha emesso la card per
  `/Users/fabio/Desktop/path-b-outside-gate-1782139063.md`; la successiva
  esecuzione auditata è avvenuta dopo un callback Telegram autorizzato
  (`mcp__filesystem__create`, 2026-06-22 16:38:34), non dal bypass in-root.
  **Non chiudere ancora Path B:** restano il re-test UI/Gemma in-root e la
  ripetizione manuale fuori-root, verificando che il file non compaia prima
  dell'approvazione.
- **Coda:** WS5.4b (`stato-lavori.md`) · WS5.4c (chiusura+dedup) · WS5.5 (provenienza) ·
  WS2 · WS1 3-6 · WS6/7/8/9. Ordine nel backlog.
- **Regole operative:** build LOCAL, verde a ogni passo, doc aggiornati nello stesso turno,
  **publish solo su comando utente**, **niente trailer Co-Authored-By** ([[homun-no-claude-coauthor]]).
- **Sfondo:** Motore cross-modello Fase 1 ✅ v1041 (deck verificato vero-locale, gemma4:latest).

## Diagrammi dettagliati (si aggiornano "man mano")

- [architecture/agent-loop.md](architecture/agent-loop.md) — il motore / agent loop (cross-modello).
- [architecture/memory.md](architecture/memory.md) — la memoria a 3 livelli (SQL + grafo + markdown).
- [architecture/plugins.md](architecture/plugins.md) — skill, capability e addon (ADR 0011).
- [architecture/overview.md](architecture/overview.md) — il quadro d'insieme (poster SVG su richiesta).
- [architecture/system-map.md](architecture/system-map.md) — mappa componenti.

## Disciplina di aggiornamento (come teniamo viva la doc)

1. **Una scelta nuova** → un **ADR** in `decisions/` (numerato, immutabile).
2. **Un cambio di stato/avanzamento** → aggiorna il **backlog** in `plans/`.
3. **Un cambio di funzionamento** → aggiorna il **diagramma** in `architecture/` + questo hub.
4. **Un principio nuovo** → `CAPISALDI.md`.
5. Lo **storico** non si cancella: va in `archive/`.

Regola d'oro: **se una modifica viola un caposaldo, si ridiscute, non si spedisce.**
