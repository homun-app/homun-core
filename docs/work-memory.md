# Work Memory

Questo file e' la memoria operativa del lavoro svolto nel repository. Va aggiornato durante lo sviluppo per conservare non solo cosa e' stato fatto, ma anche perche'.

## 2026-05-22

### OpenHuman come spunto, non copia

- Chiarito in `PROJECT.md` che OpenHuman e' un riferimento di ispirazione gia' considerato.
- Lo useremo per studiare come hanno risolto agenti, memoria, tool, permission flow e UX operativa.
- Non lo useremo come base da copiare, forkare o replicare nello stack.
- Ogni idea presa da OpenHuman dovra' essere adattata alle decisioni gia' validate: local-first, Rust Core, Tauri, runtime Python/MLX con Gemma 4, subagenti auditabili e permessi deny-by-default.

Perche': il progetto deve imparare da implementazioni esistenti senza perdere identita' architetturale e vincoli locali.

## 2026-05-23

### Memory Facade completa

- Creato design `docs/memory/memory-facade-design.md`.
- Creato piano operativo `docs/superpowers/plans/2026-05-23-memory-facade.md`.
- Aggiunto crate `crates/memory`.
- Aggiunti contratti multilingua e multiutente: `MemoryRef`, eventi, memorie, entita', relazioni, evidenze, wiki page e context pack.
- Aggiunto `SQLiteMemoryStore` con CRUD per eventi, memorie, entita', relazioni, evidenze, wiki metadata, audit accessi e tombstone logici.
- Aggiunta policy anti-esfiltrazione per domini privacy, sensibilita', payload raw ed export ampio.
- Aggiunta redaction ricorsiva di segreti.
- Aggiunta crittografia applicativa XChaCha20-Poly1305 per payload sensibili tramite `KeyProvider`.
- Aggiunto graph MVP sopra entita'/relazioni SQLite.
- Aggiunto wiki Markdown adapter con frontmatter refs e blocco di contenuti raw secret.
- Aggiunta `MemoryFacade` per context pack policy-gated, auditati e richiamabili dai subagenti.
- Testato il crate memoria con contratti, SQLite, policy, crypto, graph, wiki e facade.

Perche': la memoria e' un pezzo separato e va completata come componente autonomo. La facade unisce SQLite, grafo e wiki senza fonderli, mantenendo refs stabili, isolamento user/workspace, privacy domains, anti-esfiltrazione, crittografia e audit.

### Graphify come backend grafo

- Confermato che il backend grafo target e' `safishamsi/graphify`.
- Clonato e ispezionato Graphify a commit `990ac706d823bf92275333433fde4ef4782a9139`.
- Verificata la pipeline `detect -> extract -> build_graph -> cluster -> analyze -> report -> export`.
- Verificato che `graph.json` usa formato NetworkX node-link con `nodes` e `links`.
- Verificata l'interfaccia LLM query-first: `graphify query`, `graphify path`, `graphify explain`.
- Aggiornato il design memoria con regole adapter Graphify.
- Aggiornato `PROJECT.md` per chiarire che Graphify e' il motore scelto per memoria tecnica/documentale.
- Aggiunto `metadata` anche a `MemoryRelation`.
- Lo store SQLite salva ora `relations.metadata_json`.
- I test coprono metadati Graphify su edge: `graphify_edge_id`, node ids e path artefatti.
- Aggiunto adapter `GraphifyImport` per importare artifact `graphify-out` nel Memory Core.
- Aggiunto `GraphifyCli` per costruire comandi query/path/explain senza far leggere report interi ai caller.
- Esposto import Graphify da `MemoryFacade`.

Perche': Graphify produce un grafo tecnico/documentale richiamabile (`graph.json`, `GRAPH_REPORT.md`, `graph.html`). Le nostre entita' e relazioni devono poter conservare mapping verso quei nodi/edge senza permettere a Graphify di bypassare policy, privacy domains, multiutente e anti-esfiltrazione.

### Import output MemoryAgent

- Aggiunto contratto `MemoryExtraction`.
- Aggiunti `ExtractedMemory`, `ExtractedEntity`, `ExtractedRelation`.
- Aggiunto `MemoryExtractionSummary`.
- Aggiunto `MemoryFacade::apply_extraction`.
- L'import crea memorie confermate, upserta entita', salva relazioni e collega evidenze.
- Testato che un output JSON del `MemoryAgent` diventi context pack richiamabile con evidence refs.

Perche': il runtime/subagente non deve scrivere direttamente nello store. L'output del `MemoryAgent` deve passare dalla facade, che conserva isolamento user/workspace, refs stabili, policy e auditabilita'.

### Memory UI Read Model

- Aggiunto `MemoryUiReadModel`.
- Aggiunte viste UI-safe per dashboard, lista memorie, dettaglio memoria e privacy overview.
- Aggiunti metodi read-only nello store per entita', relazioni e wiki pages.
- La dashboard espone conteggi per status, privacy domain e sensitivity.
- Il dettaglio memoria espone refs, evidenze, entita', relazioni e wiki pages collegate.
- Le decisioni di visibilita' vengono auditate anche quando negano una memoria.
- I payload raw degli eventi non vengono restituiti dalle viste UI.

Perche': la UI Tauri/React ha bisogno di dati gia' pronti per schermate operative, ma non deve bypassare privacy, anti-esfiltrazione o audit leggendo direttamente tabelle grezze.

### Memory production-ready closure

- Creata spec `docs/superpowers/specs/2026-05-23-production-memory-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-production-memory.md`.
- Aggiunto branch `fabio/production-memory` per isolare la chiusura.
- Aggiunto schema metadata con versione `2` e migrazioni idempotenti.
- Esteso `MemoryRecord` con `created_at`, `updated_at`, `last_seen_at`, `supersedes`, `superseded_by`, `correction_of`.
- Aggiunta API lifecycle auditata sulla facade: create candidate, update, confirm, reject, stale, merge, delete/tombstone.
- Aggiunto SQLite FTS5 per `search_memories`, con filtri policy, status, tipo, ranking deterministico e paginazione.
- Aggiunta wiki correction sync: Markdown modificato -> candidate correction con `correction_of`, senza overwrite silenzioso.
- Aggiunta API Graphify query/path/explain policy-gated con validazione root locale e ritorno di refs scoped.
- Aggiunte operations: health, backup locale, restore locale, maintenance integrity check + FTS rebuild.
- Aggiunto `MemoryError` / `MemoryResult` come boundary error tipizzato per la facade.
- Aggiunto contratto routine inference con `RoutineRecord`, `RoutineInference` e import via `MemoryFacade::apply_routine_inference`.

Perche': per considerare chiusa la memoria non bastava l'MVP. Servivano lifecycle completo, retrieval, sync bidirezionale minima, Graphify query sicura, operabilita' locale, errori tipizzati e copertura del contratto routine previsto dalla Fase 2.

### Principi architetturali confermati

- Il progetto e' language-agnostic e multilingua di default.
- Nessun contratto, agente, memoria o workflow deve assumere una lingua unica.
- L'italiano resta un caso d'uso primario, ma non deve diventare accoppiamento nel core.
- Va mantenuta una buona separazione dei file per dominio, evitando file lunghi da dividere tardi.

Perche': l'assistant deve lavorare su input reali e misti, spesso multilingua, e il core deve rimanere stabile anche se cambiano lingua, UI o runtime modello. Separare presto i file riduce il costo dei refactor man mano che i subagenti crescono.

### Split crate subagenti

- Diviso `crates/subagents/src/lib.rs` in moduli per dominio:
  - `types.rs`
  - `runtime.rs`
  - `runner.rs`
  - `prompt_guard.rs`
  - `agents.rs`
  - `tool_access.rs`
  - `workflow.rs`
  - `permissions.rs`
  - `graph.rs`
  - `orchestrator.rs`
  - `audit.rs`
- `lib.rs` ora resta solo il punto di export pubblico.
- Verificata la suite Rust dopo il refactor.

Perche': il file unico era arrivato a circa 1500 righe. Spezzarlo ora riduce accoppiamento e rende piu' semplice evolvere subagenti, audit, workflow e policy senza creare un monolite difficile da mantenere.

### Analisi mirata OpenHuman

- Clonato OpenHuman in `/tmp/openhuman-reference` solo per lettura.
- Ispezionato commit `934546b2b3ae20271c2cd82b95e8221efb199568`.
- Letti README, flow agent/subagent/tool, delegation policy, memory client reference, prompt injection guard, agent definitions e tool filtering.
- Creato ADR `docs/decisions/0001-openhuman-as-reference.md`.

Pattern da adattare:

- agent definitions data-driven.
- policy direct-first prima della delegazione.
- separazione tra tool visibili al modello e tool realmente eseguibili dal runtime.
- subagent runner isolato dal parent session.
- memory facade unica.
- prompt-injection guard prima di inference/tool loop.
- compressione/sintesi dei risultati grandi.

Perche': OpenHuman e' utile come repertorio di soluzioni concrete, ma ogni idea deve essere adattata ai nostri vincoli: local-first, Rust Core, MLX/Gemma, subagenti auditabili e deny-by-default.

### AgentDefinition registry e direct-first policy

- Aggiunto `AgentDefinition` nel crate subagenti.
- Aggiunti `AgentTier` e `ToolScope`.
- Aggiunto `default_agent_definitions()` per i nostri agenti iniziali.
- Aggiunta validazione della gerarchia: i worker non delegano, i reasoning agent non delegano ad altri reasoning agent.
- Aggiunta `DelegationPolicy` direct-first tramite `DelegationInput` e `DelegationDecision`.

Perche': OpenHuman mostra che hardcodare agenti e deleghe nel runner rende difficile governare tool, limiti e routing. Noi adattiamo il pattern mantenendo contratti piccoli, testati e coerenti con il nostro Rust Core.

### Prompt guard nel runner subagenti

- Aggiunto `guard_prompt`.
- Aggiunti `PromptGuardVerdict` e `PromptGuardResult`.
- Il `SubagentRunner` blocca prompt con pattern di instruction override, prompt exfiltration o secret exfiltration prima di chiamare il runtime.
- Testato che un prompt ostile non raggiunga il runtime finto.

Perche': OpenHuman applica enforcement server-side prima di inference/tool loop. Nel nostro progetto questo controllo deve vivere nel core/orchestratore, non nella UI, per evitare che un task subagente trasformi input non affidabile in tool call operative.

### Tool visibility vs execution

- Aggiunto `ToolDefinition`.
- Aggiunto `ToolAccessPlan`.
- Aggiunto `plan_tool_access`.
- Separata la lista di tool visibili al modello dalla lista di tool realmente eseguibili dal runtime.
- Testato che `ToolAgent` possa vedere un tool di scrittura per preparare un piano, ma possa eseguire solo i tool consentiti da scope, connector, azione e autonomia del task.

