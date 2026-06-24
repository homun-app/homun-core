# Homun — Sviluppo (hub vivo)

> **Punto d'ingresso unico.** Da qui si parte e si torna. Questo file è SEMPRE
> aggiornato: se cambia una scelta importante, si aggiorna qui (o nel doc linkato).
> Ultimo aggiornamento: 2026-06-23.

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
7. Capability activation da **registry unico**, non keyword sparse.
8. Niente keyword/regex; verità verificabile.
9. La memoria cattura il **PERCHÉ** e i **loop aperti**, e collega TUTTO nel grafo (verificabile via eval).

## Mappa della documentazione (una fonte per ogni cosa)

| Domanda | Dove |
|---|---|
| **Principi** (cosa non si viola) | [CAPISALDI.md](CAPISALDI.md) |
| **Scelte precise** (perché abbiamo deciso X) | [decisions/](decisions/) — ADR 0001-0016 (immutabili) |
| **Com'è fatto** (architettura + diagrammi) | [architecture/](architecture/) — overview + memory + agent-loop + plugins + system-map |
| **Dove siamo / cosa manca** (backlog corrente) | [plans/2026-06-22-…](plans/2026-06-22-batch-1042-artifacts-memory.md) |
| **La memoria** (contratto operativo + visione + struttura) | [MEMORIA.md](MEMORIA.md) · [memory-vision.md](memory-vision.md) · [memory-architecture.md](memory-architecture.md) |
| **Prodotto / distribuzione / self-host** | [PRODUCT_LOOP.md](PRODUCT_LOOP.md) · [distribution.md](distribution.md) · [self-host.md](self-host.md) · [release-macos.md](release-macos.md) |
| **Storico** (changelog, vecchi piani, snapshot) | [archive/](archive/) — non più "corrente", solo memoria storica |

## Stato esecuzione — "SEI QUI" (aggiornato 2026-06-23, anti-compattazione)

