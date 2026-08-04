# Uncertain Effect Workbench Design

**Date:** 2026-07-30

**Status:** Superseded on 2026-07-31 by the conversation-attention projection. The durable receipt
contract below remains current; references to a Tasks Workbench describe the retired UI only.

## Purpose

Make the existing uncertain-effect recovery contract operable from the desktop without adding a
second stop, resume or effect lifecycle. The backend already owns the authoritative transition:

```text
EffectReceipt::Uncertain -> Applied | NotApplied -> wake/projection replay
```

The missing product boundary is visibility and explicit user resolution. An uncertain browser,
connector or channel effect can currently remain suspended because only the HTTP resolver exposes
the transition.

## Decision

Project unresolved effect receipts into the existing task queue read model and render them inline in
the owning conversation. They are not approvals: approving an operation
authorizes a future dispatch, while resolving uncertainty records verified evidence about a dispatch
that may already have happened.

The Workbench offers exactly two commands:

- **Verified applied** submits `EffectReceiptResolution::Applied` and never dispatches again.
- **Verified not applied** submits `EffectReceiptResolution::NotApplied`, returning the same receipt
  to `Prepared` so its canonical owner may perform one fenced retry.

## Backend Projection

`TaskQueueResponse` gains `uncertain_effects`. Each item is derived from an authoritative receipt
owned by the current user and contains only:

- `receipt_ref`;
- `execution_id`;
- optional `thread_id`;
- a bounded operation family (`browser`, `channel`, `connector`, or `external_write`);
- redacted dispatch evidence already persisted in `effects_json`;
- the persisted timestamp and status.

The projection never exposes the idempotency key, recipient, arguments hash, browser values, page
content, connector payload or model output. Thread-scoped task queue requests retain only matching
receipts. The existing `GET /api/effects/uncertain` endpoint remains available for diagnostics, but
the desktop does not create a parallel polling path.

## Resolution Flow

The desktop posts to the existing endpoint:

```text
POST /api/effects/{receipt_ref}/resolve
```

For `Applied`, the client sends a bounded manual-verification result and merges the already-redacted
dispatch evidence into the resolution evidence. For `NotApplied`, it sends a bounded redacted reason.
The backend continues to verify user ownership, enforce single-flight resolution and atomically
update receipt, wake and blocked projection rows. After success the desktop refreshes the canonical
task queue, selected task and thread read models.

The UI never optimistically removes a receipt. A failed or concurrent resolution leaves the card in
place and surfaces a compact error state; the next queue refresh remains authoritative.

## Desktop Experience

The Tasks navigation badge counts pending approvals plus uncertain effects. The Tasks Workbench
shows uncertain effects before the approval center, using the existing compact operational card
language and familiar Lucide status icons. Each card displays the operation family, related thread
scope when present, and the time of the uncertain transition. Raw JSON evidence is not rendered.

The commands use explicit text because they record two different factual outcomes. While one command
is in flight both are disabled. The section disappears only after the refreshed queue no longer
contains the receipt.

## Provider Boundary

This feature does not claim automatic provider reconciliation. Telegram does not expose a reliable
idempotency lookup after a lost `sendMessage` response. WhatsApp returns a provider message id only
after the sidecar receives acknowledgement, which does not close every crash window. Provider-specific
verification may later produce `Applied` or `NotApplied`, but it must submit the same general
`EffectReceiptResolution` contract used here.

## Acceptance Criteria

- The task queue returns unresolved receipts for the current user and filters them by thread.
- Projection data is metadata-only and contains no recipient, arguments or content.
- The desktop uses the existing task queue poll and resolver endpoint.
- Uncertain effects are visually and semantically distinct from approvals.
- `Applied` never redispatches; `NotApplied` permits only the existing fenced retry path.
- Concurrent or stale resolutions fail closed and refresh from backend state.
- Locale parity, UI contract, Electron tests, TypeScript build and Rust warning-free gates pass.
- No new lifecycle state, wake type, task kind, card marker, tool schema or provider API is added.

## Rejected Alternatives

1. **Chat cards.** They would create another card-derived resume path and mix operational recovery
   into the transcript.
2. **Treating uncertainty as approval.** Authorization and post-dispatch verification have different
   semantics and cannot share approve/reject actions safely.
3. **Automatic retry after timeout.** The remote mutation may already have happened.
4. **Provider-specific recovery contracts.** Provider adapters may verify evidence, but all results
   must converge through `EffectReceiptResolution`.

## Implementation Evidence

- Backend queue projection and thread scope: `7eb8b22f`.
- Desktop bridge, Tasks navigation, Workbench controls and locale parity: `582991f9`.
- `cargo fmt --all -- --check` and gateway clippy with `-D warnings` passed.
- `cargo test -p local-first-task-runtime` passed, including the twelve effect receipt tests and
  three projection crash-recovery tests.
- `cargo test -p local-first-desktop-gateway` passed: 1,076 gateway tests, six optional fixture
  tests ignored, and every integration target green.
- Desktop UI contract, all 93 Electron tests, TypeScript checking and the Vite production build
  passed.
- Playwright verified the queue card at desktop and 390x844 mobile sizes. A deliberately rejected
  resolver request left the card present and surfaced the error instead of reporting success.
- The restarted dev stack owns `127.0.0.1:1420` and `127.0.0.1:18765`; `/api/health` reports no
  recovered store or projection worker error.