Perche': OpenHuman distingue i tool mostrati al modello dai tool che il runtime puo' invocare davvero. Nel nostro progetto questo evita che la capacita' di ragionare su un'azione diventi automaticamente permesso operativo.

### Query AuditStore

- Aggiunto `AuditStore::latest_result`.
- Aggiunto `AuditStore::recent_results_by_status`.
- Aggiunta deserializzazione dei record audit in `SubagentResult`.
- Testato recupero dell'ultimo risultato per task e filtro dei risultati recenti per stato.

Perche': l'audit non deve solo registrare eventi, deve permettere al core e alla futura UI di spiegare cosa e' successo: ultimo esito di un task, errori recenti e stato operativo dei subagenti.

### Review audit dedicate

- Aggiunta tabella SQLite `subagent_reviews`.
- Aggiunto `AuditStore::record_review`.
- Aggiunti `AuditStore::review_count` e `AuditStore::latest_review`.
- Testato che l'ultima review di un task sia recuperabile con reviewer, approvazione, rischio, richiesta approvazione e findings.

Perche': `SubagentReview` e' un oggetto di controllo distinto dal normale output del modello. Salvarlo come record dedicato rendera' piu' semplice costruire viste di approvazione, spiegazioni e blocchi operativi prima di azioni rischiose.

### Bootstrap progetto

- Inizializzato il repository Git.
- Creato ambiente locale `.venv-mlx` con `uv`.
- Aggiunti `pyproject.toml`, `.python-version`, `.gitignore` e `uv.lock`.

Perche': il progetto deve essere riproducibile localmente e non dipendere dalla venv storica usata negli esperimenti iniziali.

### Runtime locale Gemma 4

- Creato `runtimes/mlx-gemma4/server.py`.
- Il server carica una sola volta `mlx-community/gemma-4-e4b-it-4bit`.
- Esposti endpoint locali: `/health`, `/generate`, `/generate_json`, `/tool_call`, `/analyze_image`, `/benchmark`, `/shutdown`.
- Aggiunte metriche per richiesta: token, token/s, memoria peak, tempo.
- Aggiunta validazione JSON e repair attempt locale.

Perche': `PROJECT.md` stabilisce che Gemma 4 deve essere un sidecar Python/MLX persistente, non una CLI lanciata a ogni prompt e non un servizio cloud.

### Runtime locale Gemma 4 production hardening

- Aggiunta `RuntimeConfig` da env.
- `/health` espone configurazione locale, shutdown enabled, busy policy e allowed image roots.
- Aggiunto error payload stabile `{error: {code, message, retryable}}`.
- Aggiunto `RuntimeServiceError` con status HTTP coerente.
- Aggiunti `wait_if_busy` e `request_timeout_seconds` alle richieste.
- Il runtime puo' rifiutare richieste quando e' busy, invece di accodarle implicitamente.
- I deadline scaduti vengono respinti prima della generazione.
- I path immagine possono essere vincolati a root locali consentite.
- `/benchmark` espone summary aggregata delle metriche.
- `/shutdown` e' disabilitato di default e abilitabile via env.

Perche': il runtime e' la dipendenza operativa dei subagenti. Deve fallire in modo tipizzato, rispettare deadline/concorrenza e restare local-first anche su immagini e shutdown.

### Benchmark parity

- Portati nel server i 7 casi validati della suite storica Gemma 4.
- Aggiunto `scripts/gemma4_benchmark.py` per produrre `reports/gemma4_eval.jsonl`.
- `make benchmark` esegue la suite reale con MLX.

Perche': la Fase 1 deve conservare il comportamento gia' validato: JSON rigido, routine inference, memory extraction, tool calling, patch codice e vision/OCR.

### Subagenti

- Aggiornato `PROJECT.md` con `Subagent Manager`, Fase 1.5 e workflow MVP.
- Aggiunti contratti JSON condivisi per `SubagentTask`, `SubagentResult`, `SubagentReview`.
- Creato crate Rust `crates/subagents`.
- Aggiunti tipi base, registry agenti iniziali e validazione permessi deny-by-default.
- Aggiunti tipi per risultato, audit, review, risk level e findings.

Perche': il runtime LLM non deve diventare l'agente. Il coordinamento, i permessi, la memoria accessibile, l'audit e la cancellazione dei task devono vivere nel Rust Core.

### Stato verificato

- `make test`: Python e Rust passano.
- `make benchmark`: suite Gemma reale 7/7 passata.

## Prossimo blocco

### ExecutionGraph subagenti

- Implementato `ExecutionGraph` in `crates/subagents`.
- Aggiunti `TaskNode` e `TaskState`.
- Il grafo calcola i task pronti quando tutte le dipendenze sono `succeeded`.
- Il grafo marca come bloccati i task pendenti con dipendenze `failed` o `cancelled`.
- Il grafo rifiuta dipendenze mancanti al momento dell'inserimento.

Perche': il Subagent Manager deve poter orchestrare workflow sequenziali/paralleli in modo auditabile, prima di introdurre esecuzione async o chiamate reali al runtime.

## Prossimo blocco

### Runtime client Rust

- Aggiunto `RuntimeClient` nel crate subagenti.
- Modellate `GenerateJsonRequest` e `GenerateJsonResponse`.
- La risposta conserva le metriche del runtime Python/MLX tramite `TokenMetrics`.
- Il client costruisce endpoint locali stabili e chiama `/generate_json`.

Perche': il Subagent Manager deve usare il runtime Gemma come primitiva locale HTTP. Il client e' tenuto separato dall'`ExecutionGraph` per non accoppiare scheduling, permessi e trasporto.

## Prossimo blocco

### SubagentRunner

- Aggiunto `JsonRuntime` come trait, implementato da `RuntimeClient`.
- Aggiunto `SubagentRunner` sincrono.
- Il runner valida i permessi del `SubagentTask` prima di chiamare il runtime.
- Il runner costruisce `GenerateJsonRequest` da `task.input`, `task.goal` e `task.budgets`.
- Il runner produce sempre un `SubagentResult` auditabile, anche in caso di permessi invalidi o runtime error.

Perche': questo e' il primo punto in cui i contratti dei subagenti diventano operativi. Il runner resta sincrono e testabile con un runtime finto; cancellazione, retry e parallelismo verranno aggiunti sopra questa base.

### SubagentRunner production hardening

- Aggiunto `SubagentError`.
- Il runner blocca task gia' cancellati prima di chiamare il runtime.
- Il runner marca `timed_out` se `timeout_seconds` e' gia' scaduto.
- `GenerateJsonRequest` porta `wait_if_busy` e `request_timeout_seconds` al runtime.
- I test verificano che timeout/cancel non raggiungano il runtime finto.

Perche': cancellazione e timeout devono essere enforce reali, non solo campi descrittivi nel contratto.

## Prossimo blocco

### SubagentOrchestrator

- Aggiunto `SubagentOrchestrator`.
- L'orchestratore mantiene un `ExecutionGraph`, i `SubagentTask` e un `SubagentRunner`.
- `run_ready_once()` esegue solo i task pronti.
- Lo stato del grafo viene aggiornato a `running`, poi `succeeded`, `failed` o `cancelled`.
- I task dipendenti restano bloccati quando una dipendenza fallisce.

Perche': serve un primo coordinatore deterministicamente testabile prima di introdurre parallelismo, cancellazione reale o integrazione Tauri/Rust Core.

## Prossimo blocco

### Workflow MVP routine startup

- Aggiunto `routine_startup_workflow`.
- Il workflow produce la catena `PlannerAgent -> RiskAgent -> MemoryAgent/ToolAgent -> ReviewAgent`.
- Aggiunto `WorkflowTaskSpec` per associare ogni `SubagentTask` alle sue dipendenze.
- Aggiunto `SubagentOrchestrator::add_workflow`.

Perche': `PROJECT.md` definisce questo workflow come MVP dei subagenti. Averlo come builder testato evita che la forma del grafo venga ricostruita a mano in UI o core.

## Prossimo blocco

### Workflow execution end-to-end

- Aggiunto `SubagentOrchestrator::run_until_blocked`.
- Testato il workflow MVP completo con runtime finto.
- L'orchestratore esegue `routine.plan`, poi `routine.risk`, poi `routine.memory` e `routine.tool`, infine `routine.review`.
- L'esecuzione si ferma quando non ci sono piu' task pronti.

Perche': prima di collegare il runtime reale serve dimostrare che la semantica del workflow e' corretta in memoria, senza dipendere da MLX o HTTP.

## Prossimo blocco

### Workflow smoke reale

- Aggiunto binario Rust `workflow_smoke`.
- Aggiunto target `make workflow-smoke`.
- Il comando usa `RuntimeClient`, `SubagentRunner`, `SubagentOrchestrator` e `routine_startup_workflow`.
- Lo smoke e' separato da `make test`, quindi non richiede Metal o server Python attivo durante i test unitari.
- Eseguito contro il server Python/MLX reale su `127.0.0.1:8765`: 5 task eseguiti, 0 failed, 0 blocked.

Perche': ora esiste una prima prova end-to-end locale: Rust orchestra subagenti, chiama il runtime Gemma via HTTP, riceve JSON validato e conserva metriche/audit per ogni task.

Nota emersa dallo smoke:

- La validazione attuale controlla chiavi richieste e tipi root semplici, ma non applica ancora completamente gli schemi JSON condivisi con vincoli annidati.
- Esempio: `SubagentReview.findings` oggi passa come array, ma il contratto condiviso vorrebbe oggetti `{severity, message}`.

## Prossimo blocco

### Validazione JSON annidata

- Rafforzato il validatore del runtime Python.
- Ora supporta ricorsivamente `type`, `properties`, `items`, `required`, `enum`.
- I workflow Rust passano uno schema minimo nel campo `schema` di `GenerateJsonRequest`.
- `SubagentReview.findings` viene validato come array di oggetti con `severity` e `message`.
- Ripetuto lo smoke reale: workflow Rust + runtime Python/MLX, 5 task, 0 failed, 0 blocked.

Perche': lo smoke precedente aveva mostrato un falso positivo: `findings` era un array di stringhe, mentre il contratto condiviso richiede oggetti. Questa modifica fa rispettare meglio i contratti senza introdurre ancora una dipendenza Python da `jsonschema`.

## Prossimo blocco

### AuditStore SQLite

- Aggiunto `AuditStore` nel crate subagenti.
- Usa SQLite tramite `rusqlite` con feature `bundled`.
- Crea tabella `subagent_results`.
- Salva `task_id`, `agent_id`, `status`, output, errori, metriche e audit JSON.
- Testato con database in-memory.

