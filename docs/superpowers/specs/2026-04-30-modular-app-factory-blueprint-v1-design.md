# Modular App Factory Blueprint v1 Design

Data: 2026-04-30
Status: approvata per pianificazione

## Obiettivo

Portare App Factory da interprete CRUD generico a sistema modulare capace di creare applicazioni aziendali semplici ma credibili durante una demo live.

Il modello non deve generare codice arbitrario. Deve scegliere moduli applicativi predefiniti, configurarli con un blueprint validato e lasciare al runtime Homun il compito di comporre database isolato, UI, ruoli, workflow, viste e capability verso Homun.

La promessa demo e':

> "Descrivo un'app interna. Homun capisce quali moduli servono, crea un'app separata con login proprio, database isolato, ruoli, viste e azioni coerenti."

## Problema Attuale

La v0 dimostra che Homun puo' creare e renderizzare un'app, ma tratta ancora troppi elementi come campi generici. Nell'esempio ferie/permessi, un employee puo' impostare direttamente lo stato della richiesta nel form. Questo e' sbagliato: `status` e' uno stato di workflow, non input utente.

Il problema non e' solo il campo `status`. Manca un contratto generale per distinguere:

- campi utente;
- campi di sistema;
- campi gestiti da workflow;
- azioni disponibili per ruolo;
- viste disponibili per ruolo;
- dati propri, dati del team e dati globali;
- capability Homun accessibili all'app.

## Principi

1. **Modulo prima del campo**
   Il modello deve ragionare in termini di moduli: identity, data, workflow, navigation, dashboard, calendar, directory, notifications, agent bridge.

2. **Blueprint dichiarativo**
   Il blueprint descrive cosa comporre, non come implementarlo. Nessun JavaScript, SQL o Rust generato dal modello.

3. **Runtime fail-closed**
   Se un permesso, una vista, una transizione o una capability non sono dichiarati, sono negati.

4. **Database isolato per app**
   Ogni app generata mantiene il proprio database operativo. Homun conserva registry, ownership, blueprint, bridge policy e audit nel control plane.

5. **UI generata da primitive approvate**
   Le app devono sembrare prodotti finiti, non form grezzi. Il runtime usa layout e componenti di qualita' gia' pronti.

6. **Chat come interfaccia di modifica**
   L'utente deve poter dire "aggiungi un campo", "crea un ruolo", "metti una dashboard", "fai approvare al responsabile" e Homun deve aggiornare il blueprint usando operazioni guidate.

## Blueprint v1

### Root

```json
{
  "version": 1,
  "app": {},
  "modules": [],
  "entities": [],
  "views": [],
  "workflows": [],
  "roles": [],
  "permissions": [],
  "navigation": [],
  "dashboards": [],
  "calendars": [],
  "notifications": [],
  "homun_access": {},
  "agent_commands": []
}
```

`modules` diventa il punto di partenza. Le altre sezioni configurano i moduli scelti.

### Modulo

```json
{
  "name": "workflow",
  "version": 1,
  "features": ["state_machine", "approval_actions"],
  "required": true
}
```

Regole:

- `name` deve appartenere al catalogo moduli supportato.
- `version` permette evoluzioni compatibili.
- `features` abilita sotto-capacita' del modulo.
- `required=true` significa che l'app non puo' essere pubblicata se il modulo non e' valido.

## Catalogo Moduli

### P0: identity

Gestisce utenti app-local, ruoli, sessioni e inviti.

Responsabilita':

- login separato da Homun;
- utenti app-local;
- ruoli standard e custom;
- mapping opzionale verso contatti Homun;
- admin sempre con tutti i permessi dell'app;
- employee limitato ai propri dati;
- approver con azioni di approvazione configurate.

Schema minimo:

```json
{
  "name": "identity",
  "features": ["local_users", "roles", "ownership"]
}
```

### P0: data

Gestisce entity, campi, relazioni, ownership e storage record.

Nuovi attributi campo:

```json
{
  "name": "status",
  "type": "enum",
  "label": "Stato",
  "options": ["pending", "approved", "rejected"],
  "default": "pending",
  "system": true,
  "managed_by": "workflow",
  "editable_by": []
}
```

