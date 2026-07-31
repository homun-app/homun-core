# Host Computer Control 01 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Homun's independently implemented, versioned, authenticated macOS host-computer protocol, Rust client, native helper skeleton, permission reporting, and development fixture without exposing any model-facing computer tools yet.

**Architecture:** A new cross-platform Rust crate owns protocol types, a macOS Unix-domain-socket client, and helper supervision. A SwiftPM package builds a background `.app` helper and an accessibility fixture app. The gateway launches the helper through LaunchServices with an ephemeral socket path and 256-bit session token; Electron supplies only the packaged bundle path. The helper authenticates every request, keeps screenshots out of JSON, and returns typed errors. Non-macOS builds compile a disabled implementation.

**Tech Stack:** Rust 2021, Tokio, Serde, Unix domain sockets, Swift 6, SwiftPM, AppKit, ApplicationServices, ScreenCaptureKit, Node.js package scripts, Electron Builder.

---

**Depends on:** `docs/superpowers/specs/2026-07-21-host-computer-control-design.md`

**Unblocks:** `2026-07-21-host-computer-02-native-control.md`

## File map

- Modify `Cargo.toml`: register the new workspace crate.
- Create `crates/host-computer/Cargo.toml`: Rust dependencies and macOS gates.
- Create `crates/host-computer/src/lib.rs`: public client/service surface.
- Create `crates/host-computer/src/protocol.rs`: versioned JSON-RPC envelopes, DTOs, and stable errors.
- Create `crates/host-computer/src/framing.rs`: bounded length-prefixed JSON framing.
- Create `crates/host-computer/src/transport.rs`: transport trait, UDS transport, and unsupported-platform stub.
- Create `crates/host-computer/src/client.rs`: authenticated request client and handshake.
- Create `crates/host-computer/src/supervisor.rs`: LaunchServices lifecycle, token file, health, and bounded restart.
- Create `crates/host-computer/src/service.rs`: helper lifecycle and permission facade.
- Create `crates/host-computer/tests/protocol_contract.rs`: serialization and compatibility tests.
- Create `crates/host-computer/tests/framing_contract.rs`: malformed and oversized-frame tests.
- Create `crates/host-computer/tests/client_contract.rs`: fake-transport authentication and timeout tests.
- Create `runtimes/host-computer/macos/Package.swift`: Swift helper and fixture targets.
- Create `runtimes/host-computer/macos/Sources/HomunComputerProtocol/*.swift`: Swift protocol mirror and framing.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/*.swift`: app entry point, socket server, authentication, and permission probe.
- Create `runtimes/host-computer/macos/Sources/HomunComputerFixture/*.swift`: deterministic accessibility fixture.
- Create `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/*.swift`: cross-language fixture tests.
- Create `runtimes/host-computer/macos/Fixtures/*.json`: canonical request/response fixtures shared with Rust.
- Create `apps/desktop/scripts/build-host-computer-helper.mjs`: assemble development `.app` bundles.
- Create `apps/desktop/tests/host-computer-package.test.mjs`: bundle-layout contract.
- Modify `apps/desktop/package.json`: helper build and test scripts.
- Modify `apps/desktop/electron/main.cjs`: macOS-only helper discovery and gateway path configuration.
- Modify `apps/desktop/scripts/prepare-package.mjs`: stage the nested helper bundle without signing it yet.

### Task 1: Define the versioned protocol and stable error taxonomy

**Files:**
- Modify: `Cargo.toml`
- Create: `crates/host-computer/Cargo.toml`
- Create: `crates/host-computer/src/lib.rs`
- Create: `crates/host-computer/src/protocol.rs`
- Create: `crates/host-computer/tests/protocol_contract.rs`
- Create: `runtimes/host-computer/macos/Fixtures/handshake-request-v1.json`
- Create: `runtimes/host-computer/macos/Fixtures/handshake-response-v1.json`

- [ ] **Step 1: Add failing Rust contract tests**

Cover exact field names, unknown-field rejection, a successful handshake, every stable error
code, and protocol-version mismatch. Use a canonical fixture rather than inline JSON:

```rust
#[test]
fn handshake_fixture_round_trips_without_shape_drift() {
    let raw = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtimes/host-computer/macos/Fixtures/handshake-request-v1.json"
    ));
    let request: RpcRequest = serde_json::from_str(raw).unwrap();
    assert_eq!(request.jsonrpc, JsonRpcVersion::V2);
    assert_eq!(request.meta.protocol_version, PROTOCOL_VERSION);
    assert!(matches!(request.method, HostComputerMethod::Handshake));
    assert_eq!(serde_json::to_value(request).unwrap(), serde_json::from_str::<serde_json::Value>(raw).unwrap());
}

#[test]
fn secure_input_is_a_stable_machine_readable_error() {
    assert_eq!(HostComputerErrorCode::SecureInputBlocked.as_str(), "secure_input_blocked");
}
```

The v1 envelope is:

```rust
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RpcRequest {
    pub jsonrpc: JsonRpcVersion,
    pub id: u64,
    pub method: HostComputerMethod,
    pub params: serde_json::Value,
    pub meta: RequestMeta,
}

pub struct RequestMeta {
    pub protocol_version: u32,
    pub turn_id: Option<String>,
    pub deadline_unix_ms: i64,
    pub session_token: String,
}
```

Stable v1 errors: `authentication_failed`, `protocol_mismatch`, `invalid_request`,
`permission_missing`, `app_not_granted`, `approval_required`, `secure_input_blocked`,
`terminal_input_blocked`, `stale_snapshot`, `target_not_found`, `deadline_exceeded`,
`payload_too_large`, `helper_unavailable`, `host_locked`, and `unsupported_platform`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p local-first-host-computer --test protocol_contract
```

Expected: FAIL because the crate and protocol types do not exist.

- [ ] **Step 3: Implement the minimal crate and fixtures**

Add `crates/host-computer` to workspace members. Name its package
`local-first-host-computer`. Use tagged snake-case enums and `deny_unknown_fields` on all
wire structs. Make `RpcResponse` an enum with `result` or `error`, never both. Redact
`meta.session_token` from `Debug` by implementing `Debug` manually for `RpcRequest` and
`RequestMeta`.

The handshake result must contain `protocol_version`, `helper_build`, `helper_pid`,
`host_os_version`, and the capabilities array. Do not include paths or tokens.

- [ ] **Step 4: Run protocol tests for GREEN**

Run:

```bash
cargo test -p local-first-host-computer --test protocol_contract
cargo fmt --all -- --check
```

Expected: protocol tests pass and formatting exits 0.

- [ ] **Step 5: Commit the protocol contract**

```bash
git add Cargo.toml Cargo.lock crates/host-computer runtimes/host-computer/macos/Fixtures
git commit -m "feat(computer): define host control protocol"
```

### Task 2: Implement bounded framing and authenticated client behavior

**Files:**
- Create: `crates/host-computer/src/framing.rs`
- Create: `crates/host-computer/src/transport.rs`
- Create: `crates/host-computer/src/client.rs`
- Create: `crates/host-computer/tests/framing_contract.rs`
- Create: `crates/host-computer/tests/client_contract.rs`

- [ ] **Step 1: Write failing framing and client tests**

Test a fragmented four-byte big-endian length header, fragmented JSON body, two frames on
one stream, zero length, invalid JSON, 8 MiB limit, mismatched response IDs, auth token
presence, absolute deadline expiry, and handshake-before-command ordering.

```rust
#[tokio::test]
async fn oversized_frame_is_rejected_before_allocation() {
    let bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
    let error = read_frame(&mut bytes.as_slice()).await.unwrap_err();
    assert_eq!(error.code(), HostComputerErrorCode::PayloadTooLarge);
}

#[tokio::test]
async fn client_never_sends_a_command_before_handshake() {
    let transport = RecordingTransport::default();
    let client = HostComputerClient::new(transport.clone(), SecretToken::from_bytes([7; 32]));
    client.permission_status(context()).await.unwrap();
    assert_eq!(transport.methods(), [HostComputerMethod::Handshake, HostComputerMethod::PermissionStatus]);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cargo test -p local-first-host-computer --test framing_contract --test client_contract
```

Expected: FAIL because framing, transport, and client modules are absent.

- [ ] **Step 3: Implement framing, transport abstraction, and client**

Use a `HostComputerTransport` trait so tests do not start a process:

```rust
#[async_trait]
pub trait HostComputerTransport: Send + Sync {
    async fn call(&self, request: RpcRequest) -> Result<RpcResponse, HostComputerClientError>;
}
```

`UdsTransport` serializes one request per connection in phase 1, uses Tokio timeouts from
the absolute request deadline, creates no network listener, and validates that the socket
is owned by the current user and is not group/world writable. The cross-platform factory
returns `UnsupportedPlatform` outside macOS. Store the token in `secrecy::SecretBox` and
zeroize temporary token buffers.

- [ ] **Step 4: Run all crate tests for GREEN**

Run:

```bash
cargo test -p local-first-host-computer
cargo clippy -p local-first-host-computer --all-targets -- -D warnings
```

Expected: all host-computer tests pass; clippy exits 0.

- [ ] **Step 5: Commit transport and client**

```bash
git add Cargo.lock crates/host-computer
git commit -m "feat(computer): add authenticated host transport"
```

### Task 3: Build the Swift protocol mirror and authenticated UDS server

**Files:**
- Create: `runtimes/host-computer/macos/Package.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerProtocol/Protocol.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerProtocol/Framing.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/main.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/SocketServer.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/ProtocolTests.swift`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/FramingTests.swift`

- [ ] **Step 1: Write failing Swift fixture and framing tests**

Decode and re-encode the same JSON fixtures used by Rust. Add invalid token, unsupported
version, oversized length, response-ID preservation, and token-redaction tests.

```swift
func testHandshakeFixtureRoundTrips() throws {
    let data = try fixture("handshake-request-v1")
    let request = try JSONDecoder.hostComputer.decode(RPCRequest.self, from: data)
    XCTAssertEqual(request.meta.protocolVersion, 1)
    XCTAssertEqual(request.method, .handshake)
    XCTAssertEqual(try canonicalJSON(request), try canonicalJSON(data))
}
```

- [ ] **Step 2: Run Swift tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos
```

Expected: FAIL because `Package.swift` and Swift modules do not exist.

- [ ] **Step 3: Implement the protocol package and serial server**

Set `.macOS(.v14)` and create library `HomunComputerProtocol` plus executable
`HomunComputerService`. The service reads configuration only from these launch arguments:
`--socket`, `--auth-token-file`, and `--parent-pid`. The token file path may appear in argv,
but the token itself may not. Verify that the file and parent directory are owned by the
current user with modes `0600` and `0700`, read the token once, unlink the file immediately,
unlink any pre-existing socket only after the same ownership checks, bind the socket with
mode `0600`, and exit when the parent process dies.

Route only `handshake` and `permission_status` in this phase. Authenticate with
constant-time comparison before method dispatch. Reject concurrent requests above eight
and frames above 8 MiB. Never log request bodies, text values, screenshots, or the token.

- [ ] **Step 4: Run Swift and cross-language fixture tests for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos
cargo test -p local-first-host-computer --test protocol_contract
```

Expected: both suites pass against the shared fixtures.

- [ ] **Step 5: Commit the native protocol server**

```bash
git add runtimes/host-computer/macos
git commit -m "feat(computer): add native host helper server"
```

### Task 4: Report macOS permissions without prompting implicitly

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/PermissionProbe.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/PermissionStatusTests.swift`
- Create: `crates/host-computer/src/service.rs`
- Create: `crates/host-computer/tests/service_contract.rs`

- [ ] **Step 1: Write failing permission-mapping tests**

Test independent Accessibility and Screen Recording states: `granted`, `denied`,
`not_determined`, and `restricted`. A status read must not invoke a prompt.

```rust
#[tokio::test]
async fn status_keeps_accessibility_and_capture_independent() {
    let service = fixture_service(permission_response("granted", "denied"));
    let status = service.permission_status(context()).await.unwrap();
    assert_eq!(status.accessibility, PermissionState::Granted);
    assert_eq!(status.screen_recording, PermissionState::Denied);
    assert!(!status.can_observe);
    assert!(!status.can_control);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter PermissionStatusTests
cargo test -p local-first-host-computer --test service_contract
```

Expected: FAIL because permission probing and service mapping are absent.

- [ ] **Step 3: Implement read-only permission status and explicit settings links**

Use `AXIsProcessTrusted()` for a non-prompting Accessibility status check. Use
`CGPreflightScreenCaptureAccess()` for Screen Recording. Keep prompting in separate
methods (`request_accessibility_permission`, `request_screen_recording_permission`) that
will only be called by an explicit settings button in plan 04. Return stable System
Settings deep-link identifiers but do not open them from the helper.

The Rust service derives:

```rust
can_observe = accessibility == Granted && screen_recording == Granted;
can_control = can_observe;
```

- [ ] **Step 4: Run service, Swift, and platform compilation checks for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos
cargo test -p local-first-host-computer
cargo check --workspace
```

Expected: all commands exit 0; non-host crates remain compilable.

- [ ] **Step 5: Commit permission status**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): expose native permission status"
```

### Task 5: Add a deterministic accessibility fixture app

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerFixture/main.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerFixture/FixtureApp.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerFixture/FixtureView.swift`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/FixtureManifestTests.swift`
- Create: `runtimes/host-computer/macos/Fixtures/fixture-elements-v1.json`

- [ ] **Step 1: Write the failing fixture-manifest test**

Require stable accessibility identifiers for a button, checkbox, text field, secure text
field, popup, scroll region, secondary-action target, and draggable source/destination.

```swift
func testFixtureManifestHasEveryRequiredControl() throws {
    let ids = try fixtureElementIdentifiers()
    XCTAssertEqual(Set(ids), [
        "fixture.button", "fixture.checkbox", "fixture.text",
        "fixture.secure", "fixture.popup", "fixture.scroll",
        "fixture.secondary", "fixture.drag-source", "fixture.drag-destination"
    ])
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter FixtureManifestTests
```

Expected: FAIL because the fixture target and manifest are incomplete.

- [ ] **Step 3: Implement the fixture app**

Build a single-window AppKit app with deterministic layout, labels, identifiers, state
readback, and a visible event log. The secure field must expose the native secure-text
role so later tests prove it is blocked. Add menu items with keyboard shortcuts and a
sheet to cover window changes. Do not automate other apps in this task.

- [ ] **Step 4: Run tests and manually launch the fixture**

Run:

```bash
swift test --package-path runtimes/host-computer/macos
swift run --package-path runtimes/host-computer/macos HomunComputerFixture
```

Expected: tests pass; the fixture opens with every manifest control. Close it normally
after inspection.

- [ ] **Step 5: Commit the fixture**

```bash
git add runtimes/host-computer/macos
git commit -m "test(computer): add native accessibility fixture"
```

### Task 6: Assemble, launch, stop, and stage the helper bundle

**Files:**
- Create: `apps/desktop/scripts/build-host-computer-helper.mjs`
- Create: `apps/desktop/tests/host-computer-package.test.mjs`
- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/electron/main.cjs`
- Modify: `apps/desktop/scripts/prepare-package.mjs`
- Create: `crates/host-computer/src/supervisor.rs`
- Create: `crates/host-computer/tests/supervisor_contract.rs`
- Create: `apps/desktop/resources/host-computer/HomunComputerService-Info.plist`
- Create: `apps/desktop/resources/host-computer/HomunComputerFixture-Info.plist`

- [ ] **Step 1: Write the failing bundle-layout test**

Assert nested bundle identifier, executable location, minimum macOS version, background
activation policy, usage descriptions, and absence from non-mac staging:

```js
test("helper bundle has a stable nested-app layout", async () => {
  const bundle = await buildHostComputerHelper({ configuration: "debug" });
  assert.equal(bundle.executable, "HomunComputerService.app/Contents/MacOS/HomunComputerService");
  assert.equal(bundle.info.CFBundleIdentifier, "app.homun.desktop.computer-service");
  assert.equal(bundle.info.LSUIElement, true);
  assert.equal(bundle.info.LSMinimumSystemVersion, "14.0");
});
```

- [ ] **Step 2: Run the focused package test and verify RED**

Run:

```bash
cd apps/desktop
node --test tests/host-computer-package.test.mjs
```

Expected: FAIL because the build script and plist do not exist.

- [ ] **Step 3: Implement deterministic bundle assembly and Electron lifecycle**

The build script invokes `swift build`, creates `Contents/MacOS` and
`Contents/Resources`, copies the executable, writes the checked-in plist, and returns a
manifest. It must not sign or mutate the developer's keychain.

Electron resolves the development or packaged bundle and passes only
`HOMUN_HOST_COMPUTER_HELPER_PATH` to the gateway when
`process.platform === "darwin"` and `HOMUN_HOST_COMPUTER === "1"`. It does not generate,
store, or receive the authentication token.

In Rust, `HostComputerSupervisor` owns the complete lifecycle. Generate the socket and a
single-use token file beneath a fresh `mkdtemp` directory mode `0700`; write the token file
with mode `0600`, retain the token in a secret container, pass only its path to
`open -n -a ... --args`, and require the helper to delete it before accepting requests.
Never put the token itself in argv or environment. Wait for handshake and verify helper
PID/build/signing identity. Stop the helper when the gateway exits or after the specified
idle timeout. Allow one bounded restart for a pre-action health failure; invalidate all
snapshot generations and never replay a mutation. A failed helper leaves the gateway and
desktop running with an unavailable status.

`prepare-package.mjs` stages the nested `.app` at
`.package/resources/host-computer/HomunComputerService.app` on macOS only. Codesigning and
notarization are intentionally deferred to plan 04.

- [ ] **Step 4: Run package, type, Rust, and Swift checks for GREEN**

Run:

```bash
cd apps/desktop
node --test tests/host-computer-package.test.mjs
npm run typecheck
cd ../..
swift test --package-path runtimes/host-computer/macos
cargo test -p local-first-host-computer
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit helper assembly and lifecycle**

```bash
git add apps/desktop runtimes/host-computer/macos
git commit -m "feat(computer): package native host helper"
```

## Phase completion gate

- [ ] `cargo test -p local-first-host-computer` passes.
- [ ] `swift test --package-path runtimes/host-computer/macos` passes.
- [ ] `cd apps/desktop && node --test tests/host-computer-package.test.mjs && npm run typecheck` passes.
- [ ] `cargo check --workspace` passes on macOS.
- [ ] The helper starts only with the feature flag, authenticates, reports permissions, and stops with Electron.
- [ ] No model-facing `use_computer` or granular action tool has been registered yet.
- [ ] `git diff --check` passes and the worktree is clean.
