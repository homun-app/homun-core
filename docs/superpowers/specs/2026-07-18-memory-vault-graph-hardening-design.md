# Memory, Vault, and Project Graph Hardening

**Date:** 2026-07-18
**Status:** Approved design, awaiting implementation plan
**Scope:** Homun Vault boundary, semantic memory integrity, project-code graph import, workspace deletion, and end-to-end verification

## 1. Purpose

Make the persistent knowledge path demonstrably correct rather than relying on green unit tests alone. The system must put sensitive values, semantic memories, project-code entities, relations, wiki projections, and recall provenance in their intended stores; repeated analysis of an unchanged project must converge to the same canonical graph; deleting or revoking a source must fail closed and remove or hide the associated state.

This design hardens the existing architecture. It does not replace SQLite, Graphify, the memory facade, or the Vault encryption model.

## 2. Verified Baseline

The 2026-07-18 read-only audit used consistent temporary backups of the live SQLite databases and removed those backups afterward.

- `memory.sqlite`, `vault.sqlite`, and `desktop-gateway.sqlite` passed `PRAGMA integrity_check`.
- The complete `local-first-memory` suite passed 238 tests serially.
- `local-first-vault` passed 20 tests; the gateway passed 29 Vault-focused tests.
- All 1,466 memories had an FTS row; JSON metadata was valid; canonical entity duplicates were zero.
- The live Vault had a valid system-wrapped keyring but no saved records, so real-data behavior could not be sampled.
- The live memory database contained 64,392 entities and 594,607 relations.
- Graphify relations contained 89,146 duplicate tuples and 488,590 excess rows. The source `graph.json` files already contained duplicate links, and the gateway importer generated a fresh relation UUID for every input link.
- Three project scopes no longer present in `workspaces.json` retained 90 active memories and 49,762 entities.
- Workspace purge used `local` while live memory rows used `local-user`; the store purge also referenced nonexistent `embeddings` and `episodes` tables instead of `memory_embeddings` and `memory_events`.
- Three embeddings had no memory, one wiki link was unresolved, and a small number of semantic relations had missing endpoints.
- Apparent Luhn hits were numeric artifact identifiers also present in artifact metadata, not evidence of raw card values.
- The Homun project graph fingerprint did not match the current Git HEAD, so the current graph was stale.

## 3. Goals

1. An unchanged project analyzed twice produces the same canonical node and edge sets without duplicate rows.
2. Malformed, duplicate, and dangling Graphify input is normalized before persistence.
3. A failed graph import leaves the previous graph and fingerprint intact and never emits a false `project_graph.ready` event.
4. Workspace deletion removes all workspace-owned memory data and graph cache atomically enough to be retryable and observable.
5. A permanent read-only audit reports integrity violations without exposing memory text or Vault values.
6. Repair is explicit, dry-run first, scoped, backed up, and never silently deletes an unknown project scope.
7. Vault values remain encrypted and absent from chat, memory, wiki, event parts, logs, and audit output.
8. Semantic memory, wiki projection, recall, linked-source authorization, revocation, and provenance are verified as one workflow.

## 4. Non-goals

- Replacing Graphify or moving the code graph into a separate database.
- Making Graphify output itself clean; Homun must defend against imperfect extractor output.
- Enforcing global uniqueness on every semantic relation. Repeated evidence for a semantic relation can be legitimate.
- Automatically deleting all historical scopes on startup.
- Reading or printing plaintext Vault values during an audit.
- Redesigning the Memory or Vault user interface beyond surfacing audit/repair status when needed.

## 5. System Invariants

### 5.1 Vault boundary

- `vault_records` contains metadata only; `vault_secret_material` contains ciphertext only.
- A record and its secret material are committed both-or-neither.
- Every secret-material row has a record; record deletion removes both.
- The normal save path deduplicates by normalized `(category, label)` and decrypted value. Explicit `add` remains the only way to keep a deliberate duplicate.
- Memory, wiki, transcript, event parts, and logs may contain only a redacted placeholder or opaque `vault_ref`, never the value.
- Audit output contains counts and opaque identifiers only.

### 5.2 Semantic memory

