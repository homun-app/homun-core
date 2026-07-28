# Browser Checkpoint and Recovery Design

**Status:** Approved for implementation

**Date:** 2026-07-28

## Problem

Homun keeps one warm browser session per chat thread, but the ownership is process-local. A
browser RPC is executed in a blocking task while an outer Tokio timeout bounds the call. If the
outer timeout wins, the gateway can no longer recover the moved client. The blocking call later
finishes, the client is dropped, the sidecar sees stdin EOF, and the sidecar currently closes the
tabs it opened.

The V5 train-booking smoke demonstrated the full failure sequence:

1. the same thread and objective reached browser observation generation 76;
2. a screenshot call lost the client at the gateway deadline;
3. the following snapshot and tabs calls saw no usable page;
4. a later navigation opened a new page at generation 1;
5. the selected journey and in-page draft state were no longer available.

The browser runtime already has `targetMeta`, but it is held only inside one sidecar and records
only the last explicit navigation. It cannot survive sidecar or gateway loss, and it does not
preserve unsent form state.

## Goals

- Preserve the exact live page, including unsent form state, when the sidecar or gateway is lost
  but the contained Chromium page is still alive.
- Recover after a full browser-page loss by navigating to the last trusted URL and restoring only
  bounded, reversible form draft values.
- Bind every checkpoint to the owning user, workspace, thread, objective revision, target, and
  browser epoch.
- Keep observation generations monotonic across recovery and rebuild refs from a fresh snapshot.
- Never persist page text, screenshots, credentials, payment data, CVV, passwords, file inputs, or
  other secret-bearing controls in plaintext.
- Never replay clicks, submit actions, bookings, payments, account changes, or actions whose remote
  outcome is uncertain.
- Preserve the existing sandbox, URL policy, effect policy, Vault, payment approval, and task/run
  ownership boundaries.
- Make degradation explicit and fail closed when exact recovery is impossible.

## Non-goals

- Serializing and reconstructing arbitrary JavaScript heap or SPA component state.
- Exactly-once recovery for arbitrary remote side effects.
- Replaying an action journal to reconstruct navigation, booking, cart, account, or payment state.
- Persisting authentication material outside the existing browser profile and secret store.
- Treating recovery as evidence that a remote action succeeded.

## Considered approaches

### Increase RPC deadlines

This delays the failure but retains the ownership bug. Any slower call can still outlive the outer
deadline and destroy the session. It is not a recovery mechanism.

### Replay browser actions

Replaying all actions can duplicate bookings or other external effects whose outcome is unknown.
Classifying a click as ordinary is not sufficient evidence that it is safe to replay after a site
or session change. This approach violates the existing exactly-once boundary.

### Layered checkpoint and restore

The selected design first adopts the exact live Chromium page. Only when that page is gone does it
navigate to the last URL and restore a restricted encrypted form draft. No committing action is
replayed. This addresses the observed failure without claiming impossible reconstruction.

## Recovery model

Recovery has three explicit results:

- `adopted_live_page`: the original Chromium target still exists. Homun adopts it and preserves
  the exact DOM, unsent form values, scroll position, cookies, and in-memory page state.
- `restored_safe_draft`: the original target is gone. Homun navigates to the checkpoint URL and
  restores the bounded set of eligible form controls from encrypted storage.
- `degraded_url_only`: only the URL could be restored, or one or more controls no longer match.
  Homun returns structured missing-field metadata and never invents values or claims full recovery.

`no_checkpoint`, `stale_contract`, `policy_denied`, `origin_changed`, and `expired` are terminal
restore refusals, not aliases for a fresh unrestricted browse.

## Durable contract

The task-runtime store owns one metadata row per active thread target:

```text
browser_checkpoints
  user_id
  workspace_id
  thread_id
  objective_revision
  target_id
  browser_epoch
  cdp_target_id
  url
  origin
  generation
  draft_secret_ref
  draft_field_count
  omitted_sensitive_count
  status
  created_at
  updated_at
  expires_at
```

