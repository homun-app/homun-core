# F4.1 — Durable work runtime (DBOS in engine)

**Date:** 2026-09-18  
**Status:** accepted (C+B: DBOS in engine + receipts + HTTP run status)  

**Depends on:** D-RUN-01 (Pydantic AI + DBOS), F1–F3 domain, F0.2 spike  
**Slice intent:** “quasi produzione” = spike proofs **inside** `engine/` + HTTP status + Homun receipts (C+B)

## Goal

Run a Homun **Work** as a durable DBOS workflow hosted by the engine process:

1. `work.start` (or dedicated `run.start`) binds `work_id` ↔ `workflow_id` / `run_id` / `command_id`
2. Checkpoint survives process kill; resume continues from the wait or step
3. Human contribution via durable `DBOS.recv` / `DBOS.send` (maps to `work.request_contribution` / `work.provide_contribution`)
4. One uncertain external effect with Homun **receipt** keyed by `command_id` — reconcile, never blind double-apply
5. HTTP: read run/workflow status for Fonte=motore chrome (waiting / running / completed / failed)

Homun owns domain transitions, policy, and receipts. DBOS owns durable wait/checkpoint. No second orchestrator.

## Non-goals (this slice)

- Real tools / MCP / Trello / email (F6)
- File ingest / OCR (F4.2)
- Artifact generation & review UI polish (F4.4–F4.5) beyond linking receipt path
- Checkpoint encryption (D-CRYPTO-01)
- Electron packaging
- Multi-agent insert mid-run (ADR hardening backlog)

## Objects

```text
Run (Homun, minimal)
  id                  # run_*
  workspace_id
  work_id
  workflow_id         # DBOS workflow id (stable)
  command_id          # idempotency for external effect
  status              # pending | running | waiting_input | completed | failed | cancelled
  waiting_topic       # e.g. contribution
  waiting_step_id     # plan step awaiting material
  last_error          # optional
  created_at, updated_at

EffectReceipt (file or SQLite entity)
  command_id
  effect              # e.g. publish_draft_listing
  path / payload_ref
  created_at
```

Domain `Work.status` stays the product truth; Run mirrors execution. On wait → `Work` → `waiting_input`; on resume after contribution → `ready`/`running` per existing transitions.

## Runtime adapter

New package under `engine/src/homun/runtime/` (replace thin capabilities stub or split):

| Module | Job |
|--------|-----|
| `dbos_app.py` | Configure/launch DBOS (SQLite under data dir); lifecycle with FastAPI |
| `workflows/work_run.py` | Durable workflow: load work snapshot → wait contribution → uncertain effect step |
| `receipts.py` | Homun idempotent apply/reconcile (port of F0.2 `side_effects`) |
| `bridge.py` | Map domain commands ↔ start/send/status |

Rules from ADR:

- `retries_allowed` only on steps that may fail after external I/O
- Receipt check before re-apply
- Workflow id derived from `run_id` (stable) via `SetWorkflowID`

## Commands / HTTP

| Surface | Behavior |
|---------|----------|
| `work.start` | Creates Run, starts DBOS workflow, sets Work `running` then quickly `waiting_input` when recv arms |
| `work.provide_contribution` | Domain acceptance + `DBOS.send` to workflow topic |
| `GET /v1/workspaces/{id}/runs/{run_id}` | Homun Run + DBOS status string |
| `GET /v1/workspaces/{id}/works/{work_id}/run` | Current run for work (if any) |

Optional thin UI: Engine domain / work panel shows run status when Fonte=motore (no simulation fallback).

## Dependency

Add `dbos` to `engine` dependencies (version aligned with F0.2: 3.x). Keep pydantic-ai; workflow may use `TestModel` / no LLM in F4.1 proofs (plan already exists on Work).

## Success criteria

1. Automated test: start run → contribute → complete; Work ends coherently (`test_f41_durable_runtime`). Kill/resume script optional under `engine/scripts/`.
2. Uncertain-effect test: receipt write → retry → `reconciled`, single receipt (`test_f41_receipts`).
3. HTTP status reflects waiting/running/completed.
4. Grep: no LangGraph / second orchestrator.
5. Fonte=motore shows waiting state without inventing simulation data (HTTP run endpoints; UI chrome follow-up in F4.6).

## Migration from spike

Port patterns from `experiments/engine/f0_2_runtime/` into `homun.runtime`; spike remains historical proof. Product data lives under engine `data_dir` (DBOS system DB + receipts), not the experiment `.data/`.

## Decisions (locked in plan)

- Trigger: extend existing `work.start` (no separate `run.start` in v1)
- Contribution to DBOS: `{request_id: step_id, note: text, material_ref: optional}`
- Kill/resume: optional script; CI covers in-process complete + reconcile
