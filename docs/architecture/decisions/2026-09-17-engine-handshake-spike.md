# ADR — Engine handshake spike (FastAPI provisional)

- **Date:** 2026-09-17
- **Status:** Accepted for F0 handshake only; not a final framework lock
- **Decision IDs touched:** D-DESK-01 (Electron confirmed separately), D-RUN-01 (**adopted** 2026-09-17; see F0.2 ADR)

## Context

Homun 2 needs a clear boundary between the simulated React UX and a real local
engine. The product stack is confirmed as React + Electron + Python API, but
agent/runtime libraries (Pydantic AI, DBOS) and memory backends (Mem0) are still
candidates and must not be treated as adopted.

## Decision

1. Ship a **minimal Python process** under `engine/` that listens on
   `127.0.0.1:8765` and exposes only:
   - `GET /v1/health`
   - `GET /v1/capabilities`
2. Use **FastAPI + Uvicorn provisionally** for this spike so the HTTP surface
   matches the draft OpenAPI in `contracts/openapi/v1-health.yaml`.
3. Keep capability flags **explicitly false** for domain, agents, materials,
   memory, automations, and peers.
4. The React app may poll health for a connection indicator. Selecting an
   “engine” data path when the process is down must **fail visibly** — never
   fall back silently to the IndexedDB simulator.

## Consequences

- Proven: local process start/stop, curl health/capabilities, CORS from Vite
  `4183`, UI status connected/absent.
- **D-RUN-01 adopted** after F0.2 (Pydantic AI + DBOS). Remaining F0 work is
  hardening on that stack (checkpoint encryption, MCP, Electron packaging),
  plus D-CRYPTO-01 / D-NET-01 / D-MEM-01 still open as separate decisions.
- FastAPI for the HTTP surface of `engine/` remains the API layer for Homun;
  it is not a second agent runtime. OpenAPI for health/capabilities stays the
  contract for those routes.

## Alternatives considered

- TypeScript-only health stub inside Vite: rejected — would blur the
  simulation/real boundary the spike is meant to establish.
- Adopting DBOS/Pydantic AI in the same increment: rejected — violates the
  “validate libraries with reduced experiments before domain build” rule.
