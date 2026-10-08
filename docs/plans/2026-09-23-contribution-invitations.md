# Scoped human contributions

An owner or reviewer explicitly creates a seven-day invitation for one pending contribution request. The invitation fixes the recipient identity, request, work version and project revisions. A cryptographically random bearer secret is returned once; only its hash is persisted. Ordinary lists omit both hash and secret. Revocation immediately disables access.

The invitation portal reads only the work title, request question, recipient and response status. It accepts text only and executes the existing contribution command as the fixed recipient. A context-local policy scope authorizes exactly that command/request/version, without issuing project grants. A resolved invitation accepts only the exact same answer on retry. Expired, revoked and superseded scope never gives global engine access.

The desktop-session middleware exempts only the exact two portal routes, each of which authenticates the invitation itself. The UI keeps credentials in a URL fragment and sends them in Authorization headers. It copies a link, never sends a message or opens network access. The local engine must already be reachable by the intended person; this is not a remote deployment.
