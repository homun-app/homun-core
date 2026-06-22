# Telegram approval UX implementation plan

**Goal:** make remote approvals visibly progress after a Telegram tap/reply:
the user should see that Homun received the approval, started execution, and
then completed or failed the action before/while the agent resumes the task.

**Scope:**

- Telegram inline callback and channel text approval replies (`OK <code>`).
- In-app thread status messages for remote approval execution.
- Existing durable approval provenance (`remote_approvals`) remains the source
  of truth.

**Non-scope:**

- New frontend components or live token streaming indicators.
- Changing approval authorization semantics.
- Publishing/tagging a release.

## Current slice (2026-06-22)

- [x] Add immediate Telegram progress reply for valid approval codes:
  `Ricevuto… verifico/avvio`.
- [x] Append in-thread status when an approval is claimed and executing.
- [x] Append in-thread executed/failed status before resume.
- [x] Include action target from approved args (`path`/`to`) in status text.
- [x] Publish `thread.updated` after status appends.
- [x] Rebind/retry Telegram outbound sends when the sidecar is stale before
  reporting failure.
- [x] Make failed initial Telegram delivery visible in the originating thread
  as `delivery_failed` instead of leaving `dispatched_at = NULL` silently.
- [x] Unit coverage:
  `telegram_approval_progress_messages_are_actionable`.
- [x] Local verification:
  `cargo test -p local-first-desktop-gateway` → 161 passed, 1 ignored;
  `cargo build -p local-first-desktop-gateway` → green;
  `npm run build` in `apps/desktop` → green;
  `git diff --check` → clean.

## Field finding (2026-06-22)

Gate attempt did not send the Telegram notification. Evidence in
`~/.homun/desktop-gateway.sqlite`: approval
`approval_fc2026c6804a45029123b354672cd130` / code `FC2026` had correct
thread, source card, tool and arguments, but stayed `pending` with
`dispatched_at = NULL`.

Root cause for this slice: `dispatch_remote_approval` swallowed Telegram
delivery failure and left the in-app thread without an actionable status.
The action was not executed because the approval was never delivered to the
user.

## Final gate — passed

Restarted Electron from HEAD and ran a Telegram-only approval.

Evidence:

- Approval `approval_1a16fb7978fe4a91b163560fafbecff0` / code `1A16FB`.
- Requested path: `/Users/fabio/Desktop/path-b-telegram-ux-2.md`.
- `remote_approvals.dispatched_at IS NOT NULL`.
- `remote_approvals.status = 'executed'`.
- The app thread shows running and executed statuses before the final resume
  response.
- Final resume answer is anchored to `/Users/fabio/Desktop/path-b-telegram-ux-2.md`
  with content `ux-ok-2`.
- File exists on Desktop.
