# Automazioni e Scheduling

## Panoramica

Il sistema di automazioni di Homun consente di creare task ricorrenti che vengono eseguiti automaticamente su schedule (cron, intervallo, one-shot). Ogni automazione ha un prompt che viene inviato all'agent loop per l'esecuzione, con supporto per trigger condizionali (notifica solo quando l'output cambia o contiene un certo testo), workflow multi-step, validazione delle dipendenze, e un builder visuale con canvas SVG in stile n8n.

L'architettura segue un pattern a due percorsi di esecuzione unificati: le automazioni prompt-based inviano un `CronEvent` attraverso il message bus verso il gateway/agent loop, mentre le automazioni workflow-based creano direttamente un workflow tramite `WorkflowEngine`. Entrambi i percorsi convergono sulla stessa logica di valutazione trigger e completamento run (`evaluate_and_complete_automation_run`).

---

## 1. Automations Builder

### Comportamento Atteso
- L'utente crea automazioni tramite un builder visuale a canvas SVG (stile n8n) nella Web UI
- Il builder ha tre aree: palette nodi (sinistra), canvas drag-and-drop (centro), inspector proprietà (destra)
- I nodi si trascinano dalla palette al canvas; le connessioni si creano tramite drag dai connettori di output ai connettori di input
- I nodi sono liberamente posizionabili nel canvas e selezionabili per configurazione nell'inspector
- L'inspector mostra campi specifici per tipo di nodo, con validazione real-time
- Il builder supporta sia la creazione di nuove automazioni sia l'editing di automazioni esistenti (`editingId`)
- Pulsante "Save" serializza nodi ed edge come `flow_json` e genera `workflow_steps` per l'esecuzione
- Vista alternativa: lista automazioni con editor inline per modifiche rapide (nome, prompt, schedule, trigger, deliver_to, workflow steps)

#### Input
- Drag-and-drop nodi dalla palette al canvas
- Collegamento nodi tramite connettori (bezier paths)
- Configurazione proprietà nel pannello inspector
- Generazione da linguaggio naturale via prompt bar

#### Output
- `flow_json`: grafo visuale serializzato (`FlowGraph` con `nodes[]` e `edges[]`)
- `workflow_steps`: array di step per l'esecuzione runtime
- Automazione persistita nella tabella `automations`

#### Stati
- **List view**: lista automazioni con mini flow preview, badge stato, azioni rapide
- **Builder view**: canvas con palette, inspector, prompt bar
- **Editing mode**: builder precompilato con dati automazione esistente

#### Edge case
- Canvas vuoto senza nodi trigger: la validazione flow-level blocca il salvataggio
- Nodi sconnessi: permessi ma segnalati dalla validazione
- Automazione con `flow_json` nullo: viene derivato automaticamente da `derive_flow()` al momento del caricamento

### Dettagli Tecnici
- **Moduli**: `static/js/automations.js` (oggetto `Builder`), `static/js/flow-renderer.js` (rendering SVG), `static/js/auto-validate.js` (validazione)
- **Flusso dati**: Builder.nodes/edges -> serializzazione JSON -> POST/PATCH `/api/v1/automations` -> DB `automations.flow_json`
- **Rendering**: SVG puro (namespace `http://www.w3.org/2000/svg`), no dipendenze esterne. Layout DAG calcolato con BFS topologico
- **Drag-and-drop**: eventi nativi HTML5 (`dragstart`, `dragover`, `drop`) per palette; `mousedown/move/up` per spostamento nodi nel canvas
- **Connessioni**: bezier curves con formula `M x1,y1 C (x1+dx),y1 (x2-dx),y2 x2,y2`, marker freccia SVG
- **Temi**: supporto dark/light con colori adattivi (`isDark()` controlla la classe CSS `dark`)

### Dipendenze
- Dipende da: `flow-renderer.js`, `auto-validate.js`, `schema-form.js` (per parametri tool), `mcp-loader.js`, `model-loader.js`
- Dipende da API: `/v1/automations`, `/v1/tools`, `/v1/skills`, `/v1/automations/targets`
- Cosa dipende da questa: nessun modulo dipende direttamente dal Builder

---

## 2. Nodi Automazione

### Comportamento Atteso
- Il sistema supporta 13 tipi di nodi raggruppati in 4 categorie:
  - **Triggers**: `trigger` (schedule cron/intervallo/daily/weekly)
  - **Processing**: `tool` (tool built-in), `skill` (Agent Skill), `mcp` (MCP server tool), `llm` (prompt LLM), `transform` (trasformazione dati)
  - **Control**: `condition` (if/else, forma diamante), `parallel` (fork/join, forma diamante), `loop` (iterazione), `subprocess` (sub-workflow), `approve` (approvazione utente, forma diamante), `require_2fa` (verifica 2FA, forma diamante)
  - **Output**: `deliver` (invio risultato al canale)

- Ogni nodo ha: `id`, `kind`, `label`, `meta` (opzionale), `x/y` (posizione canvas), `data` (configurazione)
- Nodi con forma speciale: `condition`, `parallel`, `approve`, `require_2fa` sono diamanti; `subprocess` ha bordo doppio
- Ogni tipo ha un colore accent distinto, un'icona SVG path, e proprietà `hasIn`/`hasOut` per i connettori

#### Proprietà per tipo (campi inspector)
| Tipo | Campi obbligatori | Campi opzionali |
|------|-------------------|-----------------|
| `trigger` | mode (daily/weekdays/weekly/interval/cron) | time, weekday, intervalHours, cron fields |
| `tool` | tool_name | parametri dinamici da JSON Schema |
| `skill` | skill_name | - |
| `mcp` | server, tool | parametri dinamici da JSON Schema |
| `llm` | prompt | model |
| `condition` | expression | - |
| `deliver` | target (canale:chat_id) | - |
| `approve` | approve_channel | - |
| `transform` | template | - |
| `loop` | max_iterations (1-100) | condition |
| `subprocess` | workflow_ref | - |
| `parallel` | - | - |
| `require_2fa` | - | - |

### Dettagli Tecnici
- **Configurazione nodi**: costante `NODE_KINDS` in `automations.js` (13 entry) + `KIND_CONFIG` in `flow-renderer.js` (rendering)
- **Inspector dinamico**: per nodi `tool` e `mcp`, i parametri vengono caricati via API (`/v1/tools`, MCP server tools) e renderizzati come form tramite `schema-form.js`
- **Smart parameter overrides**: per tool specifici (es. `read_email_inbox`), i parametri vengono arricchiti con valori dinamici (account email configurati, modelli LLM disponibili)
- **Validazione per nodo**: `AutoValidate.validateNode()` verifica i campi obbligatori e salva errori in `node._errors`

### Dipendenze
- Dipende da: `schema-form.js` (rendering parametri JSON Schema), API `/v1/tools`, `/v1/skills`, MCP server tools
- Cosa dipende da questa: Builder, Flow Renderer, Auto-Validate

---

## 3. Trigger Engine

### Comportamento Atteso
- Il trigger engine determina quando un'automazione deve essere eseguita, basandosi su tre tipi di trigger condizionali che controllano la **notifica** (non l'esecuzione):
  - `always`: notifica ad ogni esecuzione (default)
  - `on_change`: notifica solo quando l'output differisce dall'ultima esecuzione riuscita
  - `contains`: notifica solo quando l'output contiene un testo specifico (`trigger_value`)
