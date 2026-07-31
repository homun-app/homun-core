# Memory (as-built)

Verificato 2026-07-31 contro `crates/memory` e gateway.

## Store

- Path: `HOMUN_MEMORY_DB` oppure `{HOMUN_DATA_DIR|~/.homun}/memory.sqlite`
  (`gateway_memory_database_path` in `desktop-gateway`).
- Crate: `local-first-memory`.
- Accesso canonico: **`MemoryFacade`** (`crates/memory/src/facade.rs`) —
  search/upsert/extraction/context pack, ecc. Caposaldo: niente store parallelo.

## Pool vs service

| Flag | Default | Effetto |
| --- | --- | --- |
| `HOMUN_MEMORY_POOL` | **ON** | Pool di connessioni SQLite; `=off`/`0` → `Single` + Mutex |
| `HOMUN_MEMORY_POOL_READERS` | `3` | Reader nel pool |
| `HOMUN_MEMORY_SERVICE` | **OFF** | Se `on`/`1`, gateway usa `MemoryRecallService` (`brief`/`recall`/`learn`); altrimenti orchestrazione inline storica |

Residuo ADR 0022: il **service object** non è ancora il path default. Il pool sì.

## Moduli rilevanti

`recall`, `learn`, `consolidate`, `embedding`, `graph`, `graphify`, `wiki`,
`policy`, `service`, `store`, …

## Linked / privacy

Policy e firewall linked-memory vivono nel crate + gate gateway; non duplicare
uno store “per connector”. Per dettagli di schema tabelle: leggere
`crates/memory/src/schema.rs` (non una doc esterna).
