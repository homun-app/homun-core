# Homun Unified Kernel UI Plugin Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Homun stable enough for a first release by converging kernel/backend, desktop UI, browser automation, plugin/capability routing, approvals, and effect receipts onto one canonical runtime projection, while deleting obsolete duplicate owners slice by slice.

**Architecture:** Runtime V2 remains the base: one guarded loop, one durable event/receipt store, one task-runtime reducer, one gateway DTO, and one desktop presenter. Browser, plugins, MCP, skills, connector tools, automations, and local computer are capabilities that produce typed events/effect receipts; they do not create independent liveness, plan, approval, or completion contracts. The UI renders `KernelThreadProjection` plus local presentation state only.

**Tech Stack:** Rust workspace (`crates/engine`, `crates/task-runtime`, `crates/desktop-gateway`), SQLite-backed runtime state, Electron/React desktop (`apps/desktop`), pure `.mjs` presenter tests with `.ts` wrappers, Python/Node/Rust regression gates.

---

## Guiding Contract

This plan supersedes narrower runtime/browser/UI patch plans. The previous work on `reduce_kernel_projection` stays; every new slice must extend that owner boundary instead of adding another UI or gateway inference path.

Canonical flow:

```text
model/tool/capability execution
  -> turn_events + runtime_plans + execution_effect_receipts + approvals + agent_runs
  -> task-runtime reducer
  -> gateway KernelThreadProjection
  -> desktop presenter rows/cards/composer mode
```

The desktop may own layout, selected tabs, scroll anchoring, draft input, optimistic echo before the first backend projection, and transient animation. The desktop must not own terminality, plan progress, browser success, plugin effect risk, approval/wait ownership, or stale marker recovery when a durable projection exists.

## Deletion Ledger Rule

Every implementation task must include this ledger in the commit message body or adjacent test comment:

```text
Removed owner:
  file/function:
  old responsibility:
  new owner:
  regression test:

Temporary fallback retained:
  file/function:
  reason:
  removal condition:
  tracking test:
```

A slice that only adds a new projection but leaves all old inference paths active is incomplete. Compatibility is allowed only behind a named legacy adapter.

## Target Projection Shape

The exact serde names must be stabilized by tests before UI migration:

```rust
KernelThreadProjection {
    thread_id: String,
    revision: i64,
    turn: KernelTurnView,
    plan: Option<KernelPlanView>,
    activity: Vec<KernelActivityRow>,
    browser: KernelBrowserView,
    capability_runtime: KernelCapabilityRuntimeView,
    attention: KernelAttentionView,
    actions: KernelThreadActions,
}
```

Required fields:

```rust
KernelTurnView {
    active_turn_id: Option<String>,
    status: "idle" | "running" | "waiting_user" | "waiting_approval" | "completed" | "failed" | "cancelled",
    last_event_seq: i64,
    terminal_reason: Option<String>,
    failure_text: Option<String>,
    updated_at: i64,
}

KernelPlanView {
    goal: Option<String>,
    revision: i64,
    steps: Vec<{ id: String, title: String, status: "todo" | "doing" | "done" | "blocked" | "failed" }>,
    markdown: String,
}

KernelBrowserView {
    state: "idle" | "active" | "waiting_user" | "done" | "failed" | "unknown",
    target_id: Option<String>,
    latest_progress: Option<String>,
    failure_reason: Option<String>,
    snapshot_verified: bool,
}

KernelCapabilityRuntimeView {
    loaded_tools: Vec<String>,
    armed_sensitive_domains: Vec<String>,
    pending_capability: Option<String>,
    blocked_capabilities: Vec<{ key: String, reason: String }>,
}

KernelAttentionView {
    awaiting_user: bool,
    approvals: Vec<ApprovalProjection>,
    uncertain_effects: Vec<UncertainEffectProjection>,
}

KernelThreadActions {
    can_stop: bool,
    composer_mode: "new_turn" | "steer_active_turn" | "reply_to_user_wait" | "approval_only" | "disabled",
}
```

`ThreadActivityProjection` remains only as a compatibility endpoint until the desktop is migrated.

---

