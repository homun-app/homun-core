# Turn Replay Recovery And Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere terminale, reconnect e recovery deterministici anche con eventi duplicati, fuori ordine o processi interrotti.

**Architecture:** Il task store accetta atomicamente un solo terminale per `turn_id`. Il desktop applica eventi per sequenza e snapshot; il recovery chiude l'attempt ma riusa turno e assistant. Gli effetti restano protetti dalle receipt già presenti.

**Tech Stack:** Rust, SQLite transactions, WebSocket, TypeScript, Node test runner.

---

## File structure

- Modify `crates/task-runtime/src/{types.rs,store.rs,broker.rs}`: terminal write atomico.
- Modify `crates/desktop-gateway/src/main.rs`: recovery e fan-out.
- Create `apps/desktop/src/lib/turnReplayState.{mjs,ts}` and test: reducer sequenziale.
- Modify `apps/desktop/src/components/ChatView.tsx`: snapshot + cursor.

### Task 1: Imporre un terminale atomico

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/src/broker.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn terminal_event_is_written_once() {
    let store = TaskStore::open_in_memory().unwrap();
    let first = store.insert_terminal_event_once("turn", TurnEventKind::Done, json!({"attempt": 2})).unwrap();
    let late = store.insert_terminal_event_once("turn", TurnEventKind::Error, json!({"attempt": 1})).unwrap();
    assert!(matches!(first, TerminalWrite::Inserted(_)));
    assert!(matches!(late, TerminalWrite::Existing(_)));
    assert_eq!(store.read_turn_events("turn", 0).unwrap().len(), 1);
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-task-runtime terminal_event_is_written_once -- --nocapture`

- [ ] **Step 3: Implement the transaction**

```rust
pub enum TerminalWrite { Inserted(TurnEvent), Existing(TurnEvent) }

pub fn insert_terminal_event_once(&self, turn_id: &str, kind: TurnEventKind, payload: Value)
    -> TaskRuntimeResult<TerminalWrite> {
    if !matches!(kind, TurnEventKind::Done | TurnEventKind::Error | TurnEventKind::Cancelled) {
        return Err(TaskRuntimeError::InvalidTransition("non-terminal kind".into()));
    }
    let tx = self.connection.unchecked_transaction()?;
    if let Some(event) = latest_terminal_on(&tx, turn_id)? {
        tx.commit()?;
        return Ok(TerminalWrite::Existing(event));
    }
    let event = insert_turn_event_on(&tx, turn_id, kind, payload)?;
    tx.commit()?;
    Ok(TerminalWrite::Inserted(event))
}
```

Move the current insert SQL into `insert_turn_event_on`. Route completion, failure and cancel through this method; publish only `Inserted`.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-task-runtime terminal_event -- --nocapture
cargo test -p local-first-task-runtime broker -- --nocapture
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs crates/task-runtime/src/broker.rs
git commit -m "fix(runtime): fence logical turn terminals"
```

### Task 2: Applicare replay e snapshot per sequenza

**Files:**
- Create: `apps/desktop/src/lib/turnReplayState.mjs`
- Create: `apps/desktop/src/lib/turnReplayState.ts`
- Create: `apps/desktop/src/lib/turnReplayState.test.mjs`
- Modify: `apps/desktop/src/components/ChatView.tsx`

- [ ] **Step 1: Write RED reducer tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { applyTurnEvent, createTurnReplayState } from "./turnReplayState.mjs";

test("duplicate and post-terminal events are ignored", () => {
  let s = createTurnReplayState("turn");
  s = applyTurnEvent(s, { turn_id: "turn", seq: 1, kind: "delta", payload: { text: "A" } });
  s = applyTurnEvent(s, { turn_id: "turn", seq: 2, kind: "done", payload: {} });
  s = applyTurnEvent(s, { turn_id: "turn", seq: 2, kind: "done", payload: {} });
  s = applyTurnEvent(s, { turn_id: "turn", seq: 3, kind: "retry", payload: {} });
  assert.equal(s.text, "A");
  assert.equal(s.status, "completed");
  assert.equal(s.lastSeq, 2);
});
```

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop && node --test src/lib/turnReplayState.test.mjs`

- [ ] **Step 3: Implement and wire**

```js
export const createTurnReplayState = (turnId) => ({ turnId, lastSeq: 0, status: "running", text: "" });
export function applyTurnEvent(state, event) {
  if (event.turn_id !== state.turnId || event.seq <= state.lastSeq || ["completed", "failed", "cancelled"].includes(state.status)) return state;
  const next = { ...state, lastSeq: event.seq };
  if (event.kind === "delta") next.text += event.payload?.text ?? "";
  if (event.kind === "done") next.status = "completed";
  if (event.kind === "error") next.status = "failed";
  if (event.kind === "cancelled") next.status = "cancelled";
  if (event.kind === "retry") next.status = "retrying";
  return next;
}
```

Seed the reducer from the active-turn snapshot, subscribe with `since=lastSeq`, and replace ad-hoc terminal booleans in `ChatView`.

- [ ] **Step 4: Verify and commit**

```bash
cd apps/desktop
node --test src/lib/turnReplayState.test.mjs
npm run build
git add src/lib/turnReplayState.mjs src/lib/turnReplayState.ts src/lib/turnReplayState.test.mjs src/components/ChatView.tsx
git commit -m "fix(desktop): replay turns by monotonic sequence"
```

### Task 3: Recovery sulla stessa identità e receipt coverage

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Add recovery regressions**

```rust
#[test]
fn recovery_reuses_turn_assistant_and_does_not_reclaim_uncertain_effect() {
    let store = TaskStore::open_in_memory().unwrap();
    let receipt = NewAgentToolReceipt { turn_id: "turn".into(), idempotency_key: "write_file:abc".into(), run_id: "run-1".into(), thread_id: "thread".into(), user_id: "user".into(), workspace_id: "workspace".into(), tool_name: "write_file".into(), arguments_hash: "abc".into() };
    assert!(matches!(store.claim_tool_receipt(&receipt).unwrap(), ToolReceiptClaim::Execute));
    assert!(matches!(store.claim_tool_receipt(&receipt).unwrap(), ToolReceiptClaim::Uncertain(_)));
}
```

- [ ] **Step 2: Run and keep the test GREEN**

Run: `cargo test -p local-first-task-runtime recovery_reuses_turn_assistant_and_does_not_reclaim_uncertain_effect -- --nocapture`

Expected: receipt half passes; add a gateway recovery assertion beside `chat_turn_retry_and_terminal_failure_update_the_stable_assistant` proving the recovered task keeps `assistant_message_id` and emits no attempt-level terminal.

- [ ] **Step 3: Implement recovery routing and commit**

Recovery must call `abort_running_agent_runs("gateway_restart")`, append `aborted_attempt`, reclaim the same task, and read `assistant_message_id` from task input. It must not append `done`, create a user message, or call an effect with `ToolReceiptClaim::Uncertain`.

```bash
cargo test -p local-first-task-runtime tool_receipt -- --nocapture
cargo test -p local-first-desktop-gateway recovery_ -- --nocapture
git add crates/desktop-gateway/src/main.rs crates/task-runtime/src/store.rs
git commit -m "fix(chat): recover attempts without duplicating turns"
```
