# Projection Outbox And Crash Recovery Design

## Purpose

Make committed execution outcomes converge to their visible projections after process loss without rescanning the complete execution history. The outbox is a durable delivery mechanism for `ExecutionOutcome`; it is not another execution state machine and it does not own effects.

This increment also adds a deterministic crash harness that proves the persistence boundaries instead of relying only on normal-path unit tests.

## Baseline

The current runtime already provides these authoritative contracts:

- `ExecutionContract` owns scope, policy, revision, budget, checkpoint, and wake binding.
- `ExecutionOutcome` is the only terminal or suspended result of a revision.
- `EffectHost` owns authorization, receipt claim, external dispatch completion, replay, and uncertain outcomes.
- the execution journal and its folded `executions` row are the execution source of truth;
- chat task, run, message, objective, HITL wait, channel delivery, and turn events are projections.

Today startup calls `replay_committed_chat_projections`, scans committed executions, and asks the idempotent projector to discover whether work remains. This recovers many crashes, but it does not persist projection intent, claim ownership, retry state, blocking receipt, or the exact revision that still needs projection.

## Scope

This increment includes:

1. a generic persisted projection outbox in `task-runtime`;
2. atomic enqueue with every newly committed execution outcome;
3. exact-revision reads from the journal;
4. fenced outbox claim, completion, retry, blocking, and stale-claim recovery;
5. migration/backfill for outcomes committed before the outbox existed;
6. a gateway worker for `chat_lifecycle` projection;
7. direct requeue of a projection blocked on an uncertain effect receipt;
8. deterministic crash and concurrency tests around commit, claim, partial projection, acknowledgement, and restart;
9. removal of the production full-history projection scan after migration coverage is proven.

This increment does not add new effect protocols, change execution terminal semantics, wire `continue_as_new`, propagate cancellation tokens, or build the resolver UI.

## Approaches considered

### Derive pending work by scanning execution history

This preserves the current implementation but has no durable claim or retry state, repeatedly scans completed history, and cannot directly identify a projection blocked by an uncertain receipt. It remains useful only as a migration validator.

### Put projection state on the `executions` row

This is compact, but one status cannot represent multiple projector kinds and it mixes a derived delivery concern into the authoritative execution projection. It also loses exact-revision work after the execution advances to another revision.

### Dedicated generic outbox

This is the selected approach. An outbox row references an exact journal revision and names a projector kind. It contains delivery state only; the contract and outcome remain in the execution journal. Future projector kinds reuse the same claim protocol without creating another agent-loop contract.

## Durable model

Add `execution_projection_outbox` with these logical fields:

- `projection_ref`: deterministic primary key derived from execution id, revision, and projector kind;
- `execution_id`, `revision`, `projection_kind`: immutable source binding;
- `status`: `pending`, `claimed`, `blocked`, or `completed`;
- `attempt_count`: incremented by each successful claim;
- `claim_owner`, `claim_generation`, `claim_token`, `claimed_at`: fenced worker ownership;
- `not_before`: retry scheduling;
- `blocked_on_ref`: receipt reference when projection cannot continue before explicit effect resolution;
- `last_error_code`, `last_error_detail`: redacted operational evidence;
- `created_at`, `updated_at`, `completed_at`.

The unique identity is `(execution_id, revision, projection_kind)`. The initial projector kind is `chat_lifecycle`. No outcome, message text, connector payload, browser state, Vault value, or secret is copied into the outbox.

## Atomic enqueue

`commit_execution_outcome_with_requirement` appends `OutcomeCommitted`, registers a suspended wake, updates the folded execution projection, and inserts the outbox row in the same SQLite transaction. A rollback leaves neither outcome nor projection intent. An idempotent replay of the same outcome verifies or creates the same deterministic outbox row without producing another row.

Only execution kinds with a registered projector create outbox work. The first registry mapping is `chat_turn -> chat_lifecycle`; unsupported kinds remain valid execution contracts and do not acquire an accidental chat projection.

`continue_execution_as_new` must apply the same enqueue rule to the parent outcome in its atomic parent/child transaction when product wiring begins. The current continuation tests must remain green even though this increment does not activate continuation from the gateway.

## Claim and recovery protocol

The gateway supplies its persisted process generation when claiming. A claim transaction may select:

- a due `pending` row;
- a `claimed` row whose generation predates the current process generation.

It changes the row to `claimed`, increments `attempt_count` and `claim_token`, and binds owner plus generation. Two workers in the same generation cannot claim the same row. Completion, retry, or blocking must match the claimed owner, generation, and token.

State transitions are:

```text
pending -> claimed -> completed
                   -> pending   (retryable failure with not_before)
                   -> blocked   (uncertain effect receipt)
claimed from an older process generation -> claimed by the new owner/token
blocked -> pending              (verified receipt resolution)
```

There is no automatic `blocked -> pending` timeout. Unknown remote outcomes remain stopped until the authenticated resolver records `Applied` or `NotApplied`.

## Projection worker

The gateway starts one projection worker after boot recovery and before normal task workers. It drains due rows in bounded batches and then waits for a notification or a short retry interval. A successful execution outcome commit notifies the worker after the database transaction returns.