> Se il contesto si è compattato: rileggi QUESTO blocco + il
> [backlog](plans/2026-06-22-batch-1042-artifacts-memory.md) (gli stati ☐/✅ = i loop
> aperti) e sei di nuovo sul filo. Stesso principio della memoria di Homun (caposaldo #10).

### Cruscotto operativo attuale

- **Linea attiva:** consolidamento memoria + artefatti prima di WS7. **WS6 chiusa localmente**:
  Resource Governor, scheduler/ricorrenza, proactive review card surface/dedup
  e write-back memoria proattiva sono coperti da test e build. Lo smoke reale
  su automazione schedulata nel thread `scheduled` ha trovato una falsa chiusura:
  il runtime marcava `completed` una risposta non vuota anche quando conteneva
  solo `PLAN` intermedio. Fix locale: la gestione condivisa del piano ora
  distingue piano completo (`done == total`) da piano aperto/bloccato; i
  proactive prompt usano quella guardia invece di schedulare un falso successo.
  Il contratto operativo corrente della memoria è [MEMORIA.md](MEMORIA.md).
- **Direzione WS7 aggiornata:** l'obiettivo deliverable non è una gallery statica
  clonata tool-per-tool, ma un **design system dichiarativo condiviso** per
  documenti e presentazioni/plugin: temi, layout, componenti, template e QA
  visuale sono grammatica comune; `make_document` e `make_deck` la consumano come
  capability del registry unico. Il modello compone narrativa e blocchi, il
  renderer deterministico produce `.docx`/`.pptx`/`.pdf`/HTML e la QA verifica
  overflow, tabelle, immagini e leggibilità. Prima slice locale/verde:
  `design_profile` condiviso (`executive`, `sales_pitch`, `technical`,
  `editorial`, `minimal`) nello schema di `make_document` e `make_deck`,
  propagato nei rispettivi workflow/prompt senza nuovi `make_*`. Seconda slice
  locale/verde: `design_components` condiviso (`kpi_grid`, `timeline`,
  `comparison_table`, `quote_callout`, `process_steps`, `risks_table`) come
  componenti dichiarativi per il composer. Terza/quarta slice locali/verdi:
  quei componenti vengono materializzati deterministicamente nei layout deck
  (`kpi`, `quote`, `two_column`) e in blocchi/tabelle Markdown-DOCX. Slice
  corrente locale/verde: `design_template` condiviso (`startup_pitch`,
  `executive_update`, `project_plan`, `technical_brief`, `sales_proposal`) che
  espande in default profilo/componenti; gli argomenti espliciti restano
  sovrani. Sesta slice locale/verde: `design_theme` condiviso
  (`clean_corporate`, `high_contrast`, `warm_editorial`, `minimal_mono`,
  `soft_gradient`) entra negli schemi/workflow/prompt; lato deck materializza
  token `theme` compatibili con `deck_render.py` e applica un primo guardrail QA
  deterministico su titoli/bullet troppo lunghi prima del render. Settima slice
  locale/verde: nuovo comando container `deck-qa` apre l'HTML renderizzato con
  Chromium headless via DevTools Protocol e blocca la consegna se rileva
  overflow slide, elementi fuori bounds o immagini non caricate; `make_deck` e
  `render_deck` lo eseguono prima di registrare gli artifact. Ottava slice
  locale/verde: primo template catalog provider read-only nel registry
  (`monet/*` seed), cercabile da `find_capability` ma non callable; il modello
  passa `template_ref` a `make_deck`/`make_document` e il gateway lo risolve in
  `design_template`/`design_theme`/`design_profile`/componenti già supportati.
  Monet resta catalogo/adapter di template, non secondo renderer/store né nuovo
  sistema `make_*`. Nona slice locale/verde: il seed `monet/*` passa dietro a
  un `TemplateCatalogProvider` interno con collector multi-provider deduplicato;
  è il punto di aggancio futuro per MCP Monet, marketplace o template pack
  firmati senza cambiare `make_deck`/`make_document`. Decima slice locale/verde:
  `FileTemplateCatalogProvider` carica manifest JSON locali da
  `HOMUN_TEMPLATE_CATALOG_PATH` o `~/.homun/template-catalog.json`, validando ID,
  kind e token `design_*`; i cataloghi file aggiungono template al registry ma
  non sovrascrivono i seed built-in. Undicesima slice locale/verde:
  `deck-qa` verifica anche leggibilità su HTML reale: font-size minimo e
  contrast ratio WCAG-like (`low_contrast`, `text_too_small`) bloccano la
  consegna del deck come gli overflow. Dodicesima slice locale/verde:
  `make_document` applica un guardrail QA deterministico al Markdown generato
  prima di scrivere artifact MD/PDF/DOCX: linee troppo lunghe, token non
  spezzabili e righe tabella con numero celle incoerente bloccano la consegna.
  Tredicesima slice locale/verde: il seed `monet/*` sale da 5 a 11 template
  PMI reali (one-pager, case study, verbale riunione, launch plan, incident
  review, product roadmap) sempre come entry catalogo non callable risolte nei
  token esistenti. Quattordicesima slice locale/verde: i manifest file possono
  portare metadati opzionali `tags`, `preview_ref`, `source_ref` e `license`,
  sanificati prima dell'indicizzazione; servono a cataloghi/gallery futuri senza
  trasformare i template in tool o store paralleli. Quindicesima slice
  locale/verde: il catalogo template è esposto read-only da
  `/api/templates/catalog` e da `coreBridge.templateCatalog()`, così la UI può
  costruire una gallery senza duplicare il registry. Sedicesima slice
  locale/verde: il plugin Presentations mostra una prima gallery template
  filtrabile per presentazioni/documenti, con metadati `design_*`, layout
  archetype e copia del `template_ref`; è alimentata dall'API catalogo, non da
  un elenco duplicato. Non mostra finte preview grafiche: finché non ci sono
  asset `preview_ref` reali, resta una contract gallery. Diciassettesima slice
  locale/verde: i seed locali `monet/*` dichiarano ora `preview_ref`
  `builtin:template-preview/*`; la UI materializza una preview compatta dai token
  `design_theme`/layout/componenti già nel catalogo e mantiene il fallback
  contract-only per cataloghi esterni senza preview. Prossimo asse: preview
  asset/thumbnail reali per pack esterni e QA ancora più profonda.
  Correzione UX post-smoke: il menu modelli distingue ora i modelli cloud
  instradati tramite endpoint locale Ollama (`☁ via local`) dai provider cloud
  diretti; in quel caso serve Ollama locale acceso oppure una binding sul
  provider remoto effettivo. Correzione runtime successiva: quando il router
  instrada a un workflow one-call (`make_deck`/`make_document`), il gateway
  blocca tool fallback non ammessi (shell/filesystem/MCP create) invece di
  lasciare che il modello aggiri il workflow dopo un errore provider. Nota
  esplicita: i `template_ref` `monet/*` attuali sono seed locali del catalogo
  Homun, non lookup MCP; se `make_deck` fallisce su `127.0.0.1:11434`, la causa
  è il provider contenuti non raggiungibile/incompatibile, non il template.
  Smoke successivo: Ollama locale risponde, ma `kimi-k2.6:cloud` via Ollama
  restituisce reasoning-only e `content` vuoto, quindi non è adatto al JSON
  schema di `make_deck`; quando la QA deck segnala problemi dopo il render, i
  file già scritti vengono comunque emessi come artifact visibili e registrati
  in memoria, con warning QA invece di sparire. Correzione activity stream:
  `/api/chat/active_streams` ora considera terminato qualunque stream che abbia
  già emesso `done/error` nello stesso punto in cui il gateway emette il
  terminale, anche se il post-processing memoria è ancora lento; inoltre gli
  stream senza eventi recenti vengono marcati stale per evitare lampeggi
  sidebar fantasma quando si cambia chat. Il resume marker frontend ora ha TTL
  e scarta i marker legacy senza timestamp, così un reload non riattacca stream
  vecchi e non ricrea lo stato busy. Follow-up UI live: il dock Computer riceve
  `thread_id` dal gateway e viene mostrato solo nella chat proprietaria
  dell'attività e solo mentre browser/terminal sono effettivamente running (non
  resta come storico a fine comando); anche il vecchio pannello inline Computer
  non si apre più automaticamente solo perché la sessione contiene timeline o
  artifact completati. Il messaggio streaming usa lo stesso parser del messaggio
  finale, quindi plan/progress/markdown emergono durante lo stream invece che
  solo a fine risposta. Guardrail successivo: `test:ui-contract` copre questo
  contratto e il dock Computer usa polling adattivo (600ms durante attività,
  2500ms da idle) per ridurre il carico sulle chat pesanti.
  **WS8 eval locale:** `scripts/eval_suite.py` ora include anche il flusso
  documento strutturato con formato `docx` obbligatorio, supporta
  `HOMUN_EVAL_BASE` e stampa progressivamente; smoke locale `gemma4:latest 1`
  passato su deck/document/plan/decision/open_loop. Slice successiva: la suite
  può eseguire anche contract check opzionali sul gateway reale con
  `HOMUN_EVAL_GATEWAY_BASE`/`HOMUN_EVAL_GATEWAY_TOKEN`, validando
  `/api/templates/catalog` e `/api/capabilities/snapshot` come primi guardrail
  HTTP prima del render end-to-end. **WS8.3 pre-release gate locale/verde:**
  aggiunto `scripts/pre_release_gate.py`, che raccoglie i gate deterministici
  (`cargo test -p local-first-capabilities -- --nocapture`,
  `cargo test -p local-first-desktop-gateway -- --nocapture`,
  `npm run test:ui-contract`, `npm run build`, `py_compile` della eval suite) e
  abilita gli eval modello/gateway solo via env (`HOMUN_RUN_MODEL_EVAL`,
  `HOMUN_EVAL_GATEWAY_BASE`). Verifica aggiornata: `python3 scripts/pre_release_gate.py`
  verde con suite capabilities, **255 test gateway passati, 1 ignorato**, UI
  contract e build desktop verdi.
  **WS4 chat perf:** `RichMessage` e il renderer markdown lazy sono memoizzati,
  così polling/live state e sidebar non ricalcolano markdown pesante per messaggi
  completati invariati.
  **Provider UX:** le card Settings per preset provider ora matchano prima
  l'id stabile e poi l'URL, così preset come Z.ai standard/coding non ricadono a
  Custom quando l'endpoint cambia o una configurazione legacy conserva lo stesso
  id; il contratto UI blocca regressioni sugli endpoint Z.ai separati.
  **Artifact UX:** i workflow managed (`make_deck`, `make_document`) includono
  `managed_path` nei marker artifact e la chat mostra una riga path compatta
  sotto ogni file, così l'utente vede dove vive il deliverable oltre ai pulsanti
  preview/download.
  **Computer owner hardening:** il dock live non tratta più `thread_id=null`
  come visibile ovunque quando c'è attività browser/terminal; da idle resta
  neutro, ma un'attività live richiede owner esplicito uguale alla chat corrente.
  **WS4 seeder skills:** il seeder delle default skills ora hasha l'intero tree
  della skill (manifest, script e asset), non solo `SKILL.md`, così gli update
  bundled vengono applicati quando la copia utente è ancora stock e restano
  protetti quando l'utente ha davvero modificato la skill.
  **WS4 image role UX:** Settings → Model per task mostra un hint quando il
  ruolo `image_generation` non ha modelli immagine disponibili; i deck restano
  generabili senza immagini, ma la causa è esplicita prima del workflow.
  **WS4 deck image prompt:** il workflow deck non passa più il titolo slide
  esatto/quotato al provider immagini; usa temi/keyword e un divieto esplicito
  di tipografia per ridurre testo storpiato nelle immagini generate.
  **WS9.1 plugin manifest contract locale/verde:** il contratto condiviso
  `local-first-capabilities::PluginManifest` ora dichiara metadati distributivi
  (`channel` stable/beta, `min_homun_version`, `entitlement` free/paid,
  `signature`) e capability dichiarate (`panel`, `skill`, `workflow`,
  `connector`, `template_catalog`). I manifest legacy deserializzano come
  stable/free senza firma. Verifica: `cargo test -p local-first-capabilities -- --nocapture`
  verde. **WS9.2 registry index contract locale/verde:** lo stesso crate espone
  `PluginRegistryIndex` / `PluginRegistryEntry` per un feed JSON marketplace
  separato: `schema_version`, `generated_at`, entry per plugin con channel,
  entitlement, compatibilità minima, `manifest_url`, `package_url`,
  `package_sha256` e firma Ed25519 dichiarata. Verifica: suite capabilities
  verde. **WS9.4a package integrity policy locale/verde:** `PluginRegistryEntry`
  valida metadata install-time minimi (`sha256:<64 hex>`, algoritmo firma
  `ed25519`), confronta il digest SHA-256 del pacchetto e verifica la firma
  Ed25519 sui byte pacchetto. Verifica: suite capabilities verde; restano
  collegamento a fetch/install, policy chiavi trusted e enforcement update.
  `make_research` e `make_meeting` restano dopo questo asse.
