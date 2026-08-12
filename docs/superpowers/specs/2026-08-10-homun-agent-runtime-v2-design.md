# Homun Agent Runtime v2 Design

Date: 2026-08-10
Status: Baseline for implementation planning
Scope: architectural refactor direction for the agent runtime. This is not an implementation plan and not a rewrite mandate.

## Objective

Homun has accumulated valuable pieces: local-first persistence, desktop UI, browser automation, memory, task runtime, execution contracts, approvals, sandboxing, and projection work. The instability is not caused by a lack of features. It comes from too many layers owning overlapping truths about a turn: engine, task runtime, execution projection, chat store, stream recovery, UI state, browser runtime, and plan heuristics can each make local claims about progress or terminality.

This design defines a smaller base model aligned with how successful coding agents are structured:

```text
User input
  -> AgentProfile
  -> one TurnKernel loop
  -> Action requested by model
  -> Runtime executes action
  -> Observation appended
  -> loop continues
  -> one terminal event
  -> projections derive UI/read models
```

The refactor goal is not to replace Homun. It is to keep the useful subsystems and move them behind one canonical turn/event model so extensions cannot invent conflicting state.

## State of the Art

These are reference patterns, not products to clone.

### OpenCode

Reference: <https://opencode.ai/docs/agents/> and <https://github.com/anomalyco/opencode>.

OpenCode separates agent identity from the runtime loop. Built-in agents include:

- `build`: full-access primary agent for development work.
- `plan`: read-only primary agent for exploration/planning.
- subagents such as `general`, invoked for specialized work.

The useful lesson for Homun is that `plan`, `build`, browser, review, and recovery should be agent profiles or subagents with different permissions and prompts, not different engines with separate lifecycle truths.

### OpenHands

Reference: <https://docs.openhands.dev/sdk/arch/events>.

OpenHands documents a typed event architecture where events are immutable, append-only, and drive both execution and state management. It distinguishes:

- events convertible to LLM messages, such as user/assistant messages, actions, and observations;
- internal events, such as state updates, condensation, pause, and conversation-level errors;
- tool-level errors, which the model can observe and recover from;
- conversation-level errors, which transition the run to an error state and must be surfaced to clients.

The useful lesson for Homun is that `source` and LLM `role` are different concepts. A synthetic nudge may be represented as a user message to the model, but it is not a real user action. A tool error may be LLM-visible, but it is not necessarily a terminal conversation failure.

### Aider

Reference: <https://aider.chat/docs/repomap.html>.

Aider is simpler, but its context discipline is important. It builds a repository map of files, symbols, and relationships, then gives the model the relevant map instead of relying on broad ad hoc exploration.

The useful lesson for Homun is that investigation should start from structured project context and canonical state, not from the last failing commit or the last visible symptom.

### Goose

Reference: <https://goose-docs.ai/>.

Goose exposes CLI, desktop, and API surfaces over an extensible agent with MCP extensions, permissions, sandboxing, recipes, and subagents.

The useful lesson for Homun is that desktop UX, CLI/API embedding, MCP tools, memory, and subagents can all sit around one runtime model. They should not each define their own completion/progress semantics.

## Diagnosis

The current Homun direction already contains pieces of the right architecture:

- `crates/engine` has the extracted guarded loop.
- `crates/task-runtime` stores tasks, events, runs, leases, and lifecycle state.
- `crates/desktop-gateway/src/execution_projection.rs` projects execution outcomes.
- `runtimes/browser-automation` isolates browser operation.
- `apps/desktop/src/lib/chat-runtime` contains pure UI state-machine logic.
- `docs/testing/kernel-contract-matrix.md` and `scripts/kernel_regression_gate.py` already express the desire for kernel-level contracts.

The architectural gap is that these pieces are not arranged around one object model. They still overlap:

- Plan state can be markdown, structured JSON, event payload, UI projection, or heuristic delivery reconciliation.
- Terminality can be task status, execution outcome, turn event, agent run status, message delivery state, stream status, or local UI state.
- Browser can behave like a tool, delegated subagent, sidecar session, UI surface, and HITL source.
- Failure can be a task `blocked_reason`, terminal event, empty assistant message, transport error, projection retry, or UI-only status.

This explains the recurring pattern: a local patch fixes one path, but another owner still has enough logic to re-create the old contradiction.

## Design Principles

### One Kernel

