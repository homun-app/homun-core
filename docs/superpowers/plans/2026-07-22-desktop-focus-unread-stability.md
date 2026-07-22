# Desktop Focus And Unread Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedire a qualunque evento in background di cambiare task e mostrare un pallino teal fisso per i completamenti non letti, durevole dopo restart.

**Architecture:** La selezione resta user-owned nel desktop. Task runtime e gateway espongono una proiezione `ThreadAttention`; il chat store conserva soltanto il cursore letto. Gli eventi aggiornano cache e sidebar senza invocare la navigazione.

**Tech Stack:** React 19, TypeScript, Node test runner, Rust, Axum, rusqlite/SQLite.

---

## File structure

- Create `apps/desktop/src/lib/threadAttentionState.{mjs,ts}` and test: reducer puro.
- Modify `apps/desktop/src/{App.tsx,types.ts,styles.css}` and `components/{Shell,Sidebar}.tsx`: integrazione UI.
- Modify `apps/desktop/src/lib/coreBridge.ts`: API attention/seen.
- Modify `crates/task-runtime/src/{types.rs,store.rs}`: terminale più recente per thread.
- Modify `crates/desktop-gateway/src/{chat_store.rs,main.rs}`: cursori letti ed endpoint.

### Task 1: Definire selezione e indicatori con un reducer puro

**Files:**
- Create: `apps/desktop/src/lib/threadAttentionState.mjs`
- Create: `apps/desktop/src/lib/threadAttentionState.ts`
- Create: `apps/desktop/src/lib/threadAttentionState.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write the failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createThreadAttentionState, applyThreadSignal, selectThread } from "./threadAttentionState.mjs";

test("background completion never changes selection", () => {
  const initial = createThreadAttentionState("thread_b");
  const next = applyThreadSignal(initial, { threadId: "thread_a", status: "completed", terminalEventId: 41 });
  assert.equal(next.selectedThreadId, "thread_b");
  assert.equal(next.byThread.thread_a, "completed_unread");
});

test("opening the task clears only its unread", () => {
  const unread = applyThreadSignal(createThreadAttentionState("thread_b"), { threadId: "thread_a", status: "completed", terminalEventId: 41 });
  const next = selectThread(unread, "thread_a");
  assert.equal(next.selectedThreadId, "thread_a");
  assert.equal(next.byThread.thread_a, "idle");
  assert.equal(next.seenTerminalEventIds.thread_a, 41);
});
```

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop && node --test src/lib/threadAttentionState.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the reducer**

```js
export function createThreadAttentionState(selectedThreadId = "") {
  return { selectedThreadId, byThread: {}, terminalEventIds: {}, seenTerminalEventIds: {} };
}
export function applyThreadSignal(state, signal) {
  const terminalEventIds = { ...state.terminalEventIds };
  if (signal.terminalEventId != null) terminalEventIds[signal.threadId] = signal.terminalEventId;
  const unread = signal.status === "completed" && signal.threadId !== state.selectedThreadId
    && (signal.terminalEventId ?? 0) > (state.seenTerminalEventIds[signal.threadId] ?? 0);
  const status = unread ? "completed_unread"
    : ["running", "queued", "retrying"].includes(signal.status) ? "working"
    : signal.status === "waiting_user" ? "waiting_user"
    : signal.status === "failed" ? "failed" : "idle";
  return { ...state, terminalEventIds, byThread: { ...state.byThread, [signal.threadId]: status } };
}
export function selectThread(state, threadId) {
  const terminal = state.terminalEventIds[threadId] ?? 0;
  return { ...state, selectedThreadId: threadId, byThread: { ...state.byThread, [threadId]: "idle" }, seenTerminalEventIds: { ...state.seenTerminalEventIds, [threadId]: terminal } };
}
```

Create the typed wrapper with `ThreadAttentionStatus = "idle" | "working" | "completed_unread" | "waiting_user" | "failed"`. Add `test:thread-attention` to `package.json`.

- [ ] **Step 4: Run GREEN and commit**

```bash
cd apps/desktop
npm run test:thread-attention
git add package.json src/lib/threadAttentionState.mjs src/lib/threadAttentionState.ts src/lib/threadAttentionState.test.mjs
git commit -m "test(desktop): define user-owned thread attention state"
```