- **WS2-3.1 PASSATA in runtime (2026-06-23):** gli artifact scritti via
  Filesystem MCP dentro la root progetto vengono registrati come
  `memory_type="artifact"` + entity grafo `artifact` + embedding. Gate:
  `artifact-memory-gate-5.md` creato in `/Users/fabio/Desktop/test-homun`,
  `tool_runs.id=57` (`mcp__filesystem__create`, `ok=1`), memoria
  `artifact|confirmed` nello scope
  `workspace_0d46c4470d97422298ece7ee7f0b74c6`, entity `artifact` e 1 embedding.
  Recall esplicito: un nuovo turno ha recuperato `artifact-memory-gate-5.md`.
  Nota operativa: il gate precedente su `artifact-memory-gate-4.md` era falso
  negativo perché il gateway in esecuzione era partito alle 23:06, prima della
  build delle 23:13; dopo modifiche gateway serve restart reale del processo.
- **WS2-3.2a locale/verde:** aggiunto `/api/artifacts/memory?thread=...`, che
  legge `memory_type="artifact"` nello scope del thread/progetto e restituisce
  artifact con `project_path`, `project_relative_path`, tipo e dimensione. Il
  Workbench Artifacts ora fonde i marker chat-managed con gli artifact memoria:
  i file creati in-place via Filesystem MCP diventano visibili nel pannello e
  vengono previewati/scaricati via `fsFile`, restando jailati alla root progetto.
  Gate endpoint: `artifact-memory-gate-5.md` restituito per
  `thread_1782197059_1782197059045808000`. Gate visuale DOM/in-app: badge
  Workbench `1`, tab Artifacts mostra `artifact-memory-gate-5.md` e preview
  `test memoria artifact 5`.
- **WS2-3.2b/3.3 slice locale/verde:** lifecycle artifact separato dalla chat.
  `delete_chat_thread` non rimuove più i deliverable; `/api/artifacts/usage`
  include anche gli artifact registrati come memoria; `DELETE /api/artifacts/memory`
  elimina il file solo se resta dentro root progetto/artifacts jail e poi
  tombstona memoria + entity artifact. Settings usa il delete memoria quando il
  file arriva da `memory_type="artifact"`. Test:
  `delete_chat_thread_preserves_artifact_lifecycle`,
  `artifact_memory_delete_path_is_jail_scoped`, gateway completo `174 passati, 1
  ignorato`; frontend `npm run build` verde. Smoke runtime non distruttivo dopo
  restart Electron da HEAD: `GET /api/artifacts/usage` include il gruppo
  `memory:workspace_0d46c4470d97422298ece7ee7f0b74c6` con
  `artifact-memory-gate-5.md`, `source=memory`, `reference` e `project_path`.
  **Gate in-app/Settings PASSATO:** la surface dedicata “Artifacts” mostra il
  gruppo `memory:workspace_...` con
  `artifact-memory-gate-5.md`; un artifact usa-e-getta
  `settings-delete-gate-fe0f6585.md` è stato rimosso dalla UI, il file è sparito
  dal filesystem, la memoria è passata a `status=deleted` e sono presenti i
  tombstone di memoria + entity. Gate chat-delete: un thread usa-e-getta
  cancellato via API ha preservato il file artifact managed finché non è stato
  pulito esplicitamente via API artifact. Copy Settings aggiornata: cancellare
  conversazioni non elimina deliverable.
- **Decisione UI:** gli artifact/deliverable non stanno più sotto Local
  computer: hanno una voce Settings dedicata “Artifacts”. Local computer resta
  per runtime tecnico (Docker, noVNC, sessioni browser).
- **WS2-3.2c locale/verde:** la surface Settings → Artifacts ha filtri
  gruppo/progetto, sorgente (`managed`/`memory`), tipo file e stato
  `memory-linked`/`orphan`; supporta selezione multipla e export ZIP dei file
  selezionati o, se nulla è selezionato, dei file visibili. Backend:
  `POST /api/artifacts/export` crea un bundle ZIP; per artifact memoria rilegge
  il `MemoryRef` canonico e valida root progetto/artifacts prima di leggere il
  file, senza fidarsi di path inviati dal frontend. Test mirati:
  `artifact_zip_entry_names_are_safe_and_unique`,
  `managed_artifact_export_rejects_path_escape`; gateway completo `176 passati,
  1 ignorato`; build desktop verde. Smoke runtime API passato su gateway da HEAD:
  `/api/artifacts/export` ha prodotto `/tmp/homun-artifacts-gate.zip` con entry
  `thread_1782105474_1782105474688595000/brand.json`. Gate in-app/DOM passato:
  Settings → Artifacts mostra `Export ZIP`, filtri Group/Source/Type/Link e 12
  file visibili; click su `Export ZIP (12 visible)` ha scaricato
  `homun-artifacts-2026-06-23.zip`, valido, con managed artifact e
  `memory-workspace_0d46c4470d97422298ece7ee7f0b74c6/artifact-memory-gate-5.md`.
