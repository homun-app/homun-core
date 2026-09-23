# Durable external invocation receipts

Continuation of the approved Hermes parity design and registry prerequisite.
Homun owns the persisted execution state; MCP SDK owns only wire transport.

Contract: pin server configuration and work version in approval; reject reused
command ids with changed scope; persist intent before external IO; save complete
receipt in a separate transaction before artifact publication. Never redispatch
an invocation with a receipt or uncertain outcome. Catch ordinary exceptions,
not process exit. An expired in-flight intent becomes outcome_unknown; it is
not evidence that the action failed. Human owner/reviewer can resume publication
of an existing receipt without repeating the effect. Retain error receipts too.

- [x] Regression fixtures: replay approval, configuration drift, command collision,
  transport uncertainty, publication failure, interrupted process, changed work.
- [x] Separate publication from transport; persist results before publication.
- [x] Show pending publication and uncertain outcomes in the existing UI.
- [x] Independent review and full regression.
- [x] Runtime/restart evidence and documentation, local commit and integration.

Not a claim of distributed exactly-once. Tool schema/grant binding and adaptive
MCP integration remain next requirements; reconciliation of external unknown
outcomes requires explicit service evidence. No automatic retry is invented.
