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
  - 🟡 **Slice 2.5 (commit `4706d7a`, unit-verde 8/8) — RICLASSIFICATA, NON è il fix di
    demo-piano**: guard simmetrico @ `main.rs:13534` (se il modello agisce ma stoppa **senza
    piano** né confirm-gate, giudice cheap `task_appears_incomplete` → nudge a creare il piano).
    **Caso più stretto:** il test `demo-piano` NON ci passa (la 1ª scrittura attiva
    `pending_confirm` che rompe a :13518, *prima* del guard di 2.5 a :13524) → vedi 6.1b.
    La tengo (corretta + low-risk), ma **in-app non verificata** (il suo caso non è stato
    esercitato). `turn_used_tools` la tiene fuori dalla chat pura; `make_deck` esente.
  - ✅ **Slice 2.6 (2026-06-23, locale/verde)**: il piano runtime-owned ora fa write-back
    nella memoria canonica. Ogni `update_plan` / `step_advance` crea o aggiorna **in-place**
    un solo `open_loop` `source="runtime_plan"` per thread, con `done_count`, `total_count`,
    `next_step` e snapshot steps nei metadata; quando il piano è completo il record viene
    marcato stale. `stato-lavori.md` resta una proiezione derivata rigenerata dal
    `MemoryFacade`, non uno store parallelo. Test:
    `cargo test -p local-first-desktop-gateway runtime_plan_memory -- --nocapture`.
  - ✅ **Slice 2.7 (2026-06-23, locale/verde)**: lo stesso write-back materializza
    anche il grafo canonico del piano: entity piano (`metadata.kind="runtime_plan"`),
    entity step (`metadata.kind="runtime_plan_step"`), relazione memoria→piano
    `describes`, piano→step `relates_to` con `metadata.kind="has_step"` e
    step→step `depends_on` quando il piano porta `depends_on` espliciti. Resta
    dentro `MemoryFacade`, nessun workflow store parallelo. Test mirato:
    `runtime_plan_memory_materializes_plan_step_graph`.
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

- ✅ **3.1 — chiudere il BUCO (prerequisito):** artefatti come **entità di memoria**
  (`title/type/project/path/thread/created_at` + embedding) via il `MemoryFacade`
  condiviso → recall del deliverable ("rifammi il deck del consiglio").
  **Slice locale/headless:** i produttori artifact principali (`run_in_sandbox`,
  `create_artifact`, `generate_image`, `render_deck`, `make_deck`) registrano
  ogni artifact surfaced come `memory_type="artifact"` + entity grafo `artifact`,
  metadata canonici (`thread_slug`, `name`, `artifact_type`, `path_ref`,
  `managed_path`, `project_path`, `size_bytes`) e backfill embedding immediato.
  Dopo il primo gate in-app fallito, anche `write_file` registra i file di
  progetto come artifact memoria/entity: se il modello interpreta "artifact" come
  file in-place, il deliverable entra comunque nella memoria. Il secondo gate ha
  mostrato che il ramo reale era `mcp__filesystem__create` workspace-scoped:
  anche quelle scritture dentro root progetto ora registrano artifact memoria/entity.
  Il terzo gate ha esposto la forma provider reale `mcp:filesystem`; il filtro è
  stato normalizzato e coperto da test. Gate runtime passato il 2026-06-23 dopo
  restart reale del gateway: `artifact-memory-gate-5.md` è stato creato via
  `mcp__filesystem__create`, registrato come `memory_type="artifact"` nello
  scope progetto, entity grafo `artifact`, embedding presente e recall esplicito
  riuscito. Nota: il pannello Artifacts non mostra ancora questi file perché oggi
  legge solo gli artifact surfaced/chat-managed; la surface passa a 3.2. Test:
  `artifact_memory_upsert_creates_single_record_and_graph_entity` e
  `mcp_filesystem_artifact_detection_accepts_namespaced_provider` verdi.
