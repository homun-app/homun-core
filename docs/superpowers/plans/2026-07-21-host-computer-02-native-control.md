# Host Computer Control 02 Native Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the authenticated helper complete, deterministic macOS observation and semantic action capabilities with snapshot-generation safety, screenshot artifacts, hard protected-target denials, and takeover detection, while keeping all capabilities inaccessible to the model.

**Architecture:** The Swift helper resolves running applications and windows, normalizes an Accessibility tree into bounded snapshots, captures only approved windows through ScreenCaptureKit, and executes semantic AX actions before controlled CGEvent fallbacks. Every target belongs to a snapshot generation; focus or UI changes invalidate stale targets. A local policy firewall inside the helper blocks protected apps, secure fields, and all Terminal input even if a future gateway bug sends such a request.

**Tech Stack:** Swift 6, AppKit, AXUIElement, ScreenCaptureKit, CoreGraphics, OSLog privacy annotations, Rust DTOs and integration tests.

---

**Depends on:** `2026-07-21-host-computer-01-foundation.md`

**Unblocks:** `2026-07-21-host-computer-03-agent-policy.md`

## File map

- Modify `crates/host-computer/src/protocol.rs`: application, window, snapshot, action, artifact, takeover DTOs.
- Modify `crates/host-computer/src/client.rs`: typed observation and action methods.
- Modify `crates/host-computer/src/service.rs`: snapshot lifecycle and artifact-root facade.
- Create `crates/host-computer/tests/native_contract.rs`: fixture-driven typed client coverage.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/ApplicationResolver.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/WindowResolver.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/AXSnapshotBuilder.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/ElementRegistry.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/ScreenCaptureService.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/ActionExecutor.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/ProtectedTargetPolicy.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/InputTakeoverMonitor.swift`.
- Create `runtimes/host-computer/macos/Sources/HomunComputerService/HostSessionMonitor.swift`.
- Modify `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`.
- Add focused Swift tests for each service under `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/`.

### Task 1: List applications and windows with stable identities

**Files:**
- Modify: `crates/host-computer/src/protocol.rs`
- Modify: `crates/host-computer/src/client.rs`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/ApplicationResolver.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/WindowResolver.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/ApplicationResolverTests.swift`

- [ ] **Step 1: Write failing resolver tests**

Test duplicate app names, apps with no bundle identifier, hidden/background processes,
minimized windows, untitled windows, multiple spaces, and deterministic sorting. Identity
must use `(pid, processStartTime)` for an app and `(pid, cgWindowId)` for a window; never
use a title as identity.

```swift
func testDuplicateNamesRemainDistinctByPidAndStartTime() throws {
    let apps = resolver.resolve(fixtureProcesses(named: "Notes", pids: [101, 202]))
    XCTAssertEqual(apps.map(\.identity.pid), [101, 202])
    XCTAssertEqual(Set(apps.map(\.identity)).count, 2)
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ApplicationResolverTests
cargo test -p local-first-host-computer --test native_contract
```

Expected: FAIL because native observation DTOs and resolvers are absent.

- [ ] **Step 3: Implement application/window inventory**

Add `list_apps` and `list_windows` protocol methods. Return app name, bundle ID, PID,
start time, activation policy, active/hidden state, and icon artifact reference; return
window ID, title, bounds in global points, minimized/on-screen state, display ID, and app
identity. Filter system background processes by default but allow `include_background`.
Cap responses at 500 apps and 1,000 windows with an explicit `truncated` flag.

- [ ] **Step 4: Run Swift and Rust tests for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ApplicationResolverTests
cargo test -p local-first-host-computer --test native_contract
```

Expected: resolver and typed-client tests pass.

- [ ] **Step 5: Commit inventory support**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): inventory host apps and windows"
```

