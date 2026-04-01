# Prompt per la prossima sessione

Copia e incolla questo come primo messaggio nella nuova sessione Claude Code:

---

## Contesto

Nelle sessioni precedenti abbiamo:

1. **Creato 16 documenti di specifica funzionale** in `docs/features/` che descrivono come ogni feature di Homun deve funzionare (comportamento atteso + dettagli tecnici)

2. **Implementato l'isolamento per profilo** su tutti i domini del sistema:
   - Memory: namespace `_private`/`_public` con filtro strutturale nel search (non prompt-based)
   - Cognition: `allowed_namespaces` propagato dal contact perimeter
   - Tutti i domini (automations, business, vault log, skill audit, pending responses, contacts): filtro `profile_id` a livello SQL
   - Migration 050: aggiunto `profile_id` a vault_access_log, skill_audit, pending_responses
   - Visibility Audit Wizard nella Web UI (`/memory`)
   - Cascade `delete_profile` completa (14 tabelle DB + filesystem cleanup)

3. **Creato `docs/PRODUCTION-READINESS.md`** con la checklist completa per il deploy

## Cosa fare in questa sessione

### Step 1 — Backfill critico (BF-1)

I chunk di memoria esistenti con `contact_id IS NOT NULL` hanno `namespace = '_private'` (default SQL precedente all'implementazione). Con il nuovo filtro, quei contatti non vedranno più le loro memorie. Serve un backfill:

```sql
UPDATE memory_chunks SET namespace = '_public' WHERE contact_id IS NOT NULL AND namespace = '_private';
```

Eseguilo nel codice Rust (non manualmente) — aggiungilo come backfill in `storage/db.rs` nel metodo `run_migrations()`, con un commento che spiega che è un one-shot post-migration-050. Poi verifica con una query di conteggio.

### Step 2 — Test end-to-end isolamento (ISO-1 → ISO-5)

Segui la checklist in `docs/PRODUCTION-READINESS.md`, sezioni ISO-1 → ISO-5. Per ogni punto:
1. Leggi il codice coinvolto
2. Verifica che il flusso sia corretto
3. Se trovi un buco, fixalo
4. Segna il checkbox nel doc

### Step 3 — Flussi non verificati (FLOW-1 → FLOW-6)

Verifica i flussi elencati nella Fase 2 del doc:
- Heartbeat e profilo
- Subagent spawn e profilo
- MCP tool calls e contesto
- Email response modes
- Browser site memory
- Context compaction

Per ciascuno: leggi il codice, verifica se il `profile_id` viene propagato correttamente, fixa se necessario.

### Step 4 — Shell tests flaky (SHELL-1)

Investiga `tools::shell::tests::test_safe_ls` e `test_safe_echo` — capiscine la root cause e fixa o marca `#[ignore]` con commento.

### Step 5 — Aggiorna la checklist

Dopo ogni fix, aggiorna `docs/PRODUCTION-READINESS.md` con i checkbox spuntati e eventuali nuovi punti scoperti.

## File di riferimento

- `docs/PRODUCTION-READINESS.md` — checklist completa
- `docs/features/INDEX.md` — indice specifiche con sezione "Modello di Isolamento"
- `docs/features/03-memoria-conoscenza.md` — Feature 4b (Visibility) e 4c (Audit Wizard)
- `src/profiles/db.rs` — cascade delete_profile
- `src/agent/memory_search.rs` — filtro _private (righe 146-154 e 232-238)
- `src/agent/memory_db.rs` — insert con auto-namespace + funzioni audit
- `src/agent/cognition/discovery.rs` — allowed_namespaces nel memory search