- 🟡 **3.2 — schermata Artefatti centralizzata** (Settings): selettore progetto
  (workspace) + filtri (progetto/tipo/orfani) + multi-selezione + **Esporta ZIP**
  (cross-OS, salva in cartella) + **Elimina**. Dati: `artifacts_usage` arricchito con
  titolo/progetto/flag orfano.
  **Slice 3.2a locale/verde:** `/api/artifacts/memory?thread=...` espone gli
  artifact registrati in memoria nello scope del thread/progetto; il Workbench
  Artifacts fonde artifact chat-managed e artifact memoria, con preview/download
  dei file di progetto via `fsFile` jailato. Gate endpoint: restituisce
  `artifact-memory-gate-5.md` con `project_relative_path`, `project_path`,
  `size=24`, `source=mcp_filesystem`. Gate visuale DOM/in-app: badge Workbench
  `1`, tab Artifacts mostra `artifact-memory-gate-5.md` e preview
  `test memoria artifact 5`.
  **Slice 3.2b locale/verde:** `/api/artifacts/usage` include anche gli artifact
  memoria dello workspace corrente, con `source=memory`, `reference`,
  `project_path`, `project_relative_path` e `title`; Settings distingue file
  managed vs memoria e chiama il delete memoria quando disponibile. **Resta:**
  export ZIP, filtri/progetto/tipo/orfani. Smoke runtime non distruttivo:
  `GET /api/artifacts/usage` su nuova build include `artifact-memory-gate-5.md`
  nel gruppo `memory:workspace_...`. Gate UI Settings passato: il gruppo memoria
  è visibile nella surface dedicata Artifacts. La surface è stata spostata fuori
  da Local computer perché i deliverable sono output di prodotto, non runtime
  tecnico.
  **Slice 3.2c locale/verde:** aggiunto `POST /api/artifacts/export`, che produce
  uno ZIP dai file visibili/selezionati nella UI. I file `managed` vengono letti
  solo dalla cartella artifacts jailata; i file `memory` vengono risolti dal
  `MemoryRef` canonico e validati contro root progetto/artifacts prima della
  lettura. Settings → Artifacts ora offre filtri gruppo/progetto, sorgente,
  tipo file e `memory-linked`/`orphan`, più selezione multipla. Test:
  `cargo test -p local-first-desktop-gateway artifact_ -- --nocapture` e
  `cargo test -p local-first-desktop-gateway -- --nocapture` (`176 passati, 1
  ignorato`) e `npm run build` desktop verdi. Smoke runtime API passato:
  `/api/artifacts/export` ha prodotto `/tmp/homun-artifacts-gate.zip` con entry
  `thread_1782105474_1782105474688595000/brand.json`. Gate in-app/DOM passato:
  la surface mostra `Export ZIP` e filtri Group/Source/Type/Link; click su
  `Export ZIP (12 visible)` ha scaricato uno ZIP valido con artifact managed e
  `memory-workspace_0d46c4470d97422298ece7ee7f0b74c6/artifact-memory-gate-5.md`.
- 🟡 **3.3 — lifecycle + cancellazione con memoria:** `delete_chat_thread` **non**
  cancella più gli artefatti: la chat è storia conversazionale, il deliverable ha
  lifecycle proprio. `DELETE /api/artifacts/memory?reference=...` rimuove il file
  solo se resta dentro root progetto o artifacts jail, poi tombstona memoria +
  entity artifact. Test verdi: `delete_chat_thread_preserves_artifact_lifecycle`,
  `artifact_memory_delete_path_is_jail_scoped`, gateway completo `174 passati, 1
  ignorato`, frontend `npm run build`.
  Gate runtime/in-app passato: `settings-delete-gate-fe0f6585.md` eliminato dalla
  UI → file rimosso, memoria `status=deleted`, tombstone memoria + entity
  presenti; cancellare un thread usa-e-getta ha preservato il file artifact
  managed finché non è stato rimosso esplicitamente via API artifact.

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
(2026-06-22): grafo 49k entità/236k relazioni ma oggi **soprattutto codice**; **391** embedding;
**9** pagine wiki markdown → la macchina c'è ma è **sbilanciata/dormiente** sui pezzi
che fanno "ricordare il perché e sopravvivere". Caposaldo #8.

- ☐ **5.1 Estendere il grafo** dal primo adapter maturo (code graph/Graphify) a
  **decisioni / artefatti / step di piano / esiti** + **archi causali**
  (`rationale_for`, `produced`, `derived_from`, `supersedes`, `blocks`). Include
  audit dei read-model graph-like (`contact_relationships`): se portano conoscenza
  semantica devono essere mirrorati/convergenti nel grafo canonico memoria.
