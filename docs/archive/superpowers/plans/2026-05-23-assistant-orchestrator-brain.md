# Assistant Orchestrator Brain Implementation Plan

**Goal:** implement the first production slice of the Assistant Orchestrator Brain.

**Architecture:** add `crates/orchestrator` with local FTS/BM25 tool retrieval, local JSON planner contracts, memory context adapter, execution policy and durable capability queueing.

## Tasks

- [x] Add crate to the Rust workspace.
- [x] Write failing contract tests for lazy tool indexing.
- [x] Write failing contract tests for direct answer, lazy planner loading and execution routing.
- [x] Implement `ToolSearchIndexStore` with SQLite FTS5/BM25.
- [x] Implement `OrchestratorRequest`, `ExecutionPlan`, `OrchestratorOutcome` and related contracts.
- [x] Implement `MemoryContextProvider` with static/noop providers and `MemoryFacade` adapter.
- [x] Implement `OrchestratorBrain` planner prompt, schema request and JSON validation.
- [x] Implement tool hallucination rejection by validating every capability step against loaded full tool details.
- [x] Implement immediate execution only for short read/draft local-safe steps.
- [x] Queue write/browser/unsafe steps through `CapabilityTaskRuntimeBridge`.
- [x] Preserve retry-loaded tools when planner returns `needs_more_tools`.
- [x] Run `cargo test -p local-first-orchestrator`.
- [x] Run `cargo test --workspace`.
- [x] Run `make test`.
- [x] Update `PROJECT.md` and `docs/work-memory.md`.
- [x] Run `git diff --check`.
