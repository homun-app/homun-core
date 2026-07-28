# Unified Execution Protocol Design

**Date:** 2026-07-28

**Status:** Approved for implementation

## Purpose

Homun must expose one execution protocol for every kind of work. Chat turns,
automations, browser operations, host-computer work, connectors, subagents,
filesystem operations, artifacts, timers, and resumed work must not have distinct
lifecycle APIs.

The conceptual public entry point is always:

```rust
execute(contract) -> ExecutionOutcome
```

Domain implementations may extend the contract payload and implement domain
behavior. They may not define new status values, terminal rules, wait mechanisms,
resume APIs, receipt semantics, or projection paths.

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
    User { wait: HitlEnvelope },
    Approval { approval: ApprovalRef },
    EffectResolution { receipt: EffectReceiptRef },
}
```

These four outcomes are the only lifecycle variants. `Parked` is represented as a
suspension on `ModelAvailable`; HITL, approval, uncertain effects, `WaitingTime`,
`WaitingExternalEvent`, and `WaitingResource` are projections of
`WakeCondition`, not separate producer contracts.

## Extension model

An extension registers an `ExecutionKind` and an adapter returning the same
canonical outcome. The registry is internal to the runtime. Callers never resolve
or call adapters directly.

```rust
pub trait ExecutionAdapter {
    fn execute(
        &mut self,
        contract: &ExecutionContract,
        context: &ExecutionContext,
    ) -> ExecutionOutcome;
}
```

The adapter may use browser, connector, sandbox, Vault, model, or filesystem
services. It cannot persist task/run/message status, mint custom wait states, or
resume itself. The runtime validates the returned outcome against the contract's
policy before committing it.

An agent turn is an execution kind. Each consequential tool action is a child
execution using the same protocol and `parent_execution_id`; it is not dispatched
through an unrelated tool lifecycle.

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

The canonical journal records contract creation, lease claims, checkpoints,
effects, wake deliveries, and exactly one committed outcome per revision. The
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

## Checkpoint contract

Every checkpoint uses one envelope containing schema version, execution identity,
objective revision, producer kind, wake condition, effect receipts, payload
sensitivity, and optional secret references. Raw sensitive values are never stored
in the general SQLite payload. Browser encrypted drafts become one checkpoint
codec under this envelope rather than a separate lifecycle.

## History and long-running work

Long histories use `continue_as_new`: a completed execution revision creates a
new linked execution with a compacted checkpoint and preserved objective lineage.
External multi-step workflows may register compensations on completed receipts;
compensations run in reverse order through the same execution protocol.

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
- projection failure followed by replay;
- continue-as-new lineage and compensation.

Security regression must cover Vault non-disclosure, payment one-use approval,
browser action floors, connector capability policy, sandbox policy, checkpoint
redaction, and receipt scope. Completion requires warning-free Rust and desktop
builds, the full test suites, and a real development-app smoke.
