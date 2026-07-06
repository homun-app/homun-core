# Memory Identity Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make personal and project memory converge on canonical identities before graph/wiki projection.

**Architecture:** `MemoryFacade` owns semantic mutations. Contacts, graph UI, wiki editing, automation delete, and future graph drag actions call canonical memory primitives, then regenerate derived graph/wiki views. SQL memory remains the source of truth; graph and wiki are synchronized faces.

**Tech Stack:** Rust gateway, `local-first-memory`, SQLite memory store, React graph UI in a later slice.

---

### Task 1: Canonical Entity Merge Foundation

**Files:**
- Modify: `crates/memory/src/facade.rs`
- Test: `crates/memory/tests/graph.rs`

- [x] Add `MemoryFacade::merge_entities(survivor_ref, absorbed_ref, user_id, workspace_id, reason)`.
- [x] Repoint relations from absorbed entity to survivor.
- [x] Merge aliases and preserve absorbed metadata under survivor metadata.
- [x] Mark absorbed entity with `merged_into`, then tombstone it.
- [x] Verify graph UI listings hide absorbed nodes while survivor keeps moved aliases/relations.

### Task 2: Owner Channel Identity Guard

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/chat_store.rs`

- [x] Add a pure owner-channel resolver using approval channel/target.
- [x] When inbound sender is the owner, create/promote the contact as `is_self`.
- [x] Upsert `person:self` with the channel handle as alias.
- [x] Do not create `person:telegram:*` or `person:whatsapp:*` entities for owner handles.
- [x] Attribute owner inbound learning to the user, not to a contact speaker.

### Task 3: Contact Merge Converges Into Memory Graph

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Keep contact merge as UX/read-model operation.
- [x] When both contacts have `entity_ref`, call `MemoryFacade::merge_entities`.
- [x] Keep conservative tombstone fallback only when refs are missing or unparsable.

### Task 4: Profile Wiki Hygiene

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Generate `profilo.md` from confirmed facts/preferences only.
- [x] Keep candidate memories in the management surface, not in the consolidated wiki.

### Task 5: Project Root Identity

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Add tests near workspace/memory graph tests.

- [x] Upsert one deterministic project root entity when a workspace is created, renamed, or assigned a folder.
- [x] Use `canonical_key = "workspace:<workspace_id>"`.
- [x] Store name, previous names, folder path, and basename as aliases/metadata.
- [x] Prevent the extractor from creating competing project roots for the active workspace.
- [x] Treat names like "Pitch Homun" as `topic`/`initiative`/`artifact`, not root projects.

### Task 6: Reconciliation After Mutations

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/memory/src/facade.rs`

- [x] Add a single `reconcile_memory_scope(workspace_id)` path that clears/regenerates mention edges, removes stale derived graph edges, and rebuilds wiki pages.
- [x] Call it after entity merge, memory correction/delete, wiki save, automation delete, and project rename/folder update.
- [x] Link automations to memory refs/entities so deletion stales or deletes the corresponding memory/wiki entries by ref, not text search.

### Task 7: Graph UI Merge Operations

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Add backend endpoint in `crates/desktop-gateway/src/main.rs`

- [x] Add explicit graph `Merge mode`.
- [x] Support select-two-nodes and drag-onto-node as UI gestures.
- [x] Show a preview modal with survivor, absorbed node, aliases, and relation counts.
- [x] Confirm action calls a backend endpoint backed by `MemoryFacade::merge_entities`.
- [x] Refresh graph and wiki after success.

### Task 8: Memory Hygiene Suggestions

**Files:**
- Add backend read model near memory graph endpoint.
- Add UI panel in Memory view.

- [x] Detect safe auto-merge candidates: same verified handle/email or owner handle.
- [x] Detect suggestions: same normalized person name, with verified-handle matches marked safe.
- [x] Never auto-merge same-name-only people.
- [x] Allow `Merge`, `Ignore`, and `Do not suggest again`.
