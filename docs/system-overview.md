# Homun — System Overview (as-built)

> **Documento di presentazione, allineato 1:1 al codice.** Verificato vs codice il **2026-07-09**
> (branch `fix/workflow-route-plan-precedence`, HEAD dopo l'audit di riconciliazione). Ogni claim qui
> è stato provato con grep/read; dove qualcosa è dietro flag o ancora WIP, è **detto esplicitamente**.
> Niente claim aspirazionali. Per il "perché" delle scelte → `docs/decisions/` (ADR); per lo stato di
> lavoro vivo → `docs/STATO.md`; per l'inventario grezzo → `docs/audit/2026-07-09-system-state-ledger.md`.

---

## 1. Cos'è Homun

Homun è un **assistente/agente desktop local-first**: un workspace agentico dove la chat è il comando
naturale, ma lo stato del lavoro (piano, attività dei tool, artefatti, memoria) ha superfici proprie.
Il modello di prodotto è un **action engine**: obiettivo → piano (il piano è un *tool*, non un secondo
motore) → capability da un registro unico → esecuzione → evidenza → artefatto → ripresa/correzione.

Due cose lo distinguono:
1. **La memoria è il differenziatore** — un cervello ibrido sempre-attivo (lessicale + semantico + grafo)
   che sopravvive alle chat e sa il *perché*, non solo i fatti.
2. **L'orchestrazione è dell'harness, non del modello** — il motore deve funzionare **anche su modelli
   locali deboli** (Gemma/7B); niente stampella cloud obbligatoria. Il cloud è una scelta, mai un requisito.

Local-first e deny-by-default sono scelte deliberate: scope per progetto, privacy-domain, approval.

---

## 2. Il quadro d'insieme (chi fa cosa)

Un **gateway Rust orchestra tutto**; un'app **Electron + React** è la UI; **sidecar standalone**
gestiscono i lavori pesanti/isolati. Il gateway espone un'API HTTP/stream locale (dev: `127.0.0.1:18765`)
che la UI consuma.

```
┌───────────────────────────┐      HTTP/WebSocket        ┌────────────────────────────────┐
│  Electron + React (UI)     │ ◀────  127.0.0.1:18765 ──▶ │  Gateway Rust (desktop-gateway) │
│  apps/desktop/src          │                            │  il "postino" + l'orchestratore │
│  ChatView.tsx (~9.5k righe)│                            │  main.rs (~58.8k righe)         │
└───────────────────────────┘                            └───────────────┬────────────────┘
                                                                          │ chiama, con seam tipizzati
                              ┌───────────────────────────────────────────┼───────────────────────────┐
                              ▼                          ▼                 ▼                             ▼
                    ┌──────────────────┐   ┌──────────────────┐  ┌──────────────────┐        ┌──────────────────┐
                    │ crates/engine    │   │ crates/memory    │  │ altri crate       │        │ runtimes/ (sidecar)│
                    │ IL loop agentico │   │ IL layer memoria │  │ capabilities,     │        │ contained-computer│
                    │ run_turn (motore │   │ MemoryFacade     │  │ task-runtime,     │        │ browser-automation│
                    │ #1, ADR 0021)    │   │ (sqlite ibrido)  │  │ subagents, vault… │        │ channel-*, graphify│
                    └──────────────────┘   └──────────────────┘  └──────────────────┘        └──────────────────┘
```

**Crate Rust** (`crates/`): `desktop-gateway` (il gateway monolitico), `engine` (il loop canonico),
`memory` (il layer memoria), `orchestrator` (planner deliverable, dormiente-per-chat), `capabilities`,
`task-runtime`, `subagents`, `skill-runtime`/`process-skill`, `browser-automation`,
`local-computer-session`, `process-manager`, `inference`, `context-compression`, `secrets`, `vault`.

**Sidecar** (`runtimes/`): `contained-computer` (browser+shell in Docker via CDP/noVNC),
`browser-automation` (driver Playwright/CDP), `channel-telegram`, `channel-whatsapp`, `graphify`
(estrattore codice→grafo per la memoria), `mlx-gemma4`.

> ⚠️ **Debito noto, non nascosto:** `main.rs` (~58.8k righe) e `ChatView.tsx` (~9.5k) sono **sopra i
> limiti** di progetto (soft 1500 / hard 2500) e sono i target di split incrementale. Non è un rischio
> di correttezza; è debito di manutenibilità dichiarato.

---

## 3. Il motore canonico — un solo loop guardato

Il motore è **UN loop ReAct guardato** (motore #1, **ADR 0021**): percepisci → ragiona/pianifica → agisci
(tool al chokepoint unico) → osserva/verifica → itera o termina. Il piano è un *tool*, **non** un secondo
motore plan-execute.

- **Dove vive:** `crates/engine/src/agent_loop.rs`, funzione `run_turn`. È generico sui suoi collaboratori
  (i *seam*: model client, capability executor, browser executor, plan progress, ecc.) così il crate resta
  puro e testabile, disaccoppiato dal gateway.
- **Come lo chiama il gateway:** `run_agent_rounds` (in `main.rs`) è un **thin seam-builder** che costruisce
  gli adapter concreti e chiama `run_turn` **incondizionatamente**. Nessun flag, nessuna copia inline.
- **Convergenza (ADR 0024, completa):** il loop è stato **estratto** dal monolite; la copia inline e il flag
  transitorio `HOMUN_ENGINE_CRATE` sono **cancellati** ("un loop, nessun flag"). *(grep `HOMUN_ENGINE_CRATE`
  in codice vivo = 0.)*

**Garanzie del piano** (stato e control-flow sono di CODICE; il modello riempie slot vincolati):
monotonìa (un `done` verificato non si riapre), limitatezza (un avanzamento non gonfia il piano), identità
non inferita (l'id è del runtime). Verifica dei passi (F2) e auto-avanzamento su evidenza verificata sono
la **rete per i modelli deboli** (ADR 0016/0018): l'harness sa avanzare il piano anche se il modello locale
non chiama `step_advance`.

> **Nota SOTA onesta:** ADR 0021 ha **emendato** la tesi originale di ADR 0016/0019 sul *forzare* l'output
> JSON: la chat usa **native tool-calling** + parsing tollerante, non grammatica forzata (forzare JSON
> peggiora i modelli deboli). Il normalizzatore d'output (ADR 0019) vive puro in `crates/engine/model_normalize.rs`.

---

## 4. La memoria — il layer condiviso e il differenziatore

**Un solo store, un solo grafo** (`~/.homun/memory.sqlite`, crate `memory`, `MemoryFacade`). Ogni capacità
— chat, canali, automazioni, sub-agent, artefatti, piano — fa **recall + write-back attraverso l'unico
facade**; mai uno store parallelo (**Caposaldo #1**, verificato: nessuno store parallelo nel codice).

- **Recall ibrido** ogni turno: pass lessicale (FTS5/bm25) + pass semantico (embedding) fusi con **RRF**
  + boost importanza + recency; scoped al progetto attivo. Robusto **anche con embedding/modelli deboli**.
- **Briefing sempre-attivo:** identità + preferenze stabili + loop aperti raggiungono il modello ogni turno.
- **Grafo:** entità + relazioni (persone, progetti, simboli di codice via `graphify`, artefatti, step di
  piano, outcome) — conoscenza *interrogabile*, non testo piatto.
- **Autocorrezione:** `Candidate → Confirmed`, supersede/correzione, tombstones; consolidamento in background.
- **Governance:** scope per workspace + `privacy_domain`/`sensitivity` + `access_audit`.

**Stato as-built (onesto):** l'orchestrazione memoria (recall/learn/consolidate/embedding) è **estratta nel
crate** `memory` (ADR 0022) — file reali e non-triviali. Il tool **`recall_memory`** (recall on-demand) è
**live ed esposto al modello**. Due flag di migrazione restano **default-OFF** e sono WIP dichiarato:
`HOMUN_MEMORY_SERVICE` (service-object vs costruzione inline delle **stesse** fn del crate) e
`HOMUN_MEMORY_POOL` (pool WAL vs connessione singola). Con i flag OFF il comportamento è identico: entrambi
i path usano le fn del crate.

---

## 5. Le capability — un registro unico

**Caposaldo #7 (onorato):** l'attivazione delle capability parte da un **registro unico interrogabile**,
non da keyword sparse. Il routing primario è un **retrieval BM25 su un unico corpus** (workflow nativi
`make_*`, tool MCP, skills/addon, connector tools, strumenti atomici interni) — un solo ranker condiviso
(`crates/capabilities/src/search.rs`), lo stesso che usano sia il router del turno sia il planner. Il turno
carica nel toolset live solo il set minimo necessario.

Le euristiche keyword esistono solo come **prefilter/guardrail** (es. de-routing a favore del piano quando
il prompt è chiaramente plan/research; il classificatore atomico PDF), mai come verità primaria di routing.

---

## 6. Il browser — `browse(goal)` ricorsivo

**ADR 0025 (completo): un solo path browser, nessun flag.** Il manager (loop principale) espone **un unico
tool `browse(goal)`**. I 6 tool granulari (`browser_navigate`/`snapshot`/`act`/`tabs`/`screenshot`/`dialog`)
**non** sono visibili al manager: vivono **solo** dentro un sotto-turno isolato.

Quando il manager chiama `browse(goal)`, `GatewayBrowseExecutor` avvia un **`run_turn` ricorsivo** con un
toolset browser-only + il modello-browser, isolato da un **drain-sink**: snapshot/click/reasoning del
sotto-agente **non inquinano** il contesto del manager né lo stream utente. Torna solo un `BrowseResult`
compatto, che il manager verifica. Il vecchio **model-switch mid-turn** (scambiava tutto il turno al modello
debole) è stato **rimosso**: il manager resta sul suo modello per l'intero turno.

Sotto, il sidecar `runtimes/browser-automation` (Playwright/CDP) fa la navigazione reale; `contained-computer`
offre un browser+shell in container per i lavori isolati.

---

## 7. Sicurezza & esecuzione — sandbox + approval

**ADR 0023 (implementato, ATTIVO DI DEFAULT dal 2026-07-09).** L'esecuzione dei tool (shell/filesystem/
processi) passa da un modello *cooperativo* (il modello chiede) a uno **enforced** (il processo non può
uscire dal recinto), con una **policy di approvazione unica** al chokepoint.

- **Enforcement OS:** `sandbox-exec` + **Seatbelt** su macOS, `homun-linux-sandbox` + **Landlock** su Linux;
  policy *workspace-write* (scritture confinate a root progetto + cache tool; il resto read-only).
- **Default ON:** `tool_safety_enabled()` è ON salvo `HOMUN_TOOL_SAFETY=0` (escape-hatch **transitorio**,
  fail-secure: solo "0" disabilita) prima della rimozione del flag → enforcement incondizionato.

> ⚠️ **Onestà:** questo **cambia il comportamento di default** (l'exec dei tool è ora sandboxato). La suite
> di test è verde (nessun test non-`soffice` regredito), ma la **validazione LIVE in-app** è ancora dovuta
> prima di rimuovere del tutto il flag. Su Windows/altre piattaforme non c'è ancora fencing.

---

## 8. Trasporto & task — broker + WebSocket

Il **turn broker è l'unico path dei turni**, incondizionato: la UI accoda con POST `/api/chat/turns` e riceve
gli eventi live sul **WebSocket unificato `/api/ws`**; NDJSON resta solo come body di replay/resume
(`…/turns/{id}/stream`) specchiato su WS. Il vecchio path NDJSON-diretto e il flag `HOMUN_TURN_BROKER` sono
**rimossi** (grep = 0). Il task-runtime (`crates/task-runtime`) gestisce i job durevoli con heartbeat.

---

## 9. Deliverable — decks & documenti

I deliverable (presentazioni, documenti) condividono **un unico design system dichiarativo** (temi, layout,
componenti, template, QA). Il modello fa da *composer* (sceglie struttura/narrativa/blocchi dal registro);
un renderer deterministico materializza `.pptx`/`.docx`/`.pdf`/HTML; la QA verifica overflow/tabelle/immagini.
`make_deck`/`make_document` sono capability che usano questa grammatica comune, **non** sistemi separati.

Il **planner** di questi deliverable è `OrchestratorBrain::plan_only` (crate `orchestrator`) — vedi §11 per
il ruolo residuo del crate. I deliverable sono anche **entità di memoria** (recall dell'artefatto).

---

## 10. Cosa è VIVO oggi (tabella onesta)

| Sottosistema | Stato | Default |
|---|---|---|
| Loop agentico unico (`engine::run_turn`, ADR 0021/0024) | **vivo** | on, no flag |
| Browser `browse(goal)` ricorsivo (ADR 0025) | **vivo** | on, no flag |
| Turn broker + WebSocket unificato | **vivo** | on, no flag |
| Memoria: facade/ibrido/grafo/briefing + tool `recall_memory` | **vivo** | on |
| Registro capability unico + routing BM25 (Caposaldo #7) | **vivo** | on |
| Sandbox seatbelt/landlock + approval unica (ADR 0023) | **vivo** | **on** (`=0` per disattivare) — *validazione live dovuta* |
| Deliverable `make_deck`/`make_document` + `brain_materialize` | **vivo** | on |
| Normalizzatore output (ADR 0019, in `crates/engine`) | **vivo** | on |
| Vault (chiavi wrapped da syskey OS, PIN reveal-only) | **vivo** | on |
| Canali Telegram/WhatsApp, contained-computer, graphify | **vivo** (sidecar) | opt-in per config |
| Memoria service/pool (ADR 0022, estrazione crate) | **dietro-flag** | **off** — WIP dichiarato (`HOMUN_MEMORY_SERVICE`/`_POOL`) |
| Adaptive floor per-tier (ADR 0018) | **dietro-flag** | **off** — WIP dichiarato (`HOMUN_ADAPTIVE_FLOOR`) |
| `crates/orchestrator` come **motore di chat** | **ritirato** | — (drive-as-chat rimosso) |
| `crates/orchestrator` come **planner deliverable** | **vivo** | on (`plan_only`) |

---

## 11. Cosa è WIP / opt-in (onestà, non marketing)

- **Memoria fluida (ADR 0022):** il crate è reale e convergente, ma i due flag di migrazione restano
  **default-OFF**. Il tool di recall on-demand è live; la convergenza completa sul service + la pulizia di
  fn morte del gateway è il residuo (Tappa 3). *Nessuna regressione col flag off (stesso codice del crate).*
- **Adaptive floor (ADR 0018):** la macchina è cablata e testata (tier → profilo → due branch reali:
  relax del route + profondità di verifica), ma **default-OFF**: nel default il tier viene calcolato e non
  modula nulla. Due knob (`slot`/`format`) sono superficie senza consumatore. Land parziale + kill dei knob
  morti è una decisione aperta (fuori scope pre-presentazione).
- **`crates/orchestrator`:** il *secondo motore* (drive plan-execute come chat) è stato **rimosso** (ADR
  0020, superseded da 0021). Il crate **resta** solo per il **tipo `ExecutionPlan`** e il **planner
  deliverable** (`plan_only`, per `make_deck`/`make_document`) + `brain_materialize`. Non è un motore di chat.
- **C1/sandbox:** attivo di default ma **la validazione live in-app è dovuta** prima di togliere il flag.
- **File oltre-limite:** `main.rs`/`ChatView.tsx` da splittare (debito di manutenibilità).

---

## 12. I capisaldi e come il codice li rispetta

I 13 capisaldi (`docs/CAPISALDI.md`) sono il filtro di ogni modifica. Verifica as-built:

- **#1 memoria = layer condiviso, un solo facade** — ✅ rispettato (nessuno store parallelo).
- **#2 orchestrazione dell'harness, funziona su modelli deboli** — ✅ (verifica F2 + auto-advance sono la rete).
- **#5 un solo motore, converge non duplica** — ✅ dopo l'audit: il loop è solo `run_turn`; il secondo
  motore (drive-as-chat) è stato **rimosso** (era il debito residuo; ora chiuso).
- **#6 stato/control-flow di codice, il modello riempie slot** — ✅ per le invarianti del piano; **emendato**
  (ADR 0021) sul punto "output forzato": la chat usa native tool-calling, non grammatica imposta.
- **#7 attivazione da registro unico, non keyword** — ✅ (routing BM25 su corpus unico; keyword solo prefilter).
- **#3 local-first + privacy-by-design, #4 lifecycle deliverable ≠ chat, #8 design system unico, #9 workspace
  agentico, #12 memoria cattura il perché + loop aperti, #13 lingua UI ≠ lingua risposta** — coerenti col codice.

---

## 13. In una frase

Homun, oggi, è **un action engine local-first con un solo loop agentico guardato** (estratto in un crate
dedicato, senza flag), **una memoria ibrida come layer condiviso**, **un registro unico di capability**,
**un browser che gira come sotto-agente isolato**, e **un'esecuzione tool sandboxata di default** — con un
pugno di sottosistemi ancora dietro flag, dichiarati come tali. Niente doppi motori, niente flag-zombie:
ciò che è acceso è acceso, ciò che è WIP è detto.