Perche': audit e ricostruibilita' sono principi centrali del progetto. La prima persistenza riguarda i risultati dei subagenti, per poter spiegare cosa e' stato deciso da quale agente e con quali metriche.

## Prossimo blocco

### AuditStore integrato nell'orchestratore

- Aggiunto `SubagentOrchestrator::run_until_blocked_recording`.
- Ogni `SubagentResult` prodotto dal workflow viene salvato in `AuditStore`.
- Testato con runtime finto e SQLite in-memory.

Perche': l'audit deve essere automatico nel percorso operativo, non un passaggio opzionale lasciato ai caller. Questo prepara il core Rust a ricostruire cosa ha fatto ogni subagente.

### Workflow status production hardening

- Aggiunto `WorkflowRunStatus`.
- Aggiunto `WorkflowRunSummary`.
- `AuditStore` crea e aggiorna `workflow_runs`.
- Aggiunti `start_workflow_run`, `finish_workflow_run`, `workflow_run_status`.
- Aggiunto `SubagentOrchestrator::run_workflow_recording`.
- I risultati possono essere associati a `workflow_run_id`.

Perche': la UI e il core devono sapere lo stato di una run completa, non solo l'ultimo risultato di un task.

### MemoryAgent bridge

- Aggiunto dependency `local-first-memory` in `crates/subagents`.
- Aggiunto `MemoryAgentImport`.
- Aggiunto `MemoryAgentImporter`.
- L'import accetta solo risultati prodotti da `MemoryAgent`.
- L'import applica `MemoryExtraction` e `RoutineInference` passando da `MemoryFacade`.

Perche': il `MemoryAgent` non deve scrivere nello store direttamente. Anche nel flusso subagenti, la memoria resta protetta da facade, policy, refs stabili e contratti production-ready.

## Prossimo blocco

### Capability Layer design

- Analizzato OpenHuman per la parte canali/integrazioni/skill.
- Chiarita la separazione tra `channels`, `integrations`, `skills`, MCP e browser automation.
- Decisione: copiare l'architettura, non il codice.
- Decisione: usare provider esterni tipo Composio/Zapier/Pipedream come acceleratori opzionali, non come dipendenza core.
- Creato design in `docs/superpowers/specs/2026-05-23-capability-layer-design.md`.
- Aggiornato `PROJECT.md` con `Capability Layer`, managed providers opt-in e separazione channels/integrations/skills.

Perche': costruire manualmente decine o centinaia di integrazioni richiederebbe troppo tempo. Il progetto deve scalare usando MCP e provider managed quando l'utente li abilita, mantenendo pero' policy, audit, memoria e subagenti sotto controllo locale.

### Capability Layer first slice

- Creato crate Rust `crates/capabilities`.
- Aggiunti contratti provider-neutral per provider, tool, call, connection, trigger, skill manifest e managed metadata.
- Aggiunto `CapabilityPolicy` con separazione tra tool visibili al modello e tool eseguibili.
- I provider managed/cloud richiedono `allow_managed_cloud`.
- Aggiunto `FakeCapabilityProvider` per test locali senza Composio live.
- Aggiunto `CapabilityFacade` per listare tool policy-gated, chiamare tool, filtrare connessioni per user/workspace e auditare le operazioni.
- Aggiunto audit in-memory con redazione di `access_token`, `refresh_token`, `api_key`, `password`, `secret`.
- Aggiunta validazione minima degli argomenti tool su `type`, `properties` e `required`.
- Aggiunti contratti trigger con enable/disable nel provider fake.
- Aggiunti contratti channel separati: `ChannelProvider`, `ChannelMessage`, `OutboundChannelMessage`, `ChannelCapabilities`, `FakeChannelProvider`.

Perche': questo crea il confine interno prima di integrare MCP o Composio. Subagenti e UI potranno parlare con un layer stabile, mentre provider nativi, MCP, managed, browser e skill restano intercambiabili e policy-gated.

### Subagents capability bridge

- Aggiunta dependency `local-first-capabilities` in `crates/subagents`.
- Aggiunto modulo `capability_bridge`.
- `capability_policy_context_for_task` trasforma `PermissionEnvelope` in `PolicyContext`.
- `plan_capability_access` usa `CapabilityPolicy` e `CapabilityTool` per produrre tool visibili/eseguibili.
- Il vecchio `plan_tool_access` resta disponibile per compatibilita' durante la migrazione.
- I test coprono mapping permessi, separazione visible/executable e blocco managed cloud senza opt-in.

Perche': i subagenti non devono conoscere Composio, MCP o provider specifici. Devono passare dal Capability Layer, che applica permessi, privacy domain, autonomia e boundary cloud in modo uniforme.

### MCP Capability Provider

- Aggiunto `McpTransport` come boundary testabile per JSON-RPC MCP.
- Aggiunto `McpCapabilityProvider`.
- Aggiunto `McpToolPolicy` per assegnare action class, privacy domains e sensitivity ai tool MCP.
- Aggiunto `InMemoryMcpTransport` per test locali senza server MCP esterno.
- `tools/list` viene mappato in `CapabilityTool`.
- `tools/call` viene mappato in `CapabilityCallResult`.
- `initialize` invia poi `notifications/initialized`.
- I trigger MCP non sono ancora supportati e ritornano errore tipizzato.

Perche': MCP e' il primo moltiplicatore locale per evitare di scrivere ogni integrazione a mano. Il transport resta separato cosi' potremo aggiungere stdio persistente o HTTP streamable senza cambiare il contratto del Capability Layer.

### MCP stdio transport

- Aggiunto `McpStdioConfig`.
- Aggiunto `McpStdioTransport`.
- Il transport avvia un processo locale persistente con stdin/stdout piped.
- Ogni request invia JSON-RPC 2.0 newline-delimited con id incrementale.
- Le notification vengono inviate senza attendere risposta.
- Il drop del transport termina il processo figlio.
- Aggiunto binario fixture `fake_mcp_stdio` per testare un processo reale.
- Il test verifica initialize, `tools/list` e `tools/call` sullo stesso processo.

Perche': ora MCP non e' solo un contratto in memoria. Abbiamo il primo transport locale reale, ancora vendor-neutral e senza Composio, pronto per registrare server MCP stdio scelti dall'utente.

### Composio managed provider

- Aggiunto `ComposioTransport` come boundary per chiamate Composio senza legare il core a un client specifico.
- Aggiunto `ComposioCapabilityProvider`.
- Aggiunto `ComposioProviderConfig` user/workspace scoped.
- Aggiunto `ComposioToolPolicy` per action class, privacy domains e sensitivity.
- Aggiunto `InMemoryComposioTransport` per test locali senza API key o chiamate cloud.
- Il provider dichiara `DataBoundary::ManagedCloud` e auth mode `composio_connect_or_api_key`.
- Mappa tool Composio in `CapabilityTool`.
- Mappa connected accounts in `CapabilityConnection`.
- Mappa triggers in `CapabilityTrigger`.
- Esegue tool con payload che include `user_id` e `arguments`.

Perche': Composio serve a scalare rapidamente la copertura integrazioni, ma deve restare un provider managed opt-in dietro policy/audit locali. Questo adapter prepara l'integrazione reale senza rompere il principio local-first di default.

## Prossimo blocco

### Durable Task Runtime come fondamento trasversale

- Rivalutata la roadmap dopo aver chiarito due requisiti:
  - browser automation deve supportare form, prenotazioni, ricerche complesse e operazioni multi-step.
  - i task lunghi di ore o giorni non sono specifici del browser, ma devono valere per tutto il sistema.
- Decisione: introdurre un crate centrale `crates/task-runtime`.
- Il Durable Task Runtime gestira' task indipendenti, workflow, code, priorita', resource governor, lease/heartbeat, checkpoint, retry/backoff, pause/resume/cancel e approval gates.
- Le risorse iniziali da governare sono: `llm_inference`, `browser_session`, `network_io`, `filesystem_io`, `connector_api`, `memory_indexing`, `graph_indexing`, `user_wait`, `background_maintenance`.
- I task multipli potranno essere eseguiti in parallelo solo quando priorita', dipendenze e risorse lo permettono.
- Browser automation restera' un modulo separato, ma usera' il Durable Task Runtime per prenotazioni, compilazione form, monitoraggi e task di giorni.
- Aggiornato `PROJECT.md` con la nuova fase `Durable Task Runtime`, la fase `Browser Automation` separata e la roadmap successiva.
- Aggiornata la spec del Capability Layer per chiarire che provider e capability non possiedono scheduling, retry o checkpoint.
- Aggiornata la spec runtime/subagenti per chiarire che i subagenti restano responsabili degli step, mentre la durata globale passa al task runtime.
- Creati:
  - `docs/superpowers/specs/2026-05-23-durable-task-runtime-design.md`
  - `docs/superpowers/plans/2026-05-23-durable-task-runtime.md`

Perche': senza un task runtime centrale, browser automation, subagenti, connettori e manutenzioni finirebbero per duplicare code, retry, limiti risorse, approvazioni e recovery. Questo blocco va chiuso prima del browser reale.

### Durable Task Runtime first production slice

- Creato crate `crates/task-runtime`.
- Aggiunti contratti core: `TaskRecord`, `TaskStatus`, `TaskPriority`, `ResourceClass`, `ResourceRequirement`, `RetryPolicy`, `TaskId`, `WorkflowId`, `UserId`, `WorkspaceId`.
- Aggiunto `TaskStore` SQLite con migrazioni idempotenti.
- Lo store persiste task, dipendenze workflow, reservation risorse, checkpoint e approval records.
- Aggiunto scheduler deterministico:
  - priorita' `critical > high > normal > low > background`.
  - rispetto di `not_before`.
  - dipendenze completate prima dei task figli.
  - dipendenze terminali marcano i figli come `waiting_external_event`.
- Aggiunto `ResourceGovernor` con limiti per classe risorsa e transizione `waiting_resource` con motivo esplicito.
- Aggiunto `LeaseManager` con acquire, heartbeat e recovery dei lease scaduti.
- La recovery libera le reservation e rimette in coda task running con lease stale.
- Aggiunti checkpoint append-only con payload raw e payload redatto separati.
- Aggiunto `RetryController` con backoff e failure terminale dopo `max_attempts`.
- Aggiunto `ApprovalGate` per request/approve/reject:
  - request porta il task in `waiting_user_approval`.
  - approve rimette il task in coda.
  - reject cancella il task senza esecuzione.
- Aggiunti `TaskExecutor`, `FakeTaskExecutor` e `TaskRuntime` facade.
- `TaskRuntime::run_ready_once` collega scheduler, resource governor, lease, executor, checkpoint, approval e retry.
- Aggiunto `TaskUiReadModel` per snapshot UI-safe: queued, active, blocked, waiting approvals, recent failures, resource usage e detail con checkpoint redatto.
- Aggiornato e marcato completo il piano `docs/superpowers/plans/2026-05-23-durable-task-runtime.md`.
- Ogni slice e' stato sviluppato test-first e committato separatamente.