- Every row is scoped by the canonical local user and an intentional workspace.
- Active memory has a matching FTS row; embeddings refer to an existing memory in the same scope.
- Wiki `linked_refs` resolve in the same scope or are removed during an explicit repair.
- Relations resolve both endpoints in the same scope.
- Exact duplicate episodes and stale open loops are reported separately because their lifecycle semantics differ.
- Personal memory is local-only unless a project has a direct active grant. Grants are not transitive; expiry and revocation fail closed.

### 5.3 Project-code graph

- Node identity is `(user_id, workspace_id, canonical_key)` where Graphify nodes use `code:<node_id>`.
- Edge identity is `(user_id, workspace_id, source_canonical_key, relation_type, target_canonical_key, source=graphify)`.
- Duplicate input nodes and edges collapse before persistence.
- Links whose endpoints are missing after node normalization are rejected and counted, not persisted.
- Project graph replacement is one transaction: validate and normalize in memory, begin transaction, clear the prior Graphify projection, insert the canonical set, commit.
- The persisted fingerprint and `project_graph.ready` event occur only after a successful commit.
- Re-importing identical input produces an identical canonical checksum and row counts.

### 5.4 Workspace lifecycle

- All gateway paths derive the memory user from `gateway_memory_user_id()`; no literal alternate user ID is permitted.
- Purge uses actual schema table names and a transaction inside the memory store.
- Purge covers memories, entities, relations, tombstones, embeddings, events, evidence, wiki pages, routines, automation candidates, access audit, source grants where the workspace is consumer or source, and publication state where applicable.
- Every store purge and graph-cache removal is idempotent. The gateway removes the workspace from `workspaces.json` only after all cleanup steps succeed; a failure leaves the registry entry available for an explicit retry and is never described as success.
- Repeating purge is safe.

## 6. Components

### 6.1 Canonical Graphify normalizer

Introduce a memory-layer normalizer used by the gateway importer. It accepts parsed nodes and links and returns:

- canonical entities;
- canonical relations with deterministic references;
- counts for raw, accepted, duplicate, malformed, and dangling items;
- a stable checksum over sorted canonical node and edge identities.

The normalizer owns identity and validation. The gateway owns project discovery, staleness checks, background execution, and app events. The store owns the replacement transaction.

### 6.2 Import result and failure boundary

Replace the `(usize, usize)` best-effort return with a typed `Result<ProjectGraphImportReport, ProjectGraphImportError>`. No caller may convert import errors to `(0, 0)`. The report is safe to log because it contains counts, checksum, workspace ID, and no source text.

### 6.3 Workspace purge coordinator

The gateway resolves the canonical user once and invokes store-specific purge methods. Each store reports success or a typed failure. Memory purge is transactional. Graph cache deletion follows the store purges, and the workspace registry update is last. If any step fails, the endpoint returns an incomplete-cleanup error and a repeated request safely resumes the idempotent sequence.

### 6.4 Read-only integrity audit

Add a reusable audit service over an SQLite snapshot or read transaction. It reports:

- SQLite integrity and foreign-key status;
- table counts and schema version;
- duplicate canonical entities and Graphify edge tuples;
- missing relation endpoints, orphan embeddings/evidence/wiki links, and FTS coverage;
- registered versus unknown workspace scopes;
- source-grant corruption, expiry, and revocation consistency;
- Vault record/secret orphans, forbidden metadata keys, duplicate normalized keys, and supported keyring algorithms;
- possible sensitive-text detections as counts classified by record type and source, never the matched text.

Audit is read-only and must work without the OS keychain. Plaintext-value equality is therefore validated by synthetic Vault tests, not by decrypting the live Vault.

### 6.5 Explicit repair workflow

Repair consumes an audit report and defaults to dry-run. Before mutation it creates a SQLite backup. Repairs are individually selectable:

- rebuild the Graphify projection from the current `graph.json` through the canonical normalizer;
- remove orphan embeddings and unresolved derived wiki links;
- rebuild FTS;
- purge a specifically approved unknown workspace scope;
- refresh a stale registered project graph.

Semantic-memory merges are not automated by the structural repair. Exact duplicate episodes and stale open loops go through existing lifecycle/consolidation rules so evidence is not discarded blindly.

## 7. End-to-End Workflows

### 7.1 Existing project analysis

