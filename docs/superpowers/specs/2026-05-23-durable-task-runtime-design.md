# Durable Task Runtime Design

## Goal

Build the central local-first runtime for durable work: independent tasks, workflow tasks, long-running tasks, queueing, priorities, resource limits, approvals, checkpoints and crash recovery.

The key decision is that task durability is not owned by browser automation, subagents, connectors, MCP providers or the UI. It is a Rust Core subsystem that all executors use.

## Definition Of Done

The Durable Task Runtime is production-ready when:

- task state is persisted in SQLite with idempotent migrations.
- tasks are scoped by `user_id` and `workspace_id`.
- tasks can be independent or part of a workflow with dependencies.
- multiple independent tasks can run concurrently when resource limits allow.
- too many tasks are queued by priority and resource availability.
- queue order is deterministic and supports fairness/aging.
- task lifecycle supports pause, resume, cancel, expiry and retry/backoff.
- running tasks use lease/heartbeat to avoid duplicate execution.
- task checkpoints make long work explainable and recoverable.
- tasks can wait for time, resources, external events or user approval.
- UI-safe read models expose active, queued, blocked and completed tasks.
- audit records explain every state transition and scheduler decision.
- no cloud service is required.
- executors are adapters; they do not own scheduling policy.

## Non-Goals

- Implementing real browser automation.
- Implementing live connector sync.
- Replacing the subagent runner.
- Replacing the Capability Layer.
- Building Tauri UI screens.
- Running distributed workers across machines.

## Component Model

```text
crates/task-runtime
  -> contracts
  -> sqlite store
  -> scheduler
  -> queue manager
  -> resource governor
  -> lease manager
  -> checkpoint store
  -> approval gate
  -> read model
  -> executor adapter boundary
```

The runtime exposes a facade:

```text
TaskRuntime
  -> create_task()
  -> create_workflow()
  -> enqueue()
  -> schedule_ready()
  -> acquire_lease()
  -> heartbeat()
  -> record_checkpoint()
  -> complete()
  -> fail()
  -> pause()
  -> resume()
  -> cancel()
  -> request_approval()
  -> approve()
  -> reject()
  -> task_status()
  -> queue_snapshot()
  -> recover_stale_leases()
```

## Task Model

Minimum task fields:

```text
task_id
workflow_id
user_id
workspace_id
kind
goal
status
priority
risk_level
resource_requirements
permission_context
input_json
checkpoint_json
retry_policy
attempt_count
max_attempts
not_before
deadline
expires_at
created_at
updated_at
last_heartbeat_at
lease_owner
lease_expires_at
blocked_reason
```

Statuses:

```text
queued
pending
running
waiting_time
waiting_external_event
waiting_user_approval
waiting_resource
paused
completed
failed
cancelled
expired
```

Priorities:

```text
critical
high
normal
low
background
```

Resource classes:

```text
llm_inference
browser_session
network_io
filesystem_io
connector_api
memory_indexing
graph_indexing
user_wait
background_maintenance
```

## Workflow Model

Workflows group tasks but do not hide individual task state.

Rules:

- A task can run only when all dependencies have completed successfully.
- If a dependency fails, downstream tasks become blocked unless the workflow policy allows compensation.
- Fan-out/fan-in is supported by dependency edges.
- Workflow status is derived from child task states.
- Each task remains independently auditable.

## Scheduling

The scheduler selects runnable tasks by:

1. user/workspace scope.
2. status in `queued` or `pending`.
3. dependencies satisfied.
4. `not_before` reached.
5. approval not required or already granted.
6. resource requirements available.
7. priority order.
8. deterministic tie-break by aging and creation time.

If resources are unavailable, the task moves to `waiting_resource` with an explicit `blocked_reason`.

## Resource Governance

Initial resource limits should be conservative:

- `llm_inference`: 1 active task.
- `browser_session`: configurable, default 1.
- `graph_indexing`: 1 active task.
- `background_maintenance`: low priority only.
- `connector_api`: per-provider limit and backoff.

The runtime stores active resource reservations through leases. On stale lease recovery, reservations are released and tasks return to a retryable state when policy allows.

## Approval Gates

Tasks can request approval before risky operations.

Approval records must include:

- task id.
- requested action.
- risk level.
- data boundary.
- user-visible explanation.
- approval status.
- approver id.
- timestamps.

High-risk task examples:

- submit booking form.
- send message.
- mutate remote project/task state.
- upload/download sensitive file.
- run managed-cloud connector with personal data.

## Executor Boundary

Executors are adapters with a small contract:

```text
TaskExecutor
  -> executor_id()
  -> supported_task_kinds()
  -> estimate_resources(task)
  -> execute_step(task, checkpoint)
```

Executor examples:

- subagent workflow executor.
- capability call executor.
- browser automation executor.
- memory maintenance executor.
- Graphify indexing executor.

Executors may return:

- completed result.
- new checkpoint and continue later.
- waiting for time.
- waiting for external event.
- waiting for user approval.
- retryable failure.
- terminal failure.

## UI Read Model

The UI should be able to show:

- active tasks.
- queued tasks.
- blocked tasks and reason.
- waiting approvals.
- task detail with checkpoints.
- workflow progress.
- resource saturation.
- recent failures.
- audit timeline.

No raw secrets, raw connector payloads or sensitive browser DOM should appear in UI read models.

## Integration Points

### Subagents

Subagent workflow steps become durable tasks when they may outlive the current process or require approvals, retries or resource governance.

### Capability Layer

Capability calls remain provider-neutral. The task runtime decides when a call may run and records checkpoints around the call.

### Browser Automation

Browser automation uses durable tasks for multi-step forms, bookings, long searches, monitoring and operations that may wait for user input.

### Memory

Memory maintenance, Graphify indexing and routine extraction can run as background tasks with explicit resource limits.

## Security Rules

- Deny by default.
- Every task has user/workspace scope.
- Every state transition is audited.
- Secrets are referenced, not stored in task payloads.
- High-risk actions require approval.
- Managed-cloud providers require explicit opt-in.
- Checkpoints must be redacted before UI exposure.
- Cancelled tasks cannot resume without a new explicit transition.

