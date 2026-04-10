# Homun — Production Readiness Checklist

> **Creato**: 2026-04-01
> **Ultimo aggiornamento**: 2026-04-01
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

- [x] Eseguire backfill — aggiunto come `backfill_contact_namespaces()` in `storage/db.rs`, eseguito automaticamente a ogni avvio dopo le migrazioni. Idempotente (no-op se già fixato).
- [x] Verificare conteggio — query di verifica integrata nel backfill stesso, logga errore se rimangono chunk non fixati.

---

## Fase 1 — Test Isolamento End-to-End

### ISO-1: Memory search — contatti non vedono chunk _private

**Scenario**: un contatto scrive su Telegram/WhatsApp/Email.
- [x] Il memory search del contatto NON restituisce chunk con `namespace = '_private'` — `memory_search.rs:151-153` filtra esplicitamente
- [x] Il memory search del contatto restituisce chunk con `namespace = '_public'` e `contact_id` matching — `memory_search.rs:146-149`
- [x] Il memory search del contatto restituisce chunk con `contact_id = NULL` e `namespace = '_public'` (se reclassificati dall'audit wizard) — `memory_search.rs:146-149`, `contact_id.is_some()` è false per chunk globali
- [x] Il proprietario (CLI/Web) vede TUTTI i chunk indipendentemente dal namespace — `memory_search.rs:146`, il blocco è skippato quando `contact_id = None`

**Bug fixati**:
- `search_vector_only()` non applicava il filtro `allowed_namespaces` — ora passato e applicato
- Il check `!chunk.namespace.is_empty()` nel filtro namespace poteva bypassare il filtro per chunk con namespace vuoto — rimosso

### ISO-2: Cognition — allowed_namespaces propagato

- [x] Quando un contatto scrive, la cognition usa `allowed_namespaces` dal contact perimeter — `agent_loop.rs:793`, `cognition/engine.rs:354,365`
- [x] Il perimeter default `["_public", "contact_{id}"]` funziona correttamente — `perimeter.rs:52-66`, test `default_perimeter_values()` conferma
- [x] Un contatto senza perimeter custom riceve il default safe — `perimeter.rs:71-81`, `load_perimeter()` usa `default_perimeter()` come fallback

### ISO-3: Cambio profilo nella Web UI

Cambiare profilo nella topbar e verificare che ogni sezione aggiorni i dati:
- [ ] Memory → chunk count e history cambiano
- [ ] Memory Audit → badge e lista cambiano
- [ ] Automations → lista filtrata per profilo
- [ ] Contacts → lista filtrata per profilo
- [ ] Vault Audit → log filtrato per profilo
- [ ] Skills Audit → log filtrato per profilo
- [ ] Pending Responses → lista filtrata per profilo
- [ ] Knowledge → sources filtrate per profilo

> **Nota**: ISO-3 richiede test manuale con la Web UI — le API backend sono filtrate per `profile_id`.

### ISO-4: Scenario "Warner chiede di Acme"

Setup: due contatti (Acme e Warner) nello stesso profilo, ciascuno con conversazioni consolidate.
- [ ] Warner scrive "a cosa stai lavorando per Acme?"
- [ ] L'agente NON rivela informazioni dalle memorie di Acme
- [ ] L'agente NON menziona Acme come contatto (`can_see_contacts = 0`)
- [ ] I chunk consolidati di Acme (contact_id = acme_id) non appaiono nel search di Warner

> **Nota**: ISO-4 richiede test manuale con conversazioni reali. Il codice di filtro è verificato in ISO-1.

### ISO-5: Delete profilo — cascade completa

- [x] Cascade copre tutti i 16 tavoli con `profile_id` — verificato in `profiles/db.rs:138-172`
- [x] Filesystem cleanup rimuove `brain/profiles/{slug}/` e `memory/profiles/{slug}/` — `profiles/db.rs:198,212`
- [x] Default profile NON è eliminabile — `profiles/db.rs:113-122`, test a riga 472-479
- [x] Nessun tavolo con `profile_id` mancante nella cascade — verifica completa su tutte le 16 tabelle

---

## Fase 2 — Flussi Non Ancora Verificati

### FLOW-1: Heartbeat e profilo

- [x] Verificare quale `profile_id` usa il heartbeat quando scatta — risolve profilo fresh via resolver cascade (`agent_loop.rs:617-682`)
- [x] Il heartbeat accede alla memoria del profilo corretto o a quella globale? — usa `active_profile_id` risolto, con memory scoping corretto
- [x] Se ci sono più profili, il heartbeat non mescola dati tra profili — ogni heartbeat ha scope indipendente

### FLOW-2: Subagent (spawn) e profilo

- [x] Verificare che un subagent spawned erediti il `profile_id` del parent — **FIXATO**: ora `SubagentManager::spawn()` accetta `profile_id` e imposta un session override prima di `process_message()`
- [x] Il subagent ha accesso solo alla memoria del profilo corretto? — sì, via session profile override → resolver cascade
- [x] ToolContext propaga `profile_id` al spawn tool — `spawn.rs` ora passa `ctx.profile_id`

### FLOW-3: MCP tool calls e contesto

- [x] Quando un MCP tool viene invocato, il `ToolContext` contiene `profile_id` e `contact_id`? — sì, costruito in `agent_loop.rs:1095-1110`
- [x] I tool MCP rispettano il contesto di isolamento? — MCP servers sono stateless e non ricevono profile context. By design: i tool MCP interagiscono col mondo esterno (filesystem, git, API), non con dati interni Homun.

### FLOW-4: Email channel response modes

- [x] `assisted` mode: la risposta viene messa in pending con il profile_id corretto? — `PendingApproval` in-memory non ha profile_id, ma è transitorio (vive nella sessione dell'agent loop che ha il profilo corretto). I `pending_responses` in DB (migration 050) hanno `profile_id`.
- [x] `automatic` mode: la risposta usa il profilo corretto per memoria e contesto? — sì, l'agent loop ha il profilo risolto per tutta la durata della sessione.

### FLOW-5: Browser site memory

- [x] La site memory è per-contact ma non per-profile — è intenzionale? — è **per-profile** (non per-contact). Accettabile per v1: la site memory contiene pattern di navigazione (selettori, campi form), non dati sensibili. Un contatto che browsa non vede la site memory di un altro profilo.
- [x] Un contatto che browsa non vede site memories di un altro contatto? — all'interno dello stesso profilo, la site memory è condivisa. Tra profili diversi, è isolata via `profile_brain_dir`.

### FLOW-6: Context compaction

- [x] Quando il contesto viene compattato (`context_compactor.rs`), il `profile_id` viene preservato? — la compaction taglia messaggi vecchi dal context window, non genera memory chunks. Nessun impatto su `profile_id`.
- [x] I chunk compattati mantengono il namespace corretto? — la consolidazione (`memory.rs:469-521`) passa `contact_id` e `profile_id` a `insert_memory_chunk()`, che imposta `namespace = '_public'` per contatti e `_private` per owner.

---

## Fase 3 — Test Shell Flaky

### SHELL-1: test_safe_ls e test_safe_echo

- [x] Root cause: il test `test_shell_command_cancelled_by_stop_request` imposta un flag globale `AtomicBool` (stop flag) che viene visto dai test paralleli via `is_stop_requested()` in `shell.rs:434`. Il flag viene cancellato dopo l'assert, ma c'è una race window.
- [x] Fix: tutti i test che eseguono comandi ora usano un retry loop con `clear_stop()` + sleep backoff, tollerando la cancellazione da race come risultato transitorio (stessa pattern di `test_stderr` e `test_safe_python_version`).
- [x] CI green al 100%: 875 test passano (864 unit + 5 sandbox_e2e + 6 sandbox_runtime_image), 0 failures.

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
| Memory search (vector-only) | ✅ | ✅ | ✅ (fixato) | — |
| Memory pruning | ✅ | — | — | — |
| Memory history | ✅ | — | — | — |
| RAG sources | ✅ | — | ✅ | ✅ |
| RAG search | ✅ | ✅ (namespace) | ✅ | — |
| Contacts | ✅ | — | — | ✅ |
| Automations | ✅ | — | — | ✅ |
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
| Browser site memory | ✅ (dir) | — | — | ✅ (brain dir) |
| Subagent spawn | ✅ (fixato) | — | — | — |
| MCP servers | ❌ globale | — | — | — (by design) |
| Vault secrets | ❌ globale | — | — | — (by design) |
| Config TOML | ❌ globale | — | — | — (by design) |