Perche': ora il progetto ha un fondamento durevole riusabile da subagenti, capability, browser automation, Graphify e manutenzioni. I task lunghi e paralleli non richiedono logica duplicata negli executor.

## Prossimo blocco

### Subagents bridge verso Durable Task Runtime

- Creato design `docs/superpowers/specs/2026-05-23-subagents-task-runtime-bridge-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-subagents-task-runtime-bridge.md`.
- Aggiunta dipendenza `local-first-task-runtime` al crate `crates/subagents`.
- Aggiunto modulo `task_runtime_bridge`.
- `SubagentTaskRuntimeBridge` converte `WorkflowTaskSpec` e `SubagentTask` in `TaskRecord` durevoli.
- Le dipendenze workflow vengono persistite con `TaskStore::add_dependency`.
- Il payload completo del `SubagentTask` viene conservato in `TaskRecord.input_json`.
- Il `PermissionEnvelope` viene conservato in `TaskRecord.permission_context`.
- Ogni task subagente dichiara `ResourceClass::LlmInference` con 1 unita'.
- Aggiunto `SubagentTaskExecutor`, adapter `TaskExecutor` che ricostruisce il `SubagentTask` e chiama `SubagentRunner`.
- I successi diventano `ExecutorResult::Completed` con `SubagentResult` serializzato.
- Failed/timed out/cancelled diventano `ExecutorResult::RetryableFailure`.
- I test coprono enqueue workflow, dipendenze, resource declaration, completamento durable e failure retryable.

Perche': il Subagent Manager ora puo' appoggiarsi al task runtime per code, risorse, lease, retry, checkpoint e recovery invece di restare confinato all'orchestratore in-memory.

### Capability bridge verso Durable Task Runtime

- Creato design `docs/superpowers/specs/2026-05-23-capability-task-runtime-bridge-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-capability-task-runtime-bridge.md`.
- Aggiunta dipendenza `local-first-task-runtime` al crate `crates/capabilities`.
- Aggiunto modulo `task_runtime_bridge`.
- `CapabilityTaskRuntimeBridge` converte `CapabilityCall` + `PolicyContext` in `TaskRecord` durevoli.
- Il payload task conserva `PolicyContext` e `CapabilityCall`.
- `TaskRecord.permission_context` conserva il contesto policy per audit/UI.
- Le risorse vengono assegnate in base al provider kind:
  - native -> `filesystem_io`
  - MCP/managed -> `connector_api`
  - browser -> `browser_session`
  - skill -> `background_maintenance`
- Aggiunto `CapabilityTaskExecutor`, adapter `TaskExecutor` che possiede una `CapabilityFacade` e chiama `call_tool`.
- Successo tool -> `ExecutorResult::Completed`.
- Errore/denial tool -> `ExecutorResult::RetryableFailure`, quindi retry/backoff restano nel task runtime.
- Test coprono enqueue, resource mapping, esecuzione riuscita e denial managed-cloud.

Perche': ora anche connettori, MCP e provider managed possono usare code, lease, limiti risorse e retry comuni, invece di vivere come chiamate immediate fuori dal runtime durevole.

## Prossimo blocco

### Capability provider registry persistente

- Creato design `docs/superpowers/specs/2026-05-23-capability-provider-registry-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-capability-provider-registry.md`.
- Aggiunta `CapabilityRegistryStore` SQLite nel crate `crates/capabilities`.
- La registry salva config provider, tipo provider, metadata managed, hint risorsa e rate limit.
- Aggiunti grant user/workspace con privacy domains, action consentite, autonomia massima, opt-in managed cloud e abilitazione/disabilitazione.
- La registry deriva `PolicyContext` dai grant abilitati e lo usa con `CapabilityFacade`.
- Aggiunte connection config persistenti con `secret_ref` separato: i segreti restano fuori dal DB e i metadata vengono sanitizzati da token/password/api key.
- Aggiunta cache strumenti per provider con schema input, action class, privacy domains, sensitivity e provider kind.
- Test coprono migrazioni idempotenti, config provider, grant policy, managed opt-in, connessioni secret-ref-only, tool cache e integrazione Facade.

Perche': capability, MCP e provider managed non possono restare configurati solo in memoria. Serve una registry locale, multiutente/workspace e policy-aware per abilitare provider, collegare account, mostrare tool alla UI/subagenti e mandare tool call durevoli nel Task Runtime senza dipendere da un vendor.

## Prossimo blocco

### Browser automation design con OpenClaw come riferimento

- Analizzato OpenClaw a commit `bcf756ce36397febcdc92fdbea825824c72d3427`.
- Confermata licenza MIT, quindi possiamo portare/adattare codice mantenendo attribution.
- Confermato il problema Playwright/Rust: Playwright non ha binding Rust ufficiale, quindi non va usato direttamente dal core Rust.
- Decisione: usare un sidecar locale Node/TypeScript con `playwright-core`, supervisionato dal Rust Core.
- Decisione: copiare/adattare il piu' possibile dal modello OpenClaw per browser profile, Playwright/CDP, snapshot/refs, azioni atomiche, tab tracking, navigation guard, artifact roots e manual blockers.
- Decisione: non copiare Gateway/plugin/session/policy OpenClaw; quei ruoli restano in Durable Task Runtime, Capability Layer, Provider Registry e audit locali.
- Creata spec `docs/superpowers/specs/2026-05-23-browser-automation-design.md`.
- Aggiornato `PROJECT.md` con OpenClaw come riferimento browser e con il runtime sidecar Node/TS.

Perche': browser automation e' una capacita' critica per operazioni reali come prenotazioni, compilazione form, ricerche complesse e task di giorni. Serve massima compatibilita' con Playwright ufficiale, ma senza spostare permessi, privacy, scheduling o audit fuori dal Rust Core.

## Prossimo blocco

### Browser automation first production slice

- Creato piano `docs/superpowers/plans/2026-05-23-browser-automation.md`.
- Creato runtime locale `runtimes/browser-automation` in Node/TypeScript con `playwright-core`.
- Aggiunto trasporto stdio JSON lines per evitare una control surface HTTP prematura.
- Aggiunti contratti sidecar per request/response, errori tipizzati, retry e manual action.
- Aggiunti guardrail locali: navigation guard per protocolli e private network, artifact root confinement e upload roots.
- Implementato profilo managed `assistant` con discovery di browser Chromium e launch Playwright.
- Implementati tab label, snapshot/ref loop, invalidazione refs dopo navigazione e azioni atomiche iniziali (`fill`, `type`, `click`, `wait`).
- Aggiunto test fixture reale: open pagina locale, snapshot, fill, submit, resnapshot e stale ref.
- Creato crate Rust `crates/browser-automation` con contratti serde, policy, artifact guard, client e sidecar session wrapper.
- Aggiunto `BrowserCapabilityProvider` nel Capability Layer con tool `browser.health`, `browser.tabs`, `browser.snapshot`, `browser.open`, `browser.navigate`, `browser.act`.
- Aggiunto `BrowserTaskRuntimeBridge` e `BrowserTaskExecutor`: risorsa `browser_session`, snapshot come checkpoint, output come completed, manual blocker come `NeedsApproval`.
- Aggiunti target Makefile `browser-sync`, `browser-test`, `test-browser`; `make test` ora include i test browser.

Perche': questa slice rende il browser automation un componente operativo locale e testato, senza spostare autonomia o permessi nel sidecar. Il lato Node fa solo browser/CDP; Rust conserva policy, capability, durable task, checkpoint e approval.

## Prossimo blocco

### Browser automation production hardening

- Creato piano `docs/superpowers/plans/2026-05-23-browser-automation-production-hardening.md`.
- Esteso il sidecar Node/TypeScript per implementare tutti i metodi browser dichiarati nei contratti.
- Aggiunti artifact reali per screenshot e PDF, sempre dentro artifact root confinata.
- Aggiunto upload reale con file chooser armato e validazione degli upload roots.
- Aggiunto download reale con salvataggio dentro artifact root confinata.
- Aggiunto dialog handling (`accept`/`dismiss`, prompt text opzionale) e console ring buffer per pagina.
- Aggiunta gestione tab `focus` e `close_tab`.
- Aggiunto profilo attach-only `user`: richiede endpoint CDP locale esplicito, altrimenti produce manual-action.
- Corretto il profilo `assistant` default per evitare collisioni di ProcessSingleton tra sidecar paralleli; la persistenza esplicita passa da `BROWSER_AUTOMATION_PROFILE_ROOT`.
- Espanso `BrowserCapabilityProvider` con tutti i tool browser: profiles, console, focus, close_tab, screenshot, pdf, arm_file_chooser, respond_dialog, wait_download oltre ai tool gia' presenti.
- Aggiornato `BrowserTaskExecutor` per checkpoint snapshot redatti con metadata browser utili alla UI.
- Aggiornato `TaskUiReadModel` per esporre metadata browser senza esporre input raw.
- Aggiunti test reali Playwright per artifact, console, dialog, upload, download, profili e tab lifecycle.

Perche': il browser runtime ora ha primitive operative sufficienti per prenotazioni, compilazione form, download/upload e task lunghi orchestrati dal Durable Task Runtime. Il sidecar continua a non possedere autonomia, policy o durata del task: esegue primitive locali controllate, mentre Rust conserva capability, approval, checkpoint e scheduling.

## Prossimo blocco

### Process Manager Rust

- Creato design `docs/superpowers/specs/2026-05-23-process-manager-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-process-manager.md`.
- Aggiunto crate `crates/process-manager` al workspace.
- Aggiunti contratti per `ProcessSpec`, `ProcessKind`, `HealthCheck`, `RestartPolicy`, `ProcessStatus` e `ProcessSnapshot`.
- Aggiunto `ProcessRegistryStore` SQLite con migrazioni idempotenti per specs e latest snapshots.
- Aggiunto `LogBuffer` bounded con stream stdout/stderr.
- Aggiunto health evaluator con `process_alive` e `http_get`, tramite `HealthProbe` iniettabile.
- Aggiunto `ProcessManager` facade con register/start/stop/check_health/detail.
- Aggiunto `FakeProcessSupervisor` per test deterministici.
- Aggiunto `LocalProcessSupervisor` con spawn reale, start idempotente, stop/kill, snapshot exit e capture stdout/stderr.

Perche': LLM runtime, browser sidecar e MCP server non devono essere avviati ad hoc da ogni componente. Serve un boundary comune nel Rust Core che gestisca lifecycle, health, logs e stato UI-safe, lasciando scheduling e retry dei task al Durable Task Runtime.

