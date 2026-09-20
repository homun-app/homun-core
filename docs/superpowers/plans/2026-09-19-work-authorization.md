# Current authority for work commands and runtime delivery

Authorized continuation of the production foundations. Existing AccessGrant policy
remains canonical: project write for mutation; workspace-only work retains its
current semantics. No new identities or automatic grants.

Design: a small policy module resolves the work/conversation targeted by a command
and checks current grants before mutation AND before cached command replay. All
project scopes linked to the work must be writable. Runtime delivery resolves the
original actor from the persisted command record and rechecks the same work policy
at claim and immediately before IO. Missing provenance for project work fails closed.
Blocked intents retain a typed permission_denied error and can retry after regrant;
no revocation is claimed to undo IO already accepted by the runtime.

- [x] Add regression cases for all work/plan command entrances, conversation creation,
  replay after revocation, linked project scope, and revoked/expired outbox delivery.
- [x] Implement policy/work.py, wire DomainService and runtime/outbox.py.
- [x] Verify HTTP command returns typed 403; domain state/receipts remain unchanged.
- [x] Run focused/full backend and architecture checks, rebuild and smoke the bundle.

Explicit remaining scope: HTTP read filtering and authenticated actor binding,
project/material/grant replay policy outside work commands, authority during already
running DBOS effects. Do not describe this tranche as complete API authorization.

Consegna: docs/research/2026-09-19-work-authorization-delivery.md.
