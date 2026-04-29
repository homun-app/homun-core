# SPEC: Tool/App Factory Blueprint v0

> Status: Implementazione demo v0 completata, in verifica finale
> Data: 2026-04-29
> Obiettivo: definire il contratto tecnico per generare applicazioni interne tramite blueprint dichiarativi e componenti predefiniti.

---

## 0. Stato implementativo

Al 2026-04-29 la v0 demo include:

- dominio blueprint e validazione schema;
- registry app interne nel control plane;
- database SQLite dedicato per ogni app;
- storage generico record/eventi;
- API interne per app, record e azioni;
- UI `/apps` e `/apps/{slug}`;
- workflow locale su campi enum;
- tool agente per creare app, leggere/scrivere record e lanciare azioni;
- skill `app-factory`;
- blueprint demo ferie/permessi e runbook operativo.

Rischi/limiti consapevoli:

- relation v0 e' rappresentata come valore semplice nel record; lookup/selector avanzato e' P1;
- notification e automation blueprint sono metadati/proposte, non invii reali P0;
- RBAC granulare e ruoli multiutente sono P1/P2; la v0 protegge via ownership utente/profilo;
- import/export, allegati, calendario e dashboard sono componenti futuri;
- la generazione live del blueprint dipende dal modello, quindi la demo usa un blueprint pre-seed come fallback.

---

## 1. Scopo

La Tool/App Factory permette a Homun di trasformare una richiesta aziendale in una app interna funzionante.

La v0 deve supportare una demo completa:

> Crea un'app interna per gestire ferie e permessi, con richieste dipendenti, approvazione responsabile, lista richieste, dettaglio e interrogazione via agente.

La v0 non deve generare codice arbitrario. Il modello produce un blueprint validato, e Homun lo interpreta con componenti approvati.

---

## 2. Principi

1. **Blueprint first**
   - Il blueprint e' il contratto stabile.
   - L'agente puo' proporlo, modificarlo e salvarlo.
   - Il runtime lo valida e lo renderizza.

2. **Componenti predefiniti**
   - UI, storage, workflow e tool sono composti da mattoni noti.
   - Nessun JavaScript/Rust/SQL arbitrario generato dal modello nella v0.

3. **User/profile scoped**
   - Ogni app, record e evento e' scoped a `user_id`.
   - `profile_id` e' opzionale ma supportato, come memory/knowledge.

4. **Agent-usable**
   - Le app create non sono solo UI.
   - L'agente deve poter leggere, creare, aggiornare record e lanciare azioni tramite tool.

5. **Estendibile**
   - La v0 supporta CRUD + workflow semplice.
   - Le versioni successive aggiungono componenti senza rompere i blueprint v0.

---

## 3. Architettura

```text
User prompt
  -> App Factory Skill
  -> Blueprint JSON
  -> Blueprint validator
  -> App registry
  -> Generic app storage
  -> Generic app renderer
  -> App tools for agent
  -> Workflow / Automation / MCP integrations
```

### Componenti Homun coinvolti

| Area | Ruolo nella Tool/App Factory |
|---|---|
| Skills | Skill `app-factory` guida il modello nella produzione del blueprint |
| MCP | Connessioni esterne opzionali per app future: calendar, Slack, GitHub, Notion, Google |
| Tool Registry | Espone tool per creare app, leggere/scrivere record e lanciare azioni |
| Workflow | Esegue transizioni con approvazioni o step sequenziali |
| Automation | Reminder, report periodici, notifiche su eventi |
| Gateway | Routing messaggi/canali e notifiche |
| Memory/Knowledge | Policy aziendali, contesto utente, documenti usati dall'app |
| Vault | Segreti per integrazioni esterne |
| Web UI | Renderer delle app interne e admin view |

---

## 4. Blueprint schema v0

### Root

```json
{
  "version": 1,
  "app": {},
  "entities": [],
  "views": [],
  "workflows": [],
  "roles": [],
  "notifications": [],
  "automations": [],
  "agent_commands": []
}
```

