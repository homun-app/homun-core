# Homun roadmap operativa

## Obiettivo attivo

Consolidamento memoria + artefatti completato abbastanza da riprendere
l'espansione deliverable con un vincolo nuovo: Homun deve arrivare a documenti e
presentazioni di qualità alta tramite un **design system dichiarativo condiviso**
per temi, layout, componenti, template e QA visuale. Non si aggiungono gallery o
`make_*` isolati: `make_document`, `make_deck`/presentation e i futuri plugin
consumano la stessa grammatica dal registry unico.

## Fase corrente

WS6 è chiusa localmente; WS2-3.1 è passata in runtime, WS2-3.2c/3.3 ha un
primo percorso locale verde e WS5 è chiusa localmente/gate:

1. WS6.1 — approval resume, Path B workspace-scoped Filesystem, Telegram UX.
2. WS6.2 — Resource Governor: recovery, visibility, stress gate.
3. WS6.3 — scheduler/ricorrenza + proactive review: recurrence parity,
   scheduled/proactive prompt thread, card surface/dedup.
4. WS6.4 — write-back delle azioni proattive in memoria (`open_loop`/`decision`).
   Post-smoke scheduled automation: la gestione condivisa del piano considera
   completo solo `done == total`, quindi una risposta con solo piano intermedio
   non viene più marcata come completata.
5. WS2-3.1 — artifact come `memory_type="artifact"` + entity grafo + embedding,
   inclusi file in-place scritti via Filesystem MCP dentro root progetto.
6. WS2-3.2a — il Workbench Artifacts legge anche gli artifact memoria e mostra
   i file di progetto con preview jailata via `fsFile`.
7. WS2-3.2b/3.3 — Settings riceve anche gli artifact memoria da
   `/api/artifacts/usage`; delete chat non cancella deliverable; delete esplicito
   memoria rimuove file in root autorizzate e tombstona memoria/entity. Gate
   in-app Settings passato con artifact usa-e-getta; chat delete preserva file.
   La surface è dedicata “Artifacts”, non più dentro Local computer.
8. WS2-3.2c — Settings → Artifacts ha filtri gruppo/progetto, sorgente, tipo e
   stato `memory-linked`/`orphan`, selezione multipla ed export ZIP via
   `POST /api/artifacts/export`. Il backend rilegge i `MemoryRef` canonici per
   gli artifact memoria e valida le root autorizzate prima di includerli nel
   bundle. Smoke API e click-download in-app passati con ZIP valido che include
   sia artifact managed sia artifact memoria.
9. WS5.5a — gli artifact memoria ora materializzano provenance graph canonica:
   producer tool `produced` artifact, artifact `belongs_to_project` progetto e,
   per file in root progetto, artifact `relates_to` file. Il vocabolario memory
   include anche `rationale_for`, `produced`, `derived_from`.
10. WS5.5b — prima slice evidence-only: decisioni con `affects_labels` espliciti
    o metadata artifact con ref canoniche (`decision_refs`, `plan_refs`,
    `task_refs`, `source_memory_refs`, `derived_from_refs`) creano archi
    `affects` / `derived_from` nel grafo canonico. Nessun matching semantico o
    store parallelo.
11. WS5.6 — prima slice eval/reader: recall esplicito e RAG automatico leggono la
    provenance artifact dal grafo canonico e possono rispondere quali artifact
    esistono e da quale decisione/lavoro derivano, includendo il perché.
12. WS5.6 — seconda slice eval/reader: recall esplicito e RAG automatico leggono
    `goal`, `open_loop`, outcome/fact verificati, decisioni con rationale e
    artifact provenance per rispondere “a che punto siamo?” e “perché?”.
13. WS5.6 — gate release memoria: un test unico pre-release verifica in una
    nuova chat simulata artifact/provenance/decisione e workflow status/perché,
    inclusi producer/workflow, path gestito, rationale, alternative scartate,
    goal/open-loop e outcome verificato. WS5.1a ha avviato anche l'audit
    read-model graph-like: `contact_relationships` resta read-model UX ma viene
    mirrorato nel grafo canonico quando entrambi i contatti hanno `entity_ref`
    esplicito; la rimozione tombstona il ref canonico.