Regole:

- i campi `system=true` non appaiono nei form di creazione standard;
- `managed_by=workflow` puo' essere modificato solo da transizioni;
- `editable_by` controlla ruoli abilitati alla modifica diretta;
- il server ignora o rifiuta input non autorizzati, anche se inviati via API.

### P0: workflow

Gestisce stati, transizioni e azioni.

Schema:

```json
{
  "entity": "leave_request",
  "state_field": "status",
  "initial_state": "pending",
  "states": ["pending", "approved", "rejected"],
  "transitions": [
    {
      "name": "approve",
      "from": "pending",
      "to": "approved",
      "label": "Approva",
      "roles": ["admin", "approver"]
    }
  ]
}
```

Regole:

- `initial_state` viene applicato server-side;
- un utente vede solo azioni compatibili con il suo ruolo;
- admin puo' sempre eseguire transizioni valide;
- employee non puo' cambiare direttamente lo stato;
- ogni transizione genera evento audit.

### P0: navigation

Gestisce menu, sezioni e visibilita' per ruolo.

Schema:

```json
{
  "label": "Richieste",
  "view": "leave_requests_table",
  "roles": ["admin", "approver", "employee"]
}
```

Regole:

- una view non presente in navigation resta raggiungibile solo se esplicitamente esposta dal runtime;
- le voci menu sono filtrate per ruolo;
- il primo item visibile diventa home dell'app.

### P1: dashboard

Gestisce metriche, KPI e riepiloghi.

Schema:

```json
{
  "name": "overview",
  "widgets": [
    {
      "type": "count",
      "entity": "leave_request",
      "label": "Richieste pending",
      "filter": { "status": "pending" },
      "roles": ["admin", "approver"]
    }
  ]
}
```

### P1: calendar

Gestisce eventi, intervalli data e visualizzazioni calendario.

Schema:

```json
{
  "name": "leave_calendar",
  "entity": "leave_request",
  "start_field": "start_date",
  "end_field": "end_date",
  "title_field": "employee",
  "roles": ["admin", "approver"]
}
```

### P1: directory

Gestisce persone, team, contatti e mapping verso contatti Homun.

Responsabilita':

- entity persona/dipendente;
- lookup utente app -> dipendente;
- lookup dipendente -> contatto Homun, se autorizzato;
- viste team/directory.

### P1: notifications

Gestisce eventi e notifiche tramite canali Homun consentiti.

Schema:

```json
{
  "on": "leave_request.created",
  "to": "role:approver",
  "channel": "email",
  "template": "Nuova richiesta ferie da approvare"
}
```

Regole:

- usa solo canali ammessi in `homun_access`;
- se il canale non e' autorizzato, la notifica non parte;
- fallimenti notifiche vanno in audit.

### P1: agent_bridge

Espone comandi chat e capability MCP-like tra Homun e app.

Responsabilita':

- query record via agente;
- creazione record via agente;
- azioni workflow via agente;
- accesso controllato a skill/MCP/canali/knowledge.

## Permission Model

I permessi devono essere dichiarativi e valutati da server e runtime.

Esempio:

```json
{
  "role": "employee",
  "allow": [
    "leave_request:create",
    "leave_request:read:own"
  ],
  "deny": [
    "leave_request:update:status",
    "leave_request:transition:*"
  ]
}
```

Regole:

- `admin` ha sempre `*` dentro l'app;
- `deny` vince su `allow`, tranne per admin;
- `own` usa `created_by_app_user_id` o un ownership field dichiarato;
- il client mostra solo cio' che il server autorizzerebbe;
- il server resta autoritativo.

## Runtime UI

Il runtime esterno deve comporre layout da moduli:

- hero app;
- menu laterale o tab bar;
- dashboard;
- table/list view;
- form view;
- detail view;
- workflow action bar;
- calendar view;
- user/admin area.

Le viste non devono renderizzare automaticamente tutto. Devono filtrare:

- campi nascosti;
- campi system;
- campi read-only;
- azioni non autorizzate;
- record non visibili al ruolo corrente.

## Data Flow

### Creazione App

