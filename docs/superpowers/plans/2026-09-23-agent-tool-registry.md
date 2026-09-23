# Shared agent tool registry and MCP prerequisite

Goal: replace separate schema/dispatch switches with an extensible Homun-owned
registry, following Hermes tools/registry.py (pinned reference, MIT attribution).
Same per-run registry supplies model schemas, search, argument validation and
execution metadata. Availability is distinct from authority; handlers retain
source/team policy checks. No global mutable registry or automatic plugin trust.

New proposals pin deterministic manifests (schema hash, handler version, toolset,
kind and replay policy) inside the approval digest. Existing runs without a
manifest retain their explicit legacy tool surface; additions do not silently
expand their approved scope. A local tool_search exposes only the run's approved
registry and never executes matching tools. Existing material, collaborator and
clarification handlers are registered through the same boundary.

In parallel, fix MCP protocol prerequisites before adaptive binding: proper SDK
initialize/initialized lifecycle, negotiated sessions, fail-closed replies,
full discovery descriptors and structured results. Presence in discovery does
not authorize a native call. A later invocation journal must preserve external
receipts and uncertain effects before MCP may join adaptive execution.

- [x] Pure instance-scoped registry: registration, schema snapshots, duplicate
  rejection, strict validation, deterministic manifest/search and typed failures.
- [x] Bind existing tools plus tool_search; native schemas and dispatch share
  registry; pin and validate new manifests, preserve old-run tool surface.
- [x] Verify model→tool_search→selected tool→final, malformed arguments,
  unavailable collaborator, manifest drift, replay and revoked source behavior.
- [x] MCP SDK transport: actual initialized handshake, descriptors/pagination,
  session HTTP/SSE, fail-closed errors and bounded lifetime; protocol fixtures.
- [x] Review, full regression, documentation and local integration. H07/H36
  stay partial until dynamic MCP binding, lazy activation, spill and effect
  receipts are implemented and proven end-to-end.