14. WS5.1b — chiusura audit read-model: `ChatStore` espone un boundary audit
    testato per ogni tabella locale; nuove tabelle non classificate falliscono
    il gate e devono dichiarare UX/ops-only oppure convergenza nel
    `MemoryFacade`. WS5 resta chiusa salvo smoke in-app pre-release.
15. WS1-Fase 2 — prima slice piano→memoria: ogni `update_plan` / `step_advance`
    aggiorna un solo `open_loop` canonico `source="runtime_plan"` per thread,
    con prossimo step e conteggi; a completamento il record viene marcato stale e
    `stato-lavori.md` è rigenerato come vista derivata.
16. WS1-Fase 2 — grafo piano/step: lo stesso write-back materializza entity piano
    e step nel grafo canonico, con relazioni `describes`, `relates_to`/`has_step`
    e `depends_on` quando esplicito.
17. WS1-Fase 2 Slice 3a — il write-back canonico del piano include anche
    `metadata.execution_plan` nel contratto `ExecutionPlan` del crate
    `orchestrator`; `update_plan` conserva `depends_on` espliciti dal flusso
    reale. Resta da promuovere `ExecutionPlan` a stato runtime primario.
18. WS1-Fase 2 Slice 3b — il loop agente usa `ExecutionPlan` come stato runtime
    canonico; lo snapshot `Vec<Value>` resta solo vista derivata per marker UI,
    memoria/grafo e verifica step. Il merge progressivo preserva route,
    `plan_propose`, provider/tool, execution policy e contratto degli step
    workflow/capability invece di ricostruirli come `DirectAnswer`.
19. WS1-Fase 3a — `make_deck` ha una `WorkflowDefinition` harness-owned
    proiettata in `ExecutionPlan` con DAG e contratto `DeckWorkflow`; il modello
    continua a vedere un solo tool.
20. WS1-Fase 3c — `ExecutionPlan` include `plan_propose` come contratto
    strutturato per piani da approvare prima dell'esecuzione.
21. WS1-Fase 3b/F5 — `OrchestratorBrain::run_plan` esegue workflow
    dichiarativi già costruiti dall'harness usando gli stessi provider,
    task-runtime, dipendenze e subagent path dei piani planner-generated.
22. WS1-Fase 6a — il loop principale scrive outcome per-step come `fact`
    confermate `source="runtime_plan_step"` nel `MemoryFacade` canonico, con
    criterio ed evidenze della verifica; il piano resta l'unico `open_loop`.
23. WS1-Fase 6b — gli outcome completati dei task `subagent.*` riusano lo
    stesso write-back per-step, con evidence redatta `source="subagent_task"`.
24. WS1-Fase 3d — `make_deck` passa la propria `WorkflowDefinition` /
    `ExecutionPlan` attraverso `OrchestratorBrain::run_plan` prima della
    pipeline deterministica, senza planner LLM e senza store parallelo.
25. WS1-Fase 4 — router workflow|agent harness-owned: deck/presentation/slide/pptx
    vanno a `make_deck` con scaffolding `maximum`; richieste generiche restano
    nel loop agente.
26. Post-smoke v0.1.1045 — fix locale su due regressioni osservate nello smoke
    deck reale: il composer non è più ridimensionabile manualmente fino a
    espandere la chat, e il recall artifact/provenance ora espone `managed_path`,
    workflow `make_deck`/`DeckWorkflow` e outcome `runtime_plan_step`.
27. WS1 generalizzazione deliverable — `make_document` ha ora una
    `WorkflowDefinition` harness-owned (`DocumentWorkflow`) proiettata in
    `ExecutionPlan`, passa da `OrchestratorBrain::run_plan`, viene instradato dal
    router workflow|agent per richieste esplicite di scrittura documenti/report e
    registra l'artifact Markdown in memoria con provenance canonica. Post-smoke:
    il percorso è async-safe nel runtime Tokio, il toolset viene ristretto al
    workflow anche dopo MCP/Composio injection e il nome artifact esplicito viene
    preservato (`homun-smoke-document.md`).
28. WS1/WS7 document focus — `make_document` viene arricchito prima di creare
    altri strumenti: supporta formati `md`/`pdf` dallo stesso Markdown canonico e
    registra ogni artifact prodotto in memoria/provenance con producer
    `make_document`. `make_research` e `make_meeting` sono spostati alla fine.
