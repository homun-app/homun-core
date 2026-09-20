# Agents foundation — Homun AgentProfile (slice A)

**Date:** 2026-09-18  
**Status:** accepted  
**Depends on:** ModelPort foundation, F1 domain agents, F2 SQLite

## Build order (product)

1. LLM foundations (done — ModelPort)
2. **Agents (this spec)** — profiles as Homun objects
3. Memory (MemoryPort already started)
4. Projects / workspace structure
5. Product flow

## Goal

Make **AgentProfile** a usable Homun object: identity, instructions, preferred ModelPort connection, and status — without tools, MCP, autonomy, or intake-from-chat.

## Non-goals

- Tool grants / MCP / plugins
- Autonomy modes (AG-06)
- Memory policy per agent
- AgentPort / runtime adapters parallel to ModelPort
- Replacing simulation Collaboratori pages
- Creating agents from chat intake

## Target object

```text
AgentProfile
  id, workspace_id, revision
  name, role, avatar          # avatar optional string key
  instructions                # plain/markdown text
  preferred_connection_id     # ModelPort connection id or null
  status                      # draft | active | paused | retired
  created_at, updated_at
```

Rules:

- **id is stable; name is not a key** (duplicate names allowed; UI shows role/id).
- `preferred_connection_id=null` means “use workspace active ModelPort connection”.
- Unknown connection id → `validation_error` (never invent).
- Roster for interpret includes agents with `status in {active, draft}`.

## Commands

| Command | Notes |
|---------|--------|
| `agent.create` | Payload may include role, instructions, preferred_connection_id, status (default `active`), avatar |
| `agent.update` | Patch with `expected_version` |
| `agent.rename` | Unchanged |

## HTTP / UI

- `GET .../agents`, `GET .../agents/{agent_id}`
- Settings → **Agenti**: list/create/edit + optional “Prova come agente” via `postModelChat` (system = instructions)

## Success criteria

1. Domain tests: create/update with instructions + connection; reject unknown connection; revision bumps.
2. Interpret roster includes engine agents by stable id (`kind=agent`).
3. Settings Agenti works when Fonte=motore; engine down → gate error, no simulation fallback.
4. Spec/plan/docs note foundation order.
