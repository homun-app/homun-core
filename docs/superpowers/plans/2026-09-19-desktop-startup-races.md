# Desktop startup race correction

Goal: cancellation or deadline expiry during health response parsing must never
return an owned engine as ready. Continue under the user's autonomous foundation
work authorization. Scope: existing engine-process module and isolated tests.

Design: keep process ownership in engine-process.cjs. Combine caller cancellation
and remaining startup deadline for the HTTP probe, then recheck ownership, abort
and deadline after parsing health. Preserve awaited teardown on every failure.
A shell-only check leaves the reusable process owner unsafe; redesigning lifecycle
is unnecessary for this bounded defect. No API, database or UI behavior expansion.

- [x] Reproduce abort while real child HTTP response body is delayed; assert rejection
  and actual child exit. Also reproduce health arriving after startup deadline.
- [x] Add remaining-budget probe cancellation and post-await readiness checks.
- [x] Run desktop suite and build an updated app using the unchanged engine bundle.
- [x] Compare packaged owner module to source and record artifact plus native UI limit.

Tests live in apps/desktop/tests/engine-startup-races.test.cjs; fixtures use a Node
child with a real HTTP socket, synthetic temporary data and no provider access.

Related recovery defect reproduced using SIGKILL after manifest verification but
before atomic rename: list_backups exposed .pending-* as completed. Exclude hidden
staging directories from listing; retain them on disk for explicit recovery, and
prove a subsequent backup succeeds after the killed owner releases the lease.
Scope extension is within the previously authorized crash/recovery foundation work.

Risultati e limiti: docs/research/2026-09-19-desktop-reliability-delivery.md.
