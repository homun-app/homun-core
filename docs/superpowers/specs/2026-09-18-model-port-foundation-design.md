# ModelPort foundation — replaceable LLM layer

**Date:** 2026-09-18  
**Status:** accepted (direction approved)  
**Depends on:** F2 storage, existing F3.1 registry (to be refactored behind the port)

## Build order (product)

1. **LLM foundations** — connections, verify, chat, model choice (**this spec**)
2. Agents (profiles/capabilities as Homun objects)
3. Memory (already started as MemoryPort — keep independent)
4. Projects / workspace structure
5. Product flow (composition only after objects are solid)

## Goal

A Homun-owned **ModelPort** so the UI and domain never depend on Pydantic AI (or any vendor SDK). Pydantic AI is one **adapter**. Swapping the adapter must not require changes to chat UI, agents, or memory.

## Architecture

```
UI / domain routes
        │
        ▼
   ModelPort (Protocol + Homun types)
        │
        ├── FakeAdapter          (deterministic tests)
        ├── OpenAICompatAdapter  (Ollama / any OpenAI-HTTP — keep)
        └── PydanticAIAdapter    (native providers via Pydantic AI)
```

- **No `pydantic_ai` imports** outside `engine/src/homun/models/adapters/`.
- Homun types live in `homun.models.types` / `homun.models.port` only.
- Secrets stay in `SecretStore`; connections store ids/refs, never raw keys in JSON logs.

## ModelPort surface (v1)

| Method | Purpose |
|--------|---------|
| `list_connections()` | Configured connections (no secrets) |
| `get_connection(id)` | One connection |
| `upsert_connection(...)` | Create/update provider kind, model, base_url, secret |
| `delete_connection(id)` | Remove connection + optional secret |
| `set_active(id)` | Active connection for chat/interpret |
| `verify(id)` | Probe without claiming chat success |
| `complete(messages, *, connection_id?)` | Sync completion |
| `stream(messages, *, connection_id?)` | Iterator of text chunks then final usage |
| `list_usage(limit)` | Ledger rows |

Interpret/plan stay **callers** of `complete`/`stream` (or a thin `interpret` helper that uses the port) — not a second provider stack.

## Connection object

```text
Connection
  id: str
  kind: fake | openai_compatible | pydantic_ai
  display_name: str
  model_id: str
  base_url: str | null          # openai_compatible / custom endpoints
  pydantic_provider: str | null # e.g. openai, anthropic, groq, ollama, google
  configured: bool
  credential_present: bool
  active: bool
```

For `kind=pydantic_ai`, model identity is `pydantic_provider` + `model_id` (adapter maps to Pydantic AI model strings / factories). Optional extras install groups for vendor SDKs (`anthropic`, `groq`, …) — missing extra → typed `provider_unavailable`, never silent fake.

## Slice A (ship first)

| Item | Choice |
|------|--------|
| Port + types | `ModelPort`, `Connection`, reuse `ChatMessage` / `CompletionResult` / `UsageEntry` |
| Adapters | Fake + OpenAICompat (wrap existing) + PydanticAIAdapter for `openai` / `ollama` / `anthropic` (anthropic optional extra) |
| Registry | `ModelRegistry` implements or owns ModelPort; HTTP routes talk only to the port |
| API | Keep `/v1/models/*`; add connection CRUD if missing; `POST /v1/models/chat` for complete; stream SSE under `/v1/models/chat/stream` |
| UI | Impostazioni → Modelli: list connections, set active, verify, pick model; thin “prova chat” box |
| Simulation | Stay hidden when Fonte=motore; chat uses ModelPort only |

## Slice B (next)

- Broader Pydantic AI providers (groq, google, mistral, openrouter, …) behind same `pydantic_provider` field
- List remote models where API allows
- Routing prefs (quality/fast) as Homun policy over the port, not vendor APIs

## Non-goals

- Agents, memory product flow, projects, F4 execution
- Leaking Pydantic AI types into FastAPI response models
- Requiring cloud keys for local fake/Ollama paths
- Mem0 / Qdrant

## Success criteria

1. Unit tests: FakeAdapter complete/stream without network.
2. Swap test: domain/UI code imports only `ModelPort` types — grep forbids `pydantic_ai` outside adapters.
3. Manual: set active fake → prova chat → text; set Ollama connection → verify → chat; missing key → `HomunClientError` / engine error code, no silent demo reply.
4. Document how to add a new adapter in `engine/README.md`.

## Migration

- Existing `openai_compatible` + `fake` configs map to `Connection` records on load.
- Interpret path uses `port.complete` (or existing interpret helper that calls the port) — behavior preserved for F3.2–F3.4.