- La valutazione trigger avviene **dopo** l'esecuzione del task, non prima
- Il confronto `on_change` normalizza il testo (lowercase, whitespace collassato) prima del confronto
- Se nessun risultato precedente esiste, `on_change` notifica comunque (prima esecuzione)
- Il trigger `contains` e case-insensitive
- Un trigger misconfigured (es. `contains` senza `trigger_value`) degrada a `always` con nota

#### Output
- Tupla `(should_notify: bool, trigger_note: Option<String>)`
- `should_notify = false` sopprime l'invio dell'output all'utente ma il run viene comunque registrato come success
- `trigger_note` viene salvato nel `last_result` dell'automazione per trasparenza

### Dettagli Tecnici
- **Modulo**: `src/scheduler/automations.rs` — funzioni `evaluate_automation_trigger()` e `evaluate_and_complete_automation_run()`
- **Flusso**: run completo -> `evaluate_and_complete_automation_run()` -> carica ultimo risultato success -> `evaluate_automation_trigger()` -> decide notifica
- **Confronto risultati precedenti**: query `load_last_successful_automation_result()` che esclude il run corrente
- **Normalizzazione**: `normalize_for_trigger_compare()` — split whitespace + join + lowercase

### Dipendenze
- Dipende da: `storage/db.rs` (query risultati precedenti), `scheduler/db.rs` (completion run)
- Cosa dipende da questa: Gateway post-processing (prompt-based), WorkflowEngine (workflow-based)

