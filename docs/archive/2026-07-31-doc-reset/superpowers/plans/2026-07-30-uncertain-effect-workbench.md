# Uncertain Effect Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authoritative uncertain effect receipts visible and resolvable from the existing Tasks Workbench without adding a second lifecycle, retry path, or provider-specific contract.

**Architecture:** Extend the canonical task queue response with a metadata-only projection of the current user's uncertain effect receipts. The desktop renders that projection separately from approvals and submits one of the two existing `EffectReceiptResolution` variants, then refreshes the canonical queue instead of mutating local state optimistically.

**Tech Stack:** Rust, Axum, SQLite-backed `task-runtime`, serde, React 19, TypeScript, Electron, i18next, Node test runner.

**Status:** Implemented and verified on `main` (`7eb8b22f`, `582991f9`).

---

## File Map

- Modify `crates/desktop-gateway/src/main.rs`: add the bounded uncertain-effect queue DTO, map persisted receipts without sensitive fields, filter it with thread-scoped queues, and test both boundaries.
- Modify `apps/desktop/src/lib/coreBridge.ts`: type the queue projection and submit manual resolution through the existing resolver endpoint.
- Modify `apps/desktop/src/types.ts`: add the Workbench-only view model for uncertain effects.
- Modify `apps/desktop/src/App.tsx`: map canonical queue data, track one in-flight resolution, refresh canonical read models, and add the Tasks attention badge.
- Modify `apps/desktop/src/data/mockData.ts`: restore the existing Tasks view as a reachable navigation entry.
- Modify `apps/desktop/src/components/TasksView.tsx`: render the distinct recovery section and its two factual outcome commands.
- Modify `apps/desktop/src/styles.css`: style compact operational cards and responsive actions using existing tokens.
- Modify `apps/desktop/src/i18n/locales/{en,it,es,fr,de}.json`: add parity-checked operational labels and errors.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: assert the single queue/resolver path and the absence of a chat-card recovery path.
- Modify `docs/superpowers/specs/2026-07-30-uncertain-effect-workbench-design.md`: record implementation and verification evidence after all gates pass.

### Task 1: Backend metadata-only queue projection

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:674`
- Test: `crates/desktop-gateway/src/main.rs:83665`

- [x] **Step 1: Write the failing projection test**

Add a unit test that builds an `ExecutionEffectReceipt` containing deliberately sensitive values in
`idempotency_key`, `arguments_hash`, `result_json`, and nested evidence, then serializes the queue DTO:

```rust
#[test]
fn uncertain_effect_projection_is_bounded_and_metadata_only() {
    let receipt = local_first_task_runtime::ExecutionEffectReceipt {
        receipt_ref: local_first_execution_protocol::EffectReceiptRef::from_store_id(
            "11111111111111111111111111111111",
        ).unwrap(),
        execution_id: "exec-1".to_string(),
        revision: 3,
        idempotency_key: "secret-idempotency-key".to_string(),
        run_id: Some("run-1".to_string()),
        thread_id: Some("thread-1".to_string()),
        user_id: "user-1".to_string(),
        workspace_id: "workspace-1".to_string(),
        effect_class: local_first_execution_protocol::EffectClass::ExternalWrite,
        operation: "channel.telegram.reply".to_string(),
        arguments_hash: "secret-arguments-hash".to_string(),
        status: local_first_execution_protocol::EffectReceiptStatus::Uncertain,
        result_json: Some(json!({ "recipient": "private-recipient" })),
        effects_json: Some(json!({
            "dispatch_started": true,
            "recipient": "private-recipient",
            "payload": "private-payload"
        })),
        error_json: None,
        compensation: None,
        prepared_at: 100,
        started_at: Some(120),
        resolved_at: None,
    };

    let value = serde_json::to_value(super::uncertain_effect_response(&receipt)).unwrap();

    assert_eq!(
        value["receipt_ref"],
        "effect:v1:32:11111111111111111111111111111111"
    );
    assert_eq!(value["operation_family"], "channel");
    assert_eq!(value["uncertain_at"], 120);
    assert_eq!(value["evidence"], json!({ "dispatch_started": true }));
    let encoded = value.to_string();
    for forbidden in [
        "secret-idempotency-key",
        "secret-arguments-hash",
        "private-recipient",
        "private-payload",
    ] {
        assert!(!encoded.contains(forbidden), "projection leaked {forbidden}");
    }
}
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway uncertain_effect_projection_is_bounded_and_metadata_only -- --nocapture
```

Expected: compilation fails because `uncertain_effect_response` and its response type do not exist.

- [x] **Step 3: Implement the bounded DTO and mapper**

Add a serialized response type with exactly these fields:

```rust
#[derive(Clone, Debug, Serialize)]
struct UncertainEffectResponse {
    receipt_ref: String,
    execution_id: String,
    thread_id: Option<String>,
    operation_family: &'static str,
    status: &'static str,
    evidence: Value,
    uncertain_at: i64,
}
```

Implement `uncertain_effect_response` with a closed operation-family match and a closed evidence
allowlist. The evidence object may retain only boolean or provider-neutral dispatch markers already
persisted by the effect host, such as `dispatch_started`, `request_dispatched`, `side_effect_started`,
and `unknown_remote_outcome`; it must never copy arbitrary nested receipt JSON.

Extend `TaskQueueResponse` with:

```rust
uncertain_effects: Vec<UncertainEffectResponse>,
```

Load receipts using `uncertain_effect_receipts_for_user(gateway_user_id().as_str())` inside
`task_queue_response_for_state`, map them, and pass the resulting vector into `task_queue_response`.
Update existing direct callers of `task_queue_response` to pass `Vec::new()`.

- [x] **Step 4: Run focused and crate tests and verify GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway uncertain_effect_projection_is_bounded_and_metadata_only -- --nocapture
cargo test -p local-first-desktop-gateway task_queue_response_serializes_ui_read_model_for_renderer -- --nocapture
```