### Task 2: Normalize bounded accessibility snapshots

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/AXSnapshotBuilder.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/ElementRegistry.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Modify: `crates/host-computer/src/protocol.rs`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/AXSnapshotBuilderTests.swift`
- Create: `crates/host-computer/tests/snapshot_contract.rs`

- [ ] **Step 1: Write failing snapshot tests**

Cover deterministic depth-first indices, ignored elements, cyclic AX graphs, missing
attributes, timeouts, 2,000-node/12-depth/2-second bounds, sensitive-value redaction,
action lists, coordinates across Retina displays, and generation invalidation.

```rust
#[test]
fn secure_elements_never_deserialize_a_value() {
    let snapshot = snapshot_fixture("secure-field-redacted.json");
    let secure = snapshot.elements.iter().find(|e| e.role == "AXSecureTextField").unwrap();
    assert_eq!(secure.value, None);
    assert!(secure.sensitive);
    assert!(!secure.actions.contains(&SemanticAction::SetValue));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter AXSnapshotBuilderTests
cargo test -p local-first-host-computer --test snapshot_contract
```

Expected: FAIL because snapshots and registry do not exist.

- [ ] **Step 3: Implement snapshot normalization and registry**

`get_app_state` activates no app and mutates no focus. It accepts an app/window identity,
walks the AX tree, and returns:

```rust
pub struct AppSnapshot {
    pub snapshot_id: Uuid,
    pub generation: u64,
    pub captured_at_unix_ms: i64,
    pub app: HostApplication,
    pub window: Option<HostWindow>,
    pub elements: Vec<HostElement>,
    pub focused_element_index: Option<u32>,
    pub screenshot_ref: Option<ArtifactRef>,
    pub truncated: bool,
}
```

Expose only role, subrole, label, help, selected safe value, normalized bounds, enabled,
focused, selected, expanded, actions, parent index, and child indices. Never expose raw AX
object addresses. Keep AX references only in an in-memory `ElementRegistry` keyed by
`(snapshot_id, generation, index)` and expire entries after 60 seconds or focus/window
change. Return `stale_snapshot`, never silently retarget.

Support `tree_mode: full|diff` and `base_snapshot_id`. The first observation, helper
restart, missing base, stale base, or explicit recovery always returns a full tree. A diff
contains inserted/updated/removed indices plus the immutable new snapshot ID and can only
reference the immediately preceding snapshot in the same session; tests must reconstruct
the exact normalized full tree from every emitted diff.

- [ ] **Step 4: Run snapshot tests for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter AXSnapshotBuilderTests
cargo test -p local-first-host-computer --test snapshot_contract
```

Expected: all snapshot bounds, redaction, and generation tests pass.

- [ ] **Step 5: Commit snapshot observation**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): expose semantic accessibility snapshots"
```

### Task 3: Capture approved windows as managed artifacts

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/ScreenCaptureService.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Modify: `crates/host-computer/src/protocol.rs`
- Modify: `crates/host-computer/src/service.rs`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/ScreenCaptureServiceTests.swift`
- Create: `crates/host-computer/tests/artifact_contract.rs`

- [ ] **Step 1: Write failing capture and artifact-boundary tests**

Test permission denied, missing/off-screen window, display scale conversion, window-only
filtering, maximum 8,192 pixels per dimension, PNG encoding, artifact TTL, path traversal,
and JSON responses that never contain base64 pixels or absolute paths.

```rust
#[test]
fn screenshot_response_contains_an_opaque_reference_only() {
    let response = screenshot_response_fixture();
    let json = serde_json::to_value(response).unwrap();
    assert!(json.get("artifact_ref").is_some());
    assert!(json.get("data").is_none());
    assert!(!json.to_string().contains("/Users/"));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ScreenCaptureServiceTests
cargo test -p local-first-host-computer --test artifact_contract
```

Expected: FAIL because capture and artifact handling are absent.

- [ ] **Step 3: Implement ScreenCaptureKit capture and artifact ownership**

