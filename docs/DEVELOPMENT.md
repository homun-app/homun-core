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

### Cruscotto operativo attuale

- **Linea attiva:** WS6.2 Resource Governor — slice 1 completata localmente:
  reidratazione dei task `WaitingResource` quando la capacità torna disponibile.
  Prossimo slice: rendere più visibili limiti/uso/backpressure nella superficie
  task o stress-gate in-app con più worker.
- **Fatto e verificato localmente:** root automatica del progetto, bypass conferma
  solo per scritture Filesystem MCP dentro root; outside-root resta confirm-gated;
  routing Auto thread-aware + fallback orchestratore su `400` con tool; approval
  remota persistita in `remote_approvals`, legata a `approval_id` +
  `source_message_id`, notificata solo dopo card salvata, claim una-sola-volta
  `pending→executing`; in-app supersede il codice remoto; Composio verifica la
  card sorgente prima di eseguire/allow. Dopo il retry Telegram è stato aggiunto
  anche il prompt di resume vincolato a richiesta originale + args approvati
  (`approval_resume_prompt`) per evitare contaminazione da vecchi loop. Verifiche:
  `cargo test -p local-first-desktop-gateway` = **160 passati, 1 ignorato**; `npm run build`
  desktop = verde; `cargo build -p local-first-desktop-gateway` = verde;
  `git diff --check` = pulito.
- **Gate appena verificato:** fuori-root con approval in-app + binding remoto
  superseduto. Prompt:
  `Usa il tool MCP filesystem per creare /Users/fabio/Desktop/path-b-approval-bound.md con una riga: test.`
  Prove: file creato con contenuto `test`; thread
  `thread_1782142399_1782142399448892000`; `chat_messages` mostra user prompt →
  `✓ MCP tool executed: mcp__filesystem__create` → finale corretto sul file
  esatto; nessuna occorrenza di `path-b-gate/note.md` nel thread; riga
  `remote_approvals` `approval_b7a4a02ae4944ead862ecb9ef8af02c4` legata a
  `source_message_id=browser_assistant_1782142417646` e stato `superseded`
  (coerente con approvazione in-app che invalida il codice remoto).
- **Retry Telegram #1 (fallito solo nel resume, 2026-06-22):** prompt
  `.../path-b-telegram-bound.md` + approvazione Telegram ha creato correttamente
  `/Users/fabio/Desktop/path-b-telegram-bound.md` con `telegram-test`;
  `remote_approvals` ha `status='executed'`,
  `source_message_id=browser_assistant_1782142921059`, args corretti e thread
  `thread_1782142906_1782142906959786000`. Però il resume model-driven ha
  risposto col vecchio `path-b-gate/note.md` (`una/due/tre`). Causa: il prompt
  di `resume_thread_after_approval` era ancora generico e non includeva richiesta
  utente originale + args approvati, quindi il modello poteva pescare memoria o
  loop vecchi.
- **Fix locale dopo il retry:** `resume_thread_after_approval` ora costruisce un
  prompt con `ORIGINAL USER REQUEST`, `APPROVED ARGUMENTS JSON`, risultato e
  guardrail espliciti: continuare solo la richiesta originale, non cambiare
  file/path/task/memoria/open-loop; se l'azione approvata soddisfa la richiesta,
  chiudere con messaggio conciso sul path esatto. Test dedicato:
  `approval_resume_prompt_anchors_to_source_request_and_approved_args`.
- **Gate Telegram #2 PASSATO (2026-06-22, dopo rebuild+riavvio da HEAD):**
  prompt `.../path-b-telegram-bound-2.md` + approvazione Telegram ha creato
  `/Users/fabio/Desktop/path-b-telegram-bound-2.md` con `telegram-test-2`.
  Prove: `remote_approvals` =
  `approval_bf564060200f430fa6dd653ec585aa79`, `status='executed'`,
  `source_message_id=browser_assistant_1782143967279`, args corretti; thread
  `thread_1782143941_1782143941578301000` mostra prompt → `✓ MCP tool executed`
  → finale “Percorso: `/Users/fabio/Desktop/path-b-telegram-bound-2.md` /
  Contenuto: `telegram-test-2` / Byte: 15”; zero occorrenze di
  `path-b-gate/note.md` nel thread. **Path B approval/provenienza chiusa.**
