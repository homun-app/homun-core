# General Agent Loop Contract Design

**Date:** 2026-07-28

**Status:** Integrated into the unified execution journal; adapter-specific long-running policies remain explicit extension work.

## Purpose

Make the objective contract, HITL resume contract, effect policy, memory/Vault intent, and terminal projection agree across normal, resumed, recovered, and long-running turns. The implementation must be domain-neutral: no train, booking-site, or prompt-specific branches.

## Observed failure

The live test completed its browser workflow correctly, resumed the same warm browser session, stopped before confirmation/payment, and terminalized both broker tasks and agent runs. However, the persisted contract was internally inconsistent:

- `mode` was `read_only_analysis` while `allowed_effect_classes` included every write class;
- the HITL resume helper constructed `ValidatedSemanticDecision` directly and skipped `validate_decision`;
- an `agent_loop` resume also carried `selected_capability=browse`, which the normal validator rejects;
- `OpenWorkSnapshot` retained only browser liveness, URL, and a capability hint;
- the objective contract remained `active` after the final resumed delivery;
- the persisted objective summary omitted the post-choice work and safety boundary from the original request.

The browser payment gate prevented an unsafe final effect independently, so the visible result was safe. The general contract was not the reason it was safe and would not be sufficient after restart, context compaction, or a longer wait.

## Chosen approach

Extend the existing typed contracts without replacing the broker, task runtime, browser action lattice, or HITL envelope.

Rejected alternatives:

1. Fix only the hard-coded resume effects. This removes one contradiction but leaves resume state dependent on conversational prose and leaves objective lifecycle open.
2. Replace the loop with a new graph runtime. This duplicates the durable broker and expands risk across sandbox, Vault, connectors, browser, and UI.
3. Chosen: preserve current architecture and make every continuation consume the same validated contract and terminal projection.

## Contract model

### Objective contract

`ObjectiveContractRecord` remains the canonical per-thread objective. For a new or replacement objective, its `objective` field stores a bounded form of the complete user request rather than a lossy model summary. The structured semantic decision remains in `scope_json.semantic_decision` for routing and observability.

The effect policy is read from `allowed_actions_json`. `mode` is a high-level description and a compatibility fallback for legacy rows; it is not independently authoritative when a typed effect policy exists.

Normal and resumed decisions pass through `validate_decision`. A value named `ValidatedSemanticDecision` can no longer be created by the HITL resume path without validation.

### Effect enforcement

Effectful tools map to one typed effect class:

- project/user filesystem mutation -> `filesystem_write`;
- generated deliverables -> `artifact_creation`;
- connectors, messages, automations, schedules, and other outside-system mutation -> `external_write`.

Tool exposure and dispatch both consult the same effect policy. Missing or malformed policy fails closed to read plus authorization requests. Existing browser action classes remain the browser-specific second layer: ordinary/account/booking actions stay governed by user direction and the final payment continues to require a one-use payment approval.

### Resume binding

`OpenWorkSnapshot` gains a versioned, backward-compatible resume contract containing:

- objective revision and complete objective;
- objective mode;
- allowed and forbidden effect classes;
- memory intent, including Vault intent;
- completion contract;
- bounded remaining runtime-plan steps.

When a wait is opened, the gateway snapshots this data from the active objective and runtime plan. On resolution, the resume decision restores the exact policy and memory intent, sets `same_objective` plus `continue_current_work`, keeps `execution_shape=agent_loop`, clears `selected_capability`, and runs the normal validator. Browser/session hints remain in `OpenWork`, not in semantic routing.

Legacy waits without a resume contract use the active objective if available. If neither durable source exists, resume fails closed to the normal read-only fallback instead of granting all effects.

### Terminal lifecycle

Objective status is projected at the broker-owned terminal boundary:

- final delivered answer with no actionable user wait -> `completed`;
- cancellation -> `cancelled`;
- free/hold HITL wait, park, retryable failure, or missing final answer -> remains `active`.

