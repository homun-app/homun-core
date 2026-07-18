# Memory Evolution v1

**Date:** 2026-07-18  
**Status:** Approved for implementation  
**Scope:** semantic memory evolution, temporal validity, current recall, inspectable history, and MemoryBench interoperability

## Purpose

Turn Homun's existing lifecycle primitives into a coherent memory-evolution engine. New knowledge must be able to reinforce, replace, extend, derive from, or conflict with existing knowledge without losing history or crossing an unauthorized scope.

The design adopts useful ideas from Supermemory's public graph-memory model and benchmark pipeline, but retains Homun's stronger contracts: personal/project isolation, direct grants, provenance, candidate review, local-first storage, and the Vault boundary.

## Existing foundation

Homun already has:

- scoped `MemoryRecord`, `MemoryRelation`, and `MemoryEvidence` rows;
- `supersedes`, `superseded_by`, `correction_of`, lifecycle status, and audit events;
- fact, preference, decision, goal, open-loop, and episode types;
- FTS+dense hybrid recall with importance and recency;
- explicit linked-memory grants and retained source provenance;
- transactional SQLite writes and inspectable history.

The missing layer is a single validated operation that applies semantic evolution consistently and a standard evaluation harness that measures the resulting recall.

## Invariants

1. Evolution is always confined to one exact `(user_id, workspace_id)` scope.
2. A linked source can be read only through its active direct grant; it is never mutated by the consumer project.
3. Vault records and secret-bearing text never enter semantic evolution.
4. `updates` preserves the previous record, marks it superseded, and makes the new record current atomically.
5. `extends` keeps both records current and creates a typed, evidenced relation.
6. `derives` always creates a candidate, never an auto-confirmed fact.
7. `conflict` keeps both records visible for review and never chooses a winner automatically.
8. `duplicate` reinforces the canonical record without creating a second row.
9. Expiry marks a record stale; it never deletes history.
10. Recall excludes superseded and expired records by default, while history/audit views retain them.
11. Repeating the same evolution request is idempotent.

## Model

### Evolution kinds

- `independent`: a new standalone memory.
- `duplicate`: the same claim; reinforce the target.
- `updates`: the new claim replaces an older claim.
- `extends`: the new claim adds compatible detail.
- `derives`: the new claim is an inference based on existing memories.
- `conflict`: the claims disagree, but the system cannot safely pick a winner.

### Temporal state

The typed temporal/evolution envelope is stored under the reserved `metadata.evolution` key so the first release does not require a destructive schema rewrite:

```json
{
  "kind": "updates",
  "target_refs": ["memory:..."],
  "valid_from": 1784419200,
  "valid_until": null,
  "last_confirmed_at": 1784419200,
  "reinforcement_count": 1,
  "classifier": "extractor-v1",
  "classifier_confidence": 0.94
}
```

The envelope is parsed and validated through Rust types. Callers never manipulate these JSON keys directly.

## Write workflow

1. The extractor produces a normal `ExtractedMemory` plus an optional evolution proposal.
2. Homun resolves only candidate targets in the same scope and rejects missing, stale, deleted, secret, or cross-scope targets.
3. A deterministic store transaction applies the selected evolution kind.
4. FTS, evidence, typed relations, supersession fields, and lifecycle event are committed together.
5. Vector/briefing generations are invalidated only after commit.
6. Low-confidence classification degrades to `conflict` or `independent`; it never silently supersedes.

The initial automatic classifier uses explicit extractor output plus deterministic validation. Later versions may use a separate local classifier, but the store contract remains model-independent.

## Read workflow

`MemoryRecord::is_current_at(now)` is the shared predicate for semantic recall:

- status is `Confirmed` or, where the caller explicitly allows it, `Candidate`;
- `superseded_by` is absent;
- `valid_until` is absent or greater than `now`;
- the record is not tombstoned.

Normal recall and always-on briefings use current records. The Memory UI can request history and display the evolution chain, evidence, temporal bounds, and review state.

## Expiry and reinforcement

- A maintenance pass finds active memories whose `valid_until <= now` and transitions them to `Stale` with reason `temporal_expiry`.
- Reinforcement increments `reinforcement_count`, advances `last_confirmed_at`, and raises confidence conservatively without exceeding `1.0`.
- Repeated preferences become stronger; episodes do not become durable facts merely through repetition.

## Automatic classification boundary

The extractor may emit:

```json
"evolution": {
  "kind": "updates|extends|derives|conflict|independent",
  "target_ref": "memory:...",
  "valid_from": 1784419200,
  "valid_until": null,
  "confidence": 0.0
}
```

Only opaque refs from the active scope are exposed to the extractor context. The validator applies these rules:

- `updates` requires confidence `>= 0.80` and an active target;
- `extends` requires confidence `>= 0.70`;
- `derives` and `conflict` always remain candidates;
- an invalid or missing target becomes `independent`, never a guessed cross-record mutation;
- exact/high-similarity duplicates are handled deterministically before model classification.

## MemoryBench interoperability

Add a small TypeScript provider package conforming to MemoryBench's public `Provider` interface:

- `initialize` configures a local Homun gateway only;
- `ingest` creates an isolated benchmark workspace and imports ordered sessions;
- `awaitIndexing` polls a metadata-only status endpoint;
- `search` returns current recall items with refs, provenance, score, and no secret values;
- `clear` deletes the benchmark workspace through the governed purge endpoint.

Homun-specific evals extend the public benchmark categories with:

- cross-project denial without a grant;
- direct-grant recall and revocation;
- update/extend/derive history correctness;
- repeated-ingest idempotency;
- expiry and abstention;
- zero Vault leakage.

## Rollout

1. Introduce typed evolution metadata and pure validation.
2. Add the atomic store/facade operation and focused tests.
3. Route extracted memories through the operation.
4. Apply current-record filtering and temporal maintenance.
5. Add history projection and MemoryBench provider adapter.
6. Run memory, gateway, and full repository gates before integration.

## Non-goals

- Replacing SQLite, embeddings, or the existing recall engine.
- Importing Supermemory's `containerTag` authorization model.
- Deleting expired or superseded history.
- Auto-confirming inferred memories.
- Sending Vault values or secret memories to any classifier or benchmark.
- Making a cloud memory provider the Homun default.

## Acceptance criteria

- Duplicate ingestion creates no extra active memory row.
- Update, extend, derive, conflict, and independent paths are transactional and idempotent.
- Cross-scope targets fail closed without mutation.
- Current recall returns the new fact after an update and omits the superseded fact.
- Expired records become stale and remain inspectable.
- Derived facts remain candidates with evidence.
- Evolution relations contain no dangling refs.
- MemoryBench adapter contract tests pass with a fake local gateway.
- Existing project/personal grant, Vault, Graphify, and full workspace tests remain green.
