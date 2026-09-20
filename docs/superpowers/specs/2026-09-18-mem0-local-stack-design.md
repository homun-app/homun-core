# Mem0 local stack — F3.5a slice C

**Date:** 2026-09-18  
**Status:** accepted  
**Depends on:** MemoryPort ledger (F3.5a A/B), ModelPort / Ollama path

## Goal

Run Mem0 OSS **fully local** (Ollama LLM + embedder, Qdrant vector store) behind Homun `DualWriteMemoryPort`. SQLite ledger remains source of truth. No OpenAI/cloud defaults when `HOMUN_MEMORY_BACKEND=mem0`.

## Rules

- Explicit config only via `build_local_mem0_config()` + env vars.
- Project isolation enforced by ledger metadata (`homun_id` → note.project_id), never Mem0 alone.
- Interpret never auto-writes memory.
- Init failure with backend=mem0 → loud `Mem0UnavailableError` (fix stack or unset env).

## Env defaults

| Env | Default |
|-----|---------|
| `HOMUN_MEMORY_BACKEND` | `sqlite` |
| `HOMUN_MEM0_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `HOMUN_MEM0_LLM_MODEL` | `llama3.2` |
| `HOMUN_MEM0_EMBED_MODEL` | `nomic-embed-text` |
| `HOMUN_MEM0_EMBED_DIMS` | `768` |
| `HOMUN_MEM0_QDRANT_HOST` | `127.0.0.1` |
| `HOMUN_MEM0_QDRANT_PORT` | `6333` |
| `HOMUN_MEM0_COLLECTION` | `homun_memories` |

## Operator prerequisites

```bash
uv pip install -e ".[memory]"
docker run -d -p 6333:6333 -p 6334:6334 qdrant/qdrant
ollama pull llama3.2
ollama pull nomic-embed-text
HOMUN_MEMORY_BACKEND=mem0 npm run engine:dev
```

## Success criteria

1. Config unit test: ollama + qdrant providers, no openai keys.
2. Fake Mem0 dual-write: project A recall excludes project B.
3. `GET /v1/memory/status` reports backend + ok/detail.
4. Settings Memoria shows status + recall search.
5. Live integration optional behind `HOMUN_MEM0_LIVE=1`.