```text
prompt utente
  -> app-factory skill
  -> selezione moduli
  -> blueprint v1
  -> validazione schema
  -> creazione app registry
  -> creazione database isolato
  -> provisioning runtime
  -> link app esterna
```

### Employee Crea Richiesta Ferie

```text
employee login
  -> form nuova richiesta
  -> client non mostra status
  -> API create record
  -> server applica status=pending
  -> record salvato con created_by_app_user_id
  -> evento record.created
  -> eventuale notifica approver
```

### Approver Approva

```text
approver login
  -> vede pending autorizzate
  -> azione approve
  -> server valida ruolo + transizione
  -> status=approved
  -> evento workflow.approve
  -> eventuale notifica employee
```

## App Demo P0

### Ferie e Permessi

Moduli:

- identity;
- data;
- workflow;
- navigation;
- dashboard;
- calendar;
- notifications.

Comportamento atteso:

- employee crea richieste e vede solo le proprie;
- employee non modifica stato;
- approver approva/rifiuta;
- admin gestisce tutto;
- calendario mostra richieste approvate o pending secondo ruolo;
- dashboard mostra pending/approvate/rifiutate;
- notifiche sono dichiarate ma partono solo se i canali sono autorizzati.

### Ticket Interni

Moduli:

- identity;
- data;
- workflow;
- navigation;
- dashboard;
- notifications.

Comportamento atteso:

- employee apre ticket;
- support vede ticket aperti;
- support cambia stato;
- admin vede statistiche e tutti i ticket.

## Skill App Factory

La skill deve cambiare prompt operativo.

Prima:

- crea entities, views, workflows.

Dopo:

- identifica dominio applicativo;
- sceglie moduli necessari;
- produce blueprint usando solo moduli supportati;
- marca campi system/workflow;
- assegna ruoli e permessi;
- genera navigation coerente;
- propone dashboard/calendario se utili;
- non inventa capability non supportate.

## Criteri Di Accettazione

1. Il blueprint ferie/permessi v1 non permette a employee di impostare `status`.
2. Il runtime non mostra campi `system` nei form standard.
3. Le azioni workflow sono visibili solo a ruoli autorizzati.
4. Il server rifiuta transizioni non autorizzate.
5. Admin puo' vedere e gestire tutto.
6. Una app ticket interni puo' essere creata con gli stessi moduli senza codice custom.
7. La skill App Factory produce blueprint che dichiarano `modules`.
8. La documentazione demo spiega quali moduli sono stati scelti e perche'.

## Piano Incrementale

### Step 1: Schema e validazione

- estendere blueprint con `modules`, `permissions`, `navigation`, `dashboards`, `calendars`;
- aggiungere attributi campo `system`, `managed_by`, `editable_by`;
- validare moduli e dipendenze.

### Step 2: Enforcement minimo

- applicare `initial_state` server-side;
- rifiutare campi system in create/update non autorizzati;
- derivare `can_create`, `can_read`, `can_transition` dai permessi blueprint.

### Step 3: Runtime module-aware

- form senza campi system;
- action bar filtrata per ruolo;
- navigation filtrata;
- dashboard base;
- calendar base.

### Step 4: Skill e tool chat

- aggiornare skill App Factory;
- creare operazioni guidate per aggiungere modulo, campo, vista, ruolo, permesso, workflow;
- evitare update blueprint JSON libero quando possibile.

### Step 5: Demo pack

- blueprint ferie/permessi v1;
- blueprint ticket interni v1;
- runbook demo "crea app al volo";
- smoke test con employee, approver e admin.

## Rischi

- Troppi moduli subito possono rallentare la demo. Mitigazione: P0 limitato a identity, data, workflow, navigation.
- Il modello puo' produrre blueprint incoerenti. Mitigazione: validatore severo e messaggi di errore correggibili via chat.
- La UI generica puo' tornare a sembrare un form builder. Mitigazione: runtime con layout per moduli, dashboard e workflow visibili.
- Permessi duplicati tra client e server. Mitigazione: server autoritativo, client solo presentation.

## Decisione

Procedere con Blueprint v1 modulare, implementando prima i moduli P0 e usando ferie/permessi come test verticale. La demo deve mostrare che Homun compone applicazioni affidabili da mattoni propri, non che genera codice libero.
