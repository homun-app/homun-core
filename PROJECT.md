# Local-First Personal Assistant

Documento fondativo del progetto per costruire un personal assistant locale, proattivo e installabile su macOS, Windows e Linux. Il nome e il branding sono provvisori; questo file serve a fissare architettura, componenti, decisioni tecniche, riferimenti e roadmap.

## Visione

Costruire un assistant che non sia una chat passiva. Deve osservare il lavoro quotidiano dell'utente, imparare routine, costruire memoria verificabile, proporre automazioni e operare sul computer con autorizzazioni progressive.

Il modello mentale e': un apprendista che osserva, capisce, propone, esegue con permesso e nel tempo diventa un maestro operativo.

Principi:

- local-first: i dati e la memoria restano sul dispositivo per default.
- language-agnostic e multilingua di default: pipeline, contratti, memoria e subagenti non devono assumere una lingua specifica; l'italiano e' un caso d'uso primario, non un vincolo architetturale.
- trasparente: l'utente vede e corregge cio' che l'assistant sa.
- operativo: ogni azione passa da contratti, permessi e audit trail.
- proattivo: l'assistant rileva pattern e propone aiuto prima che venga chiesto.
- estendibile: connettori, MCP, skill e runtime LLM devono essere modulari.
- modulare nei file: i componenti vanno separati presto per dominio, evitando file troppo lunghi che costringano a refactor tardivi.

## Decisioni Gia' Validate

### Riferimento di ispirazione

- OpenHuman (`tinyhumansai/openhuman`) e' uno spunto di riferimento per capire come altri hanno affrontato assistant personali, agenti, memoria, tool e UX operativa.
- Non e' un progetto da copiare o forkare.
- Lo usiamo per leggere soluzioni concrete, confrontare tradeoff e decidere consapevolmente cosa adattare al nostro progetto.
- Le nostre decisioni restano autonome: local-first per default, Rust Core, Tauri, runtime Python/MLX con Gemma 4, subagenti auditabili e permessi deny-by-default.
- Ogni idea presa da OpenHuman deve passare da una decisione esplicita: cosa risolve, come viene adattata, quali parti non importiamo.

### Stack applicazione

- Desktop shell: Tauri.
- UI: React + TypeScript.
- Core locale: Rust.
- Runtime inference Mac: Python + MLX + mlx-vlm.
- Modello Mac default: `mlx-community/gemma-4-e4b-it-4bit`.
- Memoria primaria: SQLite + grafo + wiki Markdown.
- Graph/document memory: Graphify / GraphifyLabs.
- Human-readable memory: Obsidian Wiki / LLM Wiki.
- Orchestrazione: subagenti locali coordinati dal Rust Core, non dal runtime LLM.
- Capability Layer: provider-neutral contracts for channels, native connectors, MCP, skills and optional managed integration aggregators.
- Managed integrations: Composio/Zapier/Pipedream style providers are allowed only as explicit opt-in adapters, never as implicit core dependencies.
- Capability provider registry: provider config, grant user/workspace, connessioni, tool cache e policy context devono essere persistenti in SQLite locale.
- Browser automation: OpenClaw e' il riferimento principale per profili browser, Playwright/CDP, snapshot/refs, azioni atomiche, tab tracking, navigation guard e manual blockers. Lo stack operativo sara' sidecar locale Node/TypeScript con `playwright-core`, orchestrato dal Rust Core.

### Test Gemma 4 locale

Test eseguito su MacBook Air M4, 24 GB RAM, Apple Metal.

Risultato suite locale: 7/7 passati.

Capacita' testate:

- italiano conversazionale.
- JSON rigido.
- routine inference con contratto severo.
- memory extraction.
- tool calling Gemma 4.
- patch codice.
- vision/OCR da immagine sintetica.

Metriche indicative:

- load da cache: circa 2.2 secondi.
- generazione: circa 28-32 token/s.
- memoria text: circa 5.3-5.8 GB.
- modello: `mlx-community/gemma-4-e4b-it-4bit`.