Expected: both tests pass without warnings.

### Task 2: Thread-scoped canonical queue behavior

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:41836`
- Test: `crates/desktop-gateway/src/main.rs`

- [x] **Step 1: Write the failing scope test**

Extract the endpoint's existing retain logic behind a pure helper and add a test with two uncertain
receipts, one matching `thread-1` and one belonging to `thread-2`:

```rust
#[test]
fn task_queue_scope_retains_only_matching_uncertain_effects() {
    let effect = |receipt_ref: &str, thread_id: &str| super::UncertainEffectResponse {
        receipt_ref: receipt_ref.to_string(),
        execution_id: format!("execution-{receipt_ref}"),
        thread_id: Some(thread_id.to_string()),
        operation_family: "browser",
        status: "uncertain",
        evidence: serde_json::json!({}),
        uncertain_at: 100,
    };
    let mut response = super::TaskQueueResponse {
        queued: Vec::new(),
        active: Vec::new(),
        blocked: Vec::new(),
        waiting_approvals: Vec::new(),
        uncertain_effects: vec![
            effect("effect-1", "thread-1"),
            effect("effect-2", "thread-2"),
        ],
        recent_failures: Vec::new(),
        resource_usage: Vec::new(),
    };

    super::retain_task_queue_scope(
        &mut response,
        &std::collections::HashSet::new(),
        "thread-1",
    );

    assert_eq!(response.uncertain_effects.len(), 1);
    assert_eq!(response.uncertain_effects[0].receipt_ref, "effect-1");
}
```

Do not introduce a test-only runtime store or HTTP server for this pure filtering behavior.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway task_queue_scope_retains_only_matching_uncertain_effects -- --nocapture
```

Expected: compilation fails because `retain_task_queue_scope` does not exist.

- [x] **Step 3: Move the existing thread filtering into one helper**

Implement:

```rust
fn retain_task_queue_scope(
    response: &mut TaskQueueResponse,
    allowed_task_ids: &HashSet<String>,
    thread_id: &str,
) {
    response.queued.retain(|item| allowed_task_ids.contains(&item.task_id));
    response.active.retain(|item| allowed_task_ids.contains(&item.task_id));
    response.blocked.retain(|item| allowed_task_ids.contains(&item.task_id));
    response.recent_failures.retain(|item| allowed_task_ids.contains(&item.task_id));
    response.waiting_approvals.retain(|item| allowed_task_ids.contains(&item.task_id));
    response.uncertain_effects.retain(|item| item.thread_id.as_deref() == Some(thread_id));
}
```

Call it from the existing `task_queue` endpoint after obtaining the thread's task IDs.

- [x] **Step 4: Run the gateway test target and verify GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway task_queue_scope_retains_only_matching_uncertain_effects -- --nocapture
cargo test -p local-first-desktop-gateway task_queue_response -- --nocapture
```

Expected: all matching tests pass without warnings.

- [x] **Step 5: Commit the backend projection**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(agent-loop): project uncertain effects into task queue"
```

