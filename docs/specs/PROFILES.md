# SPEC: Profile System (Profilo-First Architecture)

> Status: **IN PRODUCTION** — profile_id + user_id implementati; scoping write-path da completare
> Data originale: 2026-03-22
> Revisione: 5 — user_id implementato su DB + struct + agent loop (2026-03-22)

## Panoramica

Homun supporta **N profili per singolo utente** (v2). Ogni profilo è un'identità separata con memoria, knowledge, vault, contatti, sessioni, automazioni e workflow scoped.

### Modello architetturale

```
v1 (legacy):     1 utente, 1 identità (SOUL.md + persona enum)
v2 (attuale):    1 utente, N profili — profile_id implementato, user_id da aggiungere
v2.5 (prossimo): 1 utente admin di default, user_id + profile_id su tutte le tabelle scoped
v3 (futuro):     N utenti, N profili, RBAC — solo logica multi-utente + UI admin
```

---

## Audit completo del database

### Classificazione tabelle

Ogni tabella del DB è classificata in una delle seguenti categorie:

- **Parent scoped**: tabella con dati utente che ha (o deve avere) `user_id` + `profile_id` diretti
- **Child (eredita)**: tabella figlia con FK verso una parent scoped — eredita scoping via JOIN
- **System**: tabella infrastrutturale che non richiede scoping utente/profilo

### Tabella: users (migration 003 + 017)

```sql
CREATE TABLE users (
    id TEXT PRIMARY KEY,                    -- UUID v4
    username TEXT NOT NULL UNIQUE,
    roles TEXT NOT NULL DEFAULT '[]',       -- JSON array: ["admin","user","guest"]
    password_hash TEXT,                     -- aggiunto in 017
    created_at TEXT, updated_at TEXT, metadata TEXT
);
```

**Stato attuale**: esiste, funzionante, usata per web auth e webhook tokens. Ha `UserManager` in `src/user/mod.rs` con CRUD + ruoli (Admin/User/Guest). Nessun utente auto-seed — creazione solo via CLI (`homun user add --admin`).

**Da fare**: seed di un utente admin di default nella migration.

### Tabella: profiles (migration 034)

```sql
CREATE TABLE profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_emoji TEXT NOT NULL DEFAULT '👤',
    profile_json TEXT NOT NULL DEFAULT '{}',    -- AIEOS-inspired identity JSON
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT, updated_at TEXT
);
-- Seed: ('default', 'Default', 1)
```

**Stato attuale**: funzionante. `user_id` FK aggiunto in migration 037.

---

### Audit tabella per tabella

#### PARENT SCOPED — user_id + profile_id diretti

| Tabella | Migration | Ha profile_id | Ha user_id | Stato |
|---|---|---|---|---|
| `profiles` | 034+037 | N/A (è il profilo) | ✅ SÌ | ✅ Migration 037 |
| `memory_chunks` | 002+035+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `rag_chunks` | 011+035+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `rag_sources` | 011+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `contacts` | 020+035+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `sessions` | 001+035+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `automations` | 006+036+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `workflows` | 013+036+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `memory_summaries` | 029+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `businesses` | 015+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |
| `email_pending` | 005+037 | ✅ SÌ | ✅ SÌ | ✅ Migration 037 |

#### CHILD — Ereditano via JOIN, nessuna colonna diretta

| Tabella | FK padre | Eredita da |
|---|---|---|
| `messages` | `session_key → sessions(key)` | sessions.user_id + sessions.profile_id |
| `web_chat_runs` | `session_key → sessions(key)` | sessions.user_id + sessions.profile_id |
| `token_usage` | `session_key → sessions(key)` | sessions.user_id + sessions.profile_id |
| `automation_runs` | implicita → automations | automations.user_id + automations.profile_id |
| `workflow_steps` | `workflow_id → workflows(id)` | workflows.user_id + workflows.profile_id |
| `contact_identities` | `contact_id → contacts(id)` | contacts.user_id + contacts.profile_id |
| `contact_relationships` | `contact_id → contacts(id)` | contacts.user_id + contacts.profile_id |
| `contact_events` | `contact_id → contacts(id)` | contacts.user_id + contacts.profile_id |
| `pending_responses` | `contact_id → contacts(id)` | contacts.user_id + contacts.profile_id |
| `business_strategies` | `business_id → businesses(id)` | businesses.user_id + businesses.profile_id |
| `products` | `business_id → businesses(id)` | businesses.user_id + businesses.profile_id |
| `transactions` | `business_id → businesses(id)` | businesses.user_id + businesses.profile_id |
| `orders` | `business_id → businesses(id)` | businesses.user_id + businesses.profile_id |
| `market_insights` | `business_id → businesses(id)` | businesses.user_id + businesses.profile_id |
| `memory_fts` | content-sync → memory_chunks | virtuale, auto-sincronizzata |
| `rag_fts` | content-sync → rag_chunks | virtuale, auto-sincronizzata |