File esistenti:

- `/Users/fabio/Documents/Codex/2026-05-22/voglio-creare-un-applicazione-tipo-codex/tests/gemma4_eval.py`
- `/Users/fabio/Documents/Codex/2026-05-22/voglio-creare-un-applicazione-tipo-codex/reports/gemma4_eval.jsonl`
- `/Users/fabio/Documents/Codex/2026-05-22/voglio-creare-un-applicazione-tipo-codex/reports/gemma4_vision_fixture.png`

Conclusione: Gemma 4 locale e' utilizzabile come componente operativo se viene guidato con contratti rigidi e validazione, non come chatbot libero.

## Architettura Generale

```text
Tauri React UI
  -> Rust Core
    -> Permission Manager
    -> Process Manager
    -> Event Collector
    -> Memory Manager
    -> Durable Task Runtime
      -> Task Store
      -> Queue Manager
      -> Scheduler
      -> Priority Manager
      -> Resource Governor
      -> Lease / Heartbeat
      -> Checkpoints
      -> Approval Gates
    -> Capability Manager
      -> Provider Registry
      -> Channels
      -> Native Connectors
      -> MCP Adapter
      -> Skill Registry
      -> Managed Provider Adapters
    -> Automation Engine
    -> Subagent Manager
      -> PlannerAgent
      -> MemoryAgent
      -> ToolAgent
      -> VisionAgent
      -> RiskAgent
      -> ReviewAgent
    -> Local LLM Runtime
      -> Python sidecar
      -> MLX / mlx-vlm
      -> Gemma 4
    -> Browser Automation Runtime
      -> Node/TypeScript sidecar
      -> playwright-core
      -> Chromium CDP
```

## Componenti

### 1. Desktop App

Responsabilita':

- onboarding utente.
- chat operativa.
- inbox assistant.
- routine rilevate.
- automazioni proposte.
- connettori mancanti.
- memoria appresa e modificabile.
- permessi e audit.

Tecnologie:

- Tauri.
- React.
- TypeScript.
- Rust commands.

La UI non deve essere una landing page. La prima schermata deve essere il prodotto operativo.

### 2. Rust Core

Responsabilita':

- avviare e monitorare sidecar Python/MLX.
- gestire database SQLite.
- osservare eventi locali.
- applicare policy di sicurezza.
- gestire connettori.
- validare output LLM.
- eseguire tool solo con permessi corretti.
- mantenere audit trail.
- orchestrare subagenti locali con budget, timeout, permessi e memoria accessibile.

API interne previste:

```text
runtime.health()
runtime.generate_json(contract, input)
runtime.tool_call(tools, input)
runtime.analyze_image(image, contract)
subagents.dispatch(agent_id, task, permission_envelope)
subagents.cancel(task_id)
subagents.status(task_id)
memory.write_event(event)
memory.extract_candidates(event_batch)
memory.upsert_entity(entity)
memory.upsert_relation(relation)
task.create(task_spec)
task.enqueue(task_id, priority, resource_requirements)
task.pause(task_id)
task.resume(task_id)
task.cancel(task_id)
task.status(task_id)
task.list_queue(user_id, workspace_id)
task.record_checkpoint(task_id, checkpoint)
automation.propose(candidate)
automation.execute_with_approval(id)
```

### 3. Durable Task Runtime

Il Durable Task Runtime e' il coordinatore durevole del lavoro operativo. Non appartiene al browser, ai connettori o ai subagenti: e' un componente centrale del Rust Core che permette task indipendenti, workflow, code, priorita', limiti risorse, checkpoint e ripresa dopo crash o riavvio.

Responsabilita':