Campi obbligatori:

- `version`
- `app`
- `entities`
- `views`

Campi opzionali:

- `workflows`
- `roles`
- `notifications`
- `automations`
- `agent_commands`

### App

```json
{
  "slug": "ferie-permessi",
  "name": "Ferie e Permessi",
  "description": "Gestione richieste ferie e permessi dei dipendenti",
  "icon": "calendar"
}
```

Regole:

- `slug`: lowercase, numeri e trattini, max 64 caratteri.
- `name`: max 80 caratteri.
- `description`: max 500 caratteri.
- `icon`: nome simbolico tra icone consentite.

### Entity

```json
{
  "name": "leave_request",
  "label": "Richiesta",
  "fields": []
}
```

Regole:

- `name`: lowercase snake_case, max 64 caratteri.
- `label`: max 80 caratteri.
- ogni entity deve avere almeno un field.

### Field

Tipi v0:

- `string`
- `text`
- `number`
- `date`
- `boolean`
- `enum`
- `relation`

Esempi:

```json
{ "name": "full_name", "type": "string", "label": "Nome completo", "required": true }
```

```json
{ "name": "kind", "type": "enum", "label": "Tipo", "options": ["ferie", "permesso"], "required": true }
```

```json
{ "name": "employee", "type": "relation", "to": "employee", "label": "Dipendente" }
```

Regole:

- `name`: lowercase snake_case, max 64 caratteri.
- `label`: max 80 caratteri.
- `required`: default `false`.
- `default`: valore JSON compatibile col tipo.
- `enum.options`: 1-32 opzioni stringa.
- `relation.to`: deve puntare a una entity esistente.

### View

Tipi v0:

- `table`
- `form`
- `detail`

Esempi:

```json
{ "type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["employee", "kind", "start_date", "end_date", "status"] }
```

```json
{ "type": "form", "entity": "leave_request", "name": "Nuova richiesta" }
```

Regole:

- `entity`: deve esistere.
- `columns`: solo field esistenti.
- ogni app deve avere almeno una table view.
- se manca una form view, il runtime puo' generarne una default per ogni entity.

### Workflow

La v0 supporta workflow a stati su una singola entity.

```json
{
  "entity": "leave_request",
  "state_field": "status",
  "states": ["pending", "approved", "rejected"],
  "transitions": [
    { "name": "approve", "from": "pending", "to": "approved", "label": "Approva" },
    { "name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta" }
  ]
}
```

Regole:

- `state_field` deve essere un field enum.
- `states` deve combaciare con le opzioni enum.
- ogni transition deve avere `from`, `to`, `name`, `label`.
- v0 non supporta condizioni arbitrarie o script.

### Role

```json
{
  "name": "approver",
  "label": "Responsabile",
  "permissions": [
    "leave_request:read",
    "leave_request:update",
    "leave_request:transition:approve",
    "leave_request:transition:reject"
  ]
}
```

Regole v0:

- se `roles` e' assente, l'app e' disponibile all'utente proprietario.
- i ruoli sono metadati per UI e futura RBAC; enforcement v0 usa `user_id` owner/admin.

### Notification

```json
{
  "on": "leave_request.approved",
  "channel": "web",
  "message": "Richiesta ferie approvata per {{employee}}"
}
```

Regole v0:

- supporto obbligatorio solo a evento registrato/audit.
- invio canale reale e' P1, non P0.

### Automation

```json
{
  "name": "Reminder richieste pendenti",
  "schedule": "every:86400",
  "task": "Controlla richieste ferie pending e avvisa il responsabile"
}
```

Regole v0:

- si salva come proposta, non necessariamente come automation attiva automatica.
- attivazione reale e' P1 se il tempo lo consente.

### AgentCommand

```json
{
  "intent": "create_leave_request",
  "entity": "leave_request",
  "action": "create",
  "examples": [
    "Crea una richiesta ferie per Mario dal 10 al 12 maggio"
  ]
}
```

Azioni v0:

