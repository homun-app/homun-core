# Browser Effects And Turn Stream Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow user-directed browser search, login, and booking flows while requiring one exact, single-use approval for payment, and make chat turns reconnect and render idempotently after a non-terminal stream disconnect.

**Architecture:** Keep the existing browser snapshot/ref executor, Payment Approval Card, durable turn broker, and monotonic turn reducer. Separate payment risk from generic click mechanics, consume payment grants at the final financial action, add a cursor-preserving stream recovery loop, and enforce one published/rendered event per `(request_id, seq)` plus one local UI owner per turn.

**Tech Stack:** Rust, Axum, SQLite-backed task runtime, TypeScript, React, Node test runner, Electron/Vite.

---

## File structure

- Modify `crates/desktop-gateway/src/browser_safety.rs`: classify only payment and arbitrary evaluation as blocked browser effects.
- Modify `crates/desktop-gateway/src/main.rs`: remove the objective/channel blanket click block, scope and consume payment grants, and update browser tool guidance.
- Modify `apps/desktop/src/lib/chatApi.ts`: expose typed turn status and deduplicate sequenced stream publication.
- Create `apps/desktop/src/lib/turnStreamRecovery.{mjs,ts}`: testable reconnect policy with preserved cursor and bounded recovery.
- Create `apps/desktop/src/lib/turnStreamRecovery.test.mjs`: RED/GREEN coverage for EOF, terminal replay, and exhausted recovery.
- Modify `apps/desktop/src/lib/coreBridge.ts`: use the recovery loop instead of treating a non-terminal EOF as a chat error.
- Modify `apps/desktop/src/components/ChatView.tsx`: register local ownership before enqueue and reject duplicate sequenced UI side effects.
- Modify `apps/desktop/src/lib/turnReplayState.test.mjs`: cover stable text across transport reconnect.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: assert the local/background ownership guards remain wired.

### Task 1: Permit user-directed non-payment browser actions

**Files:**
- Modify: `crates/desktop-gateway/src/browser_safety.rs`
- Modify: `crates/desktop-gateway/src/main.rs:17968-17988`
- Modify: `crates/desktop-gateway/src/main.rs:22536-22562`
- Test: inline unit tests in both Rust modules

- [ ] **Step 1: Write failing policy tests**

Extend the browser snapshot fixture and add tests proving login and booking are ordinary user-directed actions while payment and `evaluate` remain blocked:

```rust
const SNAP: &str = concat!(
    "- textbox \"Da\" [ref=e1]\n",
    "- button \"Cerca\" [ref=e7]\n",
    "- button \"Accedi\" [ref=e8]\n",
    "- button \"Prenota\" [ref=e9]\n",
    "- button \"Paga ora\" [ref=e10]",
);

#[test]
fn allows_login_and_booking_but_blocks_payment() {
    for reference in ["e7", "e8", "e9"] {
        assert!(high_risk_reason(&json!({"kind":"click","ref":reference}), SNAP).is_none());
    }
    assert!(high_risk_reason(&json!({"kind":"click","ref":"e10"}), SNAP).is_some());
}
```

Add a gateway regression beside the existing browser policy tests:

```rust
#[test]
fn read_only_analysis_does_not_turn_search_click_into_channel_commit() {
    let action = serde_json::json!({"kind":"click","ref":"e7"});
    let snapshot = "- button \"Cerca\" [ref=e7]";
    assert!(browser_safety::high_risk_reason(&action, snapshot).is_none());
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test -p local-first-desktop-gateway browser_safety -- --nocapture
```

Expected: the login/booking assertion fails because those labels are still in `HIGH_RISK_LABEL_PATTERNS`.

- [ ] **Step 3: Implement the focused policy**

Replace the mixed high-risk list with payment-only classification and preserve the unconditional `evaluate` block:

```rust
const FINAL_PAYMENT_LABEL_PATTERNS: &[&str] = &[
    "pay now", "confirm payment", "place order", "purchase",
    "paga ora", "conferma pagamento", "procedi al pagamento",
];
```

Remove the fallback that blocks every `is_committing_action` when `ctx.read_only && !ctx.channel_owner`. Keep `high_risk_reason_with_payment_approval` as the safety gate. Update the browser tool description and manager prompt so login and booking are allowed when requested, while the final payment requires `payment_approval_id`.

Do not remove the `evaluate` prohibition, CVV vault handling, payment label check, or stale-ref recovery.

- [ ] **Step 4: Run GREEN**

Run:

```bash
cargo test -p local-first-desktop-gateway browser_safety -- --nocapture
cargo test -p local-first-desktop-gateway read_only_analysis_does_not_turn_search_click_into_channel_commit -- --nocapture
```

