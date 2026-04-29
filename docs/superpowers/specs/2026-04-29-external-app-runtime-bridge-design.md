# External App Runtime And Homun Bridge Design

Data: 2026-04-29
Status: proposta di design

## Obiettivo

Portare App Factory oltre il CRUD generico: ogni app generata deve poter diventare una vera applicazione esterna, con UI separata da Homun, utenti propri, ruoli propri, database isolato e un contratto esplicito di comunicazione bidirezionale con Homun.

La direzione prodotto e':

- Homun crea, pubblica e governa le app;
- l'app pubblicata viene usata da utenti che possono non essere utenti Homun;
- l'app comunica con Homun come capability controllata, simile a un MCP interno;
- ogni accesso a profili, contatti, canali, knowledge e tool passa da un permission contract esplicito.

## Non Obiettivi V0

- SSO enterprise.
- Multi-tenant pubblico con domini custom.
- Marketplace di app.
- RBAC enterprise granulare su ogni campo.
- Webhook pubblici arbitrari.
- Codice custom generato dal modello.
- Bridge verso vault o memoria personale libera.

## Modello Prodotto

### Homun Studio

Homun resta il control plane:

- crea app da blueprint;
- pubblica/disattiva app;
- gestisce owner e profili Homun autorizzati ad amministrare;
- configura ruoli app;
- configura accesso a contatti, canali, knowledge namespace e tool;
- vede audit, errori, eventi e dati tecnici;
- usa l'app tramite agent tools.

Route indicativa:

```text
/apps
/apps/{slug}
/apps/{slug}/settings
/apps/{slug}/bridge
```

### App Pubblicata

L'app pubblicata e' il runtime esterno:

```text
/a/{slug}/login
/a/{slug}
/a/{slug}/logout
```

Caratteristiche:

- nessuna sidebar Homun;
- nessuna voce Automation/Brain/Extensions;
- layout specifico dell'app;
- login app-local;
- sessione app-local;
- ruoli app-local;
- viste e azioni filtrate in base al ruolo;
- dati operativi nel database isolato dell'app.

## Identita' E Accessi App-Local

Un utente app non deve essere per forza un utente Homun.

Tabelle nel database isolato dell'app:

```sql
CREATE TABLE app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    contact_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE app_sessions (
    id TEXT PRIMARY KEY,
    app_user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    role TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

V0 usa email/password locale. Inviti e magic link sono previsti dal modello ma possono arrivare subito dopo.

## Ruoli V0

Ruoli standard:

- `admin`: gestisce utenti app, dati, impostazioni app;
- `approver`: vede richieste assegnate o pending, approva/rifiuta;
- `employee`: crea e vede le proprie richieste;
- `viewer`: sola lettura.

Il blueprint puo' dichiarare ruoli custom, ma la v0 deve mappare sempre almeno questi quattro ruoli quando il dominio lo richiede.

Esempio:

```json
"roles": [
  { "name": "admin", "label": "Admin" },
  { "name": "approver", "label": "Responsabile" },
  { "name": "employee", "label": "Dipendente" }
]
```

## Bridge MCP-Like

Ogni app pubblicata ha un bridge dichiarativo con Homun.

Esempio blueprint/control-plane:

```json
"homun_access": {
  "profiles": ["azienda-acme"],
  "contacts": {
    "read": ["employees", "managers"],
    "link_app_users": true
  },
  "channels": {
    "send": ["email", "telegram"],
    "receive": []
  },
  "knowledge_namespaces": ["hr-policy"],
  "tools": ["contacts", "knowledge", "send_message"],
  "writeback": ["events", "notifications"]
}
```

Il bridge non concede accesso diretto al database Homun. Espone capability controllate:

### Homun Verso App

- `create_app_record`
- `query_app_records`
- `run_app_action`
- `list_app_users`
- `notify_app_user`

### App Verso Homun

- risolvere contatto collegato;
- leggere knowledge namespace autorizzati;
- inviare messaggi tramite canali autorizzati;
- scrivere eventi/audit;
- chiedere all'agente Homun di eseguire un workflow consentito.

## Permission Contract

Il bridge deve essere fail-closed:

- se una capability non e' dichiarata, e' negata;
- se un profilo non e' autorizzato, e' invisibile;
- se un canale non e' autorizzato, non puo' inviare;
- se un knowledge namespace non e' autorizzato, non puo' essere cercato;
- se un utente app non ha ruolo adeguato, non vede l'azione.

La v0 deve salvare il contratto nel control plane, non nel solo blueprint, cosi' Homun Studio puo' modificarlo senza rigenerare l'app.

Tabella proposta in `homun.db`:

```sql
CREATE TABLE internal_app_bridge_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    policy_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);
```

## Data Flow

### Dipendente Crea Richiesta

```text
app user login
  -> /a/ferie-permessi
  -> create leave_request
  -> app DB stores record with created_by_app_user_id
  -> app event leave_request.created
  -> bridge checks policy
  -> Homun may send notification to approver via allowed channel