---

## 4. Cron Scheduler

### Comportamento Atteso
- Loop infinito con timer a 30 secondi (`tokio::time::interval`) che controlla tutte le automazioni abilitate
- Supporta tre formati di schedule:
  - `cron:<MIN HOUR DOM MON DOW>` — espressione cron a 5 campi (minuto, ora, giorno mese, mese, giorno settimana)
  - `every:<secondi>` — intervallo fisso in secondi (minimo 60s per bare number)
  - `at:<ISO_TIMESTAMP>` — esecuzione una tantum (fire once, poi non ripete)
- Normalizzazione automatica di espressioni cron a 6 campi (trailing wildcard o leading seconds)
- Matching cron custom: supporta `*`, numeri esatti, liste con virgola (`1,5,10`), range (`1-5`), step (`*/15`, `1-30/5`)
- Guard anti-duplicazione: non riesegue se il last_run e nella stessa finestra di 60 secondi (previene doppio fire nel ciclo 30s)
- Catch-up su restart: `is_schedule_overdue()` rileva schedule mancati durante downtime del server

#### Percorsi di esecuzione
1. **Prompt-based** (no `workflow_steps_json`): invia `CronEvent` via `mpsc::Sender` -> gateway -> agent loop
2. **Workflow-based** (ha `workflow_steps_json`): chiama `WorkflowEngine::create_and_start()` direttamente

#### Compilazione plan runtime
- Ad ogni tick, per ogni automazione attiva, viene ricompilato il plan (`compile_automation_plan`) per verificare la validita delle dipendenze
- Se le dipendenze non sono soddisfatte (skill/MCP mancanti), lo status viene aggiornato a `invalid_config` e l'automazione non viene eseguita
- Il prompt runtime viene wrappato con `AUTOMATION EXECUTION MODE` per impedire all'LLM di creare nuove automazioni invece di eseguire il task

### Dettagli Tecnici
- **Modulo**: `src/scheduler/cron.rs` — struct `CronScheduler`
- **Late binding**: `WorkflowEngine` viene settato dopo la creazione tramite `set_workflow_engine()` (pattern `OnceCell`)
- **Tabelle DB**: `automations` (definizioni), `automation_runs` (esecuzioni)
- **Formato schedule**: stringa nel campo `automations.schedule`, parsata da `parse_schedule()` in `ScheduleKind` enum
- **Validazione cron**: il crate `cron` viene usato solo per validazione sintattica; il matching runtime e custom (funzione `cron_matches_now()`)
- **Weekday format**: `%u` (1=Mon, 7=Sun), ISO 8601

### Dipendenze
- Dipende da: `storage::Database`, `workflows::WorkflowEngine`, `scheduler::automations`, `config::Config`, `bus::InboundMessage`
- Cosa dipende da questa: Gateway (riceve `CronEvent` via mpsc channel)

---

## 5. Esecuzione Automazioni