- creare task persistenti multiutente/workspace.
- gestire task singoli e workflow con dipendenze.
- eseguire task multipli indipendenti in parallelo quando le risorse lo permettono.
- applicare code e priorita' quando i task sono troppi.
- proteggere risorse locali: LLM, browser session, rete, filesystem, Graphify, connettori e manutenzioni background.
- mantenere lease/heartbeat per evitare doppie esecuzioni.
- salvare checkpoint, retry, backoff, errori e audit.
- sospendere task in attesa di tempo, evento esterno, risorsa o approvazione utente.
- esporre viste UI-safe su task in esecuzione, in coda, bloccati e completati.

Stati:

```text
queued
pending
running
waiting_time
waiting_external_event
waiting_user_approval
waiting_resource
paused
completed
failed
cancelled
expired
```

Priorita':

```text
critical
high
normal
low
background
```

Classi risorsa iniziali:

```text
llm_inference
browser_session
network_io
filesystem_io
connector_api
memory_indexing
graph_indexing
user_wait
background_maintenance
```

Regole:

- Nessun executor decide autonomamente quando partire.
- Il runtime LLM rimane a concorrenza bassa o single-flight.
- Browser automation, Graphify e connettori remoti passano dal Resource Governor.
- Un task lungo di ore o giorni deve essere ricostruibile da store, checkpoint e audit.
- I task ad alto rischio entrano in `waiting_user_approval` prima dell'azione reale.
- Le policy di privacy e permessi restano esterne al task runtime, ma il task runtime deve conservarne gli esiti e bloccare l'esecuzione quando richiesto.

### 4. Subagent Manager

Il Subagent Manager e' il coordinatore operativo dell'assistant. Non e' un modello e non e' un endpoint chat. Vive nel Rust Core e usa il runtime LLM locale come motore di inferenza dietro contratti rigidi.

Responsabilita':

- registrare subagenti disponibili e versionati.
- assegnare task con input, contratto, budget token/tempo e livello di permesso.
- eseguire subagenti in sequenza o in parallelo quando i task sono indipendenti.
- cancellare task in corso e applicare timeout.
- validare output JSON prima di passarli al passo successivo.
- mantenere audit trail completo: input, contratto, agente, modello, output, metriche, decisione.
- impedire che un subagente esegua direttamente azioni non autorizzate.

Subagenti iniziali:

- `PlannerAgent`: trasforma eventi e obiettivi in piani strutturati.
- `MemoryAgent`: estrae memorie candidate, entita' e relazioni.
- `ToolAgent`: produce tool call validate, senza eseguirle direttamente.
- `VisionAgent`: analizza screenshot, finestre e immagini locali.
- `RiskAgent`: valuta rischio, reversibilita' e necessita' di approvazione.
- `AutomationAgent`: propone automazioni ricorrenti o semi-automatiche.
- `ReviewAgent`: controlla coerenza, formato JSON, policy e rischio prima dell'esecuzione.

Pattern adattati da OpenHuman:

- definizioni agenti data-driven con `id`, `display_name`, `when_to_use`, tier, scope tool e limiti runtime.
- policy direct-first: rispondere direttamente quando possibile, usare tool diretti prima dei subagenti, delegare solo lavori specialistici.
- separazione tra strumenti visibili al modello e capacita' eseguibili dal runtime.
- subagenti isolati dal parent session: producono risultati compatti, validati e auditabili.

Envelope minimo di un task subagente:

```json
{
  "task_id": "task_2026_05_22_001",
  "agent_id": "PlannerAgent",
  "goal": "Infer routine from desktop events",
  "input": {},
  "contract": "RoutineInference",
  "permission_envelope": {
    "connectors": ["git", "trello", "mattermost"],
    "max_autonomy_level": 2,
    "allowed_actions": ["read", "draft"],
    "requires_user_approval": true
  },
  "budgets": {
    "timeout_seconds": 30,
    "max_tokens": 512
  }
}
```

Regole:

- Il runtime Python/MLX non decide autonomia, permessi o routing tra subagenti.
- I subagenti non eseguono azioni irreversibili; producono piani, bozze, tool call o valutazioni.
- Ogni output operativo passa da validazione e, per azioni reali, da `RiskAgent` o `ReviewAgent`.
- I task paralleli devono essere ricostruibili e auditabili separatamente.
- La memoria accessibile a un subagente e' esplicita e limitata al task.
- Gli output di `MemoryAgent` entrano nella memoria solo tramite `MemoryFacade`.
- Timeout e cancellazione devono bloccare la chiamata al runtime quando il task e' gia' scaduto o annullato.
- I workflow devono avere stato persistito e consultabile dalla UI, non solo risultati task isolati.
- I workflow lunghi o riprendibili devono essere eseguiti sopra il Durable Task Runtime, non solo nell'orchestratore in-memory.

Workflow MVP:

```text
Event batch
  -> PlannerAgent
  -> RiskAgent
  -> MemoryAgent + ToolAgent
  -> ReviewAgent
  -> approval center / automation proposal
```

### 5. Local LLM Runtime

Runtime Mac iniziale:

- Python.
- uv-managed environment.
- MLX.
- mlx-vlm.
- Gemma 4 E4B 4-bit.

Deve essere un server locale persistente, non un CLI lanciato a ogni prompt.

Endpoint minimi:

```text
GET  /health
POST /generate
POST /generate_json
POST /tool_call
POST /analyze_image
POST /benchmark
POST /shutdown
```

Requisiti:

- caricare modello una sola volta.
- streaming token.
- metriche token/s.
- memoria peak.
- timeout.
- cancel request.
- schema validation.
- repair attempt per JSON invalido.

Il runtime espone primitive per i subagenti, non un'interfaccia di autonomia:

- `generate_json`: inferenza vincolata a contratto.
- `tool_call`: produzione di chiamate tool parseabili, non esecuzione tool.
- `analyze_image`: analisi locale di immagini/screenshot.
- `benchmark`: verifica regressioni dei contratti locali.

### 6. Contratti LLM

Ogni output operativo deve avere schema validato.

Contratti iniziali:

- `IntentDetection`
- `RoutineInference`
- `MemoryExtraction`
- `ToolPlan`
- `RiskAssessment`
- `AutomationProposal`
- `VisionSummary`
- `ConnectorRequirement`
- `SubagentTask`
- `SubagentResult`
- `SubagentReview`

Esempio `RoutineInference`:

```json
{
  "routine_name": "Client Acme Workflow Sync",
  "intent": "Manage project tasks and communications for Acme client",
  "confidence": 0.95,
  "observed_apps": ["Zed", "git", "trello.com", "mattermost"],
  "required_connectors": ["git", "trello", "mattermost"],
  "missing_connectors": ["git", "trello", "mattermost"],
  "proposed_automation": "Execute git pull, synchronize Trello board Acme, and check unread messages in Mattermost.",
  "requires_user_approval": true
}
```

Regola: l'assistant non esegue azioni da testo libero. Prima produce un piano strutturato, poi il core valida e decide se chiedere approvazione.

## Memoria

La memoria deve essere ibrida:

```text
SQLite event log
  + SQLite memory store
  + graph memory
  + Graphify technical graph
  + Obsidian LLM Wiki
  + FTS / local embeddings
```

### Event Log

Fonte grezza e append-only.

Contiene:

- timestamp.
- source.
- event type.
- payload JSON.
- privacy level.
- user/session id.
- ingestion metadata.

Esempi:

```text
08:58 open_app Zed
08:59 open_folder /Clients/Acme/app
09:01 terminal git pull
09:03 browser trello.com board Acme
09:06 browser mattermost.acme.local unread messages
```

### Memory Store

Contiene fatti consolidati, non ogni evento.

Esempi:

- Fabio lavora spesso su Acme la mattina.
- Fabio preferisce Zed come editor.
- Il repository principale di Acme e' `/Clients/Acme/app`.

