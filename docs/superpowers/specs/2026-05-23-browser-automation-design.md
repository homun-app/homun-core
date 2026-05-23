# Browser Automation Design

## Goal

Build a production-ready browser automation module that can execute long, multi-step web tasks such as research, booking, form filling, authenticated workflows and verification, while preserving the project's local-first, policy-gated architecture.

Browser automation must be powerful, but it must not become an unbounded remote-control surface. Rust remains responsible for scheduling, permissions, approvals, audit, privacy boundaries and durable recovery. The browser engine is an execution surface behind explicit contracts.

## Reference

OpenClaw (`openclaw/openclaw`) is the primary reference for this module. It was inspected locally at commit `bcf756ce36397febcdc92fdbea825824c72d3427`.

The OpenClaw browser module is MIT licensed. If we port substantial code, we must preserve the copyright/license notice in copied or adapted files and document the origin in our repository.

OpenClaw patterns to reuse:

- dedicated agent browser profile separate from the user's daily browser.
- optional attach-only user profile for already-authenticated sessions.
- local control service with one stable browser tool contract.
- Playwright over CDP for advanced actions.
- snapshot/ref operating loop: observe, act on refs, observe again.
- role/ARIA/AI snapshot concepts, with refs treated as stale after navigation.
- tab labels and session tab tracking.
- atomic actions: open, navigate, snapshot, screenshot, click, type, press, hover, drag, select, fill, wait, upload, download, dialog, pdf, console.
- SSRF/navigation guards before and after navigation.
- controlled artifact directories for screenshots, downloads, uploads, traces and PDFs.
- explicit manual blockers for login, 2FA, CAPTCHA, payments and browser permissions.
- cleanup of browser tabs/processes at the end of subagent, cron or durable task sessions.
- dedicated browser automation skill/instructions for multi-step work.

OpenClaw pieces not to copy directly:

- Gateway/plugin lifecycle.
- OpenClaw-specific session model.
- OpenClaw-specific config schema and command CLI.
- OpenClaw's policy engine.
- OpenClaw's channel approval UX.

Those responsibilities already exist in our Rust Core, Durable Task Runtime, Capability Layer, Provider Registry and future Tauri UI.

## Key Decision

Do not use Playwright directly from Rust.

Playwright does not provide an official Rust binding. Community crates exist, but this module is too central to depend on partial feature parity. The browser engine will be a local Node/TypeScript sidecar using official `playwright-core`.

Architecture:

```text
Rust Core
  -> Durable Task Runtime
  -> Capability Layer / Provider Registry
  -> BrowserAutomationClient
       -> local Node/TS sidecar
            -> playwright-core
            -> Chromium CDP
            -> browser profiles and pages
```

The sidecar is local-only. It does not call cloud APIs, does not own autonomy, and does not decide permissions. It only executes validated browser operations.

## Components

### Node/TypeScript Sidecar

Location:

```text
runtimes/browser-automation/
```

Responsibilities:

- launch and stop local managed Chromium profiles.
- attach to user/existing-session profile when explicitly requested.
- expose a stable local JSON API over stdio first; loopback HTTP can be added later if the UI needs direct diagnostics.
- maintain Playwright/CDP sessions.
- list, open, focus, label and close tabs.
- return page snapshots with actionable refs.
- execute atomic browser actions.
- handle dialogs and file chooser arming.
- save screenshots, traces, PDFs and downloads to controlled local roots.
- return typed errors and browser state after actions.

Suggested internal modules:

```text
src/server.ts
src/contracts/
  request.ts
  response.ts
src/browser/
  config.ts
  profiles.ts
  lifecycle.ts
  session_manager.ts
  tabs.ts
  snapshot.ts
  actions.ts
  dialogs.ts
  downloads.ts
  navigation_guard.ts
  artifacts.ts
  errors.ts
```

### Rust Browser Automation Crate

Location:

```text
crates/browser-automation/
```

Responsibilities:

- define Rust contracts for requests/responses.
- validate policy before sidecar calls.
- supervise the sidecar process.
- enforce local paths and artifact roots.
- map browser calls to `TaskExecutor`.
- persist checkpoints for long tasks.
- expose UI-safe read models later.

Suggested modules:

```text
src/types.rs
src/client.rs
src/policy.rs
src/artifacts.rs
src/task_executor.rs
src/sidecar.rs
```

### Capability Provider

Location:

```text
crates/capabilities/src/browser_provider.rs
```

Responsibilities:

- expose browser actions as `CapabilityTool`s.
- mark provider kind as `Browser`.
- map action classes:
  - read: status, tabs, snapshot, screenshot, console.
  - draft: fill fields without submission, prepare form data.
  - write_with_confirmation: submit forms, booking steps, account changes.
  - approved_automation: recurring or long-running workflows already approved.
- include privacy domains and sensitivity in every tool.
- require provider grant from `CapabilityRegistryStore`.

### Durable Task Runtime Integration

Browser tasks always run through `TaskRuntime` when they are multi-step, long-running or side-effectful.

Resource class:

```text
browser_session
```

Task behavior:

- checkpoint after each observation and action.
- persist target profile, tab label, last URL, snapshot metadata and artifact refs.
- support `waiting_time` for polling/waiting.
- support `waiting_user_approval` for manual blockers or risky actions.
- support retry/backoff for transient browser/page failures.
- cleanup tracked tabs on completion/cancel/failure when configured.

## Browser Profiles

Initial profiles:

- `assistant`: managed local browser profile, default.
- `user`: attach-only existing browser profile, opt-in.