### Comportamento Atteso
- L'esecuzione segue due percorsi convergenti:
  1. **Prompt-based**: `CronScheduler` invia `CronEvent` -> il gateway lo riceve dal canale mpsc -> crea un `InboundMessage` con metadata `scheduler_kind = "automation"` -> agent loop esegue il prompt -> post-processing chiama `evaluate_and_complete_automation_run()`
  2. **Workflow-based**: `CronScheduler` chiama `WorkflowEngine::create_and_start()` -> workflow engine esegue gli step -> su completamento/errore chiama `evaluate_and_complete_automation_run()`
- Run manuale tramite API `POST /api/v1/automations/{id}/run` — stesso flusso dell'esecuzione schedulata ma con trigger immediato
- Il prompt viene normalizzato per rimuovere frasi di creazione automazione (es. "Crea una automation chiamata X: fai Y" -> "fai Y")
- Il prompt runtime viene wrappato con istruzioni esplicite (`AUTOMATION EXECUTION MODE`) per evitare che l'LLM interpreti il prompt come richiesta di creare automazione

#### Ciclo di vita di un run
1. `insert_automation_run()` con status `queued`
2. Prompt inviato all'agent loop o workflow creato
3. Run aggiornato a `running` (workflow) o rimane `queued` fino a completamento
4. `evaluate_and_complete_automation_run()`: status `success` o `error`, risultato salvato
5. Trigger evaluato: se `should_notify = true`, output inviato al canale `deliver_to`
6. Automazione aggiornata: `last_run`, `last_result`, `status`

#### Stati del run
- `queued`: in attesa di esecuzione
- `running`: in esecuzione (usato per workflow)
- `success`: completato con successo
- `error`: fallito

#### Edge case
- `WorkflowEngine` non disponibile: fallback a esecuzione prompt-based con log warning
- `workflow_steps_json` invalido o vuoto: fallback a prompt-based
- Errore invio `CronEvent` (channel mpsc full): run marcato `error`, automazione status `error`
- Automazione con status `invalid_config`: l'esecuzione manuale pre-valida le dipendenze e restituisce errore senza eseguire

### Dettagli Tecnici
- **Moduli**: `src/scheduler/cron.rs` (scheduling), `src/scheduler/automations.rs` (prompt normalization, trigger eval, plan compilation), `src/agent/gateway.rs` (ricezione CronEvent), `src/web/api/automations.rs` (run manuale)
- **Flusso dati prompt-based**: `CronScheduler.check_and_fire_automations()` -> `build_runtime_run_input_from_plan()` -> `CronEvent` -> mpsc -> Gateway -> `InboundMessage` -> agent loop
- **Flusso dati workflow-based**: `CronScheduler` -> `WorkflowEngine::create_and_start()` -> step-by-step execution -> completion callback
- **Tabelle DB**: `automations` (last_run, last_result, status), `automation_runs` (run history)
- **Concorrenza**: il loop scheduler e single-threaded (un `tokio::spawn`); le esecuzioni avvengono in parallelo tramite il gateway o workflow engine

### Dipendenze
- Dipende da: `scheduler/cron.rs`, `scheduler/automations.rs`, `workflows/engine.rs`, `agent/gateway.rs`, `bus/queue.rs`
- Cosa dipende da questa: Trigger Engine (post-esecuzione), Storico Esecuzioni

---

## 6. Approval Gates

### Comportamento Atteso
- Quando un'automazione multi-step ha `approval_required: true` su uno step, l'esecuzione si pausa prima di quello step e richiede approvazione utente
- L'approvazione viene gestita dal WorkflowEngine (non dal sistema automazioni direttamente)
- Nel builder visuale, gli step con approvazione vengono rappresentati come nodi `approve` (diamante arancione) nel flow graph
- Il nodo `approve` ha un campo `approve_channel` per specificare il canale dove inviare la richiesta di approvazione
- Nel `derive_flow()`, gli step con `approval_required` generano automaticamente un nodo `condition` "Approval?" con edge etichettato "approved" prima dello step