- ✅ **5.2 Embeddare tutto** — `spawn_embedding_catchup` allo startup vettorizza ogni
  memoria mancante su **tutti** gli scope, loop fino a esaurimento (off critical path).
  Risolve il gap 391/555 (l'auto-consolidamento che faceva il backfill era OFF di
  default; il backfill altrove era cappato a 4-12).
- ✅ **5.3 Loop aperti** — tipo `open_loop` di prima classe: meccanismo validato
  in-app (cattura + recall cross-chat su gemma4:latest, v1042). Iniezione nelle
  chat nuove, proiezione wiki, dedup e chiusura automatica sono coperti da WS5.4.
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
  - ✅ **5.4b** proiezione markdown `stato-lavori.md` (faccia leggibile/editabile,
    bidirezionale): `/api/memory/wiki` rigenera una pagina "Stato lavori" dagli
    `open_loop`, linka i memory ref sorgenti, collassa parafrasi sulla pagina e
    rispetta `wiki-edited.json` come le altre proiezioni. Il save wiki ora re-ingesta
    genericamente la pagina memoria, non solo "decisioni". Test:
    `cargo test -p local-first-desktop-gateway status_wiki -- --nocapture` verde.
  - ✅ **5.4c** **chiusura automatica** dell'open_loop a lavoro fatto + **dedup**:
    gli `open_loop` parafrasati vengono superseduti via
    `MemoryFacade::merge_memories`; briefing e `stato-lavori.md` filtrano
    `superseded_by`; il salvataggio memoria e il consolidamento periodico
    deduplicano; l'estrattore può chiudere un loop attivo con
    `metadata.closes_open_loop`, marcandolo `Stale` solo se c'è overlap con un
    loop reale. Test: `open_loop_dedup_supersedes_duplicate_records` e
    `open_loop_closure_marks_matching_loop_stale_only_with_overlap` verdi.
- 🟡 **5.5 Catena di provenienza** decisione → artefatto → codice → esito (unisce
  WS2-3.1 artefatti→memoria + WS1-F6 piano→memoria + codice già nel grafo).
  **Slice 5.5a locale/verde:** ogni upsert di artifact memoria ora materializza
  nel grafo canonico anche entity `project`, entity `tool` producer, entity `file`
  quando `project_relative_path` è noto, e relazioni `produced`,
  `belongs_to_project`, `relates_to`; resta una sola verità nel `MemoryFacade`,
  niente store parallelo. Il vocabolario typed del crate memory include
  `rationale_for`, `produced`, `derived_from`. Test:
  `cargo test -p local-first-desktop-gateway artifact_memory_upsert_creates_single_record_and_graph_entity -- --nocapture`
  e `cargo test -p local-first-memory kind_tags_round_trip -- --nocapture` verdi;
  suite complete gateway (`176 passati, 1 ignorato`), suite completa memory e
  `npm run build` desktop verdi.
  **Slice 5.5b locale/verde:** gli artifact memoria collegano decisioni/piano/lavoro
  solo da evidenza strutturata già presente: `decision.affects_labels` che coincide
  con un identificatore canonico dell'artifact (`name`, `title`, `path_ref`,
  `project_relative_path`, path assoluto o basename), oppure ref esplicite nei
  metadata artifact (`decision_refs`, `plan_refs`, `task_refs`,
  `source_memory_refs`, `derived_from_refs`). Il grafo canonico materializza
  `decision --affects--> artifact` e `artifact --derived_from--> decision/source_ref`,
  con evidence refs alla memoria sorgente e alla memoria artifact. Non fa matching
  semantico né inferisce relazioni probabili. Test:
  `cargo test -p local-first-desktop-gateway artifact_memory_links_ -- --nocapture`.
  **Resta:** alimentare refs piano/task dagli artifact verso le entity/ref piano
  ora disponibili, senza inferire relazioni non evidenziate.