Capture the requested `SCWindow` only, excluding desktop, menu bar, other windows, and the
Homun overlay. Write PNG files atomically beneath the per-session artifact root created by
Rust. Rust validates the helper's returned relative filename, computes size and SHA-256,
renames it to a content-addressed managed name, and returns an opaque `artifact_ref`.
Expire unreferenced screenshots after 30 minutes and all session captures at session end.

- [ ] **Step 4: Run capture tests for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ScreenCaptureServiceTests
cargo test -p local-first-host-computer --test artifact_contract
```

Expected: capture filtering and artifact-boundary tests pass.

- [ ] **Step 5: Commit managed captures**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): capture approved host windows"
```

### Task 4: Execute semantic actions with stale-target protection

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/ActionExecutor.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Modify: `crates/host-computer/src/protocol.rs`
- Modify: `crates/host-computer/src/client.rs`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/ActionExecutorTests.swift`
- Create: `crates/host-computer/tests/action_contract.rs`

- [ ] **Step 1: Write failing semantic-action tests**

Cover launch, activate window, click/press, set value, select text, type text, press key,
scroll, drag, secondary action, stale generation, disabled action, missing target, and AX
failure without coordinate fallback. Require a fresh snapshot after every mutation.

```swift
func testStaleGenerationNeverRetargetsTheCurrentElementAtSameIndex() async throws {
    registry.install(snapshot: oldSnapshot)
    registry.install(snapshot: newSnapshot)
    await XCTAssertThrowsHostError(.staleSnapshot) {
        try await executor.click(target: .init(snapshotID: oldSnapshot.id, generation: 1, index: 4))
    }
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ActionExecutorTests
cargo test -p local-first-host-computer --test action_contract
```

Expected: FAIL because action execution does not exist.

- [ ] **Step 3: Implement semantic-first actions**

Use `AXUIElementPerformAction`, settable AX attributes, and native app activation first.
Only `click`, `drag`, and `scroll` may fall back to CGEvent, and only when the request
explicitly supplies coordinates derived from the same fresh snapshot. Reject raw
coordinates outside the target window. Normalize modifiers to a fixed enum. Limit typed
text to 20,000 Unicode scalars and key sequences to 50 events per request. Return a new
`snapshot_required: true` flag after every successful mutation.

- [ ] **Step 4: Run action tests and fixture smoke test for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ActionExecutorTests
cargo test -p local-first-host-computer --test action_contract
swift run --package-path runtimes/host-computer/macos HomunComputerFixture
```

Expected: automated tests pass. In the fixture, exercise click, checkbox, popup, text,
scroll, keyboard shortcut, secondary action, and drag; verify each appears once in its
visible event log.

- [ ] **Step 5: Commit semantic actions**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): execute semantic host actions"
```

### Task 5: Enforce protected-target and host-terminal denials in the helper

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/ProtectedTargetPolicy.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/AXSnapshotBuilder.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/ActionExecutor.swift`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/ProtectedTargetPolicyTests.swift`
- Create: `crates/host-computer/tests/protected_target_contract.rs`

- [ ] **Step 1: Write failing hard-denial tests**

Test `loginwindow`, SecurityAgent, authorization dialogs, TCC panes, known password-manager
bundle IDs, all `AXSecureTextField` elements, and Terminal/iTerm/Warp input. Terminal may be
listed and observed but its text fields, keyboard actions, click-to-focus-input, paste, and
menu command execution must be blocked.

```swift
func testTerminalInputCannotBeReenabledByRequestFlags() throws {
    let request = actionRequest(bundleID: "com.apple.Terminal", overrideApproval: true)
    XCTAssertThrowsError(try policy.authorize(request)) {
        XCTAssertEqual(($0 as? HostError)?.code, .terminalInputBlocked)
    }
}
```

- [ ] **Step 2: Run focused policy tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter ProtectedTargetPolicyTests
cargo test -p local-first-host-computer --test protected_target_contract
```

Expected: FAIL because the helper policy firewall is absent.

- [ ] **Step 3: Implement non-overridable local denials**