#### Flow derivato
```
trigger -> ... -> gate_N (Approval?) --approved--> step_N (task) -> ...
```

### Dettagli Tecnici
- **Moduli**: `src/scheduler/automations.rs` (`derive_flow()` — generazione gate), `src/workflows/engine.rs` (esecuzione approvazione), `static/js/automations.js` (UI builder nodo `approve`)
- **Persistenza**: campo `approval_required: bool` negli oggetti `workflow_steps_json`
- **Builder**: il nodo `approve` ha `shape: 'diamond'` e accent `#FF7043`

### Dipendenze
- Dipende da: WorkflowEngine (esecuzione effettiva delle approvazioni)
- Cosa dipende da questa: Automazioni multi-step con step sensibili

---

## 7. Flow Renderer

### Comportamento Atteso
- Rendering SVG del grafo di automazione in due modalita:
  - **Mini strip** (`renderFlowMini`): striscia compatta di pallini colorati con tooltip al hover — usata nelle card lista automazioni
  - **Full canvas** (`renderFlow`): canvas completo stile n8n con nodi card, icone, edge bezier, ombre, griglia a punti

#### Nodi full canvas
- Nodi rettangolari: 160x72px, border-radius 12px, con icona colorata 32x32px e label testo
- Nodi diamante: 56x56px, rotazione 45deg (per condition, parallel, approve, require_2fa)
- Nodi subprocess: bordo doppio (stroke-dasharray)
- Connettori: cerchi 5px sui bordi sinistro (input) e destro (output)
- Meta text sotto la label per dettagli aggiuntivi
- Indicatore errore: cerchietto rosso con "!" se il nodo ha `_errors`

#### Layout
- DAG layout automatico via BFS topologico
- Rank (colonna) assegnato per profondita nel grafo
- Lane (riga) assegnate per branch paralleli con propagazione ai figli
- Gap X = 70px, Gap Y = 36px, Padding = 40px

#### Edge
- Bezier curves con control points proporzionali alla distanza
- Marker freccia SVG a fine percorso
- Label opzionale sugli edge (per branch condition: "yes"/"no")
- Colore: `#4A4B5C` (dark) / `#CEC7B8` (light)

#### Griglia
- Pattern SVG a punti, passo 20px

### Dettagli Tecnici
- **Modulo**: `static/js/flow-renderer.js` — IIFE che espone `window.HomunFlow` con metodi `renderFlowMini()` e `renderFlow()`
- **Nessuna dipendenza esterna**: SVG puro con `document.createElementNS`
- **Tema adattivo**: funzione `isDark()` controlla `document.documentElement.classList.contains('dark')` per scegliere colori
- **Performance**: `clearContainer()` rimuove tutti i figli prima di re-render; rendering lazy per canvas non visibili

### Dipendenze
- Dipende da: nessun modulo
- Cosa dipende da questa: `automations.js` (rendering mini flow e canvas), Builder (rendering preview)

---

## 8. Auto-Validate

### Comportamento Atteso
- Validazione a tre livelli:
  1. **Field-level** (`validateField`): valida un singolo input contro una regola (required, type number/integer, min/max, funzione custom). Applica/rimuove classi CSS `.input-invalid` e mostra hint errore `.validation-error`
  2. **Node-level** (`validateNode`): valida tutti i campi obbligatori di un nodo in base al suo `kind`. Salva errori in `node._errors` per il rendering canvas
  3. **Flow-level** (`validateFlow`): verifica la struttura complessiva del grafo — richiede nome automazione, almeno un nodo trigger, almeno un nodo di processing

- Validazione cron specializzata (`validateCronField`): verifica range per ogni campo (minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7), supporta liste, range, step
- Rule factory (`fieldRule`): genera regole di validazione per tipo nodo e nome campo, inclusi parametri da JSON Schema per tool/mcp