Ogni memoria deve avere:

- confidence.
- source/evidence.
- created_at.
- last_seen_at.
- status: candidate, confirmed, rejected, stale.

### Graph Memory

Serve per ragionare sulle relazioni.

Entita' iniziali:

- User.
- Project.
- App.
- Tool.
- Connector.
- Routine.
- Repository.
- Task.
- Document.
- Person.
- Team.
- Preference.
- Automation.
- Decision.

Relazioni iniziali:

- `works_on`
- `uses_tool`
- `uses_repo`
- `prefers`
- `opens`
- `checks`
- `requires_connector`
- `belongs_to_project`
- `proposes_automation`
- `supported_by_evidence`
- `depends_on`

Implementazione MVP:

```sql
entities(id, type, name, canonical_key, metadata_json, created_at, updated_at)
relations(id, source_id, relation_type, target_id, confidence, evidence_json, created_at)
events(id, timestamp, source, event_type, payload_json, privacy_level)
memories(id, type, text, confidence, status, source_json, created_at, updated_at)
memory_evidence(memory_id, event_id)
routines(id, name, intent, confidence, status, schedule_hint_json, created_at, updated_at)
automation_candidates(id, routine_id, proposal_json, risk_level, status, created_at)
```

### Graphify / GraphifyLabs

Graphify (`safishamsi/graphify`) non va perso. E' il motore scelto per la memoria tecnica e documentale.

Ruolo:

- indicizzare codebase.
- creare graph da repo, documenti, PDF, Markdown, immagini, meeting transcript.
- collegare file, funzioni, classi, decisioni, PR, documenti.
- fornire query strutturate al nostro assistant.

Usi:

- codebase memory.
- project graph.
- document graph.
- impact analysis.
- knowledge graph tecnico.

Esempio:

```text
Project Acme
  -> repository /Clients/Acme/app
  -> module billing
  -> file src/billing/invoices.ts
  -> decision "use Stripe webhooks"
```

Graphify resta separato dalla memoria personale grezza. Non deve diventare l'unico database della persona.

Regole adapter:

- Gli id nodo Graphify vengono conservati in `MemoryEntity.metadata`.
- Gli id edge Graphify vengono conservati in `MemoryRelation.metadata`.
- Gli output `graphify-out/graph.json`, `GRAPH_REPORT.md` e `graph.html` sono artefatti richiamabili, non fonti che bypassano policy e privacy domains.
- Query/path/explain di Graphify saranno esposti attraverso un adapter del Memory Core, non chiamati direttamente dai subagenti.
- Il formato importato e' NetworkX node-link JSON: `nodes` + `links`.
- I confidence label Graphify (`EXTRACTED`, `INFERRED`, `AMBIGUOUS`) vengono conservati nei metadati e mappati a score interni.
- L'interfaccia LLM deve restare query-first: usare `graphify query`, `graphify path`, `graphify explain` per contesto mirato prima di leggere report interi.

### Obsidian Wiki / LLM Wiki

Obsidian Wiki e' lo strato leggibile dall'utente.

Ruolo:

- rendere la memoria trasparente.
- permettere all'utente di correggere note.
- mantenere pagine progetto, routine, decisioni, persone, tool.
- applicare il pattern LLM Wiki: fonti lette una volta, conoscenza sintetizzata in pagine interconnesse.

Esempi di pagine:

```text
Projects/Acme.md
Routines/Avvio lavoro Acme.md
Tools/Trello.md
Tools/Mattermost.md
People/Fabio.md
Decisions/2026-05-22-runtime-locale-gemma4.md
```

Esempio frontmatter:

```yaml
---
entity_id: project:acme
type: project
summary: Progetto cliente Acme usato al mattino con Zed, Git, Trello e Mattermost.
confidence: 0.91
last_verified: 2026-05-22
sources:
  - event:evt_2026_05_22_0901_git_pull
  - event:evt_2026_05_22_0903_trello
---
```