- **WS6.1c slice locale implementata (UX Telegram):** al tap/reply Telegram su
  un codice valido viene inviato subito un messaggio “Ricevuto… verifico/avvio”;
  nel thread app vengono persistiti status assistant “Approvazione Telegram
  ricevuta / eseguo …” e “Azione approvata da Telegram eseguita … riprendo il
  task” o “fallita …”, con target derivato dagli args (`path`/`to`) e
  `thread.updated`. **Bug trovato nel gate UX:** la card era persistita e la
  riga `remote_approvals` era corretta, ma `dispatched_at` restava `NULL`
  (`approval_fc2026c6804a45029123b354672cd130`, codice `FC2026`) quindi
  Telegram non riceveva nulla. Causa: errore di delivery del sidecar Telegram
  silenziato nel path `dispatch_remote_approval`. **Fix locale:** l'invio
  Telegram usa un retry con rebind automatico al token persistito sia per la
  notifica con bottoni sia per i messaggi di callback/progresso; se anche il
  retry fallisce, il thread riceve uno status `delivery_failed` con errore e
  fallback alla card in-app/reconnect, invece di lasciare l'utente al buio.
  Test dedicato: `telegram_approval_progress_messages_are_actionable`.
  Verifiche locali: gateway **161 passati, 1 ignorato**,
  `cargo build -p local-first-desktop-gateway` verde, `npm run build`
  desktop verde, `git diff --check` pulito.
- **Prossimo passo unico:** riavviare Electron da HEAD e fare un micro-gate
  Telegram con path nuovo verificando: ricezione notifica Telegram iniziale,
  messaggio Telegram immediato dopo tap/reply, due status nel thread, finale
  corretto del resume, `remote_approvals.dispatched_at IS NOT NULL` e
  `remote_approvals.status='executed'`. Non riusare `FC2026`: è la riga di
  prova creata prima del fix ed è rimasta pending/non inviata.
- **Gate fallito pre-riavvio (18:17):** nuovo tentativo
  `path-b-telegram-ux-2.md` ha creato `approval_e14399953a6c4dd6a5f9a7c7d1214114`
  / codice `E14399`, ma resta `pending` con `dispatched_at=NULL` e nel thread
  non compare nessuno status `delivery_failed`. Le preferenze sono corrette
  (`approval_channel=telegram`, target presente). Questo è incompatibile con
  il codice locale appena compilato, quindi prima ipotesi da falsificare:
  Electron/gateway attivo è un processo vecchio o non riavviato da HEAD. Prossima
  azione: hard-stop di Electron/gateway/sidecar Telegram, poi `npm run
  electron:dev` da `apps/desktop` e micro-gate con path ancora nuovo.
- **Gate WS6.1c PASSATO dopo riavvio (18:20):** nuovo tentativo su
  `/Users/fabio/Desktop/path-b-telegram-ux-2.md` ha creato
  `approval_1a16fb7978fe4a91b163560fafbecff0` / codice `1A16FB`,
  `status='executed'`, `dispatched_at=1782145205`,
  `resolved_at=1782145211`. Il thread
  `thread_1782145191_1782145191727307000` mostra card eseguita → status
  “Approvazione Telegram ricevuta / Eseguo …” → status “Azione approvata da
  Telegram eseguita … Riprendo il task…” → finale ancorato al path corretto
  con `ux-ok-2`, byte 8. Filesystem: file presente su Desktop. **WS6.1c chiusa.**
- **WS6.2a Resource Governor FATTO (2026-06-22):** root cause trovata nel
  cablaggio task: un task marcato `WaitingResource` non tornava più in `ready_tasks`
  quando la risorsa si liberava, perché lo scheduler seleziona solo
  `Queued|Pending`. Fix: `ResourceGovernor::requeue_waiting_if_available`
  riporta il task a `Queued` e pulisce `blocked_reason` se la capacità è di nuovo
  disponibile; il gateway esegue `requeue_waiting_resource_tasks` dopo recovery
  lease e prima di `ready_tasks`, così il task può ripartire nel tick successivo.
  Test red/green:
  `resource_governor_requeues_waiting_task_when_capacity_returns`; test gateway:
  `task_executor_requeues_waiting_resource_before_scheduling`. Verifiche locali:
  `cargo test -p local-first-task-runtime` verde; `cargo test -p
  local-first-desktop-gateway` = **162 passati, 1 ignorato**; `cargo build -p
  local-first-desktop-gateway` verde; `npm run build` desktop verde;
  `git diff --check` pulito.
