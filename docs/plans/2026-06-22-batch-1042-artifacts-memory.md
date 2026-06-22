# Backlog completo Homun — tutto ciò che resta da fare

Data: 2026-06-22. Quadro UNICO di tutto l'arretrato. Decisione architetturale di
fondo: [ADR 0016](../decisions/0016-harness-owned-task-engine-cross-model.md).

> Regola di rilascio: il batch 1042 si costruisce **in locale** (build verde a ogni
> passo) e si **pubblica solo su comando dell'utente**.

Legenda: ✅ fatto · 🟡 in corso · ☐ da fare.

---

## WS1 — Motore & GESTIONE DEL PIANO (ADR 0016)

Il cuore: rendere l'orchestrazione una proprietà dell'**harness**, robusta anche su
modelli deboli/locali. Invarianti: monotonìa, limitatezza, identità non inferita.

- ✅ **Fase 1** — enforcement output (floor) + `make_deck` (un-call, max scaffolding).
  Pubblicato **v1041**, deck verificato su `gemma4:latest` locale.
- 🟡 **Fase 2 — GESTIONE PIANO (il pezzo grosso).** Obiettivo: piano runtime-owned a
  **`step_id` stabili** (l'`ExecutionPlan` del crate `orchestrator` ce l'ha già).
  - ✅ **Slice 1 (fatto)**: `merge_plan` ora abbina **per `id`** quando il modello lo
    rimanda (lo schema `update_plan` ha il campo `id`; il marker ‹‹PLAN›› lo mostra),
    fallback al titolo → riduce il gonfiore da titoli parafrasati, retro-compatibile,
    sicuro sui modelli deboli. Test `merge_plan_matches_by_id_despite_rephrased_title`.
  - ✅ **Slice 2 (fatto)**: tool **`step_advance(id, status)`** — riporta il progresso su
    UN solo step per id, **senza re-inviare il piano** (weak-model-proof: niente da
    parafrasare, niente gonfiore). Riusa lo stesso percorso merge+F2-verify di
    `update_plan` (zero duplicazione); `merge_plan` ora aggiorna anche per **id solo** (no
    titolo). Tool registrato + guida nel prompt + test. `update_plan` resta per creare/rivedere.
  - ⚠️ **Trovato in-app (2026-06-22, `kimi-k2.6:cloud`)**: per un task multi-step *generico*
    (≠ `make_deck`) l'harness **non crea il piano** (‹‹PLAN››=0 nel chat store) **né guida
    il loop a termine** (demo-piano fermo a 2/5). Le slice 1/2 sono corrette ma **non
    raggiunte** — stanno a valle di un piano che non nasce. **Prima di slice 3** serve il
    pezzo a monte: **trigger-piano + continuazione-loop a completamento** (vedi "Floor
    ovunque" sotto, caposaldo #2). **Slice 3 (DAG) deprioritizzata.**
  - ☐ **Slice 2.5 (NUOVO, priorità)**: l'harness garantisce un piano per i task multi-step e
    tiene il loop avanzando via `step_advance` fino a `done`/blocco (no ritorno all'utente
    dopo la 1ª tool-call). Verifica: demo-piano → **5/5** su **gemma**. Passo 0 = leggere il
    loop agente (terminazione turno + offerta `update_plan`) per fissare la causa.
  - ☐ **Slice 3**: convergere sull'`ExecutionPlan` del crate `orchestrator` (DAG
    `depends_on`, `plan_propose`) e ritirare il `Vec<Value>` canonico.
- ☐ **Floor ovunque** — constrained decoding su **tutte** le emissioni di
  orchestrazione (tool call del loop principale, piano, verifica), locale+cloud. Oggi
  è imposto solo sul contenuto di `make_deck`; il planner OpenAI-compat declassa ancora.