#### SYSTEM — Nessun scoping necessario

| Tabella | Migration | Motivazione |
|---|---|---|
| `users` | 003 | È l'utente stesso, non ha bisogno di FK a sé |
| `user_identities` | 003 | Mapping canale→utente, infrastruttura auth |
| `webhook_tokens` | 003 | Token API per utente, FK users.id già presente |
| `trusted_devices` | 030 | 2FA device fingerprint, FK users.id già presente |
| `vault_access_log` | 019 | Audit trail del vault, cross-profile per design |
| `skill_audit` | 016 | Log attivazione skill, cross-profile per design |
| `memories` (legacy) | 001 | Tabella legacy pre-memory_chunks, non più usata attivamente |

---

## Stato componenti Rust + JS

### Componenti implementati (✅ DONE)

| Componente | File | Note |
|---|---|---|
| Profile domain + registry | `src/profiles/mod.rs` (388 LOC) | Profile, ProfileJson, ProfileRegistry, resolve_visible_profile_ids |
| Profile CRUD DB | `src/profiles/db.rs` (365 LOC) | Insert/load/update/delete + persona migration |
| Profile resolver | `src/agent/profile_resolver.rs` (102 LOC) | Catena: Contact > Channel > Config > "default" |
| Agent loop integration | `src/agent/agent_loop.rs` (lines 600-700) | Risolve profilo, carica brain files, inietta context, visible_profile_ids |
| Bootstrap watcher | `src/agent/bootstrap_watcher.rs` | Watch `brain/profiles/{slug}/` + fallback `brain/` |
| Prompt ProfileSection | `src/agent/prompt/sections.rs` (lines 529-549) | Inietta linguistics/personality/capabilities |
| Remember tool | `src/tools/remember.rs` | Scrive `brain/profiles/{slug}/USER.md` |
| Memory consolidation | `src/agent/memory.rs` | INSTRUCTIONS.md, HISTORY.md, daily files — in `profiles/{slug}/` |
| Memory search | `src/agent/memory_search.rs` | `search_scoped_full(..., profile_ids)` con RRF |
| Memory DB | `src/agent/memory_db.rs` | insert/count con profile_id |
| RAG search | `src/rag/engine.rs` | Filtra per profile_id (NULL = globale) |
| Skills loader | `src/skills/loader.rs` | `scan_profile_skills()`, tag `profile_slug`, `list_profile_scopes()` |
| Cognition discovery | `src/agent/cognition/engine.rs` | `visible_profile_ids` + `active_profile_slug` |
| Vault tool | `src/tools/vault.rs` | Key-prefix: `vault.{name}` (default), `vault.p:{slug}.{name}` |
| Config | `src/config/schema.rs` | `ProfilesConfig { default }` + `ChannelBehavior::default_profile()` |
| Session DB | `src/storage/db.rs` | `get/set_session_profile_id()` |
| Gateway | `src/agent/gateway.rs` | `/profile` e `/profile <slug>` commands |
| API profiles | `src/web/api/profiles.rs` (340 LOC) | 10 endpoint: CRUD + soul R/W + instructions R + generate |
| API filters | `web/api/{memory,knowledge,automations,workflows}.rs` | `?profile={slug}` query param |
| JS profiles page | `static/js/profiles.js` (631 LOC) | Master-detail, CRUD, SOUL.md editor, LLM generation |
| JS chat profile pill | `static/js/chat.js` (lines 3815-3861) | Dropdown switch profilo |
| JS contact dropdown | `static/js/contacts.js` | `#ef-profile` select |
| JS filters (6 pagine) | memory, knowledge, vault, automations, workflows | `#*-profile-filter` select |
| Brain dir migration | `src/profiles/mod.rs` | Auto-migra `brain/` → `brain/profiles/default/` |
| Persona→Profile migration | `src/profiles/db.rs` | `migrate_contact_personas()` all'avvio |

### Componenti parziali (⚠️)

| Componente | Problema | Fix |
|---|---|---|
| Automations tool | `handle_create()` non passa `ctx.profile_id` → INSERT con NULL | Passare `ctx.profile_id` |
| Workflows tool | Stesso problema di automations | Passare `ctx.profile_id` |
| RAG ingest | `insert_rag_chunk(..., profile_id: None)` — commento "set via API Sprint 4" | Passare profile dalla API upload |
| persona.rs | Deprecated ma ancora presente come fallback | Rimuovere dopo verifica migrazione |

### Componenti mancanti (❌ TODO)