29. WS1-Fase 4b — nuova visione capability registry: i workflow `make_*` non
    devono più vivere come keyword sparse o tool sempre esposti. Workflow nativi,
    MCP, skills/addon, connector tools e strumenti atomici entrano in un registry
    unico interrogabile; il router recupera candidati semanticamente, sceglie con
    decisione strutturata e carica nel toolset live solo le capability minime.
30. WS1-Fase 4b prima slice — `make_deck` e `make_document` sono ora entry di un
    registry nativo condiviso da router e `find_capability`: “pitch per Homun”
    recupera `make_deck` senza keyword `slide`/`pptx`, i `make_*` non vengono
    duplicati nel corpus deferred, e il workflow scelto resta nel live toolset
    anche dopo lo split core/deferred.
31. WS1-Fase 4b seconda slice — il router produce una decisione strutturata
    interna (`Workflow`/`AtomicTool`/`AgentLoop`) con ragione e alternative. Prima
    conflict policy: creazione report PDF usa `make_document`; estrazione,
    unione o conversione PDF restano operazioni atomiche e non attivano
    `make_document`.
32. WS1-Fase 4b terza slice — il loop agente usa la stessa decisione strutturata
    per system prompt, route workflow e trace runtime: la scelta viene emessa come
    `ACT` e aggiunta a `tool_trace`, quindi resta auditabile e disponibile al
    learning post-turn senza store paralleli.
33. WS1-Fase 4b quarta slice — `pdf_atomic` è una capability atomica nativa nel
    registry/corpus e mappa a un tool reale (`run_in_sandbox`) per operazioni su
    PDF esistenti; la route atomica carica quel tool nel live toolset e non
    attiva `make_document`.
34. WS1-Fase 4b quinta slice — i tool MCP connessi entrano nel corpus unico
    `find_capability` come `McpTool` tipizzati, con schema attivabile nello
    stesso live toolset; quando non sono always-loaded non vivono più in un ramo
    parallelo fuori registry.
35. WS1-Fase 4b sesta slice — i tool Composio/connector recuperati da
    `find_capability` restano toolkit-aware ma vengono convertiti in
    `CapabilityEntry` source `ConnectorTool`; anche questa sorgente ora parla il
    contratto typed del registry invece di emettere righe speciali fuori tipo.
36. WS1-Fase 4b settima slice — la ricerca connector usa
    `search_connector_capability_entries` e restituisce direttamente entry
    `ConnectorTool` typed, mantenendo il set toolkit-aware; `find_capability`
    consuma lo stesso shape per native/MCP/connector. Smoke in-app passato:
    discovery Gmail unread + lettura reale ultime 3 email non lette.
37. WS1-Fase 4b ottava slice — `find_capability` aggiunge al `tool_trace` una
    riga `capability discovery ... -> source:key` derivata dalle `CapabilityEntry`
    tipizzate; la scelta registry entra nell'audit/learning del turno senza store
    paralleli.
38. WS1-Fase 4b nona slice — l'esecuzione di capability connesse entra nel
    `tool_trace` come `capability execution connector:TOOL` o
    `capability execution mcp:TOOL`, inclusi read connector come Gmail.
39. WS1 floor ovunque — le emissioni di orchestrazione hanno contratti chiusi:
    planner `ExecutionPlan` con schema chiuso, `update_plan`/`step_advance`
    strict-compatible, judge verifica step/bootstrap con JSON schema strict e UI
    che non accetta marker `PLAN_PROPOSE`/`GOAL_PROPOSE` tronchi come card
    azionabili.
40. Runtime chat bugfix — lo stream resume marker ora porta un `ownerId`: la
    stessa sessione JS non può auto-resumare e duplicare user/assistant, mentre il
    resume dopo vero reload resta disponibile. Gate in-app Gmail passato.
41. WS1/WS7 document focus — `make_document` ora materializza anche `.docx`
    editabile dalla stessa sorgente Markdown canonica, oltre a `md`/`pdf`, con
    package OOXML generato in-process e registrazione artifact/memoria invariata.
42. WS1/WS7 document focus — `make_document` ora accetta struttura/stile
    espliciti (`document_type`, `audience`, `tone`, `sections`) nello stesso
    schema tool; il workflow li usa come contratto di generazione solo se
    dichiarati, senza attivazioni euristiche o nuovi registry paralleli.