## Prossimo blocco

### Process sidecar catalog

- Creato piano `docs/superpowers/plans/2026-05-23-process-sidecar-catalog.md`.
- Aggiunto `SidecarProcessCatalog` nel crate `crates/process-manager`.
- Il catalogo genera `ProcessSpec` concrete per:
  - `llm-gemma4-mlx`: `.venv-mlx/bin/python runtimes/mlx-gemma4/server.py`, cwd workspace, health HTTP `127.0.0.1:8765/health`.
  - `browser-automation`: `node node_modules/tsx/dist/cli.mjs src/server.ts`, cwd `runtimes/browser-automation`, health `process_alive`.
  - MCP stdio configurati dall'utente tramite `McpProcessConfig`.
- Aggiunto helper `register_default_sidecars` per registrare Gemma e browser nel `ProcessRegistryStore`.
- Testato che le spec siano stabili, serializzabili e registrabili.

Perche': ora il Process Manager non e' solo un supervisor generico. Ha un catalogo esplicito per i sidecar reali del progetto, ma resta separato dall'esecuzione: registra configurazioni, mentre start/stop/health restano azioni intenzionali del `ProcessManager`.

## Prossimo blocco

### Secrets/Keychain

- Creato piano `docs/superpowers/plans/2026-05-23-secrets-keychain.md`.
- Aggiunto crate Rust `crates/secrets` al workspace.
- Aggiunti contratti `SecretRef`, `SecretMaterial`, `SecretMetadata`, `SecretStatus` e `SecretStore`.
- `SecretRef` e' stabile, parseabile, multiutente/workspace e rifiuta path traversal o riferimenti legacy non strutturati.
- `SecretMaterial` redige il debug e rifiuta la serializzazione JSON per ridurre leak accidentali in log, audit, UI o payload task.
- Aggiunto `InMemorySecretStore` per test deterministici con put/get/delete/list/status e versionamento.
- Aggiunta crittografia XChaCha20Poly1305 con `EncryptedFileSecretStore`: round trip locale, nonce casuale, plaintext non presente su disco e fallimento con chiave errata.
- Aggiunto `DevelopmentSecretKeyProvider` per test/dev locale esplicito.
- Aggiunto `SystemKeychainSecretStore` come boundary OS: su macOS usa il comando `security`, sulle piattaforme non supportate fallisce in modo esplicito e sicuro.
- Integrato `local-first-secrets` nel `CapabilityRegistryStore` con helper `upsert_connection_config_with_secret`.
- La capability registry salva nel DB solo `secret_ref`, rimuove metadata sensibili come token/password/api key/secret e scrive il materiale reale nello store segreti.
- Verifiche eseguite:
  - `cargo test -p local-first-secrets`
  - `cargo test --workspace`
  - `make test`

Perche': i connettori, MCP e provider managed richiedono credenziali, ma il registry locale non deve mai diventare un deposito di token in chiaro. Ora il progetto ha un boundary dedicato per credenziali, testabile in memoria, cifrato su file e agganciabile al keychain di sistema, mantenendo capability e task runtime su `secret_ref` auditabili.

## Prossimo blocco

### Skill/Plugin Registry locale

- Creato design `docs/superpowers/specs/2026-05-23-skill-plugin-registry-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-plugin-registry.md`.
- Esteso `SkillManifest`: i tool non sono piu' stringhe, ma `SkillToolManifest` con nome, descrizione, action, privacy domains, sensitivity e input schema.
- Aggiunti `PluginManifest`, `SkillInstallRecord`, `PluginInstallRecord` e `SkillTrustLevel`.
- Gli install record sono scoped per `user_id` e `workspace_id`, hanno `enabled`, `source_path`, `trust_level`, versioni e `manifest_hash` opzionale.
- Aggiunto `SkillPluginRegistryStore` SQLite in `crates/capabilities/src/skill_plugin.rs`.
- La registry salva manifest globali e installazioni locali, con migrazioni idempotenti.
- La registrazione di un plugin registra anche le skill bundled.
- Aggiunto `SkillCapabilityProvider`: converte skill abilitate in normali `CapabilityTool` con `CapabilityProviderKind::Skill`.
- `SkillCapabilityProvider` e' read-only per ora: `call_tool` restituisce `skill_execution_unavailable:<tool>`, evitando esecuzione di codice non sandboxato.
- La policy resta unica: `CapabilityFacade` filtra i tool skill tramite provider enabled, privacy domains, action e autonomia come per MCP/browser/managed provider.
- Verifiche eseguite:
  - `cargo test -p local-first-capabilities --test skill_plugin_registry`
  - `cargo test --workspace`
  - `make test`

Perche': skill e plugin non possono essere solo file o convenzioni esterne. Ora sono oggetti locali versionati, permission-aware, multiutente/workspace e orchestrabili come capability, ma senza introdurre ancora un runtime di esecuzione insicuro.

## Prossimo blocco

### Skill Runtime Sandbox

- Creato design `docs/superpowers/specs/2026-05-23-skill-runtime-sandbox-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-runtime-sandbox.md`.
- Aggiunto crate Rust `crates/skill-runtime` al workspace.
- Aggiunti contratti `SkillRuntimeRequest`, `SkillRuntimeOutput`, `SkillExecutionTrace`, `SkillRuntimeLimits` e `SkillAccess`.
- Aggiunto `SkillSandboxPolicy` deny-by-default.
- La policy valida tool presente nel manifest, schema JSON base, host network dichiarati e path filesystem dentro root dichiarate.
- La policy ricontrolla anche la trace del runner dopo l'esecuzione e blocca output oltre `max_output_bytes`.
- Aggiunto trait `SkillRunner`, che e' il boundary per adapter futuri WASM/QuickJS/process.
- Aggiunto `InMemorySkillRunner` per handler locali/test deterministici senza accesso OS.
- Aggiunto `SkillRuntime`: valida richiesta, esegue runner, valida trace/output.
- Aggiunto `SkillRuntimeCapabilityProvider`: espone skill eseguibili come provider capability `skill`.
- Verificato il percorso con `CapabilityFacade`: policy/audit capability restano il punto unico di enforcement.
- Verificato il percorso durevole con `CapabilityTaskRuntimeBridge` e `CapabilityTaskExecutor`: una skill tool call viene enqueued e completata come task con risorsa `background_maintenance`.
- Verifiche eseguite:
  - `cargo test -p local-first-skill-runtime`
  - `cargo test --workspace`
  - `make test`

Perche': ora skill/plugin non sono solo manifest installabili. Possono essere eseguiti dietro un boundary locale, permission-aware e orchestrabile, senza aprire esecuzione arbitraria non confinata. Gli adapter reali per codice non trusted devono implementare `SkillRunner` e dimostrare isolamento runtime/OS con test dedicati.

## Prossimo blocco

### Skill Runtime Adapter Hardening

- Creato design `docs/superpowers/specs/2026-05-23-skill-runtime-adapters-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-runtime-adapters.md`.
- Aggiunto `ProcessSkillRunnerConfig` in `crates/skill-runtime/src/process_runner.rs`.
- Il config rifiuta executable fuori dalle root consentite.
- Il config rifiuta working directory fuori dalle root consentite.
- Il config canonicalizza executable, working dir e root prima dell'uso.
- Il config parte con env vuoto e accetta solo env espliciti via `with_env`.
- Aggiunto `ProcessSkillRunner`.
- Il runner avvia executable direttamente con `Command::new`, senza shell.
- Il runner cancella l'ambiente ereditato con `env_clear`.
- Il runner scrive `SkillRuntimeRequest` JSON su stdin.
- Il runner legge `SkillRuntimeOutput` JSON da stdout.
- Il runner cattura stderr e lo trasforma in errore audit-safe su exit non-zero.
- Il runner uccide il processo su timeout.
- Il runner blocca stdout oltre `max_output_bytes`.
- La validazione post-run resta in `SkillRuntime`, quindi trace network/filesystem e output passano dallo stesso boundary gia' usato da `InMemorySkillRunner`.
- Verifiche eseguite:
  - `cargo test -p local-first-skill-runtime`
  - `cargo test --workspace`
  - `make test`

Perche': ora possiamo eseguire handler locali fidati o wrapper controllati come processi esterni senza shell, senza env ereditato e con protocollo JSON stabile. Questo non e' ancora isolamento forte per codice scaricato/non trusted: per quello serve il prossimo adapter WASM/QuickJS o equivalente, con confinement runtime verificabile.

## Prossimo blocco

- Skill Runtime Untrusted Adapter: implementare un adapter WASM/QuickJS per skill non trusted, con test che dimostrano isolamento filesystem/network oltre alla policy contrattuale.

## Prossimo blocco

### Skill Runtime Untrusted Adapter

- Creato design `docs/superpowers/specs/2026-05-23-skill-runtime-untrusted-adapter-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-skill-runtime-untrusted-adapter.md`.
- Aggiunto Wasmtime 45 a `crates/skill-runtime` e `wat` come dev dependency per test deterministici.
- Aggiunto `WasmSkillRunnerConfig` in `crates/skill-runtime/src/wasm_runner.rs`.
- Il config canonicalizza modulo e allowed roots e rifiuta moduli fuori dalle root esplicite.
- Il config compila il modulo con fuel abilitato e rifiuta qualsiasi import host/WASI.
- Aggiunto `WasmSkillRunner`.
- Il runner crea uno store Wasmtime con fuel, istanzia moduli senza import e richiede export `memory` e `run`.
- Protocollo guest: request JSON scritta nella memoria guest a offset 0, call `run(ptr, len) -> i64`, output restituito come pointer/length packed.
- Il runner valida dimensione output prima del parse JSON, controlla i bounds della memoria guest e converte trap/fuel exhaustion in errori auditabili.
- La validazione post-run rimane nel `SkillRuntime`: trace network/filesystem e output passano dallo stesso boundary gia' usato da in-memory e process runner.
- Aggiunti test per root confinement, import rejection, protocollo memoria/run, output troppo grande, fuel exhaustion e export mancanti.
- Verifiche eseguite:
  - `cargo test -p local-first-skill-runtime --test wasm_runner`
  - `cargo test -p local-first-skill-runtime`
  - `cargo test --workspace`
  - `make test`

Perche': ora le skill non trusted possono girare dentro un runtime senza accesso host implicito, invece di essere solo processi hardenizzati. Questo chiude il primo livello production del runtime skill: manifest/policy, task orchestration, process runner trusted e WASM runner non trusted. Restano utili in seguito SDK e host capability WASI controllate, ma non sono piu' prerequisito per avere un confinement forte di base.

## Prossimo blocco

- Assistant Orchestrator Brain: creare il cervello deterministico che decide quando usare memoria, browser, MCP, connettori, skill, subagenti o risposta diretta, generando piani auditabili e task durevoli invece di lasciare il routing solo al prompt del modello.

