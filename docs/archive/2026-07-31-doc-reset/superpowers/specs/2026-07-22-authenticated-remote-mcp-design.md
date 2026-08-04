# Authenticated Remote MCP Design

**Date:** 2026-07-22

**Status:** Approved in conversation for implementation

## Goal

Allow Homun to connect Orion Moon and other streamable-HTTP MCP servers that use a
Bearer token, without persisting credentials in the capability registry, logs, or
frontend state after submission.

Orion Moon remains a normal MCP provider. Its endpoint is
`https://orion-moon.pinkfloyd.competitoor.com/mcp`; its six tools enter the same
capability catalog, routing, and read/write policy already used by other MCP
servers.

## Considered approaches

1. **Native authenticated HTTP with Secret Store (selected).** The existing MCP
   connect request carries request headers once. The gateway stores the complete
   HTTP-header map as secret material, persists only a `secret_ref`, and restores
   the headers when building the HTTP transport. This fits Homun's existing
   Composio credential pattern and works after restart.
2. **Persist `Authorization` in MCP metadata.** This is mechanically supported by
   the current code but rejected because the bearer token would live in the
   capability SQLite database in plaintext.
3. **Run a local `mcp-remote` stdio proxy.** This avoids backend changes but adds a
   Node runtime dependency, fragile environment inheritance for the packaged app,
   and a second transport process. It is unsuitable as the product path.

## User experience

In Settings -> Connectors -> MCP -> Add manual server, URL mode adds:

- `Authentication`: `None` or `Bearer token`.
- A password input shown only for `Bearer token`.
- The existing name and URL fields remain unchanged.

For Orion Moon the user enters the display name, endpoint, and the value of
`ORION_MOON_MCP_TOKEN`. Homun submits the token as the `Authorization` header and
clears the input after the request. The field never shows a saved token when the
user reopens the connection.

Registry-sourced remote MCP servers continue to submit their declared headers.
All HTTP headers, not only `Authorization`, use the same encrypted secret path so
secret classification cannot drift between registry metadata and the gateway.

## Backend and storage

For remote HTTP connections:

1. The connect handler validates name, URL, and header values.
2. If headers are present, it JSON-serializes the header map into
   `SecretMaterial` and stores it through `state.secret_store` under a deterministic
   `SecretRef` scoped by user, workspace, provider, and connection.
3. The connection metadata contains only `transport: "http"` and `url`; the
   connection's existing `secret_ref` field points to the stored headers.
4. Discovery and every later tool call resolve the connection's secret, decode the
   header map, and pass it to `McpHttpTransport`.
5. An HTTP connection without headers requires no secret and continues to work.
6. Disconnect deletes the associated secret as well as provider configuration,
   grant, connection, and cached tools.

Local stdio behavior stays unchanged. This feature does not broaden MCP OAuth,
token refresh, or general Vault UI scope.

## Failure behavior

- Empty Bearer token: the UI keeps the connect button disabled.
- Invalid or missing stored secret: discovery/execution returns an explicit MCP
  credential error without logging the secret value.
- Invalid JSON or non-string stored header values: fail closed before any network
  request.
- Unauthorized Orion Moon response: surface the existing discovery warning or MCP
  tool error, without echoing the submitted token.
- Registry persistence failure after writing a new secret: perform best-effort
  secret cleanup.
- Secret deletion failure during disconnect: report the failure explicitly; never
  claim credential removal succeeded.

## Tests and verification

Tests are written before implementation and must prove:

1. HTTP connection metadata never contains `Authorization`, the bearer token, or
   any submitted header.
2. Header maps round-trip through `SecretMaterial` and reject malformed data.
3. A transport rebuilt from a persisted connection restores the Bearer header.
4. Disconnect deletes the referenced secret.
5. The URL-mode form sends `Authorization: Bearer <token>`, disables submission for
   an empty token, and clears it after connecting.
6. Existing unauthenticated HTTP and stdio MCP tests remain green.

Final verification includes focused Rust tests, desktop frontend tests/typecheck,
relevant broader suites, and a rendered Settings check at the target desktop
width. A live Orion Moon smoke test is optional and uses a locally supplied token;
no token is read, printed, or committed by the test suite.