- **WS5.5a locale/verde:** gli artifact registrati nel `MemoryFacade` ora
  materializzano anche provenance graph canonica: entity `project`, entity
  `tool` producer, entity `file` quando esiste `project_relative_path`, e
  relazioni `produced`, `belongs_to_project`, `relates_to` oltre alla relazione
  esistente memoria→artifact. Il vocabolario typed del crate memory riconosce
  anche `rationale_for`, `produced`, `derived_from`. Test:
  `cargo test -p local-first-desktop-gateway artifact_memory_upsert_creates_single_record_and_graph_entity -- --nocapture`
  e `cargo test -p local-first-memory kind_tags_round_trip -- --nocapture` verdi;
  suite complete `cargo test -p local-first-desktop-gateway -- --nocapture`
  (`176 passati, 1 ignorato`), `cargo test -p local-first-memory -- --nocapture`
  e `npm run build` desktop verdi.
  **WS5.5b slice locale/verde:** gli artifact ora collegano decisioni/piano/lavoro
  solo quando c'è evidenza esplicita: `affects_labels` di una memoria `decision`
  che coincide con `name`/`title`/`path_ref`/`project_relative_path` dell'artifact,
  oppure metadata artifact con ref canoniche (`decision_refs`, `plan_refs`,
  `task_refs`, `source_memory_refs`, `derived_from_refs`). In quel caso il grafo
  canonico materializza `decision --affects--> artifact` e
  `artifact --derived_from--> decision/source_ref`, con evidence refs alla decisione/
  source e alla memoria artifact. Nessuna inferenza semantica o store parallelo.
  Test mirati:
  `cargo test -p local-first-desktop-gateway artifact_memory_links_ -- --nocapture`.
  **WS5.6 prima slice locale/verde:** aggiunto un reader/eval headless della
  provenance artifact: una nuova chat che chiede quali artifact esistono e da
  quale decisione/lavoro derivano riceve un blocco `ARTIFACT PROVENANCE FROM
  CANONICAL MEMORY GRAPH` nel recall esplicito e nel RAG automatico. Il reader
  attraversa solo `memories`/`entities`/`relations` canoniche del `MemoryFacade`,
  mostrando producer, path, decisione sorgente, rationale e alternative scartate.
  Test red/green:
  `cargo test -p local-first-desktop-gateway memory_eval_surfaces_artifact_provenance_and_decision_why -- --nocapture`
  (rosso iniziale: nessun contesto provenance). **WS5.6 seconda slice locale/verde:**
  la domanda “a che punto è il workflow e perché?” riceve un blocco
  `WORKFLOW STATUS FROM CANONICAL MEMORY` nel recall/RAG, composto da `goal`,
  `open_loop`, outcome/fact verificati, decisioni con rationale e artifact
  provenance come evidenza. Test red/green:
  `cargo test -p local-first-desktop-gateway memory_eval_surfaces_workflow_status_and_why -- --nocapture`
  (rosso iniziale: nessun contesto workflow). **WS5.6 gate release locale/verde:**
  aggiunto un gate unico nominabile che simula una nuova chat e verifica insieme
  artifact/provenance/decisione e workflow status/perché, inclusi producer
  `make_document`, `DocumentWorkflow`, path gestito, decision rationale,
  alternativa scartata, goal/open-loop e outcome verificato. Comando:
  `cargo test -p local-first-desktop-gateway memory_guardrail_release_gate_covers_artifact_and_workflow_recall -- --nocapture`.
  **WS1-Fase 2 write-back memoria
  locale/verde:** ogni `update_plan` / `step_advance` materializza lo stato del
  piano runtime-owned come unico `open_loop` canonico `source="runtime_plan"` per
  thread; aggiorna in-place, rigenera `stato-lavori.md` come proiezione derivata
  e marca stale il record quando non restano step aperti. Test mirati:
  `cargo test -p local-first-desktop-gateway runtime_plan_memory -- --nocapture`.
  **WS1-Fase 2 grafo piano locale/verde:** lo stesso write-back ora materializza
  nel grafo canonico entity `runtime_plan` e `runtime_plan_step` (come metadata
  su entity `document`/`asset`) e relazioni memoria `describes` piano,
  piano `relates_to` step (`metadata.kind="has_step"`) e step `depends_on` step
  quando il piano porta dipendenze esplicite. Test mirato:
  `runtime_plan_memory_materializes_plan_step_graph`.
  Gate locale allargato: `cargo test -p local-first-desktop-gateway -- --nocapture`
  = 182 passati, 1 ignorato; `cargo test -p local-first-memory -- --nocapture` =
  verde; `npm run build` desktop = verde; `git diff --check` pulito. **Prossimo
  passo unico:** completare verifica allargata della nuova slice grafo piano e
  poi proseguire verso convergenza `ExecutionPlan`/workflow runner dichiarativo,
  senza aprire WS7 prima delle fondamenta.
- **WS6 post-smoke automation guard (2026-06-23):** analisi runtime su
  `~/.homun/task-runtime.sqlite` e `~/.homun/desktop-gateway.sqlite`: il task
  scheduled `autorun_a4bd...@occ@1782194400` era stato registrato come
  `completed`/`ok=1`, ma il thread conteneva solo un messaggio assistant con
  piano 2/4 e testo intermedio ("Sky Sport ha solo il menu..."), senza briefing
  finale né tool run registrati. Root cause: `execute_proactive_prompt_task`
  considerava completata qualsiasi risposta non vuota di `run_agent_turn`.
  Fix locale: `plan_is_complete`/`plan_incomplete_reason` sono il contratto
  condiviso del piano; `agent_output_incomplete_reason` rifiuta fallback "No
  reply generated..." e marker `PLAN` con step aperti, restituendo
  `completed=false`/`blocked_reason` e evento `proactive_prompt_incomplete` per
  il runner scheduled. Test mirati:
  `cargo test -p local-first-desktop-gateway plan_guard -- --nocapture` e
  `cargo test -p local-first-desktop-gateway plan_completion_requires_every_step_done -- --nocapture`.
- **WS1-Fase 2 Slice 3a locale/verde:** prima convergenza verso il contratto
  `ExecutionPlan` del crate `orchestrator` senza introdurre un workflow store
  parallelo: il piano runtime resta compatibile con marker/UI `Vec<Value>`, ma
  il write-back canonico aggiunge `metadata.execution_plan` serializzato come
  `ExecutionPlan` (`route=mixed_workflow`, step con `step_id`, `depends_on`,
  `goal`, `contract=runtime_plan_step`). `update_plan` ora accetta
  `depends_on` espliciti e `merge_plan` li conserva, così la DAG non esiste solo
  nei test costruiti a mano. Test mirati:
  `runtime_plan_memory_projects_execution_plan_contract`,
  `merge_plan_preserves_explicit_dependencies`,
  `runtime_plan_memory_materializes_plan_step_graph`.
