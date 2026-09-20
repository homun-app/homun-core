# F4.1 Durable Runtime Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans.

**Goal:** Host a Homun Work as a durable DBOS workflow inside `engine/` with contribution wait, idempotent receipts, and HTTP run status (quasi-prod C+B).

**Architecture:** Homun owns Work/Run/receipts; DBOS owns checkpoint + `recv`/`send`. `work.start` creates a Run and starts the workflow; `work.provide_contribution` accepts domain contribution and `DBOS.send`s to the workflow. No second orchestrator.

**Tech Stack:** FastAPI engine, DBOS 3.x + SQLite system DB under data_dir, existing DomainService.

**Spec:** `docs/superpowers/specs/2026-09-18-f41-durable-runtime-design.md`

---

## Files

| Path | Role |
|------|------|
| `engine/src/homun/runtime/` | Package: capabilities + DBOS + receipts + bridge |
| `engine/src/homun/domain/models.py` | `Run` entity |
| `engine/src/homun/domain/store.py` | `runs` dict |
| `engine/src/homun/storage/sqlite.py` | Persist `run` kind |
| `engine/src/homun/domain/service.py` | Wire start/contribute → bridge |
| `engine/src/homun/routes/domain.py` | `GET .../runs/{id}`, `GET .../works/{id}/run` |
| `engine/src/homun/app.py` / `context.py` | Launch/shutdown DBOS with lifespan |
| `engine/pyproject.toml` | Add `dbos` dependency |
| `engine/tests/test_f41_durable_runtime.py` | Receipts + happy path + reconcile |

---

### Task 1: Runtime package + receipts

- [x] Move `runtime.py` → `runtime/capabilities.py`; package `__init__` re-exports
- [x] Add `runtime/receipts.py` (port F0.2 apply/load/reconcile)
- [x] Tests for single receipt + reconcile path

### Task 2: Run model + persistence

- [x] `Run` model + store + SQLite dump/load
- [x] Domain helpers get_run / list by work_id

### Task 3: DBOS workflow + bridge

- [x] Add `dbos` dep; configure system DB under data_dir
- [x] Workflow: wait contribution → uncertain effect step (`retries_allowed`)
- [x] `bridge.start_work_run` / `bridge.send_contribution` / `bridge.run_status`
- [x] Lifespan launch DBOS when not `for_tests` OR test harness launches explicitly

### Task 4: Domain + HTTP wire

- [x] `work.start` creates Run + starts workflow; transitions toward waiting_input when wait arms
- [x] `work.provide_contribution` → DBOS.send after domain accept
- [x] GET run endpoints; capability flag `runtime` or reuse materials=false / add `runs: true`

### Task 5: Docs

- [x] Mark plan checkboxes; update piano/roadmap; engine README curl for runs
- [x] Spec status → accepted

---

## Decisions locked

- Extend **`work.start`** (no separate `run.start` command in v1)
- Contribution to DBOS: `{request_id: step_id, note: text, material_ref: optional}`
- Kill/resume proof: script under `engine/scripts/` optional; CI covers in-process complete + reconcile