## Task 1: Backend Kernel Projection DTO

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/turn_reducer.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/lib.rs`

- [ ] Add a failing reducer/store test named `kernel_thread_projection_owns_turn_plan_attention_and_actions`.
- [ ] Build the fixture with one latest chat turn, a runtime plan with stable step ids, one read uncertain receipt, one external-write uncertain receipt, one waiting approval, and a terminal run.
- [ ] Assert that read uncertainty does not set `attention.awaiting_user`, external-write uncertainty does, terminal run clears `active_turn_id`, and plan step statuses come from `runtime_plans`.
- [ ] Add serializable DTOs in `types.rs`; keep field names snake_case to match current gateway JSON.
- [ ] Add `TaskStore::project_kernel_thread(thread_id, activity_cap)` that calls the existing reducer and returns `KernelThreadProjection`.
- [ ] Keep `project_thread_activity` as a compatibility adapter implemented from the new projection where possible.
- [ ] Run:

```bash
cargo test -p local-first-task-runtime kernel_thread_projection_owns_turn_plan_attention_and_actions -- --nocapture
cargo test -p local-first-task-runtime project_thread_activity -- --nocapture
cargo fmt --all --check
```

**Deletion ledger:**

Removed owner: `store.rs::project_thread_activity` no longer independently decides canonical turn status and plan ownership.

New owner: `store.rs::project_kernel_thread` plus `turn_reducer.rs`.

Regression test: `kernel_thread_projection_owns_turn_plan_attention_and_actions`.

---

## Task 2: Gateway Projection Route And Compatibility Boundary

**Files:**
- Modify: `crates/desktop-gateway/src/gateway_turn_broker.rs`
- Modify: `crates/desktop-gateway/src/gateway_routes.rs`
- Modify: `apps/desktop/src/lib/chatApi.ts`

- [ ] Add `GET /api/chat/threads/{thread_id}/kernel-projection`.
- [ ] Return the exact `KernelThreadProjection` DTO from `TaskStore::project_kernel_thread`.
- [ ] Add `KernelThreadProjection` TypeScript interfaces in `chatApi.ts`.
- [ ] Add `fetchKernelThreadProjection(threadId)`.
- [ ] Keep `fetchThreadActivity` temporarily, with a comment pointing to the removal condition: no renderer consumer outside the legacy adapter.
- [ ] Add a gateway-level test or focused Rust route/unit test proving a terminal durable turn returns `turn.status="completed"`, `actions.can_stop=false`, and `actions.composer_mode="new_turn"`.
- [ ] Run:

```bash
cargo test -p local-first-desktop-gateway kernel_projection -- --nocapture
npm --prefix apps/desktop test -- chatApi
python3 scripts/check_gateway_main_contract.py
```

**Deletion ledger:**

Removed owner: gateway route callers no longer infer stop/composer behavior from `latest_turn_status`.

New owner: `TaskStore::project_kernel_thread`.

Temporary fallback retained: `/activity`, until `useChatActivityProjection.ts` stops consuming it.

---

## Task 3: Pure Desktop Presenter Adapter

**Files:**
- Add: `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.mjs`
- Add: `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.ts`
- Add: `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.test.mjs`

- [ ] Add RED tests before implementation:
  - `terminal_projection_clears_active_thinking`
  - `durable_plan_projection_wins_over_marker_and_stream_gap`
  - `read_uncertain_effect_does_not_render_verification_attention`
  - `write_uncertain_effect_renders_attention`
  - `plugin_loaded_tools_do_not_change_liveness`
  - `browser_active_without_done_stays_active`
- [ ] Implement a pure presenter returning:
  - `conversationPlan`
  - `conversationActivity`
  - `workspacePlanSteps`
  - `workspacePlanGoal`
  - `turnUiState`
  - `composerMode`
  - `attentionItems`
  - `browserStatus`
  - `capabilityRuntime`
- [ ] The presenter may merge live current-turn stream rows only when `streamOwnerTurnId === projection.turn.active_turn_id`.
- [ ] The presenter must ignore persisted marker plan/activity when `projectionLoaded === true`.
- [ ] Run:

```bash
npm --prefix apps/desktop test -- kernelProjectionPresenter
```

**Deletion ledger:**

Removed owner: `browserActivityLifecycle.mjs::deriveConversationPlan` no longer chooses canonical plan when kernel projection is loaded.

New owner: `kernelProjectionPresenter.mjs`.

Temporary fallback retained: marker extraction only when `projectionLoaded === false`.

---

## Task 4: Migrate `useChatActivityProjection` To Kernel Projection

**Files:**
- Modify: `apps/desktop/src/components/useChatActivityProjection.ts`
- Modify: `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.mjs`
- Modify: `apps/desktop/src/lib/chat-runtime/browserActivityLifecycle.test.mjs`
- Modify: `apps/desktop/src/lib/chat-runtime/lifecycle.mjs`
- Modify: `apps/desktop/src/lib/chat-runtime/lifecycle.test.mjs`

- [ ] Replace `fetchThreadActivity` with `fetchKernelThreadProjection`.
- [ ] Replace local state fragments (`projectedPlan`, `projectedActivity`, `projectedTurnStatus`, `projectedActiveTurn`) with one `kernelProjection` state value.
- [ ] Use `kernelProjectionPresenter` for plan, activity, workspace steps, active-turn view, browser budget/failure state, and composer mode.
- [ ] Delete the local `doing -> done` rewrite based on `projectedTurnStatus`; backend must return final step statuses.
- [ ] Delete plan resurrection from `latestPlanMarkdown(messages)` when projection loaded.
- [ ] Keep `latestPlanMarkdown` only inside a clearly named `legacyMarkerProjection` fallback path.
- [ ] Run:

```bash
npm --prefix apps/desktop test -- useChatActivityProjection
npm --prefix apps/desktop test -- browserActivityLifecycle lifecycle
npm --prefix apps/desktop test
```

**Deletion ledger:**

Removed owner: `useChatActivityProjection.ts` no longer owns plan completion, stale marker recovery, or active-turn truth.

New owner: backend `KernelThreadProjection` plus pure presenter.

Temporary fallback retained: `legacyMarkerProjection` for old persisted messages and projection fetch failures only.

---

## Task 5: Browser State As Typed Kernel Projection

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/turn_reducer.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/gateway_tool_execution.rs`
- Modify: `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.mjs`
- Modify: browser-related tests under `runtimes/browser_automation` only if the typed event contract requires it.