- `create`
- `query`
- `update`
- `transition`

Uso:

- il prompt dell'agente include le app disponibili e i comandi supportati;
- il modello sceglie i tool app runtime invece di inventare dati.

---

## 5. Storage v0

La v0 separa il database di controllo dal database dati delle app generate.

- `homun.db` resta il control plane: contiene metadata, ownership, blueprint, path del database applicativo e audit di sistema.
- ogni app generata ha un proprio SQLite dedicato: contiene i record operativi dell'app.
- il runtime apre il database dell'app solo dopo aver verificato ownership e profilo nel control plane.

Questa scelta mantiene semplice la v0 ma introduce isolamento reale: se una singola app viene corrotta o compromessa, i dati delle altre app e il database principale non sono nello stesso file dati.

### Tabelle in `homun.db`

```sql
CREATE TABLE internal_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    profile_id INTEGER,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    blueprint_json TEXT NOT NULL,
    db_path TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    storage_mode TEXT NOT NULL DEFAULT 'sqlite_per_app',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(user_id, slug)
);
```

```sql
CREATE TABLE internal_app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    record_id INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    actor_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Indici

```sql
CREATE INDEX idx_internal_apps_user_profile ON internal_apps(user_id, profile_id);
CREATE INDEX idx_internal_app_events_app_record ON internal_app_events(app_id, record_id);
```

### Database per-app

Ogni app usa un file dedicato:

```text
~/.homun/apps/<user_id>/<app_slug>/app.db
```

Schema v0 del database applicativo:

```sql
CREATE TABLE app_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    actor_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_app_records_entity ON app_records(entity_name);
CREATE INDEX idx_app_events_record ON app_events(record_id);
```

### Perche' SQLite per-app

Pro:

- isolamento tra app generate;
- backup, export e cancellazione per singola app;
- superficie di danno limitata se un'app viene compromessa;
- nessun SQL custom generato dal modello;
- blueprint versionabile nel control plane.

Contro:

- piu' file da gestire;
- serve aprire pool/connessioni per-app;
- query aggregate cross-app non immediate;
- validazione applicativa necessaria;
- report complessi richiederanno indici o materializzazioni nel DB applicativo.

Decisione v0: control plane in `homun.db`, record operativi in SQLite dedicato per ogni app.

---

## 6. API v0

Prefisso: `/api/v1/apps`.

### List apps

```http
GET /api/v1/apps?profile=default
```

Risposta:

```json
{
  "apps": [
    { "id": 1, "slug": "ferie-permessi", "name": "Ferie e Permessi", "status": "active" }
  ]
}
```

### Create app

```http
POST /api/v1/apps
Content-Type: application/json

{
  "profile": "default",
  "blueprint": {}
}
```

Comportamento:

- valida blueprint;
- risolve `profile` solo tra profili dell'utente;
- salva `internal_apps`;
- restituisce link interno.

### Get app

```http
GET /api/v1/apps/ferie-permessi
```

### List records

```http
GET /api/v1/apps/ferie-permessi/entities/leave_request/records
```

### Create record

```http
POST /api/v1/apps/ferie-permessi/entities/leave_request/records
Content-Type: application/json

