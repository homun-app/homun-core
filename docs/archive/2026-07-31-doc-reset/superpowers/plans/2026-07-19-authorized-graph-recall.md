# Authorized Graph Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project recall consult every directly authorized memory collection, find a small set of query-relevant seed memories, and expand those seeds through the existing typed graph without adding another persistent memory layer.

**Architecture:** SQLite remains canonical for memories, entities, relations, grants, and tombstones. The existing lexical/vector search finds seed memories inside each exact authorized source; a bounded two-hop breadth-first traversal then follows only safe, same-source graph edges and materializes only memories that still pass the source policy. Markdown remains a projection and is not duplicated into a recall catalog.

**Tech Stack:** Rust workspace (`local-first-memory`, `local-first-engine`, `local-first-desktop-gateway`), SQLite/rusqlite, React/TypeScript desktop event contracts.

---

### Task 1: Remove keyword collection exclusion

**Files:**
- Modify: `crates/memory/src/recall.rs:193-274,526-580`
- Modify: `crates/memory/tests/multi_source_recall.rs:1-80,430-560`

- [ ] **Step 1: Write the failing tests**

Replace the keyword-router assertions with behavior tests proving that a query does not need collection-specific words:

```rust
#[test]
fn linked_recall_searches_every_granted_collection_without_keyword_activation() {
    let fixture = MultiSourceFixture::new();
    fixture.insert(
        "__personal__",
        "personal-code",
        "fact",
        "Il codice personale confermato è NEBULA-7429",
        serde_json::json!({"scope": "personal"}),
        &[1.0, 0.0],
    );
    fixture.grant(
        "grant-personal",
        "__personal__",
        [MemoryCollectionKey::Profile],
        HashMap::new(),
    );

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "Qual è il codice personale confermato?",
        &[1.0, 0.0],
        1_800_000_000,
        None,
    )
    .expect("recall");

    assert!(pack.hits.iter().any(|hit| hit.text.contains("NEBULA-7429")));
}
```

Update the existing grant-collection test so both `Preferences` and `Goals` are returned when both are directly granted, regardless of words in the query. Keep the individual `Allow` test, but assert that it adds the allowed artifact without suppressing either granted collection.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cargo test -p local-first-memory --test multi_source_recall linked_recall_searches_every_granted_collection_without_keyword_activation -- --exact
```

Expected: FAIL because `Profile` is removed by `memory_recall_intent` for this wording.

- [ ] **Step 3: Remove the keyword gate**

Delete `MemoryRecallIntent` and `memory_recall_intent`. In `recall_authorized_sources_on_facade_with_source_filter`, pass each resolved `AuthorizedMemorySource` unchanged to `recall_source_on_facade`; the source policy itself remains the collection authorization boundary. Individual `Allow` and `Deny`, sensitivity limits, direct-grant resolution, final policy revalidation, and source auditing remain unchanged.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
cargo test -p local-first-memory --test multi_source_recall
```

Expected: all multi-source recall tests pass.

### Task 2: Add bounded, authorization-preserving graph traversal

**Files:**
- Modify: `crates/memory/src/store.rs:2875-2915`
- Modify: `crates/memory/src/facade.rs:1252-1383`
- Modify: `crates/memory/src/service.rs:95-127`
- Modify: `crates/memory/src/recall.rs:738-882`
- Modify: `crates/memory/tests/multi_source_recall.rs`

- [ ] **Step 1: Write the failing graph expansion test**

Create two authorized memories that do not share query words, link both to one safe entity using `mentions`, and assert the second memory is recalled with a two-edge path:

```rust
#[test]
fn recall_expands_seed_through_same_source_graph() {
    let fixture = MultiSourceFixture::new();
    let seed = fixture.insert(
        "project-b",
        "atlas-decision",
        "decision",
        "Atlas release uses the September window",
        serde_json::json!({}),
        &[],
    );
    let related = fixture.insert(
        "project-b",
        "isolation-fact",
        "fact",
        "Personal knowledge remains isolated unless explicitly linked",
        serde_json::json!({}),
        &[],
    );
    let entity = fixture.insert_entity("project-b", "project:atlas", "Atlas");
    fixture.link("project-b", "seed-mentions", &seed, "mentions", &entity);
    fixture.link("project-b", "related-mentions", &related, "mentions", &entity);
    fixture.grant(
        "grant-b",
        "project-b",
        [MemoryCollectionKey::Decisions, MemoryCollectionKey::Knowledge],
        HashMap::new(),
    );

    let pack = recall_authorized_sources_on_facade(
        &fixture.facade,
        &fixture.user,
        &fixture.consumer,
        "Quale finestra usa Atlas?",
        &[],
        1_800_000_000,
        None,
    )
    .expect("graph recall");
    let expanded = pack.hits.iter().find(|hit| hit.memory_ref == related.to_string()).unwrap();
    assert_eq!(expanded.graph_path, vec!["mentions", "mentions"]);
}
```

Add a second test using an explicit `Deny` override for `related`; assert that the seed remains and the related memory is absent. Add a third assertion that all expanded hit references stay in `source_workspace_id`, proving the traversal never crosses into another grant.

- [ ] **Step 2: Run the graph tests to verify RED**