Rules:

- `assistant` is default for automation.
- `user` requires explicit provider grant and task-level permission.
- `user` is preferred only when existing cookies/login are necessary.
- Each profile has isolated artifact roots and policy configuration.
- Headless is allowed for low-risk read-only flows, but headed mode remains default for authenticated, booking, form or anti-bot-sensitive workflows.

## Contract

The first sidecar transport should be stdio JSON lines. This avoids exposing an HTTP control surface before auth/UI needs are clear.

Envelope:

```json
{
  "id": "req_1",
  "method": "browser.snapshot",
  "params": {
    "profile": "assistant",
    "target_id": "booking",
    "format": "role",
    "labels": true
  }
}
```

Response:

```json
{
  "id": "req_1",
  "ok": true,
  "result": {
    "target_id": "booking",
    "url": "https://example.com",
    "snapshot": "...",
    "refs": [{"ref": "e12", "role": "button", "name": "Continue"}],
    "artifacts": []
  }
}
```

Error:

```json
{
  "id": "req_1",
  "ok": false,
  "error": {
    "code": "BROWSER_STALE_REF",
    "message": "ref is stale; take a fresh snapshot",
    "retryable": true,
    "manual_action_required": false
  }
}
```

Initial methods:

```text
browser.health
browser.profiles
browser.start
browser.stop
browser.tabs
browser.open
browser.focus
browser.close_tab
browser.navigate
browser.snapshot
browser.screenshot
browser.act
browser.arm_file_chooser
browser.respond_dialog
browser.wait_download
browser.console
browser.pdf
```

## Action Model

Actions are atomic. Multi-step plans are composed by Rust tasks/subagents, not by the sidecar.

Initial `browser.act` kinds:

```text
click
click_coords
type
press
hover
drag
select
fill
resize
wait
evaluate
close
```

Rules:

- prefer refs from the latest snapshot.
- CSS selectors are not the public default for agent actions.
- coordinates are fallback only.
- after navigation, modal changes or form submit, take a fresh snapshot.
- stale refs fail fast.
- `evaluate` is disabled by default and requires explicit grant.
- timeouts and batch sizes are bounded.

## Policy And Safety

Browser automation inherits project-wide rules:

- deny-by-default.
- privacy domains required.
- no cloud dependency.
- local audit for every operation.
- secrets never stored in browser metadata or task checkpoints.
- side-effectful actions require appropriate autonomy and sometimes approval.

Navigation policy:

- allow only `http`, `https` and explicit safe non-network URLs such as `about:blank`.
- block `file`, `data`, `javascript`, `chrome`, `chrome-extension` and other protocols unless a future explicit local diagnostic mode allows them.
- private network and loopback navigation require explicit policy.
- validate requested URL before navigation and final URL after navigation.
- detect and report redirects that cross policy boundaries.

Manual blockers:

- login required.
- 2FA required.
- CAPTCHA.
- payment confirmation.
- destructive account or data changes.
- camera/microphone/screen permissions.
- unexpected browser permission prompt.

When a blocker is detected, the browser task moves to `waiting_user_approval` or `waiting_external_event` with a clear message and a current screenshot/snapshot artifact.

## Artifacts

All artifacts live under a controlled local root, scoped by user/workspace/task:

```text
data/browser-artifacts/<workspace>/<task>/
  screenshots/
  downloads/
  uploads/
  traces/
  pdf/
```

Rules:

- sidecar can only read upload files from approved upload roots.
- sidecar can only write artifacts inside task artifact roots.
- task checkpoints store artifact refs, not large binary payloads.
- UI read models expose redacted artifact metadata.

## Testing Strategy

Rust tests:

- request/response serialization.
- policy denies private network, unsupported protocols and risky action classes.
- sidecar client maps success/error envelopes.
- task executor checkpoints after each step.
- blockers move task to waiting state.
- capability provider exposes correct action classes and privacy metadata.

Node/TS tests:

- action schema validation.
- profile config validation.
- tab label tracking.
- snapshot/ref action loop on static fixture pages.
- stale ref failure.
- dialog/file chooser arming.
- artifact path confinement.
- navigation guard.

Integration tests:

- start sidecar.
- open local fixture page.
- snapshot -> fill -> submit -> wait -> screenshot.
- verify checkpoints and artifacts.
- verify task cleanup closes tracked tabs.

## Implementation Order

1. Port/adapt OpenClaw browser contracts, action schema and skill text with MIT attribution.
2. Build minimal Node/TS sidecar with stdio JSON lines.
3. Add Rust client and typed contracts.
4. Add Rust policy and artifact confinement.
5. Add `BrowserCapabilityProvider`.
6. Add `BrowserTaskExecutor`.
7. Add fixture-based integration tests.
8. Add docs and work-memory updates.

## Non-Goals For First Slice

- Full browser UI in Tauri.
- Remote browser nodes.
- Browser extension.
- Cross-device browser control.
- WebDriver/Selenium backend.
- Autonomous solving of CAPTCHA/2FA/payment prompts.
- Generic scraping framework outside policy/task runtime.

## First Slice Decisions

Resolved for the first implementation plan:

- Transport is stdio JSON lines only. Loopback HTTP can be added later for diagnostics after the sidecar contract is stable.
- Managed browser launch first discovers installed Chromium-based browsers. Playwright browser installation is a subsequent explicit helper, not a hidden side effect in the first slice.
- The first slice implements the managed `assistant` profile. The attach-only `user` profile is designed in the contract but implemented after managed profile behavior, policy and cleanup are stable.
