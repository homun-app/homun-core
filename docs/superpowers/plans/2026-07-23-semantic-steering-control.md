# Semantic Steering Control Implementation Plan

> **Execution:** Use superpowers:executing-plans to implement this plan task-by-task in the current session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make model-interpreted steering decisions durably control an active turn, including waiting for the semantic model, stopping further tools, and producing one terminal response.

**Architecture:** Extend the existing semantic decision schema with a structured steering disposition, persist its lifecycle in `turn_steering`, and add a live turn-control channel observed by the engine and gateway capability executor. A durable interpreter coordinator retries model-backed interpretation without lexical fallback. Runtime checkpoints preserve safe evidence across cooperative interruption, manual Stop, and restart recovery.

**Tech Stack:** Rust 2024, Tokio, SQLite/rusqlite, local-first engine/task-runtime crates, React 19, TypeScript, Node test runner.

---

## File map

- `crates/desktop-gateway/src/semantic_decision.rs`: semantic schema, validation, steering disposition.
- `crates/task-runtime/src/types.rs`: durable steering statuses and interpreted decision envelope.
- `crates/task-runtime/src/store.rs`: schema migration, guarded lifecycle transitions, retry/recovery queries.
- `crates/desktop-gateway/src/steering_control.rs`: interpreter coordinator and live structured-control registry.
- `crates/desktop-gateway/src/main.rs`: enqueue scheduling, coordinator startup, and API/event projection.
- `crates/desktop-gateway/src/model_client.rs`: consume interpreted steering rather than claiming raw text.
- `crates/engine/src/contract.rs`: engine-facing turn-control contract.
- `crates/engine/src/agent_loop.rs`: replan/finalize/cancel enforcement and no-more-tools fence.
- `crates/desktop-gateway/src/turn_executor.rs`: cooperative notification, checkpoint, recovery, and terminal acknowledgement.
- `apps/desktop/src/lib/chatApi.ts`: expanded steering API types.
- `apps/desktop/src/lib/chatSteeringState.ts`: lifecycle-to-label projection.
- `apps/desktop/src/components/PendingSteeringQueue.tsx`: accurate lifecycle rendering.
- `apps/desktop/src/i18n/locales/{en,it,de,es,fr}.json`: steering status copy.

### Task 1: Add the structured semantic disposition

**Files:**
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Test: `crates/desktop-gateway/src/semantic_decision.rs`

- [ ] **Step 1: Write failing schema and validation tests**

Add tests that deserialize a semantic decision containing:

```rust
"steering_disposition": "finalize_with_current_evidence"
```

and assert:

```rust
assert_eq!(
    validated.decision.steering_disposition,
    SteeringDisposition::FinalizeWithCurrentEvidence
);
```

Add a second test proving `provenance.fallback_reason = Some("model_unavailable")` fails `actionable_steering_decision(&validated)`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway semantic_decision::tests::steering -- --nocapture
```

Expected: compilation fails because `SteeringDisposition` and `steering_disposition` do not exist.

- [ ] **Step 3: Implement the semantic contract**

Add:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SteeringDisposition {
    ContinueCurrentWork,
    ReplanCurrentWork,
    FinalizeWithCurrentEvidence,
    CancelCurrentWork,
    NeedsClarification,
}
```

Add `steering_disposition` to `SemanticDecision`, its JSON schema, required keys, prompt guidance, safe defaults, and test fixtures. Implement:

```rust
pub(crate) fn actionable_steering_decision(
    decision: &ValidatedSemanticDecision,
) -> Option<SteeringDisposition> {
    decision.provenance.fallback_reason.is_none()
        .then_some(decision.decision.steering_disposition)
}
```

No text parser, regex, or keyword table is permitted.

- [ ] **Step 4: Run focused and gateway semantic tests**

Run:

```bash
cargo test -p local-first-desktop-gateway semantic_decision -- --nocapture
```