1. Create a fixture repository with files, functions, calls, imports, and a rationale document.
2. Produce Graphify input containing deliberate duplicate nodes, duplicate links, and one dangling link.
3. Import into a fresh project scope.
4. Assert canonical node/edge counts, zero duplicate tuples, zero dangling persisted relations, and a successful report.
5. Re-run unchanged and assert the same checksum and counts.
6. Modify one fixture file, rebuild, and assert only the expected canonical graph difference.
7. Delete or rename a symbol and assert stale graph rows disappear after replacement.
8. Force an insert failure and assert the previous graph, fingerprint, and ready-event state remain unchanged.

### 7.2 Memory continuity

1. Analyze the fixture project and create a new project conversation.
2. Save a fact, decision with rationale, goal, and open loop.
3. Assert all records use the project workspace and the expected lifecycle status.
4. Assert extracted entities use stable canonical keys and relations resolve.
5. Rebuild wiki projections and assert every linked ref resolves.
6. Open a new thread in the same project and recall the records with structured local-source provenance.
7. Verify a different project cannot recall them without a direct grant.
8. Grant one selected source/collection, verify recall and provenance, revoke it, and verify immediate fail-closed behavior and cache invalidation.

### 7.3 Vault lifecycle

1. Use a temporary Vault with an injected test wrapping key.
2. Submit a sensitive value through the same gateway save path used by the UI.
3. Assert transcript and normal memory contain only redacted metadata.
4. Save the same logical value with preview drift and assert it is ignored as a duplicate.
5. Verify key-only and value-only conflicts require explicit resolution.
6. Recall the record and expose only the Vault summary/reveal marker.
7. Reveal locally, verify the value never enters persisted transcript or audit output, then delete the record.
8. Assert metadata and secret material are both absent.

## 8. Error Handling and Observability

- Graph extraction failure, JSON parse failure, normalization rejection, transaction failure, fingerprint-write failure, and event-publication failure are distinct stages in logs.
- Logs include workspace ID, stage, safe counts, and checksum; never node source text, memory text, prompts, or secret values.
- The UI may continue showing the last committed graph with a stale/error state. It must not replace it with an empty graph after a failed refresh.
- Purge failures remain retryable and are visible; workspace deletion must not claim complete cleanup when a store failed.
- Repair output lists proposed and completed actions separately.

## 9. Test Strategy

### 9.1 Unit tests

- Graph normalizer: duplicate nodes, duplicate edges, dangling edges, deterministic ordering/checksum.
- Vault dedup and redaction boundaries.
- Audit queries on deliberately corrupted temporary databases.
- Purge table coverage and idempotency.

### 9.2 Integration tests

- Graph replacement transaction and rollback.
- Analyze-twice convergence.
- Workspace purge across memory and graph cache.
- Memory → entity/relation → wiki → recall provenance.
- Direct grant → recall → revoke → cache invalidation.

### 9.3 Regression and real-data verification

- Run the complete Memory and Vault suites serially.
- Run focused gateway Vault, graph, workspace-delete, and linked-memory tests serially.
- Run the audit against consistent read-only copies of live databases.
- Apply any cleanup first to a copy, rerun the audit, and require all structural counters to reach zero before requesting approval for live repair.
- Refresh Homun's project graph and verify two unchanged passes produce the same checksum.

## 10. Acceptance Criteria

- SQLite integrity checks pass.
- Zero duplicate canonical entities.
- Zero duplicate Graphify edge tuples.
- Zero persisted dangling Graphify relations.
- Zero orphan embeddings, evidence links, and wiki links after approved repair.
- One FTS row for every memory row, with active-memory recall verified.
- Analyze-twice checksum and canonical counts are identical.
- Failed imports preserve the prior committed graph and fingerprint.
- Workspace deletion leaves no rows or graph cache for that workspace and is idempotent.
- Project/personal recall isolation, explicit grant, provenance, revocation, and cache invalidation pass end to end.
- Vault synthetic lifecycle passes without plaintext appearing in any non-Vault persistence surface or audit output.
- Live repair is never automatic: the user receives a dry-run report and explicitly approves the scoped mutation.

## 11. Rollout

1. Add failing regression tests for the confirmed defects.
2. Implement normalizer and typed import result.
3. Correct and transactionalize purge.
4. Add audit and dry-run repair services.
5. Run synthetic end-to-end workflows.
6. Audit a fresh copy of live data and validate repair on the copy.
7. Present the live repair plan and exact counts for explicit approval.
8. Apply live repair, refresh Homun's graph, and rerun the full audit and test gates.