- **WS1-Fase 2 Slice 3b locale/verde:** il loop agente usa ora `ExecutionPlan`
  come stato runtime canonico del piano; il vecchio `Vec<Value>` resta solo come
  vista derivata per marker UI, memoria/grafo e verifica step. `merge_execution_plan`
  applica le stesse regole monotone di `merge_plan` e rigenera il contratto
  `ExecutionPlan`; la resume da marker rimane retrocompatibile. Test mirato:
  `merge_execution_plan_is_runtime_canonical_state`.
- **WS1-Fase 3a locale/verde:** primo workflow dichiarativo: `make_deck` ha una
  `WorkflowDefinition` harness-owned (`brand → content → images/deck_json →
  render → register_artifacts`) e viene proiettato in `ExecutionPlan` interno
  con DAG/contratto `DeckWorkflow`. Il modello continua a vedere un solo tool
  `make_deck`; l'orchestrazione resta dell'harness. Test mirato:
  `make_deck_workflow_definition_projects_execution_plan`.
- **WS1-Fase 3c locale/verde:** il contratto `ExecutionPlan` del crate
  `orchestrator` include ora `plan_propose: Option<PlanProposal>` (`summary`,
  `steps`) e lo schema/prompt planner lo accettano come campo top-level
  opzionale quando serve approvazione del piano prima dell'esecuzione. Test:
  `cargo test -p local-first-orchestrator -- --nocapture`.
- **WS1-Fase 3b/F5 locale/verde:** `OrchestratorBrain` espone `run_plan(request,
  execution_plan)`, entrypoint per workflow dichiarativi già costruiti
  dall'harness. Esegue/accoda gli step usando gli stessi provider, policy,
  task-runtime, dipendenze e subagent path dei piani generati dal planner, con
  `planner_rounds=0` e senza roundtrip LLM. Test mirato:
  `brain_runs_static_execution_plan_without_planner_roundtrip`. **WS1-Fase 3d
  locale/verde:** `make_deck` passa la sua `WorkflowDefinition`/`ExecutionPlan`
  attraverso `OrchestratorBrain::run_plan` prima della pipeline deterministica;
  nessun planner LLM e nessuno store workflow parallelo. Test mirato:
  `make_deck_workflow_plan_runs_through_brain_without_planner`.
- **WS1-Fase 6a locale/verde:** quando il loop principale verifica davvero uno
  step `done`, scrive una `fact` confermata nel `MemoryFacade` canonico con
  `source="runtime_plan_step"`, `thread_id`, `step_id`, criterio ed evidenze
  usate dalla verifica. Il piano resta l'unico `open_loop` runtime-owned; la
  `fact` è l'outcome storico recuperabile e viene aggiornata in-place per lo
  stesso step. Test mirato:
  `runtime_plan_step_outcome_writes_confirmed_fact_memory`. **WS1-Fase 6b
  locale/verde:** gli outcome completati dei task `subagent.*` passano dallo
  stesso helper e scrivono `fact` `source="runtime_plan_step"` con `step_id`
  uguale al task id, `done_criterion` dal contratto sub-agent ed evidence redatta
  `source="subagent_task"`. Test mirato:
  `subagent_task_outcome_writes_runtime_plan_step_fact`.
- **WS1-Fase 4 locale/verde:** introdotto router harness-owned
  workflow|agent: richieste deck/presentation/slide/pptx vengono instradate al
  workflow `make_deck` con scaffolding `maximum` e instruction di sistema
  "call `make_deck` exactly once"; le richieste generiche restano nel normale
  agent loop. Test mirati: `workflow_router_sends_deck_requests_to_max_scaffolding_workflow`,
  `workflow_router_keeps_generic_requests_on_agent_loop`.
- **Post-smoke v0.1.1045 locale/verde:** lo smoke deck reale ha evidenziato due
  follow-up: composer ridimensionabile che poteva espandere la chat in modo
  anomalo, e risposte artifact/provenance che non esponevano abbastanza
  `managed_path`, workflow `make_deck` e outcome `runtime_plan_step`. Fix locale:
  il textarea del composer non è più ridimensionabile manualmente; il reader
  provenance include `local managed path`, collega `make_deck` a `DeckWorkflow`
  e lo status workflow include anche fact `source="runtime_plan_step"`. Test
  mirati: `artifact_provenance_context_surfaces_managed_path_and_make_deck_workflow`,
  `memory_eval_surfaces_workflow_status_and_why`; frontend `npm run build` verde.
- **WS1 generalizzazione make_document locale/verde:** aggiunto il primo workflow
  dichiarativo documenti senza store paralleli: `make_document` ha
  `WorkflowDefinition`/`ExecutionPlan` (`DocumentWorkflow`), passa da
  `OrchestratorBrain::run_plan`, viene instradato dal router harness-owned per
  richieste esplicite di scrittura/creazione documenti/report e produce un
  artifact Markdown gestito, registrato in memoria con producer `make_document`.
  Post-smoke runtime: la validazione del piano statico gira via `spawn_blocking`
  (niente drop di runtime Tokio in contesto async), il router workflow pruna il
  toolset anche dopo injection MCP/Composio così il modello non bypassa su shell
  o filesystem, e il tool `make_document` richiede/preserva il nome artifact.
  Gate API passato su `thread_1782222457104_348911810416083`: prompt
  `homun-smoke-document.md` ha usato `make_document`, creato
  `/Users/fabio/.homun/artifacts/thread_1782222457104_348911810416083/homun-smoke-document.md`,
  memoria `artifact|confirmed`, entity artifact e relazione
  `tool:make_document --produced--> artifact`. **Slice PDF locale/verde:** lo
  stesso `make_document` accetta `formats=["md","pdf"]`, genera una sola sorgente
  Markdown e materializza artifact gestiti `.md`/`.pdf`, entrambi registrati in
  memoria/provenance con producer `make_document`. Gate PDF ha esposto un
  guardrail memoria: gli artifact sono esclusi dal dedup semantico distruttivo,
  perché la loro identità è `thread_slug + name/path`, non la descrizione testuale.
  Il reader provenance collega `make_document` a `DocumentWorkflow`.
  `make_research` e `make_meeting` sono volutamente spostati in coda: prima si
  stabilizza il contratto degli strumenti `make_*` su documenti. Test mirati:
  `make_document_workflow`, `workflow_router_sends_document_requests_to_document_workflow`,
  `workflow_router_prunes_alternative_tools_for_document_workflow`,
  `make_document_tool_requires_artifact_name`,
  `make_document_formats_preserve_explicit_pdf_outputs`,
  `artifact_memories_do_not_participate_in_semantic_dedup`,
  `static_workflow_plan_validation_is_async_runtime_safe`,
  `artifact_provenance_context_surfaces_make_document_workflow`.
