# Identity & Gateway Architecture — SPEC

> **Codename**: IGA (Identity, Gateway, Access)
> **Status**: SPEC — da implementare
> **Effort stimato**: 3-4 settimane (7-8 sprint da 2 giorni)
> **Dipendenze**: Profiles (già implementato), Contacts (già implementato), Channels (da migrare)

## Visione

Trasformare Homun da "un bot per canale con profili globali" a "un sistema multi-gateway dove ogni connessione ha la sua identità, e ogni contatto ha un perimetro di accesso esplicito che impedisce data leakage tra contesti".

### Problema attuale

1. **I canali sono singleton nel config TOML** — non puoi avere 2 bot Telegram (personale + aziendale)
2. **Account, Profile e Channel sono scollegati nella UI** — 3 pagine diverse, nessun filo conduttore
3. **Il contatto ha un solo profile_id** — un amico/collega non può avere profili diversi per gateway diversi
4. **Nessun perimetro di accesso per contatto** — l'agente può leakare informazioni tra contatti (memorie, contatti, appuntamenti)
5. **Nessuna condivisione granulare** — non puoi condividere una skill o un MCP con contatti specifici

### Modello target

```
ACCOUNT (l'umano)
  ├── GATEWAY (istanza di canale — N per tipo)
  │     ├── channel_type, name, config
  │     └── profile_id → PROFILE
  ├── PROFILE (personalità dell'agente)
  │     ├── brain files, memory, knowledge scoped
  │     └── visibility: { readable_from: [...] }
  └── CONTACT (persona esterna)
        ├── default_profile + gateway_overrides
        ├── PERIMETER (isolation by default)
        └── SHARED RESOURCES (eccezioni esplicite)
```

---

## Requisiti

### R1: Gateway — Istanze multiple per tipo di canale

Ogni utente può avere N gateway dello stesso tipo di canale. Ogni gateway è un'istanza
indipendente con la propria configurazione e il proprio profilo.

**Esempio:**
```
Account: Fabio
  ├── Gateway "Telegram Personale" (bot token A) → Profile: Fabio Personale
  ├── Gateway "Telegram Aziendale" (bot token B) → Profile: Fabio Lavoro
  ├── Gateway "WhatsApp" (+39...) → Profile: Fabio Personale
  └── Gateway "Email Lavoro" (IMAP aziendale) → Profile: Fabio Lavoro
```

**Migrazione**: i canali attuali da `config.toml` vengono migrati a righe nella tabella `gateways`.
Il config TOML mantiene solo i parametri globali (es. `[profiles] default`), non più i canali.

### R2: Contact Gateway Overrides — Profilo per contatto per gateway

Un contatto può avere un profilo diverso a seconda del gateway da cui scrive.
Questo risolve il caso "amico + collega" (Marco su WhatsApp = informale, Marco su Telegram Az. = formale).

**Priority chain per risolvere il profilo:**
```
1. Contact.gateway_override[gateway_id].profile_id   ← override esplicito per gateway
2. Contact.default_profile_id                          ← fallback del contatto
3. Gateway.profile_id                                  ← profilo del gateway
4. Account.default_profile                             ← profilo default dell'utente
5. Profile "default"                                   ← sempre esistente
```

### R3: Contact Perimeter — Isolation by Default

Ogni contatto ha un perimetro che limita **architetturalmente** (non via prompt) ciò che
l'agente può accedere quando risponde a quel contatto.

**Principio fondamentale:**
> Quando l'agente risponde a un contatto, deve comportarsi come se quel contatto fosse
> l'unica persona al mondo con cui parla. Non "non dire cose private" — proprio non avere
> accesso a quelle informazioni nel contesto.

**Differenza critica:**
- ❌ Soft limit (prompt): "Non dire a X informazioni su Y" → l'LLM potrebbe leakare
- ✅ Hard limit (architettura): il contesto NON contiene dati di Y → impossibile leakare

**Campi del perimetro:**