- [ ] Add backend tests:
  - `browser_done_closes_browser_state_even_with_read_uncertainty`
  - `browser_visible_snapshot_without_done_is_not_success`
  - `browser_no_progress_failure_is_bounded`
- [ ] Project browser state only from durable browser events/checkpoints/effect receipts, not from UI snapshot visibility.
- [ ] Emit typed failure reasons for `wall_clock`, `failed_navigations`, and `no_progress`.
- [ ] Remove UI parsing of `browser_budget_exceeded:*` from generic activity rows once typed failure is present.
- [ ] Ensure the browser prompt requesting train results can end in `browser.state="done"` plus terminal answer without an outcome-verification card for read-only uncertainty.
- [ ] Run:

```bash
cargo test -p local-first-task-runtime browser_done_closes_browser_state_even_with_read_uncertainty -- --nocapture
cargo test -p local-first-desktop-gateway browser -- --nocapture
npm --prefix apps/desktop test -- kernelProjectionPresenter
python3 scripts/kernel_regression_gate.py
```

**Deletion ledger:**

Removed owner: desktop browser panel no longer derives success/failure from `previewDataUrl`, `computerLiveStatus.active`, or budget marker text.

New owner: `KernelBrowserView`.

---

## Task 6: Plugin, Skill, MCP, Connector Capability Runtime Contract