### Task 2: Proiettare terminale e cursore letto

**Files:**
- Modify: `crates/task-runtime/src/types.rs`
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] **Step 1: Write failing store tests**

```rust
#[test]
fn thread_attention_reports_latest_terminal_event() {
    let s = TaskStore::open_in_memory().unwrap();
    let task = make_chat_turn("turn-a", "thread-a", TaskStatus::Completed);
    s.insert_chat_turn(&task, "thread-a", "chat_stream_1", "interactive", "full").unwrap();
    let event = s.insert_turn_event("turn-a", TurnEventKind::Done, json!({})).unwrap();
    assert_eq!(s.thread_attention("thread-a").unwrap().latest_terminal_event_id, Some(event.event_id));
}

#[test]
fn seen_terminal_cursor_is_monotonic() {
    let store = ChatStore::in_memory().unwrap();
    store.mark_thread_terminal_seen("thread_active_prompt", 9).unwrap();
    store.mark_thread_terminal_seen("thread_active_prompt", 4).unwrap();
    assert_eq!(store.thread_terminal_seen("thread_active_prompt").unwrap(), 9);
}
```

Place the first test in the existing `chat_turn_query_tests` module so it reuses `make_chat_turn`; place the second beside the existing `ChatStore::in_memory` tests.

- [ ] **Step 2: Run RED**

```bash
cargo test -p local-first-task-runtime thread_attention_reports_latest_terminal_event -- --nocapture
cargo test -p local-first-desktop-gateway seen_terminal_cursor_is_monotonic -- --nocapture
```

- [ ] **Step 3: Implement the durable contract**

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThreadAttention {
    pub thread_id: String,
    pub status: String,
    pub latest_terminal_event_id: Option<i64>,
    pub updated_at: i64,
}
```

`thread_attention` selects the latest chat task and greatest terminal `turn_events.event_id`. Add `thread_read_receipts(thread_id PRIMARY KEY, last_seen_terminal_event_id, updated_at)`; update with `MAX(existing, excluded)`. Expose `GET /api/chat/threads/attention` and `POST /api/chat/threads/{thread_id}/seen` with `{terminal_event_id}`.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-task-runtime thread_attention -- --nocapture
cargo test -p local-first-desktop-gateway terminal_cursor -- --nocapture
git add crates/task-runtime/src/types.rs crates/task-runtime/src/store.rs crates/desktop-gateway/src/chat_store.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(chat): persist per-thread completion receipts"
```

### Task 3: Rimuovere la navigazione dagli eventi

**Files:**
- Modify: `apps/desktop/src/App.tsx`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/components/Shell.tsx`
- Modify: `apps/desktop/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing contract assertions**

```js
assertNotContains("src/App.tsx", "navigateToThread(eventThreadId", "background events cannot navigate");
assertContains("src/App.tsx", "refreshThreadInBackground(eventThreadId)", "background events refresh only their cache");
assertContains("src/styles.css", ".thread-status-dot.completed-unread", "completion uses a fixed teal dot");
```

Run: `cd apps/desktop && npm run test:ui-contract`

Expected: FAIL on the current `navigateToThread(eventThreadId, ...)`.

- [ ] **Step 2: Implement the user-owned selection boundary**

Make `refreshChatReadModels` update only the requested thread and never call selection setters. Keep `setActiveThreadId`, `setSelectedTaskId` and `setActiveView("chat")` only in `handleSelectThread`. Attach `incomingBackgroundTurn` only when its thread is already selected. On explicit selection call `markThreadSeen` with the reducer cursor.

Pass `ThreadAttentionStatus` through `Shell` and `Sidebar`. Replace `busy` with `attention` on `ThreadLink`. `.working` pulses; `.completed-unread` is `background: var(--brand)` with `animation: none`; waiting and failed have distinct accessible labels.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/desktop
npm run test:thread-attention
npm run test:ui-contract
npm run build
git add src/App.tsx src/lib/coreBridge.ts src/components/Shell.tsx src/components/Sidebar.tsx src/styles.css scripts/check-ui-contract.mjs
git commit -m "fix(desktop): keep background completions out of navigation"
```