## Prossimo blocco

### Assistant Orchestrator Brain

- Creato design `docs/superpowers/specs/2026-05-23-assistant-orchestrator-brain-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-assistant-orchestrator-brain.md`.
- Aggiunto crate Rust `crates/orchestrator` al workspace.
- Aggiunti contratti `OrchestratorRequest`, `ExecutionPlan`, `PlanStep`, `OrchestratorOutcome`, `ToolCard` e `OrchestratorAudit`.
- Aggiunto `ToolSearchIndexStore` SQLite FTS5/BM25 per registry tool lazy.
- Le `ToolCard` espongono provider, action, descrizione, privacy domain, sensitivity e schema hash, ma non lo schema input completo.
- Il Brain carica tutti i tool detail solo se il catalogo visibile e' piccolo; con cataloghi grandi carica un subset limitato e consente un solo retry `needs_more_tools`.
- Aggiunto `MemoryContextProvider` con provider noop/statici e adapter per `MemoryFacade`.
- Aggiunto `OrchestratorBrain`: costruisce prompt JSON locale, valida il piano e blocca tool non caricati o inventati dal modello.
- Le risposte dirette non creano task quando non servono capability.
- Le capability `read`/`draft` brevi e locali possono essere eseguite subito via `CapabilityFacade`.
- Write, browser mutativo, managed provider e step non immediati vengono accodati tramite `CapabilityTaskRuntimeBridge`.
- Aggiunta gestione iniziale di DAG: gli step possono dichiarare dipendenze e le dipendenze tra task accodati vengono registrate nel `TaskStore`.
- Verifiche eseguite finora:
  - `cargo test -p local-first-orchestrator`

Perche': il modello non deve vedere tutti i tool e non deve decidere da solo cosa puo' eseguire. Ora il cervello usa un pattern simile a tool search/deferred loading: catalogo compatto, pochi detail caricati, piano JSON validato e enforcement finale nel Rust Core.

## Prossimo blocco

### Assistant Orchestrator Brain Hardening

- Creato design `docs/superpowers/specs/2026-05-23-assistant-orchestrator-brain-hardening-design.md`.
- Creato piano `docs/superpowers/plans/2026-05-23-assistant-orchestrator-brain-hardening.md`.
- Aggiunto `OrchestratorAuditStore` in `crates/orchestrator/src/audit.rs`.
- Lo store audit usa SQLite locale e migrazioni idempotenti per persistere run Brain riuscite e failure planner.
- Aggiunto `OrchestratorUiReadModel` in `crates/orchestrator/src/ui.rs`.
- Il read model espone route, status, step, tool/agent id, contract, metriche, memory refs e task summary senza raw user message, raw tool arguments o raw tool output.
- Esteso `PlanStep` con campi subagent: `agent_id`, `goal`, `contract`, `allowed_actions`, `requires_user_approval`, `timeout_seconds`, `max_tokens`.
- Esteso `OrchestratorOutcome` con `enqueued_subagent_tasks`.
- Aggiunto `subagent_workflow.rs` per convertire `subagent_task` in `SubagentTask` durevoli tramite `SubagentTaskRuntimeBridge`.
- Le azioni richieste dai subagenti vengono validate contro il `PolicyContext`.
- Le dipendenze tra step subagent e step capability gia' accodati vengono persistite nel `TaskStore`.
- Aggiornato planner prompt/schema per dichiarare esplicitamente i campi subagent.
- Aggiunti test:
  - `crates/orchestrator/tests/audit.rs`
  - `crates/orchestrator/tests/subagent_workflow.rs`
- Verifiche eseguite finora:
  - `cargo test -p local-first-orchestrator`

Perche': ora il Brain non e' solo un router per la singola chiamata. Produce decisioni persistenti e leggibili dalla futura UI, mantenendo separato cio' che serve all'esecuzione raw da cio' che puo' essere mostrato in modo sicuro.

## Prossimo blocco

### UI Tauri V1 operativa

- Creato `apps/desktop` con Tauri 2, React, TypeScript e Vite.
- Aggiunta shell light-first con sidebar sinistra, workspace centrale e inspector destro contestuale.
- Implementata home Chat come prima schermata prodotto, non landing page.
- Implementate viste complete per Chat, Task/Approval center e Settings.
- Aggiunte viste shallow navigabili per Memoria, Connessioni, Automazioni, Browser e Brain Audit.
- Separati i mock TypeScript dai componenti in `src/data/mockData.ts`.
- Allineati i mock ai read model gia' previsti: task queue, task detail redatto, run Brain, memory summary, runtime health e provider/connection list.
- L'inspector mostra Brain plan, task selezionato, approvazioni e runtime health senza esporre raw payload.
- Verificata la direzione visuale Manus light + settings Codex: neutral grays, system blue, radius massimo 8px, niente dotted background permanente e niente card annidate.
- Rifinita la UX dopo review visuale: canvas piu' adattivo su desktop, sidebar principale comprimibile, inspector comprimibile e Settings come modalita' shell dedicata che sostituisce la navigazione principale con menu impostazioni + ritorno all'app.
- Seconda rifinitura ispirata a Manus: inspector nascosto di default e richiamabile da header/activity strip, sidebar ridotta alle voci primarie, impostazioni accessibili dal footer e pagina Plugin/Connettori resa piu' curata con feature card, search e griglia connettori.
- Terza rifinitura layout: composer trattato come overlay ancorato dentro la chat invece che come elemento del flow, conversazione con scroll interno e auto-scroll React, sidebar a griglia con footer ancorato, un solo entry point impostazioni e icone centrate nello stato compresso con slot fissi.
- Aggiunte micro-interazioni non invasive: transizioni su shell/sidebar, feedback active/focus sul composer, ingresso leggero del dock e dei messaggi, rispettando `prefers-reduced-motion`.
- Verifiche eseguite:
  - `npm run typecheck`
  - `npm run build`
  - screenshot browser desktop e mobile su Chat/Settings/Tasks

Perche': la UI e' il primo punto di fiducia del prodotto. Serviva un prototipo operativo abbastanza fedele da giudicare look and feel, densita', privacy/approval flow e layout responsive prima di cablare i Tauri commands reali. In particolare il prompt non deve mai essere spinto fuori dalla chat e la navigazione deve restare stabile anche con altezze ridotte.

## Prossimo blocco

### Local Computer Session e direzione UX Manus

- Navigata e analizzata Manus live dopo login per capire interazioni reali, menu, chat attiva, plugin, pianificazione, activity card e computer panel.
- Confermato che Manus e' un riferimento UX, non una base tecnica da copiare.
- Confermato che il "computer" non e' solo browser: deve includere anche shell/terminale, file/artifact e log.
- Creato ADR `docs/decisions/0002-local-computer-session-ux.md`.
- Creata spec `docs/superpowers/specs/2026-05-23-local-computer-session-ux-design.md`.
- Aggiornato `PROJECT.md` con `Local Computer Session Manager`, superfici Browser/Shell/Artifact/Log, risorse `computer_session` e `shell_process`, Fase 6.5 e nuova direzione UI.
- La chat deve diventare rail/drawer + thread centrale + activity card, con dettagli on demand tramite popover/modal/panel.
- L'inspector non deve essere il default: piano, utilizzo, file, computer e audit devono apparire solo quando l'utente li chiede o quando un task richiede attenzione.
- Il prossimo cablaggio UI non deve collegare direttamente i mock a task/browser: prima serve il read model Local Computer per evitare di cementare una UX sbagliata.

Perche': l'esperienza utente e' parte centrale del prodotto. Se browser e shell restano pannelli tecnici separati, l'assistant sembra grezzo e difficile da fidare. Una sessione computer locale, visibile e redatta, permette di mostrare lavoro reale, approvazioni e takeover senza sacrificare local-first, audit e policy.

## Prossimo blocco

### UI Tauri riallineata alla spec Local Computer

- Scartato il tentativo visuale precedente basato su sidebar densa e inspector.
- Rifatta la shell con rail primaria sempre presente e drawer espandibile on demand.
- Rimossa l'integrazione dell'inspector dal layout e cancellato il componente `Inspector`.
- Rifatta la Chat come active-task thread: topbar minimale, messaggi centrali, timeline inline, Local Computer activity card e composer ancorato al fondo dell'area utile.
- Aggiunto pannello `Computer locale` on demand con tab Browser, Terminale, File e Log.
- Aggiunto mock read model `ComputerSession` con superfici, timeline, artifact e transcript redatto.
- Aggiunto contract test statico `npm run test:ui-contract` per impedire regressioni su rail/drawer, activity card, detail panel, timeline e assenza dell'inspector nella shell.
- Corretto comportamento responsive: su viewport mobile il drawer parte chiuso, su altezze ridotte il thread torna al fondo e il composer resta utilizzabile.
- Rifinito comportamento sidebar: quando il drawer testuale e' aperto la rail di icone sparisce; quando il drawer viene chiuso resta solo la rail compatta.
- Aggiunte azioni persistenti nel drawer aperto per non perdere Notifiche e Impostazioni quando la rail e' nascosta; poi ridotte a sole icone in fondo, allineate a sinistra, senza riga divisoria, e rimossa la card Local Computer dalla sidebar.
- Verifiche eseguite:
  - `npm run test:ui-contract`
  - `npm run typecheck`
  - `npm run build`
  - screenshot browser in-app su desktop, mobile e altezza corta.

Perche': la UI doveva seguire la nuova specifica Manus-inspired senza mantenere compromessi del primo prototipo. Il prodotto deve comunicare subito "sto lavorando sul tuo computer locale" con progress visibile e dettagli controllati, non "sto mostrando pannelli tecnici".

## Prossimo blocco

### Auto-apprendimento come pagina fondativa

- Aggiunta la view `Apprendimento` come sezione di primo livello nella UI desktop.
- Separati i mock in `learningInsights` e `automationProposals`, pronti per essere sostituiti da read model Tauri.
- La pagina mostra cosa il sistema pensa di aver imparato: titolo, dominio privacy, cadenza, confidenza, stato e prove redatte.
- Ogni insight espone controlli espliciti: confermare, correggere o ignorare. Questo evita che l'auto-apprendimento diventi una scatola nera.
- Aggiunta una sezione di automatismi possibili con trigger, azioni previste, livello di autonomia, rischio e stato di attivazione.
- Esteso il contratto statico UI per rendere obbligatori view dedicata, habit card, automation proposal, evidence list, privacy control e layout dedicato.

Perche': l'auto-apprendimento e' una differenza centrale del prodotto, ma deve essere governabile. La UI deve rendere visibile non solo l'automazione proposta, ma anche il motivo per cui il sistema l'ha dedotta e il modo per correggerla prima che diventi comportamento.