Expected: all selected tests pass and search/login/booking no longer return the channel-commit denial.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/browser_safety.rs crates/desktop-gateway/src/main.rs
git commit -m "fix(browser): gate payment instead of ordinary actions"
```

### Task 2: Scope and consume payment authorization exactly once

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs:524-529`
- Modify: `crates/desktop-gateway/src/main.rs:42931-42947`
- Modify: `crates/desktop-gateway/src/main.rs:43761-43930`
- Modify: `apps/desktop/src/lib/coreBridge.ts:2601-2615`
- Modify: `apps/desktop/src/components/ChatView.tsx:7558-7591`
- Test: `crates/desktop-gateway/src/main.rs` payment approval test module

- [ ] **Step 1: Write failing grant tests**

Add explicit scope and consumption assertions:

```rust
#[test]
fn payment_grant_matches_scope_and_is_claimed_once() {
    let mut approvals = std::collections::HashMap::from([(
        "pay_test".to_string(),
        PaymentApprovalGrant {
            snapshot: payment_snapshot(),
            cvv_one_shot: Some("123".to_string()),
            user_id: "user".to_string(),
            workspace_id: "workspace".to_string(),
            turn_id: "turn_1".to_string(),
            consumed: false,
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(300),
        },
    )]);
    let action = serde_json::json!({
        "kind":"click", "ref":"e20", "payment_approval_id":"pay_test"
    });
    let page = "- button \"Paga ora\" [ref=e20]";

    assert!(claim_payment_approval_from_map(
        &mut approvals, &action, page, "user", "workspace", "turn_1"
    ).is_ok());
    assert!(claim_payment_approval_from_map(
        &mut approvals, &action, page, "user", "workspace", "turn_1"
    ).is_err());
}
```

```rust
#[test]
fn payment_grant_rejects_different_turn_and_non_payment_control() {
    let grant = PaymentApprovalGrant {
        snapshot: payment_snapshot(),
        cvv_one_shot: None,
        user_id: "user".to_string(),
        workspace_id: "workspace".to_string(),
        turn_id: "turn_1".to_string(),
        consumed: false,
        expires_at: std::time::Instant::now() + std::time::Duration::from_secs(300),
    };
    let action = serde_json::json!({
        "kind":"click", "ref":"e20", "payment_approval_id":"pay_test"
    });
    let mut wrong_turn = std::collections::HashMap::from([("pay_test".to_string(), grant.clone())]);
    assert!(claim_payment_approval_from_map(
        &mut wrong_turn, &action, "- button \"Paga ora\" [ref=e20]",
        "user", "workspace", "turn_2"
    ).is_err());
    let mut wrong_control = std::collections::HashMap::from([("pay_test".to_string(), grant)]);
    assert!(claim_payment_approval_from_map(
        &mut wrong_control, &action, "- button \"Continua\" [ref=e20]",
        "user", "workspace", "turn_1"
    ).is_err());
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
cargo test -p local-first-desktop-gateway payment_grant_ -- --nocapture
```

Expected: compilation fails because scoped grant fields and `claim_payment_approval_from_map` do not exist.

- [ ] **Step 3: Add scope and one-shot claim**

Extend the in-memory grant:

```rust
struct PaymentApprovalGrant {
    snapshot: PaymentApprovalSnapshot,
    cvv_one_shot: Option<String>,
    user_id: String,
    workspace_id: String,
    turn_id: String,
    consumed: bool,
    expires_at: std::time::Instant,
}
```

Require `turn_id` on `VaultPaymentApprovalRequest`; derive `user_id` and `workspace_id` server-side. Reject an approval request whose `thread_id`/message marker does not match the immutable snapshot. Implement a claim helper that:

1. prunes expired grants;
2. verifies ID, user, workspace, and turn;
3. verifies the current ref resolves to a final-payment label;
4. rejects an already consumed grant;
5. marks the grant consumed before the browser call.

Use the claim result in the browser gate. A failed or uncertain browser call does not restore the grant; the user must approve a new card, preventing accidental double payment.

The frontend passes the already-known `turn_${requestId}` when approving the card:

```ts
await coreBridge.vaultPaymentApprovalApprove(snapshot, pin, cvv, {
  threadId,
  messageId,
  turnId: activeTurnId,
});
```

Keep CVV consumption independent: it may be consumed while filling the checkout, but it does not consume the final payment grant.

- [ ] **Step 4: Run GREEN and existing payment coverage**

Run:

```bash
cargo test -p local-first-vault payment_approval -- --nocapture
cargo test -p local-first-desktop-gateway payment_approval -- --nocapture
cargo test -p local-first-desktop-gateway controlled_checkout_approval_flow -- --nocapture
```

