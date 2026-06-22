# Assistant Orchestrator Brain Design

## Goal

Create the Rust Core brain that decides whether a request should be answered directly, enriched with memory, executed through a capability, delegated to subagents or enqueued as durable work.

The Brain is not an LLM prompt wrapper. It is a deterministic boundary around a local JSON planner. Rust owns tool visibility, lazy loading, plan validation, execution policy, task queueing and audit.

## Architecture

The first slice lives in `crates/orchestrator` and depends on the existing local components:

- `JsonRuntime` from `crates/subagents` for local Gemma `/generate_json`.
- `CapabilityFacade` for policy-filtered tool visibility and execution.
- `MemoryContextProvider` as a small adapter boundary over `MemoryFacade`.
- `TaskStore` plus `CapabilityTaskRuntimeBridge` for durable execution.
- `ToolSearchIndexStore` for local SQLite FTS/BM25 tool retrieval.

Tool exposure is lazy:

- if visible tools are 10 or fewer, the planner can receive all details.
- if visible tools are more than 10, the planner receives compact `ToolCard` values plus at most 5 full tool details.
- the planner may request one extra retrieval round with `needs_more_tools`.
- the model can only use tools present in loaded full details; hallucinated tools are rejected before execution.

## Execution Policy

Immediate execution is intentionally narrow:

- allowed only for `read` and `draft` actions.
- blocked for managed-cloud providers.
- blocked for browser mutating actions.
- blocked for expected duration over 30 seconds.
- still enforced by `CapabilityFacade.call_tool`.

Everything else becomes durable work through `CapabilityTaskRuntimeBridge`, preserving existing queue, resource, retry and approval behavior.

## Contracts

`OrchestratorRequest` carries request id, policy context, user message, conversation summary, attachments and planner budgets.

`ExecutionPlan` is a simple DAG:

- `route`
- optional `direct_answer`
- `steps`
- optional `needs_more_tools`

`OrchestratorOutcome` exposes the plan, direct answer, loaded tool cards, memory refs, immediate results, enqueued tasks, metrics and audit summary.

## Testing

The first implementation must prove:

- compact tool cards do not expose input schemas.
- full tool detail is loaded lazily by FTS/BM25.
- direct answer creates no task.
- large catalogs load only a bounded subset.
- `needs_more_tools` validates against retry-loaded tools.
- read/draft steps execute immediately.
- write and browser mutating steps are enqueued.
