# Logical Turn And Transcript Isolation Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completare il lifecycle presente in v0.1.1076 garantendo una sola risposta valida e impedendo a reasoning o output degenerato di diventare transcript.

**Architecture:** I piani `logical-turn-terminal-lifecycle` e `queued-steering-chat-status` restano la base già parzialmente implementata. L'engine applica un quality gate canonico; il gateway conserva reasoning soltanto nel journal; il desktop ignora reasoning come contenuto e mostra activity sintetica.

**Tech Stack:** Rust, React 19, TypeScript, Node test runner.

---

## File structure

- Modify `crates/engine/src/{markers.rs,agent_loop.rs,outcome.rs}`: verdetto di delivery.
- Modify `crates/desktop-gateway/src/{main.rs,chat_store.rs}`: persistenza solo della risposta.
- Create `apps/desktop/src/lib/chatVisibleContent.{mjs,ts}` and test: filtro client.
- Modify `apps/desktop/src/{types.ts,App.tsx}` and `components/{ChatView,RichMessage}.tsx`: nessun reasoning nel transcript.

### Task 1: Rifiutare risposte reasoning-only o degenerate

**Files:**
- Modify: `crates/engine/src/markers.rs`
- Modify: `crates/engine/src/outcome.rs`
- Modify: `crates/engine/src/agent_loop.rs`

- [ ] **Step 1: Write failing quality tests**

```rust
#[test]
fn delivery_text_rejects_pathological_repetition() {
    let raw = "Inter Inter Interessante essante essante il browse il browse il browse ha trovato ha trovato";
    assert_eq!(delivery_text(raw), Err(DeliveryTextError::DegenerateRepetition));
}

#[test]
fn delivery_text_keeps_normal_prose() {
    assert_eq!(delivery_text("Molto bene. Bene davvero: il test è passato.").unwrap(),
               "Molto bene. Bene davvero: il test è passato.");
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-engine delivery_text_ -- --nocapture`

Expected: missing `delivery_text` and `DeliveryTextError`.

- [ ] **Step 3: Implement the canonical verdict**

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeliveryTextError { Empty, DegenerateRepetition }

pub fn delivery_text(text: &str) -> Result<String, DeliveryTextError> {
    let visible = strip_display_markers(&normalize_reasoning_markers(text)).trim().to_string();
    if visible.is_empty() { return Err(DeliveryTextError::Empty); }
    let tokens = visible.split_whitespace().map(|v| v.to_lowercase()).collect::<Vec<_>>();
    if tokens.len() >= 10 {
        let adjacent = tokens.windows(2).filter(|pair| pair[0] == pair[1]).count();
        let unique = tokens.iter().collect::<std::collections::HashSet<_>>().len();
        if adjacent >= 3 || unique * 3 < tokens.len() {
            return Err(DeliveryTextError::DegenerateRepetition);
        }
    }
    Ok(visible)
}
```

Make `visible_answer` delegate to `delivery_text(...).ok()`. Normal completion and forced synthesis set `TurnDelivery::Delivered` only from `delivery_text`; a degenerate verdict follows the existing no-visible-answer retry/error path.

- [ ] **Step 4: Run GREEN and commit**

```bash
cargo test -p local-first-engine delivery_text_ -- --nocapture
cargo test -p local-first-engine visible_answer_ -- --nocapture
cargo test -p local-first-engine agent_loop::tests -- --nocapture
git add crates/engine/src/markers.rs crates/engine/src/outcome.rs crates/engine/src/agent_loop.rs
git commit -m "fix(engine): reject degenerate visible answers"
```

### Task 2: Togliere il reasoning dal modello di messaggio desktop

**Files:**
- Create: `apps/desktop/src/lib/chatVisibleContent.mjs`
- Create: `apps/desktop/src/lib/chatVisibleContent.ts`
- Create: `apps/desktop/src/lib/chatVisibleContent.test.mjs`
- Modify: `apps/desktop/src/components/RichMessage.tsx`
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/types.ts`
- Modify: `apps/desktop/src/App.tsx`