For each claimed `chat_lifecycle` row the worker:

1. loads the exact contract and outcome revision from the execution journal;
2. loads the scoped task and validates user, workspace, thread, execution kind, and revision;
3. invokes the existing idempotent chat projector;
4. completes the outbox row only after the terminal/suspended turn event is durable;
5. leaves external channel writes inside `EffectHost`;
6. blocks the row on the returned receipt reference when channel delivery is uncertain.

The projector returns a typed result:

- `Completed`: every required projection and final acknowledgement is durable;
- `BlockedOnEffect(receipt_ref)`: local projections may be partially applied, but the final acknowledgement is intentionally absent;
- `Retryable(error)`: release to `pending` with bounded backoff;
- `InvariantViolation(error)`: return the row to `pending` with redacted evidence, then fail the startup drain or surface a fatal worker health error; it is never acknowledged or hot-looped.

Partial projection is expected to be replayed. Every local mutation therefore remains idempotent and the turn event containing `projection_ref` remains the final acknowledgement.

## Effect resolution

The effect resolver already serializes resolution per receipt. It will stop scanning committed executions. In the same SQLite transaction that records `Applied` or `NotApplied`, it changes outbox rows with `blocked_on_ref = receipt_ref` to due `pending`. After commit it notifies the worker. A crash can therefore observe either the unresolved receipt with a blocked projection or the resolved receipt with pending projection work, never a resolved receipt stranded behind a blocked row.

`Applied` lets replay consume the completed receipt without another remote dispatch. `NotApplied` returns the same receipt identity to `Prepared`, so replay may make one fenced dispatch through `EffectHost`. Concurrent resolver calls still cannot enqueue or dispatch twice.

## Migration and compatibility

The schema migration creates the table and backfills one `chat_lifecycle` row for every committed `chat_turn` journal revision that has an `OutcomeCommitted` event. Backfill is deterministic and idempotent.

Already projected revisions are harmless: the existing terminal turn event makes projector replay a no-op, after which the outbox row is completed. Pending or partially projected revisions are recovered normally. The migration must validate that every backfilled event folds to a matching exact-revision contract and outcome; incoherent history fails atomically.

After migration and restart tests pass, production code removes the unbounded `committed_executions` scan. A bounded diagnostic method may remain only if tests use it to compare journal outcomes with outbox coverage.

## Error handling

- A database error before outcome commit returns failure and creates no outbox work.
- A crash after commit but before notification is recovered because the row is already pending.
- A crash after claim is recovered by the next process generation.
- A crash after partial local projection replays idempotently because acknowledgement is last.
- A crash after remote dispatch follows the effect receipt state, never an outbox retry assumption.
- A crash after projection acknowledgement but before outbox completion replays as a no-op and then completes the row.
- A missing task, mismatched scope, missing journal revision, or conflicting acknowledgement is an invariant violation, not a fabricated success.
- Retryable store contention uses bounded exponential backoff with a maximum delay; it never drops the row.

## Crash harness

The automated matrix uses file-backed SQLite stores, closes or aborts the first worker at a named boundary, reopens the same store with a higher process generation, and asserts durable convergence. The harness covers:

1. outcome commit and outbox enqueue are all-or-nothing;
2. restart after commit but before projection claims the pending row;
3. two concurrent workers produce exactly one valid claim token;
4. restart reclaims a stale claim while the stale worker cannot acknowledge it;
5. failure after task/run mutation but before message/turn acknowledgement replays once;
6. restart after acknowledgement but before outbox completion does not duplicate the turn event;
7. uncertain channel delivery blocks the row and performs no automatic redispatch;
8. `Applied` resolution completes by receipt replay without dispatch;
9. `NotApplied` resolution permits exactly one dispatch with the same receipt identity;
10. legacy committed revisions are backfilled and converge after migration;
11. task, execution, receipt, message, run, objective, wait, and outbox terminal states agree.

The harness injects faults at explicit interfaces or transaction boundaries. Production behavior does not read a general-purpose crash environment variable.

## Acceptance criteria

1. Every new projected outcome has one outbox row committed atomically with it.
2. The gateway projects exact revisions and never relies on an unbounded committed-history scan.
3. A stale or concurrent worker cannot acknowledge another worker's claim.
4. An uncertain effect blocks projection without implicit retry.
5. Receipt resolution requeues only the rows blocked by that receipt.
6. Legacy stores backfill safely and atomically.
7. The crash matrix proves convergence and absence of duplicate effects/events.
8. Existing execution, receipt, HITL, browser, connector, channel, Vault, sandbox, UI-contract, and Electron tests remain green.
9. Rust builds with warnings denied and the desktop development version starts with a healthy gateway.

## Follow-up boundary

After this increment, the next lifecycle work is end-to-end cancellation/deadline propagation, product-wired `continue_as_new`, compensation orchestration, and an Inspector surface for uncertain receipts and projection health. Those features must consume this outbox and the existing contracts rather than introduce parallel execution or effect abstractions.