Regola: Obsidian non riceve ogni evento. Riceve solo conoscenza consolidata, decisioni, routine e sintesi utili.

## Osservazione Desktop

MVP signals:

- app attiva.
- finestra attiva.
- directory/progetto aperto.
- comandi Git.
- file modificati.
- domini browser rilevanti.
- screenshot manuale o autorizzato.
- calendario, se connesso.

Pattern iniziale da supportare:

```text
Avvio lavoro progetto:
  open Zed
  open project folder
  git pull
  check Trello
  check Mattermost
```

Output atteso:

```text
"Sembra la routine di avvio lavoro Acme. Per automatizzarla servono Git, Trello e Mattermost. Vuoi configurarli?"
```

## Connettori

Decisione architetturale:

- Separare `channels`, `integrations`, `skills` e `browser automation`.
- Usare un Capability Layer provider-neutral nel Rust Core.
- Usare provider managed tipo Composio, Zapier MCP o Pipedream MCP come acceleratori opzionali per copertura ampia.
- Non far dipendere `ToolAgent`, subagenti o memoria direttamente da Composio o da un vendor specifico.
- Ogni provider cloud deve essere esplicitamente abilitato dall'utente e marcato come boundary non local-first.

Ordine consigliato:

1. Git locale.
2. Filesystem.
3. Browser observer.
4. Trello.
5. Mattermost.
6. Calendar.
7. Email.
8. GitHub/GitLab.
9. Slack/Discord.
10. Google Drive/Dropbox/OneDrive.

Strategia:

- connettori nativi per il core indispensabile.
- MCP client universale.
- provider managed esterni per copertura ampia, opt-in e policy-gated.
- skill locali per estendere il sistema senza modificare il core.
- fallback browser automation solo quando non esiste API affidabile.
- i task lunghi, paralleli o sospesi non vivono nei connettori: vengono sempre orchestrati dal Durable Task Runtime.
- le capability/tool call possono essere montate su `TaskRuntime` tramite bridge dedicato.
- provider, connessioni, grant e tool cache vengono registrati in SQLite locale tramite `CapabilityRegistryStore`.
- i segreti dei connettori restano in keychain/secure storage e nel DB viene salvato solo un `secret_ref`.

Permessi per connettore:

```text
read
draft
write_with_confirmation
approved_automation
```

## Autonomia

Livelli:

```text
0 osserva
1 suggerisce
2 prepara
3 esegue con conferma
4 esegue task approvati e reversibili
5 maestro operativo auditabile
```

MVP target: livello 2/3.

## Sicurezza

Regole:

- deny-by-default.
- ogni connettore ha scope espliciti.
- ogni automazione ha livello di rischio.
- azioni non reversibili richiedono conferma.
- log auditabile.
- l'utente puo' cancellare memoria, eventi, wiki e grafo.
- segreti in keychain/secure storage, mai in chiaro nel DB.

Risk levels:

```text
low: leggere file, leggere task, generare riepilogo
medium: creare bozza, modificare file locale, preparare commit
high: inviare messaggi, push git, cancellare file, aggiornare task remoti
critical: pagamento, deploy, modifiche irreversibili
```

## Roadmap

### Fase 0 - Esperimenti validati

Stato: in corso, base gia' presente.

- Gemma 4 E4B 4-bit su MLX.
- test JSON, routine, tool call, vision.
- benchmark locale.
- probe Candle/Rust.

### Fase 1 - Local LLM Runtime

Deliverable:

- server Python/MLX persistente.
- API HTTP locale.
- model load una volta sola.
- schema validation.
- error response stabile.
- health operativo con readiness, configurazione locale e stato concorrenza.
- busy/deadline handling.
- validazione path immagini locali.
- benchmark endpoint.

### Fase 1.5 - Subagent Orchestration

Deliverable:

