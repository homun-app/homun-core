# Turn Ownership Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Homun chat turn ownership onto one typed control-flow contract and remove dead or misleading structures that create rival stop/resume paths.

**Architecture:** Keep `engine::run_turn` as the single guarded loop. Human waits are represented by `HitlEnvelope` and carried through `TurnOutcome.awaiting_user`; gateway, broker, and UI consume projections of that typed state instead of reconstructing ownership from prose or marker text. Cleanup is staged: remove dead scaffolds first, then converge persistence, then delete legacy flags/docs after tests prove the contract.

**Tech Stack:** Rust (`crates/engine`, `crates/desktop-gateway`, `crates/task-runtime`), React/TypeScript (`apps/desktop`), SQLite-backed chat/task stores, existing cargo and npm test suites.

---

## File Map

| File | Responsibility |
|---|---|
| `crates/engine/src/hitl.rs` | Canonical `HitlEnvelope` parsing/classification. |
| `crates/engine/src/agent_loop.rs` | Owns round loop, no-tools classifier, plan nudge, forced synthesis, parked outcome. |
| `crates/engine/src/outcome.rs` | Carries typed turn outcome from engine to gateway. |
| `crates/desktop-gateway/src/main.rs` | Builds runtime prompt/tools, drains stream, persists assistant message and HITL wait projections. |
| `crates/desktop-gateway/src/hitl_resume.rs` | Free wait persistence model and ResumeBinding prompt slot. |
| `crates/desktop-gateway/src/chat_store.rs` | Durable `thread_hitl_waits` table. |
| `crates/desktop-gateway/src/turn_executor.rs` | Broker post-run branch: completed, waiting approval, parked, no-answer. |
| `crates/task-runtime/src/broker.rs` | New turn vs mid-flight steering and task status ownership. |
| `apps/desktop/src/components/ChatView.tsx` | UI projection for Waiting vs Working and Free wait reply behavior. |
| `docs/TURN_CONTRACT.md` / `docs/STATO.md` / `docs/superpowers/2026-07-27-foundations-and-kill-list.md` | Living contract and cleanup checklist. |

---

## Task 1: Remove Dead Scaffolds And Keep Docs Honest

**Files:**
- Delete: `crates/desktop-gateway/src/tool_exec.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `docs/superpowers/2026-07-27-foundations-and-kill-list.md`
- Modify: `docs/STATO.md`
- Modify: `docs/superpowers/plans/2026-07-27-turn-contract-convergence.md`

- [x] **Step 1: Remove the unused module**

Delete `crates/desktop-gateway/src/tool_exec.rs` and remove this line from `crates/desktop-gateway/src/main.rs`:

```rust
mod tool_exec;
```

- [x] **Step 2: Update living docs**

Change current docs from “quarantine later” to “removed”, and keep future `ToolExecutor` extraction explicitly deferred until the live dispatch in `main.rs` is extracted with tests.

- [x] **Step 3: Verify compile boundary**

Run:

```bash
cargo check -p local-first-desktop-gateway
```

Expected: command exits `0`. Any failure mentioning `tool_exec` means a hidden live reference existed and must be investigated before continuing.

---

## Task 2: Make `TurnOutcome.awaiting_user` The Gateway Persistence Source

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs` if helper shape needs adjustment
- Test: `crates/desktop-gateway/src/main.rs` test module

- [x] **Step 1: Add a failing gateway test**

Add a test proving an engine outcome with `awaiting_user=Some(Choice Free)` persists `thread_hitl_waits` even when no marker-derived `event_parts` are provided.