- [ ] **Step 1: Write failing client tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { visibleMessageText, visibleEventParts } from "./chatVisibleContent.mjs";

test("reasoning is discarded", () => {
  assert.equal(visibleMessageText("‹‹REASONING››segreto‹‹/REASONING››\nRisposta"), "Risposta");
  assert.deepEqual(visibleEventParts([{ type: "reasoning", text: "raw" }, { type: "activity", text: "Uso il browser" }]),
                   [{ type: "activity", text: "Uso il browser" }]);
});
```

- [ ] **Step 2: Run RED**

Run: `cd apps/desktop && node --test src/lib/chatVisibleContent.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement and wire the filter**

```js
const CLOSED = /(?:‹‹REASONING››|<think(?:ing)?>)[\s\S]*?(?:‹‹\/REASONING››|<\/think(?:ing)?>)/gi;
const OPEN = /(?:‹‹REASONING››|<think(?:ing)?>)[\s\S]*$/gi;
export const visibleMessageText = (text) => text.replace(CLOSED, "").replace(OPEN, "").trim();
export const visibleEventParts = (parts = []) => parts.filter((part) => part?.type !== "reasoning");
```

Remove `reasoning` from `ChatEventPart`; make `mapCoreChatEventParts`, `normalizeChatEventParts` and `chatEventPartFromStream` discard it. Delete `ReasoningBlock` from `RichMessage.tsx`; render only `visibleMessageText(text)`. Activity remains in Inspector and `AssistantThinkingState`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
cd apps/desktop
node --test src/lib/chatVisibleContent.test.mjs
npm run test:ui-contract
npm run build
git add src/lib/chatVisibleContent.mjs src/lib/chatVisibleContent.ts src/lib/chatVisibleContent.test.mjs src/components/RichMessage.tsx src/components/ChatView.tsx src/types.ts src/App.tsx
git commit -m "fix(desktop): keep raw reasoning out of chat"
```

### Task 3: Verificare una bolla e nessun reasoning persistito

**Files:**
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `docs/STATO.md`

- [ ] **Step 1: Add the regression test**

```rust
#[test]
fn finalization_drops_reasoning_parts_but_keeps_recall() {
    let store = ChatStore::in_memory().unwrap();
    let thread = store.create_thread("default").unwrap();
    let assistant = local_first_desktop_gateway::seeded_ready_message(
        &thread.thread_id,
        "assistant-reasoning-filter".to_string(),
    );
    store.append_assistant_message(&thread.thread_id, &assistant).unwrap();
    let parts = vec![
        serde_json::json!({"type": "reasoning", "text": "private"}),
        serde_json::json!({"type": "recall", "payload": {"hits": []}}),
    ];
    let saved = store.finalize_assistant_message(
        &thread.thread_id,
        &assistant.id,
        "Risposta finale.",
        &parts,
        &MemoryReuseEnvelope::normal(),
    ).unwrap();
    assert_eq!(saved.text, "Risposta finale.");
    assert_eq!(saved.event_parts.len(), 1);
    assert_eq!(saved.event_parts[0]["type"], "recall");
}
```

- [ ] **Step 2: Run RED**

Run: `cargo test -p local-first-desktop-gateway finalization_drops_reasoning_parts_but_keeps_recall -- --nocapture`

- [ ] **Step 3: Filter persistence and run GREEN**

At finalization, store only response text and non-reasoning event parts; reasoning remains in `turn_events` and execution journal. Extend `chat_turn_retry_and_terminal_failure_update_the_stable_assistant` with an assistant-message count assertion after both retry and terminal failure, proving both transitions update the existing bubble.

```bash
cargo test -p local-first-desktop-gateway finalization_drops_reasoning_parts_but_keeps_recall -- --nocapture
cargo test -p local-first-desktop-gateway chat_turn_retry_and_terminal_failure_update_the_stable_assistant -- --nocapture
```

- [ ] **Step 4: Commit**

```bash
git add crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/chat_store.rs docs/STATO.md
git commit -m "fix(chat): isolate transcript delivery from reasoning"
```
