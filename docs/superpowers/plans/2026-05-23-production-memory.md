# Production Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the memory crate as a production-ready local-first subsystem with lifecycle APIs, search, wiki correction sync, Graphify query access, operations and full test coverage.

**Architecture:** Keep `MemoryFacade` as the public boundary for writes and scoped reads. Split production features into focused modules: schema/migrations stay in `store.rs`, lifecycle in `lifecycle.rs`, search in `search.rs`, wiki sync in `wiki_sync.rs`, Graphify queries in `graphify_query.rs`, and operational support in `operations.rs`.

**Tech Stack:** Rust 2024, rusqlite bundled SQLite, SQLite FTS5, serde/serde_json, existing chacha20poly1305 application encryption, existing Python MLX tests through `make test`.

---

### Task 1: Schema Versioning And Timestamps

**Files:**
- Modify: `crates/memory/src/types.rs`
- Modify: `crates/memory/src/store.rs`
- Test: `crates/memory/tests/schema.rs`

- [ ] Write tests that opening a store creates schema metadata, running migrations twice is idempotent, and memory rows round-trip `created_at`, `updated_at`, `last_seen_at`, `supersedes`, `superseded_by` and `correction_of`.
- [ ] Run `cargo test -p local-first-memory --test schema` and verify it fails because the fields and schema API do not exist.
- [ ] Add timestamp and lifecycle-link fields to `MemoryRecord`.
- [ ] Add `schema_metadata` and migration helpers to `SQLiteMemoryStore::init`.
- [ ] Alter existing tables idempotently with `pragma table_info` checks.
- [ ] Update all memory row inserts/selects and existing tests to populate the new fields.
- [ ] Run `cargo test -p local-first-memory --test schema` and existing memory tests.
- [ ] Commit as `Add production memory schema metadata`.

### Task 2: Lifecycle Facade

**Files:**
- Create: `crates/memory/src/lifecycle.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/lib.rs`
- Modify: `crates/memory/src/store.rs`
- Test: `crates/memory/tests/lifecycle.rs`

- [ ] Write tests for create candidate, update, confirm, reject, stale, merge and tombstone through `MemoryFacade`.
- [ ] Write tests for invalid transitions, cross-user denial and audit count changes.
- [ ] Run `cargo test -p local-first-memory --test lifecycle` and verify missing API failures.
- [ ] Add lifecycle request/response types with actor, purpose, ref, reason and update patch fields.
- [ ] Implement store update helpers that preserve stable refs and timestamps.
- [ ] Implement facade lifecycle methods that validate user/workspace scope and write audit entries.
- [ ] Ensure merged memories set `superseded_by` on source refs and `supersedes` on canonical refs.
- [ ] Run lifecycle tests plus `cargo test -p local-first-memory`.
- [ ] Commit as `Add audited memory lifecycle API`.

### Task 3: Search And Retrieval

**Files:**
- Create: `crates/memory/src/search.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/lib.rs`
- Test: `crates/memory/tests/search.rs`

- [ ] Write tests for FTS search, privacy domain filtering, sensitivity filtering, status/type filters, offset pagination and deterministic ranking.
- [ ] Run `cargo test -p local-first-memory --test search` and verify missing API failures.
- [ ] Add `MemorySearchRequest`, `MemorySearchResult` and `MemorySearchPage`.
- [ ] Add SQLite FTS5 table and triggers or explicit refresh logic for memory text and aliases.
- [ ] Implement policy-gated facade search that audits allowed and denied results.
- [ ] Ensure search never returns raw event payloads.
- [ ] Run search tests plus `cargo test -p local-first-memory`.
- [ ] Commit as `Add policy gated memory search`.

### Task 4: Wiki Bidirectional Correction Sync

**Files:**
- Create: `crates/memory/src/wiki_sync.rs`
- Modify: `crates/memory/src/wiki.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/lib.rs`
- Test: `crates/memory/tests/wiki_sync.rs`

- [ ] Write tests for deterministic page projection, frontmatter parsing, changed Markdown becoming candidate corrections, unchanged pages being ignored, and secret content rejection.
- [ ] Run `cargo test -p local-first-memory --test wiki_sync` and verify missing API failures.
- [ ] Add vault config, sync report and correction candidate types.
- [ ] Implement safe frontmatter parser for the wiki metadata the writer emits.
- [ ] Implement Markdown-to-correction import that links candidates with `correction_of`.
- [ ] Ensure conflicting edits create separate candidates instead of overwriting confirmed facts.
- [ ] Run wiki sync tests plus `cargo test -p local-first-memory`.
- [ ] Commit as `Add wiki correction sync`.

### Task 5: Graphify Query Adapter

**Files:**
- Create: `crates/memory/src/graphify_query.rs`
- Modify: `crates/memory/src/graphify.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/lib.rs`
- Test: `crates/memory/tests/graphify_query.rs`

- [ ] Write tests for query/path/explain command construction, allowed-directory validation, policy-filtered results and denied broad graph dumps.
- [ ] Run `cargo test -p local-first-memory --test graphify_query` and verify missing API failures.
- [ ] Add query request/result types with `MemoryAccessRequest`.
- [ ] Implement a command builder that does not execute shell in tests.
- [ ] Parse Graphify JSON output into scoped refs and summaries.
- [ ] Expose facade methods for query, path and explain that apply policy before returning results.
- [ ] Run Graphify query tests plus `cargo test -p local-first-memory`.
- [ ] Commit as `Add policy gated Graphify queries`.

### Task 6: Operations, Backup And Maintenance

**Files:**
- Create: `crates/memory/src/operations.rs`
- Modify: `crates/memory/src/store.rs`
- Modify: `crates/memory/src/facade.rs`
- Modify: `crates/memory/src/lib.rs`
- Test: `crates/memory/tests/operations.rs`

- [ ] Write tests for health stats, backup to local file, restore into an empty store, encrypted payload restore failure with wrong key, and FTS maintenance rebuild.
- [ ] Run `cargo test -p local-first-memory --test operations` and verify missing API failures.
- [ ] Add `MemoryHealth`, `MemoryBackupReport`, `MemoryRestoreMode` and `MemoryMaintenanceReport`.
- [ ] Implement local-only backup using SQLite backup or safe file copy for file-backed stores.
- [ ] Implement restore that refuses to overwrite non-empty stores unless explicitly requested.
- [ ] Implement maintenance integrity check and FTS rebuild.
- [ ] Run operations tests plus `cargo test -p local-first-memory`.
- [ ] Commit as `Add memory operations support`.

### Task 7: Production Boundary Cleanup And Docs

**Files:**
- Modify: `docs/memory/memory-facade-design.md`
- Modify: `docs/work-memory.md`
- Modify: `PROJECT.md`
- Test: full suite

- [ ] Update design docs to match completed APIs and production closure.
- [ ] Update `docs/work-memory.md` with what changed and why.
- [ ] Run `make test`.
- [ ] Run `git status --short` and ensure only intended files are changed.
- [ ] Commit as `Document production memory completion`.