Run:

```bash
cargo test -p local-first-memory --test multi_source_recall recall_expands_seed_through_same_source_graph -- --exact
```

Expected: FAIL because recall currently returns only lexical/vector seed hits and `RecallHit` has no graph path.

- [ ] **Step 3: Add an exact touching-edge store query**

Add `SQLiteMemoryStore::visible_relations_touching_exact` using one scoped SQL query:

```sql
where (r.source_ref = ?1 or r.target_ref = ?1)
  and r.user_id = ?2
  and r.workspace_id = ?3
  and not exists (
    select 1 from tombstones t
    where t.ref = r.ref and t.user_id = r.user_id and t.workspace_id = r.workspace_id
  )
order by r.ref
```

Return an empty list before SQL when the input reference does not exactly match the requested user/workspace.

- [ ] **Step 4: Add the facade traversal boundary**

Introduce a crate-visible result:

```rust
pub(crate) struct AuthorizedGraphMemory {
    pub record: MemoryRecord,
    pub seed_ref: MemoryRef,
    pub relation_path: Vec<String>,
}
```

Add `MemoryFacade::related_authorized_memories_for_source(source, seeds, max_hops, limit)`. It must:

- clamp traversal to two hops and a fixed node budget;
- accept only exact same-user/same-workspace references;
- accept only safe relation tokens, allowed privacy domains, non-secret sensitivity within the grant ceiling, and secret-free metadata;
- traverse an entity only when its identity and payload are safe under the same ceiling;
- materialize a memory only through `get_authorized_memory_for_source`;
- never enqueue a denied or stale memory as an intermediate bridge;
- use deterministic breadth-first ordering and return at most `limit` unique memories.

- [ ] **Step 5: Materialize related hits in recall**

Add `graph_path: Vec<String>` to `RecallHit`. After direct hits are ranked, use their references as seeds and request at most four related memories at depth two. Give an expanded hit the originating seed score multiplied by `0.75` per hop, preserve source/grant/policy provenance, and rank direct hits before graph-expanded hits when other semantic priorities tie. Keep the final per-source and merged recall limits unchanged.

- [ ] **Step 6: Run graph and isolation tests to verify GREEN**

Run:

```bash
cargo test -p local-first-memory --test multi_source_recall
cargo test -p local-first-memory --test memory_evolution
cargo test -p local-first-memory --test source_grants
```

Expected: all tests pass; graph history, grant isolation, and current-only behavior remain green.

### Task 3: Preserve graph provenance through prompt and stream events

**Files:**
- Modify: `crates/memory/src/service.rs:216-240`
- Modify: `crates/engine/src/events.rs:8-36,144-170`
- Modify: `crates/desktop-gateway/src/main.rs:1800-1818,13990-14070`
- Modify: `apps/desktop/src/lib/coreBridge.ts:367-387`

- [ ] **Step 1: Write the failing serialization and prompt tests**

Extend the engine serialization test with:

```rust
graph_path: vec!["mentions".to_string(), "mentions".to_string()],
```

and assert `value["graph_path"]` contains both edges. Remove the property before deserializing and assert a legacy event receives an empty path. In the memory test, build one expanded `RecallHit` and assert `RecallPack::from_hits(...).block` contains `graph: mentions -> mentions`.

- [ ] **Step 2: Run the focused tests to verify RED**

Run:

```bash
cargo test -p local-first-engine recall_stream_hit_serializes_source_provenance -- --exact
cargo test -p local-first-memory --lib format_recall_hits_marks_graph_expansion
```

Expected: FAIL because graph provenance is not serialized or formatted.

- [ ] **Step 3: Wire structured provenance**

Add `#[serde(default)] pub graph_path: Vec<String>` to `RecallStreamHit`, map it from `RecallHit` in the gateway, and initialize it to `Vec::new()` in legacy/manual hit constructors. Add `graph_path?: string[]` to `RecallHitPayload` for persisted event compatibility. Format graph-expanded prompt entries as `[source: <label>; graph: edge -> edge] <text>` while leaving direct entries unchanged.

- [ ] **Step 4: Run contract checks to verify GREEN**

Run:

```bash
cargo test -p local-first-engine
cargo test -p local-first-desktop-gateway recall
```

Expected: engine and gateway recall tests pass.

### Task 4: Document and verify the complete behavior

**Files:**
- Modify: `docs/MEMORIA.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Document the canonical flow**

Document: query-relevant seeds are found in every direct authorized source; graph traversal stays within the exact source/grant policy; SQL is canonical; Markdown is a readable projection; no keyword collection activation and no transitive grants; expansion is capped at two hops and four related memories per source.

- [ ] **Step 2: Run formatting**

Run:

```bash
cargo fmt --all -- --check
```

Expected: exit 0. If it reports only formatting differences, run `cargo fmt --all` and repeat the check.

- [ ] **Step 3: Run final verification**

Run:

```bash
cargo test -p local-first-memory
cargo test -p local-first-engine
cargo test -p local-first-desktop-gateway recall
```

Then from `apps/desktop` run:

```bash
npm install
npm run typecheck
```

Expected: every command exits 0. Report any pre-existing warning separately and do not call an excluded suite green.