#### Campi obbligatori per tipo nodo
- `tool`: tool_name
- `skill`: skill_name
- `mcp`: server, tool (solo se server gia selezionato)
- `llm`: prompt
- `condition`: expression
- `deliver`: target
- `approve`: approve_channel
- `subprocess`: workflow_ref
- `transform`: template
- `loop`: max_iterations (integer, 1-100)
- `trigger`: campi cron (se mode=cron) o intervalHours (se mode=interval)

### Dettagli Tecnici
- **Modulo**: `static/js/auto-validate.js` — oggetto globale `window.AutoValidate`
- **Caricato prima di `automations.js`** per essere disponibile durante l'init
- **Integrazione DOM**: `_applyFieldState()` aggiunge/rimuove classi CSS e hint nel DOM
- **Pure logic**: `_checkRule()` e `validateCronField()` sono funzioni pure senza side effect DOM

### Dipendenze
- Dipende da: nessun modulo
- Cosa dipende da questa: `automations.js` (Builder inspector, validazione pre-save)

---

## 9. Automation Tool

### Comportamento Atteso
- Tool LLM per gestire automazioni tramite conversazione. Azioni:
  - `create`: crea una nuova automazione con nome, prompt, schedule, trigger, deliver_to
  - `list`: elenca automazioni con filtro opzionale (all, active, paused, error)
  - `status`: dettaglio singola automazione
  - `history`: ultime 10 esecuzioni
  - `enable` / `disable`: attiva/pausa automazione
  - `update`: modifica parziale (nome, prompt, schedule, deliver_to, trigger)
  - `delete`: elimina automazione

- Parsing schedule da linguaggio naturale (italiano e inglese):
  - "every 6 hours" -> `every:21600`
  - "ogni giorno alle 8" -> `cron:0 8 * * *`
  - "every weekday at 9:30" -> `cron:30 9 * * 1-5`
  - "ogni giorno feriale alle 8" -> `cron:0 8 * * 1-5`

- Il prompt viene normalizzato: frasi tipo "Crea una automazione che controlla le email" diventano "controlla le email"
- Alla creazione, viene compilato il plan con validazione dipendenze (skill e MCP server)
- Il `deliver_to` default e il canale e chat_id correnti del contesto

### Dettagli Tecnici
- **Modulo**: `src/tools/automation.rs` — struct `AutomationTool` che implementa `Tool` trait
- **Registrazione**: in `src/tools/registry.rs`
- **Parametri JSON Schema**: action (enum 8 valori), automation_id, name, prompt, schedule, deliver_to, trigger (enum 3 valori), trigger_value, filter
- **Validazione plan**: `compile_automation_plan()` estrae dipendenze dal prompt e verifica che skill/MCP siano installati/attivi
- **Tabelle DB**: `automations`, `automation_runs`

### Dipendenze
- Dipende da: `storage::Database`, `scheduler::automations`, `config::Config`
- Cosa dipende da questa: Agent loop (invocazione tool)

---

## 10. Storico Esecuzioni

### Comportamento Atteso
- Ogni esecuzione di automazione viene registrata nella tabella `automation_runs`
- L'utente puo visualizzare lo storico:
  - Via Web UI: pannello laterale con le ultime 30 esecuzioni, mostra ID, status (badge colorato), timestamp inizio/fine, risultato
  - Via Tool LLM: azione `history` mostra le ultime 10 esecuzioni
  - Via API REST: `GET /api/v1/automations/{id}/history?limit=N` (max 500)
- Ogni run registra: id (UUID), automation_id, started_at, finished_at, status, result (testo)
- La Web UI si aggiorna automaticamente ogni 30 secondi in background

#### Stati run
- `queued`: run inserito, in attesa di esecuzione
- `running`: in esecuzione (usato per workflow-based)
- `success`: completato con successo
- `error`: fallito

