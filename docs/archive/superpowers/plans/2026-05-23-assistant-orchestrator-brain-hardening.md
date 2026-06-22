# Assistant Orchestrator Brain Hardening Implementation Plan

**Goal:** close the first production-ready Brain slice with persistent audit, UI-safe plan read model and durable subagent workflow materialization.

**Architecture:** keep the Brain as the routing boundary, but split persistence and UI projection into focused modules. `audit.rs` owns SQLite records, `ui.rs` exposes redacted read models, and `subagent_workflow.rs` converts planner subagent steps into durable `SubagentTask` records through the existing task runtime bridge.

## Tasks

- [x] Write failing tests for persistent audit success records.
- [x] Write failing tests proving the UI read model does not expose raw user messages or raw tool arguments.
- [x] Write failing tests for planner failure audit records.
- [x] Write failing tests for `subagent_task` plan steps becoming durable task runtime records.
- [x] Add `OrchestratorAuditStore` with idempotent SQLite migrations.
- [x] Add `OrchestratorUiReadModel` with redacted plan detail, loaded tools, task summaries and metrics.
- [x] Extend `PlanStep` and `OrchestratorOutcome` with subagent workflow fields and summaries.
- [x] Add subagent workflow materializer using `SubagentTaskRuntimeBridge`.
- [x] Wire `OrchestratorBrain` to record successful and failed runs when an audit store is configured.
- [x] Extend planner prompt and schema for subagent workflow fields.
- [x] Run `cargo test -p local-first-orchestrator`.
- [x] Run `cargo test --workspace`.
- [x] Run `make test`.
- [x] Update `PROJECT.md` and `docs/work-memory.md`.
- [x] Run `git diff --check`.