### Task 3: Desktop bridge contract

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts:319`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] **Step 1: Add failing UI contract assertions**

Extend `check-ui-contract.mjs` to assert that:

```js
assert.match(coreBridgeSource, /uncertain_effects:\s*CoreUncertainEffect\[\]/);
assert.match(coreBridgeSource, /\/api\/effects\/\$\{encodeURIComponent\(effect\.receipt_ref\)\}\/resolve/);
assert.match(coreBridgeSource, /type:\s*"applied"/);
assert.match(coreBridgeSource, /type:\s*"not_applied"/);
assert.doesNotMatch(chatViewSource, /uncertain-effect-card/);
```

- [x] **Step 2: Run the contract test and verify RED**

Run:

```bash
npm --prefix apps/desktop run test:ui-contract
```

Expected: failure because the queue type and resolver bridge are absent.

- [x] **Step 3: Add bridge types and the resolver call**

Add `CoreUncertainEffect` and `uncertain_effects` to `CoreTaskQueueSnapshot`. Ensure
`emptyTaskQueue()` returns `uncertain_effects: []`.

Add a resolver that uses `gatewayPostJson` so non-2xx responses reject instead of appearing
successful:

```ts
type ManualEffectOutcome = "applied" | "not_applied";

async function electronResolveUncertainEffect(
  effect: CoreUncertainEffect,
  outcome: ManualEffectOutcome,
): Promise<void> {
  const resolution = outcome === "applied"
    ? {
        type: "applied" as const,
        result: { verified: true, source: "tasks_workbench" },
        effects: { ...effect.evidence, manually_verified: true },
      }
    : {
        type: "not_applied" as const,
        error: { code: "verified_not_applied", source: "tasks_workbench" },
      };
  await gatewayPostJson(
    `/api/effects/${encodeURIComponent(effect.receipt_ref)}/resolve`,
    resolution,
  );
}
```

Expose it as `coreBridge.resolveUncertainEffect` without adding an IPC handler or preload method.

- [x] **Step 4: Run contract and type checks and verify GREEN**

Run:

```bash
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run typecheck
```

Expected: both commands pass.

### Task 4: App state and canonical refresh

**Files:**
- Modify: `apps/desktop/src/types.ts`
- Modify: `apps/desktop/src/App.tsx:354`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] **Step 1: Add failing state-flow assertions**

Add source contract assertions proving that the resolution handler awaits the bridge call and then
refreshes the queue, selected task detail, and related thread read model:

```js
assert.match(appSource, /await coreBridge\.resolveUncertainEffect\(effect\.core, outcome\)/);
assert.match(appSource, /await loadTaskQueue\(\)/);
assert.match(appSource, /refreshSelectedTaskDetail\(selectedTaskId\)/);
assert.match(appSource, /effect\.threadId.*refreshChatReadModels/s);
```

- [x] **Step 2: Run the contract test and verify RED**

Run `npm --prefix apps/desktop run test:ui-contract`.

Expected: failure because App does not own uncertain effect state or resolution.

- [x] **Step 3: Implement the Workbench view model and state flow**

Add this distinct UI type in `types.ts`:

```ts
export interface UncertainEffectItem {
  id: string;
  executionId: string;
  threadId: string | null;
  scopeLabel: string | null;
  operationFamily: CoreUncertainEffect["operation_family"];
  uncertainAt: number;
  core: CoreUncertainEffect;
}
```

In `App.tsx`, map `snapshot.uncertain_effects` into state and derive a bounded thread suffix for
`scopeLabel`. Track `effectResolutionBusyId` and a receipt-bound `effectResolutionError` separately
from approvals.

Implement `handleResolveUncertainEffect(effect, outcome)` with this order:

```ts
setEffectResolutionBusyId(effect.id);
setEffectResolutionError(null);
try {
  await coreBridge.resolveUncertainEffect(effect.core, outcome);
  await loadTaskQueue();
  await refreshSelectedTaskDetail(selectedTaskId);
  if (effect.threadId) {
    await refreshChatReadModels(effect.threadId);
  }
} catch (error) {
  setEffectResolutionError({
    receiptId: effect.id,
    message: error instanceof Error ? error.message : String(error),
  });
} finally {
  setEffectResolutionBusyId(null);
}
```

Do not filter or remove the resolved item locally. Derive the Tasks nav badge from
`approvalItems.length + uncertainEffectItems.length`.

- [x] **Step 4: Run contract and type checks and verify GREEN**

Run:

```bash
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run typecheck
```

Expected: both commands pass.

### Task 5: Workbench controls, localization, and responsive styling

**Files:**
- Modify: `apps/desktop/src/components/TasksView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [x] **Step 1: Add failing UI structure assertions**

Assert that `TasksView` contains one `uncertain-effect-card`, two distinct localized actions, a
busy guard, and no raw evidence rendering:

```js
assert.match(tasksViewSource, /className="uncertain-effect-card"/);
assert.match(tasksViewSource, /tasksView\.verifiedApplied/);
assert.match(tasksViewSource, /tasksView\.verifiedNotApplied/);
assert.match(tasksViewSource, /effectResolutionBusyId === effect\.id/);
assert.doesNotMatch(tasksViewSource, /JSON\.stringify\(effect\.core\.evidence/);
```