- **Nuovo caposaldo capability registry (2026-06-23):** niente routing primario
  basato su keyword sparse per i `make_*`. Workflow nativi, MCP, skills/addon,
  connector tools e strumenti atomici devono convergere in un registry unico
  interrogabile; il turno recupera capability candidate, sceglie con decisione
  strutturata e carica nel toolset live solo il minimo necessario. Le keyword
  restano solo prefilter/fallback/guardrail. **Prima slice locale/verde:**
  `make_deck` e `make_document` sono entry di un registry nativo condiviso dal
  router e dal corpus `find_capability`; “Voglio creare un pitch per Homun”
  recupera `make_deck` senza parole `slide`/`pptx`, e quando il registry sceglie
  un workflow il toolset live viene ristretto al solo tool selezionato anche dopo
  lo split core/deferred. Test mirati:
  `workflow_registry_routes_pitch_to_deck_without_slide_keywords`,
  `workflow_registry_contributes_native_workflows_to_capability_corpus`,
  `workflow_router_sends_deck_requests_to_max_scaffolding_workflow`,
  `workflow_router_sends_document_requests_to_document_workflow`,
  `workflow_router_prunes_alternative_tools_for_document_workflow`,
  `workflow_router_keeps_generic_requests_on_agent_loop`. **Seconda slice
  locale/verde:** introdotta `CapabilityRouteDecision` come decisione strutturata
  interna (`Workflow`, `AtomicTool`, `AgentLoop`) con `reason` e alternative; la
  conflict policy PDF distingue creazione deliverable da operazioni atomiche:
  “crea un report PDF” resta `make_document`, mentre “estrai testo/unisci/converti
  PDF” diventa `AtomicTool(pdf_atomic)` e quindi non attiva `make_document`.
  Test mirati:
  `capability_router_explains_native_workflow_selection`,
  `capability_router_keeps_pdf_atomic_operations_out_of_make_document`,
  `capability_router_keeps_report_pdf_as_document_creation_workflow`. **Terza
  slice locale/verde:** il loop agente usa una sola `CapabilityRouteDecision` per
  costruire system prompt, route workflow e trace runtime; la scelta emette un
  evento `ACT` e viene aggiunta a `tool_trace`, quindi entra nel learning/audit
  del turno con il perché. L'istruzione atomica impedisce esplicitamente
  `make_document` per operazioni PDF atomiche. Test mirato:
  `capability_router_atomic_instruction_blocks_deliverable_workflow`. **Quarta
  slice locale/verde:** aggiunto registry nativo degli atomici; `pdf_atomic`
  entra nel corpus `find_capability` ed è mappato a uno schema tool reale
  (`run_in_sandbox`) per operazioni PDF su file esistenti. Quando la route
  atomica viene scelta, `run_in_sandbox` viene caricato nel live toolset insieme
  a `find_capability`, senza esporre `make_document`. Test mirato:
  `native_atomic_registry_maps_pdf_atomic_to_real_tool_schema`. **Prossimo passo
  unico:** aggiungere un atomico PDF dedicato se serve UX più guidata; altrimenti
  proseguire con smoke reale DOCX e design system/template/layout dichiarativi
  condivisi da `make_document` e `make_deck`.
- **Capability registry MCP locale/verde (2026-06-23):** il corpus unico di
  `find_capability` ora include anche tool MCP connessi come entry tipizzate
  `McpTool`, oltre a workflow nativi, atomici, tool deferred e skill. Gli MCP non
  sono più solo schema live/anonimo: quando superano l'always-load cap possono
  essere recuperati dallo stesso registry e attivati con lo stesso meccanismo.
  Test mirato: `mcp_tools_contribute_typed_entries_to_capability_corpus`.
- **Capability registry connector locale/verde (2026-06-23):** i risultati
  Composio/connector recuperati da `find_capability` restano toolkit-aware
  (servono CRUD completi e perimeter read/write), ma non sono più output
  speciale fuori tipo: vengono convertiti in `CapabilityEntry` con source
  `ConnectorTool` e mostrati come `connector «TOOL»: ...`. Test mirato:
  `connector_hits_are_typed_capability_entries`. **Settima slice locale/verde:**
  la ricerca connector stessa ora passa da
  `search_connector_capability_entries`, che restituisce entry typed mantenendo
  il set toolkit-aware; `find_capability` consuma quindi lo stesso contratto per
  native/MCP/connector. Test mirato:
  `connector_search_returns_typed_toolkit_entries`. **Smoke in-app passato
  (2026-06-23):** prompt discovery Gmail unread → risposta con connector Gmail
  scelto; prompt esecuzione “massimo 3 risultati” → lettura reale ultime 3 email
  non lette via Gmail connector. **Ottava slice locale/verde:** `find_capability`
  aggiunge al `tool_trace` una riga `capability discovery ... -> source:key`
  costruita dalle `CapabilityEntry` tipizzate, così la scelta registry entra
  nell'audit/memory extractor senza store paralleli. Test mirato:
  `capability_discovery_trace_records_typed_sources`. **Nona slice
  locale/verde:** anche l'esecuzione di capability connesse viene tracciata come
  `capability execution connector:TOOL` o `capability execution mcp:TOOL`,
  inclusi i read connector come Gmail. Test mirato:
  `connected_capability_execution_trace_records_source`. **Bugfix in-app
  verificato (2026-06-23):** durante lo smoke Gmail la chat duplicava domanda e
  risposta perché il resume marker dello stream veniva letto dalla stessa sessione
  JS e committava un secondo ramo (`local_assistant_*` + `browser_assistant_*`).
  Il marker ora include `ownerId`: se appartiene alla stessa sessione viene
  riattaccato solo per mostrare il live stream senza committare un secondo ramo;
  dopo vero reload resta valido come resume con commit. Verifica: build desktop
  verde + retest utente senza duplicazione; follow-up 2026-06-23 corregge anche
  il cambio-chat durante stream, preservando il reasoning live al ritorno.
- **make_document DOCX locale/verde (2026-06-23):** lo stesso workflow ora
  materializza anche artifact `.docx` editabili dalla sorgente Markdown canonica,
  via pacchetto OOXML minimale generato in-process con `zip` già presente.
  `formats` accetta `md`/`pdf`/`docx`; richieste “Word/editabile/modificabile” o
  file `.docx` selezionano il formato DOCX. Test mirati:
  `make_document_formats_support_editable_docx_outputs`,
  `markdown_to_docx_writes_valid_word_package`,
  `make_document_tool_requires_artifact_name`.
- **make_document struttura/stile locale/verde (2026-06-23):** arricchito lo
  stesso tool, non introdotti nuovi `make_*`: `document_type`, `audience`,
  `tone`, `layout_profile` e `sections` entrano nello schema come parametri
  espliciti e vengono usati nel prompt solo se passati dal modello. Valori fuori
  vocabolario sono ignorati; le sezioni restano ordinate e limitate.
  `layout_profile` accetta `standard`, `one_page`, `executive_brief`,
  `detailed_report`, `proposal` e traduce il profilo in direttive di struttura,
  non in un nuovo workflow. Test mirati:
  `make_document_tool_requires_artifact_name`,
  `make_document_generation_options_are_explicit_and_bounded`.
