# Workflow

## Panoramica

Il sistema Workflow di Homun e un orchestratore persistente di task multi-step. Evolve il pattern fire-and-forget dei subagent in un motore durevole dove ogni passo e persistito in SQLite, sopravvive ai riavvii, supporta approval gate per conferma umana e passaggio di contesto tra step.

Un workflow e una sequenza ordinata di step (massimo 20), ciascuno eseguito dal proprio agent loop con una sessione indipendente. I risultati di ogni step vengono propagati ai successivi tramite un contesto condiviso JSON. L'esecuzione e sequenziale: uno step alla volta, con retry configurabili e possibilita di pausa per approvazione.

## Funzionalita

### 1. Workflow Engine — Orchestrazione Multi-Step e Ciclo di Vita

#### Comportamento Atteso

- L'utente (o l'LLM tramite il tool `workflow`) crea un workflow specificando nome, obiettivo e lista di step.
- Alla creazione il workflow viene immediatamente avviato: lo stato passa da `pending` a `running`.
- L'engine esegue gli step in sequenza dentro un loop asincrono (`run_workflow_loop`). Ogni step viene processato tramite `AgentLoop::process_message()` con una sessione dedicata (`workflow:{id}:step:{idx}`).
- Il workflow attraversa i seguenti stati:
  - **pending** — creato ma non ancora avviato (stato iniziale in DB).
  - **running** — in esecuzione attiva.
  - **paused** — in attesa di approvazione umana su uno step.
  - **completed** — tutti gli step completati con successo.
  - **failed** — uno step ha esaurito i retry.
  - **cancelled** — cancellato manualmente dall'utente.
- Gli stati terminali sono: `completed`, `failed`, `cancelled`. Un workflow terminale puo essere riavviato (reset completo a step 0) o eliminato.
- L'ID del workflow e un UUID troncato a 8 caratteri.
- Limite: minimo 1 step, massimo 20 step per workflow.

**Operazioni disponibili:**
- **create_and_start**: crea e avvia immediatamente.
- **approve_and_resume**: riprende un workflow in pausa dopo approvazione. Verifica che lo stato sia `paused`.
- **cancel**: interrompe un workflow attivo, abortisce il task in esecuzione (`.abort()` sul JoinHandle), marca gli step pending come `skipped`.
- **delete**: rimuove un workflow terminale dal DB (cascade su steps). Non elimina workflow attivi.
- **restart**: resetta un workflow terminale (stato, contesto, tutti gli step tornano `pending`), poi lo riavvia.
- **list**: elenca i workflow, con filtro opzionale per stato.
- **status**: restituisce un singolo workflow con tutti i suoi step.

#### Dettagli Tecnici

- **Moduli/file**: `src/workflows/engine.rs` (motore), `src/workflows/mod.rs` (tipi), `src/workflows/db.rs` (persistenza)
- **Flusso dati**: `WorkflowCreateRequest` -> `insert_workflow()` -> `start_workflow()` -> `tokio::spawn(run_workflow_loop)` -> per ogni step: `execute_step()` -> `AgentLoop::process_message()`
- **Concorrenza**: i workflow attivi sono tracciati in `Arc<Mutex<HashMap<String, JoinHandle<()>>>>`. Ogni workflow gira in un task Tokio separato.
- **Contesto condiviso**: `context_json` (colonna `workflows`) e un oggetto JSON. Dopo ogni step completato, il risultato (troncato a 2000 caratteri) viene inserito come `step_{idx}: { name, result }`.
- **Prompt per step**: costruito da `build_step_prompt()`. Include: intestazione workflow (nome, obiettivo, step corrente/totale), guida ai tool disponibili (web_search, browser, web_fetch se presenti), risultati degli step precedenti (troncati a 500 caratteri ciascuno), istruzione dello step corrente.

**Tabelle DB:**
- `workflows`: `id`, `name`, `objective`, `status`, `created_by`, `deliver_to`, `automation_id`, `automation_run_id`, `context_json`, `current_step_idx`, `created_at`, `updated_at`, `completed_at`, `error`, `profile_id`, `user_id`
- `workflow_steps`: `id`, `workflow_id` (FK con CASCADE), `idx`, `name`, `instruction`, `status`, `approval_required`, `result`, `error`, `started_at`, `completed_at`, `retry_count`, `max_retries`, `agent_id`