- [x] **Step 2: Run UI contract and locale parity tests and verify RED**

Run:

```bash
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run test:electron -- --test-name-pattern="locale"
```

Expected: contract failure because the section is absent; locale parity may fail after the first
English key is introduced until every locale is updated.

- [x] **Step 3: Render the distinct operational section**

Add `uncertainEffects`, `effectResolutionBusyId`, `effectResolutionError`, and `onResolveEffect` to
`TasksViewProps`. Render the section before approvals only when `uncertainEffects.length > 0`.

Each card must show a Lucide warning/status icon, localized operation family, optional thread title,
localized timestamp, and exactly these commands:

```tsx
<button
  className="secondary-button"
  disabled={busy}
  onClick={() => onResolveEffect(effect, "not_applied")}
>
  <CircleX aria-hidden="true" />
  {t("tasksView.verifiedNotApplied")}
</button>
<button
  className="primary-button"
  disabled={busy}
  onClick={() => onResolveEffect(effect, "applied")}
>
  {resolvingThisEffect ? <Loader2 aria-hidden="true" /> : <BadgeCheck aria-hidden="true" />}
  {t("tasksView.verifiedApplied")}
</button>
```

Keep raw receipt evidence out of the component tree.

- [x] **Step 4: Add complete locale parity**

Add equivalent keys to all five locale files for the section title, four operation families,
conversation scope, uncertain timestamp, two actions, busy state, and resolution error. Italian
copy uses factual wording: `Verificato come applicato` and `Verificato come non applicato`.

- [x] **Step 5: Add compact responsive styles**

Use existing CSS variables, `border-radius: 8px`, stable action heights, and a wrapping action row.
At the existing mobile breakpoint, make both actions full width. Do not add gradients, decorative
backgrounds, nested cards, or viewport-scaled fonts.

- [x] **Step 6: Run desktop tests and build and verify GREEN**

Run:

```bash
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run test:electron
npm --prefix apps/desktop run build
```

Expected: all tests and the TypeScript/Vite build pass without warnings.

- [x] **Step 7: Commit desktop integration**

```bash
git add apps/desktop/src/lib/coreBridge.ts apps/desktop/src/types.ts apps/desktop/src/App.tsx \
  apps/desktop/src/components/TasksView.tsx apps/desktop/src/data/mockData.ts \
  apps/desktop/src/styles.css apps/desktop/src/i18n/locales/en.json \
  apps/desktop/src/i18n/locales/it.json apps/desktop/src/i18n/locales/es.json \
  apps/desktop/src/i18n/locales/fr.json apps/desktop/src/i18n/locales/de.json \
  apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat(desktop): resolve uncertain effects from tasks"
```

### Task 6: Full verification, documentation, and dev runtime

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-uncertain-effect-workbench-design.md`
- Verify: workspace and running desktop runtime

- [x] **Step 1: Run format and warning gates**

```bash
cargo fmt --all -- --check
cargo clippy -p local-first-desktop-gateway --all-targets -- -D warnings
npm --prefix apps/desktop run typecheck
```

Expected: all commands exit 0 with no warnings.

- [x] **Step 2: Run focused and full regression gates**

```bash
cargo test -p local-first-desktop-gateway
cargo test -p local-first-task-runtime
npm --prefix apps/desktop run test:ui-contract
npm --prefix apps/desktop run test:electron
npm --prefix apps/desktop run build
```

Expected: every command exits 0.

- [x] **Step 3: Verify the dev runtime owns the expected ports**

```bash
lsof -nP -iTCP:1420 -sTCP:LISTEN
lsof -nP -iTCP:18765 -sTCP:LISTEN
curl -fsS http://127.0.0.1:18765/api/health
```

If either service is absent, start the existing desktop dev command from the repository; do not
launch a second gateway over an already-owned port.

- [x] **Step 4: Record implementation evidence**

Change the design status to `Implemented and verified` and append the exact successful commands and
the implementation commit IDs. Do not claim provider-level automatic reconciliation.

- [x] **Step 5: Commit plan and verification documentation**

```bash
git add docs/superpowers/plans/2026-07-30-uncertain-effect-workbench.md \
  docs/superpowers/specs/2026-07-30-uncertain-effect-workbench-design.md
git commit -m "docs(agent-loop): record uncertain effect recovery"
```

- [x] **Step 6: Confirm clean scope and publish main**

```bash
git status --short
git log -4 --oneline
git push origin main
```

Expected: clean worktree and successful push of only the planned commits.
