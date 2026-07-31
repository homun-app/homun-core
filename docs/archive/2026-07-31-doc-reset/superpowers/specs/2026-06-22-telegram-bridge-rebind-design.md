# Telegram bridge rebind after gateway restart

## Problem

The Telegram sidecar can survive a desktop-gateway restart or an app update. It
continues to send outbound approval cards, but its `TG_GATEWAY_TOKEN` belongs to
the old gateway. Button callbacks then receive HTTP 401 from the new gateway.
The sidecar currently drops that response, so the user sees no result.

## Goal and acceptance criteria

When Homun finds a Telegram bridge already listening on `127.0.0.1:18767`, the
current gateway becomes its callback target without exposing secrets in logs.

1. An existing compatible bridge accepts the current gateway URL and token and
   uses them for subsequent inbound messages and inline-button callbacks.
2. A bridge that does not implement reconfiguration, rejects the authenticated
   request, or is unreachable is stopped and replaced by a bridge started with
   the current configuration.
3. A callback records only its HTTP outcome (`2xx`, `401`, transport failure),
   never the gateway token, bot token, callback payload, or chat text.
4. Existing live bridges are not killed when a rebind succeeds.
5. The demo-piano Telegram approval executes the pending action and reaches the
   6.1b resume path.

## Design

The Telegram bridge owns a mutable `GatewayTarget` (`url`, `gateway_token`) in
an `Arc<RwLock<...>>`, shared by inbound forwarding and callback forwarding.
It adds loopback-only `POST /configure-gateway` with a target payload. The
request is authenticated with the already configured Telegram bot token in an
`Authorization: Bearer` header; the bridge returns no configuration values and
does not log credentials.

At startup and in the Telegram connect endpoint, the desktop gateway tries this
rebind first when `:18767` is occupied. It sends its current URL/token plus the
persisted Telegram bot token. A successful response preserves the sidecar. Any
other result triggers the existing controlled disconnect of the listener and
starts a new bridge with the current environment.

The callback forwarder reads the target at request time and logs a redacted,
structured outcome only. It keeps polling after a failed callback; no approval
is executed locally by the sidecar.

## Alternatives rejected

- **Kill the listener on every startup:** simple, but unnecessarily interrupts a
  bridge that is already serving the current gateway and can disrupt another
  live Homun instance.
- **Make gateway tokens stable across restarts:** avoids the immediate mismatch
  but weakens process isolation and leaves stale sidecar ownership unresolved.

## Testing

Tests are written first and cover:

1. A callback uses the reconfigured target rather than its initial stale token.
2. `/configure-gateway` rejects a request without the bridge authentication
   secret and never returns either secret.
3. Gateway lifecycle retains a bridge after successful rebind and restarts it
   when rebind is unsupported or fails.
4. Callback diagnostics distinguish success, HTTP failure, and transport
   failure without including sensitive values.

Integration verification is the existing Gemma demo-piano gate: approve the
first write from Telegram, observe the confirmation result, then verify
`note.md`, `riepilogo.md`, and the persisted resumed assistant message.