43. WS1/WS7 document focus — il renderer DOCX di `make_document` traduce le
    tabelle pipe Markdown in tabelle Word reali (`w:tbl`) con escaping XML,
    mantenendo sorgente Markdown canonica e registrazione artifact invariata.
44. WS1/WS7 document focus — feedback smoke reale DOCX: il file era valido ma
    troppo grezzo. Il renderer ora include `styles.xml`, converte bold/italic
    Markdown in run Word, promuove il primo titolo e gestisce liste numerate.
45. WS1/WS7 document focus — secondo feedback smoke DOCX: tabelle leggibili ma
    non adattate alla pagina. Il renderer ora emette tabelle full-width con
    `tblGrid`, layout fixed, celle percentuali, padding e proporzione 35/65 per
    tabelle a due colonne.
46. WS1/WS7 document focus — `make_document` ha un `layout_profile` dichiarativo
    nello stesso schema tool (`standard`, `one_page`, `executive_brief`,
    `detailed_report`, `proposal`); il profilo diventa direttiva di generazione
    esplicita, non un nuovo workflow e non una euristica di routing.
47. WS7 direction — deliverable design system condiviso: documenti e
    presentazioni/plugin convergono su temi, layout, componenti, template e QA
    visuale comuni. Il modello sceglie struttura e blocchi dal registry; renderer
    deterministici producono `.docx`, `.pptx`, `.pdf`/HTML. Una gallery può
    esistere come UI/catalogo sopra questa grammatica, non come secondo sistema.
48. WS7 first shared design contract — `make_document` e `make_deck` espongono lo
    stesso `design_profile` dichiarativo (`executive`, `sales_pitch`,
    `technical`, `editorial`, `minimal`), lo portano nel workflow e lo traducono
    in direttive specifiche per documento o deck. È il primo pezzo di grammatica
    condivisa; non è ancora template library completa né QA visuale.
49. WS7 shared component contract — `make_document` e `make_deck` espongono anche
    `design_components` condiviso (`kpi_grid`, `timeline`, `comparison_table`,
    `quote_callout`, `process_steps`, `risks_table`), deduplicato e bounded. È
    ancora composer contract: i layout fisici del renderer e la gallery template
    arrivano dopo.
50. WS7 deck component materialization — in `make_deck`, i componenti dichiarativi
    ora vengono applicati deterministicamente al deck JSON prima del render:
    `kpi_grid` usa layout `kpi`, `quote_callout` usa `quote`, gli altri componenti
    usano `two_column`, tutti già supportati da `deck_render.py`. Non ancora
    esteso al renderer DOCX e non ancora gallery/template library.
51. WS7 document component materialization — in `make_document`, gli stessi
    componenti dichiarativi ora vengono applicati al Markdown prima degli artifact:
    sezioni/tabelle sono derivate dal contenuto generato e diventano vere tabelle
    DOCX quando il formato richiesto è Word. Resta da fare QA visuale e template
    library completa.
52. WS7 shared template contract — `make_document` e `make_deck` espongono anche
    `design_template` condiviso (`startup_pitch`, `executive_update`,
    `project_plan`, `technical_brief`, `sales_proposal`). Il template espande in
    default `design_profile` + `design_components`, ma gli argomenti espliciti
    restano sovrani; il workflow registra il template scelto e i prompt ricevono
    una direttiva medium-specific. Non è ancora la gallery visuale completa; i
    theme token e il primo floor QA arrivano nella slice successiva.
53. WS7 shared theme tokens + QA floor — `make_document` e `make_deck`
    espongono `design_theme` condiviso (`clean_corporate`, `high_contrast`,
    `warm_editorial`, `minimal_mono`, `soft_gradient`). Lato deck il tema viene
    materializzato in token renderer-compatible prima del render; il workflow
    applica anche un primo guardrail QA deterministico che rileva e corregge
    titoli/bullet troppo lunghi. Il primo floor era testuale; la slice seguente
    porta la verifica sull'HTML renderizzato.
