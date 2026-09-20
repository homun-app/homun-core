# F3.5a — MemoryPort (approved local notes)

**Date:** 2026-09-18  
**Status:** accepted (slices A–C + gate UI shipped)  
**Depends on:** F2 storage, F3.2 interpret  

## Goal

MemoryPort + optional Mem0 OSS locale: ricordo approvato, persistenza, isolamento due progetti, rettifica, cancellazione, export; nessuna ricostruzione del piano via memoria semantica.

## Shipped

| Slice | Content |
|-------|---------|
| A | `MemoryPort` SQLite ledger: list / add_approved / rectify / delete / export |
| B | Recall + Salva in memoria from chat; dual-write hook |
| C | Local Mem0 (Ollama+Qdrant) via `build_local_mem0_config`; `/v1/memory/status` |
| Gate | Settings: rectify + export JSON; HTTP test isolates two projects on list/recall/export |

## Rules

- Interpret never auto-writes memory
- Unknown / missing Mem0 stays loud when `HOMUN_MEMORY_BACKEND=mem0`
- Project filter is mandatory for isolation checks

## Non-goals

- Using memory to rebuild plans
- Silent capture of every message
- Electron packaging / D-CRYPTO-01 for the memory DB
