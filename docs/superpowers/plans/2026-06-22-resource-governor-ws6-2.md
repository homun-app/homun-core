# WS6.2 Resource Governor — slice 1

**Goal:** make task backpressure durable and recoverable: a task that is held
because a local resource is saturated must become runnable again when capacity
is available.

## Scope

- Resource-wait lifecycle for queued task execution.
- `WaitingResource` → `Queued` rehydration when the `ResourceGovernor` reports
  capacity available again.
- Gateway worker integration before selecting the next ready task.
- Focused task-runtime regression test plus gateway verification.

## Non-scope

- New frontend UI.
- New scheduler/recurrence semantics.
- Changing approval behavior.
- Publishing/tagging a release.

## Acceptance criteria

- [x] A task moved to `WaitingResource` because `llm_inference`/other resource is
  saturated is not permanently stranded.
- [x] Once the reservation is released, the governor can clear `blocked_reason` and
  return the task to `Queued`.
- [x] The gateway worker runs the rehydration sweep before `ready_tasks`, so the task
  can be picked up on the next tick.
- [x] Existing resource usage accounting remains unchanged.

## Verification

- Red/green focused test:
  `cargo test -p local-first-task-runtime resource_governor_requeues_waiting_task_when_capacity_returns`
  - Red: missing `requeue_waiting_if_available`.
  - Green: 1 passed.
- Gateway focused test:
  `cargo test -p local-first-desktop-gateway task_executor_requeues_waiting_resource_before_scheduling`
  - Green: 1 passed.
- Broader checks:
  - `cargo test -p local-first-task-runtime` → green.
  - `cargo test -p local-first-desktop-gateway` → 162 passed, 1 ignored.
  - `cargo build -p local-first-desktop-gateway` → green.
  - `npm run build` in `apps/desktop` → green.
  - `git diff --check` → clean.

## Implementation notes

- Added `ResourceGovernor::requeue_waiting_if_available`.
- Added gateway sweep `requeue_waiting_resource_tasks`.
- `run_next_task_once` now calls the sweep after lease recovery and before
  dependency/time/ready-task scheduling.

## Next slice

Make resource pressure visible and operable: expose effective limits versus
usage in the task/executor API, then run an in-app stress gate with multiple
workers and contended `llm_inference`.