## Prossimo blocco

### Allineamento Auto-apprendimento al Memory Core

- Riallineato il comportamento al piano originale del progetto: l'auto-apprendimento non introduce un core separato, ma passa da `Event Log`, `MemoryAgent`, `RoutineRecord`, `automation_candidates` e `MemoryFacade`.
- Cambiato `MemoryFacade::apply_extraction`: le memorie estratte dal `MemoryAgent` ora entrano come `candidate`, non `confirmed`.
- Aggiornato `MemoryFacade::context_pack`: il contesto operativo carica solo memorie `confirmed`; le candidate restano disponibili alla UI di apprendimento/review.
- Aggiunto `MemoryRefKind::Automation`.
- Aggiunti `AutomationCandidateRecord`, `AutomationCandidateCreateRequest`, `AutomationRiskLevel` e `AutomationCandidateStatus`.
- Aggiunta tabella SQLite `automation_candidates` e portata la schema version memoria a `3`.
- Aggiunta API `MemoryFacade::propose_automation`.
- Aggiunto `LearningUiReadModel`, che aggrega memorie candidate/confermate, routine candidate e proposte di automazione applicando privacy domain e sensitivity prima di esporre dati alla UI.
- Aggiunti test TDD:
  - `crates/memory/tests/extraction.rs`: MemoryAgent extraction resta candidate.
  - `crates/memory/tests/learning_ui.rs`: snapshot apprendimento, evidence refs, automation proposals e filtri privacy.
- Verifiche eseguite:
  - `cargo test -p local-first-memory`
  - `cargo test -p local-first-subagents`

Perche': il progetto aveva gia' definito il percorso corretto: osservare eventi, dedurre candidate, mostrare evidenze redatte, lasciare all'utente il controllo e solo poi trasformare pattern ricorrenti in automazioni approvate. Questo evita che la pagina Apprendimento sia un mock scollegato o che l'assistant trasformi inferenze in verita' operative senza review.

## Prossimo blocco

### Tauri Core Bridge V1

- Aggiunto stato applicativo locale in `apps/desktop/src-tauri/src/state.rs`.
- Aggiunti command Tauri in `apps/desktop/src-tauri/src/commands.rs`.
- Separati DTO e mapping in `apps/desktop/src-tauri/src/models.rs`.
- Separato bootstrap seeded locale in `apps/desktop/src-tauri/src/seed.rs`.
- Il bridge inizializza componenti core reali con store locali seeded:
  - `TaskStore` + `TaskUiReadModel`
  - `MemoryFacade` + `MemoryUiReadModel`
  - `ProcessManager` + `SidecarProcessCatalog`
  - `CapabilityRegistryStore`
- Esposti command:
  - `core_bridge_status`
  - `runtime_health_snapshot`
  - `process_check_health`
  - `process_start`
  - `process_stop`
  - `task_queue_snapshot`
  - `task_detail`
  - `memory_dashboard_snapshot`
  - `capability_snapshot`
- Aggiunti DTO serializzabili e redatti per evitare di esporre raw input, `secret_ref`, env, log raw o payload sensibili.
- Aggiunto wrapper TypeScript `apps/desktop/src/lib/coreBridge.ts` separato dai componenti React.
- Aggiornato `PROJECT.md` con lo stato reale del bridge.
- Verifiche eseguite:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `npm run typecheck`
  - `npm run build`
  - `cargo test --workspace`

Perche': prima di cablare l'auto-apprendimento serve un confine stabile tra UI e Rust Core. La UI deve poter leggere task, approvals, memoria, processi e capability da command reali, ma l'apprendimento resta ultimo perche' deve basarsi su eventi reali generati da browser, shell, task runtime e osservazione desktop.

## Prossimo blocco

### Local Computer Session Core

- Aggiunto crate `crates/local-computer-session`.
- Implementati contratti per:
  - sessione computer
  - superfici Browser/Shell/Files/Logs
  - eventi append-only
  - artifact
  - timeline UI
  - approval state
  - takeover state
- Implementato `LocalComputerSessionStore` SQLite con schema version, sessioni, eventi e artifact.
- Implementato `LocalComputerSessionManager` per creare sessioni, avviare superfici, aggiungere eventi, terminal output, artifact, richieste approval e takeover.
- Implementato `LocalComputerReadModel` con redazione prima della UI:
  - URL senza query o frammenti
  - terminal excerpt redatto
  - artifact senza path raw
  - timeline senza payload raw
  - errori redatti
- Implementata `ShellCommandPolicy` per classificare comandi read-only, write, network/install e destructive.
- Esteso `TaskRuntime::ResourceClass` con `computer_session` e `shell_process`, inclusi in Resource Governor e Task UI read model.
- Collegato il bridge Tauri con `local_computer_session_snapshot`.
- Aggiornato `apps/desktop/src/lib/coreBridge.ts` con il tipo snapshot Local Computer.
- Aggiornato `PROJECT.md`.
- Verifiche eseguite:
  - RED: `cargo test -p local-first-local-computer-session` falliva per API mancanti.
  - RED: `cargo test -p local-first-task-runtime --test contracts` falliva per risorse mancanti.
  - GREEN: `cargo test -p local-first-local-computer-session`
  - GREEN: `cargo test -p local-first-task-runtime`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`

Perche': la UI non deve cablare browser, shell e artifact come pannelli separati. Serve un read model unico, persistente e redatto che rappresenti il lavoro reale del computer locale durante task lunghi, con approval e takeover governabili.

## Prossimo blocco

### UI Chat collegata alla Local Computer Session

- La Chat non riceve piu' `computerSession` mock da `App`.
- Aggiunto mapper `apps/desktop/src/lib/localComputerViewModel.ts` per trasformare `CoreComputerSessionSnapshot` nel view model React `ComputerSession`.
- Il mapper conserva il contratto privacy:
  - usa `current_url_redacted`
  - usa `terminal_excerpt_redacted`
  - mostra artifact senza path raw
  - considera la timeline valida solo con `payload_redacted`
- `ChatView` carica `coreBridge.localComputerSession("computer_train_search")` e aggiorna la card ogni 4 secondi.
- In anteprima web senza Tauri viene mostrato un fallback esplicito, non un errore tecnico.
- Il detail panel Computer continua a usare tab Browser, Terminale, File e Log, ma ora legge superfici, timeline, artifact e terminal excerpt dal read model core.
- Aggiornato il contratto UI statico per impedire regressioni verso mock passati da `App`.
- Verifiche eseguite:
  - RED: `npm run test:ui-contract` falliva per cablaggio Tauri mancante.
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run build`
- Verifica browser:
  - viewport desktop 1440x900
  - activity card visibile
  - composer resta ancorato
  - panel Computer apribile senza cambiare route
  - fallback web chiaro quando il bridge Tauri non e' presente

Perche': questo e' il primo punto in cui la UI legge una sessione operativa reale dal Rust Core invece di affidarsi al mock. In Tauri l'utente puo' vedere il read model seeded e redatto; nel browser resta disponibile solo la preview grafica con messaggio esplicito.

## Prossimo blocco

### Local Computer Smoke Test reale da UI

- Aggiunto command Tauri `local_computer_run_smoke_test`.
- Il command esegue un percorso locale reale e controllato:
  - chiama il sidecar Browser Automation via stdio con `browser.health`;
  - esegue il comando shell read-only `date '+%Y-%m-%d %H:%M:%S %Z'`;
  - scrive eventi nella `LocalComputerSessionManager`;
  - aggiunge output terminale redatto;
  - registra artifact metadata `local-smoke-transcript.txt` senza path raw.
- Aggiunto bottone `Test reale` nella Local Computer activity card.
- Il bottone richiama `coreBridge.runLocalComputerSmokeTest(...)` e aggiorna subito la card con lo snapshot reale.
- Aggiunto test Rust `local_computer_smoke_test_records_real_shell_output`.
- Aggiornato il contratto UI per imporre che la Chat esponga un'azione reale e non solo il polling dello snapshot.
- Rigenerata la app Tauri debug apribile da:
  - `apps/desktop/src-tauri/target/debug/bundle/macos/Local First Assistant.app`
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml local_computer_smoke_test_records_real_shell_output` falliva per metodo mancante.
  - RED: `npm run test:ui-contract` falliva per azione UI mancante.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`
  - GREEN: `npm run tauri -- build --debug --bundles app --no-sign`

Perche': ora l'utente puo' fare un test reale end-to-end dentro la app Tauri: non e' ancora una prenotazione/browser task complesso, ma attraversa UI -> Tauri command -> runtime browser locale -> shell locale -> Local Computer read model -> UI.

## Prossimo blocco

### Composer cablato al Tauri Core

- Aggiunto modulo `apps/desktop/src-tauri/src/prompt_submission.rs`.
- Aggiunto command Tauri `submit_user_prompt`.
- Il composer React ora invia il prompt a `coreBridge.submitUserPrompt(...)`.
- La UI aggiunge il messaggio utente localmente e riceve dal core una risposta assistant.
- Il core non salva il prompt raw nel read model:
  - registra evento `user_prompt_received`;
  - payload UI sempre redatto;
  - conserva solo conteggio caratteri e metadati operativi.
- Primo handler deterministico reale storico:
  - in questo step iniziale il core riconosceva ora/data prima del Brain;
  - questo comportamento e' stato sostituito nel blocco "Composer compreso dal Brain".
- Aggiunto test Rust `submit_user_prompt_runs_local_time_request_without_storing_raw_prompt`.
- Aggiornato il contratto UI per imporre che il composer usi il command Tauri reale.
- Rigenerata e aperta la app Tauri debug.
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_user_prompt_runs_local_time_request_without_storing_raw_prompt` falliva per metodo mancante.
  - RED: `npm run test:ui-contract` falliva per command UI mancante.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run build`
  - GREEN: `npm run tauri -- build --debug --bundles app --no-sign`

Perche': ora l'utente puo' digitare davvero un prompt nella app. Non e' ancora il Brain completo, ma il circuito UI -> Tauri Core -> shell locale -> Local Computer Session -> chat e' reale e testabile.

## Prossimo blocco

### Fix sessione attiva non coerente con il prompt

