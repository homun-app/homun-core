# Session identity and authorized reads

User explicitly authorizes all useful non-GUI foundation work and comparative OSS
research. This tranche binds the local session to its launcher-selected actor and
filters protected HTTP reads through existing AccessGrant policy. No external IdP,
new users, automatic grants, native GUI or secret migration.

Session design: create_app accepts a trusted session_actor_id (default person_fabio,
the app's existing single local identity); CLI uses HOMUN_SESSION_ACTOR_ID; desktop
sets that value explicitly. Authenticated requests without actor headers receive
the bound identity. A different or duplicated actor header is denied before routes.
The renderer cannot select a more privileged actor. Dev-insecure remains explicitly
loopback-only and permits test/development actor headers as before.

Read design: dedicated small read policy/router modules for works/runs/events,
existing actor-aware clients supply headers; all project scopes of a linked work
must be readable. Event scans advance cursor across denied records without returning
their content. Unknown references fail closed. No silent simulation fallback.

- [x] Test middleware identity spoofing, missing/duplicate headers and isolated sessions.
- [x] Implement session binding, server/desktop wiring, frozen acceptance scenario.
- [x] Implement and test read policy/API/client changes independently; integrate.
- [x] Research Hermes plus comparable open source systems from primary evidence.
- [x] Verify full backend/client/boundary checks; rebuild and smoke extracted bundle.

Authority after IO acceptance, external multi-user identity provisioning, native
Keychain identity and graphical acceptance remain separate concerns.

Additional completed scope: project/material/grant cached-result reauthorization,
read-only rejection of future workspace schemas in both backup formats, generated
OpenAPI drift gate, and bounded authorized conversation context with replay and
publication gates. See the final delivery report for consolidated verification.

Consolidated results and artifact: [delivery](../../research/2026-09-19-autonomous-foundations-delivery.md).
