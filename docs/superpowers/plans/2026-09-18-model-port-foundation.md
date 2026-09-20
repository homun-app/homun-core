# ModelPort Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce Homun `ModelPort` so LLM connections/chat are adapter-swappable; Pydantic AI stays behind `adapters/`.

**Architecture:** Protocol + Homun types in `models/port.py` and `models/types.py`; Fake and OpenAI-compat wrap existing code; `PydanticAIAdapter` is the only module that imports `pydantic_ai`. Registry implements the port; HTTP + Settings UI talk to the port only.

**Tech Stack:** FastAPI, existing Homun engine, Pydantic AI (adapter only), React settings panel.

**Spec:** `docs/superpowers/specs/2026-09-18-model-port-foundation-design.md`

---

## File map

| File | Role |
|------|------|
| `engine/src/homun/models/port.py` | `ModelPort` Protocol + `Connection` model |
| `engine/src/homun/models/types.py` | Extend `ProviderInfo.kind` / connection DTOs |
| `engine/src/homun/models/adapters/__init__.py` | Package marker |
| `engine/src/homun/models/adapters/fake.py` | Thin wrap of `FakeProvider` |
| `engine/src/homun/models/adapters/openai_compat.py` | Thin wrap of existing provider |
| `engine/src/homun/models/adapters/pydantic_ai.py` | Pydantic AI complete/stream |
| `engine/src/homun/models/registry.py` | Implement ModelPort; migrate config → connections |
| `engine/src/homun/routes/models.py` | Chat + connection CRUD via port |
| `engine/tests/test_model_port_f1.py` | Port + adapter isolation tests |
| `apps/web/src/lib/engine-models-client.ts` | Client for chat/connections |
| `apps/web/.../ConversationModelsSettingsSection.tsx` | Prova chat + clearer connections |

---

### Task 1: ModelPort types and failing test

**Files:**
- Create: `engine/src/homun/models/port.py`
- Create: `engine/tests/test_model_port_f1.py`
- Modify: `engine/src/homun/models/types.py` (kind union)

- [x] **Step 1: Write failing test** for Fake-backed port `complete`
- [x] **Step 2: Run test — expect fail** (port missing)
- [x] **Step 3: Add `Connection` + `ModelPort` Protocol in `port.py`**
- [x] **Step 4: Minimal in-memory Fake port impl in test or `adapters/fake.py` — make test pass**
- [x] **Step 5: Commit** (if user requested commits)

---

### Task 2: Registry implements ModelPort

**Files:**
- Modify: `engine/src/homun/models/registry.py`
- Create: `engine/src/homun/models/adapters/*.py`

- [x] **Step 1: Map existing fake + openai_compatible config to `Connection` list on load**
- [x] **Step 2: `complete` / `verify` / `set_active` / `list_connections` on registry**
- [x] **Step 3: Tests for openai_compat path mocked or skipped without network**
- [x] **Step 4: Grep guard test: no `pydantic_ai` import outside adapters/**

---

### Task 3: PydanticAIAdapter (openai + ollama)

**Files:**
- Create: `engine/src/homun/models/adapters/pydantic_ai.py`
- Modify: `engine/pyproject.toml` optional extras if needed

- [x] **Step 1: `complete` via Pydantic AI model for `openai` and `ollama` providers**
- [x] **Step 2: Missing dependency → RuntimeError with clear message**
- [x] **Step 3: Wire `kind=pydantic_ai` connections in registry** *(ConnectionKind + adapter helpers; registry upsert still rejects until Slice B)*
- [x] **Step 4: Unit test with TestModel or fake if available without network**

---

### Task 4: HTTP chat endpoint

**Files:**
- Modify: `engine/src/homun/routes/models.py`
- Modify: `engine/tests/test_models_f31.py` or new test

- [x] **Step 1: `POST /v1/models/chat` body `{ messages, connection_id? }`**
- [x] **Step 2: `POST /v1/models/chat/stream` SSE tokens**
- [x] **Step 3: Interpret continues to use registry/port (no behavior regress)**

---

### Task 5: Web client + Settings prova chat

**Files:**
- Modify: `apps/web/src/lib/engine-models-client.ts`
- Modify: `ConversationModelsSettingsSection.tsx`

- [x] **Step 1: `postModelChat` client**
- [x] **Step 2: Small “Prova chat” textarea + send in Models settings**
- [x] **Step 3: Typecheck + `npm test` for client if added**

---

### Task 6: Docs + roadmap

**Files:**
- Modify: `engine/README.md`, `roadmap.md`, `docs/development/2026-09-17-piano-sviluppo.md`

- [x] **Step 1: Document ModelPort + how to add an adapter**
- [x] **Step 2: Note foundation-first order (LLM → agents → memory → projects → flow)**

---

## Verification

```bash
cd engine && .venv/bin/pytest -q
cd /Users/fabio/Projects/Homun/homun2 && npm run typecheck && npm test
rg -n "pydantic_ai" engine/src/homun --glob '!**/adapters/**'
# expect only adapters (and maybe pyproject)
```