The composite owner key is `(user_id, workspace_id, thread_id, target_id)`. Updates require the
same objective revision. A stale turn cannot overwrite or consume a checkpoint belonging to a
newer objective.

The row contains metadata only. `draft_secret_ref` points at encrypted material in the existing
`EncryptedFileSecretStore`; the SQLite row never contains control values, cookies, page content,
or request payloads.

The draft secret contains a versioned, bounded payload:

```text
schema_version
origin
captured_at
controls[]
  locator descriptor
  control kind
  value/checked/selected state
```

Limits are fixed in code: at most 32 controls, 2,000 characters per control, and 16 KiB total
serialized plaintext before encryption. Values beyond the limits are omitted and reported.

## Browser protocol

The Rust and TypeScript browser contracts add:

- `browser.checkpoint`: captures target metadata and the safe draft; it does not mutate the page.
- `browser.restore`: adopts a live CDP target or performs URL plus safe-draft restoration.
- `browser.detach`: disconnects a sidecar from a shared contained-browser context without closing
  owned pages. This is used for abnormal parent loss and timeout recovery.

Explicit `browser.stop`, thread archive/delete, user "close all browsers", objective completion or
cancellation, and idle expiry still close pages and remove checkpoint data.

Every successful open, navigation, snapshot, or post-action observation returns enough metadata to
refresh the checkpoint: logical target, current URL, CDP target id, browser epoch, and generation.
The gateway removes that metadata before the result enters model context or durable agent journals.

On stdin EOF the sidecar uses detach semantics only for a shared CDP context. A sidecar that owns an
isolated or host-launched context still closes it, because there is no external browser process that
can safely retain the page. Explicit stop always closes regardless of context mode.

## Live page adoption

For a shared contained-browser context, the sidecar obtains the Chromium target id through a CDP
session and includes it in the checkpoint. A replacement sidecar enumerates pages in the shared
context and adopts only the exact checkpoint target id.

Adoption additionally requires:

- exact user/workspace/thread metadata selected by the gateway;
- exact active objective revision;
- unexpired checkpoint status;
- matching browser epoch;
- matching page origin unless the page is at a navigation transition already recorded by a newer
  checkpoint.

The model cannot provide or override checkpoint identifiers. They are gateway-owned inputs.

After adoption, refs are empty until a fresh snapshot. The page state's generation starts from the
persisted generation; the mandatory snapshot increments it. A checkpoint at generation 76 therefore
resumes at generation 77. Any action still carrying generation 76 fails stale-generation validation.

## Safe draft capture

Draft capture considers only visible, enabled controls on the active page:

- text, email, tel, search, number, date, time, and URL inputs;
- textareas;
- select elements;
- checkboxes and radio buttons.

Each locator descriptor uses bounded structural attributes such as tag, type, name, id,
`autocomplete`, accessible label, and form identity. Restore requires an unambiguous match and the
same origin. Ambiguous, missing, disabled, or changed controls are skipped.

The following are never captured:

- password controls;
- any autocomplete category for current/new password or payment-card data;
- controls detected by the existing payment-floor machinery;
- CVV/security-code controls;
- file and hidden inputs;
- contenteditable regions;
- controls whose descriptors or values exceed bounds.

Names, email addresses, phone numbers, passenger data, and addresses may be draft data. They are
eligible only because the payload is encrypted, scoped to the active objective revision, and deleted
at the terminal boundary. They must not appear in logs, SQLite, traces, tool results, or debug output.

## Restore authorization

Safe-draft restoration is a page mutation and requires the active objective contract to allow
`external_write`. Live-page adoption and a fresh snapshot are reads, but adoption alone does not
authorize a subsequent write.

Restore refuses when:

- the objective revision changed;
- the contract is completed or cancelled;
- `external_write` is absent for draft restoration;
- URL policy rejects the checkpoint URL;
- origin changed;
- encrypted material is missing or invalid;
- the checkpoint expired.

The independent payment approval gate remains unchanged. Recovery cannot synthesize, consume, or
reuse a payment approval.

## Gateway lifecycle

