# Browser Effects And Turn Stream Recovery Design

**Date:** 2026-07-23

**Status:** Approved

## Purpose

Restore reliable browser form completion and chat rendering without weakening payment safety. Homun must be able to navigate, search, authenticate, and prepare or confirm bookings when the user requests those actions. The final transfer of money remains the only browser effect that requires a separate, explicit, single-use authorization.

The same change set must make a logical chat turn survive a transient stream disconnect without displaying a false terminal error or rendering duplicated response fragments.

## Confirmed failures

### Browser policy

An interactive train-search turn was classified as `ReadOnlyAnalysis`. The browser executor converted that objective mode into `read_only: true`, while an ordinary local chat was not marked as `channel_owner`. The safety gate then treated every click and Enter/Return press as a committing action and rejected it. Navigation and typing succeeded, but autocomplete selection and form submission were blocked.

The root problem is a conflation of three independent concepts:

1. whether an objective changes Homun or external systems;
2. whether the command came from the user or an untrusted source;
3. whether the browser action transfers money.

### Turn stream

The durable `turn_events` sequence contained correct, non-duplicated deltas. The desktop bridge nevertheless treated any NDJSON end-of-file without a terminal event as a terminal failure. The UI could then clear ownership state and attach to the same still-running turn through the background/resume path. Each replay had a monotonic reducer, but multiple replay publishers could still emit the same `(turn_id, seq)` to a global listener, and the chat view concatenated each delivered delta.

## Chosen approach

Use a structural but focused correction. Preserve the current browser snapshot/ref architecture and durable turn broker. Introduce explicit effect policy at the browser boundary and a single idempotent observation path at the desktop boundary. Do not replace the browser agent or rewrite the task runtime.

Rejected alternatives:

- A minimal boolean patch would unblock the immediate train form but retain the ambiguous `read_only` contract and the multi-owner stream race.
- A browser/runtime rewrite would expand scope without addressing the proven defects more directly.

## Browser authorization model

### Action classes

Browser actions are evaluated by effect, not by generic input mechanics:

- **Ordinary interaction:** navigation, click, coordinate click, typing, Enter/Return, autocomplete selection, search submission, opening results, and non-financial form progression.
- **User-directed account action:** login, logout, account creation, and use of credentials supplied through the vault.
- **User-directed booking action:** selecting a fare or service and creating or confirming a reservation, provided the action does not transfer money.
- **Payment action:** the final action that charges, transfers, authorizes, captures, or otherwise commits funds.
- **Unsupported hazardous action:** arbitrary page script evaluation or an action forbidden independently of payment policy.

Ordinary interaction, account actions, and non-payment booking actions are allowed when they are within the user's request. Payment actions require an approval token. Unsupported hazardous actions remain blocked.

### Origin and intent

Objective mode must not be reused as an origin-trust flag. The browser context receives explicit fields for user direction and invocation origin. A local interactive request is user-directed. An external channel or automation may navigate and prepare a checkout, but cannot mint payment authorization.

Login and booking are not gated by an extra generic confirmation dialog. They remain bound to the user's stated goal and normal secret-handling rules. Credentials come from the vault and must not enter model prompts, browser snapshots, application logs, or durable chat text.

### Payment approval

Before a payment action, Homun emits a Payment Approval Card containing:

- merchant;
- exact amount;
- currency;
- concise transaction description;
- the browser control that will be activated.

Approval creates a server-side, single-use identifier bound to the user, workspace, turn, merchant, amount, currency, and normalized target action. The browser executor consumes it atomically when executing the approved action.

The approval is invalid if any bound value changes, if it expires, if it has already been consumed, or if it is presented by another turn. A failed or changed checkout requires a new card. The model never receives a reusable authorization secret.

### Safety invariants

- No payment occurs without an unconsumed matching approval.
- An approval cannot authorize a larger or different transaction.
- A channel message or automation cannot approve its own payment.
- Login credentials and payment secrets remain outside prompts and logs.
- Removing the blanket click block does not enable arbitrary page-script execution.