- **make_document DOCX table rendering locale/verde (2026-06-23):** il renderer
  OOXML minimale ora converte le tabelle pipe Markdown in `<w:tbl>` Word reali
  invece di salvarle come paragrafi grezzi; conserva escaping XML e scarta la
  riga separatore Markdown. Test mirato:
  `markdown_to_docx_renders_pipe_tables`.
- **make_document DOCX formatting smoke fix (2026-06-23):** lo smoke reale ha
  mostrato un DOCX valido ma povero: marker Markdown (`**bold**`, `*italic*`),
  titolo iniziale e liste numerate finivano come testo grezzo. Il renderer OOXML
  ora scrive `styles.xml`, promuove la prima riga a `Heading1`, converte inline
  bold/italic in run Word e riconosce liste numerate come `ListParagraph`. Test
  mirati: `markdown_to_docx_writes_valid_word_package`,
  `markdown_to_docx_promotes_plain_first_line_to_title`.
- **make_document DOCX table sizing smoke fix (2026-06-23):** secondo smoke
  reale: contenuto migliorato, ma le tabelle restavano a larghezza automatica
  con celle `w=0`. Il renderer ora emette tabella full-width (`pct=5000`),
  griglia colonne, layout fixed, padding celle, proporzione 35/65 per tabelle a
  due colonne e header evidenziato. Test mirato:
  `markdown_to_docx_renders_pipe_tables`.
- **Deliverable design profile locale/verde (2026-06-23):** primo contratto
  condiviso del design system WS7: `make_document` e `make_deck` espongono lo
  stesso `design_profile` (`executive`, `sales_pitch`, `technical`, `editorial`,
  `minimal`). Il profilo entra nei workflow args e genera direttive specifiche
  per documento o deck, senza creare template come nuovi tool e senza routing
  keyword-based. Test mirati:
  `deliverable_design_profile_schema_is_shared_by_deck_and_document`,
  `make_document_generation_options_are_explicit_and_bounded`,
  `make_deck_workflow_definition_projects_execution_plan`.
- **Deliverable design components locale/verde (2026-06-23):** seconda base del
  design system condiviso: `make_document` e `make_deck` espongono lo stesso
  array `design_components` (`kpi_grid`, `timeline`, `comparison_table`,
  `quote_callout`, `process_steps`, `risks_table`). I componenti sono deduplicati,
  bounded e tradotti in direttive specifiche per documento/deck; non sono ancora
  layout fisici del renderer né una gallery template completa. Test mirati:
  `deliverable_design_components_schema_is_shared_by_deck_and_document`,
  `make_document_generation_options_are_explicit_and_bounded`,
  `make_deck_workflow_definition_projects_execution_plan`.
- **Deliverable design components → deck layouts locale/verde (2026-06-23):**
  prima materializzazione fisica lato presentazioni: dopo la generazione JSON,
  `make_deck` applica deterministicamente `design_components` agli slide
  intermedi e produce layout già supportati da `deck_render.py` (`kpi`, `quote`,
  `two_column`) senza chiedere al modello di orchestrare layout. Cover/closing
  restano intatti e gli slide trasformati disattivano `want_image` per evitare
  conflitti visivi. Test mirato:
  `deck_design_components_materialize_renderer_supported_layouts`.
- **Deliverable design components → document blocks locale/verde (2026-06-23):**
  prima materializzazione fisica lato documenti: dopo il Markdown del modello,
  `make_document` applica `design_components` usando il contenuto già generato
  come sorgente e aggiunge blocchi Markdown renderizzabili (`Key metrics`,
  `Timeline`, `Comparison`, `Key principle`, `Process steps`, `Risks and
  mitigations`). I blocchi tabellari passano dal renderer DOCX come vere tabelle
  Word, senza template paralleli e senza inventare dati esterni al documento.
  Test mirati: `document_design_components_append_renderable_markdown_blocks`,
  `document_design_components_render_as_docx_tables`.
- **Gate provider Z.ai/GLM risolto (test manuale utente, 2026-06-23):** Settings
  espone sia `Z.ai (GLM)` standard (`https://api.z.ai/api/paas/v4`) sia
  `Z.ai Coding (GLM)` (`https://api.z.ai/api/coding/paas/v4`); il preset coding
  è stato riconfigurato/testato in app e l'errore precedente `400 Bad Request`
  sul primo round con tool non è più attivo.
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
- **WS6 nota finale:** il micro-gate Telegram post-restart è passato; `FC2026`
  resta solo una riga di prova precedente al fix, pending/non inviata, da non
  riusare come prova di regressione.
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
- **WS6.2b runtime-level recovery FATTO (2026-06-22):** stesso gap chiuso anche
  nel crate `task-runtime`: `TaskRuntime::run_ready_once` ora esegue una sweep
  di requeue dei `WaitingResource` prima di chiamare `ready_tasks`. Test
  red/green: `task_runtime_requeues_waiting_resource_before_scheduling` (red:
  `summary.completed` restava 0; green: task bloccato completato dopo rilascio
  risorsa). Verifiche locali: `cargo test -p local-first-task-runtime` verde;
  focused gateway `task_executor_requeues_waiting_resource_before_scheduling`
  verde; `cargo build -p local-first-desktop-gateway` verde; `npm run build`
  desktop verde; `git diff --check` pulito.
- **WS6.2c visibility API FATTO (2026-06-22):** la risposta task queue espone
  pressione risorse per classe: `units`, `limit_units`, `available_units`,
  `saturated`. I limiti usati dal payload sono gli stessi del worker
  (`ResourceLimits::conservative_defaults()` + override dinamico
  `active_llm_concurrency()` per `llm_inference`). Test red/green:
  `task_queue_response_serializes_ui_read_model_for_renderer` (red: campi assenti;
  green: `llm_inference` con used=1, limit=4, available=3, non saturo). Verifiche:
  `cargo test -p local-first-desktop-gateway` = **162 passati, 1 ignorato**;
  `cargo test -p local-first-task-runtime` verde; `cargo build -p
  local-first-desktop-gateway` verde; `npm run build` desktop verde;
  `git diff --check` pulito.
- **WS6.2d stress gate headless FATTO (2026-06-22):** aggiunto un gate
  multi-worker realistico su SQLite condiviso: due connessioni `TaskStore`
  separate simulano owner/worker diversi, limite `llm_inference=1`, un task
  occupa la risorsa e il secondo va in `WaitingResource`; dopo rilascio della
  reservation, un tick successivo del `TaskRuntime` separato reidrata e completa
  il task bloccato. Test:
  `task_runtime_recovers_resource_wait_across_worker_connections`.
  Verifiche fresche: `cargo test -p local-first-task-runtime` verde;
  `cargo test -p local-first-desktop-gateway` = **162 passati, 1 ignorato**;
  `cargo build -p local-first-desktop-gateway` verde; `npm run build` desktop
  verde; `git diff --check` pulito.