54. WS7 rendered deck QA — il contained computer include `deck-qa`, comando
    dependency-free che apre `deck.html` con Chromium headless e misura layout
    reale via DevTools Protocol. `make_deck` e `render_deck` lo eseguono dopo il
    render e prima della registrazione artifact/memoria: overflow slide, elementi
    fuori bounds o immagini non caricate bloccano la consegna come deck
    completato. Restano da estendere contrasto/leggibilità, screenshot/PDF più
    profondi e QA documenti.
55. WS7 template catalog provider — primo catalogo read-only seed `monet/*`
    dentro il registry unico: entry cercabili da capability discovery ma non
    callable, `template_ref` nello schema di `make_deck`/`make_document`, e
    risoluzione gateway verso `design_template`, `design_theme`,
    `design_profile` e `design_components` già supportati. Monet è catalogo/
    adapter di template, non secondo renderer/store e non un nuovo `make_*`.
56. WS7 template provider contract — il seed `monet/*` è ora dietro a un
    `TemplateCatalogProvider` interno e a un collector multi-provider deduplicato.
    Questo è il punto di aggancio per MCP Monet, marketplace Homun o template
    pack firmati: tutti pubblicano `template_ref` nel registry unico, mentre i
    workflow esistenti continuano a renderizzare.
57. WS7 file template catalog — aggiunto `FileTemplateCatalogProvider`: manifest
    JSON locali caricabili da `HOMUN_TEMPLATE_CATALOG_PATH` o
    `~/.homun/template-catalog.json`, validati contro il vocabolario `design_*`.
    I file catalog estendono il registry ma non sovrascrivono i seed built-in.
58. WS7 deck legibility QA — `deck-qa` ora misura anche font-size e contrasto
    sul DOM renderizzato. `text_too_small` e `low_contrast` entrano nel
    `DECK_QA_JSON` e bloccano consegna/registrazione del deck.
59. WS7 document Markdown QA — `make_document` valida il Markdown prima della
    scrittura degli artifact `.md`/`.pdf`/`.docx`: linee troppo lunghe, token
    non spezzabili e tabelle pipe con numero celle incoerente bloccano la
    consegna fragile con errore QA deterministico.
60. WS7 expanded Monet seed catalog — il catalogo built-in `monet/*` copre ora
    11 template PMI: pitch, executive update, project plan, sales proposal,
    technical brief, one-pager, case study, meeting minutes, launch plan,
    incident review e product roadmap. Sono ancora capability di catalogo non
    callable, risolte nei token `design_*` già supportati.
61. WS7 template manifest metadata — i manifest JSON esterni possono includere
    `tags`, `preview_ref`, `source_ref` e `license`, con riferimenti sanificati
    prima dell'indicizzazione. Questo prepara gallery/cataloghi visuali senza
    introdurre un secondo sistema di template o nuovi tool callable.
62. WS7 template catalog API — il registry template è esposto read-only da
    `/api/templates/catalog` e dal bridge desktop `coreBridge.templateCatalog()`.
    La UI può costruire una gallery partendo dalla stessa fonte del routing,
    senza duplicare cataloghi o trasformare template in tool.
63. WS7 first template gallery — il plugin Presentations mostra una gallery
    filtrabile alimentata da `coreBridge.templateCatalog()`, con metadati
    `design_*` e copia del `template_ref`. È una superficie di selezione, non un
    router euristico e non un catalogo duplicato; finché non esistono asset
    `preview_ref` reali, mostra il contratto/layout invece di finte preview
    grafiche.
64. WS7 workflow guardrail — durante una route workflow one-call il gateway
    blocca tool fallback non ammessi (shell/filesystem/MCP create) invece di
    permettere al modello di aggirare `make_deck`/`make_document` dopo un errore
    provider. Se il provider non risponde, il workflow si ferma e chiede una
    binding/provider raggiungibile.
65. Runtime chat activity guard — gli stream chat marcano `finished` quando il
    gateway emette `done/error`, non solo dopo il cleanup post-turn; gli stream
    senza eventi recenti vengono esclusi dal segnale sidebar per evitare pallini
    working infiniti dopo cambio chat. I resume marker frontend hanno TTL e i
    marker legacy senza timestamp vengono scartati; il riattach nella stessa
    sessione ripristina solo la preview live, senza secondo commit. Il dock
    Computer è filtrato per `thread_id`, resta visibile solo durante attività
    browser/terminal running; il pannello inline Computer legacy non viene più
    riaperto da timeline/artifact già completati. Il rendering streaming riusa il
    parser finale per plan/progress/markdown progressivi.