## Turn stream model

### Single logical owner

The desktop maintains one owner for the visible text of a `(thread_id, turn_id)` pair. Locally started turns are registered as handled before any asynchronous enqueue or subscription. The background-turn path must not attach a second owner to them.

WebSocket state and the durable per-turn stream may overlap as observations, but only the durable replay path publishes transcript content. WebSocket events may update cockpit/projection state without independently appending answer text.

### Idempotent delivery

Every event is keyed by `(turn_id, seq)`. Deduplication occurs before any UI side effect, including delta concatenation, activity insertion, plan updates, terminal state, and persistence. The deduplication cursor belongs to the logical turn owner and survives transport reconnection.

The bridge must not broadcast replayed content through an unscoped global fan-out when multiple consumers could claim the same request. Either the replay owner receives events directly or the event bus enforces a single subscription per request and sequence.

### Non-terminal disconnect recovery

End-of-file without `done`, `error`, or `cancelled` is a transport interruption, not a logical failure. The bridge:

1. retains the current text and `lastSeq`;
2. checks the persisted turn state;
3. reconnects with `since=lastSeq` while the turn is active or retrying;
4. uses bounded backoff and a bounded idle/recovery budget;
5. completes only on a durable terminal event.

If the turn is terminal but the stream ended before delivering the terminal event, the bridge performs a final replay/state read. A user-visible error appears only for a durable `error`, an unrecoverable missing turn, or exhaustion of the recovery budget with evidence that progress cannot be resumed. The string `Turn stream ended before a terminal event` may be logged as diagnostic context but is not inserted into the conversation.

### Attempt recovery

Attempt-level abort/retry events do not create a new user message, assistant message, or logical turn. Provisional text is reset only when the durable event contract explicitly declares the previous attempt abandoned. Reconnection to the same attempt retains already committed deltas.

## Error handling

- Browser policy denials return a typed reason: payment approval required, approval mismatch/expired/consumed, unsupported hazardous action, or out-of-scope action.
- The browser agent receives an actionable result and must not wander across sites after a deterministic policy denial.
- Stream reconnect failures are recorded with turn ID, cursor, attempt number, and status, without response or secret contents.
- Cancellation remains immediately terminal and suppresses further rendering for that owner.

## Verification strategy

### Automated browser tests

- An interactive `ReadOnlyAnalysis` train search can click an autocomplete option and submit `Cerca`.
- User-directed login and non-payment booking actions are allowed.
- A payment action without approval is blocked and requests a Payment Approval Card.
- A matching approval is consumed exactly once.
- Merchant, amount, currency, turn, action, expiry, or reuse mismatch is rejected.
- External channels and automations cannot approve their own payments.
- Arbitrary script evaluation remains blocked.

### Automated stream tests

- A stream ending while the turn is running reconnects from the last sequence and produces no chat error.
- Duplicate and out-of-order events are applied once.
- Overlapping resume/background signals still produce one transcript owner.
- A local turn is marked handled before a background notification can attach.
- A durable terminal is rendered once.
- Cancellation stops reconnect and rendering.
- Recovery-budget exhaustion reports one typed failure without duplicated bubbles.

### Integration and installed-app checks

- Run the relevant Rust and desktop unit suites, UI contract checks, type checking, and production build.
- In the installed application, start a fresh train-search chat and verify station autocomplete, form submission, and visible search results.
- Exercise a login and a booking flow only up to the payment boundary.
- Exercise the Payment Approval Card with synthetic transaction data; do not perform a real payment.
- Force or simulate an intermediate stream disconnect and verify one assistant bubble, non-duplicated text, automatic resume, and one durable terminal.

## Delivery boundary

Implementation, tests, packaging, installed-app replacement, and release publication are separate gates. No real purchase, payment, deployment, or release publication is authorized by this design approval alone.