### Dettagli Tecnici
- **Moduli**: `src/scheduler/db.rs` (CRUD run), `src/web/api/automations.rs` (endpoint history), `static/js/automations.js` (rendering history panel)
- **Tabella**: `automation_runs` con indici su `automation_id` e `started_at`
- **Endpoint**: `GET /api/v1/automations/{id}/history` — parametro query `limit` (default 50, clamp 1-500)
- **Cascading delete**: `automation_runs.automation_id` ha `ON DELETE CASCADE` — eliminare un'automazione elimina tutto lo storico

### Dipendenze
- Dipende da: `storage::Database`
- Cosa dipende da questa: Trigger Engine (`load_last_successful_automation_result` per confronto on_change), Web UI, Tool LLM

---

## 11. NLP Flow Generation

### Comportamento Atteso
- L'utente descrive un'automazione in linguaggio naturale (es. "ogni mattina controlla Gmail e mandami un riassunto su Telegram")
- Il sistema genera automaticamente un flow visuale completo (nodi + edge)
- Accessibile da:
  - Prompt bar nella lista automazioni (apre il Builder con flow generato)
  - Prompt bar nel Builder stesso
- La generazione usa `llm_one_shot()` con un system prompt specializzato che definisce i tipi di nodo disponibili e le regole di composizione
- L'LLM restituisce JSON con `name` (nome automazione) e `flow` (grafo `{nodes, edges}`)
- Il JSON viene estratto dalla risposta LLM con `extract_json_object_block()` (cerca il primo `{` e l'ultimo `}`)

#### Regole di generazione (system prompt)
- Sempre iniziare con un nodo `trigger` e terminare con un nodo `deliver`
- `deliver` per canali di messaggistica (Telegram, Discord, etc.) — mai `mcp` per invio messaggi
- `mcp` solo per servizi API esterni (Gmail, GitHub, Slack API, Calendar, etc.)
- `llm` per task di ragionamento (riassumere, analizzare, scrivere)
- `tool` per tool built-in (web_search, shell, file operations)
- Flow tipici: 3-6 nodi, wired sequenzialmente
- Node ID: `n1`, `n2`, `n3`, etc.

#### Edge case
- Risposta LLM non contiene JSON valido: errore 500
- Timeout LLM: errore 504 (Gateway Timeout)
- Nessun modello attivo: errore 503 (Service Unavailable)

### Dettagli Tecnici
- **Backend**: `src/web/api/automations.rs` — funzione `generate_automation_flow()`
- **Endpoint**: `POST /api/v1/automations/generate-flow` — body `{ description: string }`
- **LLM**: `provider::llm_one_shot()` con max_tokens 4096, timeout 60s
- **Frontend**: `Builder.generateFromPrompt()` in `automations.js` — chiama l'endpoint e popola il canvas con i nodi generati

### Dipendenze
- Dipende da: `provider/one_shot.rs` (LLM engine), `config::Config` (modello attivo)
- Cosa dipende da questa: Builder (input per canvas)

---

## Schema Database

### Tabella `automations`

| Colonna | Tipo | Default | Note |
|---------|------|---------|------|
| id | TEXT PK | - | UUID |
| name | TEXT NOT NULL | - | Nome visualizzato |
| prompt | TEXT NOT NULL | - | Istruzioni per l'agent |
| schedule | TEXT NOT NULL | - | `cron:...` o `every:...` |
| enabled | INTEGER | 1 | 0/1 boolean |
| status | TEXT | 'active' | active, paused, error, invalid_config |
| deliver_to | TEXT | NULL | `channel:chat_id` |
| trigger_kind | TEXT | 'always' | always, on_change, contains |
| trigger_value | TEXT | NULL | Testo per trigger `contains` |
| last_run | TEXT | NULL | Timestamp ultimo run |
| last_result | TEXT | NULL | Risultato ultimo run (troncato) |
| plan_json | TEXT | NULL | Piano compilato serializzato |
| dependencies_json | TEXT | '[]' | Array dipendenze `[{kind, name}]` |
| plan_version | INTEGER | 1 | Versione schema plan |
| validation_errors | TEXT | NULL | Array JSON errori validazione |
| workflow_steps_json | TEXT | NULL | Step workflow per esecuzione multi-step |
| flow_json | TEXT | NULL | Grafo visuale SVG serializzato |
| profile_id | INTEGER | NULL | FK profiles(id), scoping per profilo |
| user_id | TEXT | NULL | FK users(id) |
| created_at | TEXT | datetime('now') | - |
| updated_at | TEXT | NULL | - |

**Indici**: enabled, status, trigger_kind, profile_id, user_id

### Tabella `automation_runs`

| Colonna | Tipo | Default | Note |
|---------|------|---------|------|
| id | TEXT PK | - | UUID |
| automation_id | TEXT NOT NULL | - | FK automations(id) ON DELETE CASCADE |
| started_at | TEXT | datetime('now') | - |
| finished_at | TEXT | NULL | - |
| status | TEXT | 'queued' | queued, running, success, error |
| result | TEXT | NULL | Output dell'esecuzione |

**Indici**: automation_id, started_at

### Migrazioni correlate
- `006_automations.sql` — schema base automations + automation_runs
- `007_automation_triggers.sql` — trigger_kind, trigger_value
- `008_automation_plan.sql` — plan_json, dependencies_json, plan_version, validation_errors
- `014_automation_workflow.sql` — workflow_steps_json
- `018_automation_flow.sql` — flow_json
- `032_workflow_automation_link.sql` — automation_id/automation_run_id su workflows
- `036_profile_scoping_phase2.sql` — profile_id
- `037_user_profile_scoping.sql` — user_id

---

## API REST

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | `/api/v1/automations` | Lista automazioni (query: `profile` per filtro profilo) |
| POST | `/api/v1/automations` | Crea automazione |
| GET | `/api/v1/automations/targets` | Lista target di delivery disponibili |
| POST | `/api/v1/automations/generate-flow` | Genera flow da linguaggio naturale |
| PATCH | `/api/v1/automations/{id}` | Aggiorna automazione (partial update) |
| DELETE | `/api/v1/automations/{id}` | Elimina automazione |
| GET | `/api/v1/automations/{id}/history` | Storico esecuzioni (query: `limit`) |
| POST | `/api/v1/automations/{id}/run` | Esecuzione manuale immediata |

**Autenticazione**: tutti gli endpoint richiedono sessione autenticata. POST/DELETE richiedono permesso write (`require_write`).

**Isolamento profilo**: `load_automations(profile_id)` filtra a livello SQL con `WHERE profile_id IS NULL OR profile_id = ?`. L'API passa il profilo dal query param. Il cron scheduler carica tutte le automazioni (`None`) per verificare quali devono scattare — le automazioni sono risorse di sistema che scattano indipendentemente dal profilo attivo.

---

## File Coinvolti

### Backend (Rust)
- `src/scheduler/mod.rs` — re-export pubblici
- `src/scheduler/cron.rs` — CronScheduler, loop 30s, schedule matching, catch-up
- `src/scheduler/automations.rs` — AutomationSchedule, FlowGraph, plan compilation, trigger evaluation, prompt normalization
- `src/scheduler/db.rs` — operazioni CRUD su automations e automation_runs
- `src/tools/automation.rs` — AutomationTool (interfaccia LLM)
- `src/web/api/automations.rs` — 8 endpoint REST
- `src/agent/gateway.rs` — ricezione CronEvent, post-processing run

### Frontend (JS)
- `static/js/automations.js` — pagina automazioni, lista, editor inline, Builder (canvas drag-and-drop), NODE_KINDS, prompt bar NLP
- `static/js/auto-validate.js` — validazione field/node/flow, regole per tipo nodo, validazione cron
- `static/js/flow-renderer.js` — rendering SVG mini strip e full canvas, layout DAG, bezier edges
- `static/js/schema-form.js` — rendering parametri tool/mcp da JSON Schema
- `static/js/mcp-loader.js` — discovery MCP server e tool
- `static/js/model-loader.js` — lista modelli LLM disponibili
