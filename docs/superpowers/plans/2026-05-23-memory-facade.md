# Memory Facade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete local-first memory facade with SQLite, graph refs, wiki projection, privacy policy, anti-exfiltration, multiuser isolation and application-level encryption.

**Architecture:** Create a new Rust crate `crates/memory` instead of extending subagents. The crate exposes focused modules: contracts, refs, policy, crypto, SQLite store, wiki adapter, graph facade and high-level facade/context pack.

**Tech Stack:** Rust 2024, `rusqlite`, `serde`, `serde_json`, `uuid`, `chacha20poly1305`, `rand`, `base64`, standard filesystem APIs.

---

### Task 1: Crate And Contracts

**Files:**
- Create: `crates/memory/Cargo.toml`
- Create: `crates/memory/src/lib.rs`
- Create: `crates/memory/src/types.rs`
- Create: `crates/memory/src/refs.rs`
- Test: `crates/memory/tests/contracts.rs`

- [ ] Add crate to workspace.
- [ ] Define user/workspace/domain/sensitivity/status/ref types.
- [ ] Define event, memory, entity, relation, evidence and wiki contracts.
- [ ] Test serialization and stable ref parsing.
- [ ] Commit: `Add memory facade contracts`.

### Task 2: SQLite Store

**Files:**
- Create: `crates/memory/src/store.rs`
- Test: `crates/memory/tests/sqlite_store.rs`

- [ ] Create schema for events, memories, entities, relations, evidence, wiki pages, audit and tombstones.
- [ ] Implement CRUD operations with user/workspace filters.
- [ ] Implement logical tombstones.
- [ ] Test create/read/update/delete isolation.
- [ ] Commit: `Add SQLite memory store`.

### Task 3: Policy And Redaction

**Files:**
- Create: `crates/memory/src/policy.rs`
- Create: `crates/memory/src/redaction.rs`
- Test: `crates/memory/tests/policy.rs`

- [ ] Implement access decisions for domains, sensitivity, raw payloads and export.
- [ ] Implement secret redaction for JSON/string payloads.
- [ ] Audit allowed and denied access through the store.
- [ ] Test privacy domains, sensitivity, broad export and redaction.
- [ ] Commit: `Add memory access policy`.

### Task 4: Encryption

**Files:**
- Create: `crates/memory/src/crypto.rs`
- Test: `crates/memory/tests/crypto.rs`

- [ ] Implement `KeyProvider`.
- [ ] Implement `DevelopmentKeyProvider`.
- [ ] Implement encrypted JSON envelope with XChaCha20-Poly1305.
- [ ] Encrypt sensitive event and memory payloads in store writes.
- [ ] Test round-trip and wrong-key failure.
- [ ] Commit: `Encrypt sensitive memory payloads`.

### Task 5: Graph And Wiki Facades

**Files:**
- Create: `crates/memory/src/graph.rs`
- Create: `crates/memory/src/wiki.rs`
- Test: `crates/memory/tests/graph.rs`
- Test: `crates/memory/tests/wiki.rs`

- [ ] Implement graph node/relation helpers over SQLite entities/relations.
- [ ] Implement Markdown wiki writer with frontmatter refs.
- [ ] Reject wiki writes containing raw secrets.
- [ ] Test graph links and wiki round-trip.
- [ ] Commit: `Add graph and wiki memory adapters`.

### Task 6: High-Level Facade And Context Packs

**Files:**
- Create: `crates/memory/src/facade.rs`
- Test: `crates/memory/tests/facade.rs`
- Modify: `docs/work-memory.md`

- [ ] Expose `MemoryFacade` methods for CRUD, policy-gated context reads and wiki projection.
- [ ] Build `MemoryContextPack` for subagents with refs, redacted summaries and evidence.
- [ ] Test end-to-end memory flow.
- [ ] Update work memory.
- [ ] Run `make test`.
- [ ] Commit: `Complete memory facade`.