- ☐ **Fase 3** — skill **dichiarative** + workflow runner (un solo grafo; `make_deck`
  è l'embrione di `create-presentations` come workflow).
- ☐ **Fase 4** — router workflow|agent + **scaffolding adattivo** (pavimento + manopole
  per tier; tier via seed registry + probe al primo uso + stretta a runtime sui
  fallimenti) + repair limitato.
- ☐ **Fase 5** — convergenza con `OrchestratorBrain` (completa [ADR 0008](../decisions/0008-orchestrator-brain-single-planner.md)).
- ☐ **Fase 6** — memoria nel loop **per-step** sull'unico `MemoryFacade` (sub-agent inclusi).
- ☐ **Sub-agent** — sub-agent a contesto isolato come tipo di nodo del grafo, recall/
  write-back attraverso il motore di memoria condiviso.

## WS2 — Artefatti & Memoria (sequenza obbligata)

Gli artefatti sono i **deliverable** (valore del prodotto); ciclo di vita ≠ chat;
tutto passa dal motore di memoria.

- ☐ **3.1 — chiudere il BUCO (prerequisito):** artefatti come **entità di memoria**
  (`title/type/project/path/thread/created_at` + embedding) via il `MemoryFacade`
  condiviso → recall del deliverable ("rifammi il deck del consiglio"). *Oggi gli
  artefatti sono solo su filesystem; la memoria è memory-safe ma non li conosce.*
- ☐ **3.2 — schermata Artefatti centralizzata** (Settings): selettore progetto
  (workspace) + filtri (progetto/tipo/orfani) + multi-selezione + **Esporta ZIP**
  (cross-OS, salva in cartella) + **Elimina**. Dati: `artifacts_usage` arricchito con
  titolo/progetto/flag orfano.
- ☐ **3.3 — lifecycle + cancellazione con memoria:** `delete_chat_thread` **non**
  cancella più gli artefatti (oggi sì, `main.rs:1526`) → preserva + `meta.json`
  (titolo/progetto/data); la cancellazione dalla schermata elimina **file + entità di
  memoria** (possibile solo dopo 3.1).

## WS3 — Batch 1042 (in locale, da pubblicare su comando)

- ✅ Deck nella **lingua della richiesta** (no default inglese).
- ✅ Badge **💻 locale / ☁️ cloud** nel picker (composer + ruoli Settings).
- ✅ Gestione file **per-file** nel pannello esistente (interim, solo filesystem; da
  rivedere dopo WS2/3.1).
- ✅ **#3 — memoria "appiccicosa"** (propone sempre 3 slide): risolto a livello **skill**
  (chiama `make_deck` SUBITO col numero richiesto, non proporre/chiedere) — scelto NON
  cancellare la memoria utente (sarebbe band-aid sui dati). Opzione (a) scartata.
- ✅ **Strip `<tool_call>` trapelato** come testo in chat (`RichMessage.tsx`
  `LEAKED_TOOLCALL_RE`), come già per le immagini rotte.

> **WS3 chiuso** — pronto a pubblicare la **v0.1.1042** su comando.

## WS5 — Completare la MEMORIA (cervello che sa il perché e sopravvive)

Visione & ragionamento: [memory-vision.md](../memory-vision.md). Baseline reale
(2026-06-22): grafo 49k entità/236k relazioni ma **solo codice**; **391** embedding;
**9** pagine wiki markdown → la macchina c'è ma è **sbilanciata/dormiente** sui pezzi
che fanno "ricordare il perché e sopravvivere". Caposaldo #8.

- ☐ **5.1 Estendere il grafo** da solo-codice a **decisioni / artefatti / step di piano
  / esiti** + **archi causali** (`rationale_for`, `produced`, `derived_from`,
  `supersedes`, `blocks`).
- ✅ **5.2 Embeddare tutto** — `spawn_embedding_catchup` allo startup vettorizza ogni
  memoria mancante su **tutti** gli scope, loop fino a esaurimento (off critical path).
  Risolve il gap 391/555 (l'auto-consolidamento che faceva il backfill era OFF di
  default; il backfill altrove era cappato a 4-12).
- 🟡 **5.3 Loop aperti** — tipo `open_loop` di prima classe: meccanismo validato in-app
  (cattura + recall cross-chat su gemma4:latest, v1042). Resta: **chiusura automatica** +
  **iniezione nelle chat nuove** (WS5.4) + **dedup** (erano 2 quasi-duplicati).
- ✅ **5.7 Completezza & coerenza della cattura** *(gap trovato nel test Rossi, 2026-06-22;
  prompt estrattore sistemato — **VERIFICATO in-app 2026-06-22**: chat B ha ricordato il
  finding negativo "il file del preventivo non è stato ancora trovato")*:
  l'estrattore scarta i **finding** ("do NOT extract … what the assistant said") → la
  memoria salva il piano ma NON lo **stato reale** (es. "nessun file ancora / X non
  trovato"), e una chat nuova ricostruisce un quadro "troppo pulito", **incoerente** con
  la chat originale. Fix: catturare i **finding salienti, inclusi i negativi**, e rendere
  gli `open_loop` **più ricchi** (cosa esiste / cosa NON esiste / cosa blocca) — senza
  però immortalare gli errori di processo del modello. Verificabile via eval (un check di
  coerenza A→B).
- 🟡 **5.4 Open loops nelle chat nuove**:
  - ✅ **5.4a briefing always-on** — `gather_open_loops` + sezione "OPEN LOOPS" in cima a
    `format_memory_block` (priorità di budget): una chat nuova li riceve **senza** nominare
    il topic (chiude il gap del test Rossi-B). Build+test verdi. **VERIFICATO in-app
    2026-06-22**: chat nuova ha mostrato **2** loop (preventivo Rossi + bug gateway browser).
  - ☐ **5.4b** proiezione markdown `stato-lavori.md` (faccia leggibile/editabile, bidirezionale).
  - ☐ **5.4c** **chiusura automatica** dell'open_loop a lavoro fatto + **dedup** (erano 2).
- ☐ **5.5 Catena di provenienza** decisione → artefatto → codice → esito (unisce
  WS2-3.1 artefatti→memoria + WS1-F6 piano→memoria + codice già nel grafo).
- ☐ **5.6 Eval memoria** (guardrail): chat nuova → *"a che punto è il workflow e perché
  make_deck?"* / *"quali artefatti per il progetto X e da quale decisione?"* → deve
  rispondere. Anti-regressione, come l'eval del deck.

> Nota: WS2-3.1 (artefatti→memoria) e WS1-F6 (piano→memoria) **alimentano** WS5 — sono
> i nodi che rendono la memoria il cervello connesso. Stesso north-star.

## WS6 — Proattività & esecuzione durevole

North-star: "osserva, propone, esegue task lunghi che **sopravvivono**". Il crate
`task-runtime` ha già `ResourceGovernor`, lease/heartbeat, scheduler, checkpoint,
recovery, `ApprovalGate`, `RetryController` — ma (gap audit nell'SVG) **non tutto è
cablato** nel flusso agente. ADR 0015.

- ☐ **6.1 Cablare la durabilità**: task agente lunghi nella coda con
  checkpoint/heartbeat/recovery → sopravvivono a chiusura app/crash (lega ADR 0016 F4
  background+resume).
- ☐ **6.2 Resource Governor** attivo sui task (limiti, backpressure).
- ☐ **6.3 Scheduler / ricorrenza** + **proactive review** (l'assistente propone schede
  in autonomia governata) verificati end-to-end.
- ☐ **6.4** Le azioni proattive scrivono in memoria (loop aperti / decisioni) — lega WS5.

## WS7 — Ecosistema deliverable (Manus)

Solo il **deck** è affidabile cross-modello (`make_deck`). Le altre skill esistono
(`create-documents`, `research-report`, `meeting-notes`) ma con la fragilità appena
risolta per il deck. ADR 0011 (addon + contratto personalizzazione).

- ☐ **7.1** Portare documenti/ricerca/meeting al livello del deck: **workflow
  dichiarativi** (`make_*`) guidati dal runtime, contenuto schema-enforced.
- ☐ **7.2** Contratto di personalizzazione addon (zona bloccata + overlay-dato),
  3 origini (installati/scritti/generati).
- ☐ **7.3** Deliverable come **entità di memoria** + provenienza (lega WS2/WS5).

## WS8 — Eval suite cross-modello (guardrail)

Il caposaldo #2 ("funziona sul tier locale") oggi è verificato solo sul deck
(`scripts/eval_deck_content.py`). Serve un **guardrail trasversale**.

- 🟡 **8.1** Suite di eval sui **flussi chiave** sul **modello locale di base**.
  *Seed fatto:* `scripts/eval_suite.py` (deck · piano · decisione-con-perché —
  structured-output a livello modello). Da estendere: flussi via gateway (tool-call
  emission, render end-to-end) + documento/ricerca quando esistono (WS7).
- ☐ **8.2** Eval memoria (= WS5.6): chat nuova → "stato + perché" → deve rispondere.
- ☐ **8.3** Gate pre-release: nessuna pubblicazione se la suite non è verde sul tier base.

## WS9 — Distribuzione plugin & marketplace

Da "app con plugin" a **piattaforma**: i plugin/addon (WS7) devono avere ciclo di vita
proprio — versioning, canali, scaricabili dal **sito Homun**, auto-aggiornabili, alcuni
**a pagamento**. ADR 0011 (addon) + nuovo ADR dedicato (distribuzione & licensing).
*"Predisporre la struttura ora, monetizzare dopo."*

- ☐ **9.1 Manifest plugin**: `semver` + `channel` (stable/beta) + `min_homun_version`
  (compat) + `entitlement` (free/paid) + firma + capability dichiarate (contratto ADR 0011).
- ☐ **9.2 Registry/catalogo sul sito Homun**: indice JSON + pacchetti **firmati** (modello
  come l'auto-update dell'app: feed separato per i plugin).
- ☐ **9.3 Plugin manager in-app**: installa da registry · beta opt-in per-plugin ·
  controllo aggiornamenti + **auto-update** (confronto versioni).
- ☐ **9.4 Sicurezza**: firma **Ed25519** verificata all'install/update; `stable`=firmato,
  `beta`=opt-in; esecuzione contenuta (ADR 0009) + `skill_security` scan.
- ☐ **9.5 Licensing/paid (predisporre ora)**: campo `entitlement` nel manifest + **token
  di licenza firmato** verificabile **offline** + ri-check periodico. Il paywall vero
  (account + pagamenti, es. Stripe) è fase successiva e **lega cloud/always-on**.
- ☐ **9.6 ADR** "distribuzione & licensing plugin" (formalizza il contratto).

> Dipendenze: 9.1-9.4 sono local-first-compatibili e fattibili da subito; 9.5 (paid) ha
> bisogno di **account + backend pagamenti** → arriva con cloud/always-on. WS9 poggia su
> WS7 (i plugin) e sul contratto addon ADR 0011.

## WS4 — Qualità, affidabilità, UX

- ☐ **UI perf su chat pesanti** — il renderer arrivava al **99% CPU** (immagini grandi
  + log lunghi + piano gonfio): memoizzare i render pesanti + rallentare i polling
  quando idle. (Il gonfiore-piano lo chiude WS1-Fase 2; questa è la parte UI.)
- ☐ **Seeder skill fragile** — una skill modificata a mano (hash desync) non viene più
  auto-aggiornata (ha tenuto `create-presentations` vecchia su disco fino al fix manuale)
  → irrobustire.
- ☐ **Immagini deck con testo storpiato** ("no text" ignorato) — limite del modello
  immagine; mitigare prompt o accettare.
- ☐ **Ruolo immagine opzionale** — hint UI quando vuoto (deck senza immagini).
- ☐ **Lentezza locale** — un 31B locale ~55s/chiamata; suggerire in UI un modello
  locale più piccolo (7-12B) per reattività, restando vero-locale.

---

## Ordine d'esecuzione proposto

1. **Chiudere WS3 (batch 1042)** — decidere #3 (+ eventuale strip `<tool_call>`) →
   **pubblicare su comando**.
2. **WS8.1 seed** — avviare la suite di eval (anche solo deck + memoria) come guardrail,
   così ogni passo successivo è verificabile sul tier locale.
3. **WS5 — fondamenta memoria** (il cervello, prerequisito trasversale; include 3.1
   artefatti→memoria = 5.5, e prepara piano→memoria).
4. **WS2-3.2 / 3.3** — schermata artefatti + lifecycle + delete-con-memoria.
5. **WS1-Fase 2** — gestione piano (`ExecutionPlan`+`step_id`); il piano scrive in memoria.
6. **WS1-Fase 3** — skill dichiarative + workflow runner → abilita WS7.
7. **WS7** — ecosistema deliverable (`make_*` per documenti/ricerca/meeting).
8. **WS6** — proattività & esecuzione durevole (poggia sul piano).
9. **WS1-Fasi 4→6** — router+scaffolding adattivo, Brain (ADR 0008), memoria per-step + sub-agent.
10. **WS4 + WS8 completo** — perf/affidabilità/UX a regime; eval come gate di release.

> Note: la **memoria (WS5)** è il filo trasversale (artefatti→memoria e piano→memoria la
> alimentano). La **gestione piano (WS1-Fase 2)** è il refactor più profondo: dopo i quick
> win e le fondamenta memoria, prima delle Fasi 3-6 che ci si appoggiano. **Cloud /
> always-on** (canali 24/7, proattività continua, self-hostable — `self-host.md`) resta
> direzione **futura**, non in questo ciclo. **Sub-agent** maturano dentro WS1-F6.