```

### Approver Approva

```text
approver login
  -> sees pending requests
  -> clicks approve
  -> app runtime validates role + transition
  -> app DB updates record
  -> app event leave_request.approved
  -> bridge writes internal app event
  -> Homun may notify employee/contact via allowed channel
```

### Homun Agente Interroga App

```text
Homun chat
  -> agent selects app tool
  -> control plane verifies owner/profile
  -> app DB query
  -> response based on scoped records
```

## UI V0

### Homun Studio

Serve una console app con:

- overview app;
- publish status;
- link pubblico `/a/{slug}`;
- app users;
- roles;
- bridge permissions;
- audit/eventi;
- danger zone.

### Runtime Esterno

Serve una UI separata:

- login;
- header app minimale;
- nav interna app;
- dashboard per ruolo;
- viste operative;
- logout;
- nessun riferimento visivo alla console Homun, salvo piccolo footer opzionale "Powered by Homun".

## Demo Ferie/Permessi

Ruoli:

- `admin`: Fabio/Homun owner configura app;
- `approver`: responsabile;
- `employee`: dipendente.

Flusso:

1. Homun Studio pubblica `ferie-permessi`.
2. Admin crea due utenti app: dipendente e responsabile.
3. Dipendente entra da `/a/ferie-permessi/login`.
4. Dipendente crea richiesta ferie.
5. Responsabile entra da `/a/ferie-permessi/login`.
6. Responsabile vede richieste pending.
7. Responsabile approva.
8. Homun riceve evento e puo' inviare notifica usando solo canali autorizzati.
9. Chat Homun puo' chiedere: "quante richieste approvate ci sono questa settimana?"

## Sicurezza

- Password app hashate con lo stesso standard usato da Homun web auth.
- Session cookie separato da quello Homun.
- Cookie path-scoped su `/a/{slug}` quando possibile.
- Nessun accesso app-local alla sessione Homun.
- Ogni query app verifica app slug + app_user session + role.
- Ogni bridge call verifica policy in `homun.db`.
- Nessuna capability implicita.
- Audit su login, record create/update, transition, bridge call.

## Incrementi Implementativi

### P0

- route `/a/{slug}/login`, `/a/{slug}`, `/a/{slug}/logout`;
- schema app-local users/sessions;
- seed admin app al momento della pubblicazione;
- ruolo app su record/action;
- runtime esterno senza sidebar Homun;
- policy bridge salvata in control plane;
- UI Homun Studio minima per vedere link pubblico e utenti app;
- demo ferie/permessi funzionante con employee/approver.

### P1

- inviti email/magic link;
- linking app_user <-> contact;
- notifiche reali via allowed channels;
- knowledge lookup autorizzato;
- bridge audit viewer;
- admin UI completa per policy.

### P2

- domini custom/subdomain;
- template ruolo/permesso per verticali;
- app marketplace;
- componenti avanzati dashboard/calendar/kanban;
- bridge verso MCP esterni.

## Decisioni V0 Proposte

Per la prima implementazione si propone di fissare queste decisioni:

- login locale con email/password;
- ruoli standard `admin`, `approver`, `employee`, `viewer`;
- bridge policy salvata in `homun.db`;
- app users nel DB isolato app;
- runtime pubblico sotto `/a/{slug}`.

Queste decisioni tengono la demo realistica senza introdurre subito dipendenze da email delivery, SSO o domini esterni.