| Campo | Default | Descrizione |
|---|---|---|
| `knowledge_namespaces` | `["_public"]` | Namespace RAG accessibili |
| `memory_scope` | `contact_only` | Scope delle memorie visibili |
| `tools_allowed` | `[]` (= tutti) | Whitelist tool (vuoto = tutti non-denied) |
| `tools_denied` | `["vault"]` | Blacklist tool (priorità su allowed) |
| `can_see_contacts` | `false` | Può vedere la lista contatti? |
| `can_see_calendar` | `false` | Può vedere appuntamenti? |

**Memory scope valori:**

| Valore | Significato |
|---|---|
| `contact_only` | Solo conversazioni passate con questo contatto. **Default.** |
| `namespace` | Conversazioni + memorie consolidate nei namespace permessi |
| `profile` | Tutto il profilo (solo per contatti molto fidati) |

**Esempio — caso privacy:**
```
Contatto: Compagna
  perimeter:
    knowledge_namespaces: ["famiglia", "_public"]
    memory_scope: contact_only
    can_see_contacts: false

Compagna chiede: "Ti scambi messaggi con qualcuno?"
  → Contesto agente: solo memorie delle conversazioni con Compagna
  → Nessuna menzione di altri contatti nel contesto
  → Agente: "Non ho informazioni su questo argomento."
  → (Non mente — non ha accesso a quei dati)
```

**Esempio — caso aziendale:**
```
Contatto: ACME
  perimeter:
    knowledge_namespaces: ["acme", "_public"]
    memory_scope: contact_only
    tools_denied: ["vault", "file_read"]

ACME chiede: "Cosa fate per Warner?"
  → RAG filtrato: solo namespace "acme" e "_public"
  → Documenti Warner non accessibili
  → Agente: "Non posso condividere informazioni su altri clienti."
```

### R4: Knowledge Namespaces — Sicurezza senza tag liberi

Ogni documento RAG e memoria ha un **namespace** che ne determina la visibilità.
I namespace sostituiscono i tag come meccanismo di sicurezza.

**Distinzione fondamentale:**
- **Tag** = organizzazione/ricerca (liberi, nessun impatto sicurezza)
- **Namespace** = controllo accesso (determina chi vede cosa)

**Namespace riservati:**

| Namespace | Chi lo vede |
|---|---|
| `_public` | Tutti i contatti |
| `_private` | Solo l'owner (nessun contatto) |
| `_profile:{slug}` | Tutti quelli col profilo X |
| `{custom}` | Solo contatti con quel namespace nel perimetro |

**Regola d'oro: deny by default.** Un documento senza namespace esplicito è `_private`.
Devi esplicitamente aprirlo — mai il contrario.

**Struttura RAG con namespace:**
```
/acme/contratto-2026.pdf         → namespace: acme
/acme/meeting-notes.md           → namespace: acme
/warner/progetto-x.pdf           → namespace: warner
/famiglia/lista-vacanze.md       → namespace: famiglia
/generale/listino-prezzi.pdf     → namespace: _public
/interno/strategie.pdf           → namespace: _private (default)
```

### R5: Shared Resources — Condivisione esplicita di risorse

Risorse specifiche (skill, MCP server, tool, namespace) possono essere condivise
con contatti specifici con permessi granulari. Questo è l'unico modo per un contatto
di accedere a risorse fuori dal suo perimetro base.

**Tipi di risorse condivisibili:**

| Tipo | Esempio |
|---|---|
| `skill` | Lista della Spesa, Promemoria Famiglia |
| `mcp` | Google Calendar Famiglia, Database CRM |
| `tool` | web_search (se negato dal perimetro ma concesso specificamente) |
| `knowledge_namespace` | Un namespace specifico aggiunto oltre al perimetro |

**Permessi:**

| Permesso | Significato |
|---|---|
| `read` | Può consultare/invocare in sola lettura |
| `write` | Può consultare e modificare |
| `admin` | Può tutto + condividere con altri (futuro) |

