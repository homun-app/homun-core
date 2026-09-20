# Agents Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Homun `AgentProfile` with instructions, preferred ModelPort connection, and status; wire roster + Settings UI.

**Architecture:** Domain commands on existing SQLite-backed store; optional connection-id validator injected from ModelRegistry; shared `build_workspace_roster` helper; Settings panel talks to engine only.

**Tech Stack:** FastAPI domain, existing ModelPort, React settings.

**Spec:** `docs/superpowers/specs/2026-09-18-agents-foundation-design.md`

---

## File map

| File | Role |
|------|------|
| `engine/src/homun/domain/models.py` | Extend `AgentProfile` fields |
| `engine/src/homun/domain/roster.py` | Build roster from actor + agents |
| `engine/src/homun/domain/service.py` | `agent.create`/`agent.update` + connection validation |
| `engine/src/homun/context.py` | Inject known connection ids into service |
| `engine/src/homun/routes/domain.py` | GET agent by id; enrich interpret roster |
| `engine/tests/test_agents_foundation.py` | Domain + HTTP + roster tests |
| `apps/web/src/lib/engine-agents-client.ts` | List/get/create/update client |
| `apps/web/.../ConversationAgentsSettingsSection.tsx` | Settings → Agenti |
| `apps/web/.../ConversationSettings.tsx` | Nav section |

---

### Task 1: Spec (done alongside this plan)

- [x] Design spec written

### Task 2: Domain model + commands

- [x] Extend `AgentProfile`
- [x] `agent.update` + extended `agent.create`
- [x] Connection validation via injectable `known_connection_ids`
- [x] Tests green

### Task 3: Roster helper

- [x] `domain/roster.py`
- [x] Use in `_default_roster` / interpret path
- [x] Bridge may list agents when posting (optional if engine merges)

### Task 4: HTTP + UI

- [x] `GET /agents/{id}`
- [x] Web client + Settings section + prova chat

### Task 5: Docs

- [x] Roadmap + piano note

---

## Verification

```bash
cd engine && .venv/bin/pytest tests/test_agents_foundation.py tests/test_domain_f1.py -q
cd /Users/fabio/Projects/Homun/homun2 && npm run typecheck && npm test
```