- **WS6.3a runtime recurrence materialization FATTO (2026-06-22):** test
  red/green aggiunto:
  `task_runtime_materializes_next_recurrence_after_completion`. Red confermato:
  `TaskRuntime::run_ready_once` completava il task ricorrente ma non inseriva
  `daily@occ@...`; il gateway lo faceva già nel proprio worker. Fix locale:
  dopo `Completed`, `TaskRuntime` chiama `TaskScheduler::next_recurrence` e
  inserisce l'occorrenza successiva nello stesso store. Verifiche:
  `cargo test -p local-first-task-runtime` verde; `cargo test -p
  local-first-desktop-gateway` = **162 passati, 1 ignorato**; `cargo build -p
  local-first-desktop-gateway` verde; `npm run build` desktop verde;
  `git diff --check` pulito.
- **WS6.3b failure/retry recurrence parity FATTO (2026-06-22):** test
  red/green aggiunto:
  `task_runtime_materializes_next_recurrence_after_terminal_failure`. Red
  confermato: un task ricorrente con `max_attempts=1` andava `Failed` ma non
  inseriva la prossima `daily@occ@...`, mentre il gateway già lo fa nel path
  `handle_failed_task_run`. Fix locale: `TaskRuntime` usa
  `record_failure_and_insert_next_if_terminal`; dopo `RetryableFailure` o errore
  executor ricarica il task, e se è `Failed` inserisce la prossima occorrenza.
  Verifiche: `cargo test -p local-first-task-runtime` verde; `cargo test -p
  local-first-desktop-gateway` = **162 passati, 1 ignorato**; `cargo build -p
  local-first-desktop-gateway` verde; `npm run build` desktop verde;
  `git diff --check` pulito.
- **WS6.3c scheduled/proactive prompt gate FATTO (2026-06-22):** gate headless
  sul contratto usato dall'app: `materialize_automation_task` crea un task
  visibile `proactive_prompt` con `automation_id`, recurrence, `not_before`,
  retry policy 3x/120s e policy approval; le occorrenze `autorun_x@occ@...`
  riusano un solo thread `channel_scheduled_autorun_x`. Test:
  `scheduled_automation_materializes_visible_proactive_task` e
  `scheduled_occurrences_reuse_one_visible_thread`.
- **WS6.3d proactive review surface/dedup FATTO (2026-06-22):** superficie card
  coperta dai test esistenti: parse decline/card/action/choices, dedup fuzzy
  anti-parafrasi e read model suggestions. Test rilevanti:
  `proactive_parse_declines_cleanly`, `proactive_parse_builds_card`,
  `proactive_parse_extracts_choices`, `proactive_fuzzy_dedup_blocks_paraphrases`,
  `suggestions_dedup_list_and_act`.
- **WS6.4 proactive memory write-back FATTO (2026-06-22):** `suggestion_act`
  ora scrive anche in memoria: `accepted` e `snoozed` diventano `open_loop`,
  `dismissed` diventa `decision`, con metadata della card/dedup/proposed_action.
  La memoria viene auto-confermata nello scope della card, così una chat futura
  vede loop aperti o decisioni prese dalle azioni proattive. Test:
  `proactive_action_memory_writeback_maps_statuses` e
  `suggestion_lookup_preserves_durable_dedup_key`.
- **Gate finale locale WS6 (2026-06-22):** `cargo test -p
  local-first-task-runtime` verde; `cargo test -p local-first-desktop-gateway`
  = **166 passati, 1 ignorato**; `cargo build -p local-first-desktop-gateway`
  verde; `npm run build` desktop verde; `git diff --check` pulito.
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
- **Coda aggiornata:** WS2-3.2b/3.3 (schermata/lifecycle artefatti) ·
  WS5.5/5.6 (provenienza + eval
  memoria) · WS1-Fase 2/3 (piano/workflow runner) · WS7 per ultimo nel blocco
  prodotto, quando memoria e deliverable lifecycle sono solidi.
- **WS5.4b locale/verde:** `/api/memory/wiki` proietta `stato-lavori.md` dagli
  `open_loop`, con ref sorgenti e dedup parafrasi nella pagina; il re-ingest wiki
  è generico per pagine memoria. Test focalizzato `status_wiki` verde.
- **WS5.4c locale/verde:** gli `open_loop` parafrasati vengono superseduti nello
  store via `MemoryFacade::merge_memories`; briefing e `stato-lavori.md`
  filtrano `superseded_by`. La chiusura avviene con evidenza esplicita:
  l'estrattore emette `metadata.closes_open_loop`, il runtime verifica overlap
  con un loop attivo e marca quel loop `Stale`.
- **WS2-3.1 chiusa:** i produttori artifact principali registrano ogni
  artifact surfaced nel `MemoryFacade` come `memory_type="artifact"` + entity
  grafo `artifact`, con metadata path/thread/tipo/dimensione e backfill embedding
  immediato. Test mirato `artifact_memory_upsert_creates_single_record_and_graph_entity`
  verde. **Gate in-app 2026-06-22 inizialmente fallito:** prompt "crea un artifact
  artifact-memory-gate.md..." ha usato `write_file`, quindi ha creato un semplice
  file di progetto e solo un episodio in memoria, non `memory_type="artifact"`.
  **Fix locale:** anche `write_file` registra il file di progetto come artifact
  memoria/entity con embedding. **Gate 2 fallito:** il tool effettivo era
  `mcp__filesystem__create` workspace-scoped, non `write_file` (prova:
  `tool_runs` righe 53/54). **Fix locale successivo:** anche le scritture
  `mcp__filesystem__create|insert|write|write_file` dentro root progetto
  registrano artifact memoria/entity con embedding. **Gate 3 fallito:** il filtro
  cercava provider `filesystem`, ma `parse_mcp_chat_name` produce `mcp:filesystem`;
  il tool ha scritto il file ma il write-back artifact è stato saltato. **Fix
  locale successivo:** normalizzato il provider `mcp:*` e aggiunto test
  `mcp_filesystem_artifact_detection_accepts_namespaced_provider`. **Gate
  runtime PASSATO dopo restart gateway:** `artifact-memory-gate-5.md` creato via
  `mcp__filesystem__create`; prove in filesystem, `tool_runs`, `memories`,
  `entities` e `memory_embeddings`; recall esplicito include il file. Il pannello
  Artifacts è ancora vuoto perché oggi legge solo artifact surfaced/chat-managed:
  diventa il lavoro di WS2-3.2.
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