66. WS4 UI perf guard — il contratto UI verifica che il pannello Computer inline
    non torni a dipendere da timeline/artifact completati e il dock live riduce
    il polling quando idle (2500ms), mantenendolo veloce durante attività
    browser/terminal (600ms).
67. WS8 eval document flow — `scripts/eval_suite.py` copre anche output documento
    strutturato con `docx` obbligatorio, base URL configurabile via
    `HOMUN_EVAL_BASE` e progress flush; smoke `gemma4:latest 1` verde.
68. WS4 markdown render perf — `RichMessage` e il renderer markdown lazy sono
    memoizzati per evitare rerender dei messaggi completati invariati quando
    cambiano polling, dock live o stato laterale.
69. Provider settings robustness — le card provider matchano prima per id stabile
    e solo poi per endpoint, preservando preset Z.ai standard/coding separati
    anche con configurazioni legacy o cambi URL.
70. Artifact location UX — i marker dei workflow managed includono `managed_path`
    e le card chat mostrano il path compatto del deliverable, riducendo la
    confusione su dove siano stati creati i file.
71. Computer owner hardening — attività live browser/terminal senza `thread_id`
    esplicito non vengono più mostrate in tutte le chat; il null owner è ammesso
    solo da idle.
72. WS7 built-in template previews — i seed locali `monet/*` dichiarano
    `preview_ref` `builtin:template-preview/*`; la gallery Presentations
    materializza una preview compatta dai token del catalogo (`design_theme`,
    layout archetype, componenti) invece di scegliere da sole card testuali. I
    cataloghi esterni senza `preview_ref` restano sul fallback contract-only; il
    registry rimane la fonte unica e i template non diventano tool callable.
73. WS8 gateway contract eval — `scripts/eval_suite.py` può ora, se configurato
    con `HOMUN_EVAL_GATEWAY_BASE` e token, verificare anche il gateway reale:
    `/api/templates/catalog` deve esporre template non-callable con preview
    built-in, e `/api/capabilities/snapshot` deve restare uno snapshot valido.
    È il primo strato HTTP del gate; il render end-to-end resta da aggiungere.
74. WS4 default skill seeder hardening — il seeder delle skill bundled hasha ora
    l'intero tree (`SKILL.md`, script, asset), non solo il manifest. Gli update
    bundled arrivano su copie ancora stock; le skill davvero modificate
    dall'utente restano protette perché il tree su disco diverge dal record
    seeded.
75. WS4 image role UX — Settings → Model per task segnala quando
    `image_generation` non ha modelli immagine disponibili. Il deck workflow può
    degradare senza immagini, ma l'utente vede prima che serve un provider
    image-capable o un refresh catalogo.
76. WS4 deck image prompt mitigation — il workflow deck non invia più al modello
    immagine il titolo slide esatto/quotato. Usa keyword tematiche e un vincolo
    esplicito contro tipografia leggibile, riducendo il rischio di testo
    storpiato nelle immagini generate.
77. WS8 pre-release base gate — `scripts/pre_release_gate.py` rende ripetibile il
    gate locale prima di tag/build: capabilities, gateway test completo, UI
    contract, build desktop e syntax check eval. Gli eval modello/gateway si
    agganciano via env, senza rendere fragile il gate deterministico.
78. WS8 memory eval closure — il requisito "nuova chat: stato + perché" è coperto
    dai gate WS5.6 (`memory_eval_*` e release gate memoria): artifact provenance,
    decision why e workflow status/why emergono dalla memoria canonica.
79. WS9 plugin manifest contract — `PluginManifest` nel crate capabilities ora
    porta i metadati distributivi necessari al marketplace: channel, compatibilità
    Homun minima, entitlement, firma opzionale e capability dichiarate. I manifest
    legacy restano validi come stable/free.
80. WS9 plugin registry index contract — `PluginRegistryIndex` definisce il feed
    JSON marketplace separato dai manifest installati: entry con URL manifest e
    package, digest SHA-256, firma, channel, compatibilità ed entitlement. È il
    contratto per sito/install manager; non scarica ancora pacchetti.