- **Divieto operativo:** niente altri test di scrittura via endpoint HTTP grezzo;
  per questo gate usare solo UI/app o callback Telegram reale.

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
  **Diagnosi successiva, verificata end-to-end (2026-06-22):** la chat progetto
  in Auto risolveva il ruolo `coding` (`glm-5.2`), ma il composer mostrava
  erroneamente l'orchestratore (`kimi-k2.6:cloud`). GLM rifiuta il primo round
  con tool (`400/1210`); il loop poi sintetizzava senza tool, dando l'illusione
  di proseguire senza mai chiamare Filesystem MCP. Kimi esplicito ha invece
  eseguito `mcp__filesystem__view` nello stesso progetto. **Fix locale da
  verificare in Electron:** Auto ora mostra il modello risolto per il thread,
  gli array tool vuoti sono omessi dal payload, e un `400` su un round con tool
  ritenta una sola volta l'orchestratore configurato senza mostrare il falso
  errore. `run_agent_turn` usa inoltre lo stesso routing thread-aware. Test
  gateway **157 passati, 1 ignorato** + build desktop verde. **Prova runtime
  Electron (gateway da HEAD):** thread
  `thread_1782140733_1782140733708101000`, Auto=`glm-5.2`, attività fallback
  una volta, card per
  `/Users/fabio/Desktop/path-b-provider-fallback-1782140733.md`, file assente
  prima dell'approvazione. **GATE INVALIDATO (2026-06-22, non chiudere Path
  B):** quel probe HTTP ha inviato una vera approval Telegram, ma non ha
  persistito la richiesta/card nel thread. La successiva approvazione ha
  eseguito il file probe e chiamato `resume_thread_after_approval` sul thread
  quasi vuoto; il resume ha quindi recuperato il vecchio `path-b-gate/note.md`
  dal contesto/memoria e lo ha eseguito/riportato come se appartenesse al task
  nuovo. Prove: nel thread `thread_1782140733_1782140733708101000` la catena
  `browser_user` → `✓ MCP tool executed` → messaggio `msg_…` cita il vecchio
  note; `path-b-provider-fallback-1782140733.md` esiste. Nessuno stream è
  attivo al controllo, ma le approval pendenti erano solo in-memory e non
  ispezionabili/auditabili. **Fix locale implementato (2026-06-22):** le remote
  approval ora sono persistite in `remote_approvals` con `approval_id`, codice,
  tool/args, thread e stato; le card chat includono `approval_id`; Telegram/WA
  vengono inviati solo dopo `commit_prompt_result`/continuation/regenerate o
  `append_assistant_message` server-side, quando la card è già legata a
  `source_message_id`; `execute_pending_approval` rifiuta origini non
  persistite o marker non corrispondenti e claim-a una sola volta
  `pending→executing`; le approvazioni in-app supersedono il codice remoto.
  Anche `composio_execute` ora verifica la card sorgente prima di eseguire e di
  salvare "always allow". Test gateway **159 passati, 1 ignorato**. **Gate
  parziale:** in-app ha passato e ha superseduto il codice remoto; Telegram ha
  eseguito l'azione corretta (`status='executed'`, file
  `path-b-telegram-bound.md` creato) ma il resume ha contaminato la risposta con
  il vecchio `path-b-gate/note.md`. **Fix locale successivo:** resume prompt
  vincolato a richiesta originale + args approvati; test gateway ora **160
  passati, 1 ignorato**. **Gate finale PASSATO:** retry con
  `path-b-telegram-bound-2.md` ha prodotto `status='executed'`, file corretto,
  finale chat sul path approvato e zero `path-b-gate/note.md` nel thread.
  **Path B approval/provenienza chiusa**; non usare più endpoint grezzi per test
  di scrittura reali.
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
