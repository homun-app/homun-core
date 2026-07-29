# Unified Execution Protocol Design

**Date:** 2026-07-28

**Status:** Runtime path implemented; bounded legacy recovery bridges remain

## Purpose

Homun must expose one execution protocol for every kind of work. Chat turns,
automations, browser operations, host-computer work, connectors, subagents,
filesystem operations, artifacts, timers, and resumed work must not have distinct
lifecycle APIs.

The conceptual public entry point is always asynchronous:

```rust
async execute(contract) -> ExecutionOutcome
```

Domain implementations may extend the contract payload and implement domain
behavior. They may not define new status values, terminal rules, wait mechanisms,
resume APIs, receipt semantics, or projection paths.

## Implementation checkpoint

The code currently guarantees:

- every scheduled task enters `ExecutionRuntime::execute` with one validated
  `ExecutionContract`;
- synchronous domain adapters execute on Tokio's blocking pool, outside the async
  projection context;
- the execution journal is authoritative per `(execution_id, revision)` and
  outcome commit is fenced;
- timer, signal, user, approval, model and effect-resolution delivery reopen the
  same execution identity at revision `N + 1`; exact delivery is deduplicated and
  conflicting duplicate payloads fail closed;
- `chat_turn` returns a canonical `ExecutionOutcome` directly from the engine stop;
- non-chat adapters also return canonical outcomes; `TaskExecutionOutcome` and its
  normalization bridge have been removed;
- one idempotent projector owns task, agent-run, message, objective, HITL/approval,
  and terminal-event state for chat;
- startup scans committed journal outcomes, rebuilds a missing execution read model,
  and replays incomplete chat projections before workers start;
- channel and automation work enqueue the same broker contract; marker parsing is
  presentation compatibility and cannot create lifecycle state;
- effect dispatch uses the shared receipt state machine
  `Prepared/Started/Completed/Failed/Uncertain/Compensated`; an interrupted
  `Started` effect suspends until exact typed resolution;
- generated checkpoints carry objective lineage, exact wake and effect receipt refs;
- chat resume loads the exact checkpoint referenced by the prior journal revision,
  not the latest checkpoint found by turn ID;
- `continue_execution_as_new` atomically commits the parent and creates the linked
  child journal; compensation plans are read in reverse effect order and require a
  completed linked compensation execution before a receipt becomes compensated;
- source guard tests reject lifecycle writes in `turn_executor.rs` and direct chat
  dispatch outside `ExecutionRuntime::execute`.

Remaining bounded work:

- old persisted `Parked` steering rows are still readable through a compatibility
  recovery bridge; no current production path creates a new parked turn;
- browser encrypted drafts remain an adapter codec referenced by the common
  checkpoint envelope, by design; they must never move into generic JSON;
- `continue-as-new` has an atomic store contract but each long-running adapter must
  define its compaction threshold and child input before opting in;
- compensation has durable reverse-order planning and completion evidence, but a
  domain adapter must interpret its own compensation recipe and submit the child
  execution; the runtime must not guess connector/browser rollback semantics.

## Non-negotiable invariants

1. There is one public execution entry point.
2. There is one durable `ExecutionContract` envelope.
3. There is one exhaustive `ExecutionOutcome` vocabulary.
4. There is one `WakeCondition` vocabulary for every suspension.
5. There is one effect classification and receipt protocol.
6. There is one canonical execution journal; task, run, message, objective, and UI
   status are projections, never independent control-flow owners.
7. Resume re-enters `execute` with the same contract identity and a newer revision;
   it never calls a domain-specific continuation endpoint.
8. A domain adapter cannot write lifecycle state directly.
9. No model prose, marker, stream closure, or empty transport event can decide a
   lifecycle transition.
10. Migration code is temporary and must have an explicit deletion step.

## Alternatives considered

### A. Keep the current layers and improve their bridges

This has the smallest initial diff, but preserves `TurnOutcome`,
`TaskExecutionOutcome`, task statuses, message delivery, marker persistence, and
domain-specific resume helpers as competing owners. It is rejected because it
continues the architecture that produced the current failures.

### B. Add a new orchestration layer above the current runtime

This could normalize existing outputs without immediately changing producers. It
is rejected as a permanent design because it creates another layer and another
contract. A bounded compatibility adapter is allowed only during migration and
must be deleted when all producers implement the canonical protocol.

