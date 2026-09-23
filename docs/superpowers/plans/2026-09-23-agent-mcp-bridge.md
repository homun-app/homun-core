# Native agent MCP bridge

Continue the authorized Hermes parity design. Expose tools only from selected
servers; approval of a run grants availability, not external action execution.
Every generated external call stages an exact proposal with its approved schema
and arguments. Preserve its native call id while waiting for human approval.
Receipt resumes the model once; only the final agent result becomes an artifact.

- [x] Pin selected server descriptors in the run and register native MCP tools.
- [x] Stage action + waiting_external atomically; bind proposal to run epoch/call.
- [x] Validate current run before external dispatch; cancellation fences approvals.
- [x] Preserve receipt independently, resume through DBOS reconciliation without
  duplicate effects, allow model correction after known tool/preflight errors.
- [x] UI server selection, tool summary and exact per-action approval panel.
- [x] Tests for normal path, crash/replay, unavailable tools, cancellation, drift;
  real MCP/model evidence; independent review and full regression; local merge.

Scope is native tools only; legacy JSON runs retain previous surface. Unknown
external outcomes block the run for reconciliation; never auto-retry them. MCP
resources/prompts/OAuth and full H07/H36 remain separately tracked gaps.
