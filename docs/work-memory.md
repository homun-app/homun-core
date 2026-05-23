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

## Prossimo blocco

- Aggiungere salvataggio di `SubagentReview` come vista/record dedicato o come risultato tipizzato.
- Aggiungere query audit utili: risultati per workflow, ultimo risultato per task, errori recenti.