**Esempio — Lista della Spesa:**
```
Resource: "Lista della Spesa" (skill)
  owner_profile: Fabio Personale
  shared_with:
    ├── Compagna:    read, write   ← aggiunge e toglie
    ├── Claudio:     read          ← solo consulta
    ├── Gaia:        read          ← solo consulta

Compagna scrive: "Aggiungi latte alla lista"
  → Perimetro base: contact_only (nessun accesso skill)
  → Shared resource override: skill "Lista della Spesa" con write ✓
  → Agente esegue la skill → aggiunge "latte"

ACME scrive: "Cosa c'è nella lista della spesa?"
  → Perimetro base: nessun accesso alla skill
  → Nessuna shared resource per ACME
  → Agente: "Non so di cosa parli"
```

### R5b: MCP/Skill Resource Scoping — Accesso granulare alle sotto-risorse

Quando si condivide un MCP (es. Notion) con un contatto, non basta dire "hai accesso a Notion" —
serve specificare **quali risorse dentro Notion** sono accessibili.

**Il problema:** L'MCP Notion dà accesso a tutto il workspace. Condividerlo con Felicia
significherebbe darle accesso ai documenti di lavoro, ai clienti, a tutto.

**La soluzione:** Ogni `shared_resource_access` ha un `scope_json` che specifica le sotto-risorse
accessibili e le operazioni permesse.

**Flusso UI — Sharing con scope:**

```
Step 1: Browse risorse dell'MCP
┌─────────────────────────────────────────────┐
│ 📋 Notion — Browse resources                │
│                                             │
│ ☐ 📁 Workspace Fabio                        │
│   ☐ 📄 Strategia 2026          (page)      │
│   ☐ 📊 Clienti                 (database)  │
│   ☑ 📊 Spesa Famiglia          (database)  │
│   ☐ 📄 Meeting Notes           (page)      │
│   ☐ 📁 Progetti Warner         (folder)    │
└─────────────────────────────────────────────┘

Step 2: Scegli chi e con quali permessi
┌─────────────────────────────────────────────┐
│ Sharing "Spesa Famiglia" from Notion        │
│                                             │
│ 👤 Felicia     [Read] [Write]        [×]   │
│ 👤 Claudio     [Read]               [×]   │
│ 👤 Gaia        [Read]               [×]   │
│                                             │
│ [+ Add contact]                             │
└─────────────────────────────────────────────┘

Step 3: Operazioni permesse (avanzato, collapsato)
┌─────────────────────────────────────────────┐
│ ▶ Allowed operations                        │
│   ☑ Read items                              │
│   ☑ Add items                               │
│   ☐ Delete items                            │
│   ☐ Search other pages                      │
└─────────────────────────────────────────────┘
```

**scope_json salvato:**
```json
{
  "resources": [
    {
      "type": "database",
      "id": "def456-spesa-famiglia",
      "name": "Spesa Famiglia",
      "allowed_operations": ["read", "add_item"]
    }
  ]
}
```

**Runtime enforcement:**
```
Felicia: "Aggiungi latte alla lista della spesa"
  1. Agente vuole chiamare MCP Notion → "add_item" su "Spesa Famiglia"
  2. Homun controlla scope_json per Felicia:
     - database "def456" → ✓ è nello scope
     - operation "add_item" → ✓ è permessa
  3. Passa la chiamata all'MCP → aggiunge "latte"

Felicia: "Fammi vedere i progetti Warner"
  1. Agente vuole chiamare MCP Notion → "read_page" su "Progetti Warner"
  2. Homun controlla scope_json per Felicia:
     - "Progetti Warner" → ✗ non è nello scope
  3. Blocca la chiamata → "Non ho accesso a questa risorsa"
```

**MCP Resource Browser:** Serve un componente generico che, dato un MCP server, ne esplora
le risorse e le presenta nella UI come albero selezionabile. Il protocollo MCP prevede
`resources/list` per enumerare le risorse. Per MCP che non lo supportano, Homun usa i tool
stessi per esplorare (es. `search` di Notion per ottenere pagine/database).

**Note su MCP multipli:** Avere più istanze dello stesso tipo di MCP (es. 2 account Notion)
è supportato dal sistema Gateway — ogni gateway può avere i suoi MCP server associati.
Questo è per gestire **più account** sullo stesso servizio, non per lo scoping (che si fa
via `scope_json`).

