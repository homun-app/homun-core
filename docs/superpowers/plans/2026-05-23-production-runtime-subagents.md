# Production Runtime And Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the local Gemma runtime and Rust subagent manager into production-ready local-first components.

**Architecture:** Runtime hardening stays in `runtimes/mlx-gemma4/server.py` and Python tests. Subagent hardening stays in focused Rust modules under `crates/subagents/src`, with typed boundary errors and persistence in `AuditStore`.

**Tech Stack:** Python FastAPI/Pydantic, MLX/MLX-VLM, Rust 2024, rusqlite, serde.

---

### Task 1: Runtime Operational Hardening

**Files:**
- Modify: `runtimes/mlx-gemma4/server.py`
- Modify: `tests/test_mlx_gemma4_server.py`

- [ ] Add failing tests for runtime config, stable error shape, busy rejection, deadline rejection, image root validation, aggregate benchmark metrics and disabled shutdown.
- [ ] Implement `RuntimeConfig`, `RuntimeErrorPayload`, request options, busy lock handling and safe image path validation.
- [ ] Ensure existing endpoint behavior remains compatible.
- [ ] Run `PYTHONDONTWRITEBYTECODE=1 .venv-mlx/bin/python -m unittest tests/test_mlx_gemma4_server.py`.
- [ ] Commit as `Harden local Gemma runtime`.

### Task 2: Subagent Boundary Errors And Budget Enforcement

**Files:**
- Create: `crates/subagents/src/error.rs`
- Modify: `crates/subagents/src/lib.rs`
- Modify: `crates/subagents/src/runner.rs`
- Modify: `crates/subagents/src/types.rs`
- Test: `crates/subagents/tests/runner.rs`

- [ ] Add failing tests for typed errors, timeout before runtime call, cancelled task before runtime call and budget metadata in audit.
- [ ] Add `SubagentError` and `SubagentResult` helpers for timeout/cancelled status.
- [ ] Enforce zero timeout and cancellation before runtime calls.
- [ ] Run `cargo test -p local-first-subagents --test runner`.
- [ ] Commit as `Harden subagent runner boundaries`.

### Task 3: Workflow Run Persistence And UI Status

**Files:**
- Modify: `crates/subagents/src/audit.rs`
- Modify: `crates/subagents/src/orchestrator.rs`
- Test: `crates/subagents/tests/audit_store.rs`
- Test: `crates/subagents/tests/orchestrator.rs`

- [ ] Add failing tests for workflow run records, task status summaries, recent failures and recovery status reads.
- [ ] Add workflow run table and status query structs.
- [ ] Record workflow run start/finish around orchestrator execution.
- [ ] Run subagent audit/orchestrator tests.
- [ ] Commit as `Add subagent workflow status persistence`.

### Task 4: Documentation And Full Verification

**Files:**
- Modify: `PROJECT.md`
- Modify: `docs/work-memory.md`
- Modify: `docs/superpowers/plans/2026-05-23-production-runtime-subagents.md`

- [ ] Update project docs with production runtime/subagent closure.
- [ ] Mark this plan complete.
- [ ] Run `make test`.
- [ ] Commit as `Document production runtime and subagents`.