81. WS9 package integrity policy — le entry registry validano forma del digest
    `sha256`, algoritmo firma `ed25519` e confronto SHA-256 sui byte pacchetto.
    La verifica Ed25519 e il gate install-candidate coprono canale beta,
    compatibilità Homun, allowlist chiavi trusted, digest e firma; restano
    enforcement install/update e scan contenuto pacchetto.
82. WS9 install/update policy — le entry registry ora espongono regole
    deterministiche per disponibilità canale (`stable` sempre, `beta` solo con
    opt-in), compatibilità minima Homun e confronto versioni semver. Il manager
    in-app deve ancora usare queste regole per fetch/install/update reali.
83. WS9 `.hplugin` package manifest — il pacchetto plugin ha un manifest interno
    dichiarativo (`PluginPackageManifest`) con file, digest e manifest path; la
    validazione rifiuta pacchetti vuoti, digest non SHA-256 e path assoluti o
    traversal. Il gateway ora ispeziona gli archive in memoria, verifica i digest
    dei file dichiarati, prepara i blob per `skill_security` e può scrivere in
    staging solo i file dichiarati, bloccando pacchetti critici. Restano
    endpoint/manager e attivazione atomica nel registry locale.
84. WS9 ADR distribuzione/licensing — ADR 0017 formalizza registry hosted sul
    sito Homun, verifica locale deterministica, beta opt-in, paid predisposto con
    token offline e pagamento/cloud rinviati.
85. WS9 licensing offline contract — `PluginLicenseClaims` /
    `PluginLicenseToken` verificano offline firma Ed25519, plugin target e
    scadenza. Il gateway persiste token verificati in
    `~/.homun/plugins/licenses.json` tramite `GET/PUT /api/plugins/licenses` e
    rifiuta token scaduti/non coerenti prima della scrittura. Restano re-check
    manager e account/payment cloud.
86. WS9 install manager locale — il gateway installa `.hplugin` solo dopo
    verifica registry/signature/digest, staging sicuro, controllo
    `plugin_id/version` e rename atomico. Endpoint locale
    `/api/plugins/packages/install-local` disponibile per pacchetti già
    scaricati, con registry installati `~/.homun/plugins/installed.json`
    aggiornato atomicamente e letto da `/api/plugins/packages/installed`.
    `install-from-registry` scarica anche `package_url` HTTPS e riusa lo stesso
    percorso verificato. Settings -> Addons mostra cache marketplace e
    pacchetti installati, e puo' scaricare un registry HTTPS tramite backend.
    Il trust store locale `~/.homun/plugins/trusted-keys.json` consente di
    fidare signer Ed25519, attivare opt-in beta esplicito e installare package
    firmati dalla UI. `/api/plugins/packages/updates` rileva candidati piu'
    nuovi dalla cache registry e Settings -> Addons li segnala. `POST
    /api/plugins/packages/update-from-registry` applica manualmente candidate
    piu' nuove per plugin gia' installati, riusando verifica/staging/swap
    dell'install manager. Resta update automatico.
87. WS9 registry cache locale — `PluginRegistryIndex` marketplace può essere
    validato e salvato atomicamente in `~/.homun/plugins/registry-cache.json`
    tramite `GET/POST /api/plugins/registry/cache`; il gateway può anche
    scaricarlo via `POST /api/plugins/registry/fetch` da HTTPS. Restano feed e
    package reali pubblicati sul sito Homun.

Prima di pubblicare/taggare resta prudente ripetere lo smoke manuale in-app su
una automazione schedulata reale con il binario aggiornato. Il primo smoke ha
trovato e corretto una falsa chiusura su piano non completato.

## Milestone

3. Completare verifica allargata della nuova slice `ExecutionPlan` runtime.
4. WS1-Fase 2/3 — piano runtime-owned e workflow runner dichiarativo, così i
   deliverable futuri non riaprono fragilità cross-modello.
5. WS1/WS7 deliverable design system — smoke reale del nuovo `layout_profile`
   quando serve la prossima release, poi introdurre template/componenti
   dichiarativi condivisi da `make_document` e `make_deck`/presentation.
6. WS7 — deliverable Manus/Z.ai-style: prima qualità di documenti e
   presentazioni tramite design system + composer + renderer + QA; solo dopo
   ragionare su `make_research` e `make_meeting`.

## Blocco noto