### R6: Profile Visibility — Relazioni tra profili

Già implementato nel backend (`visibility.readable_from`), va esposto nella UI.

**Semantica:**
- Unidirezionale: "Fabio Personale legge da Fabio Lavoro" ≠ "Fabio Lavoro legge da Fabio Personale"
- Si applica a memory search e RAG query
- L'owner ha sempre accesso completo a tutti i profili

**Esempio:**
```
Profile: Fabio Personale
  readable_from: ["fabio-lavoro"]    ← vede anche memorie aziendali

Profile: Fabio Lavoro
  readable_from: []                  ← NON vede memorie personali
```

### R7: Account come Hub — UI unificata

La pagina Account diventa il punto centrale che collega Gateway, Profili e Sharing.

**Layout:**
```
Account: Fabio
│
├── YOUR GATEWAYS
│   ┌─────────────────────────────────────────────┐
│   │ ✈ Telegram Personale      [Active]          │
│   │   Profile: Fabio Personale                  │
│   │   Bot: ****oKQA                             │
│   │                           [Edit] [Disable]  │
│   ├─────────────────────────────────────────────┤
│   │ ✈ Telegram Aziendale      [Active]          │
│   │   Profile: Fabio Lavoro                     │
│   │   Bot: ****xYZQ                             │
│   │                           [Edit] [Disable]  │
│   ├─────────────────────────────────────────────┤
│   │ + Add Gateway                               │
│   └─────────────────────────────────────────────┘
│
├── YOUR PROFILES
│   Fabio Personale — used by: Telegram Pers., WhatsApp
│   Fabio Lavoro    — used by: Telegram Az., Email
│   [Manage Profiles →]
│
├── SHARED RESOURCES
│   🛒 Lista della Spesa — shared with: Compagna, Claudio, Gaia
│   📅 Calendar Famiglia  — shared with: Compagna
│   [Manage Sharing →]
│
├── API Keys
└── Security (Trusted Devices, 2FA)
```

### R8: Context Isolation — Enforcement nel backend

Quando l'agente prepara il contesto per rispondere a un contatto, applica l'isolamento
in modo architetturale (non via prompt):

```
fn build_context_for_contact(contact, gateway, profile):

  1. MEMORY:
     match contact.perimeter.memory_scope:
       "contact_only" → load ONLY memories WHERE contact_id = this_contact
       "namespace"    → load memories WHERE namespace IN contact.perimeter.namespaces
       "profile"      → load all memories for this profile (+ readable_from)

  2. KNOWLEDGE (RAG):
     allowed_namespaces = contact.perimeter.knowledge_namespaces
                        + shared_resources.knowledge_namespaces(contact)
     query RAG WHERE namespace IN allowed_namespaces

  3. TOOLS:
     base_tools = all_tools
     REMOVE tools IN contact.perimeter.tools_denied
     IF contact.perimeter.tools_allowed NOT EMPTY:
       INTERSECT with tools_allowed
     ADD tools from shared_resources(contact) with permission >= read

  4. SKILLS:
     available_skills = shared_resources.skills(contact) with permission >= read
     (contatti non vedono skill di default — solo quelle condivise)

  5. MCP SERVERS:
     available_mcp = shared_resources.mcp(contact) with permission >= read

  6. SYSTEM PROMPT:
     DO NOT inject: contact list, other contacts' names, calendar events
                    (unless can_see_contacts / can_see_calendar = true)
     DO inject: contact's own card, profile personality, allowed context only
```

**Owner bypass:** quando il messaggio arriva dall'owner (identificato via Account),
nessun perimetro si applica — accesso completo.

---

## Schema Database

### Nuove tabelle