Expected: all semantic decision tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/semantic_decision.rs
git commit -m "feat(steering): add semantic control disposition"
```

### Task 2: Persist interpretation and application truthfully

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing lifecycle tests**

Add a test that appends a steering record and exercises this exact sequence:

```rust
let claimed = store.claim_pending_turn_steering(/* ... */)?.remove(0);
let interpreted = store.mark_turn_steering_interpreted(
    claimed.steering_id,
    claimed.revision,
    &decision_json,
    "agent_run_1",
)?;
let applied = store.mark_turn_steering_applied(
    interpreted.steering_id,
    interpreted.revision,
    "agent_run_1",
)?;
let completed = store.mark_turn_steering_completed(
    applied.steering_id,
    applied.revision,
    "agent_run_1",
)?;
assert_eq!(completed.status, TurnSteeringStatus::Completed);
```

Add tests that an interpretation failure returns the row to `Pending` with `next_retry_at`, and that stale revisions cannot transition.

- [ ] **Step 2: Run task-runtime tests and verify RED**

Run:

```bash
cargo test -p local-first-task-runtime turn_steering -- --nocapture
```

Expected: compilation fails on the new status and transition methods.

- [ ] **Step 3: Implement schema and guarded transitions**

Add `Interpreted` and `Completed` to `TurnSteeringStatus`. Add nullable columns through the existing additive migration mechanism:

```sql
semantic_decision_json TEXT,
interpreted_at INTEGER,
completed_at INTEGER,
last_interpretation_error TEXT,
next_retry_at INTEGER,
interpretation_attempts INTEGER NOT NULL DEFAULT 0
```

Extend `TurnSteeringRecord` with typed optional projections. Replace the batch `mark_turn_steering_applied(&[id], run_id)` with revision-guarded single-record transitions. Implement `release_turn_steering_for_retry` so failures never become applied.

- [ ] **Step 4: Run store and migration tests**

Run:

```bash
cargo test -p local-first-task-runtime turn_steering -- --nocapture
cargo test -p local-first-task-runtime store::tests -- --nocapture
```

Expected: all selected tests pass, including migration from an older table.

- [ ] **Step 5: Commit**

```bash
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs
git commit -m "feat(steering): persist semantic lifecycle"
```

### Task 3: Interpret steering asynchronously without lexical fallback

**Files:**
- Create: `crates/desktop-gateway/src/steering_control.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/model_client.rs`
- Test: `crates/desktop-gateway/src/steering_control.rs`

- [ ] **Step 1: Write failing coordinator tests**

Define an injectable interpreter seam:

```rust
pub(crate) trait SteeringInterpreter: Send + Sync {
    fn interpret(
        &self,
        input: SteeringInterpretationInput<'_>,
    ) -> Result<ValidatedSemanticDecision, SteeringInterpretationError>;
}
```

Test that valid model output transitions `pending → claimed → interpreted`, while model unavailability calls `release_turn_steering_for_retry` and leaves the record pending. The fake interpreter returns structured decisions directly; it must never receive or expose a keyword predicate.

- [ ] **Step 2: Run coordinator tests and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway steering_control::tests -- --nocapture
```

Expected: module and coordinator types are missing.

- [ ] **Step 3: Implement the durable coordinator**

Create `steering_control.rs` with:

```rust
pub(crate) struct SteeringControlCoordinator {
    state: AppState,
}

impl SteeringControlCoordinator {
    pub(crate) fn schedule(&self, steering_id: i64) { /* spawn durable attempt */ }
    pub(crate) fn recover_due(&self) { /* claim pending due rows */ }
}
```

The production interpreter calls `resolve_semantic_decision`, rejects every result whose provenance has `fallback_reason`, persists only validated structured output, and publishes `thread.steering_changed`. Retry metadata uses bounded exponential backoff. Enqueue returns `202` before interpretation completes, then schedules the coordinator. Startup calls `recover_due`.

Change `GatewayModelClient` so round-boundary consumption reads `Interpreted` rows and acknowledges them; it must not claim and mark raw pending text applied.

- [ ] **Step 4: Run focused gateway tests**

Run:

```bash
cargo test -p local-first-desktop-gateway steering_control -- --nocapture
cargo test -p local-first-desktop-gateway steering_messages -- --nocapture
```

Expected: coordinator and existing steering tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/steering_control.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/model_client.rs
git commit -m "feat(steering): interpret pending input durably"
```

### Task 4: Add a structured live turn-control channel

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/steering_control.rs`
- Test: `crates/engine/src/agent_loop.rs`
- Test: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 1: Write failing engine enforcement tests**

Add a fake control source returning:

```rust
TurnControlDecision::FinalizeWithCurrentEvidence {
    steering_id: 7,
    revision: 2,
    instruction: "use the current evidence".to_string(),
}
```

