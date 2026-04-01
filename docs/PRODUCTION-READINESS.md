# Homun — Production Readiness Checklist

> **Creato**: 2026-04-01
> **Contesto**: dopo l'implementazione completa del profile isolation (commits b992488, 0336b11, 920e037)
> **Obiettivo**: verificare coerenza e stabilità prima del deploy in produzione

---

## Fase 0 — Backfill Critico (one-shot, da fare PRIMA di tutto)

### BF-1: Namespace backfill su chunk esistenti

I chunk di memoria consolidati da conversazioni con contatti prima dell'implementazione del namespace hanno `namespace = '_private'` (default SQL). Con il nuovo filtro strutturale, quei contatti **non vedranno più le loro memorie passate**.

**Query di fix**:
```sql
UPDATE memory_chunks
SET namespace = '_public'
WHERE contact_id IS NOT NULL AND namespace = '_private';
```

**Verifica**: `SELECT COUNT(*) FROM memory_chunks WHERE contact_id IS NOT NULL AND namespace = '_private'` deve restituire 0.

- [ ] Eseguire backfill
- [ ] Verificare conteggio

---

## Fase 1 — Test Isolamento End-to-End

### ISO-1: Memory search — contatti non vedono chunk _private

**Scenario**: un contatto scrive su Telegram/WhatsApp/Email.
- [ ] Il memory search del contatto NON restituisce chunk con `namespace = '_private'`
- [ ] Il memory search del contatto restituisce chunk con `namespace = '_public'` e `contact_id` matching
- [ ] Il memory search del contatto restituisce chunk con `contact_id = NULL` e `namespace = '_public'` (se reclassificati dall'audit wizard)
- [ ] Il proprietario (CLI/Web) vede TUTTI i chunk indipendentemente dal namespace

### ISO-2: Cognition — allowed_namespaces propagato

- [ ] Quando un contatto scrive, la cognition usa `allowed_namespaces` dal contact perimeter
- [ ] Il perimeter default `["_public", "contact_{id}"]` funziona correttamente
- [ ] Un contatto senza perimeter custom riceve il default safe

### ISO-3: Cambio profilo nella Web UI

Cambiare profilo nella topbar e verificare che ogni sezione aggiorni i dati:
- [ ] Memory → chunk count e history cambiano
- [ ] Memory Audit → badge e lista cambiano
- [ ] Automations → lista filtrata per profilo
- [ ] Business → lista filtrata per profilo
- [ ] Contacts → lista filtrata per profilo
- [ ] Vault Audit → log filtrato per profilo
- [ ] Skills Audit → log filtrato per profilo
- [ ] Pending Responses → lista filtrata per profilo
- [ ] Knowledge → sources filtrate per profilo

### ISO-4: Scenario "Warner chiede di Acme"

Setup: due contatti (Acme e Warner) nello stesso profilo, ciascuno con conversazioni consolidate.
- [ ] Warner scrive "a cosa stai lavorando per Acme?"
- [ ] L'agente NON rivela informazioni dalle memorie di Acme
- [ ] L'agente NON menziona Acme come contatto (`can_see_contacts = 0`)
- [ ] I chunk consolidati di Acme (contact_id = acme_id) non appaiono nel search di Warner

### ISO-5: Delete profilo — cascade completa

- [ ] Creare un profilo test con: contatti, memorie, automazioni, skill audit, pending responses
- [ ] Eliminare il profilo
- [ ] Verificare che TUTTI i dati associati siano spariti da DB
- [ ] Verificare che la directory `~/.homun/brain/profiles/{slug}/` sia stata rimossa
- [ ] Verificare che la directory `~/.homun/memory/profiles/{slug}/` sia stata rimossa
- [ ] Verificare che il profilo default NON sia eliminabile

---

## Fase 2 — Flussi Non Ancora Verificati

### FLOW-1: Heartbeat e profilo

- [ ] Verificare quale `profile_id` usa il heartbeat quando scatta
- [ ] Il heartbeat accede alla memoria del profilo corretto o a quella globale?
- [ ] Se ci sono più profili, il heartbeat non mescola dati tra profili

### FLOW-2: Subagent (spawn) e profilo

- [ ] Verificare che un subagent spawned erediti il `profile_id` del parent
- [ ] Il subagent ha accesso solo alla memoria del profilo corretto?

### FLOW-3: MCP tool calls e contesto

- [ ] Quando un MCP tool viene invocato, il `ToolContext` contiene `profile_id` e `contact_id`?
- [ ] I tool MCP rispettano il contesto di isolamento?

### FLOW-4: Email channel response modes

- [ ] `assisted` mode: la risposta viene messa in pending con il profile_id corretto?
- [ ] `automatic` mode: la risposta usa il profilo corretto per memoria e contesto?

### FLOW-5: Browser site memory

- [ ] La site memory è per-contact ma non per-profile — è intenzionale?
- [ ] Un contatto che browsa non vede site memories di un altro contatto?

### FLOW-6: Context compaction

- [ ] Quando il contesto viene compattato (`context_compactor.rs`), il `profile_id` viene preservato?
- [ ] I chunk compattati mantengono il namespace corretto?

---

## Fase 3 — Test Shell Flaky

### SHELL-1: test_safe_ls e test_safe_echo

Due test preesistenti che falliscono in modo intermittente.

- [ ] Investigare la root cause (probabilmente sandbox/path issue)
- [ ] Fixare o marcare come `#[ignore]` con commento
- [ ] CI deve essere green al 100%

---

## Fase 4 — Preparazione Multi-User (v3, non bloccante per produzione)

Questi punti non bloccano il deploy ma vanno tracciati per il futuro:

### MU-1: DEFAULT_ADMIN_USER_ID hardcodato

`"00000000-0000-0000-0000-000000000001"` usato in ~15 punti:
- `src/agent/agent_loop.rs` (righe 684, 1063)
- `src/web/api/profiles.rs`
- `src/web/api/gateways.rs`
- `src/profiles/db.rs`
- `src/storage/db.rs` (backfill)

**Per v3**: sostituire con risoluzione dinamica dall'auth context.

### MU-2: user_id non usato nei filtri

Le colonne `user_id` esistono (migration 037) ma nessuna query filtra per esse. Il filtro è solo su `profile_id`.

**Per v3**: aggiungere `user_id` ai filtri quando ci saranno più operatori.

### MU-3: Web auth single-user

Una sola password, nessuna user management UI, session store in-memory.

**Per v3**: login multi-user, session store persistente, user CRUD.

---

## Matrice Isolamento Attuale

| Dominio | profile_id filtrato | contact_id filtrato | namespace filtrato | Cascade delete |
|---------|--------------------|--------------------|-------------------|----------------|
| Memory chunks | ✅ | ✅ | ✅ (_private) | ✅ |
| Memory search | ✅ (profile_ids) | ✅ (filter_map) | ✅ (allowed_ns) | — |
| Memory pruning | ✅ | — | — | — |
| Memory history | ✅ | — | — | — |
| RAG sources | ✅ | — | ✅ | ✅ |
| RAG search | ✅ | ✅ (namespace) | ✅ | — |
| Contacts | ✅ | — | — | ✅ |
| Automations | ✅ | — | — | ✅ |
| Business | ✅ | — | — | ✅ |
| Workflows | ✅ | — | — | ✅ |
| Vault log | ✅ | — | — | ✅ |
| Skill audit | ✅ | — | — | ✅ |
| Pending responses | ✅ | ✅ (contact_id) | — | ✅ |
| Sessions | ✅ (column) | — | — | ✅ |
| Gateway overrides | ✅ (FK) | — | — | ✅ (fase 1) |
| Shared resources | ✅ (FK) | — | — | ✅ (fase 1) |
| Knowledge watches | ✅ | — | — | ✅ |
| Skills (filesystem) | ✅ (dir) | — | — | ✅ (brain dir) |
| Brain files | ✅ (dir) | — | — | ✅ (brain dir) |
| MCP servers | ❌ globale | — | — | — (by design) |
| Vault secrets | ❌ globale | — | — | — (by design) |
| Config TOML | ❌ globale | — | — | — (by design) |