**Files:**
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/loop_state.rs`
- Modify: `crates/desktop-gateway/src/gateway_tool_execution.rs`
- Modify: `crates/desktop-gateway/src/effect_host.rs`
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/turn_reducer.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `apps/desktop/src/lib/chat-runtime/kernelProjectionPresenter.mjs`
- Modify: `apps/desktop/src/components/MessageConnectSuggestCard.tsx` only if projection-driven connect actions require a prop change.

- [ ] Add a reducer test named `capability_runtime_projection_does_not_own_liveness`.
- [ ] Fixture: `use_skill` loads a tool, MCP read tool succeeds, MCP write tool is blocked by approval, and a plugin suggests a connector.
- [ ] Assert:
  - loaded tools appear in `capability_runtime.loaded_tools`;
  - blocked connector/tool appears in `capability_runtime.blocked_capabilities`;
  - read tool result never sets `attention.awaiting_user`;
  - write tool approval appears through `attention.approvals`;
  - no capability field changes `turn.status` without a matching turn event or task status.
- [ ] Normalize `ToolEffects.load_tools`, armed sensitive domains, MCP/Composio confirmation, and connect suggestions into typed projection rows.
- [ ] UI connect/install cards render from typed projection or typed transcript parts; raw marker support remains legacy only.
- [ ] Run:

```bash
cargo test -p local-first-engine load_tools -- --nocapture
cargo test -p local-first-desktop-gateway capability_runtime_projection -- --nocapture
cargo test -p local-first-task-runtime capability_runtime_projection_does_not_own_liveness -- --nocapture
npm --prefix apps/desktop test -- kernelProjectionPresenter chatPromptAssembly
```

**Deletion ledger:**

Removed owner: plugin/MCP/skill UI cards no longer decide task liveness, approval state, or capability availability from message text.

New owner: capability registry plus `EffectHost` plus `KernelCapabilityRuntimeView`.

Temporary fallback retained: marker parsing in `chatEventParts.ts` for historical transcript rows only.

---

## Task 7: Transcript Parts And Marker Quarantine

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/desktop-gateway/src/gateway_turn_broker.rs`
- Modify: `apps/desktop/src/lib/chatEventParts.ts`
- Modify: `apps/desktop/src/lib/markers.ts`
- Modify: `apps/desktop/src/components/ChatMessageParts.tsx` or current equivalent renderer owner.

- [ ] Add typed transcript part DTOs for plan, activity, approval, connect suggestion, artifact, browser event, and plain answer.
- [ ] Add tests:
  - `typed_parts_render_after_reload_without_marker_text`
  - `malformed_marker_fragments_cannot_affect_liveness`
  - `legacy_marker_messages_render_but_do_not_drive_current_turn`
- [ ] Move marker parsing behind `legacyMarkerProjection`.
- [ ] Remove marker/HITL fallback from general lifecycle code when durable projection exists.
- [ ] Run:

```bash
npm --prefix apps/desktop test -- chatEventParts markers
cargo test -p local-first-desktop-gateway transcript_parts -- --nocapture
```

**Deletion ledger:**

Removed owner: `markers.ts` and `chatEventParts.ts` no longer drive current turn lifecycle.

New owner: typed transcript parts plus kernel projection.

Temporary fallback retained: import/render compatibility for older marker-only messages.

---