Assert the engine executes no later capability calls, invokes one tool-free synthesis round, emits one `Done`, and acknowledges steering ID 7 only after terminal delivery. Add a control case proving `ContinueCurrentWork` does not interrupt the active tool.

- [ ] **Step 2: Run engine tests and verify RED**

Run:

```bash
cargo test -p local-first-engine steering_control -- --nocapture
```

Expected: `TurnControlDecision` and the control source contract do not exist.

- [ ] **Step 3: Implement the engine contract**

Add to `contract.rs`:

```rust
pub enum TurnControlDecision {
    ContinueCurrentWork { steering_id: i64, revision: u64, instruction: String },
    ReplanCurrentWork { steering_id: i64, revision: u64, instruction: String },
    FinalizeWithCurrentEvidence { steering_id: i64, revision: u64, instruction: String },
    CancelCurrentWork { steering_id: i64, revision: u64, instruction: String },
    NeedsClarification { steering_id: i64, revision: u64, instruction: String },
}

pub trait TurnControlSource: Send + Sync {
    fn current(&self) -> Option<TurnControlDecision>;
    fn acknowledge_applied(&self, steering_id: i64, revision: u64);
    fn acknowledge_completed(&self, steering_id: i64, revision: u64);
}
```

At each capability and round boundary, `agent_loop` consumes the structured decision. Finalize sets a no-more-tools fence, appends the instruction as a user steering envelope, and forces synthesis with an empty tool list. Cancel emits one terminal acknowledgement without further tools. Replan retains completed plan steps and clears only open work.

Extend `TurnBroadcast` with a watch channel holding the current structured decision. The coordinator publishes interpreted decisions into it.

- [ ] **Step 4: Run engine and turn-executor tests**

Run:

```bash
cargo test -p local-first-engine steering_control -- --nocapture
cargo test -p local-first-desktop-gateway turn_executor::tests -- --nocapture
```

Expected: structured enforcement and idempotent acknowledgement tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/contract.rs crates/engine/src/agent_loop.rs crates/desktop-gateway/src/turn_executor.rs crates/desktop-gateway/src/steering_control.rs
git commit -m "feat(steering): enforce structured turn control"
```

### Task 5: Cooperatively interrupt active capabilities and checkpoint evidence

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Test: `crates/engine/src/agent_loop.rs`
- Test: `crates/desktop-gateway/src/turn_executor.rs`

- [ ] **Step 1: Write failing interruption and recovery tests**

Use a pending capability future and publish `FinalizeWithCurrentEvidence`. Assert the future is dropped through the cooperative control boundary and the engine proceeds to synthesis. Add a gateway test that Browser Stop is requested. Add a manual-cancel test asserting pending steering and the latest redacted agent checkpoint remain recoverable.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
cargo test -p local-first-engine steering_interrupts_active_capability -- --nocapture
cargo test -p local-first-desktop-gateway steering_checkpoint -- --nocapture
```

Expected: the active capability continues and no steering checkpoint exists.

- [ ] **Step 3: Implement cooperative interruption and checkpoints**

Wrap capability execution in a `tokio::select!` between the capability future and the control watch notification. On finalize/cancel, drop the future, call the executor cleanup hook, and record a typed `steering_interrupted` tool outcome.

Implement a gateway cleanup hook that calls `BrowserMethod::Stop` for an active browser session and uses existing cancellation cleanup for subprocess capabilities.

Before interruption or manual Stop, persist an `agent_checkpoint` containing bounded redacted messages, plan, evidence references, browser source list, and steering IDs. Mark it resumable. Startup/manual-stop recovery requeues interpreted control or schedules pending interpretation against this checkpoint.

- [ ] **Step 4: Run focused recovery suites**

Run:

```bash
cargo test -p local-first-engine steering_ -- --nocapture
cargo test -p local-first-desktop-gateway steering_ -- --nocapture
cargo test -p local-first-task-runtime checkpoint_recovery -- --nocapture
```