Expected: identical checkout data passes; scope/change/reuse fails; CVV remains absent from persisted text.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "fix(payments): consume scoped browser approval once"
```

### Task 3: Reconnect a non-terminal turn stream from its durable cursor

**Files:**
- Create: `apps/desktop/src/lib/turnStreamRecovery.mjs`
- Create: `apps/desktop/src/lib/turnStreamRecovery.ts`
- Create: `apps/desktop/src/lib/turnStreamRecovery.test.mjs`
- Modify: `apps/desktop/src/lib/chatApi.ts:992-1005`
- Modify: `apps/desktop/src/lib/coreBridge.ts:4888-4990`

- [ ] **Step 1: Write the failing recovery tests**

Create tests around a dependency-injected recovery loop:

```js
test("reopens after non-terminal EOF from the last sequence", async () => {
  const calls = [];
  const chunks = [
    [{ seq: 1, kind: "delta", payload: { text: "A" } }],
    [{ seq: 2, kind: "delta", payload: { text: "B" } }, { seq: 3, kind: "done", payload: {} }],
  ];
  const result = await recoverTurnStream({
    turnId: "turn",
    open: async (_turnId, since) => { calls.push(since); return chunks.shift(); },
    status: async () => ({ status: "running" }),
    sleep: async () => {},
    maxReconnects: 3,
  });
  assert.deepEqual(calls, [0, 1]);
  assert.equal(result.state.text, "AB");
  assert.equal(result.state.status, "completed");
});

test("throws typed recovery exhaustion without inventing a terminal", async () => {
  await assert.rejects(
    recoverTurnStream({
      turnId: "turn", open: async () => [],
      status: async () => ({ status: "running" }), sleep: async () => {}, maxReconnects: 2,
    }),
    (error) => error.code === "turn_stream_recovery_exhausted",
  );
});
```

- [ ] **Step 2: Run RED**

Run:

```bash
cd apps/desktop
node --test src/lib/turnStreamRecovery.test.mjs
```

Expected: module/function-not-found failure.

- [ ] **Step 3: Implement the pure recovery loop**

Implement `recoverTurnStream` so the same `TurnReplayState` survives each call to `open(turnId, state.lastSeq)`. Apply events through `applyTurnEvent`, return only on a terminal state, and reconnect only when the persisted state is active (`queued`, `running`, `retrying`, `retry_waiting`, or `blocked`). Use delays `[100, 250, 500, 1000, 2000]` milliseconds and return a typed error after the configured recovery budget.

Add to `chatApi.ts`:

```ts
export interface TurnStatusResponse {
  turn_id: string;
  thread_id: string | null;
  request_id: string | null;
  status: string;
}

export async function fetchTurnStatus(turnId: string): Promise<TurnStatusResponse> {
  return gatewayJson<TurnStatusResponse>(`/api/chat/turns/${encodeURIComponent(turnId)}`);
}
```

Adapt the production wrapper to parse an NDJSON `Response` into event batches for the pure loop. Preserve `onFirstDelta`, redacted user text, and typed error propagation. Remove the direct throw of `Turn stream ended before a terminal event.`; log it only as reconnect diagnostics.

- [ ] **Step 4: Verify RED-to-GREEN and reducer compatibility**

Run:

```bash
cd apps/desktop
node --test src/lib/turnStreamRecovery.test.mjs src/lib/turnReplayState.test.mjs
npm run typecheck
```

Expected: recovery and reducer tests pass; TypeScript reports zero errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/turnStreamRecovery.mjs apps/desktop/src/lib/turnStreamRecovery.ts apps/desktop/src/lib/turnStreamRecovery.test.mjs apps/desktop/src/lib/chatApi.ts apps/desktop/src/lib/coreBridge.ts
git commit -m "fix(chat): reconnect nonterminal turn streams"
```