1. A browser observation succeeds.
2. The gateway strips recovery metadata from the model-facing result.
3. The gateway upserts metadata in `browser_checkpoints` with the owned objective revision.
4. At bounded points after reversible draft mutation and before parking the turn, the gateway calls
   `browser.checkpoint` and writes the encrypted payload through `SecretStore`.
5. A later call first attempts the warm in-process client.
6. If no client exists, the gateway loads the active checkpoint and spawns a replacement sidecar.
7. The gateway calls `browser.restore` using only trusted checkpoint data.
8. A fresh snapshot establishes refs and the next generation before the browser agent continues.
9. Restore status is journaled as metadata only: tier, generation, counts, and reason. URLs and values
   are excluded from the agent journal event.

## Timeout ownership

The outer Tokio deadline remains a responsiveness boundary, but timeout no longer means "forget the
page". When a call times out:

- the timed-out client is quarantined and cannot receive another request;
- the checkpoint from the last successful observation remains authoritative;
- abnormal EOF detaches from shared Chromium instead of closing the page;
- the next browser operation creates a replacement sidecar and attempts restore once;
- the failed RPC is never automatically replayed.

This preserves the exactly-once boundary: the system recovers the latest confirmed observation, not
the uncertain operation that timed out.

## Cleanup and retention

Checkpoint metadata and draft secrets are deleted when:

- the matching objective completes or is cancelled;
- the thread is archived or deleted;
- the user closes the browser or all browsers;
- the checkpoint exceeds the same warm-session TTL;
- a newer objective revision supersedes it.

Startup cleanup removes expired metadata and corresponding encrypted material. Cleanup is
idempotent. A missing secret is treated as degraded recovery, never as a fatal startup error.

## Observability

The agent journal records bounded metadata-only events:

- `browser_checkpoint_saved`;
- `browser_restore_adopted`;
- `browser_restore_safe_draft`;
- `browser_restore_degraded`;
- `browser_checkpoint_cleared`.

Events contain schema version, target count, generation, recovery tier, restored/skipped counts,
and a typed reason. They contain no URL, origin, selector, field name, value, cookie, or page text.

## Tests

### Browser runtime

- A shared CDP page survives abnormal sidecar detach and is adopted by a replacement manager.
- Explicit stop still closes the page.
- Adoption keeps an unsent safe form value and resumes generation monotonically.
- Full page loss restores eligible draft controls after navigation.
- Password, payment, CVV, file, hidden, ambiguous, and cross-origin controls are never restored.
- Restore never submits a form or triggers a click.
- Checkpoint payload bounds are enforced.

### Rust contracts and store

- New browser methods serialize identically across Rust and TypeScript.
- Checkpoint upsert/load/delete is scope exact and revision guarded.
- Stale objective revisions cannot restore or overwrite a checkpoint.
- Draft values exist only in the encrypted secret store and never in SQLite or journal payloads.
- Terminal objective transitions and thread deletion remove metadata and encrypted material.
- Timeout recovery attempts restore once and does not replay the timed-out operation.
- A restored session forces a fresh snapshot before any action.

### End-to-end smoke

1. Start a generic local form fixture in the contained browser.
2. Fill safe draft fields without submitting.
3. Record generation `N` and force the browser sidecar to terminate.
4. Continue the same thread and objective.
5. Prove the original page is adopted, values remain present, and the next observation is `N + 1`.
6. Repeat after closing only the page; prove safe-draft fallback and explicit skipped-sensitive counts.
7. Prove no submit request occurred.
8. Cancel the objective and verify task, run, message, objective, checkpoint metadata, and encrypted
   draft all reach terminal/removed state.

The existing train-booking smoke is rerun only after the deterministic fixture test passes. It must
reach form draft after a forced sidecar loss without restarting discovery or inventing passenger data.

## Completion criteria

The gap is complete when deterministic tests and a real development smoke prove:

- exact page adoption across sidecar loss;
- bounded safe-draft recovery when the page itself is lost;
- no sensitive plaintext persistence;
- no replay of uncertain or committing actions;
- monotonic generation and fresh refs;
- cleanup at every terminal boundary;
- no regression to sandbox, Vault, URL, payment, connector, or agent-loop contracts.