### C. Replace execution ownership with one protocol

This is the chosen approach. Existing security and domain engines remain, but all
work enters through the same runtime and returns the same outcome. Old lifecycle
types and specialized callers are removed after their producers migrate.

## Canonical contract

```rust
pub struct ExecutionContract {
    pub execution_id: ExecutionId,
    pub parent_execution_id: Option<ExecutionId>,
    pub kind: ExecutionKind,
    pub revision: u64,
    pub fencing_token: FencingToken,
    pub scope: ExecutionScope,
    pub objective: ObjectiveRef,
    pub input: serde_json::Value,
    pub policy: ExecutionPolicy,
    pub resources: Vec<ResourceRequirement>,
    pub budget: ExecutionBudget,
    pub checkpoint: Option<CheckpointRef>,
    pub wake: Option<WakeDelivery>,
}

pub enum ExecutionOutcome {
    Completed {
        output: serde_json::Value,
        continuation: Option<ContinuationRef>,
    },
    Suspended {
        wake: WakeCondition,
        checkpoint: CheckpointEnvelope,
    },
    Cancelled { reason: CancelReason },
    Failed { failure: ExecutionFailure },
}

pub enum WakeCondition {
    At(time::OffsetDateTime),
    Signal { kind: String, correlation_id: String },
    Resource { class: ResourceClass },
    ModelAvailable { role: String },
    User { wait: UserWaitRef },
    Approval { approval: ApprovalRef },
    EffectResolution { receipt: EffectReceiptRef },
}

pub struct ExecutionFailure {
    pub class: FailureClass,
    pub code: String,
    pub redacted_detail: String,
}

pub enum FailureClass {
    Transient,
    Permanent,
    PolicyDenied,
}
```

These four outcomes are the only lifecycle variants. `Parked` is represented as a
suspension on `ModelAvailable`; HITL, approval, uncertain effects, `WaitingTime`,
`WaitingExternalEvent`, and `WaitingResource` are projections of
`WakeCondition`, not separate producer contracts. Protocol references are neutral:
domain payloads such as a HITL envelope, browser draft, or connector request remain
owned by their adapter and are resolved through scoped references.

## Extension model

An extension registers an `ExecutionKind` and an adapter returning the same
canonical outcome. The registry is internal to the runtime. Callers never resolve
or call adapters directly.

```rust
pub trait ExecutionAdapter {
    fn execute<'a>(
        &'a mut self,
        contract: &'a ExecutionContract,
        context: &'a ExecutionContext,
    ) -> futures::future::BoxFuture<'a, ExecutionOutcome>;
}
```

The adapter may use browser, connector, sandbox, Vault, model, or filesystem
services. It cannot persist task/run/message status, mint custom wait states, or
resume itself. The runtime validates the returned outcome against the contract's
policy before committing it.

An agent turn is an execution kind. A tool action becomes a child execution using
the same protocol and `parent_execution_id` when it is effectful, suspendable,
remote, long-running, or must recover after a crash. Pure functions and bounded
internal reads remain inside the current execution slice; they do not create
durable task noise or a second lifecycle.

The runtime owns an event sink backed by the canonical journal. Adapters publish
progress through the supplied context; callers observe journal events by
`execution_id`. Streaming therefore does not introduce a second execution or
terminal API.

## Effect protocol

`ExecutionPolicy` contains the single authoritative `EffectClass` mapping. Tool
exposure, dispatch permission, receipt creation, sandbox selection, and audit all
consume that mapping. Name heuristics cannot independently determine whether a
receipt is required.

Every non-read effect follows:

```text
propose -> authorize -> claim receipt -> execute -> complete receipt
```

The receipt states are `Prepared`, `Started`, `Completed`, `Failed`, `Uncertain`,
and `Compensated`. An interrupted `Started` receipt yields
`ExecutionOutcome::Suspended` with `WakeCondition::EffectResolution`; the model
cannot silently retry it.

Browser, payment, Vault, sandbox, and connector policies remain domain owners.
They provide policy decisions and references to the protocol; they do not own the
global execution lifecycle.

## Durable journal and projection

The canonical journal records contract creation, revision/fence transitions,
checkpoints, effects, wake deliveries, and exactly one committed outcome per revision. The
runtime commits the outcome first, then projects it idempotently to:

- task status;
- agent-run status;
- assistant-message delivery;
- objective status;
- turn/UI events;
- HITL or approval records.

