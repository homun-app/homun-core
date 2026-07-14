# Broker Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pasted and dragged images survive broker enqueue, reach the vision model, and remain visible in the persisted user message.

**Architecture:** The existing `chat_turn` task remains the sole chat path. The desktop client sends an explicit image array alongside normalized file attachments; the task runtime preserves both in `input_json`; the executor converts them into the canonical `ChatGenerateStreamRequest` and writes transcript metadata in the atomic enqueue transaction.

**Tech Stack:** TypeScript/React desktop bridge, Rust/Axum gateway, Rust task runtime, SQLite chat store.

---

### Task 1: Preserve the broker payload

**Files:**
- Modify: `apps/desktop/src/lib/chatApi.ts`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `crates/desktop-gateway/src/lib.rs`
- Modify: `crates/task-runtime/src/broker.rs`
- Test: `crates/task-runtime/src/broker.rs`

- [x] **Step 1: Write the failing broker regression test**

Add a `ChatTurnInput` with `images: vec!["data:image/png;base64,AA==".into()]` to the existing task-runtime tests, enqueue it, reload the task, and assert `input_json["images"]` equals that array.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `cargo test -p local-first-task-runtime broker -- --nocapture`

Expected: the test does not compile because `ChatTurnInput` has no `images` field.

- [x] **Step 3: Add the minimal broker and API fields**

Add `images: Vec<String>` to `ChatTurnInput`; persist it as `"images"` in both task JSON constructors. Add `images: Vec<String>` with `#[serde(default)]` to `EnqueueTurnRequest`. Add `images?: string[]` to `enqueueTurn` options and include it in the JSON body. In `coreBridge.ts`, pass inline images to `enqueueTurn` and normalize files with:

```ts
attachments: attachments?.length
  ? attachments.map(toGatewayAttachmentInput)
  : undefined,
images,
```

- [x] **Step 4: Run the focused test to verify it passes**

Run: `cargo test -p local-first-task-runtime broker -- --nocapture`

Expected: PASS.

### Task 2: Feed and persist the queued turn inputs

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Test: `crates/desktop-gateway/src/chat_store.rs`
- Test: `crates/desktop-gateway/src/turn_executor.rs`

- [x] **Step 1: Write the failing persistence regression test**

Extend `ChatStore` tests with an atomic `insert_linked_user_message` call that receives an inline-image attachment object containing `kind: "image"` and `preview_url: "data:image/png;base64,AA=="`; reload the thread and assert the exact attachment object remains.

- [x] **Step 2: Run the focused test to verify it fails**

Run: `cargo test -p local-first-desktop-gateway linked_user_message -- --nocapture`

Expected: the test does not compile because the atomic insertion accepts no attachments.

- [x] **Step 3: Add the minimum canonical conversion**

In `enqueue_chat_turn_core`, derive transcript attachment JSON from normalized file inputs and inline images, then pass it to `insert_linked_user_message`. Extend that store method to write `attachments_json` in its `INSERT`. In `turn_executor`, deserialize `input_json["attachments"]` as `Vec<AttachmentInput>` and `input_json["images"]` as `Vec<String>`, defaulting to empty on absent legacy tasks; pass both into `run_agent_turn_into_message_with_fanout`, which fills the canonical request fields rather than `Vec::new()`.

- [x] **Step 4: Run the focused tests to verify they pass**

Run: `cargo test -p local-first-desktop-gateway linked_user_message -- --nocapture`

Expected: PASS.

### Task 3: Document and verify the end-to-end contract

**Files:**
- Modify: `docs/architecture/agent-loop.md`
- Test: `apps/desktop` build and UI contract

- [x] **Step 1: Document the broker input boundary**

Add one sentence to the request-path section: image `data:` URLs and normalized file attachments are durable `chat_turn` inputs; the executor is responsible for making both model-visible and preserving transcript metadata.

- [x] **Step 2: Run static and package gates**

Run:

```bash
cargo test -p local-first-task-runtime broker -- --nocapture
cargo test -p local-first-desktop-gateway linked_user_message -- --nocapture
(cd apps/desktop && npm run typecheck && npm run test:ui-contract && npm run build)
```

Expected: all commands exit 0.

- [x] **Step 3: Commit the implementation**

```bash
git add apps/desktop/src/lib/chatApi.ts apps/desktop/src/lib/coreBridge.ts \
  crates/task-runtime/src/broker.rs crates/desktop-gateway/src/lib.rs \
  crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/turn_executor.rs \
  crates/desktop-gateway/src/chat_store.rs docs/architecture/agent-loop.md \
  docs/superpowers/plans/2026-07-14-broker-image-attachments.md
git commit -m "fix(chat): preserve inline images through broker turns"
```
