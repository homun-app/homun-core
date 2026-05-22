# Local-First Personal Assistant

Documento fondativo del progetto per costruire un personal assistant locale, proattivo e installabile su macOS, Windows e Linux. Il nome e il branding sono provvisori; questo file serve a fissare architettura, componenti, decisioni tecniche, riferimenti e roadmap.

## Visione

Costruire un assistant che non sia una chat passiva. Deve osservare il lavoro quotidiano dell'utente, imparare routine, costruire memoria verificabile, proporre automazioni e operare sul computer con autorizzazioni progressive.

Il modello mentale e': un apprendista che osserva, capisce, propone, esegue con permesso e nel tempo diventa un maestro operativo.

Principi:

- local-first: i dati e la memoria restano sul dispositivo per default.
- trasparente: l'utente vede e corregge cio' che l'assistant sa.
- operativo: ogni azione passa da contratti, permessi e audit trail.
- proattivo: l'assistant rileva pattern e propone aiuto prima che venga chiesto.
- estendibile: connettori, MCP, skill e runtime LLM devono essere modulari.

## Decisioni Gia' Validate

### Stack applicazione

- Desktop shell: Tauri.
- UI: React + TypeScript.
- Core locale: Rust.
- Runtime inference Mac: Python + MLX + mlx-vlm.
- Modello Mac default: `mlx-community/gemma-4-e4b-it-4bit`.
- Memoria primaria: SQLite + grafo + wiki Markdown.
- Graph/document memory: Graphify / GraphifyLabs.
- Human-readable memory: Obsidian Wiki / LLM Wiki.

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
    -> Connector Manager
    -> Automation Engine
    -> Local LLM Runtime
      -> Python sidecar
      -> MLX / mlx-vlm
      -> Gemma 4
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

API interne previste:

```text
runtime.health()
runtime.generate_json(contract, input)
runtime.tool_call(tools, input)
runtime.analyze_image(image, contract)
memory.write_event(event)
memory.extract_candidates(event_batch)
memory.upsert_entity(entity)
memory.upsert_relation(relation)
automation.propose(candidate)
automation.execute_with_approval(id)
```

### 3. Local LLM Runtime

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

### 4. Contratti LLM

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

Graphify non va perso. E' il motore per la memoria tecnica e documentale.

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
- marketplace esterni per copertura ampia.
- fallback browser automation solo quando non esiste API affidabile.

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
- streaming.
- schema validation.
- benchmark endpoint.

### Fase 2 - Memory Core

Deliverable:

- SQLite schema.
- event log.
- entities/relations graph model.
- memory extraction contract.
- routine inference contract.
- evidence tracking.

### Fase 3 - Graphify Integration

Deliverable:

- install/runtime strategy per `graphifyy`.
- import graph output.
- query API.
- project/codebase graph.
- link fra Graphify nodes e nostro entity graph.

### Fase 4 - Obsidian Wiki Integration

Deliverable:

- vault path config.
- page templates.
- wiki writer.
- wiki updater.
- bidirectional sync minima: DB -> Markdown, Markdown corrections -> DB candidate updates.

### Fase 5 - Desktop Observation MVP

Deliverable:

- app watcher.
- active window watcher.
- git event collector.
- filesystem watcher.
- browser domain observer.
- event batching.
- routine proposal.

### Fase 6 - Tauri UI

Deliverable:

- inbox assistant.
- chat.
- routine detected.
- connectors needed.
- memories learned.
- approval center.
- settings/privacy.

### Fase 7 - First Automation

Use case:

```text
Avvio lavoro Acme
  -> git pull
  -> Trello assigned cards
  -> Mattermost unread messages
  -> summary
  -> open Zed/project
```

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
    connectors/
    automation/
    permissions/
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

- OpenHuman: https://github.com/tinyhumansai/openhuman
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

Creare il primo vero modulo:

```text
runtimes/mlx-gemma4/server.py
```

Deve caricare `mlx-community/gemma-4-e4b-it-4bit`, esporre `/health`, `/generate_json`, `/tool_call`, `/analyze_image`, e riusare i contratti gia' testati in `tests/gemma4_eval.py`.

Obiettivo: trasformare il test locale in un servizio stabile che il Rust core potra' avviare e interrogare.
