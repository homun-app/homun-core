# Kernel V2 Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Homun's turn, plan, browser, effect-receipt, and UI-liveness state converge through one canonical reducer contract before the first release.

**Architecture:** Keep ADR 0021/0025/0026: one guarded loop, browser as delegated capability, plan as tool. Add a narrow task-runtime reducer boundary that turns persisted `turn_events`, `runtime_plans`, effect receipts, and run terminal state into one projection consumed by gateway and desktop.

**Tech Stack:** Rust workspace (`crates/engine`, `crates/task-runtime`, `crates/desktop-gateway`), Electron/React pure `.mjs` projection tests, SQLite-backed task runtime.

---

## File Structure

- Modify: `docs/architecture/kernel-v2-contract.md`
  - Living contract for owner boundaries and accepted kernel event classes.
- Modify: `crates/task-runtime/src/turn_reducer.rs`
  - Pure reducer for durable turn projection.
- Modify: `crates/task-runtime/src/store.rs`
  - Use reducer when deriving thread activity/plan projection from persisted rows.
- Modify: `crates/task-runtime/src/types.rs`
  - Keep public DTOs stable. Do not add new exported structs in the first slice.
- Modify: `crates/desktop-gateway/src/gateway_turn_broker.rs`
  - Keep event emission shape stable; add tests only if reducer reveals a mismatch.
- Modify: `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.mjs`
  - Keep frontend as projection-only; do not invent canonical plan/effect state here.
- Modify: `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.test.mjs`
  - Preserve active plan on stream resume, hide read receipts, and reject stale turn plans.
- Modify: `docs/testing/kernel-contract-matrix.md`
  - Add the Kernel V2 reducer row once the first reducer test is green.

## Task 1: RED Reducer Fixture For Plan + Read Receipt + Terminal Turn

**Files:**
- Modify: `crates/task-runtime/src/turn_reducer.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Add a failing test in `turn_reducer.rs`**

Add a test named `read_receipts_do_not_block_projected_plan_or_terminal_turn`. It must build a small in-memory fixture with:

```rust
use local_first_execution_protocol::{EffectClass, EffectReceiptStatus};

let plan = RuntimePlanRecord {
    user_id: "u1".into(),
    workspace_id: "w1".into(),
    thread_id: "thread-a".into(),
    status: "open".into(),
    plan_json: serde_json::json!({
        "goal": "trova un treno",
        "steps": [
            {"id": "s1", "title": "Cerca risultati", "status": "done"},
            {"id": "s2", "title": "Leggi risultati", "status": "doing"}
        ]
    }),
    objective_revision: 0,
    revision: 1,
    stall_turns: 0,
    last_resume_done: Some(1),
    created_at: 1,
    updated_at: 2,
};
let events = vec![
    TurnEvent {
        event_id: 1,
        turn_id: "turn-a".into(),
        seq: 1,
        kind: TurnEventKind::PlanUpdate,
        payload: plan.plan_json.clone(),
        created_at: 1,
    },
    TurnEvent {
        event_id: 2,
        turn_id: "turn-a".into(),
        seq: 2,
        kind: TurnEventKind::Done,
        payload: serde_json::json!({"text": "risultati letti"}),
        created_at: 2,
    },
];
let effects = vec![KernelEffectProjection {
    effect_class: EffectClass::Read,
    status: EffectReceiptStatus::Uncertain,
}];
let projection = reduce_kernel_projection(KernelProjectionInput {
    turn_events: &events,
    runtime_plan: Some(&plan),
    uncertain_effects: &effects,
    terminal_reason: Some("canonical_completed"),
});
assert_eq!(projection.turn.status, ReducedTurnStatus::Completed);
assert_eq!(projection.active_plan.as_ref().unwrap().goal.as_deref(), Some("trova un treno"));
assert_eq!(projection.requires_user_effect_resolution, false);
assert!(projection.turn.is_terminal);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
cargo test -p local-first-task-runtime read_receipts_do_not_block_projected_plan_or_terminal_turn -- --nocapture
```

Expected: FAIL because `KernelEffectProjection`, `KernelProjectionInput`, and `reduce_kernel_projection` do not exist yet.

- [ ] **Step 3: Implement the smallest reducer surface**

Extend the existing reducer instead of replacing `reduce_turn_events`. Add these pure projection types below `TurnStateSnapshot`:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelEffectProjection {
    pub effect_class: local_first_execution_protocol::EffectClass,
    pub status: local_first_execution_protocol::EffectReceiptStatus,
}

pub struct KernelProjectionInput<'a> {
    pub turn_events: &'a [TurnEvent],
    pub runtime_plan: Option<&'a crate::RuntimePlanRecord>,
    pub uncertain_effects: &'a [KernelEffectProjection],
    pub terminal_reason: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelActivePlanProjection {
    pub goal: Option<String>,
    pub plan_json: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KernelTurnProjection {
    pub turn: TurnStateSnapshot,
    pub active_plan: Option<KernelActivePlanProjection>,
    pub requires_user_effect_resolution: bool,
    pub terminal_reason: Option<String>,
}
```