| Componente | Descrizione |
|---|---|
| ~~user_id su profiles~~ | ~~FK `profiles.user_id → users(id)`~~ ✅ DONE (migration 037) |
| ~~user_id su 11 tabelle parent scoped~~ | ✅ DONE (migration 037 + backfill Rust) |
| ~~profile_id su 4 tabelle~~ | ✅ DONE (migration 037) |
| ~~Seed admin user~~ | ✅ DONE (migration 037: `00000000-...-000000000001`) |
| ~~ToolContext.user_id~~ | ✅ DONE — campo aggiunto, agent loop lo setta |
| ~~Profile.user_id~~ | ✅ DONE — campo aggiunto a struct + DB queries |
| Logs profile_id | LogRecord non ha profile_id (file-based JSONL) |
| Cron profile_id | Job cron senza contesto profilo |
| JS logs filter | Nessun dropdown profilo in logs.js |

---

## Design decisions confermate

### 1. Riuso tabella users esistente

La tabella `users` di migration 003 (id TEXT/UUID, roles JSON, password_hash) è già funzionante per web auth. La riusiamo — `user_id` sarà TEXT su tutte le FK. Seediamo un admin di default.

### 2. user_id su ogni tabella parent scoped (non solo profiles)

Permette query dirette `WHERE user_id = ? AND profile_id = ?` senza JOIN. Più ridondante ma più veloce e semplice da ragionare.

### 3. Child tables ereditano via JOIN

Tabelle figlie (messages, token_usage, workflow_steps, contact_identities, ecc.) non hanno colonne dirette — ereditano dallo scope della tabella padre.

### 4. Vault resta con key-prefix

Il vault è backed da OS keychain + encrypted file, non da SQLite. Il pattern `vault.p:{slug}.{name}` funziona correttamente. Non serve aggiungere colonne DB.

### 5. ProfileJson schema (AIEOS-inspired) — confermato

5 sezioni: identity, linguistics, personality, capabilities, visibility. `visibility.readable_from` controlla accesso cross-profilo.

### 6. Brain directory structure — confermata

```
~/.homun/brain/profiles/{slug}/
├── SOUL.md, USER.md, INSTRUCTIONS.md
└── skills/

~/.homun/memory/profiles/{slug}/
├── YYYY-MM-DD.md
└── HISTORY.md
```

### 7. Catena risoluzione profilo — confermata

1. Contact.profile_id > 2. Channel.default_profile > 3. Config.profiles.default > 4. "default" (id=1)

### 8. No storage_config / DB esterni — rimandato

storage_config per Postgres/Qdrant/Pinecone/S3 non implementato. Rimandato a quando serve davvero.

---

## Migration 037 — ✅ IMPLEMENTATA

Migration `037_user_profile_scoping.sql` implementata e funzionante. Vedi file in `migrations/037_user_profile_scoping.sql`.

**Cosa fa:**
1. Seed admin user (`00000000-0000-0000-0000-000000000001`)
2. `user_id TEXT REFERENCES users(id)` su 7 tabelle che avevano solo profile_id
3. `user_id` + `profile_id` su 4 tabelle che non avevano nessuno dei due
4. Indici su tutte le nuove colonne

**Backfill Rust** (`storage/db.rs::backfill_user_ids`): popola tutti i record NULL con admin user_id e default profile_id (1).

**Costante**: `crate::user::DEFAULT_ADMIN_USER_ID` in `src/user/mod.rs`.

**Struct aggiornate:**
- `Profile.user_id: Option<String>` — in `src/profiles/mod.rs`
- `ToolContext.user_id: Option<String>` — in `src/tools/registry.rs`
- Agent loop setta `user_id = DEFAULT_ADMIN_USER_ID` nel ToolContext

---

## Lavoro completato (write-path scoping)

| # | Task | Stato | Commit |
|---|---|---|---|
| P1 | Automations: `ctx.profile_id` + `ctx.user_id` a insert | ✅ DONE | `90d1405` |
| P2 | Workflows: passare `ctx.profile_id` + `ctx.user_id` a insert | ✅ DONE | `7967f49` |
| P3 | RAG ingest: profile_id + user_id in source + chunk | ✅ DONE | `90d1405` |
| P8 | Memory summaries: profile_id + user_id alla creazione | ✅ DONE | `08675de` |
| P9 | RAG sources: taggato con profile_id + user_id | ✅ DONE (parte di P3) | `90d1405` |
| P10 | Businesses: profile_id + user_id nella struct + INSERT | ✅ DONE | `08675de` |
| P11 | Email pending: profile_id + user_id nella struct + INSERT | ✅ DONE | `08675de` |
| P12 | Logs: profile_id + user_id in LogRecord (skip_none) | ✅ DONE (struct) | `08675de` |
| P13 | Cron: usa tabella automations → coperto da P1 | ✅ N/A | — |