```sql
-- ═══════════════════════════════════════════════════════════════
-- Gateway: istanza di canale per utente
-- Sostituisce [channels.*] in config.toml + channel_identities
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE gateways (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    channel_type TEXT NOT NULL,                          -- telegram, whatsapp, discord, slack, email, web
    name TEXT NOT NULL,                                  -- "Telegram Personale", "Telegram Aziendale"
    profile_id INTEGER REFERENCES profiles(id),
    config_json TEXT NOT NULL DEFAULT '{}',              -- token, allowed_users, IMAP settings...
    response_mode TEXT NOT NULL DEFAULT 'automatic',     -- automatic, assisted, on_demand, silent
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════
-- Contact gateway override: profilo diverso per gateway
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE contact_gateway_overrides (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    gateway_id INTEGER NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    UNIQUE(contact_id, gateway_id)
);

-- ═══════════════════════════════════════════════════════════════
-- Contact perimeter: isolation by default
-- Un contatto senza riga qui usa i default (contact_only, _public, no vault)
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE contact_perimeters (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
    knowledge_namespaces TEXT NOT NULL DEFAULT '["_public"]',    -- JSON array
    memory_scope TEXT NOT NULL DEFAULT 'contact_only',           -- contact_only | namespace | profile
    tools_allowed TEXT NOT NULL DEFAULT '[]',                    -- JSON array (empty = all non-denied)
    tools_denied TEXT NOT NULL DEFAULT '["vault"]',              -- JSON array (priority over allowed)
    can_see_contacts INTEGER NOT NULL DEFAULT 0,
    can_see_calendar INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════
-- Shared resources: risorse condivise con contatti specifici
-- ═══════════════════════════════════════════════════════════════
CREATE TABLE shared_resources (
    id INTEGER PRIMARY KEY,
    resource_type TEXT NOT NULL,                                 -- skill, mcp, tool, knowledge_namespace
    resource_id TEXT NOT NULL,                                   -- nome skill, nome mcp server, nome tool, namespace
    owner_profile_id INTEGER NOT NULL REFERENCES profiles(id),
    description TEXT NOT NULL DEFAULT '',                        -- descrizione leggibile
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(resource_type, resource_id, owner_profile_id)
);

CREATE TABLE shared_resource_access (
    id INTEGER PRIMARY KEY,
    shared_resource_id INTEGER NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'read',                     -- read, write, admin
    scope_json TEXT NOT NULL DEFAULT '{}',                       -- scope granulare per sotto-risorse MCP/skill
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(shared_resource_id, contact_id)
);
```

### Modifiche a tabelle esistenti

```sql
-- RAG documents: aggiungere namespace
ALTER TABLE rag_documents ADD COLUMN namespace TEXT NOT NULL DEFAULT '_private';

-- Memory chunks: aggiungere namespace + contact_id
ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT '_private';
ALTER TABLE memories ADD COLUMN contact_id INTEGER REFERENCES contacts(id);

-- Channel identities: deprecata (migrata in gateways)
-- La tabella channel_identities in account resta per retrocompatibilità
-- ma i nuovi binding passano per gateways
```

---

## Implementazione — Piano a fasi

### Fase 1: Gateway in DB (settimana 1)

**Obiettivo**: spostare i canali da config TOML a tabella `gateways`.

1. **Migration** `039_gateways.sql`: crea tabella `gateways`
2. **`src/gateways/mod.rs`**: nuovo modulo con struct `Gateway`, CRUD
3. **`src/gateways/db.rs`**: operazioni DB (load, create, update, delete, list_by_user)
4. **`src/gateways/migration.rs`**: logica per migrare config TOML → righe DB al primo avvio
5. **`src/agent/gateway.rs`**: adattare per leggere da DB invece che da config
6. **API**: `/api/v1/gateways` — CRUD endpoints
7. **Account UI**: sezione "Your Gateways" con lista, add, edit, enable/disable
8. **Settings → Channels**: diventa overview infrastrutturale (o redirect ad Account)

**Profile resolver**: aggiornare per usare `gateway.profile_id` invece di `channel.default_profile`.

### Fase 2: Contact Gateway Overrides (settimana 1-2)

**Obiettivo**: un contatto può avere un profilo diverso per gateway.

1. **Migration** `040_contact_gateway_overrides.sql`
2. **DB ops**: CRUD per `contact_gateway_overrides`
3. **Profile resolver**: aggiungere step 1 nella priority chain
4. **Contact UI**: nella scheda contatto, sezione "Profile per Gateway" con override editabili
5. **Test**: verifica che Marco su WhatsApp = personale, Marco su Telegram Az. = lavoro