There is exactly one canonical loop type for a turn. Agents, tools, browser, memory, approvals, and recovery customize inputs and capabilities; they do not fork the loop semantics.

### Append-Only Truth

The canonical truth is a typed event log plus current reducer state derived from it. Tables such as task status, chat messages, UI projections, and working ledgers are read models, caches, or external integration state.

### Explicit Object Ownership

Every object has one owner. Consumers can project it, but cannot redefine it.

### Profiles, Not Engines

`plan`, `build`, `browser`, `review`, and `recovery` are `AgentProfile`s with permissions, budgets, prompts, and toolsets. They are not separate engines.

### Projections Cannot Decide

Projection code may map canonical state to UI/message/task read models. It may not decide whether a turn is complete, failed, waiting, or still working.

### Memory Is Out of Path

Memory observes events and supplies context. It must not decide progress, terminality, or approval state.

### Browser Is a Capability or Subagent

Browser work returns a typed `BrowserResult`. The browser runtime does not decide the parent turn terminal state.

## Core Objects

### TurnKernel

Owner: `crates/engine` after convergence.

Responsibility:

- run one bounded agent loop;
- call model with the current LLM-visible event projection;
- request actions;
- accept observations;
- update reducer state;
- emit terminal state exactly once.

Non-responsibility:

- writing desktop chat rows;
- sending channel messages;
- deciding UI layout;
- directly owning browser session internals;
- directly owning long-term memory writes.

### AgentProfile

Owner: new runtime configuration layer.

Fields:

- `id`: stable profile id, for example `build`, `plan`, `browser`, `review`, `recovery`;
- `mode`: `primary` or `subagent`;
- `model_policy`: provider/model preferences and fallback rules;
- `prompt_contract`: system/developer instructions for the profile;
- `tool_permissions`: allow/ask/deny policy by tool class;
- `budgets`: max rounds, max wall time, max tool calls, max repeated no-progress cycles;
- `output_contract`: required terminal shape.

Design rule:

Changing from `plan` to `build` changes permissions and prompts, not the kernel.

### TurnEvent

Owner: `crates/task-runtime` schema plus generated types.

Canonical event families:

```text
TurnStarted
ModelRequested
ModelResponded
ActionRequested
ActionStarted
ActionObserved
PlanDeclared
PlanStepStarted
PlanStepCompleted
PlanStepBlocked
UserWaitStarted
UserWaitResolved
ApprovalRequested
ApprovalResolved
MemoryContextAttached
ContextCondensed
SubagentStarted
SubagentCompleted
TurnCompleted
TurnFailed
TurnCancelled
TurnPaused
```

Design rule:

Every event has:

- `event_id`
- `turn_id`
- `revision`
- `seq`
- `source`: `user`, `agent`, `runtime`, `environment`, `projection`
- `visibility`: `llm`, `ui`, `internal`, or a combination
- typed payload
- created timestamp

### TurnState

Owner: reducer over `TurnEvent`.

Shape:

```text
Queued | Running | WaitingUser | WaitingApproval | Paused |
Completed | Failed | Cancelled
```

Design rule:

Only the reducer can derive this state. UI, projection, agent runs, and message delivery state consume it.

### PlanState

Owner: reducer over plan events.

Shape:

```text
Plan {
  goal: string
  steps: [
    {
      id,
      title,
      status: todo | doing | done | blocked,
      owner: agent | browser | user | runtime,
      evidence_refs: [],
      blocked_reason?
    }
  ]
}
```

Design rule:

Markdown plan cards are projections. They are not the source of plan state.

### Action

Owner: `TurnKernel` action dispatcher plus capability registry.

Canonical action kinds:

- `ShellCommand`
- `FileRead`
- `FileWrite`
- `PatchApply`
- `BrowserTask`
- `BrowserAction`
- `McpCall`
- `MemoryQuery`
- `MemoryWriteCandidate`
- `SubagentInvoke`
- `ApprovalRequest`

Design rule:

Every action has an observation. Tool errors are observations unless the kernel classifies them as terminal runtime failures.

### Observation

Owner: runtime/capability that executed the action.

Shape:

```text
Observation {
  action_id,
  status: ok | failed | interrupted | denied | partial,
  summary,
  data_ref?,
  error_code?,
  error_detail?,
  evidence_refs: []
}
```

Design rule:

Observation text shown to the model is separate from structured observation state shown to reducers/projections.

### BrowserResult

Owner: browser capability/subagent.

Shape:

```text
BrowserResult {
  status: found | partial | needs_user | failed | no_result,
  answer?,
  items: [],
  sources: [],
  evidence_refs: [],
  missing_fields: [],
  failure_code?,
  failure_detail?
}
```

Design rule:

Browser returns evidence. The parent TurnKernel decides whether to continue, ask the user, or complete.

### Projection

Owner: gateway/UI read-model layer.

Projection targets:

- chat transcript;
- task queue;
- active turn status;
- plan card;
- activity stream;
- browser/workspace panels;
- channel delivery;
- working ledger.

Design rule:

Projection is allowed to fail and retry. It is not allowed to change canonical turn state.

## What We Keep

These subsystems are valuable and should be reused:

- `crates/engine`: keep the extracted loop, but reduce policy and side-effect ownership inside it.
- `crates/task-runtime`: keep durable task/event/run storage, but promote typed event/reducer authority.
- `execution_projection`: keep projection machinery, but make it a pure read-model writer plus outbox dispatcher.
- `runtimes/browser-automation`: keep browser runtime, but expose it through typed browser result contracts.
- `apps/desktop`: keep the app and existing components, but make UI consume a turn view model instead of recomputing lifecycle.
- memory crates: keep out-of-path memory, but define exactly which events it observes and which context events it may contribute.
- approval/effect receipt concepts: keep them, but express them as canonical action/observation/user-wait events.
- existing gates: keep kernel/pre-release/gateway gates, but change them to assert systemic invariants instead of patch-specific symptoms.

## What We Stop Doing

- Do not encode canonical plan progress in markdown.
- Do not let the UI infer active work from local stream state after a terminal turn event exists.
- Do not let `chat_messages.delivery_state` substitute for turn lifecycle.
- Do not let browser sidecars decide parent turn completion.
- Do not let memory writes or recall mutate turn terminality.
- Do not treat synthetic model nudges as real user messages.
- Do not patch one projection without adding a reducer invariant that explains the canonical state.
- Do not add another owner for task progress.

## Removal Discipline

Every migration slice must remove or disable legacy ownership as part of the
same slice, or explicitly create the next slice with the legacy path named as
the first removal target. A slice is not complete when the new path works. It is
complete when the old path can no longer make the same decision.

Required section in every implementation plan:

```text
Kill List
- Legacy code removed:
- Feature flags removed or expired:
- Compatibility fallbacks removed:
- Old tests updated or deleted:
- Old owner made unable to decide:
- Historical-data compatibility retained:
- Retained compatibility expiry/removal trigger:
```

Rules:

- New owner plus old active owner is a regression risk, not a migration state.
- Compatibility for historical rows is allowed only as read-time translation
  with a test fixture and a removal condition.
- Feature flags must have an owner, default, expiry condition, and test proving
  the old path is unreachable when the flag is removed.
- Fallbacks must be classified as `historical-data`, `provider-degraded`,
  `migration-temporary`, or `safety-fail-closed`. Unclassified fallback code is
  not allowed.
- If a contract moves to a reducer, projections and UI code must lose the
  ability to recompute that contract locally.
- If a test asserts an old owner, update the test to assert delegation to the
  new owner or delete it in the same slice.

Release rule:

> The first release candidate must contain fewer owners for turn truth than the
> branch started with. A green gate that only adds guards without deleting a
> stale owner is not enough.

## Migration Strategy

This is a strangling refactor. No total rewrite.

### Phase 0: Freeze the Current Contradictions

Create an audit command that reads one turn and reports contradictions across:

- `tasks`
- `agent_runs`
- `turn_events`
- `execution_projection_outbox`
- `chat_messages`
- runtime plan state
- UI replay projection if available

The command should fail if, for example:

- task is terminal but UI projection says thinking;
- terminal event exists with empty user-visible failure text;
- plan is runnable but no-progress activity repeats beyond budget;
- message is failed with empty text while task has a blocked reason;
- agent run remains running after terminal task.

Removal target:

- no runtime behavior is moved in this phase, but the audit must name the owner
  that should lose authority for every contradiction it reports.

### Phase 1: Typed Event Vocabulary

Introduce typed Rust event structs for the canonical turn event families while continuing to persist compatible JSON payloads. Add conversion tests from old events to typed events where legacy rows exist.

Acceptance:

- one reducer can classify a turn as active/waiting/terminal from events;
- existing task status projection agrees with reducer for current fixtures.

Removal target:

- remove ad hoc JSON shape checks from any new code path that can consume typed
  event helpers instead.

### Phase 2: TurnState Reducer as Authority

Move lifecycle classification into a single reducer API:

```text
reduce_turn(events) -> TurnStateSnapshot
```

All gateway/UI lifecycle decisions must consume the snapshot or a read model generated from it.

Acceptance:

- no duplicated terminal-status sets outside the reducer and tests;
- terminal state clears active UI state in recovery/replay;
- cancellation, failure, wait, resume, and completion scenarios pass from the same fixture format.

Removal target:

- delete duplicated terminal-state sets from gateway/UI code or replace them
  with reducer calls/read-model fields in the same slice.

### Phase 3: PlanState Reducer

Convert plan updates into structured plan events and render markdown plan cards from `PlanState`.

Acceptance:

- plan card is a projection;
- progress cannot advance without event evidence;
- open runnable steps cannot coexist with `TurnCompleted`;
- waiting-user steps are represented as `blocked` or `WaitingUser`, not fake progress.

Removal target:

- remove markdown/marker parsing as a plan authority. Markdown may remain only
  as a rendered projection.

### Phase 4: AgentProfile Layer

Introduce explicit profiles:

- `plan`: read-only, no file edits, shell ask/deny;
- `build`: full development tools under sandbox/approval policy;
- `browser`: browser tools only plus read-only summarization;
- `review`: read-only code inspection and test suggestions;
- `recovery`: diagnostic tools and read-model audit, no writes by default.

Acceptance:

- changing profile changes permissions/toolset/prompt, not loop implementation;
- all profiles use the same TurnKernel.

Removal target:

- remove mode-specific routing branches that implement a second loop or bypass
  the common action/observation path.

### Phase 5: Browser as Typed Capability/Subagent

Wrap browser automation behind `BrowserTask -> BrowserResult`.

Acceptance:

- parent turn gets `found`, `partial`, `needs_user`, `failed`, or `no_result`;
- browser uncertainty becomes `needs_user` or `failed`, not silent UI limbo;
- browser result delivery is tested without launching the desktop UI.

Removal target:

- remove parent-turn completion decisions from browser sidecar/session code.
  Browser code may produce `BrowserResult`; it may not complete the parent turn.

### Phase 6: Projection Purification

Make projections read-model writers:

- chat message projection;
- task queue projection;
- activity projection;
- plan card projection;
- channel delivery outbox.

Acceptance:

- projection retries cannot change canonical terminal state;
- external sends happen via outbox/effect receipt, not inline projection side effects;
- projection errors are visible as projection failures, not confused with model failure.

Removal target:

- remove inline external send side effects from projection paths once the outbox
  path exists and has an effect-receipt test.

### Phase 7: Desktop UI Becomes a View-Model Consumer

Move UI lifecycle decisions to pure functions:

```text
TurnStateSnapshot + MessageProjection + PlanProjection -> ChatTurnViewModel
```

Acceptance:

- UI has no independent terminality logic;
- stream recovery cannot resurrect a terminal turn;
- progress, goal, waiting, failed, and active activity all derive from one snapshot.

Removal target:

- remove local UI lifecycle recomputation after the view model exposes the same
  field. Local optimistic state may exist only before the first canonical event.

## Required End-to-End Scenarios

These scenarios become permanent fixtures. They test the goal, not the last bug.

### Scenario 1: Build App Complex

Prompt: create a small React + TypeScript app with CRUD, filters, localStorage, tests, and build.

Expected:

- `AgentProfile=build`;
- plan declared as structured state;
- file actions produce observations;
- tests/build observations are linked as evidence;
- turn completes only after all runnable plan steps are done;
- UI shows completed plan and final summary.

### Scenario 2: Plan Read-Only

Prompt: analyze a code change and propose a plan without editing.

Expected:

- `AgentProfile=plan`;
- file writes denied before execution;
- shell requires ask/deny according to profile;
- output is a plan/review, not an attempted implementation;
- no filesystem mutations.

### Scenario 3: Browser Train Search

Prompt: find a train from Milan to Rome on a given date/time.

Expected:

- browser runs as typed capability/subagent;
- result is `found`, `partial`, `needs_user`, or `failed`;
- a `found`/`partial` result is delivered once;
- uncertainty is visible to user;
- parent turn does not remain thinking after browser terminal result.

### Scenario 4: Open Plan Stall

Prompt: complex task where model repeatedly says it will continue but does not execute useful actions.