## Lavoro rimanente

### Priorità MEDIA — UI scoping

| # | Task | File | Effort |
|---|---|---|---|
| P14 | JS logs filter: aggiungere dropdown profilo | `static/js/logs.js` | S |
| P15 | Knowledge upload UI: selettore profilo nel form | `static/js/knowledge.js` | S |
| P12b | Logs: popolare profile_id/user_id via tracing span | `src/logs.rs` + agent loop | M |

### Priorità BASSA — Cleanup

| # | Task | File | Effort |
|---|---|---|---|
| P16 | Rimuovere persona.rs + campi legacy Contact | `src/agent/persona.rs` + migration | M |
| P17 | Cascade/cleanup su delete profile | `src/profiles/db.rs` | S |
| P18 | Session profile switch via REST API | `src/web/api/` | S |
| P19 | API endpoint USER.md per profilo | `src/web/api/profiles.rs` | S |

### Effort: S = <30 min, M = 30-60 min

---

## Rischi e mitigazioni

| Rischio | Stato | Mitigazione |
|---|---|---|
| Breaking change brain files | ✅ Risolto | Auto-migrazione su startup + fallback legacy |
| Performance query con filtro | ✅ Risolto | Indici su user_id e profile_id |
| user_id TEXT vs INTEGER mismatch | ⚠️ Design choice | Si riusa users.id TEXT (UUID) — consistente con migration 003. Performance OK con indice. |
| Backfill su DB grandi | ⚠️ Basso rischio | UPDATE batch idempotenti, tutti i record → admin user ID |
| Dati orfani su delete profilo | ⚠️ Aperto | P17: cleanup in delete_profile() |
| Automazioni/workflow create senza profilo | ⚠️ Aperto | P1-P2: fix urgente |
| RAG ingest senza profilo | ⚠️ Aperto | P3: fix upload API |
| persona.rs residuo | ⚠️ Aperto | P16: rimuovere dopo verifica |
| admin user con UUID fisso | ⚠️ Basso rischio | UUID deterministico `0...01` — solo per seed. In v3 utenti creati con UUID random. |

---

## File reference completa

| Componente | File | LOC |
|---|---|---|
| User manager | `src/user/mod.rs` | ~280 |
| User DB ops | `src/storage/db.rs` | UserRow, create/load/update/delete |
| Profile domain + registry | `src/profiles/mod.rs` | 388 |
| Profile CRUD DB | `src/profiles/db.rs` | 365 |
| Profile resolver | `src/agent/profile_resolver.rs` | 102 |
| Persona (deprecated) | `src/agent/persona.rs` | ~135 |
| Agent loop integration | `src/agent/agent_loop.rs` | lines 600-700 |
| Prompt ProfileSection | `src/agent/prompt/sections.rs` | lines 529-549 |
| Bootstrap watcher | `src/agent/bootstrap_watcher.rs` | profile dir support |
| Agent context | `src/agent/context.rs` | profile_context, reload_bootstrap |
| Memory consolidation | `src/agent/memory.rs` | profile-scoped file paths |
| Memory search | `src/agent/memory_search.rs` | profile_ids filter |
| Memory DB | `src/agent/memory_db.rs` | insert/count with profile_id |
| RAG engine | `src/rag/engine.rs` | search filter, ingest TODO |
| RAG DB | `src/rag/db.rs` | rag_sources + rag_chunks ops |
| Skills loader | `src/skills/loader.rs` | scan_profile_skills, profile_slug |
| Cognition | `src/agent/cognition/engine.rs` | visible_profile_ids |
| Vault tool | `src/tools/vault.rs` | key-prefix namespacing |
| Remember tool | `src/tools/remember.rs` | writes to profile brain dir |
| Automation tool | `src/tools/automation.rs` | handle_create missing profile_id |
| Workflow tool | `src/tools/workflow.rs` | handle_create missing profile_id |
| Config | `src/config/schema.rs` | ProfilesConfig + ChannelBehavior |
| Session DB | `src/storage/db.rs` | get/set_session_profile_id |
| Gateway | `src/agent/gateway.rs` | /profile command |
| Logs | `src/logs.rs` | LogRecord — no profile_id |
| API profiles | `src/web/api/profiles.rs` | 340 |
| API memory/knowledge/etc | `src/web/api/*.rs` | profile filter params |
| Pages | `src/web/pages.rs` | profiles page + filter dropdowns |
| JS profiles | `static/js/profiles.js` | 631 |
| JS chat profile | `static/js/chat.js` | profile pill |
| JS contacts | `static/js/contacts.js` | profile dropdown |
| JS domain filters | `static/js/{memory,knowledge,vault,automations,workflows}.js` | profile filter selects |
| JS logs | `static/js/logs.js` | NO profile filter (TODO) |