### Fase 3: Contact Perimeter (settimana 2-3)

**Obiettivo**: isolation by default per ogni contatto.

1. **Migration** `041_contact_perimeters.sql`
2. **`src/contacts/perimeter.rs`**: struct `ContactPerimeter`, resolve logic
3. **Context isolation in agent loop**: `build_context_for_contact()` che filtra:
   - Memory per `memory_scope`
   - RAG per `knowledge_namespaces`
   - Tools per `tools_allowed` / `tools_denied`
   - System prompt per `can_see_contacts` / `can_see_calendar`
4. **Contact UI**: sezione "Access Perimeter" con:
   - Namespace selector
   - Memory scope dropdown
   - Tool allow/deny list
   - Toggle contatti e calendario
5. **Test critici**:
   - Contatto A non vede memorie di Contatto B
   - Contatto A non vede documenti RAG fuori namespace
   - Contatto A non può usare tool negati
   - Owner bypassa tutti i perimetri

### Fase 4: Knowledge Namespaces (settimana 2-3, parallelo a Fase 3)

**Obiettivo**: ogni documento RAG ha un namespace per il controllo accesso.

1. **Migration**: aggiungere colonna `namespace` a `rag_documents` e `memories`
2. **RAG ingestion**: namespace assegnato alla cartella o esplicito
3. **RAG search**: filtro `WHERE namespace IN (?)` basato sul perimetro
4. **Memory search**: filtro analogo per `memory_scope`
5. **Knowledge UI**: mostrare/editare namespace per documento
6. **Memory UI**: mostrare namespace per chunk (se non `_private`)

### Fase 5: Shared Resources (settimana 3-4)

**Obiettivo**: condivisione esplicita di skill, MCP, tool con contatti specifici.

1. **Migration** `042_shared_resources.sql`
2. **`src/sharing/mod.rs`**: struct `SharedResource`, `SharedResourceAccess`
3. **`src/sharing/db.rs`**: CRUD + query "risorse accessibili per contatto"
4. **Context builder**: integrare shared resources come override al perimetro
5. **Account UI**: sezione "Shared Resources" con gestione condivisione
6. **Profile UI**: sezione "Shared from this profile" nel dettaglio profilo
7. **Contact UI**: sezione "Shared resources" nella scheda contatto
8. **Test**: skill condivisa accessibile a contatti autorizzati, inaccessibile ad altri

### Fase 6: Profile Visibility UI (settimana 4)

**Obiettivo**: esporre `readable_from` nella UI (backend già implementato).

1. **Profile detail UI**: sezione "Visibility" con checkbox per altri profili
2. **Profile detail UI**: sezione "Used by" con lista gateway e contatti
3. **Cross-links**: da Gateway → Profile, da Profile → Gateway, da Account → Profile

---

## I 3 Livelli di Accesso — Riepilogo

```
┌─────────────────────────────────────────────────────────────┐
│ LIVELLO 1: PERIMETRO (deny by default)                      │
│   Cosa un contatto NON può mai vedere.                      │
│   Si applica sempre, non bypassabile.                       │
│   memory_scope, tools_denied, can_see_contacts/calendar     │
├─────────────────────────────────────────────────────────────┤
│ LIVELLO 2: NAMESPACE (accesso passivo ai dati)              │
│   Quali bucket di dati il contatto può "pescare".           │
│   knowledge_namespaces nel perimetro.                       │
│   _public, _private, _profile:{slug}, custom.               │
│   Default = _private (deny by default).                     │
├─────────────────────────────────────────────────────────────┤
│ LIVELLO 3: SHARED RESOURCES (accesso attivo a risorse)      │
│   Risorse specifiche condivise esplicitamente.              │
│   Skill, MCP server, tool, namespace.                       │
│   Con permessi granulari (read/write/admin).                │
│   Unico modo per bypassare il perimetro base.              │
└─────────────────────────────────────────────────────────────┘
```

