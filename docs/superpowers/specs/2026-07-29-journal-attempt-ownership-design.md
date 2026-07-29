# Journal Attempt Ownership Design

**Date:** 2026-07-29

**Status:** Approved by the execution-kernel audit and implementation request.

## Purpose

Make `ExecutionState::Running` represent durable worker ownership. A task lease selects a worker; the execution journal records which owner and fencing token may produce the outcome for the current revision.

## Invariants

1. A new or resumed revision starts `Ready`.
2. Adapter dispatch requires an `AttemptStarted` event containing a non-empty owner and the authoritative fencing token.
3. `AttemptStarted` projects the revision to `Running` and is idempotent only for the same owner and fence.
4. A new task lease may recover a crashed `Running` revision only with a strictly newer fencing token through one atomic `AttemptReclaimed` event.
5. Reclaim changes only the contract fencing token and attempt owner.
6. Production outcome commit requires the revision to be `Running` at the matching fence.
7. Existing journals without attempt events remain readable for migration and recovery auditing; new runtime dispatch never emits that shape.

## Data flow

```text
task lease acquired
  -> create/load ExecutionContract
  -> Ready + same/new fence: AttemptStarted
  -> Running(owner, fence)
  -> adapter dispatch
  -> OutcomeCommitted at matching revision/fence

crash while Running
  -> newer task lease fence
  -> AttemptReclaimed(previous owner/fence, new owner/contract)
  -> Running(new owner, new fence)
  -> adapter recovery policy
```

## Recovery safety

Reclaim proves only lifecycle ownership. It does not imply that a consequential remote effect is safe to retry. Effect receipts remain the authority for `Started` or `Uncertain` effects, and the adapter context must resolve those before redispatch.

## Verification

- Store tests prove Ready-to-Running, idempotent same-owner claim, conflicting claim rejection, and newer-fence reclaim.
- Stale outcomes from the previous fence are rejected after reclaim.
- Runtime tests prove every adapter observes a journal state of `Running` while executing.
- Workspace tests and warning-denied builds remain green.

## Implementation result

- `AttemptStarted` and `AttemptReclaimed` are typed journal events folded into `Running`.
- Same-owner/same-fence start is idempotent; conflicting ownership is rejected.
- Running fence changes must use reclaim and may change no contract field except the fence.
- The desktop runtime starts or reclaims the attempt before constructing the adapter context.
- Production outcome commit uses the strict Running-only API; the compatibility API remains for legacy journal fixtures.
