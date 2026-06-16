# Decision 0015: Durable task heartbeat + data retention + user data export

Date: 2026-06-16

## Status

Accepted and implemented. Closes three blockers identified in the roadmap
audit (2026-06-16): task lease expiry mid-run, unbounded SQLite growth, and
missing data portability.

## Context

A code-level audit against `docs/architecture/final-roadmap.md` found three
structural gaps that blocked a first release:

1. **Task lease expiry mid-run.** The `LeaseManager` (5-minute lease) had a
   `heartbeat()` method that was never called in production. Long tasks
   (proactivity LLM turns, browser automation, subagent steps) exceeded 5
   minutes, the recovery loop re-queued them, and the original worker kept
   running blind — producing double-execution and lost work.

2. **Unbounded SQLite growth.** `delete_workspace` removed only the entry from
   `workspaces.json`, leaving orphaned rows in all three stores (chat, tasks,
   memory). No `VACUUM` existed anywhere. Database files grew indefinitely.

3. **No data export.** No endpoint allowed the user to extract their data — a
   GDPR/portability requirement and a user-trust gap.

## Decision

### 1. Heartbeat watchdog + lease-theft guard

A background tokio task (`spawn_lease_watchdog`) renews the lease every 60s
while `execute_read_only_task` blocks. Spawned via `Handle::try_current()`
(the worker runs in `spawn_blocking`). Aborted in every exit path.

After execution, a guard (`is_lease_still_ours`) checks whether the lease was
stolen (recovery + re-acquire by another worker). If stolen, the result is
**discarded** — not written — to prevent double-execution corruption. The
original worker continues to run (no cancellation token exists for the sync
`block_on`), but its output is safely ignored.

Design constraints that shaped this:
- The execution is a single blocking call (`block_on` on an agent turn), not a
  step loop — there is no intermediate point for inline heartbeat.
- The `task_store` mutex is free during execution (the worker releases it before
  `execute_read_only_task`), so the watchdog can lock it without deadlock.
- `LeaseConflict` from `heartbeat()` is the signal that the task was stolen.

**Residual risk:** the original worker runs to completion "wasted" (no
cancellation). This is accepted — adding a `CancellationToken` propagated
through the LLM/browser chain is a future improvement, not a release blocker.

### 2. Cascade purge on workspace delete + periodic VACUUM

`delete_workspace` now calls `purge_workspace_data`, which cascades across all
three stores:
- **ChatStore**: threads, messages, task-thread links, settings (by workspace_id)
- **TaskStore**: tasks, dependencies, resource reservations (by user+workspace)
- **MemoryStore**: memories, entities, relations, tombstones, embeddings,
  episodes, wiki_pages (by user+workspace)

Each store gained a `purge_workspace` method using its existing composite-key
indexes. The purge is best-effort: errors are logged but do not fail the
workspace deletion (the entry is already gone from `workspaces.json`; orphaned
rows are cosmetic).

`vacuum_all_stores` runs at startup in a background `spawn_blocking` task. It
calls `VACUUM` on each SQLite database to reclaim free space from prior deletes.
VACUUM is not run on every delete (it rewrites the entire file — too slow).

### 3. User data export

`GET /api/export` serializes all user data into a single JSON document
(schema `local-first-export/v2`):
- Memories (filtered: no deleted/rejected)
- Chat threads + messages (across all workspaces)
- Contacts + profiles

This complements `/api/memory/export` (memory-only, v1) and the workspace
cascade-purge (deletion). The user can now both export and delete everything.

## Consequences

- Long tasks no longer expire mid-run (heartbeat keeps the lease alive).
- Double-execution is prevented (guard discards stolen-lease results).
- Database files no longer grow unbounded (cascade purge + VACUUM).
- Users can export their data (GDPR compliance + trust).
- The residual "wasted worker" on lease theft is documented and accepted.
- Adding new stores requires adding a `purge_workspace` method to them.

## What changed in the codebase

- `spawn_lease_watchdog` + `is_lease_still_ours` in `main.rs`
- `ChatStore.purge_workspace` + `vacuum` in `chat_store.rs`
- `TaskStore.purge_workspace` + `vacuum` in `store.rs`
- `SQLiteMemoryStore.purge_workspace` + `vacuum` in `memory/store.rs`
- `MemoryFacade.purge_workspace` + `vacuum` (delegates) in `memory/facade.rs`
- `delete_workspace` handler now receives `State(state)` and calls cascade purge
- `vacuum_all_stores` at boot (background)
- `export_user_data` handler + `/api/export` route
- Fixed pre-existing store test (schema_version 1 → 2, from commit 533b7ce)