```rust
#[test]
fn turn_outcome_awaiting_user_persists_free_wait_without_marker_parts() {
    let root = isolated_gateway_test_dir("awaiting-user-persists-wait");
    let state = test_app_state_with_root(&root);
    let store = super::lock_store(&state).unwrap();
    let thread = store.create_thread("default").unwrap();
    let message_id = "assistant-awaiting-user";
    let assistant = local_first_desktop_gateway::seeded_ready_message(
        &thread.thread_id,
        message_id.to_string(),
        "assistant",
        "",
    );
    store.append_assistant_message(&thread.thread_id, &assistant).unwrap();
    drop(store);

    let envelope = local_first_engine::hitl::HitlEnvelope {
        kind: local_first_engine::hitl::HitlKind::Choice,
        hold_policy: local_first_engine::hitl::HoldPolicy::Free,
        payload: serde_json::json!({
            "question": "Which option?",
            "options": ["A", "B"]
        }),
        source_marker: "CHOICES".to_string(),
    };
    let outcome = local_first_engine::TurnOutcome {
        awaiting_user: Some(envelope),
        memory_answer: "Pick one.".to_string(),
        delivery: local_first_engine::TurnDelivery::Delivered,
        ..Default::default()
    };

    super::persist_hitl_wait_from_outcome(
        &state,
        &thread.thread_id,
        message_id,
        &outcome,
    );

    let wait = super::lock_store(&state)
        .unwrap()
        .open_hitl_wait(&thread.thread_id)
        .unwrap()
        .expect("open wait");
    assert_eq!(wait.kind, super::hitl_resume::HitlWaitKind::Choice);
}
```

Run:

```bash
cargo test -p local-first-desktop-gateway turn_outcome_awaiting_user_persists_free_wait_without_marker_parts -- --nocapture
```

Observed: failed because `persist_hitl_wait_from_outcome` did not exist.

- [x] **Step 2: Implement the typed persistence helper**

Create a helper near `persist_hitl_wait_from_parts`:

```rust
fn persist_hitl_wait_from_outcome(
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    outcome: &local_first_engine::TurnOutcome,
) {
    let Some(envelope) = outcome.awaiting_user.as_ref() else {
        return;
    };
    if !envelope.is_free() {
        return;
    }
    let wait_kind = match envelope.kind {
        local_first_engine::hitl::HitlKind::Choice => "choice",
        local_first_engine::hitl::HitlKind::Clarify => "clarify",
        local_first_engine::hitl::HitlKind::PlanPropose => "plan_propose",
        _ => return,
    };
    let Ok(store) = lock_store(state) else {
        return;
    };
    persist_hitl_wait_payload(
        &store,
        state,
        thread_id,
        message_id,
        wait_kind,
        envelope.payload.clone(),
    );
}
```

Extract the body shared by `persist_hitl_wait_from_parts` into:

```rust
fn persist_hitl_wait_payload(
    store: &chat_store::ChatStore,
    state: &AppState,
    thread_id: &str,
    message_id: &str,
    wait_kind: &str,
    payload: serde_json::Value,
) {
    let browser_live = thread_has_live_browser_session(state, thread_id);
    let open_work = hitl_resume::OpenWorkSnapshot {
        browser_session_live: browser_live,
        last_url: None,
        capability_hint: browser_live.then(|| "browse".to_string()),
    };
    let wait_id = format!("hitl_{wait_kind}_{message_id}");
    let Ok(payload_json) = serde_json::to_string(&payload) else { return; };
    let Ok(open_work_json) = serde_json::to_string(&open_work) else { return; };
    if let Err(error) = store.set_open_hitl_wait(
        &wait_id,
        thread_id,
        message_id,
        wait_kind,
        &payload_json,
        &open_work_json,
    ) {
        eprintln!("[hitl] failed to persist {wait_kind} wait: {error}");
    }
}
```

- [x] **Step 3: Wire the helper at the outcome boundary**

After `run_agent_rounds(...)` returns in `stream_chat_via_openai`, the gateway now uses
the assistant message id recorded on `StreamEntry` by the drain, then calls:

```rust
persist_hitl_wait_from_outcome(
    &tail_state,
    tail_thread.as_deref().unwrap_or_default(),
    &tail_turn_id,
    &outcome,
);
```

If `tail_thread` is `None`, skip instead of writing under an empty thread id.

- [x] **Step 4: Keep marker persistence as compatibility**

Leave `persist_hitl_wait_from_parts` in place for old persisted messages and tests, but document it as projection/compat, not the owner.