**Flusso di risoluzione accesso:**
```
Perimetro base (Livello 1)
  → filtra memory, tools, system prompt
  → aggiunge namespace (Livello 2)
  → aggiunge shared resources (Livello 3) come override espliciti
  → risultato = contesto isolato per questo contatto
```

---

## Failure Modes e Sicurezza

### Rischi mitigati

| Rischio | Mitigazione |
|---|---|
| L'agente leaka memorie di altri contatti | Hard limit: `memory_scope: contact_only` non carica quelle memorie |
| Documento taggato sbagliato diventa visibile | Namespace ≠ tag. Namespace è deny-by-default, non opt-out |
| Contatto chiede info su altri clienti | RAG filtrato per namespace — documenti non in scope non esistono nel contesto |
| Prompt injection via contatto per estrarre dati | Dati non nel contesto = impossibile estrarli via prompt injection |
| Skill condivisa usata per escalation | Permessi read/write/admin granulari per contatto per risorsa |

### Edge cases

| Caso | Comportamento |
|---|---|
| Contatto senza riga in `contact_perimeters` | Usa default: `contact_only`, `_public`, `vault` denied |
| Contatto senza `default_profile_id` | Usa `gateway.profile_id` (passo 3 della priority chain) |
| Gateway senza `profile_id` | Usa account default o profilo "default" |
| Owner scrive da gateway | Nessun perimetro applicato — accesso completo |
| Nuovo documento RAG senza namespace | Default `_private` — nessun contatto lo vede |
| Shared resource cancellata | CASCADE: accessi rimossi, contatto perde accesso immediatamente |

---

## Tests e Verifiche

### Unit tests obbligatori

- [ ] Priority chain profilo: 5 livelli con fallback corretto
- [ ] Perimetro default: contatto nuovo → contact_only, _public, no vault
- [ ] Memory scope contact_only: non carica memorie di altri contatti
- [ ] Memory scope namespace: carica solo memorie nei namespace permessi
- [ ] Namespace _private: mai visibile a contatti
- [ ] Namespace _public: sempre visibile a tutti i contatti
- [ ] tools_denied ha priorità su tools_allowed
- [ ] Shared resource read: skill invocabile in lettura
- [ ] Shared resource write: skill invocabile in scrittura
- [ ] Shared resource assente: skill invisibile al contatto
- [ ] Owner bypass: nessun perimetro applicato
- [ ] Gateway migration: config TOML → DB preserva tutti i dati
- [ ] Profile visibility readable_from: cross-profile memory access

### Integration tests

- [ ] ACME chiede di Warner → nessuna informazione (namespace isolation)
- [ ] Compagna chiede di altri contatti → nessuna informazione (contact isolation)
- [ ] Marco su WhatsApp = profilo personale, Marco su Telegram Az. = profilo lavoro
- [ ] Skill "Lista Spesa" accessibile a Compagna, inaccessibile a ACME
- [ ] Nuovo gateway creato → canale funzionante con profilo assegnato
- [ ] Gateway disabilitato → canale non risponde

---

## Change Checklist

Quando si modifica questo sottosistema, aggiornare anche:

- [ ] `src/agent/profile_resolver.rs` — priority chain
- [ ] `src/agent/context.rs` — system prompt assembly
- [ ] `src/agent/agent_loop.rs` — context building per contatto
- [ ] `src/agent/memory_search.rs` — filtri namespace/contact
- [ ] `src/rag/engine.rs` — filtri namespace
- [ ] `src/tools/registry.rs` — filtri tools per perimetro
- [ ] `src/web/api/` — endpoints nuovi (gateways, perimeters, sharing)
- [ ] `src/web/pages.rs` — pagine Account, Contact, Profile aggiornate
- [ ] `static/js/account.js` — UI gateways + sharing
- [ ] `static/js/profiles.js` — UI visibility + used-by
- [ ] `static/js/contacts.js` — UI perimeter + gateway overrides
- [ ] `docs/UNIFIED-ROADMAP.md` — task tracking
- [ ] `CLAUDE.md` — aggiornare Architecture Overview se necessario