- 🟡 **5.6 Eval memoria** (guardrail): chat nuova → *"a che punto è il workflow e perché
  make_deck?"* / *"quali artefatti per il progetto X e da quale decisione?"* → deve
  rispondere. Anti-regressione, come l'eval del deck.
  **Prima slice locale/verde:** il reader di recall/RAG attraversa la provenance
  artifact nel grafo canonico (`describes`, `produced`, `affects`,
  `derived_from`) e restituisce un blocco `ARTIFACT PROVENANCE FROM CANONICAL
  MEMORY GRAPH` con artifact, producer, path, decisione/lavoro sorgente, rationale
  e alternative scartate. Test red/green:
  `cargo test -p local-first-desktop-gateway memory_eval_surfaces_artifact_provenance_and_decision_why -- --nocapture`.
  **Seconda slice locale/verde:** il reader di recall/RAG copre anche “a che punto
  è il workflow e perché?” con un blocco `WORKFLOW STATUS FROM CANONICAL MEMORY`,
  composto da `goal`, `open_loop`, outcome/fact verificati, decisioni con rationale
  e artifact provenance come evidenza. Test red/green:
  `cargo test -p local-first-desktop-gateway memory_eval_surfaces_workflow_status_and_why -- --nocapture`.
  **Resta:** decidere se serve smoke in-app mirato del reader memoria; piano/task
  refs complete ora possono appoggiarsi al grafo piano materializzato da WS1.

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
- ✅ **6.1b Approval-resume — cut #2 persist+publish (commit `6b0b9c7`), gate in-app passato**
  (causa REALE di demo-piano, confermata in-app 2026-06-22 su kimi+gemma): un task che scrive file → la 1ª scrittura
  (`mcp__filesystem__create` ∈ `composio_writes`) attiva la card `‹‹MCP_CONFIRM››`
  (:13340-13367) + Telegram + `pending_confirm` → turno muore a :13518; dopo l'**approvazione**
  `execute_pending_approval` (:21029) esegue **solo quell'azione** + riscrive in "✓ MCP tool
  executed" (:22315) → **nessuna continuazione**. Fix: dopo l'approvazione (in-app o Telegram)
  l'harness **rientra nel loop del thread d'origine** col risultato e continua. **Passo 0
  fatto** — meccanismo inchiodato: il ri-avvio è **`run_agent_turn(state, thread_id, prompt,
  policy)`** (:17078), già usato da canale inbound (:16528) e autorun (:19360). Due rami: (a)
  **in-app** `mcp_execute` (:22259) ha già `thread_id`+`message_id` → dopo exec+riscrittura,
  `spawn(run_agent_turn(...))`; (b) **Telegram** → aggiungere `thread_id` a `PendingApproval`
  (:21063) propagato da `create_pending_approval` (:21078) ← `deliver_remote_approval` (:21082)
  ← call-site loop (:13362), poi `run_agent_turn`. Frizione "approva ogni scrittura" già
  mitigata da **Policy B `allow_server`** (:22273). Blocca **ogni** deliverable che scrive file
  → **prima di slice 3 / WS2**. Lega ADR 0015 + caposaldo #2.
  **IMPLEMENTATO (commit `7f98d57`):** `thread_id` aggiunto a `PendingApproval` +
  `create/take_pending_approval` + `deliver_remote_approval`; helper `resume_thread_after_approval`
  → `spawn(run_agent_turn(thread, prompt, "full"))`; agganciato a `mcp_execute` (in-app) e
  `execute_pending_approval` (Telegram); call-site MCP (:13362)/Composio (:13452) passano il
  thread, bozza-canale (:16572) `None`.
  **cut #1 GATE FALLITO (2026-06-22):** `run_agent_turn` drena lo stream e il resume **scartava**
  il risultato → invisibile ("approva su Telegram ma non cambia nulla"). **cut #2 FATTO (commit
  `6b0b9c7`):** il resume **persiste** (`append_assistant_message`) + **pubblica `thread.updated`**
  (pattern canale inbound :16544) → chat aggiornata via refresh, approvazioni **in-app E Telegram**
  (server-side, no frontend). Catena: continuazione si ferma alla 2ª confirm → card nel testo
  persistito → riappare in-app + msg Telegram → approvi → riprende. **Gate in-app pendente.**
  Limite: refresh, non token-live; nessun indicatore "sta lavorando".
  **Blocco Telegram trovato nel re-test (2026-06-22):** bridge orfano della build installata su
  `:18767` → card outbound funziona, ma `TG_GATEWAY_TOKEN` stale. Prova read-only contro il
  gateway locale: token del bridge **401**, token corrente **200**. Il bridge ignora la response
  della callback, perciò il tap non mostra errore. Prima del gate Telegram: rendere il lifecycle
  del sidecar resiliente a restart/update (rebind/handshake con token corrente, senza credenziali
  in log) e registrare esito HTTP redatto della callback. Non attribuire questo al resume 6.1b.
  **Lifecycle fix FATTO (commit `1ab8a53` + `793ca9c` + `417ee95`):** `/configure-gateway`
  autenticato reimposta URL+token callback in memoria; il gateway tenta rebind dopo il bind HTTP,
  sostituisce solo bridge legacy/stale e attende al massimo 3 s il proprio child prima del primo
  rebind. Bridge test **6/6**, gateway **151 passati / 1 ignorato**, build locali verdi. Prova
  Electron: stale installato → replacement; avvio seguente → `reconfigured existing sidecar`;
  connect API → `reconfigured:true`. **Gate Telegram END-TO-END PASSATO (Gemma, 2026-06-22):**
  thread `thread_1782134906_1782134906142839000` ha emesso confirm MCP per `note.md` e
  `riepilogo.md`, quindi ha persistito il completamento; filesystem verificato con entrambi i file
  in `~/demo-piano`. La chat ha prima chiesto il path base, poi ha eseguito il flusso corretto.
  **Bivio risolto:** Path B e WS6.1c sono stati entrambi implementati e verificati sotto.
