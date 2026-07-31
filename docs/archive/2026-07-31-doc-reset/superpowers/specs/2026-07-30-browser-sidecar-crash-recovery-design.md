# Browser Sidecar Crash Recovery Design

**Date:** 2026-07-30

**Status:** Implemented and verified

## Purpose

Close the provider-level recovery gate left open by the gateway crash E2E without introducing a
second lifecycle or browser contract. A real sidecar process must be replaceable while the shared
contained Chromium remains the owner of the live page.

The existing protocol remains authoritative:

```text
browser.checkpoint -> process loss -> browser.restore -> fresh browser.snapshot
browser_act claim -> dispatch without acknowledgement -> Uncertain -> explicit resolution
```

## Ownership

- The durable execution continues to be owned by `ExecutionContract` and `ExecutionOutcome`.
- `TaskStore` owns browser checkpoint metadata and effect receipts.
- The encrypted browser draft store owns non-sensitive control values.
- The contained Chromium owns the shared browser context and live CDP targets.
- The TypeScript sidecar owns only its CDP connection and process-local target/ref maps.

A sidecar parent loss therefore disconnects from shared Chromium. It must not close the live page.
An explicit `browser.stop` remains the operation that closes sidecar-owned pages.

## Process-Level Scenario

1. Start a fixture HTTP server and a real Chromium with a remote-debugging endpoint.
2. Spawn the production stdio sidecar with that endpoint and a stable browser epoch.
3. Open the fixture, take a snapshot, fill a draft field and persist `browser.checkpoint` output.
4. Kill the sidecar process with `SIGKILL`, so no graceful cleanup hook can manufacture success.
5. Verify through CDP that Chromium and the exact target still exist.
6. Spawn a replacement sidecar with the same endpoint and epoch.
7. Call `browser.restore` with only the checkpoint contract.
8. Require `adopted_live_page`, the same target identity, monotonic generation and preserved draft.
9. Require a fresh snapshot ref and reject the pre-crash ref as stale.

## Unknown Remote Outcome

`browser_act` and `browser_rehydrate` remain external writes. Once their effect receipt is started,
loss of acknowledgement cannot be interpreted as either success or failure. The receipt becomes
`Uncertain`; a later claim for the same idempotency key must return `Resolve`, never `Execute`.
Only the existing explicit resolution API may move that receipt to a terminal state and wake the
execution.

## Acceptance Criteria

- The process E2E uses the production `src/server.ts` entrypoint over JSON lines.
- Chromium is a separate process and survives a hard sidecar kill.
- Restore adopts only the exact target with matching epoch and origin.
- Draft state survives, but stale refs do not.
- A browser-scoped started receipt becomes uncertain and cannot execute twice.
- No new tool, adapter, stop reason, resume path or persistence structure is added.

## Rejected Alternatives

1. Persisting Playwright refs across restart. Refs are observations, not durable identity.
2. Reopening the URL as equivalent to recovery. That loses page and draft state and is only the
   existing degraded tier.
3. Retrying a browser mutation after transport loss. The remote result may already have happened.
4. Adding a browser-specific scheduler or receipt store. Both would duplicate canonical ownership.

## Result

The production contracts passed without a runtime change. The stdio E2E hard-kills the first Node
sidecar, observes the exact target directly through Chromium CDP, starts a replacement process and
recovers the preserved draft with `adopted_live_page`. Its post-restore snapshot advances generation
and a pre-crash generation is rejected before dispatch.

The gateway effect-host test uses a real `browser_act` effect request. Dropping its started dispatch
lease persists `Uncertain`; claiming the identical logical call returns `Resolve`, never `Execute`.
This closes the deterministic provider gate while preserving explicit resolution as the only owner
of unknown remote outcomes.