- [x] **Step 5: Run focused tests**

```bash
cargo test -p local-first-desktop-gateway hitl -- --nocapture
cargo test -p local-first-desktop-gateway awaiting_user -- --nocapture
```

Expected: all focused tests pass.
Observed: `cargo test -p local-first-desktop-gateway hitl -- --nocapture` and
`cargo test -p local-first-desktop-gateway awaiting_user -- --nocapture` passed.

---

## Task 3: Re-Classify Forced Synthesis Output Before Delivery

**Files:**
- Modify: `crates/engine/src/agent_loop.rs`
- Test: `crates/engine/src/agent_loop.rs`

- [x] **Step 1: Add failing test**

Create a model fixture where the forced synthesis response asks the user to choose in prose without a card. Expected behavior: the turn must not deliver plain prose as a completed answer; it must nudge for a card or return `awaiting_user`.

```rust
#[tokio::test(flavor = "current_thread")]
async fn forced_synthesis_cannot_deliver_prose_wait_without_hitl_envelope() {
    let mut ls = LoopState::new();
    ls.messages = vec![
        json!({ "role": "system", "content": "sys" }),
        json!({ "role": "user", "content": "book a train" }),
    ];
    ls.step_messages_start = ls.messages.len();
    let model = ToolsUntilForcedSynthesisThenProseChoice::default();
    let sink = Collect::default();
    let journal = CollectJournal::default();
    let mut browser = NoBrowser;

    let outcome = run_turn(
        ls,
        cfg(),
        &usage_context(),
        &model,
        &NoopTool,
        &mut browser,
        &NoPlan,
        &DoneJudge,
        &NoCompact,
        &OpenPolicy,
        &journal,
        &sink,
        0.0,
        Some("thread"),
        &std::collections::BTreeSet::new(),
        &[],
        "book a train".to_string(),
        String::new(),
        None,
        false,
        0,
        false,
        Vec::new(),
        None,
        &crate::turn_trace::TurnTrace::disabled(),
    ).await;

    assert!(
        outcome.awaiting_user.is_some() || outcome.memory_answer.contains("‹‹CHOICES››"),
        "forced synthesis must not deliver prose-only user wait: {}",
        outcome.memory_answer
    );
}
```

Observed: failed with `awaiting_user=None` when forced synthesis returned prose-only choice.

- [x] **Step 2: Implement forced-synthesis HITL gate**

After `synth_text` is sanitized and before delivery candidate commit, run `classify_no_tools_stop(&synth_text)`.

For `Await(envelope)`: set `awaiting_envelope`, set `memory_answer` via `ensure_free_hitl_marker_in_text`, emit `Done`, set `delivery=Delivered`, skip plan reconcile.

For `NudgeEmit(kind)`: do not run more tools. Inject the same minimal marker locally using `format_await_user_marker` with a conservative payload:

```rust
let envelope = HitlEnvelope {
    kind,
    hold_policy: crate::hitl::HoldPolicy::Free,
    payload: serde_json::json!({ "question": "Please clarify how to proceed." }),
    source_marker: "forced_synthesis_hitl_gate".into(),
};
let final_text = ensure_free_hitl_marker_in_text(&synth_text, &envelope);
```

Then emit `Done` and return `awaiting_user=Some(envelope)`.

- [x] **Step 3: Run engine tests**

```bash
cargo test -p local-first-engine forced_synthesis -- --nocapture
cargo test -p local-first-engine choices_card_stops_the_turn_instead_of_nudging_an_open_plan -- --nocapture
```

Expected: all pass, and no forced synthesis path can create a prose-only wait.

---

## Task 4: Converge `needs_clarification` Into `HitlEnvelope`

**Files:**
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/engine/src/outcome.rs`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs` only if tests show stale wording
- Test: `crates/engine/src/agent_loop.rs`

- [x] **Step 1: Add characterization tests**

Keep current behavior visible first:

```bash
cargo test -p local-first-engine needs_clarification -- --nocapture
```