## Task 8: ChatView As Presenter Shell

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/components/useChatRuntimeState.ts` if this is the current owner for runtime aggregation.
- Modify: `apps/desktop/src/components/useChatTurnSubmission.ts`
- Modify: `apps/desktop/src/lib/chat-runtime/submissionRouting.mjs`
- Modify: `apps/desktop/src/lib/chat-runtime/submissionRouting.test.mjs`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] Introduce a single `runtimeViewModel` object passed into `ChatView` sections.
- [ ] Replace `threadTailAwaitsHitl` decision points with `projection.attention.awaiting_user` when projection loaded.
- [ ] Submission routing must use `actions.composer_mode`.
- [ ] Add structural UI contract checks:
  - `ChatView.tsx` must not import `markers.ts`;
  - `ChatView.tsx` must not call `latestPlanMarkdown`;
  - `ChatView.tsx` must not parse browser budget marker text;
  - lifecycle code must not map `doing -> done`.
- [ ] Run:

```bash
npm --prefix apps/desktop test -- submissionRouting
npm --prefix apps/desktop test
node apps/desktop/scripts/check-ui-contract.mjs
```

**Deletion ledger:**

Removed owner: `ChatView.tsx` no longer composes kernel facts from unrelated hooks.

New owner: `runtimeViewModel` derived from `KernelThreadProjection`.

---

## Task 9: Automations And Background Runs Use The Same Contract

**Files:**
- Modify: `crates/desktop-gateway/src/gateway_task_executor.rs`
- Modify: automation-related runtime files found by `rg -n "automation|scheduler|channel|adapter_output" crates apps/desktop/src`
- Modify: `docs/architecture/kernel-v2-contract.md`

- [ ] Add an automation fixture where a background trigger runs a capability, waits for approval, resumes, and completes.
- [ ] Assert that the same `KernelThreadProjection` status vocabulary is returned for chat-started and automation-started work.
- [ ] Ensure adapter output effects use `EffectHost::for_projection` and settle into receipts before UI attention is displayed.
- [ ] Remove any automation-specific UI wait/progress vocabulary that bypasses the projection.
- [ ] Run:

```bash
cargo test -p local-first-desktop-gateway automation_projection -- --nocapture
python3 scripts/kernel_regression_gate.py
```

**Deletion ledger:**

Removed owner: automation UI/state no longer has a separate lifecycle vocabulary.

New owner: same kernel projection used by chat turns.

---

## Task 10: Regression Gate, Smoke Matrix, And Release Evidence

**Files:**
- Modify: `docs/testing/kernel-contract-matrix.md`
- Modify: `docs/testing/anti-regression-protocol.md`
- Modify: `scripts/kernel_regression_gate.py`
- Modify: `scripts/pre_release_gate.py` only if the new gate command must be added to release validation.
- Add: `scripts/smoke_kernel_projection.py`

- [ ] Add gate rows for:
  - terminal turn clears UI liveness;
  - runtime plan survives stream gap and reload;
  - read uncertainty is not a user verification request;
  - external-write uncertainty is a user verification request;
  - browser done closes browser state;
  - visible browser snapshot without done remains active/unknown;
  - plugin loaded tools do not change liveness;
  - MCP/plugin write approval appears through kernel attention;
  - legacy markers render but do not own current lifecycle.
- [ ] Add a deterministic smoke script that starts from persisted fixtures and queries `/kernel-projection`.
- [ ] Wire the smoke into `kernel_regression_gate.py`.
- [ ] Run the full release-relevant gate:

```bash
python3 scripts/kernel_regression_gate.py
python3 scripts/pre_release_gate.py
make test
```

**Deletion ledger:**

Removed owner: manual screenshot-based validation is no longer the primary proof for these contracts.

New owner: regression gate plus live Electron smoke only after canonical fixtures pass.

---

## Execution Order And Commit Boundaries

Use one branch and small commits:

1. `test(runtime): define kernel thread projection contract`
2. `fix(gateway): expose kernel thread projection`
3. `test(desktop): add kernel projection presenter contract`
4. `fix(desktop): route activity hook through kernel projection`
5. `fix(runtime): project browser state canonically`
6. `fix(runtime): project capability runtime state`
7. `fix(desktop): quarantine legacy transcript markers`
8. `refactor(desktop): make chat view consume runtime view model`
9. `fix(runtime): align automations with kernel projection`
10. `test: gate kernel ui plugin convergence`

After each commit run the focused tests listed in the task. After tasks 4, 6, 8, and 10 run `python3 scripts/kernel_regression_gate.py`.

## Final Acceptance

The refactor is ready for first-release evaluation only when all statements are true:

- A durable terminal turn cannot leave the UI in an active thinking state.
- Plan visibility and progress can be traced to `runtime_plans` and `turn_events`.
- Browser activity cannot be mistaken for completion without typed `browser.state="done"`.
- Read-only uncertain effects never show a user verification card.
- External-write uncertain effects always show a user attention item.
- Plugin, skill, MCP, connector, and automation capabilities enter through the registry/effect contract and never create separate liveness rules.
- `ChatView.tsx` presents a runtime view model instead of composing backend truth from markers, approvals, browser status, and local refs.
- Every retained fallback is named `legacy*`, has a removal condition, and has a tracking test.
- `python3 scripts/kernel_regression_gate.py`, `python3 scripts/pre_release_gate.py`, and `make test` pass on a clean restart path before release tagging.