### Task 4: Enforce one stream publisher and one visible owner

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts:29-30,400-411,523-534`
- Modify: `apps/desktop/src/components/ChatView.tsx:446-454`
- Modify: `apps/desktop/src/components/ChatView.tsx:1140-1175`
- Modify: `apps/desktop/src/components/ChatView.tsx:1267-1345`
- Modify: `apps/desktop/src/components/ChatView.tsx:1534-1631`
- Modify: `apps/desktop/src/components/ChatView.tsx:2631-2668`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Create: `apps/desktop/src/lib/streamSequenceGate.mjs`
- Create: `apps/desktop/src/lib/streamSequenceGate.ts`
- Create: `apps/desktop/src/lib/streamSequenceGate.test.mjs`

- [ ] **Step 1: Write failing publication and ownership tests**

Create and test a sequenced-event gate:

```js
test("publishes each request sequence once", () => {
  const gate = createStreamSequenceGate();
  assert.equal(gate.accept({ request_id: "r", seq: 7 }), true);
  assert.equal(gate.accept({ request_id: "r", seq: 7 }), false);
  assert.equal(gate.accept({ request_id: "r", seq: 6 }), false);
  assert.equal(gate.accept({ request_id: "r", seq: 8 }), true);
});
```

Extend `check-ui-contract.mjs` to require local ownership registration and a shared render-event guard before text concatenation.

- [ ] **Step 2: Run RED**

Run:

```bash
cd apps/desktop
node --test src/lib/streamSequenceGate.test.mjs
npm run test:ui-contract
```

Expected: missing sequence gate and local ownership registration assertions fail.

- [ ] **Step 3: Deduplicate before side effects**

Maintain a bounded `Map<request_id, lastSeq>` in `chatApi.notifyChatStreamEvent`. Reject a sequenced event when `seq <= lastSeq` before invoking any listener. Keep unsequenced local-only events compatible. Retain the latest 512 request cursors and evict the oldest entry when the bound is exceeded.

In `ChatView`, maintain a render cursor keyed by turn/request and call a shared `acceptRenderedStreamEvent(payload)` before delta concatenation, activity insertion, plan updates, and terminal effects. This is a second defensive boundary against overlapping listeners.

Immediately after creating `requestId`, before enqueue or any `await`, execute:

```ts
const localTurnId = `turn_${requestId}`;
activeTurnIdRef.current = localTurnId;
handledBackgroundTurnsRef.current.add(localTurnId);
turnReplayRef.current = createTurnReplayState(localTurnId);
```

When `resumeActiveStream` starts, atomically claim the same turn in a `streamOwnerTurnRef`. If another path already owns it, return without creating optimistic bubbles or listeners. Release ownership only after durable terminal/cancellation or component teardown, not after a transport EOF.

- [ ] **Step 4: Run GREEN and desktop build**

Run:

```bash
cd apps/desktop
node --test src/lib/streamSequenceGate.test.mjs src/lib/turnStreamRecovery.test.mjs src/lib/turnReplayState.test.mjs
npm run test:ui-contract
npm run build
```

Expected: all selected tests pass and the production renderer builds.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/lib/chatApi.ts apps/desktop/src/lib/streamSequenceGate.mjs apps/desktop/src/lib/streamSequenceGate.ts apps/desktop/src/lib/streamSequenceGate.test.mjs apps/desktop/src/components/ChatView.tsx apps/desktop/scripts/check-ui-contract.mjs
git commit -m "fix(desktop): render each turn event once"
```

### Task 5: Full verification and installed-app regression checks

**Files:**
- Modify only if a verification failure exposes an in-scope defect.
- Evidence: test output, gateway log excerpt, and screenshots of the installed app.

- [ ] **Step 1: Run focused and full automated gates**

Run:

```bash
cargo test -p local-first-vault payment_approval -- --nocapture
cargo test -p local-first-desktop-gateway browser_safety -- --nocapture
cargo test -p local-first-desktop-gateway payment_approval -- --nocapture
cargo test -p local-first-desktop-gateway
cd apps/desktop
node --test src/lib/streamSequenceGate.test.mjs src/lib/turnStreamRecovery.test.mjs src/lib/turnReplayState.test.mjs
npm run test:ui-contract
npm run typecheck
npm run build
```

Expected: every included command exits zero. If a long unrelated suite hangs or is excluded, report it explicitly and do not count it as green evidence.

- [ ] **Step 2: Package and install locally**

Use the repository's established local packaging/install workflow after automated gates. Record the installed version and gateway binary path. Do not publish a release.

- [ ] **Step 3: Verify the browser flow in the installed app**

In a new local chat, request a Napoli-to-Milano train search for a concrete future date. Verify origin and destination autocomplete, form submission, visible result rows on an intended provider, and absence of the blanket channel-commit denial in `gateway.log`.

Then exercise a login and a booking flow only to the payment boundary. Do not enter real credentials unless the user supplies them through the vault, and do not make a real booking or payment.

- [ ] **Step 4: Verify payment and stream boundaries safely**

Use synthetic payment-card data to render the Payment Approval Card. Confirm that the final payment control is blocked without approval, accepted once with a matching approval, and rejected on reuse or mismatch. Stub or simulate the browser call so no funds move.

Force an intermediate stream disconnect in a controlled local run. Confirm one assistant bubble, no repeated fragments, automatic continuation from the persisted cursor, no visible `Turn stream ended before a terminal event`, and exactly one durable terminal event.

- [ ] **Step 5: Review diff and commit final in-scope adjustments**

Run:

```bash
git diff --check
git status --short
git log --oneline -5
```

If verification required no further edits, do not create an empty commit. If it exposed an in-scope defect, return to RED/GREEN for that defect and commit only after the relevant focused and full gates pass.