- Rimosso il seed "treni Napoli-Milano" dal percorso chat di default.
- La sessione attiva e' ora `computer_active_prompt`, collegata al task `task_prompt_session`.
- Il task attivo seeded e' neutro: `local_prompt`, risorsa `shell_process`, rischio `low`.
- La chat iniziale ora mostra stato pronto per prompt locali, non una richiesta treni.
- La drawer mostra `Prompt locale`, non `Treni Napoli-Milano`.
- Il test `local_computer_snapshot_is_redacted_for_ui` verifica che lo snapshot default non contenga riferimenti treni/Napoli/Milano.
- Rigenerata e aperta la app Tauri debug.
- Verifiche eseguite:
  - `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - `npm run typecheck`
  - `npm run test:ui-contract`
  - `npm run build`
  - `npm run tauri -- build --debug --bundles app --no-sign`

Perche': il composer reale funzionava, ma la UX era contaminata da dati seeded della vecchia demo treni. Questo rendeva la timeline incoerente con prompt come "che ore sono?". Il percorso default deve essere neutro e solo i task effettivamente avviati devono aggiungere contesto specifico.

## Prossimo blocco

### Fix prompt locali e timeline chat

- Aggiunto handler locale per aritmetica binaria semplice nel command `submit_user_prompt`.
- `quanto fa 6*3` ora risponde `6 * 3 fa 18.` senza cadere nel placeholder `prompt_pending_brain`.
- Il calcolo registra evento `local_calculation_completed` nel read model con payload redatto.
- La timeline `InlineTimeline` non viene piu' renderizzata sotto ogni messaggio assistant; ora appare una sola volta nel thread prima della card Computer.
- Aggiunto test Rust `submit_user_prompt_answers_simple_arithmetic_locally`.
- Aggiornato contratto UI statico per impedire che la timeline venga reintrodotta come elemento ripetuto per ogni messaggio.
- Rigenerata e aperta la app Tauri debug.
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml submit_user_prompt_answers_simple_arithmetic_locally` falliva per fallback Brain.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`
  - GREEN: `npm run tauri -- build --debug --bundles app --no-sign`

Perche': il composer non deve sembrare rotto per prompt banali. Questo e' stato lo step intermedio prima del collegamento al Brain; la UI inoltre non deve duplicare la timeline sotto ogni risposta.

## Prossimo blocco

### Composer compreso dal Brain

- Introdotto il trait `PromptBrain` nel Tauri Core.
- Introdotto `BrainUnderstanding`, JSON strutturato e validato con route:
  - `direct_answer`
  - `local_time`
  - `local_calculation`
  - `needs_planning`
  - `ask_clarification`
  - `refuse`
- Introdotto `RuntimePromptBrain`, che chiama il runtime locale Gemma 4 via `JsonRuntime` su `http://127.0.0.1:8765/generate_json`.
- `submit_user_prompt` non interpreta piu' semanticamente il prompt con regole testuali locali.
- Ora/data e calcoli vengono eseguiti solo dopo che il Brain ha restituito una route strutturata.
- I test usano un Brain finto per provare il contratto senza dipendere dal runtime MLX live:
  - prompt inglese `what time is it?` classificato come `local_time`;
  - prompt inglese in parole `what is six times three?` classificato come `local_calculation`.
- Se il Brain locale non e' raggiungibile, il core registra `brain_understanding_failed` e risponde chiedendo di avviare Gemma 4, senza tornare a riconoscimenti euristici nascosti.
- Dopo test live su Gemma, i campi di calcolo sono stati rinominati da `left/operator/right` a `calculation_left/calculation_operator/calculation_right`: `left/right` venivano interpretati dal modello come origine/destinazione in prompt di viaggio.
- Verifica live su `http://127.0.0.1:8765/generate_json` con modello gia' caricato:
  - `che ore sono?` -> `local_time`
  - `what time is it?` -> `local_time`
  - `quanto fa 6*3?` -> `local_calculation` con `6 * 3`
  - `what is six times three?` -> `local_calculation` con `6 * 3`
  - `quanto fa sette per otto?` -> `local_calculation` con `7 * 8`
  - `cerca un treno da Napoli a Milano per il 10 giugno` -> `needs_planning`
  - `send an email to Marco tomorrow morning with the meeting summary` -> `needs_planning`
  - `spiegami in una frase cos'e' una sessione computer locale` -> `direct_answer`
- Verifiche eseguite:
  - RED: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_submission::tests::english_time_request_is_understood_by_brain_not_prompt_text_rules` falliva per trait/tipi mancanti.
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml prompt_submission::tests`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`

Perche': la comprensione deve essere language-agnostic e centralizzata. Regex o keyword nel composer creano casi incoerenti tra italiano, inglese e richieste naturali; il core deve invece chiedere al Brain un'intenzione strutturata, validarla e poi eseguire solo azioni locali/policy-safe.

## Prossimo blocco

### Planner operativo per task da prompt

- `needs_planning` non resta piu' solo `prompt_pending_brain`.
- Aggiunto `PromptTaskPlanner` nel Tauri Core.
- Aggiunto `RuntimePromptTaskPlanner`, che usa Gemma locale via `/generate_json` per produrre un piano operativo strutturato.
- Aggiunti contratti UI-safe:
  - `PromptExecutionPlan`
  - `PromptPlanStep`
  - `title`, `summary`, `risk_level`
  - step con `surface`, `action_kind`, `requires_user_approval`
- `submit_user_prompt` ora:
  - comprende la richiesta con `PromptBrain`;
  - se la route e' `needs_planning`, chiede un piano al planner;
  - registra `operational_plan_created` nella Local Computer Session;
  - registra gli step come `operational_plan_step_ready`;
  - avvia la surface Browser se almeno uno step usa `surface=browser`.
- `DesktopCoreState` materializza il piano nel Durable Task Runtime:
  - un task per ogni step;
  - checkpoint redatto per ogni task;
  - resource class coerente con la surface (`browser_session`, `shell_process`, `filesystem_io`, `background_maintenance`);
  - approval gate reale via `ApprovalGate` per step con `requires_user_approval=true`.
- Aggiornato il type bridge TypeScript con `CorePromptExecutionPlan`.
- Test live con Gemma su richiesta:
  - `Prenota un treno da Napoli a Milano il 10 giugno 2026 alle 08:30, preferibilmente alta velocità, senza completare il pagamento senza conferma.`
  - output valido: piano da 5 step con ricerca browser, confronto opzioni, conferma selezione, booking draft e approval finale prima del pagamento.
- Verifiche eseguite:
  - RED/GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml planning`
  - GREEN: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`

Perche': capire la richiesta non basta. Per essere utile il sistema deve trasformare una richiesta naturale in lavoro persistente, visibile e governato: piano, task, risorse e approval. Il primo livello non completa ancora una prenotazione reale, ma crea task durevoli e blocchi di sicurezza reali che il runtime browser potra' eseguire nel layer successivo.

## Prossimo blocco

### Timeline Computer collapsabile

- La timeline `InlineTimeline` della Chat ora e' collapsabile e parte chiusa di default.
- In stato compatto mostra solo gli ultimi due eventi, mantenendo visibile lo stato operativo senza occupare troppo spazio nel thread.
- Il toggle espone `aria-expanded` e permette di mostrare/nascondere i dettagli senza aprire il pannello Computer.
- Aggiunti hook CSS dedicati (`timeline-collapsed`, `timeline-header`, `timeline-toggle`) per mantenere la UX sobria e non tecnica.
- Aggiornato il contratto UI statico per rendere obbligatoria la timeline collapsabile e impedire regressioni verso timeline sempre aperta o duplicata.
- Verifiche eseguite:
  - RED: `npm run test:ui-contract` falliva per stato collapse mancante.
  - GREEN: `npm run test:ui-contract`
  - GREEN: `npm run typecheck`
  - GREEN: `npm run build`

Perche': la timeline e' utile per fiducia e audit, ma non deve diventare rumore visivo nella chat. Il default compatto segue la direzione Manus: informazioni progressive, dettagli disponibili on demand e canvas centrale piu' leggibile.

## Prossimo blocco

### Gestione chat e thread operativi

- Aggiunto il concetto di chat thread nel Tauri Core.
- Ogni thread ha:
  - `thread_id`
  - titolo/sottotitolo UI-safe
  - `computer_session_id`
  - `task_id`
  - contatore messaggi
  - timestamp aggiornamento
- Il thread default resta `thread_active_prompt` collegato a `computer_active_prompt`.
- `create_chat_thread` crea una nuova chat pulita e una nuova Local Computer Session isolata, senza ereditare terminal output o eventi prompt precedenti.
- La UI React tiene i messaggi separati per thread e il bottone `Nuovo compito` crea/seleziona il nuovo thread.
- La sidebar mostra i thread reali invece della lista mock dei task.
- Il titolo del thread viene aggiornato localmente dal primo messaggio utente, cosi' la lista resta leggibile senza esporre payload raw nel core.
- Decisione architetturale: la chat non decide tool, MCP o browser. Passa prompt + thread/session context al Core; il Brain produce intenzione e piano, poi il Capability Layer/Task Runtime scegliera' uno o piu' strumenti.

Perche': prima di eseguire task reali serve separare bene le conversazioni. Senza thread isolati, test su ora, calcoli, treni e browser si contaminano nella stessa timeline e rendono difficile capire se il sistema sta agendo sul contesto giusto.

## Prossimo blocco

### Mappa di sistema e focus progetto

- Creato `docs/architecture/system-map.md` come documento guida operativo.
- Il documento esplicita:
  - scopo prodotto;
  - flusso principale utente -> UI -> Core -> Brain -> Task Runtime -> tool -> Local Computer;
  - responsabilita' e non-responsabilita' di ogni componente;
  - stato attuale per UI, thread, Brain, task runtime, resource governor, capability, browser, Local Computer, memoria, subagenti, process manager e learning;
  - sequenza aggiornata di implementazione;
  - regole architetturali da non violare;
  - cosa e' base production-ready e cosa non e' ancora end-to-end production-ready.
- Decisione: `docs/architecture/system-map.md` e `docs/work-memory.md` devono restare allineati. Ogni blocco futuro deve aggiornare la memoria lavoro e, se cambia architettura o ordine, anche la system map.
- Decisione: i prossimi lavori devono dichiarare quale parte della mappa stanno chiudendo. Questo evita di saltare tra UI, Brain, browser e learning senza completare i pezzi base.

Perche': il progetto ha molti componenti separati ma interdipendenti. Senza una mappa stabile rischiamo di implementare feature isolate senza arrivare al comportamento finale: assistente locale che capisce, pianifica, usa strumenti, governa risorse, mostra il Local Computer e impara in modo controllato.

## Prossimo blocco

- Collegare Tasks/Approvals ai command `task_queue_snapshot` e `task_detail`.
- Collegare Connections/Settings ai command capability/runtime esistenti.
- Collegare il Browser Automation Runtime alla `LocalComputerSessionManager`, cosi' le azioni reali producono eventi, artifact e preview nella stessa card.
- Collegare `needs_planning` del composer al planner OrchestratorBrain completo per trasformare prompt generici in piani/tool/task invece dell'attuale stato di attesa `prompt_pending_brain`.
- Lasciare `LearningUiReadModel` e azioni di feedback utente per la fine, quando gli eventi PC reali saranno disponibili.