**Endpoint API:**
- `GET /api/v1/workflows?status={status}&profile={slug}` — lista workflow con statistiche aggregate (total, running, paused, completed, failed). Filtro profilo opzionale.
- `POST /api/v1/workflows` — crea un nuovo workflow (richiede auth write).
- `GET /api/v1/workflows/{id}` — dettaglio singolo workflow con step.
- `POST /api/v1/workflows/{id}/approve` — approva e riprende (auth write).
- `POST /api/v1/workflows/{id}/cancel` — cancella (auth write).
- `POST /api/v1/workflows/{id}/delete` — elimina (auth write).
- `POST /api/v1/workflows/{id}/restart` — riavvia da zero (auth write).

#### Dipendenze

- **Da cosa dipende**: `AgentRegistry` (per risolvere l'agent di ogni step), `Database` (persistenza SQLite), `mpsc::Sender<WorkflowEvent>` (notifiche al gateway).
- **Cosa dipende da questa feature**: il gateway (`agent/gateway.rs`) consuma gli eventi, il tool `workflow` espone l'engine all'LLM, la Web UI visualizza i workflow, il sistema automazioni puo creare workflow.

---

### 2. Step di Workflow — Tipi, Esecuzione, Stato

#### Comportamento Atteso

- Ogni step e definito da: nome breve, istruzione dettagliata, flag `approval_required`, numero massimo di retry (default: 1), e `agent_id` opzionale (default: `"default"`).
- Uno step attraversa i seguenti stati:
  - **pending** — in attesa di esecuzione.
  - **running** — in esecuzione (marcato appena prima di invocare l'agent).
  - **completed** — eseguito con successo, risultato salvato.
  - **failed** — fallito dopo aver esaurito i retry.
  - **skipped** — saltato perche il workflow e stato cancellato o ha fallito prima di raggiungere questo step.
- L'output testuale dello step e salvato nel campo `result`. L'ultimo step completato fornisce il "summary" del workflow.
- Ogni step esegue in una sessione LLM indipendente. La sessione e identificata da `workflow:{workflow_id}:step:{step_idx}`.
- Il prompt include esplicitamente la guida all'uso dei tool ("You MUST use your tools to complete this step") e i risultati degli step precedenti come contesto.

**Routing per agent (MAG-4):**
- Ogni step puo specificare un `agent_id` diverso (es. `"coder"`, `"researcher"`).
- L'engine risolve l'agent tramite `AgentRegistry::get()`. Se l'agent specificato non esiste, usa l'agent default.
- Questo permette pipeline multi-agent: ad esempio step 1 con agent "researcher" per raccogliere dati, step 2 con agent "coder" per implementare.

#### Dettagli Tecnici

- **Moduli/file**: `src/workflows/mod.rs` (struct `WorkflowStep`, `StepDefinition`, enum `StepStatus`), `src/workflows/engine.rs` (funzione `execute_step`), `src/workflows/db.rs` (operazioni CRUD step)
- **Flusso esecuzione step**:
  1. `update_step_status(Running)` — marca come in esecuzione, registra `started_at`.
  2. Invia evento `StepStarted` al gateway.
  3. Risolve l'agent tramite `registry.get(&step.agent_id)`.
  4. Costruisce il prompt con `build_step_prompt()`.
  5. Chiama `agent.process_message()` con session key dedicata.
  6. Se successo: `update_step_status(Completed)`, salva `result`, aggiorna `context_json`, invia `StepCompleted`, avanza `current_step_idx`.
  7. Se errore: controlla `retry_count < max_retries`. Se si, incrementa retry e riporta a `Pending` (il loop riesegue). Se no, fallisce il workflow intero.
- **ID step**: formato `{workflow_id}-s{idx}` (es. `a1b2c3d4-s0`).
- **Vincolo DB**: `UNIQUE(workflow_id, idx)` — un solo step per posizione.
- **Troncamento risultati**: i risultati nel contesto condiviso sono troncati a 2000 caratteri; i risultati mostrati nel prompt degli step successivi sono troncati a 500 caratteri.

**Tabella DB**: `workflow_steps` (vedi sezione 1 per schema completo).

#### Dipendenze

- **Da cosa dipende**: `AgentRegistry` (per agent routing), `Database` (persistenza stato step).
- **Cosa dipende da questa feature**: `WorkflowEngine` (orchestrazione), Web UI (visualizzazione timeline step), prompt builder (passaggio risultati tra step).

---

### 3. Approval Gates — Pause per Approvazione Utente

#### Comportamento Atteso

- Uno step con `approval_required: true` blocca l'esecuzione del workflow prima di essere eseguito.
- Quando l'engine raggiunge un approval gate:
  1. Marca il workflow come `paused`.
  2. Invia un evento `ApprovalNeeded` con nome workflow, indice step, nome step e istruzione.
  3. Il loop di esecuzione termina (`return Ok(())`).
- L'utente puo approvare tramite:
  - **Web UI**: bottone "Approve" nella lista workflow o "Approve Next Step" nel dettaglio.
  - **API REST**: `POST /api/v1/workflows/{id}/approve`.
  - **Tool LLM**: azione `approve` nel tool `workflow`.
  - **Messaggio su canale**: la notifica suggerisce di rispondere "approve {nome_workflow}" o "cancel {nome_workflow}".
- Dopo l'approvazione, `approve_and_resume()` verifica che lo stato sia `paused`, poi chiama `start_workflow()` che riprende il loop dallo step corrente.
- Lo step con approval viene eseguito normalmente dopo la ripresa (lo stato e ancora `Pending`, ma il workflow non e piu `Paused`, quindi il gate non blocca di nuovo).

**Edge case:**
- Se si tenta di approvare un workflow non in pausa, viene restituito un errore con lo stato corrente.
- Se il workflow e stato cancellato durante la pausa, l'approvazione fallisce perche lo stato e terminale.

#### Dettagli Tecnici

- **Moduli/file**: `src/workflows/engine.rs` (logica gate in `run_workflow_loop`, metodo `approve_and_resume`), `src/workflows/mod.rs` (evento `ApprovalNeeded`)
- **Flusso**:
  1. Nel loop, se `step.approval_required && step.status == StepStatus::Pending`: pausa.
  2. Lo step non viene mai portato a `Running` prima dell'approvazione.
  3. Al resume, il loop riparte: ricarica il workflow dal DB, trova lo step corrente, questa volta il workflow non e `Paused` (e stato marcato `Running` da `start_workflow()`), quindi procede con l'esecuzione.
- **Formato notifica**: `[Workflow] "{nome}" paused -- approval needed for step {idx} "{step_name}": {istruzione}. Reply "approve {nome}" to continue or "cancel {nome}" to abort.`

#### Dipendenze

- **Da cosa dipende**: `WorkflowEvent` channel (per notifica), gateway event loop (per delivery).
- **Cosa dipende da questa feature**: Web UI (bottoni approve/cancel), API REST (endpoint approve).

---

### 4. Resume-on-Boot — Persistenza e Ripresa Workflow Interrotti

#### Comportamento Atteso

- Quando il gateway si avvia, il `WorkflowEngine` cerca i workflow in stato `running`, `pending` o `paused` e li riprende automaticamente.
- I workflow `running` o `pending` vengono riavviati dal loro step corrente (gli step gia completati vengono saltati).
- I workflow `paused` vengono ripresi: rientrano nel loop ma si fermano immediatamente all'approval gate (comportamento identico alla prima pausa).
- Il resume avviene in un task separato all'avvio del gateway, prima del loop eventi workflow.
- Il numero di workflow ripresi viene loggato.

**Edge case:**
- Se un workflow era `running` quando il processo e stato terminato, lo step in esecuzione non ha un risultato salvato. Al resume, lo step viene rieseguito (il suo stato e `Running` nel DB, ma il loop salta gli step `Completed` e riesegue quelli non completati).
- Se il resume fallisce per un singolo workflow, l'errore viene loggato ma gli altri workflow vengono comunque ripresi.

#### Dettagli Tecnici

- **Moduli/file**: `src/workflows/engine.rs` (`resume_on_startup`), `src/workflows/db.rs` (`load_resumable_workflows`), `src/agent/gateway.rs` (invocazione al boot)
- **Query DB**: `SELECT ... FROM workflows WHERE status IN ('running', 'pending', 'paused') ORDER BY created_at ASC`
- **Flusso nel gateway**: nel blocco di setup del workflow event loop, prima di entrare nel loop `wf_rx.recv()`, viene spawnato un task che chiama `engine.resume_on_startup()`.
- **Robustezza**: ogni workflow viene ripreso individualmente. Il fallimento di uno non impedisce la ripresa degli altri.

#### Dipendenze

- **Da cosa dipende**: `Database` (query workflow resumabili), `AgentRegistry` (per rieseguire step).
- **Cosa dipende da questa feature**: nessuna dipendenza diretta — e una feature di resilienza trasparente.

---

### 5. Workflow Events — Notifiche Progresso al Frontend

#### Comportamento Atteso

- Il `WorkflowEngine` emette eventi tramite un canale `mpsc::Sender<WorkflowEvent>` ogni volta che cambia lo stato di un workflow o di uno step.
- Il gateway consuma questi eventi nel workflow event loop e li instrada ai canali di destinazione.
- Ogni workflow ha un campo `deliver_to` (formato `canale:chat_id`, es. `telegram:123456`, `web:web`) che determina dove inviare le notifiche.

**5 tipi di evento:**
1. **StepStarted** — emesso quando inizia l'esecuzione di uno step. Include workflow_id, nome, step_idx, total_steps, step_name.
2. **StepCompleted** — emesso al completamento di uno step. Include un `result_summary` troncato a 200 caratteri.
3. **ApprovalNeeded** — emesso quando il workflow si ferma per approvazione. Include l'istruzione dello step.
4. **WorkflowCompleted** — emesso al completamento di tutti gli step. Il `summary` e il risultato dell'ultimo step completato.
5. **WorkflowFailed** — emesso quando il workflow fallisce. Include l'errore.

**Delivery:**
- La notifica testuale (`format_notification()`) viene inviata come messaggio al canale specificato in `deliver_to` tramite `route_outbound()`.
- Per il canale `web`: viene anche inviato un evento strutturato `workflow_progress` via WebSocket (stream SSE) con dati JSON per il rendering di un indicatore di progresso (donut chart). I dati JSON (`to_progress_json()`) includono: `workflow_id`, `workflow_name`, `status`, `completed_steps`, `total_steps`, `current_step`.

#### Dettagli Tecnici

- **Moduli/file**: `src/workflows/mod.rs` (enum `WorkflowEvent`, metodi `format_notification`, `to_progress_json`, `deliver_to`, `workflow_id`, `workflow_name`), `src/agent/gateway.rs` (loop eventi, righe ~1617-1670)
- **Flusso dati**: `WorkflowEngine` -> `mpsc::Sender<WorkflowEvent>` -> gateway workflow loop -> parsing `deliver_to` (`rsplit_once(':')`) -> per web: invio `StreamMessage` con `event_type: "workflow_progress"` + invio `OutboundMessage` testuale -> per altri canali: solo `OutboundMessage` testuale tramite `route_outbound()`.
- **Shutdown**: il workflow loop viene abortito durante lo shutdown graceful del gateway.

#### Dipendenze

- **Da cosa dipende**: `mpsc` channel Tokio, `StreamMessage` bus (per eventi web), `route_outbound()` (per delivery su canali).
- **Cosa dipende da questa feature**: Web UI (`workflows.js` polling ogni 15 secondi), frontend WebSocket (eventi `workflow_progress`), canali di messaggistica (notifiche testuali).

---

### 6. Workflow Tool — Interfaccia LLM per Creare e Gestire Workflow

#### Comportamento Atteso

- Il tool `workflow` permette all'LLM di creare e gestire workflow durante una conversazione.
- Supporta 7 azioni: `create`, `list`, `status`, `approve`, `cancel`, `restart`, `delete`.

**Azione `create`:**
- Parametri obbligatori: `name`, `objective`, `steps` (array di oggetti con `name` e `instruction`).
- Parametri opzionali per step: `approval_required` (bool, default false), `max_retries` (int, default 1), `agent_id` (string, default "default").
- Parametro opzionale: `deliver_to` (default: canale e chat_id correnti dal `ToolContext`).
- Restituisce l'ID del workflow creato e un messaggio di conferma.

**Azione `list`:**
- Parametro opzionale `filter`: `all`, `active`, `paused`, `completed`, `failed`, `cancelled`.
- `active` mappa allo stato DB `running`.
- Mostra: nome, ID, step completati/totali, stato.

**Azione `status`:**
- Richiede `workflow_id`.
- Mostra: header (nome, stato, obiettivo, data creazione, errore), lista step con icone stato (`[done]`, `[running]`, `[failed]`, `[skipped]`, `[pending]`), flag approval, risultato troncato a 100 char, errore.

**Azioni `approve`, `cancel`, `restart`, `delete`:**
- Richiedono `workflow_id`.
- Delegano direttamente ai metodi corrispondenti del `WorkflowEngine`.

**Late binding:**
- Il tool usa il pattern `OnceCell` per ricevere il riferimento al `WorkflowEngine` dopo la sua inizializzazione (il WorkflowEngine dipende dall'AgentLoop che e creato dopo il tool registry).

#### Dettagli Tecnici

- **Moduli/file**: `src/tools/workflow.rs`
- **Schema parametri**: JSON Schema con `action` (enum), `name`, `objective`, `steps` (array), `deliver_to`, `workflow_id`, `filter`.
- **Contesto**: usa `ToolContext` per `channel`, `chat_id`, `profile_id`, `user_id`. Il `deliver_to` di default e `{ctx.channel}:{ctx.chat_id}`.
- **Gestione errori**: tutti gli errori vengono restituiti come `ToolResult::error()` (non come `Err`), cosi l'LLM riceve il messaggio di errore come output del tool invece di un'eccezione.

#### Dipendenze

- **Da cosa dipende**: `WorkflowEngine` (via `Arc<OnceCell<Arc<WorkflowEngine>>>`), `ToolContext` (per canale/chat correnti).
- **Cosa dipende da questa feature**: il sistema di cognizione (seleziona il tool quando rileva task multi-step), il tool registry (registrazione).

---

### 7. Link Automazione-Workflow — Collegamento con Sistema Automazioni

#### Comportamento Atteso

- Un'automazione puo contenere step workflow (`workflow_steps_json` nella tabella `automations`). Quando lo scheduler esegue un'automazione multi-step, crea un workflow collegato.
- Il workflow creato registra `automation_id` e `automation_run_id` per tracciabilita.
- Al completamento del workflow (successo o fallimento), il motore notifica il sistema automazioni tramite `evaluate_and_complete_automation_run()`. Questo permette al sistema di trigger (on_change, contains) di valutare il risultato e completare la run dell'automazione.
- Il risultato del workflow (summary dell'ultimo step completato) diventa il risultato della run dell'automazione.

**Flusso automazione -> workflow:**
1. Lo scheduler rileva un'automazione con `workflow_steps_json`.
2. La funzione `build_effective_prompt_from_row()` compone un prompt dai singoli step (formato: `1. nome: istruzione`).
3. Il workflow viene creato con `automation_id` e `automation_run_id` impostati.
4. Al completamento, `complete_workflow()` chiama `evaluate_and_complete_automation_run()` con il summary.
5. Al fallimento, il gestore errore in `run_workflow_loop` chiama la stessa funzione con `is_error: true`.

**Tracciabilita nella UI:**
- L'API workflow list include `automation_id` nei dati restituiti, permettendo alla UI di mostrare il collegamento.

#### Dettagli Tecnici

- **Moduli/file**: `src/workflows/engine.rs` (callback completamento in `complete_workflow` e gestore errori in `run_workflow_loop`), `src/workflows/mod.rs` (campi `automation_id`, `automation_run_id` in `Workflow` e `WorkflowCreateRequest`), `src/workflows/db.rs` (persistenza dei campi), `src/scheduler/automations.rs` (`build_effective_prompt_from_row`, `evaluate_and_complete_automation_run`)
- **Migrazioni DB**:
  - `014_automation_workflow.sql`: aggiunge `workflow_steps_json TEXT` alla tabella `automations`.
  - `032_workflow_automation_link.sql`: aggiunge `automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL` e `automation_run_id TEXT` alla tabella `workflows`, con indice.
- **ON DELETE SET NULL**: se un'automazione viene eliminata, i workflow collegati rimangono ma perdono il riferimento (il campo diventa NULL).

#### Dipendenze

- **Da cosa dipende**: `scheduler/automations.rs` (trigger e run management), `WorkflowEngine` (esecuzione).
- **Cosa dipende da questa feature**: il sistema di automazioni (per completamento run), la Web UI (per mostrare il collegamento).

---

## Migrazioni DB

| Migrazione | Descrizione |
|---|---|
| `013_workflows.sql` | Tabelle `workflows` e `workflow_steps` con schema base |
| `014_automation_workflow.sql` | Aggiunge `workflow_steps_json` a `automations` |
| `026_step_agent_id.sql` | Aggiunge `agent_id` a `workflow_steps` (MAG-4) |
| `032_workflow_automation_link.sql` | Aggiunge `automation_id` e `automation_run_id` a `workflows` con FK e indice |
| `036_profile_scoping_phase2.sql` | Aggiunge `profile_id` a `workflows` con FK e indice |
| `037_user_profile_scoping.sql` | Aggiunge `user_id` a `workflows` con FK e indice |

## Frontend (Web UI)

Il file `static/js/workflows.js` implementa la pagina workflow con:

- **Statistiche aggregate**: contatori total, running, completed, failed.
- **Lista workflow**: ordinata con attivi prima, poi per data creazione decrescente. Ogni riga mostra nome, badge stato, progresso step, obiettivo troncato, data.
- **Bottoni contestuali**: Approve (se paused), Cancel (se attivo), Restart e Delete (se terminale).
- **Dettaglio workflow**: header con nome, stato, obiettivo; timeline step con icone stato, badge approval, istruzione troncata, risultato, errore, timestamp.
- **Form creazione**: nome, obiettivo, delivery target (dropdown caricato da API automations targets), step builder con nome, istruzione, checkbox approval. Pannello togglabile.
- **Polling**: aggiornamento automatico ogni 15 secondi.
- **Filtro profilo**: integrazione con topbar globale per filtrare per profilo.