Projection failure does not change the committed outcome. It is retried from the
journal. This removes crash windows where visible text is delivered while task or
run remains active.

Outcome commit uses compare-and-swap on `(execution_id, revision, fencing_token)`.
A stale worker may append no outcome after its lease has been recovered or stolen,
even if its model, browser, or connector call returns later.

## Suspend and resume

All suspension uses `ExecutionOutcome::Suspended`. The scheduler owns wake-up:

- due `At` conditions are delivered automatically;
- matching signals are delivered by correlation ID and deduplicated;
- resources are delivered when capacity becomes available;
- model availability is delivered by the coordinator;
- user and approval resolutions are delivered from their existing scoped gates;
- uncertain effects resume only after typed verification or a user decision.

After a wake delivery, the scheduler calls `execute` again with the same
`execution_id`, incremented revision, checkpoint reference, and typed wake
delivery. Domain-specific `resume_*` entry points are not permitted.

HITL Free and approval Hold preserve their product distinction, but resolution
also produces a typed wake delivery and re-enters the same execution protocol.

Adapters report failures with `Transient`, `Permanent`, or `PolicyDenied` class.
Before commit, the runtime alone applies `ExecutionBudget` and retry policy: an
eligible transient failure is normalized to `Suspended` with an `At` wake;
otherwise it remains terminal `Failed`. Adapters cannot schedule their own retry.

## Checkpoint contract

Every checkpoint uses one envelope containing schema version, execution identity,
objective revision, producer kind, wake condition, effect receipts, payload
sensitivity, and optional secret references. Raw sensitive values are never stored
in the general SQLite payload. Browser encrypted drafts become one checkpoint
codec under this envelope rather than a separate lifecycle.

## History and long-running work

Long histories use `continue_as_new`: a completed execution atomically creates a
new linked execution with a compacted input/checkpoint and preserved objective,
scope, policy, resources and budget. The store rejects a child that changes those
invariants, starts above revision one, carries a wake, or conflicts with an existing
lineage. The adapter owns the compaction threshold because only it understands which
domain state can be discarded.

External multi-step workflows may register compensation recipes on completed
receipts. The store returns them in reverse effect order. Each compensation is a
child execution using the same protocol; a receipt becomes `Compensated` only after
that exact linked child has a committed successful outcome. The runtime does not
invent a generic undo for connector, browser, filesystem, payment or Vault effects.

The runtime does not attempt Temporal-style deterministic replay of model calls.
LLM and remote decisions are non-deterministic activities whose committed results,
checkpoints, and receipts are reused. Replay is limited to the canonical journal
and its idempotent projections; a resumed model starts from the committed
checkpoint and never regenerates an already committed effect decision.

## Migration and deletion order

1. Add characterization tests for every current terminal and wait path.
2. Add the canonical contract, outcome, wake, journal, and pure projection table.
3. Make the scheduler wake due timers and correlated signals.
4. Migrate `chat_turn` to the canonical adapter and remove terminal deduction.
5. Migrate generic tasks, automations, subagents, browser, computer, connectors,
   filesystem, and artifact actions.
6. Make effect policy and receipts consume the same `EffectClass`.
7. Move existing checkpoints under the common envelope.
8. Delete `TaskExecutionOutcome`, `ChatTurnRunBranch`, empty parked `done`, marker
   lifecycle persistence, specialized resume calls, production duplication of
   `TaskRuntime`, and unused status variants.
9. Add continue-as-new and compensation after the base protocol is proven.

The migration is incomplete while any production caller bypasses `execute` or any
producer persists lifecycle status directly.

## Verification

Contract tests must cover the same protocol for:

- a simple answer;
- a tool-free failure;
- Choice/Clarify resume;
- approval Hold;
- timer wake;
- external signal wake and duplicate delivery;
- resource wait;
- model park and restart recovery;
- browser checkpoint recovery;
- connector write and uncertain remote outcome;
- cancellation racing completion;
- a stale fencing token attempting a late outcome commit;
- transient failure normalized by the runtime rather than the adapter;
- projection failure followed by replay;
- continue-as-new lineage and compensation.

Security regression must cover Vault non-disclosure, payment one-use approval,
browser action floors, connector capability policy, sandbox policy, checkpoint
redaction, and receipt scope. Completion requires warning-free Rust and desktop
builds, the full test suites, and a real development-app smoke.
