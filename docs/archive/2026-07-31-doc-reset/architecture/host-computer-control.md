# Host Computer Control on macOS

Host Computer Control lets Homun observe and operate explicitly authorized macOS
applications. It is an independent Homun implementation of a general desktop-agent
pattern; it does not reuse another product's source code, private protocol, signing
identity, assets, or bundled binaries.

This capability is separate from the Docker-based Contained Computer:

- Contained Computer runs a browser and shell inside an isolated container.
- Host Computer Control crosses the host boundary only through a dedicated native
  helper and only for applications granted by the user.

## Execution path

```text
Electron / React UI
  -> loopback gateway API + authenticated WebSocket events
  -> isolated host-computer worker turn
  -> Rust host-computer client and policy layer
  -> private Unix-domain socket with one-time session secret
  -> HomunComputerService.app (Swift, LSUIElement)
  -> macOS Accessibility / ScreenCaptureKit / CoreGraphics
```

The manager agent receives only the `use_computer` delegation tool. The recursive
worker receives the narrower `list_apps`, `get_state`, and `action` tools. This keeps
raw host observations and action mechanics out of the manager's general tool surface.

The Electron process supplies the helper's public bundle path. The Rust supervisor
creates a `0700` runtime directory, private Unix socket, and single-use authentication
file. The helper consumes and deletes the authentication file during the handshake.
Requests are length-framed JSON-RPC messages with a protocol version, deadline, turn
identifier, and session authentication value. The helper exits if its parent gateway
dies.

## Consent and grants

macOS owns the Accessibility and Screen Recording consent prompts. Homun exposes their
current states in Settings -> Computer -> Mac Apps and can open the corresponding
System Settings panel, but it cannot grant itself either permission.

App access is deny-by-default. A grant is scoped to the current Homun user and
workspace and is pinned to the app's signed identity:

- bundle identifier;
- Apple team identifier;
- hash of the designated code-signing requirement;
- `observe` or `control` level.

Changing the signed identity invalidates the match. Revoking a grant cancels the
active host session and clears retained snapshots. Password managers, login windows,
and authentication agents are excluded by the gateway and rejected again if a caller
attempts to create a grant directly.

## Observation and disclosure

The Swift helper builds a bounded semantic accessibility tree. Password-like fields,
secure roles, and likely secrets are redacted before they can leave the host adapter.
The Rust disclosure layer applies provider-aware projection again. Remote models
receive the redacted semantic structure by default; screenshot bytes are represented
only by opaque artifact references and are not disclosed by the host-computer worker.

Snapshots have an expiry and are bound to the signed application identity. Actions
target an element index from a live snapshot rather than arbitrary screen coordinates.

## Action policy and approval

The host action policy distinguishes observation, reversible interaction, text entry,
file writes, external communication, purchases, system settings, and destructive
operations. Consequential actions require an explicit approval tied to the exact
session, signed app identity, target, and action digest. Approvals expire after five
minutes and are consumed atomically once.

Secure inputs, protected applications, and Terminal input are hard denials; neither a
grant nor an approval can override them. A physical mouse, trackpad, or keyboard event
invalidates the current resume generation and pauses automation. Resuming requires an
explicit UI action carrying the latest generation. Only one host-control session may
be active at a time.

The chat surface shows the source (`Mac`), app, window, phase, approval summary, and
pause/resume/cancel controls. It never renders hidden typed values, session secrets, or
raw screenshot bytes.

## Persistence, audit, and reset

Grant data lives in `host-computer-grants.sqlite3`. Sanitized lifecycle and action
events are appended to `host-computer-journal.jsonl`; entries contain categories,
digests, and outcomes, not typed values or authentication material. Runtime sockets,
snapshots, and capture artifacts live under the dedicated `host-computer` data root.

Factory reset stops the managed gateway/helper chain before removing the full Homun
data root, including grants, WAL/SHM files, journal, sockets, and cached artifacts.

## Packaging and release verification

The desktop package stages `HomunComputerService.app` as a nested helper. The release
signing hook signs its executable and bundle with a least-privilege empty entitlement
set before electron-builder signs the outer Homun app. The verifier checks:

- strict `codesign` validity for helper and outer app;
- matching Developer ID team identifiers;
- absence of forbidden helper entitlements;
- expected architecture (and optionally a universal binary);
- Gatekeeper assessment;
- notarization ticket stapling.

Run it on a signed release candidate from `apps/desktop`:

```bash
npm run verify:host-computer-package -- "/path/to/Homun.app"
```

Signing and notarization cannot be simulated: the final release gate requires the
real Developer ID certificate, Apple credentials, and a notarized artifact. Current
distribution produces Apple Silicon (`arm64`) macOS builds; Intel/universal output is
not claimed.

See the [macOS acceptance matrix](../testing/host-computer-macos-matrix.md) for the
exact automated, rendered, and external release gates.