Nessun blocco tecnico attivo. Il rischio principale è costruire altri
deliverable prima che il sistema sappia ricordarli, ritrovarli, cancellarli e
collegarli al perché. Per questo WS7 non è più il prossimo step.

## Prossima azione

WS1 core e' chiusa localmente: ha write-back piano→memoria, prima
materializzazione grafo piano/step, proiezione `ExecutionPlan` nei metadata
canonici, `ExecutionPlan` come stato runtime primario del loop agente, workflow
dichiarativi `make_deck`/`make_document`, outcome per-step confermati nel loop
principale e nei sub-agent, registry unico per workflow/MCP/connector/atomici,
guardrail workflow one-call e floor di orchestrazione sulle superfici planner,
piano, verifica e card UI. `make_deck` entra nel Brain con `run_plan` prima
della pipeline deterministica. Il router workflow/agent instrada i deck a
scaffolding massimo. Il primo smoke release ha corretto composer e recall
provenance/status. La prima
generalizzazione documenti è locale/verde su `make_document` e ha superato smoke
API reale con artifact gestito + memoria/provenance canonica. Il registry nativo
dei workflow `make_deck`/`make_document` è locale/verde e alimenta router e
corpus `find_capability`; la decisione strutturata ora distingue workflow,
atomici PDF e agent loop con ragione esplicita; il loop agente emette la route
come `ACT` e la aggiunge al `tool_trace` del turno. `pdf_atomic` ora è una
capability atomica nativa mappata a `run_in_sandbox`. MCP e connector Composio
parlano ora il contratto typed del registry (`McpTool`, `ConnectorTool`), e la
ricerca connector restituisce direttamente entry typed mantenendo il set
toolkit-aware per non perdere CRUD/perimeter; smoke Gmail unread passato in app.
`find_capability` ora traccia discovery ed execution delle capability connesse
nel `tool_trace`. Lo smoke Gmail ha anche corretto una duplicazione chat causata
dal resume marker riusato nella stessa sessione JS.
`make_document` supporta anche output `.docx` editabile, parametri espliciti di
struttura/stile e tabelle Word generate da Markdown; lo smoke reale ha corretto
anche stili, grassetto, corsivo, liste numerate e sizing tabelle nel DOCX.
`layout_profile` è ora dichiarativo dentro `make_document`. Scelta corrente:
sviluppare WS7 come design system condiviso per documenti e presentazioni
(`make_deck`/presentation inclusi): template e layout sono grammatica del
registry, non keyword o nuovi tool ad hoc. Prima slice locale/verde:
`design_profile` condiviso fra `make_document` e `make_deck`; seconda slice:
`design_components` condiviso per KPI, timeline, confronti, callout, processi e
rischi; terza slice: materializzazione fisica lato deck nei layout `kpi`,
`quote` e `two_column`; quarta slice: materializzazione lato documenti in
blocchi/tabelle Markdown-DOCX; quinta slice: `design_template` condiviso con
default profilo/componenti override-safe; sesta slice: `design_theme` condiviso
e primo guardrail QA testuale prima del render; settima slice: `deck-qa`
renderizzato su HTML reale blocca overflow/immagini rotte prima della consegna;
ottava slice: template catalog provider `monet/*` read-only nel registry, con
`template_ref` risolto dai workflow esistenti; nona slice: contract
`TemplateCatalogProvider` interno per agganciare MCP/marketplace/template pack
senza toccare i workflow; decima slice: manifest JSON locale caricabile e
validato; undicesima slice: QA leggibilità deck su font-size/contrasto;
dodicesima slice: QA Markdown per documenti prima di scrivere MD/PDF/DOCX.
Tredicesima slice: catalogo seed `monet/*` ampliato a 11 template PMI.
Quattordicesima slice: manifest con metadati sanificati per preview/gallery
futura. Quindicesima slice: API/bridge read-only del catalogo template.
Sedicesima slice: prima gallery UI nel plugin Presentations. Diciassettesima
slice: preview built-in per i seed locali, renderizzate dalla gallery usando i
token del catalogo. Prossimo asse: thumbnail/asset reali per pack esterni e QA
più profonda.
`make_research` e `make_meeting` restano futuri.
Il contratto corrente della memoria è in [MEMORIA.md](MEMORIA.md).