The status update is revision-guarded so an old turn cannot close a newer replacement objective. Thread status may remain `active` because it describes the conversation, not running work.

## Data flow

```text
User request
  -> semantic decision -> validate_decision
  -> ObjectiveContract(full request + typed effects + memory intent)
  -> tool exposure/dispatch reads ObjectiveEffectPolicy
  -> TurnOutcome::AwaitingUser
  -> thread_hitl_waits(OpenWork + ResumeContract + remaining plan)
  -> UserResolution
  -> validated ResumeBinding(same objective, exact policy)
  -> terminal projection
  -> message + task + agent run + objective status
```

## Compatibility and safety

- Existing `open_work_json` rows deserialize through defaults.
- No secret values are added to `OpenWork`; Vault intent is metadata only.
- The payment approval gate remains unchanged and independent.
- Missing objective/effect metadata fails closed.
- No booking-domain parsing or keyword authorization is introduced.
- The runtime plan snapshot is bounded to known plan fields and a fixed number of steps.

## Verification

Automated tests must prove:

1. read-only resumes cannot acquire write effects;
2. mixed resumes retain exactly their prior effects and Vault/memory intent;
3. resume decisions pass the normal validator and have no selected capability conflict;
4. persisted waits round-trip the contract revision and remaining plan;
5. tool pruning and dispatch use the same allowed effect policy;
6. terminal delivery completes only the matching objective revision;
7. free/hold waits and parked turns leave the objective active;
8. legacy waits fail closed;
9. all workspace tests and builds remain clean;
10. a fresh development-app smoke reproduces search -> wait -> same-session resume -> safe stop -> completed objective.

## Completion boundary

This change completes the contract convergence discovered by the live test. It does not claim that every broader roadmap item is implemented. After the smoke, the implementation is audited against the prior security, sandbox, Vault, connector, long-running, stream ownership, and open-source comparison findings; any remaining item is reported explicitly rather than inferred from passing tests.

## Implementation audit (2026-07-29)

Implemented and verified:

- normal and resumed turns use the same validated objective/effect/memory contract;
- the complete user request is durable while the router summary remains metadata;
- invalid semantic JSON gets one bounded retry; non-security memory-choice metadata is normalized;
- browser form selection/fill is `external_write` while final payment keeps its independent one-use gate;
- every Free wait stores schema version, objective revision, exact effects, memory intent and bounded remaining plan;
- tool exposure, dynamic discovery and dispatch consume one `ObjectiveEffectPolicy`;
- every adapter returns the same `ExecutionOutcome`; channel and automation enter
  through the same broker/runtime path as interactive chat;
- user, approval, timer, signal, model and uncertain-effect wakes resume the same
  execution ID at a fenced new revision;
- resumed chat loads the exact checkpoint referenced by the prior journal revision;
- consequential effects share one durable receipt lifecycle, while sandbox, Vault,
  payment, browser and connector gates remain stricter domain policy layers;
- delivered/cancelled outcomes transition only the owned objective revision.

Live V5 evidence:

- objective revision 1 remained `mixed` with `read + external_write + request_authorization` through three Choice resumes;
- browser generation continued from 12 through 76 across those resumes;
- all waits were resolved and task/run projections terminalized at each wait boundary;
- cancelling the final failed browser attempt converged objective=`cancelled`, task=`cancelled`, run=`aborted`, message=`cancelled`.

Current bounded extension points:

- `continue-as-new` is atomic and validated in the store; each long-running adapter
  still owns its compaction threshold and child payload;
- compensation ordering and completion evidence are durable; each domain adapter
  still owns interpretation of its rollback recipe;
- task, run, message and objective remain separate read models intentionally. Their
  authority is removed, not their UI/storage utility: the journal projector rebuilds
  and reconciles them;
- old persisted `Parked` steering records remain recoverable through a migration
  bridge, but current execution code emits `Suspended(ModelAvailable)` instead.