{
  "data": {
    "employee": 1,
    "kind": "ferie",
    "start_date": "2026-05-10",
    "end_date": "2026-05-12",
    "notes": "vacanza famiglia"
  }
}
```

### Update record

```http
PUT /api/v1/apps/ferie-permessi/entities/leave_request/records/123
```

### Run transition

```http
POST /api/v1/apps/ferie-permessi/entities/leave_request/records/123/actions/approve
```

Comportamento:

- valida workflow;
- cambia `status`;
- scrive evento `leave_request.approved`;
- restituisce record aggiornato.

---

## 7. Web UI v0

### Route

```text
/apps
/apps/{slug}
```

### `/apps`

Lista app interne dell'utente/profilo:

- nome;
- descrizione;
- stato;
- data creazione;
- pulsante apri;
- pulsante crea da blueprint, se admin/write.

### `/apps/{slug}`

Renderer generico:

- header app;
- tab viste;
- table view;
- form view;
- detail view;
- azioni workflow come bottoni.

Stile:

- coerente con `Memory`, `Knowledge`, `Contacts`;
- niente card annidate;
- indicatore scope `utente / profilo`;
- layout denso e operativo.

---

## 8. Tool v0

### `create_internal_app`

Input:

```json
{
  "blueprint": {},
  "profile": "default"
}
```

Output:

```text
Created internal app "Ferie e Permessi": /apps/ferie-permessi
```

### `list_internal_apps`

Input:

```json
{ "profile": "default" }
```

### `create_app_record`

Input:

```json
{
  "app": "ferie-permessi",
  "entity": "leave_request",
  "data": {}
}
```

### `query_app_records`

Input v0:

```json
{
  "app": "ferie-permessi",
  "entity": "leave_request",
  "filters": [
    { "field": "status", "op": "eq", "value": "approved" }
  ],
  "limit": 20
}
```

Operatori v0:

- `eq`
- `neq`
- `contains`
- `gte`
- `lte`

### `run_app_action`

Input:

```json
{
  "app": "ferie-permessi",
  "entity": "leave_request",
  "record_id": 123,
  "action": "approve"
}
```

---

## 9. Skill `app-factory`

La skill deve guidare il modello a produrre blueprint validi.

### Responsabilita'

- fare domande solo se il dominio e' ambiguo;
- proporre entita', campi, viste e workflow;
- generare JSON blueprint v0;
- non generare codice;
- usare `create_internal_app` dopo validazione/approvazione.

### Prompt policy

- "If the user asks to create an internal app/tool, activate app-factory."
- "Produce a blueprint first."
- "Never invent unsupported components."
- "When unsure, keep the app small and extendable."

### Allowed tools consigliati

- `create_internal_app`
- `list_internal_apps`
- `create_app_record`
- `query_app_records`
- `run_app_action`
- `write_file`
- `read_file`

---

## 10. Integrazione con workflow e automation

### Workflow v0

Il workflow blueprint e' locale all'app e gestito dal runtime come transizione di stato.

Non e' necessario creare un `WorkflowEngine` workflow per ogni approvazione semplice.

Quando usare `WorkflowEngine`:

- processi multi-step lunghi;
- step con approvazione conversazionale;
- step che invocano agente/tool esterni;
- retry/resume.

### Automation v0

Le automation blueprint sono salvate come proposte/metadati.

Attivazione reale P1:

- creare automation Homun da blueprint;
- collegarla a record/eventi app;
- notificare canali.

Per demo P0 basta:

- evento audit su `approved/rejected`;
- eventualmente messaggio UI "notification would be sent".

---

## 11. Integrazione MCP

La v0 non deve richiedere MCP per funzionare.

Le app future possono dichiarare:

```json
{
  "integrations": [
    { "kind": "mcp", "server": "google-workspace", "capability": "calendar" }
  ]
}
```

Regola:

- se MCP manca, l'app resta funzionante in modalita' locale;
- Homun suggerisce setup MCP solo quando serve;
- credenziali restano in vault/config.

---

## 12. Sicurezza e isolamento

### Obbligatorio v0

- `internal_apps.user_id` sempre valorizzato.
- ogni query API filtra per `auth.user_id`.
- `profile` slug risolto solo per profili dell'utente.
- record accessibili solo dopo lookup dell'app in `internal_apps` con `auth.user_id`.
- il path del DB applicativo viene risolto dal server, mai accettato dal client o dal modello.
- ogni app usa un database SQLite dedicato sotto `~/.homun/apps/<user_id>/<app_slug>/app.db`.
- blueprint validato prima del salvataggio.
- nessun HTML/JS custom da blueprint.
- nessun SQL custom da blueprint.
- limiti:
  - max 12 entity;
  - max 40 field per entity;
  - max 20 view;
  - max 20 transition;
  - blueprint max 128 KB;
  - record data max 64 KB.

### Non supportato v0

- script custom;
- query SQL custom;
- webhook pubblici per app;
- upload allegati;
- ruoli multiutente complessi;
- azioni destructive batch.

---

## 13. Validatore blueprint

Il validatore deve restituire errori user-facing.

Controlli:

- JSON valido;
- root fields consentiti;
- slug valido;
- nomi entity/field univoci;
- relazioni verso entity esistenti;
- viste verso entity/campi esistenti;
- workflow verso field enum esistente;
- transition coerenti con states;
- limiti dimensionali;
- nessun campo sconosciuto critico, oppure reject in strict mode.

Output errore:

```json
{
  "ok": false,
  "errors": [
    "Entity leave_request references unknown relation target employee"
  ]
}
```

---

## 14. Demo blueprint ferie/permessi

```json
{
  "version": 1,
  "app": {
    "slug": "ferie-permessi",
    "name": "Ferie e Permessi",
    "description": "Gestione richieste ferie e permessi dei dipendenti",
    "icon": "calendar"
  },
  "entities": [
    {
      "name": "employee",
      "label": "Dipendente",
      "fields": [
        { "name": "full_name", "type": "string", "label": "Nome completo", "required": true },
        { "name": "email", "type": "string", "label": "Email" },
        { "name": "team", "type": "string", "label": "Team" }
      ]
    },
    {
      "name": "leave_request",
      "label": "Richiesta",
      "fields": [
        { "name": "employee", "type": "relation", "to": "employee", "label": "Dipendente", "required": true },
        { "name": "kind", "type": "enum", "label": "Tipo", "options": ["ferie", "permesso", "malattia"], "required": true },
        { "name": "start_date", "type": "date", "label": "Dal", "required": true },
        { "name": "end_date", "type": "date", "label": "Al", "required": true },
        { "name": "notes", "type": "text", "label": "Note" },
        { "name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved", "rejected"], "default": "pending" }
      ]
    }
  ],
  "views": [
    { "type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["employee", "kind", "start_date", "end_date", "status"] },
    { "type": "form", "entity": "leave_request", "name": "Nuova richiesta" },
    { "type": "detail", "entity": "leave_request", "name": "Dettaglio richiesta" }
  ],
  "workflows": [
    {
      "entity": "leave_request",
      "state_field": "status",
      "states": ["pending", "approved", "rejected"],
      "transitions": [
        { "name": "approve", "from": "pending", "to": "approved", "label": "Approva" },
        { "name": "reject", "from": "pending", "to": "rejected", "label": "Rifiuta" }
      ]
    }
  ],
  "agent_commands": [
    {
      "intent": "create_leave_request",
      "entity": "leave_request",
      "action": "create",
      "examples": ["Crea una richiesta ferie per Mario dal 10 al 12 maggio"]
    },
    {
      "intent": "count_approved_leave_requests",
      "entity": "leave_request",
      "action": "query",
      "examples": ["Quante richieste ferie sono state approvate questa settimana?"]
    }
  ]
}
```

---

## 15. Definition of Done v0

La v0 e' completa quando:

- [x] migration/control plane crea le tabelle app/eventi;
- [x] ogni app usa un database SQLite dedicato;
- [x] blueprint validator ha test unitari;
- [x] API crea/lista app e record;
- [x] UI `/apps/{slug}` renderizza table/form/detail;
- [x] workflow approve/reject cambia stato e scrive evento;
- [x] tool app runtime sono registrati;
- [x] skill `app-factory` produce blueprint valido;
- [x] demo ferie/permessi ha blueprint pre-seed e runbook;
- [ ] smoke test manuale finale su gateway release;
- [x] `cargo fmt --all -- --check`, `cargo check --all-features`, `cargo test --all-features app_factory`, `cargo test --all-features tools::app_factory`, `cargo clippy --all-features -- -D warnings`, build release passano nell'ultimo giro di verifica.

Ultima verifica automatica: 2026-04-29.
