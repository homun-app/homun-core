# Durable large tool results

Continue H07 using Hermes tool_result_storage.py and tool_output_truncate.py as
reference, without its runtime. Keep full JSON results in private run storage,
with hash identity and a bounded 40/60 head/tail preview in native history and
observations. Preserve top-level error/status flags. Register a run-scoped paged
read tool with optional literal search. No shared arbitrary filesystem paths.

- [x] Tests: lossless reconstruction, status preservation, corruption, unknown
  reference, restart, source revocation, native MCP continuation with large data.
- [x] Result storage helper and new-run contract version; original runs unchanged.
- [x] Integrate once into native append_result and all persisted observations.
- [x] Review, real model/server fixture, full checks, documentation and local merge.

Same authority checks as native execution surround every retrieval. No external
call is repeated to obtain more output. This does not replace total context
compression, retention/GC policies or turn/token budgets, which remain explicit.
