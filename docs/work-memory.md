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

## Prossimo blocco

- Implementare transport MCP stdio persistente con process lifecycle locale.
- Solo dopo, aggiungere adapter Composio managed opt-in.
