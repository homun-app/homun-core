# Production command foundation implementation plan

> Execution: superpowers:subagent-driven-development, with independent bounded implementation and separate review. Fabio authorized autonomous execution of the foundations proposal; no additional implementation confirmation is needed.

**Goal:** Replace unsafe command replay and snapshot persistence, split command ownership into bounded modules, and enforce architectural constraints while preserving the current application.

**Architecture:** Feature command handlers behind a compatibility facade; a repository owns SQLite concurrency and atomic writes. Domain decisions remain independent of transport. Cross-store external effects are not claimed atomic until an outbox contract is implemented and verified.

**Stack:** Existing Python/Pydantic/SQLite/FastAPI/DBOS and React/TypeScript. No new orchestrator.

## Baseline and scope

The current tree contains substantial prior uncommitted work. A tracked/untracked, gitignore-respecting archive was saved under `/Users/fabio/.codex/backups/homun2-foundations-20260919-090746`. Work proceeds on `fabio/production-foundations`, retaining that work. Do not commit unrelated baseline files or publish.

The first tranche covers commands, incremental persistence, modularization, and enforceable architecture checks. Authentication/crypto/packaging and full outbox delivery must be explicitly reported as uncompleted if not reached; no claim of production readiness from these changes alone.

## Tasks

- [x] Repository: add regression cases for no-op saves, delta writes, rollback after failed save, mismatched workspace, stale snapshot rejection across independent handles, and transaction-bound command execution. Retain roundtrip and backup compatibility.
- [x] Replace full-table deletion with bounded delta persistence and database generation compare-and-swap. Keep migrations isolated and fail closed on unknown schema/workspace. Expose a transaction context for the application boundary, no provider calls inside database transactions.
- [x] Command identity: canonical JSON fingerprint bound to actor/workspace/type/payload. Same id with changed payload or actor is rejected; identical key ordering replays; old unverifiable records fail closed. Persist fingerprint through restart.
- [x] Split `DomainService` into feature handlers with explicit context/dependencies, no mixins or reflective inheritance. Retain only compatibility dispatch and queries in the facade. Run all existing domain-specific tests after extraction.
- [x] HTTP/SSE: unify command admission and persistence, preserve user messages on model failures, only emit persisted after commit, prevent stale saves. Keep interpretation outside storage transactions and report conflicts/errors explicitly.
- [x] Architecture: automated module boundaries, file growth limits and a shrinking explicit legacy baseline; CI runs backend/frontend checks. Existing oversized files may not grow.
- [x] Validate selected regressions, full backend suite and frontend `npm run check`; diagnose any process shutdown leak. Independent review first against scope, then for correctness.
- [x] Update the production proposal and development status with measured outcomes and remaining blockers; include exact test evidence and a bounded next tranche.

## Acceptance examples

```python
first = service.apply(actor, 'same', 'conversation.create', {'title': 'A'})
assert service.apply(actor, 'same', 'conversation.create', {'title': 'A'}) == first
with pytest.raises(ConflictError):
    service.apply(actor, 'same', 'conversation.create', {'title': 'B'})
```

```python
left = repo1.load()
right = repo2.load()
left.projects["project_1"] = Project(id="project_1", workspace_id=left.workspace_id, name="Changed")
repo1.save(left)
with pytest.raises(ConflictError):
    repo2.save(right)  # stale generation must never overwrite another writer
```

Tests must assert meaningful durable state, not merely mock calls. For no-op persistence use SQLite change counters or trace statements; rollback tests reopen the database and inspect the committed state. Run tests with the repository's existing venv and avoid credentials/network.

## Validation commands

`cd engine && .venv/bin/pytest -q tests/test_command_identity.py tests/test_storage_transactions.py`

`npm run engine:test`

`npm run check`

The repository and handler changes can be developed independently. Review integration before declaring this tranche complete. No successful unit run is evidence of live models, packaged desktop, encryption or multi-device operation.

## Delivery boundary

Executed on 2026-09-19. See `docs/research/2026-09-19-production-foundations-delivery.md` for final measured results.

Command admission uses the repository transaction API; provider generation occurs outside it. Runtime intents now share the command transaction and dispatch after commit, including cancellation fencing. HTTP material ingestion remains a separate snapshot/file operation and requires the documented blob staging/finalization follow-up. No-op saves do not advance generation; the stale-snapshot example above includes an actual mutation.

This plan is complete for the delivered tranche, not the full A–F production proposal. Release blockers and legacy frontend size debt remain explicit.