Then add `reduce_kernel_projection(input: KernelProjectionInput<'_>) -> KernelTurnProjection`. It must call `reduce_turn_events(input.turn_events)`, copy the runtime plan when its `status` is `open`, and set `requires_user_effect_resolution` only for uncertain `EffectClass::ExternalWrite` receipts.

- [ ] **Step 4: Run focused reducer test**

Run:

```bash
cargo test -p local-first-task-runtime read_receipts_do_not_block_projected_plan_or_terminal_turn -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/task-runtime/src/turn_reducer.rs
git commit -m "test(runtime): define kernel projection reducer contract"
```

## Task 2: Store Uses Reducer For Thread Activity Projection

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/turn_reducer.rs`

- [ ] **Step 1: Add a store-level failing test**

Add or update a test near the existing `runtime_plans` / `step_advance` tests in `store.rs`. The test must insert:

- a `runtime_plans` row with `s2=doing`;
- a latest turn event for the same turn;
- an `execution_effect_receipts` row with `effect_class='read'` and `status='uncertain'`;
- a terminal agent run with `terminal_reason='canonical_completed'`.

Assert that the projected thread activity keeps the active plan but does not produce user effect resolution.

- [ ] **Step 2: Run failing test**

```bash
cargo test -p local-first-task-runtime read_receipts_do_not_block_thread_activity_projection -- --nocapture
```

Expected: FAIL before `store.rs` delegates projection to the reducer.

- [ ] **Step 3: Route store projection through the reducer**

In the store method that derives latest thread activity from `runtime_plans` and `turn_events`, build reducer input rows and call the reducer. Preserve existing SQL shape and public DTOs.

- [ ] **Step 4: Run task-runtime focused tests**

```bash
cargo test -p local-first-task-runtime runtime_plans -- --nocapture
cargo test -p local-first-task-runtime step_advance -- --nocapture
cargo test -p local-first-task-runtime read_receipts_do_not_block_thread_activity_projection -- --nocapture
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/task-runtime/src/store.rs crates/task-runtime/src/turn_reducer.rs
git commit -m "fix(runtime): project thread activity through kernel reducer"
```

## Task 3: Desktop Projection Remains Projection-Only

**Files:**
- Modify: `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.mjs`
- Modify: `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.test.mjs`

- [ ] **Step 1: Add/keep a failing frontend fixture**

Add a test named `durable_kernel_projection_wins_over_stream_gap`. Fixture:

```js
const result = deriveConversationPlan({
  activeTurnId: "turn-a",
  streamOwnerTurnId: "turn-a",
  projectedPlan: {
    goal: "trova un treno",
    steps: [{ id: "s2", title: "Leggi risultati", status: "doing" }],
  },
  streamPlan: null,
});
assert.equal(result?.goal, "trova un treno");
```

Add the stale-turn companion assertion:

```js
const stale = deriveConversationPlan({
  activeTurnId: "turn-b",
  streamOwnerTurnId: "turn-a",
  projectedPlan: { goal: "old", steps: [{ id: "s1", title: "Old", status: "doing" }] },
  streamPlan: null,
});
assert.equal(stale, null);
```

- [ ] **Step 2: Run the paired Node test**

```bash
cd apps/desktop && node --test src/lib/chat-runtime/browserActivityLifecycle.test.mjs
```

Expected: PASS after the already-landed resume fix. A failure here means the frontend is still inventing or dropping projection state; fix only `browserActivityLifecycle.mjs`.

- [ ] **Step 3: Run desktop umbrella tests**

```bash
cd apps/desktop && npm test
```

Expected: PASS.

- [ ] **Step 4: Commit if any frontend change was required**

```bash
git add apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.mjs apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.test.mjs
git commit -m "test(desktop): lock kernel projection plan resume"
```

## Task 4: Kernel Contract Matrix Update

**Files:**
- Modify: `docs/testing/kernel-contract-matrix.md`
- Modify: `docs/testing/anti-regression-protocol.md`

- [ ] **Step 1: Add the reducer owner row**

Add a row to the matrix:

```markdown
| Kernel V2 reducer projection | `crates/task-runtime/src/turn_reducer.rs` | `turn_events`, `runtime_plans`, `execution_effect_receipts`, `agent_runs.terminal_reason` | desktop chat-runtime projection | `cargo test -p local-first-task-runtime turn_reducer`; `python3 scripts/kernel_regression_gate.py` |
```

- [ ] **Step 2: Update anti-regression protocol**

Add one sentence under "Regola":

```markdown
Per regressioni che combinano piano, liveness, browser o effect receipts, la prima fixture deve vivere nel reducer canonico `crates/task-runtime/src/turn_reducer.rs`; le fixture UI sono solo projection checks.
```

- [ ] **Step 3: Run documentation diff check**

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 4: Commit**

```bash
git add docs/testing/kernel-contract-matrix.md docs/testing/anti-regression-protocol.md
git commit -m "docs(testing): add kernel v2 reducer gate"
```

## Task 5: Full Gate And Live Browser Smoke

**Files:**
- No source changes unless a gate reveals a real owner-level bug.

- [ ] **Step 1: Run deterministic kernel gate**

```bash
python3 scripts/kernel_regression_gate.py
```

Expected: PASS.

- [ ] **Step 2: Run pre-release gate**

```bash
python3 scripts/pre_release_gate.py
```

Expected: PASS.

- [ ] **Step 3: Run live browser smoke from the target worktree**

Ensure Electron/gateway are running from this worktree, then run:

```bash
python3 scripts/kernel_live_smoke.py --timeout-seconds 240
```

Expected: PASS with final answer containing `Selenium`.

- [ ] **Step 4: Inspect diff**

```bash
git diff --stat
git status --short
```

Expected: only the reducer, focused tests, and docs changed.

- [ ] **Step 5: Final commit**

```bash
git add crates/task-runtime/src/turn_reducer.rs crates/task-runtime/src/store.rs docs/testing/kernel-contract-matrix.md docs/testing/anti-regression-protocol.md
git commit -m "fix(runtime): stabilize kernel projection reducer"
```

## Self-Review

- Spec coverage: covers plan disappearance, progress/liveness divergence, browser read receipts, and UI projection confusion.
- Placeholder scan: no deferred-work markers are present.
- Type consistency: `KernelEffectProjection`, `KernelProjectionInput`, `KernelTurnProjection`, and `reduce_kernel_projection` are the target names for the first slice; terminal status continues to use existing `ReducedTurnStatus` and `TurnStateSnapshot`.
