# External receipt delivery reapproval

Continuation of the approved owned-engine parity design; proceed autonomously.
Goal: deliver an existing successful external receipt to a changed work without
repeating the external effect or rewriting its original approval.

- [x] Add failing tests for preview, immutable original approval, stale preview,
  changed receipt, owner/reviewer checks and idempotent delivery command replay.
- [x] Extract transactional publication helper in external_publication.py.
  New external_delivery.py binds preview to receipt hash, work version and target;
  accepts explicit delivery approval and commits artifact plus command atomically.
- [x] Add preview/deliver routes, typed client and a focused review card showing
  work context and result before an explicit delivery-only approval.
- [x] Review independently; run regression, API snapshot, typecheck/build/tests.
  Update evidence and integrate locally. Adaptive MCP binding remains open.

No transport dependency in delivery. Existing server can be disabled/deleted:
this action publishes a saved result, not a fresh server operation. Current work
access and human owner/reviewer authority must hold on replay too. Never repin
original expected_version/digest. Closed/incompatible work remains a domain error.
