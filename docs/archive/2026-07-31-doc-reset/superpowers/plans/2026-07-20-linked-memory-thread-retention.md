# Linked Memory Thread Retention Implementation Plan

> **For Codex:** Execute task by task with TDD. Never weaken the `UserInputOnly` learning firewall while changing context retention.

**Goal:** Keep an already-used linked-memory-derived answer available to the same conversation after unlink/revocation, while blocking new retrieval, new-thread reuse, and any copy into project memory.

**Architecture:** Persist a structurally valid provenance envelope with every linked-memory-informed response. Automatic briefing items retain provenance through budget selection and travel through the same recall event path as on-demand recall. Historical context trusts that persisted conversation attestation instead of re-authorizing an old read; malformed or unknown attestations remain fail-closed.

**Tech stack:** Rust, SQLite, `local-first-memory`, `local-first-engine`, `local-first-desktop-gateway`, Cargo integration tests.

---

## Task 1: Centralize structural attestation validation

**Files:** `crates/memory/src/service.rs`, `crates/desktop-gateway/src/chat_store.rs`

1. Add failing tests for valid and invalid `Normal`, `UserInputOnly`, and `BlockedUnknown` envelopes.
2. Run `CARGO_TARGET_DIR=/tmp/homun-linked-context-target cargo test -p local-first-memory memory_reuse_envelope`; expect failure because the validator does not exist.
3. Add `MemoryReuseEnvelope::is_structurally_valid()` and make `chat_store.rs` use it instead of its duplicate private validator.
4. Re-run focused memory and chat-store tests.
5. Commit as `refactor(memory): centralize reuse attestation validation`.

## Task 2: Retain attested answers inside the existing conversation

**Files:** `crates/desktop-gateway/src/main.rs`

1. Change tests first: complete `UserInputOnly` messages must remain in model context after the grant disappears; multiple complete reads remain one historical message; `BlockedUnknown` and malformed envelopes remain omitted; the stored visible message is never rewritten.
2. Run `CARGO_TARGET_DIR=/tmp/homun-linked-context-target cargo test -p local-first-desktop-gateway revoked_linked_answer -- --nocapture`; expect failure under current revalidation behavior.
3. Make `context_message_for_model` accept structurally valid `Normal` and `UserInputOnly` envelopes without checking current grants. Fresh briefing/recall continues to use current authorization.
4. Re-run focused context tests.
5. Commit as `fix(memory): retain attested linked answers in thread context`.

## Task 3: Preserve provenance through automatic briefing selection

**Files:** `crates/memory/src/service.rs`, `crates/desktop-gateway/src/main.rs`

1. Add failing tests proving: a selected linked personal preference carries source workspace, grant, policy version, reference, and source revision; a budget-excluded item is not attested; cached briefings retain selected provenance; local project items create no linked attestation.
2. Add a private structured briefing candidate containing display text and optional `RecallHit` provenance. Compute revisions with the canonical memory helper.
3. Keep the existing string formatter as a compatibility wrapper. Add a provenance-aware formatter returning the block plus only the linked hits whose lines fit the budget.
4. Add `linked_hits: Vec<RecallHit>` to `BriefingPack`; preserve it through cache hits, rebuilds, fallbacks, and all explicit constructors. Do not change `ordered_blocks()`.
5. Run memory-service and gateway briefing tests.
6. Commit as `feat(memory): attest linked automatic briefing reads`.

## Task 4: Unify briefing and recall provenance in the durable turn

**Files:** `crates/desktop-gateway/src/main.rs`; touch `crates/desktop-gateway/src/chat_store.rs` only if event compatibility requires it.

1. Add failing tests proving: briefing-only linked hits seed `LoopState.memory_reads`; briefing and on-demand hits merge without duplicates; the stream collector derives `UserInputOnly`; atomic finalization accepts the requested envelope; `Exchange::learn_material()` exposes only current user input.
2. Convert selected briefing hits to `RecallStreamHit`, merge them with on-demand recall hits by stable source/grant/ref/revision identity, and emit the canonical payload before narration.
3. Reuse the existing pipeline: briefing -> recall stream event -> loop read set -> assistant event parts -> reuse envelope -> learning policy.
4. Run stream collector, atomic chat-store finalization, and firewall tests.
5. Commit as `fix(memory): unify briefing provenance with turn attestation`.

## Task 5: Prove the isolation boundary end to end

**Files:** `crates/desktop-gateway/tests/linked_memory_read_only.rs`, and `crates/memory/tests/linked_memory_firewall.rs` only if a contract assertion is needed.

1. Add a regression scenario: create linked source memory; grant it; use it in an answer; revoke; verify the old answer remains in the same thread, fresh recall and a new thread cannot obtain it, post-turn learning creates no project copy, and old provenance remains attached.
2. Run:
   - `CARGO_TARGET_DIR=/tmp/homun-linked-context-target cargo test -p local-first-memory --test linked_memory_firewall -- --nocapture`
   - `CARGO_TARGET_DIR=/tmp/homun-linked-context-target cargo test -p local-first-desktop-gateway --test linked_memory_read_only -- --nocapture`
   - `CARGO_TARGET_DIR=/tmp/homun-linked-context-target cargo test -p local-first-memory`
   - `CARGO_TARGET_DIR=/tmp/homun-linked-context-target cargo test -p local-first-desktop-gateway`
   - `git diff --check`
3. If any suite is excluded or hangs, report it explicitly and do not describe the whole change as green.
4. Commit as `test(memory): prove linked thread retention isolation`.

## Task 6: Review and integration readiness

Review the branch diff against `docs/superpowers/specs/2026-07-20-linked-memory-thread-retention-design.md`. Confirm there is no keyword trigger, transitive grant, background copy, or unbounded context store. Format touched Rust files, repeat `git diff --check`, and verify the worktree is clean before integration.
