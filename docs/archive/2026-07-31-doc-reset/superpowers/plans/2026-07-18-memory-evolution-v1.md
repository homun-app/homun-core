# Memory Evolution v1 Implementation Plan

> **Execution:** apply test-driven development task by task. Do not merge unrelated Presentations work and do not add `Co-Authored-By` trailers.

**Goal:** Make Homun evolve memories through validated update/extend/derive/conflict/duplicate operations, enforce temporal currency in recall, and expose a MemoryBench-compatible local provider.

**Architecture:** Typed evolution metadata lives over the existing `MemoryRecord` schema. `SQLiteMemoryStore` owns one atomic mutation boundary; `MemoryFacade` owns policy, audit, and cache invalidation; `learn.rs` supplies validated proposals; recall consumes one shared current-memory predicate. The benchmark adapter talks only to the local gateway.

**Worktree:** `/Users/fabio/Projects/Homun/app/.worktrees/memory-evolution-v1-core`
**Branch:** `fabio/memory-evolution-v1-core`

## Task 1: Typed evolution and temporal contract

**Files:**
- Create: `crates/memory/src/evolution.rs`
- Modify: `crates/memory/src/lib.rs`
- Modify: `crates/memory/src/schema.rs`
- Create: `crates/memory/tests/memory_evolution.rs`

- [ ] Add red tests for parsing/round-trip, current-at-time, invalid temporal ranges, cross-scope targets, and derive-never-confirmed.
- [ ] Add `MemoryEvolutionKind`, `MemoryEvolutionMetadata`, `MemoryEvolutionProposal`, `MemoryEvolutionResult`, validation, and metadata helpers.
- [ ] Add `Extends` and `ConflictsWith` to the typed relation vocabulary.
- [ ] Run `cargo test -p local-first-memory --test memory_evolution evolution_contract -- --nocapture`.
- [ ] Commit: `feat(memory): define memory evolution contract`.

## Task 2: Atomic store and facade operation

**Files:**
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/tests/memory_evolution.rs`

- [ ] Add red tests for duplicate reinforcement, update supersession, compatible extension, derived candidate, unresolved conflict, idempotent request replay, and forced rollback.
- [ ] Implement `SQLiteMemoryStore::apply_memory_evolution` with an immediate transaction, same-scope validation, FTS updates, evidence, relations, and evolution event persistence.
- [ ] Implement `MemoryFacade::evolve_memory` with policy audit and post-commit cache invalidation.
- [ ] Run the focused test file and the complete `local-first-memory` suite serially.
- [ ] Commit: `feat(memory): apply memory evolution atomically`.

## Task 3: Route learned memories through evolution

**Files:**
- Modify: `crates/memory/src/learn.rs`
- Modify: `crates/memory/src/types.rs` only if extraction DTO validation requires it
- Modify: `crates/memory/tests/learning_pipeline.rs` or add focused tests in `learn.rs`

- [ ] Add red tests for a model-proposed update, invalid target fail-closed fallback, deterministic duplicate reinforcement, and derive staying candidate.
- [ ] Include bounded active-memory candidates with opaque refs in the extractor prompt.
- [ ] Parse optional evolution metadata and validate confidence thresholds.
- [ ] Replace the current create-only path with `evolve_memory`; retain gap/open-loop behavior as compatibility logic.
- [ ] Run learning and memory suites.
- [ ] Commit: `feat(memory): evolve extracted knowledge against active scope`.

## Task 4: Current recall, expiry, and inspectable history

**Files:**
- Modify: `crates/memory/src/recall.rs`
- Modify: `crates/memory/src/search.rs`
- Modify: `crates/memory/src/consolidate.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/ui.rs`
- Modify: `crates/memory/tests/recall.rs`
- Modify: `crates/memory/tests/ui_read_model.rs`

- [ ] Add red tests proving superseded/expired memories are absent from current recall but present in history.
- [ ] Add `expire_due_memories(now)` and idempotent stale transitions.
- [ ] Use the shared current predicate in semantic recall, briefings, consolidation inputs, and source candidates.
- [ ] Expose evolution chain and temporal fields in the memory detail projection without exposing text from unauthorized scopes.
- [ ] Run recall/UI tests and the complete memory suite.
- [ ] Commit: `feat(memory): recall only current temporal knowledge`.

## Task 5: MemoryBench provider and Homun governance scenarios

**Files:**
- Create: `benchmarks/memorybench/homun-provider/package.json`
- Create: `benchmarks/memorybench/homun-provider/src/index.ts`
- Create: `benchmarks/memorybench/homun-provider/src/types.ts`
- Create: `benchmarks/memorybench/homun-provider/test/provider.test.ts`
- Create: `benchmarks/memorybench/README.md`
- Modify: `scripts/pre_release_gate.py`

- [ ] Add red contract tests with a fake gateway for initialize/ingest/awaitIndexing/search/clear.
- [ ] Implement the public MemoryBench provider interface against localhost-only Homun endpoints.
- [ ] Add governance fixtures: isolation, direct grant+revoke, update history, repeated ingest, expiry, abstention, and Vault non-leakage.
- [ ] Add deterministic adapter tests to the pre-release gate; network/model benchmarks remain explicit opt-in.
- [ ] Commit: `test(memory): add MemoryBench provider adapter`.

## Task 6: Integration and release gate

- [ ] Run `RUST_TEST_THREADS=1 cargo test -p local-first-memory -- --test-threads=1`.
- [ ] Run focused gateway memory, grant, integrity, Graphify, and Vault tests.
- [ ] Run `make test`.
- [ ] Run `python3 scripts/pre_release_gate.py` and require `== ALL GREEN ==`.
- [ ] Request independent code review and address every blocker.
- [ ] Fast-forward only onto the intended base after reconciling concurrent Presentations work; push only after verifying `main` and `origin/main` scope.