- ✅ **Path B — root automatica per Filesystem MCP (2026-06-22):** scelta utente:
  **STATO ATTUALE / resume rapido:** implementazione locale completata fino al
  binding persistente delle approval remote. **Gate fuori-root/in-app passato
  (2026-06-22):** prompt canonico
  `Usa il tool MCP filesystem per creare /Users/fabio/Desktop/path-b-approval-bound.md con una riga: test.`
  ha creato il file esatto con `test`; thread
  `thread_1782142399_1782142399448892000`; `chat_messages` mostra user prompt →
  `✓ MCP tool executed` → finale sul file corretto; zero occorrenze di
  `path-b-gate/note.md`; `remote_approvals` ha
  `source_message_id=browser_assistant_1782142417646` e stato `superseded`
  (approvazione in-app ha invalidato il codice remoto). **Retry Telegram
  successivo:** callback Telegram ha eseguito correttamente l'azione (`status=
  'executed'`, file `/Users/fabio/Desktop/path-b-telegram-bound.md` con
  `telegram-test`, source `browser_assistant_1782142921059`), ma il resume ha
  sintetizzato il vecchio `path-b-gate/note.md`. **Fix locale:** prompt di
  resume ancorato a richiesta originale + args approvati + guardrail anti
  memoria/open-loop; test gateway **160 passati, 1 ignorato**. **Gate finale
  passato:** micro-gate Telegram-only con `path-b-telegram-bound-2.md` termina
  con `status='executed'`, finale chat sul path corretto e zero vecchio
  `path-b-gate`. Vietato ripetere probe di scrittura via endpoint HTTP grezzo.
  il connettore MCP resta collegato una volta sola a livello utente; ogni chiamata
  eredita la root del progetto del thread. Implementati manifest statico
  `mcp:filesystem` (`create`/`insert`/`str_replace`), jail assoluta
  symlink-safe, bypass card solo in-root e prova della confirm-card per il direct
  endpoint. Correzione UX/runtime: il system context ora comunica al modello la
  root assoluta del thread e che Filesystem è già disponibile — non deve chiedere
  né cartella né reconnect. **Prova runtime Electron (Kimi, `test-homun`):**
  `thread_1782138001_1782138001354628000` → attività `create`, nessun
  `MCP_CONFIRM`, file
  `/Users/fabio/Desktop/test-homun/path-b-gate/note.md` con `una/due/tre`,
  messaggi persistiti in `chat_messages`. Test gateway: **156 passati, 1
  ignorato**. Corretto anche il prompt operativo per il path fuori-root: deve
  chiamare il tool con path assoluto e far decidere al runtime, non dichiarare
  l'MCP assente né deviare nel progetto. Runtime Kimi,
  `thread_1782139063_1782139063946466000`: card prodotta per
  `/Users/fabio/Desktop/path-b-outside-gate-1782139063.md`; il `tool_runs`
  registra `create` solo dopo callback Telegram autorizzato alle 16:38:34.
  **Root cause ulteriore (verificata end-to-end):** Auto in un thread progetto
  sceglieva `coding`/`glm-5.2`, mentre il composer mostrava l'orchestratore
  `kimi-k2.6:cloud`; GLM risponde `400/1210` al round con tool e il loop
  proseguiva poi con una sintesi senza tool. Kimi esplicito ha provato che il
  Filesystem MCP è connesso e callable. **Fix locale, gate pendente:** endpoint
  modelli thread-aware (Auto mostra il routing reale), payload senza `tools: []`,
  fallback una sola volta al ruolo orchestratore dopo `400` con tool, e
  `run_agent_turn` thread-aware. Gateway **157 passati, 1 ignorato** + build
  desktop verde. **Prova runtime Electron da HEAD:** thread
  `thread_1782140733_1782140733708101000` ha risolto Auto=`glm-5.2`, emesso una
  sola attività fallback e poi la card per
  `/Users/fabio/Desktop/path-b-provider-fallback-1782140733.md`; il file era
  assente. **Gate invalidato subito dopo:** il probe HTTP ha realmente spedito
  un'approval Telegram, ma non ha persistito la sorgente nel thread. Quando
  approvata, ha eseguito il probe e ha fatto ripartire un thread senza il prompt
  originario; il resume ha contaminato il nuovo task con
  `path-b-gate/note.md` (catena verificata in `chat_messages`, file probe
  esistente). Gli stream sono ora vuoti; la vecchia mappa in-memory non era
  auditabile. **Fix locale implementato:** nuova tabella `remote_approvals`
  (`approval_id`, codice, tool/args, thread, `source_message_id`, stato);
  marker chat con `approval_id`; notifica Telegram/WA differita fino a card
  persistita; callback remoto valida card+tool+args+approval_id prima di
  `pending→executing`; origini non persistite vengono rifiutate; in-app
  supersede il codice remoto. `composio_execute` verifica ora la card come MCP.
  Gateway **159 passati, 1 ignorato**. **Gate parziale:** in-app passa;
  Telegram esegue (`executed`) ma resume contaminava il finale. **Fix locale
  successivo:** `approval_resume_prompt` con richiesta originale + args approvati
  e test gateway **160 passati, 1 ignorato**. **Gate finale PASSATO:** retry con
  `path-b-telegram-bound-2.md` ha prodotto `status='executed'`, file corretto,
  finale chat sul path approvato e zero `path-b-gate/note.md` nel thread.
  **Path B approval/provenienza chiusa**; non usare più il direct endpoint per
  test di scrittura reali.
- ✅ **6.1c UX Telegram approval (2026-06-22):** slice locale implementata dopo
  Path B: il callback Telegram su codice valido invia subito “Ricevuto…
  verifico/avvio”; il thread app riceve status persistiti “Approvazione Telegram
  ricevuta / eseguo …” e “Azione approvata da Telegram eseguita … riprendo il
  task” o “fallita …”, con target da args (`path`/`to`) e `thread.updated`.
  **Gate UX ha trovato una causa ulteriore:** notifica Telegram iniziale non
  inviata anche se card e `remote_approvals` erano corrette; prova:
  `approval_fc2026c6804a45029123b354672cd130`/`FC2026` resta `pending` con
  `dispatched_at=NULL`. Fix locale: outbound Telegram per approval/progresso
  ritenta con rebind automatico del sidecar usando il token persistito; se fallisce
  ancora, appende nel thread status `delivery_failed` con fallback esplicito a
  card in-app/reconnect invece del silenzio. Test
  `telegram_approval_progress_messages_are_actionable`; gateway **161 passati,
  1 ignorato**; `cargo build -p local-first-desktop-gateway` verde; `npm run
  build` desktop verde; `git diff --check` pulito. **Gate pendente:** riavvio
  Electron da HEAD e micro-test Telegram con nuovo path: verificare notifica
  Telegram iniziale, messaggio Telegram immediato, due status nel thread, finale
  resume corretto, `remote_approvals.dispatched_at IS NOT NULL` e
  `remote_approvals.status='executed'`. Non riusare `FC2026`.
  **Gate 18:17 ancora fallito:** `approval_e14399953a6c4dd6a5f9a7c7d1214114`
  / `E14399` per `path-b-telegram-ux-2.md` resta `pending` con
  `dispatched_at=NULL`; thread senza `delivery_failed`; prefs Telegram corrette.
  Questa evidenza punta a processo Electron/gateway vecchio/non riavviato da
  HEAD. Prossimo check: hard-stop dei processi, restart `npm run electron:dev`
  da `apps/desktop`, path nuovo.
  **Gate finale PASSATO dopo riavvio (18:20):**
  `approval_1a16fb7978fe4a91b163560fafbecff0` / `1A16FB` per
  `/Users/fabio/Desktop/path-b-telegram-ux-2.md` ha
  `status='executed'`, `dispatched_at` valorizzato e `resolved_at` valorizzato;
  thread con status running+executed e finale ancorato al path/contenuto
  `ux-ok-2`; file presente sul Desktop. **WS6.1c chiusa.**
- ✅ **6.2 Resource Governor** attivo sui task (limiti, backpressure).
  **Slice 1 FATTA (2026-06-22):** fix backpressure recuperabile. Gap trovato:
  `WaitingResource` non rientrava in `ready_tasks` dopo rilascio risorsa, perché
  lo scheduler considera solo `Queued|Pending`. Implementato
  `ResourceGovernor::requeue_waiting_if_available` + sweep gateway
  `requeue_waiting_resource_tasks` prima di `ready_tasks`, dopo lease recovery.
  Test red/green task-runtime
  `resource_governor_requeues_waiting_task_when_capacity_returns`; test gateway
  `task_executor_requeues_waiting_resource_before_scheduling`. Verifiche:
  `cargo test -p local-first-task-runtime` verde; gateway **162 passati, 1
  ignorato**; `cargo build -p local-first-desktop-gateway` verde; `npm run build`
  desktop verde; `git diff --check` pulito.
  **Slice 2 FATTA (2026-06-22):** stesso recupero cablato anche nel
  `TaskRuntime` standalone: `run_ready_once` reidrata i `WaitingResource` prima
  di `ready_tasks`. Test red/green
  `task_runtime_requeues_waiting_resource_before_scheduling` (prima
  `summary.completed=0`, dopo completa il task appena la risorsa viene rilasciata).
  Verifiche: `cargo test -p local-first-task-runtime` verde; focused gateway
  `task_executor_requeues_waiting_resource_before_scheduling` verde; build gateway
  e desktop verdi; `git diff --check` pulito.
  **Slice 3 FATTA (2026-06-22):** visibilità backpressure nella API task queue:
  `resource_usage[]` ora espone `units`, `limit_units`, `available_units` e
  `saturated` per classe. I limiti sono quelli effettivi del worker
  (`conservative_defaults` + `active_llm_concurrency` per `llm_inference`).
  Test red/green `task_queue_response_serializes_ui_read_model_for_renderer`;
  gateway **162 passati, 1 ignorato**; task-runtime verde; build gateway/desktop
  verdi; `git diff --check` pulito.
  **Slice 4 FATTA (2026-06-22):** stress-gate headless multi-worker su SQLite
  condiviso: due connessioni `TaskStore` separate, limite `llm_inference=1`,
  un worker detiene la reservation e un secondo `TaskRuntime` porta il task
  concorrente a `WaitingResource`; dopo rilascio reservation, il tick successivo
  reidrata e completa il task. Test:
  `task_runtime_recovers_resource_wait_across_worker_connections`. Verifiche:
  `cargo test -p local-first-task-runtime` verde; gateway **162 passati, 1
  ignorato**; build gateway e desktop verdi; `git diff --check` pulito.
  **Decisione:** 6.2 chiusa; la UI configurabile dei limiti resta una futura
  micro-slice opzionale, non blocca 6.3.
- ✅ **6.3 Scheduler / ricorrenza** + **proactive review** (l'assistente propone schede
  in autonomia governata) verificati end-to-end.
  **Slice 1 FATTA (2026-06-22):** allineato `TaskRuntime` standalone al worker
  gateway sulla ricorrenza. Test red/green:
  `task_runtime_materializes_next_recurrence_after_completion` (red: completava
  il task `daily` ma non inseriva `daily@occ@...`; green: occorrenza successiva
  `Queued`, `not_before > now`, stessa recurrence). Verifiche: task-runtime
  verde; gateway **162 passati, 1 ignorato**; build gateway e desktop verdi;
  `git diff --check` pulito.
  **Slice 2 FATTA (2026-06-22):** failure/retry recurrence parity tra runtime e
  gateway. Test red/green
  `task_runtime_materializes_next_recurrence_after_terminal_failure` (red:
  task ricorrente terminale `Failed` senza prossima occorrenza; green:
  `daily@occ@...` `Queued`, recurrence mantenuta, `not_before > now`). Il retry
  intermedio resta invariato (`WaitingTime`, nessuna nuova occorrenza).
  **Slice 3 FATTA (2026-06-22):** gate headless scheduled/proactive prompt:
  `materialize_automation_task` crea un task `proactive_prompt` visibile e le
  occorrenze riusano lo stesso thread `channel_scheduled_<root>`. Test:
  `scheduled_automation_materializes_visible_proactive_task`,
  `scheduled_occurrences_reuse_one_visible_thread`.
  **Slice 4 FATTA (2026-06-22):** surface/dedup proactive review coperta da
  parse/card/choices/dedup fuzzy/read-model tests.
- ✅ **6.4** Le azioni proattive scrivono in memoria (loop aperti / decisioni) — lega WS5.
  `suggestion_act` scrive memoria auto-confermata nello scope della card:
  `accepted|snoozed` → `open_loop`, `dismissed` → `decision`, con metadata
  card/dedup/action. Test:
  `proactive_action_memory_writeback_maps_statuses`,
  `suggestion_lookup_preserves_durable_dedup_key`. Gate finale locale:
  task-runtime verde; gateway **166 passati, 1 ignorato**; build gateway/desktop
  verdi; `git diff --check` pulito. **WS6 chiusa localmente.**
  **Post-smoke fix (2026-06-23):** lo smoke reale su scheduled automation ha
  mostrato un falso positivo: il runtime registrava `completed`/`ok=1` per una
  risposta non vuota che conteneva solo un `PLAN` ancora aperto (2/4) e testo di
  progresso. La gestione condivisa del piano (`plan_is_complete` /
  `plan_incomplete_reason`) ora considera completo solo `done == total`; il
  runner scheduled la usa tramite `agent_output_incomplete_reason`, classificando
  come incompleti il fallback "No reply generated..." e i marker `PLAN` con step
  non completati. Produce `completed=false`, `blocked_reason` ed evento
  `proactive_prompt_incomplete` invece di una falsa chiusura. Test mirati:
  `cargo test -p local-first-desktop-gateway plan_guard -- --nocapture` e
  `cargo test -p local-first-desktop-gateway plan_completion_requires_every_step_done -- --nocapture`.

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

1. **WS6 locale consolidata/committata** — publish/tag solo su comando. Lo smoke
   manuale in-app su scheduled automation reale ha prodotto un fix post-smoke
   contro le false chiusure; prima del publish resta utile ripetere il gate con
   il binario aggiornato.
2. **WS2-3.2b / 3.3** — completare export ZIP/filtri: central surface e
   lifecycle/delete sono cablati e passati in-app.
3. **WS5.5 / WS5.6** — catena di provenienza decisione → artefatto → codice →
   esito, più eval memoria come guardrail.
4. **WS1-Fase 2** — gestione piano (`ExecutionPlan`+`step_id`); write-back
   piano→memoria e grafo piano/step locali/verdi, resta convergere sul tipo
   `ExecutionPlan`.
6. **WS1-Fase 3** — skill dichiarative + workflow runner.
7. **WS7** — ecosistema deliverable (`make_*` per documenti/ricerca/meeting),
   volutamente dopo memoria/artefatti/engine baseline.
8. **WS8 completo + WS4** — eval come gate di release, perf/affidabilità/UX a
   regime.
9. **WS9 + WS1-Fasi 4→6** — marketplace/plugin distribution, router+scaffolding
    adattivo, Brain (ADR 0008), memoria per-step + sub-agent.

> Note: la **memoria (WS5)** è il filo trasversale (artefatti→memoria e piano→memoria la
> alimentano). La **gestione piano (WS1-Fase 2)** è il refactor più profondo: dopo i quick
> win e le fondamenta memoria, prima delle Fasi 3-6 che ci si appoggiano. **Cloud /
> always-on** (canali 24/7, proattività continua, self-hostable — `self-host.md`) resta
> direzione **futura**, non in questo ciclo. **Sub-agent** maturano dentro WS1-F6.
