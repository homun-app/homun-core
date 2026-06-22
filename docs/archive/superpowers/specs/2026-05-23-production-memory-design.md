# Production Memory Design

## Goal

Bring the memory component from a tested MVP to a production-ready local-first subsystem that can be used by UI, runtime and subagents without bypassing privacy, audit, user isolation or backend boundaries.

## Definition Of Done

The memory component is production-ready when these conditions are true:

- All persisted data is schema-versioned and migrated idempotently.
- All user-facing and agent-facing reads go through a facade or read model that applies policy and records audit decisions.
- Memory records have a complete lifecycle: create, update, confirm, reject, stale, merge and delete.
- User corrections are modeled explicitly and become audited candidate updates.
- Search and retrieval support privacy-safe filters, ranking and pagination.
- Wiki sync is bidirectional enough for user corrections: DB projects to Markdown, Markdown changes return as candidate updates.
- Graphify is reachable only through a policy-gated query adapter, not by direct UI or subagent access.
- Local encryption, backup, restore and maintenance paths are tested.
- The Rust crate exposes stable public APIs with typed errors instead of broad string errors at production boundaries.
- The full project test suite passes.

## Architecture

SQLite remains the operational source of truth for events, memory records, entities, relations, evidence, wiki metadata, access audit, tombstones and maintenance metadata. Graphify remains a separate technical/document graph engine and is accessed through a memory adapter. The wiki remains a human-readable projection and correction surface, not the source of raw events.

The public boundary is `MemoryFacade` plus specialized read/query models. Store internals can remain directly testable, but UI, runtime and subagents must not use store methods directly. Subagents receive only `MemoryContextPack` or scoped retrieval responses built from `MemoryAccessRequest`.

## Data Model

Memory records need production timestamps and lifecycle metadata:

- `created_at`: first persisted timestamp.
- `updated_at`: last content or metadata change.
- `last_seen_at`: last supporting observation.
- `supersedes`: refs merged into this memory.
- `superseded_by`: canonical replacement ref when merged.
- `correction_of`: ref being corrected when a candidate comes from wiki or UI.

The existing `MemoryStatus` values remain valid:

- `candidate`
- `confirmed`
- `rejected`
- `stale`
- `deleted`

Deletes remain logical tombstones by default. Hard deletion is reserved for explicit local erasure flows and must define cascading behavior before it is exposed.

## Lifecycle API

The facade exposes lifecycle operations with explicit actor, purpose and audit:

- create memory candidate.
- update memory text, aliases, language hints, domain, sensitivity and metadata.
- confirm candidate memory.
- reject candidate memory with reason.
- mark confirmed memory stale with reason.
- merge multiple refs into one canonical ref.
- tombstone any memory ref.

Every lifecycle operation must preserve user/workspace isolation and return stable refs.

## User Corrections

Corrections can originate from UI or wiki sync. They are not applied silently to confirmed facts unless the operation is an explicit update by an authorized actor.

Default behavior:

- UI direct edit creates an audited update when the actor has write permission.
- Wiki changed text creates a candidate correction linked through `correction_of`.
- Domain or sensitivity changes are treated as sensitive updates and audited.
- Conflicting corrections do not overwrite each other; they become separate candidates with refs and evidence.

## Search And Retrieval

Search uses SQLite FTS as the production baseline. Local embeddings are outside this closure and must fit behind the same retrieval contracts when added.

Retrieval requirements:

- filter by user and workspace.
- filter by privacy domains and max sensitivity through `MemoryAccessRequest`.
- filter by status, memory type and reference kind.
- deterministic ranking.
- cursor or offset pagination.
- no raw event payloads in search results.
- audit allowed and denied retrieval attempts.

## Wiki Sync

The wiki layer supports:

- vault path configuration.
- deterministic page templates.
- DB to Markdown projection with frontmatter refs.
- Markdown to candidate correction parsing.
- sync report with created, updated, unchanged, conflicted and rejected counts.
- no raw secret content in generated pages.

## Graphify Adapter

Graphify integration supports two paths:

- import `graph.json` artifacts into internal entities and relations.
- query/path/explain commands through a memory-owned adapter.

The adapter must:

- validate artifact paths remain inside allowed local directories.
- preserve Graphify ids in metadata.
- return scoped refs and summaries instead of broad graph dumps.
- apply memory policy before returning results to UI or subagents.

## Privacy, Encryption And Audit

Privacy domains and sensitivity are first-class fields. Reads must deny or redact data outside the request scope. Broad export requires explicit permission. Raw event payload access is denied by default.

Encryption stays application-level. The crate exposes a key provider interface and production code can inject a key provider. Tests use development providers. Restores must fail clearly when the configured key cannot decrypt encrypted payloads.

Audit must be queryable by UI with privacy-safe summaries:

- actor id.
- purpose.
- decision kind.
- reasons.
- timestamp.
- affected ref when available.

## Operations

Production operations include:

- health/stats for memory counts, schema version and audit count.
- backup to a local file.
- restore from a local file into an empty or explicitly replaceable store.
- maintenance task for integrity checks and FTS rebuild.

No cloud API, Ollama, external hosted service or remote sync is allowed for memory operations.

## Testing

Required test coverage:

- schema migration idempotency.
- multiuser and workspace isolation for every public read/write path.
- lifecycle transitions and invalid transitions.
- merge semantics and tombstone visibility.
- UI and subagent retrieval policy enforcement.
- FTS search filters and pagination.
- wiki correction import and conflict handling.
- Graphify query adapter policy gating.
- backup/restore with encrypted payloads.
- maintenance integrity checks.
- full `make test` pass.
