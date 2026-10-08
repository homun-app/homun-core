# Deferred tool bridge (H07)

Reference: Hermes tools/tool_search.py/catalog/validation at pinned c9dca726.
Goal: stop sending every approved MCP schema on every model turn, with genuine
search/describe/call routing in Homun, preserving supervised external effects.
No Hermes runtime. New native proposals pin bridge version; old runs unchanged.

- [x] RED: model surface excludes MCP schemas; describe returns exact pinned
  schema; unknown/direct/recursive targets fail without IO. Same round search
  and bridge call retains native IDs. External approval validates resolved target.
- [x] application/agent_tool_bridge.py owns strict contracts, names, visible
  definitions and pure call resolution. Registry owns discover/describe metadata.
  Execution resolves before MCP staging, link validator re-resolves current call.
- [x] Tests: approved wrapper result survives restart once, invalid args,
  cancellation, direct-name calls still requiring approval, tampered target, sequential multiple calls,
  legacy surface. No fake result or re-execution from search/describe.
- [x] Real Ollama + stdio search/describe/call, approval and restart evidence.
- [x] Review; engine regression/architecture; docs and MIT provenance; local merge.

Deferral initially covers all selected MCP tools. Materials/human/results remain
ambient. Bridge is stateless over pinned catalog, never permission acquisition.
Native multiple calls provide ordered batching; no new opaque batch side effects.
Full row parity additionally needs configuration, source catalog sizing, stemming
and other deferred toolsets; do not call partial implementation full H07 parity.

Direct approved MCP names remain accepted for compatibility, with the same
argument validation and human approval. Deferral changes disclosure, not authority.
