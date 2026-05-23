# Memory Facade Design

## Goal

Build the memory layer as a complete local-first component with one facade and separate stores for operational SQLite data, graph relations, and human-readable wiki pages.

## Principles

- Language-agnostic and multilingual by default.
- Multiuser and workspace-aware from the first schema.
- Privacy domains are first-class, not metadata added later.
- Every read goes through policy, anti-exfiltration and audit.
- SQLite, graph and wiki remain separate backends linked by stable refs.
- Sensitive payloads are encrypted at the application layer.
- Deletes create tombstones and make refs non-returnable by default.

## Memory Backends

### SQLite Store

Source of operational truth:

- events
- memory records
- entities
- relations
- evidence
- wiki page metadata
- graph node metadata
- access audit
- tombstones

### Graph Store

MVP graph lives in SQLite as entities and relations, but the graph backend target is Graphify (`safishamsi/graphify`). Graphify remains the engine for technical/document/code graphs and produces queryable graph artifacts such as `graphify-out/graph.json`, `GRAPH_REPORT.md` and `graph.html`.

Graphify adapter rules:

- Graphify node ids map to `MemoryEntity.metadata.graphify_node_id`.
- Graphify edge ids map to `MemoryRelation.metadata.graphify_edge_id`.
- Imported edges keep `metadata.adapter = "graphify"`.
- Artifact paths are stored as metadata, for example `graph_json_path` and `report_path`.
- The facade keeps personal memory policy, privacy domains, anti-exfiltration and user/workspace isolation; Graphify does not bypass those rules.
- Graphify imports technical/document graph knowledge. It does not become the sole personal-memory database.

Inspected Graphify reference:

- Repository: `safishamsi/graphify`.
- Commit inspected: `990ac706d823bf92275333433fde4ef4782a9139`.
- Pipeline: `detect() -> extract() -> build_graph() -> cluster() -> analyze() -> report() -> export()`.
- Extractors emit plain JSON fragments with `nodes` and `edges`.
- Exported `graph.json` uses NetworkX node-link JSON with `nodes` and `links`.
- Nodes carry fields such as `id`, `label`, `source_file`, `source_location`, `community` and optional extra metadata.
- Links carry `source`, `target`, `relation`, `confidence`, optional `context` and optional extra metadata.
- Confidence labels are `EXTRACTED`, `INFERRED`, `AMBIGUOUS`.
- LLM-facing usage is query-first: `graphify query`, `graphify path`, `graphify explain` should be preferred over loading the entire report for focused questions.

### Wiki Store

Markdown files are human-readable projections of confirmed knowledge. The wiki does not receive raw events or secret payloads. Wiki writes are mediated by policy and linked back to DB refs through frontmatter.

## Stable References

All cross-backend links use `MemoryRef`.

Examples:

- `event:local:user_1:workspace_1:evt_...`
- `memory:local:user_1:workspace_1:mem_...`
- `entity:local:user_1:workspace_1:project:acme`
- `relation:local:user_1:workspace_1:rel_...`
- `wiki:local:user_1:workspace_1:Projects/Acme.md`
- `graph:local:user_1:workspace_1:node_...`
- `audit:local:user_1:workspace_1:access_...`

Refs include user and workspace to prevent accidental cross-user reads.

## Core Types

- `UserId`
- `WorkspaceId`
- `PrivacyDomain`
- `DataSensitivity`
- `MemoryRef`
- `MemoryEvent`
- `MemoryRecord`
- `MemoryEntity`
- `MemoryRelation`
- `MemoryEvidence`
- `WikiPage`
- `MemoryAccessRequest`
- `MemoryAccessDecision`
- `MemoryContextPack`

## Policy And Anti-Exfiltration

Every read request includes:

- actor id
- user id
- workspace id
- purpose
- allowed privacy domains
- max sensitivity
- raw payload permission
- export permission

Policy outcomes:

- `allow`
- `redact`
- `summarize_only`
- `requires_user_approval`
- `deny`

Rules:

- deny cross-user and cross-workspace reads.
- deny domains outside the request.
- deny sensitivity above request max.
- redact secrets before returning context to agents.
- block broad export unless explicitly allowed.
- never write raw secret payloads into wiki pages.
- audit both allowed and denied access.

## Encryption

Encryption is application-level:

- metadata stays queryable where safe.
- sensitive payload JSON is encrypted with XChaCha20-Poly1305.
- encrypted values store nonce and ciphertext.
- `KeyProvider` is abstract.
- tests use `DevelopmentKeyProvider`.
- OS keychain provider is a later adapter, not required for schema correctness.

## CRUD Scope

The facade exposes CRUD-style operations for:

- events
- memory records
- entities
- relations
- evidence links
- wiki pages

Deletes are logical tombstones. Hard delete can be added later for user-requested erasure once cascading semantics are fully specified.

## MemoryAgent Extraction Contract

The MemoryAgent returns JSON that maps into `MemoryExtraction`:

- `memories[]`: consolidated facts with `memory_type`, `text`, aliases, language hints, confidence, privacy domain, sensitivity, evidence refs and metadata.
- `entities[]`: graph nodes with `entity_type`, `name`, `canonical_key`, aliases, privacy domain, sensitivity and metadata.
- `relations[]`: graph edges with source/target refs, relation type, confidence, privacy domain, sensitivity, evidence refs and metadata.

`MemoryFacade::apply_extraction` is the only path that imports this output. It creates confirmed memory records, upserts entities, stores relations, links evidence and returns refs in `MemoryExtractionSummary`.

## Testing Requirements

Tests must cover:

- CRUD isolation by user/workspace.
- privacy domain filtering.
- sensitivity filtering.
- raw payload redaction.
- secret redaction.
- encrypted payload round-trip.
- encrypted payload unreadable without the key.
- wiki pages include refs and frontmatter.
- wiki writes reject secret raw content.
- context packs preserve refs.
- access decisions are audited.

## UI Read Model

The UI must not query raw tables directly. It uses `MemoryUiReadModel`, which builds policy-gated views for Tauri/React:

- dashboard counts by memory status, privacy domain and sensitivity.
- memory list items with summaries, refs and language hints.
- memory detail with evidence refs, related entities, relations and wiki pages.
- privacy overview across domains and sensitive records.

The read model audits allowed and denied memory visibility decisions and never returns raw event payloads.
