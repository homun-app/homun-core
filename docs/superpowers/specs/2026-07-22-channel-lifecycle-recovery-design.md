# Channel Lifecycle Recovery Design

**Date:** 2026-07-22
**Branch:** `fabio/fix-channel-lifecycle`
**Status:** Implemented and verified on `fabio/fix-channel-lifecycle`; integration pending

## Problem

Two live channel failures have separate local root causes.

1. A WhatsApp inbound message is accepted, deduplicated, persisted in its
   `channel_whatsapp_*` thread, and enqueued as a `chat_turn` in the personal
   `local-workspace`. The background task workers poll only the workspace that is
   currently selected in the desktop UI. When another project such as Atlas is
   active, the personal channel turn remains `queued`, creates no `agent_run`, and
   never reaches the reply-mirroring hook.
2. A Telegram sidecar can survive a data reset or gateway restart. Gateway rebind
   updates its callback target, but does not restore a deleted
   `channel-telegram-status.json`. The bot token and Telegram API connection remain
   valid while the gateway status endpoint reports `connected: false` and
   `running: true`.

The fix must preserve channel conversations in the personal workspace, preserve
workspace isolation for memory and execution, and avoid relying on UI selection
for background delivery.

## Selected Approach

### 1. Schedule background work across all user workspaces

Add a task-store query that returns the distinct workspace identifiers containing
non-terminal runnable work for one user. The gateway worker will inspect those
scopes, ask the existing `TaskScheduler` for the best ready candidate in each
scope, then select one global candidate using the existing ordering:

1. higher priority first;
2. older creation time first;
3. stable task id tie-breaker.

Task acquisition, leases, resource reservations, dependency checks, expiry, and
execution continue to use the selected task's own `user_id` and `workspace_id`.
The currently selected workspace remains a renderer/navigation concern and is no
longer the scheduler's visibility boundary.

The personal channel thread and task remain in `local-workspace`; they are not
copied or moved into the active project. This keeps contact history and memory
permissions independent from whichever project happens to be open.

### 2. Refresh Telegram status during a successful rebind

Make `/configure-gateway` a full bridge-state refresh rather than only a callback
target update. After authenticating the control token and accepting the loopback
gateway target, the sidecar will call `getMe` through its existing bot client and
rewrite the canonical status file:

- success: `connected: true`, current bot username, no error;
- Telegram failure: `connected: false`, no username, redacted diagnostic error.

The endpoint returns success only after the status refresh succeeds. A failed
refresh makes the gateway's existing lifecycle policy replace the stale sidecar,
so reconnect remains self-healing. No bot or gateway token may appear in status,
logs, or error bodies.

## Data Flow

### WhatsApp

1. Sidecar forwards the allowed inbound message.
2. Gateway persists the channel user message and `chat_turn` atomically in
   `local-workspace`.
3. A worker discovers runnable scopes for `local-user`, including
   `local-workspace` even when Atlas is active.
4. The worker acquires the task in its stored scope and runs the existing canonical
   turn executor.
5. The executor persists the assistant response and the existing channel mirror
   sends it through the WhatsApp sidecar.
6. The existing `thread.updated` event refreshes the conversation projection.

### Telegram

1. Gateway detects an existing listener on port 18767.
2. Gateway sends authenticated `/configure-gateway` with its current callback
   target.
3. Sidecar validates both the control secret and live Telegram bot identity.
4. Sidecar persists a fresh connected status before returning success.
5. Gateway keeps the compatible sidecar; otherwise it follows the existing
   controlled replacement path.

## Error Handling

- Failure to enumerate task scopes is a worker error and must be visible through
  the existing executor status; it must not silently report an empty queue.
- A workspace that has no ready tasks is skipped without affecting other scopes.
- The scheduler must never acquire a task using the active workspace id when the
  task belongs to a different scope.
- Telegram rebind rejects non-loopback gateway URLs and wrong control tokens as it
  does today.
- Telegram API failures write a redacted disconnected status and cause replacement;
  credentials are never logged.
- WhatsApp delivery failures remain handled by the existing reply-mirroring error
  path; this change does not add a second execution or delivery pipeline.

## Tests

The implementation follows red-green TDD.

### Task runtime and gateway

- A store test proves runnable workspace discovery returns both personal and
  project scopes and excludes terminal-only scopes.
- A gateway worker-selection test creates a queued personal channel task while a
  project workspace is active and proves the personal task is selected with its
  original scope.
- A cross-workspace ordering test proves priority and creation ordering remain
  deterministic.
- Existing lease, resource, broker, and scheduler tests remain green.

### Telegram runtime and gateway

- A sidecar test proves successful reconfiguration refreshes and persists connected
  status.
- A sidecar test proves `getMe` failure produces disconnected status without secret
  material.
- A gateway lifecycle test proves failed status refresh follows the replacement
  branch while successful refresh keeps the sidecar.
- Existing six Telegram bridge tests remain green.

### Live verification

- With Atlas selected, send an allowlisted WhatsApp message and verify:
  `queued -> running -> completed`, an `agent_run` exists, an assistant message is
  persisted in the channel thread, and the reply reaches WhatsApp.
- Remove or temporarily relocate the Telegram status file while the sidecar is
  running, reconnect, and verify the status endpoint returns
  `connected: true`, the UI reflects the connection, and the same sidecar is kept
  only after live identity validation.

## Baseline and Integration Boundaries

- The initial worktree baseline has 94 passing `local-first-task-runtime` tests and
  6 passing Telegram runtime tests.
- One unrelated pre-existing test is excluded from the green claim:
  `store_creates_schema_and_migrations_are_idempotent` expects schema version 6,
  while the current store reports version 8. This change must not edit that stale
  assertion unless separately requested.
- The active `fabio/logical-chat-lifecycle` worktree has uncommitted edits in
  `crates/desktop-gateway/src/main.rs`. This branch must not read, overwrite, or
  incorporate those edits. Integration must happen after that branch is stable,
  with conflicts resolved against the scheduler invariants in this document.
- No release, push, tag, install, data reset, or channel disconnection is included
  without a later explicit deployment decision.

## Non-goals

- Moving channel threads into the active project.
- Showing personal channel history as project memory.
- Adding a second channel executor or inline fallback.
- Changing WhatsApp pairing, allowlists, contact response modes, or Telegram bot
  credentials.
- Refactoring the broader logical chat lifecycle.

## Verification Result

- `local-first-task-runtime`: 55 library tests and 8 scheduler tests pass.
- `local-first-desktop-gateway`: 4 task-executor tests and 6 channel tests pass.
- `channel-telegram`: 8 tests pass, including status refresh and redacted failure.
- Live installed app: WhatsApp and Telegram status files report connected, both
  packaged sidecars listen on ports 18766 and 18767, and the active Atlas
  workspace was restored after releasing the queued WhatsApp turn.
- The repository-wide formatting check still reports unrelated historical format
  drift in large pre-existing files; no broad formatting rewrite was included.
