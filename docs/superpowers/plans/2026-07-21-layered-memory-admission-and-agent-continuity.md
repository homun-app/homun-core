# Layered Memory Admission and Agent Continuity Implementation Plan

> Execute test-first. Keep the user's deleted build assets and untracked screenshot untouched.

**Goal:** Make post-turn learning evidence-aware and scope-correct, expose real prompt layers, preserve clean transcript/journal continuity, avoid duplicate starter tasks, and verify current Usage without fabricating history.

**Architecture:** The current `Exchange` becomes the authority boundary: current user text is the only automatic durable-memory source, while the assistant answer and actions are explicitly observed evidence for the episode. `persist_learn_extraction` records a bounded exchange event, applies deterministic admission and scope routing, then supplies only admitted graph material to the gateway. Prompt packets are split into actual content layers before provider composition. Existing SQLite stores remain canonical.

**Tech stack:** Rust workspace (`memory`, `engine`, `desktop-gateway`, `task-runtime`), rusqlite, serde, React/TypeScript desktop contracts.

---

## Task 1: Add red tests for trusted-vs-observed learning

**Files:**
- Modify: `crates/memory/src/learn.rs`
- Modify: `crates/memory/tests/linked_memory_firewall.rs`
- Add: `crates/memory/tests/layered_admission.rs`

1. Add fixtures for a personal explicit preference, a personal assistant-derived technical conclusion, an explicit confirmation, and a project tool observation.
2. Assert prompt labeling makes current assistant/actions episode-only.
3. Assert personal assistant-derived facts cannot become confirmed, project findings cannot route personal, and candidate age does not promote.
4. Run the focused tests and confirm they fail for the expected reasons.

## Task 2: Implement the admission envelope and remove age promotion

**Files:**
- Modify: `crates/memory/src/service.rs`
- Modify: `crates/memory/src/learn.rs`
- Modify: `crates/memory/src/types.rs` only if a small typed helper is required
- Modify: affected memory tests

1. Label extractor input as trusted user assertion/confirmation vs observed assistant outcome/actions.
2. Require extractor `metadata.admission.origin`; deterministically degrade missing/invalid origin to candidate/episode-only.
3. Rewrite scope metadata to the actual destination and attach `admission` provenance.
4. Set status from admission + certainty + evolution kind; never from confidence alone.
5. Remove automatic time-based promotion from learn and maintenance paths while preserving explicit lifecycle confirmation.
6. Run memory unit/integration tests.

## Task 3: Record exchange evidence and filter graph persistence

**Files:**
- Modify: `crates/memory/src/learn.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Add/modify: graph and learning tests in both crates

1. Create a sanitized, bounded `MemoryEvent` per touched destination scope.
2. Link every accepted memory to its event through `MemoryEvidence`.
3. Carry event refs into accepted relation evidence.
4. Filter entities to explicit accepted relation endpoints or names/aliases mentioned by an accepted memory.
5. Route project entities and relations together; create `person:self` only when referenced.
6. Prove repeat analysis keeps node/relation counts stable and creates no orphan self/topic nodes.

## Task 4: Turn prompt packet metadata into real layered content

**Files:**
- Modify: `crates/engine/src/prompt_packets.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: prompt inspector/contract tests as needed

1. Add red tests for ordered non-empty `core`, `workspace`, `project`, `thread`, and `runtime` packets.
2. Capture bounded workspace memory/briefing as its own packet.
3. Capture thread contact/perimeter/binding context separately.
4. Keep jail-scoped project instruction packets.
5. Keep transient mode/route/plan/tool controls in runtime.
6. Confirm composed prompt semantics remain stable and inspector fingerprints match actual packet content.

## Task 5: Improve no-progress evidence without misusing effect receipts

**Files:**
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/engine/src/loop_state.rs`
- Modify: `crates/engine/src/execution_journal.rs`
- Modify: `crates/desktop-gateway/src/working_ledger.rs`
- Modify: focused engine/gateway tests

1. Add red tests for differently parameterized failures in the same tool family.
2. Classify bounded tool outcomes and fingerprint redacted summaries.
3. Track consecutive no-progress outcomes per objective/tool family.
4. Emit a strategy-change nudge after two and force honest synthesis after three.
5. Project the bounded evidence into the Working Ledger; leave effect receipts at-most-once only.

## Task 6: Store clean assistant text with legacy compatibility

**Files:**
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs` only if stream finalization needs adjustment
- Modify: `crates/desktop-gateway/src/lib.rs`/tests as needed

1. Add a red atomic-finalization test containing reasoning/activity/plan markers and structured event parts.
2. Strip display/internal markers from the canonical `text` during finalization.
3. Preserve structured event parts and fail-closed reuse envelope behavior.
4. Keep legacy row parsing and prompt reconstruction tests green.

## Task 7: Remove duplicate starter tasks

**Files:**
- Modify: `crates/desktop-gateway/src/chat_store.rs`
- Modify: `crates/desktop-gateway/src/main.rs` if startup ordering requires it
- Modify: `apps/desktop/src/lib/chatApi.ts`/`apps/desktop/src/App.tsx` only if persistence is client-triggered

1. Add red tests for a fresh DB using the base workspace and for create-on-empty reuse.
2. Seed from `HOMUN_WORKSPACE_ID`/`local-workspace`, not hard-coded `default`.
3. Reuse an untouched one-message starter task in the same workspace.
4. Verify a second task is created after real user content exists.

## Task 8: Verify current Usage and full relevant gates

**Files:**
- Modify Usage code only if fresh-version tests fail
- Add/update focused Usage fixture tests if required

1. Run memory, engine, task-runtime, gateway focused suites and desktop typecheck.
2. Run `git diff --check` and narrow formatting for touched Rust files.
3. Start an isolated current-version gateway/profile, execute one fresh chat turn, and inspect Usage rows for provider/model/thread/turn/run and truthful token/cost provenance.
4. Confirm the old pre-Usage chat remains absent without backfill.
5. Inspect the resulting personal/project memories, evidence, graph counts, transcript text, journal, and starter-thread count.
6. Report exact passed, excluded, and environment-dependent gates; do not tag/release unless separately requested after this implementation is proven.
