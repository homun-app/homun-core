# Decision 0008: OrchestratorBrain as the single production planner/orchestrator (A1)

Date: 2026-05-29

## Status

Accepted, poi **EMENDATA dalla [0021](0021-single-guarded-loop-planning-as-tool.md)** (2026-07-09,
audit di riconciliazione). La direzione "instradare il turno di **chat** attraverso il Brain" è
**ritirata**: il motore di chat è il loop unico guardato (0021); il wiring drive-as-chat + i flag
`HOMUN_ORCHESTRATED_CHAT`/`HOMUN_DRIVE_CHAT` sono stati **rimossi** (commit B1). L'`OrchestratorBrain`
**sopravvive come PLANNER** dei deliverable (`make_deck`/`make_document` via `plan_only`) e per
`brain_materialize` — **non** come motore d'esecuzione della chat.

Target end-state originale per milestone M1/A1; reached incrementally.

## Context

The codebase has **two parallel orchestration implementations**:

1. `crates/orchestrator` — `OrchestratorBrain`: tool search (FTS), prompt-level
   planner with strict JSON schema, DAG validation, anti-hallucination,
   lazy tool loading, and materialization of durable tasks via the capability
   and subagent bridges. **Exercised only by tests.**
2. `crates/desktop-gateway` — the production path: `submit_operational_prompt`
   -> `should_create_operational_task` (keyword) -> `ensure_operational_task_for_thread`
   -> `operational_plan_for_goal`/`browser_targets_for_goal`/
   `train_search_draft_for_goal` (keyword + train hardcode) -> a bespoke
   `OperationalPlan` and read-only executor.

The production path violates PROJECT.md ("il core non deve comprendere richieste
tramite regex o keyword") and leaves the Brain dead in production. Three
architectural mismatches block a naive wiring:

- **plan-vs-execute**: `Brain::run` materializes tasks (would double-create and
  hit stub executors). Resolved by the new `Brain::plan_only`.
- **capability model**: the Brain uses a `CapabilityFacade` with *live*
  providers; the gateway reads the registry **cache** (`registry.cached_tools`).
- **store ownership**: the Brain wants owned `TaskStore`/`CapabilityFacade`/
  `ToolSearchIndexStore`; the gateway holds them behind `Arc<Mutex>`.

Also relevant: today `OperationalPlan` is mostly UI display/step-tracking — real
browser execution uses `browser_targets_for_goal` (keyword), so wiring the Brain
only to the *plan* would be cosmetic. The value is de-hardcoding **execution**.

Already done: background worker (`start_task_executor_worker`, default on),
`TaskExecutorRegistry` dispatcher by `task.kind`, `Brain::plan_only`, and the
`execution_plan_to_operational_plan` adapter (transitional bridge / read-model
deriver).

## Decision

Make `OrchestratorBrain` **the single planner/orchestrator in production** and
retire the keyword/train routing and the parallel `OperationalPlan` execution
pipeline. End-state, in one line:

> prompt -> Brain (plans over the shared CapabilityFacade + Memory + ModelRouter)
> -> ExecutionPlan -> durable tasks in the shared TaskStore -> background worker
> -> real executors (browser/connector/subagent as capability tools) -> results
> + a redacted ExecutionPlan-derived read-model for the UI.

### Five pillars

1. **One brain.** The prompt path calls the Brain. Retire
   `should_create_operational_task`, `browser_targets_for_goal`,
   `train_search_draft_for_goal`, `operational_plan_for_goal`.
2. **One capability source.** The gateway builds a single `CapabilityFacade`
   with the *live* providers (browser, skill, MCP, …), shared by the Brain
   (`list_tools` for planning) and execution (`call_tool`). The registry keeps
   config/grants/`secret_ref`; the facade is the runtime surface. A
   registry-cache-backed provider is allowed only as a transitional shim.
3. **One execution model.** The Brain materializes durable tasks into the shared
   `TaskStore`; the worker runs them via the dispatcher through the **real**
   `CapabilityTaskExecutor`/`SubagentTaskExecutor` (today stubs — GAP 4). The
   browser loop becomes the implementation of a **browser capability tool**,
   invoked as a capability call, not a separate hardcoded path. Converge on
   `ExecutionPlan` as the single plan model; `OperationalPlan` is demoted to a
   UI read-model derived from `ExecutionPlan` + live task state (this is the
   opposite convergence to the transitional adapter; the adapter becomes the
   read-model deriver).
4. **One store ownership.** `TaskStore`/`CapabilityFacade`/`ToolSearchIndexStore`/
   `MemoryFacade` live once in `AppState`; the Brain receives shared handles
   (relax its owned-store design to accept `Arc`/handles), and `run` executes
   under the appropriate lock / on the blocking worker.
5. **Chat & memory in the loop (links A4 + A5).** The Brain's planner runtime is
   the `ModelRouter` (streaming for direct answers); its `MemoryContextProvider`
   is the real `MemoryFacade` with record-event + context injection, so the
   assistant learns.

### Convergence

`ExecutionPlan` is the canonical plan; `OperationalPlan` becomes a derived,
redacted UI read-model. This supersedes the earlier transitional choice
("Adapter -> OperationalPlan"), which remains valid as the read-model deriver.

## Incremental sequence (safe, green at each step)

1. ✅ `Brain::plan_only` (no side effects) + `execution_plan_to_operational_plan`.
2. Live `CapabilityFacade` in `AppState` (start with a registry-cache provider
   shim so the Brain sees the gateway's tools; then real providers).
3. Wire the **real** `CapabilityTaskExecutor`/`SubagentTaskExecutor` into the
   dispatcher (replace the `execute_unwired_registered_task` stubs). Browser as
   a capability tool.
4. Assemble the Brain in `AppState` with shared handles; route the prompt path
   through `Brain` with fallback to the keyword path on failure/low confidence.
5. Retire the keyword/train routing and the bespoke `OperationalPlan` pipeline;
   make `OperationalPlan` a derived read-model.
6. A4 (chat via ModelRouter streaming) + A5 (memory in the loop).

Each step ships behind a flag / with fallback and stays test-green. The system
is pre-production, so partial breakage during the refactor is acceptable and
fixable, but the default build/test must stay green at every checkpoint.

## Consequences

Positive:

- One coherent path: no keyword/train hardcode, no duplicate run loop, no dead
  Brain. The architecture matches what is tested.
- Browser/connectors/subagents become uniform capability/subagent tasks.

Risks:

- Large, multi-step refactor of the production prompt path.
- Live-provider assembly (browser/skill/MCP) is itself substantial.
- Plan-model migration touches task creation, executors, read models and UI.

Mitigation: incremental sequence above; fallback to the keyword path until the
Brain path is proven; the worker + dispatcher already exist to run the tasks.