Observed before removal: Clarify steering was already represented by `awaiting_user=Some(Clarify)`.

- [x] **Step 2: Remove bool consumers after envelope tests pass**

Replace outcome assertions and gateway consumers to use:

```rust
outcome.awaiting_user
    .as_ref()
    .is_some_and(|env| matches!(env.kind, HitlKind::Clarify))
```

Done: removed `pub needs_clarification: bool` from `TurnOutcome`; tests now assert
`awaiting_user=Clarify Free`.

- [x] **Step 3: Verify no references**

```bash
rg -n "needs_clarification" crates/engine/src crates/desktop-gateway/src
```

Observed: only semantic enum/string/trace names remain, not `TurnOutcome.needs_clarification`.

---

## Task 5: Keep Free Wait Replies Out Of Steering

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `crates/task-runtime/src/broker.rs` only if gateway-side protection is needed
- Test: existing desktop unit test path if available; otherwise Rust broker/gateway tests

- [ ] **Step 1: Add gateway protection test**

Prove that when `thread_hitl_waits` has an open wait, `POST /api/chat/turns` creates a new turn and `try_resume_open_wait` consumes it before `turn_steering` is appended.

- [ ] **Step 2: Keep UI heuristic as projection only**

Leave `turnAwaitingUser` in UI for UX, but do not rely on it as the only guard. The gateway must be correct if UI state is stale.

- [ ] **Step 3: Verify**

```bash
cargo test -p local-first-desktop-gateway hitl_resume -- --nocapture
cargo test -p local-first-desktop-gateway broker_steering -- --nocapture
```

Expected: open Free wait reply is not stored as steering.

---

## Task 6: Scrub Current Docs That Re-Advertise Retired Control Paths

**Files:**
- Modify: `docs/STATO.md`
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/decisions/0020-converge-chat-loop-onto-orchestrator.md`
- Do not modify archive docs unless they are linked as current restart guidance.

- [ ] **Step 1: Search current docs**

```bash
rg -n "HOMUN_DRIVE_CHAT|HOMUN_ORCHESTRATED_CHAT|tool_exec|ToolExecutor|drive-as-chat|secondo motore" docs --glob '!docs/archive/**'
```

- [ ] **Step 2: Rewrite current references**

Current docs must say: `OrchestratorBrain` is not the chat driver; live chat driver is `engine::run_turn`; old drive flags are historical/superseded; future tool chokepoint must be extracted from live dispatch, not revived from deleted scaffold.

- [ ] **Step 3: Verify docs search**

```bash
rg -n "HOMUN_DRIVE_CHAT|HOMUN_ORCHESTRATED_CHAT|tool_exec|ToolExecutor" docs --glob '!docs/archive/**'
```

Expected: only historical ADR/audit mentions with explicit “superseded/removed”, plus this cleanup plan.

---

## Task 7: Full Contract Verification

**Commands:**

```bash
cargo test -p local-first-engine hitl -- --nocapture
cargo test -p local-first-engine forced_synthesis -- --nocapture
cargo test -p local-first-desktop-gateway hitl_resume -- --nocapture
cargo test -p local-first-desktop-gateway broker_steering -- --nocapture
cargo check -p local-first-desktop-gateway
```

**Acceptance Criteria:**
- `TurnOutcome.awaiting_user` is the typed source for gateway HITL persistence.
- Marker/event_parts persistence remains only compatibility/projection.
- Forced synthesis cannot deliver a prose-only user wait.
- Free wait reply cannot become `turn_steering`.
- `Parked` remains machine wait and never appears as human Waiting.
- Dead scaffolds are deleted or clearly marked historical in docs.

---

## Anti-Goals

- Do not add a new marker or third wait protocol.
- Do not special-case booking, Trenitalia, weather, or “che ore sono”.
- Do not revive `OrchestratorBrain::drive` as chat driver.
- Do not remove Confirm/Hold behavior before it is represented as `HitlEnvelope` and covered by tests.
- Do not rewrite `ChatView` broadly while gateway ownership is still being converged.