Expected: interruption, browser cleanup, manual Stop preservation, and restart recovery tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/engine/src/contract.rs crates/engine/src/agent_loop.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs crates/task-runtime/src/store.rs
git commit -m "feat(steering): interrupt and recover active work"
```

### Task 6: Render truthful steering and activity state

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts`
- Modify: `apps/desktop/src/lib/chatSteeringState.ts`
- Modify: `apps/desktop/src/components/PendingSteeringQueue.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Create: `apps/desktop/src/lib/chatSteeringState.test.mjs`

- [ ] **Step 1: Write failing projection tests**

Test the pure lifecycle projection:

```javascript
assert.equal(steeringUiState({ status: "pending" }).labelKey, "chat.steeringWaitingModel");
assert.equal(steeringUiState({ status: "interpreted" }).labelKey, "chat.steeringUnderstood");
assert.equal(steeringUiState({ status: "applied" }).labelKey, "chat.steeringApplying");
assert.equal(steeringUiState({ status: "completed" }).labelKey, "chat.steeringCompleted");
```

Add a terminal activity case asserting historical command text is projected as `last_activity`, not `running`.

- [ ] **Step 2: Run Node tests and verify RED**

Run:

```bash
node --test src/lib/chatSteeringState.test.mjs
```

Expected: new statuses and projection are missing.

- [ ] **Step 3: Implement API and UI projection**

Expand `TurnSteeringStatus` and record fields in `chatApi.ts`. Put lifecycle mapping in `chatSteeringState.ts`; keep `PendingSteeringQueue.tsx` presentation-only. Reconcile steering events by ID and revision. In `ChatView`, derive live activity from durable turn status; terminal/idle turns may show the last command only with the translated `Last activity` label.

Add translations for Waiting for the model, Understood, Applying, Completed, Needs clarification, and Last activity in all five locale files.

- [ ] **Step 4: Run desktop checks**

Run:

```bash
node --test src/lib/chatSteeringState.test.mjs src/lib/streamSequenceGate.test.mjs src/lib/turnStreamRecovery.test.mjs
npm run test:ui-contract
npm run typecheck
```

Expected: all Node, UI contract, and type checks pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/chatApi.ts apps/desktop/src/lib/chatSteeringState.ts apps/desktop/src/lib/chatSteeringState.test.mjs apps/desktop/src/components/PendingSteeringQueue.tsx apps/desktop/src/components/ChatView.tsx apps/desktop/src/i18n/locales
git commit -m "fix(desktop): show real steering lifecycle"
```

### Task 7: Full verification and installed-app scenario

**Files:**
- Modify only if a verification failure identifies an in-scope defect.

- [ ] **Step 1: Run complete automated gates**

Run:

```bash
cargo test -p local-first-task-runtime -- --test-threads=1
cargo test -p local-first-engine -- --test-threads=1
cargo test -p local-first-desktop-gateway -- --test-threads=1
node --test src/lib/chatSteeringState.test.mjs src/lib/streamSequenceGate.test.mjs src/lib/turnStreamRecovery.test.mjs
npm run test:ui-contract
npm run typecheck
npm run build
git diff --check
```

Expected: all selected gates pass. Record any repository-wide pre-existing formatter failures separately; do not call excluded or ignored tests green.

- [ ] **Step 2: Package and sign the desktop app**

Run the repository's existing macOS directory packaging flow, copy the latest release gateway into the bundle, sign nested code and the outer application with the available Developer ID identity, and verify:

```bash
codesign --verify --deep --strict --verbose=2 apps/desktop/dist-installers/mac-arm64/homun.app
```

Expected: bundle is valid on disk and satisfies its designated requirement.

- [ ] **Step 3: Install with a recoverable backup**

Quit Homun, move `/Applications/homun.app` to a timestamped explicit backup after confirming the target backup does not exist, copy the verified bundle to `/Applications/homun.app`, and verify its signature again.

- [ ] **Step 4: Exercise the semantic scenarios**

In the installed app:

1. Start a browser investigation and send a refinement; verify it continues.
2. Send a natural request to stop further work and answer from current evidence; verify the semantic model chooses finalization, the active tool stops, no later tool starts, and one terminal answer appears.
3. Use a paraphrase and a negated instruction to prove behavior comes from model interpretation rather than phrase matching.
4. Temporarily make the semantic provider unavailable, send steering, verify Waiting for the model, restore it, and verify automatic interpretation.
5. Repeat while using manual Stop and verify recovery from the durable checkpoint.

Do not perform a purchase, booking confirmation, payment, external write, deployment, push, pull request, or release publication.

- [ ] **Step 5: Commit any verification-only corrections and report evidence**

If no correction is required, leave the branch clean. If an in-scope correction is required, reproduce it with a failing test, implement the minimum fix, rerun affected and full gates, then commit with a focused message.