- registry subagenti locali.
- task model con `SubagentTask`, `SubagentResult` e `SubagentReview`.
- execution graph sequenziale/parallelo.
- permission envelope per ogni task.
- budget token/tempo e cancellazione task.
- audit trail per ogni passaggio subagente.
- workflow run persistence e status UI-readable.
- import output `MemoryAgent` nella `MemoryFacade`.
- workflow MVP: `PlannerAgent -> RiskAgent -> MemoryAgent/ToolAgent -> ReviewAgent`.
- bridge verso Durable Task Runtime per workflow persistenti e riprendibili.

Implementato bridge Durable Task Runtime:

- `SubagentTaskRuntimeBridge` converte `WorkflowTaskSpec` in `TaskRecord`.
- Le dipendenze workflow vengono salvate in `TaskStore`.
- Ogni task subagente dichiara risorsa `llm_inference`.
- `SubagentTaskExecutor` implementa `TaskExecutor` e chiama `SubagentRunner`.
- I risultati riusciti diventano durable task completati.
- I risultati falliti, timeout o cancellati diventano failure retryable del task runtime.

### Fase 2 - Memory Core

Deliverable:

- SQLite schema versionato con migrazioni idempotenti.
- event log.
- entities/relations graph model.
- memory extraction contract.
- routine inference contract.
- evidence tracking.
- lifecycle memorie: candidate, confirmed, rejected, stale, deleted.
- search FTS locale con policy, ranking deterministico e paginazione.
- backup/restore locale, health e maintenance.

### Fase 3 - Graphify Integration

Deliverable:

- install/runtime strategy per `graphifyy`.
- import graph output.
- query/path/explain API policy-gated.
- project/codebase graph.
- link fra Graphify nodes e nostro entity graph.

### Fase 4 - Obsidian Wiki Integration

Deliverable:

- vault path config.
- page templates.
- wiki writer.
- wiki updater.
- bidirectional sync minima: DB -> Markdown, Markdown corrections -> DB candidate updates.

### Fase 5 - Durable Task Runtime

Stato: first production slice implementato in `crates/task-runtime`.

Deliverable:

- crate Rust `crates/task-runtime`.
- task store SQLite con migrazioni idempotenti.
- task indipendenti e workflow persistenti con dipendenze.
- queue manager con priorita' `critical`, `high`, `normal`, `low`, `background`.
- resource governor con limiti globali, per utente/workspace e per classe risorsa.
- stati task completi: `queued`, `pending`, `running`, `waiting_time`, `waiting_external_event`, `waiting_user_approval`, `waiting_resource`, `paused`, `completed`, `failed`, `cancelled`, `expired`.
- lease/heartbeat per worker e recovery dopo crash.
- retry/backoff e scadenze.
- checkpoint serializzati e audit.
- pause/resume/cancel.
- read model UI-safe per coda, task attivi, task bloccati e motivi di blocco.
- adapter iniziali per subagenti e capability fake.

Regola: questo componente va chiuso prima di browser automation, per evitare che scheduling, retry, code e resume vengano duplicati nei singoli executor.

Implementato:

- contratti task, stati, priorita', risorse e retry policy.
- store SQLite con task, dipendenze, reservation risorse, checkpoint e approval records.
- scheduler deterministico per priorita', `not_before` e dipendenze.
- resource governor con `waiting_resource`.
- lease/heartbeat/recovery con rilascio reservation.
- checkpoint append-only e retry/backoff.
- approval gates.
- `TaskExecutor` e `TaskRuntime` facade con executor finto testabile.
- read model UI-safe per coda, task attivi, blocchi, approvazioni, risorse e checkpoint redatti.
- bridge subagenti e capability/tool call verso `TaskRuntime`.
- provider registry persistente nel Capability Layer con config provider, grant user/workspace, connection config secret-ref-only e tool cache.
- `CapabilityRegistryStore` deriva `PolicyContext` usabile direttamente da `CapabilityFacade`.

### Fase 6 - Browser Automation

Deliverable:

- crate Rust `crates/browser-automation`.
- sessioni browser locali e policy per dominio.
- osservazione pagina, DOM extraction e screenshot.
- azioni atomiche: navigate, click, type, select, upload, download, submit.
- compilazione form e prenotazioni con step approvati.
- handoff per CAPTCHA, 2FA, pagamenti e dati sensibili.
- adapter `BrowserCapabilityProvider` nel Capability Layer.
- integrazione con Durable Task Runtime per ricerche, monitoraggi e operazioni di giorni.

Regola: il browser engine esegue step controllati, ma non possiede la durata del task.

### Fase 7 - Desktop Observation MVP

Deliverable:

- app watcher.
- active window watcher.
- git event collector.
- filesystem watcher.
- browser domain observer.
- event batching.
- routine proposal.

### Fase 8 - Tauri UI

Deliverable:

- task queue e task detail.
- inbox assistant.
- chat.
- routine detected.
- connectors needed.
- memories learned.
- approval center.
- settings/privacy.

### Fase 9 - First Automation

Use case:

```text
Avvio lavoro Acme
  -> git pull
  -> Trello assigned cards
  -> Mattermost unread messages
  -> summary
  -> open Zed/project
```

### Fase 10 - Production Hardening

Deliverable:

- process supervision dei sidecar.
- secrets in keychain/secure storage.
- migrations e recovery testate.
- export/delete globale dei dati utente.
- osservabilita' locale.
- limiti risorse reali per LLM, browser, Graphify e connettori.
- test end-to-end su workflow durevoli.
- packaging Tauri per macOS, Windows e Linux.

## Struttura Repository Proposta

```text
local-first-personal-assistant/
  apps/
    desktop/
      src/
      src-tauri/
  crates/
    core/
    memory/
    task-runtime/
    connectors/
    capabilities/
    browser-automation/
    automation/
    permissions/
    subagents/
  runtimes/
    mlx-gemma4/
      server.py
      contracts/
      tests/
  packages/
    shared-contracts/
    ui/
  integrations/
    graphify/
    obsidian-wiki/
    mcp/
    managed-providers/
  docs/
    architecture/
    decisions/
    security/
    memory/
  tests/
    evals/
    fixtures/
  scripts/
```

## Riferimenti

- OpenHuman, spunto di riferimento da studiare e adattare, non da copiare: https://github.com/tinyhumansai/openhuman
- OpenClaw, riferimento principale per browser automation, da adattare con attribution MIT: https://github.com/openclaw/openclaw
- Graphify repo: https://github.com/safishamsi/graphify
- GraphifyLabs: https://graphifylabs.ai/
- Obsidian Wiki: https://github.com/Ar9av/obsidian-wiki
- MLX: https://github.com/ml-explore/mlx
- MLX LM: https://github.com/ml-explore/mlx-lm
- MLX VLM: https://github.com/Blaizzy/mlx-vlm
- Tauri: https://tauri.app/
- MCP: https://modelcontextprotocol.io/
- Composio MCP: https://docs.composio.dev/mcp/introduction
- Zapier MCP: https://zapier.com/mcp
- Pipedream MCP: https://pipedream.com/docs/connect/mcp/users/
- n8n MCP: https://docs.n8n.io/advanced-ai/mcp/

## Prossima Azione Consigliata

Progettare e implementare il modulo Browser Automation come capability separata:

```text
crates/browser-automation/
crates/capabilities/src/browser.rs
docs/superpowers/specs/2026-05-23-browser-automation-design.md
docs/superpowers/plans/2026-05-23-browser-automation.md
```

Il runtime Python/MLX, la memoria, i subagenti, il Durable Task Runtime e il Capability Layer hanno una base operativa. Il prossimo blocco e' il browser locale: navigazione, DOM/screenshot, form, prenotazioni, task lunghi e handoff sensibili, sempre dietro policy, audit, registry provider e Resource Governor.