Expected:

- repeated non-progress is measured by reducer/budget;
- turn fails or asks user within bounded rounds;
- failure text is visible;
- plan remains open with blocked reason;
- no empty assistant bubble.

### Scenario 5: Failure Visibility

Prompt: force a runtime/tool/model failure.

Expected:

- canonical `TurnFailed` has code/detail;
- task status, agent run, terminal event, and assistant message agree;
- UI shows failure reason;
- recovery/audit command identifies no contradiction.

### Scenario 6: User Wait and Resume

Prompt: task requiring user choice or approval.

Expected:

- `WaitingUser` or `WaitingApproval` is canonical;
- UI shows the card/reply affordance;
- model work indicator stops;
- resume creates a successor event/revision;
- final completion does not duplicate assistant messages.

### Scenario 7: Crash/Restart Recovery

Prompt: interrupt during active work and restart.

Expected:

- active turn is recovered, failed, or parked by canonical recovery rules;
- no stale `agent_runs.running` after terminal task;
- UI projection agrees after reload;
- no projection retry loop hides terminality.

## First Deliverable

The first implementation deliverable should be an audit and fixture layer, not a runtime rewrite.

Deliver:

```text
scripts/audit_turn_consistency.py
crates/task-runtime/src/turn_reducer.rs
crates/task-runtime/tests/turn_reducer_contract.rs
docs/testing/agent-runtime-v2-scenarios.md
```

The audit command should accept a `turn_id` and produce:

- canonical reducer state;
- projected task state;
- projected agent run state;
- projected message state;
- plan state;
- contradictions;
- suggested owning layer.

This gives us a system-level truth checker before moving code.

## First Release Path

The refactor must converge toward a first release, not become an open-ended
architecture program. The release path is deliberately smaller than the full v2
architecture.

Release candidate entry criteria:

- `scripts/audit_turn_consistency.py` exists and is part of the kernel/pre-release
  gate for fixed fixtures.
- Failure visibility scenario passes: no terminal failed turn can produce an
  empty assistant bubble when a canonical reason exists.
- UI liveness scenario passes: a terminal turn cannot render as thinking,
  waiting-for-model, or active work after replay.
- Browser train-search scenario has a typed result boundary: `found`, `partial`,
  `needs_user`, `failed`, or `no_result`.
- Build-app complex scenario has at least a non-browser fixture proving a
  runnable open plan cannot complete as `Done`.
- Every merged runtime slice since this RFC has a Kill List entry in its plan or
  commit notes.
- Existing release gates remain green: pre-release gate, kernel regression gate,
  gateway ownership contract, desktop build, and focused scenario tests.

Release candidate exclusions:

- Full historical-row migration is not required if read-time compatibility is
  tested and classified.
- Complete browser UX redesign is not required.
- Complete extraction of large files such as `main.rs` or `ChatView.tsx` is not
  required unless they still own turn truth after the reducer/view-model slices.
- Memory graph expansion is not required; memory must only stay out of the
  terminal/progress path.

Release stop conditions:

- any second owner can still mark a turn terminal without the reducer;
- any projection can turn a failed/completed/cancelled turn back into active UI;
- browser can leave the parent turn without a typed terminal browser result;
- a new v2 path is added while the old equivalent owner remains active and
  untracked.

## Change Control

This document is the working baseline for the runtime v2 refactor. It should
not change in response to individual bugs. Change it only when one of these is
true:

- a reference implementation or current Homun code proves that a core object is
  wrong;
- an implementation slice cannot satisfy its Kill List without violating an
  existing Homun caposaldo;
- release evidence proves that a listed release criterion is insufficient or
  impossible as written;
- the user explicitly asks to revise the architecture baseline.

Every future change to this document must include:

- the reason for changing the baseline;
- the old invariant being replaced;
- the new invariant;
- the release impact.

## Non Goals

- No total rewrite.
- No replacement of Electron/React.
- No removal of memory, browser, approvals, sidecars, or task runtime.
- No model-provider redesign in this RFC.
- No immediate migration of historical persisted rows unless a read-time compatibility layer cannot preserve correctness.
- No broad file reshuffle before the reducer/audit contract exists.

## Adopted Working Invariant

Homun adopts this invariant for runtime v2 planning:

> One TurnKernel, one typed event log, one reducer authority. Agents and capabilities extend behavior; projections and UI derive read models; no other layer owns turn truth.