Evaluate protected targets after resolving the real PID/bundle ID and AX role, not from
request-supplied metadata. Remove sensitive values and action affordances from snapshots;
then re-evaluate immediately before execution to prevent time-of-check/time-of-use bypass.
Hard denials ignore grants and approvals. Maintain the protected bundle list in a typed
Swift constant with tests; unknown password managers can still be denied later by gateway
grant policy, but secure roles are always blocked generically.

- [ ] **Step 4: Run helper and Rust policy tests for GREEN**

Run:

```bash
swift test --package-path runtimes/host-computer/macos
cargo test -p local-first-host-computer
```

Expected: all protected-target tests pass without weakening observation of ordinary apps.

- [ ] **Step 5: Commit the helper firewall**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): harden protected host targets"
```

### Task 6: Detect physical takeover and host lock suspension

**Files:**
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/InputTakeoverMonitor.swift`
- Create: `runtimes/host-computer/macos/Sources/HomunComputerService/HostSessionMonitor.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/ActionExecutor.swift`
- Modify: `runtimes/host-computer/macos/Sources/HomunComputerService/RequestRouter.swift`
- Modify: `crates/host-computer/src/protocol.rs`
- Create: `runtimes/host-computer/macos/Tests/HomunComputerProtocolTests/TakeoverMonitorTests.swift`
- Create: `crates/host-computer/tests/takeover_contract.rs`

- [ ] **Step 1: Write failing takeover state-machine tests**

Cover physical mouse, trackpad scroll, keyboard, synthetic Homun events, lock, unlock,
sleep, wake, and focus change. Homun's tagged CGEvents must not trigger takeover. A physical
event pauses before the next queued action and requires an explicit new resume token.

```rust
#[test]
fn physical_input_invalidates_the_current_resume_token() {
    let mut state = TakeoverState::active("resume-1");
    state.apply(HostInputEvent::PhysicalMouseDown);
    assert_eq!(state.phase, TakeoverPhase::PausedByUser);
    assert!(!state.accepts("resume-1"));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
swift test --package-path runtimes/host-computer/macos --filter TakeoverMonitorTests
cargo test -p local-first-host-computer --test takeover_contract
```

Expected: FAIL because takeover and host-session state do not exist.

- [ ] **Step 3: Implement event tagging and fail-closed suspension**

Tag generated CGEvents with a process-random marker in `kCGEventSourceUserData`. Monitor
the HID event tap for untagged mouse, trackpad, and keyboard activity while an automation
session is active. Publish `paused_by_user` and invalidate the resume token atomically.
Subscribe to workspace session resign/lock and sleep notifications; return `host_locked`
until unlock and a fresh snapshot. If the event tap cannot be installed, disable mutation
capability but keep observation available.

- [ ] **Step 4: Run automated tests and a real-input smoke test**

Run:

```bash
swift test --package-path runtimes/host-computer/macos
cargo test -p local-first-host-computer
```

Then run the fixture session, begin a repeated semantic action, and physically move/click
with both a mouse and trackpad. Expected: the helper pauses before another mutation, does
not resume with the old token, and resumes only after an explicit new token. Locking the
Mac suspends the session.

- [ ] **Step 5: Commit takeover protection**

```bash
git add crates/host-computer runtimes/host-computer/macos
git commit -m "feat(computer): pause host control on user takeover"
```

## Phase completion gate

- [ ] All Swift tests pass with `swift test --package-path runtimes/host-computer/macos`.
- [ ] All Rust tests pass with `cargo test -p local-first-host-computer`.
- [ ] The fixture app passes every semantic action and stale-generation test.
- [ ] Screenshots exist only as managed opaque artifacts.
- [ ] Secure fields, protected apps, authorization UI, and host-terminal input remain hard denied locally.
- [ ] Real mouse and trackpad input pause control; lock/sleep suspend it.
- [ ] No model-facing computer tool is registered.
- [ ] `git diff --check` passes and the worktree is clean.
