# Host Computer Control 04 UI and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a comprehensible, consent-driven Host Computer experience in Homun's settings and computer panel, package the native helper correctly under hardened runtime, erase all related state during factory reset, and prove the feature on real macOS applications and physical input devices before GA.

**Architecture:** The desktop UI consumes gateway status/grant/session read models and unified WebSocket events. Settings separates the existing Docker-contained computer from Mac Apps, makes TCC permissions and per-app grants explicit, and never grants through an agent action. The chat computer surface switches between contained and host sources with visible app/window/approval/takeover state. Electron packaging embeds and signs the helper as a nested app before signing the outer app; release gates validate signatures, notarization, updates, reset, and live application behavior.

**Tech Stack:** React 19, TypeScript, Electron, CSS, Node test runner, macOS codesign/notarytool, GitHub Actions, existing Electron Builder and release scripts.

---

**Depends on:** `2026-07-21-host-computer-03-agent-policy.md`

**Completes:** `docs/superpowers/specs/2026-07-21-host-computer-control-design.md`

## File map

- Modify `apps/desktop/src/lib/coreBridge.ts`: host status, app, grant, session, approval, resume, and cancel APIs.
- Modify `apps/desktop/src/lib/wsSubscription.ts`: typed host-computer events.
- Modify `apps/desktop/src/components/SettingsView.tsx`: contained-vs-host settings, permission setup, grant management, privacy controls.
- Modify `apps/desktop/src/components/ChatComputerPanel.tsx`: host source, snapshot, approval, takeover, and completion UI.
- Modify `apps/desktop/src/components/ContainedComputerView.tsx` only if source switching is extracted there.
- Modify `apps/desktop/src/styles.css`: host frame, source badge, status, permission, grant, and approval styling.
- Modify `apps/desktop/src/i18n/locales/{en,it,fr,de,es}.json`: translated host-control strings.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: structural host-control contracts.
- Add Node tests under `apps/desktop/src/lib/*.test.mjs` for host read-model reducers.
- Modify `apps/desktop/electron/main.cjs`: helper permission deep links, lifecycle, and factory reset cleanup.
- Modify `apps/desktop/scripts/build-host-computer-helper.mjs`: release bundle mode and entitlements.
- Modify `apps/desktop/scripts/prepare-package.mjs`: nested signing order and manifest.
- Modify `apps/desktop/build/entitlements.mac.plist`: outer-app requirements.
- Create `apps/desktop/resources/host-computer/entitlements.mac.plist`: least-privilege helper entitlements.
- Create `apps/desktop/scripts/verify-host-computer-package.mjs`: bundle/signature/notarization contracts.
- Modify `apps/desktop/package.json`: verification scripts and mac resources.
- Modify `.github/workflows/build.yml`: build, sign, verify, notarize, staple, and artifact checks.
- Create `docs/testing/host-computer-macos-matrix.md`: reproducible real-app and device acceptance record.
- Modify `README.md` and `docs/roadmap.md`, and create `SECURITY.md`, only after the beta
  and GA gates are evidenced.

### Task 1: Add typed desktop bridge and host session reducer

**Files:**
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/lib/wsSubscription.ts`
- Create: `apps/desktop/src/lib/hostComputerState.mjs`
- Create: `apps/desktop/src/lib/hostComputerState.ts`
- Create: `apps/desktop/src/lib/hostComputerState.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing reducer and request-shape tests**

Cover status unavailable/permissions/grants/ready; ordered session events; stale event
rejection; approval required/resolved; takeover/resume; cancel; screenshot artifact
replacement; terminal-denied error; and reconnect hydration.

```js
test("physical takeover invalidates approval controls and shows resume", () => {
  const active = state({ phase: "acting", pendingApproval: approval() });
  const paused = reduceHostComputerEvent(active, event("paused_by_user", { resume_generation: 2 }));
  assert.equal(paused.phase, "paused_by_user");
  assert.equal(paused.pendingApproval, null);
  assert.equal(paused.canResume, true);
});
```

Define exact bridge methods:

```ts
hostComputerStatus(): Promise<HostComputerStatus>;
hostComputerApps(): Promise<HostComputerApp[]>;
hostComputerGrants(): Promise<HostComputerGrant[]>;
grantHostComputerApp(input: GrantHostComputerAppInput): Promise<HostComputerGrant>;
revokeHostComputerGrant(grantId: string): Promise<void>;
presentHostComputerPermission(permission: "accessibility" | "screen_recording"): Promise<void>;
approveHostComputerAction(sessionId: string, actionDigest: string): Promise<void>;
denyHostComputerAction(sessionId: string, actionDigest: string): Promise<void>;
pauseHostComputerSession(sessionId: string): Promise<void>;
resumeHostComputerSession(sessionId: string, generation: number): Promise<void>;
cancelHostComputerSession(sessionId: string): Promise<void>;
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd apps/desktop
node --test src/lib/hostComputerState.test.mjs
```

Expected: FAIL because reducer, types, and bridge methods do not exist.

- [ ] **Step 3: Implement types, endpoint calls, and ordered event reduction**

Use discriminated unions for permission, session phase, and event type. Reject unknown
event shapes at the bridge boundary, retain the last known safe state, and request a fresh
status snapshot after a sequence gap. Never place typed text or screenshot bytes in React
state. Keep artifact references opaque.

- [ ] **Step 4: Run focused tests and typecheck for GREEN**

Run:

```bash
cd apps/desktop
node --test src/lib/hostComputerState.test.mjs
npm run typecheck
```

Expected: reducer tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit the typed desktop bridge**

```bash
git add apps/desktop/package.json apps/desktop/src/lib
git commit -m "feat(computer): bridge host session state"
```

### Task 2: Separate Contained Computer and Mac Apps in Settings

**Files:**
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

- [ ] **Step 1: Add failing UI and locale contracts**

Require two flat sections, explicit helper/TCC status, separate Accessibility and Screen
Recording actions, app grant rows with Observe/Control levels, revoke, privacy disclosure,
feature-disabled/unavailable states, and the Terminal restriction explanation. Require all
new translation keys in five locales and forbid nested card stacks.

```js
assertContains("src/components/SettingsView.tsx", "settings.computer.containedTitle", "contained computer must remain explicit");
assertContains("src/components/SettingsView.tsx", "settings.computer.macAppsTitle", "host apps need a separate section");
assertContains("src/components/SettingsView.tsx", "revokeHostComputerGrant", "grants must be revocable in settings");
assertNotContains("src/components/SettingsView.tsx", "grantHostComputerApp(session", "an agent session must never create grants");
```

- [ ] **Step 2: Run UI contracts and verify RED**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
```

Expected: FAIL on missing host settings and locale contracts.

- [ ] **Step 3: Implement consent-driven settings**

Keep the existing Docker controls unchanged under “Contained Computer”. Add a sibling “Mac
Apps” section showing helper version/availability, two TCC permission rows, and granted
apps. “Choose app” opens a list supplied by the gateway; users select Observe or Control
and confirm the resolved bundle/signing identity. Prompting/opening System Settings happens
only after an explicit click. Show the remote-provider disclosure default and allow
screenshot disclosure per workspace. Explain that secure fields, authorization screens,
password managers, and Terminal input cannot be controlled.

Use one flat reading surface with functional dividers, keyboard-accessible controls, live
status announcements, and no modal for ordinary revocation.

- [ ] **Step 4: Run UI contracts, reducer tests, and typecheck for GREEN**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
node --test src/lib/hostComputerState.test.mjs
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit settings and translations**

```bash
git add apps/desktop/src/components/SettingsView.tsx apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs apps/desktop/src/i18n/locales
git commit -m "feat(computer): add Mac Apps consent settings"
```

### Task 3: Render host observation, approval, and takeover in Chat Computer

**Files:**
- Modify: `apps/desktop/src/components/ChatComputerPanel.tsx`
- Modify: `apps/desktop/src/components/ContainedComputerView.tsx`
- Modify: `apps/desktop/src/styles.css`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`

- [ ] **Step 1: Add failing computer-panel contracts**

Require a source badge (`Contained` or `Mac`), app/window title, observation frame, phase,
approval summary and approve/deny controls, takeover/resume, cancel, terminal-denied copy,
error/retry, and screenshot alternative text. Forbid rendering raw AX values or action
parameters.

```js
assertContains("src/components/ChatComputerPanel.tsx", "hostComputerSession", "panel must consume host state");
assertContains("src/components/ChatComputerPanel.tsx", "approveHostComputerAction", "pending actions need explicit consent");
assertContains("src/components/ChatComputerPanel.tsx", "resumeHostComputerSession", "takeover pause must be resumable by the user");
assertNotContains("src/components/ChatComputerPanel.tsx", "pendingAction.params", "sensitive action parameters must not render");
```

- [ ] **Step 2: Run UI contracts and verify RED**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
```

Expected: FAIL because the panel supports the contained source only.

- [ ] **Step 3: Implement source-aware panel behavior**

Subscribe to unified `computer.live` state and host-prefixed `app.event` transitions, then
hydrate from the current read model. Keep the noVNC/terminal UI for contained sessions. For
host sessions render the latest approved
window artifact in a non-interactive image frame, the app/window identity, concise worker
activity, and controls based on phase. Approval shows category and human-readable effect,
not hidden values. “Pause”/“Take control” stops further actions through the pause route.
Physical input immediately overlays “Paused — you took control”; resume is a deliberate
button. Lock/sleep shows suspended without a resume button until unlocked.

If both sources exist, the currently active session leads and the user can switch tabs.
Never simulate a live stream when only periodic screenshots are available.

- [ ] **Step 4: Run UI tests, typecheck, and inspect target widths**

Run:

```bash
cd apps/desktop
npm run test:ui-contract
node --test src/lib/hostComputerState.test.mjs
npm run typecheck
```

Then launch the desktop and inspect the real rendered panel at 1280×800, 1440×900, and
1728×1117 for contained idle, host observing, approval, takeover, suspended, done, and
error states. Expected: no clipped controls, nested scroll traps, or ambiguous source.

- [ ] **Step 5: Commit the host computer panel**

```bash
git add apps/desktop/src/components apps/desktop/src/styles.css \
  apps/desktop/scripts/check-ui-contract.mjs apps/desktop/src/i18n/locales
git commit -m "feat(computer): show host app control in chat"
```

### Task 4: Make factory reset and uninstall cleanup complete

**Files:**
- Modify: `apps/desktop/electron/main.cjs`
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Create: `apps/desktop/tests/host-computer-reset.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write the failing reset-manifest test**

Require reset to stop the helper, cancel sessions, close token pipes, unlink the exact
socket/temp directory, delete grants/approvals/session artifacts, and remove helper caches.
The test must use a temporary fake Homun root and may not touch the real home directory.

```js
test("factory reset removes every host-computer state root", async () => {
  const root = await fixtureHomunRoot();
  await performFactoryReset({ homunRoot: root, helper: fakeHelper });
  assert.equal(fakeHelper.stopped, true);
  for (const path of hostComputerStatePaths(root)) assert.equal(await exists(path), false);
});
```

- [ ] **Step 2: Run the reset test and verify RED**

Run:

```bash
cd apps/desktop
node --test tests/host-computer-reset.test.mjs
```

Expected: FAIL because host helper state is not in the reset manifest.

- [ ] **Step 3: Extend reset through an explicit safe manifest**

Refactor the existing `lfpa:factory-reset` handler to accept an internal resolved root and
enumerate exact Homun-owned paths. Stop the helper before gateway/database removal. Delete
host grant rows through the database cleanup, pending approval files, managed screenshot
artifacts, socket/temp directories, and non-sensitive logs. macOS TCC permissions are
system-owned and cannot be silently removed; after reset, show instructions/link to revoke
them in System Settings. Do not broaden deletion beyond the resolved Homun root.

- [ ] **Step 4: Run reset, UI, and type tests for GREEN**

Run:

```bash
cd apps/desktop
node --test tests/host-computer-reset.test.mjs
npm run test:ui-contract
npm run typecheck
```

Expected: all tests pass against temporary data only.

- [ ] **Step 5: Commit complete cleanup**

```bash
git add apps/desktop/electron/main.cjs apps/desktop/src/components/SettingsView.tsx \
  apps/desktop/tests/host-computer-reset.test.mjs apps/desktop/package.json
git commit -m "feat(computer): reset all host control state"
```

### Task 5: Sign, verify, notarize, and update the nested helper

**Files:**
- Modify: `apps/desktop/scripts/build-host-computer-helper.mjs`
- Modify: `apps/desktop/scripts/prepare-package.mjs`
- Create: `apps/desktop/scripts/verify-host-computer-package.mjs`
- Create: `apps/desktop/resources/host-computer/entitlements.mac.plist`
- Modify: `apps/desktop/build/entitlements.mac.plist`
- Modify: `apps/desktop/package.json`
- Modify: `.github/workflows/build.yml`
- Create: `apps/desktop/tests/host-computer-signing.test.mjs`

- [ ] **Step 1: Write failing packaging/signing-order tests**

Require the helper bundle to be staged in the final Resources location before outer-app
signing; helper identifier/entitlements/team match; helper signature is sealed by the
outer signature; no ad-hoc signature in release; notarization/stapling verification; and
Windows/Linux packages contain no helper.

```js
test("release signing orders nested code before the outer app", () => {
  assert.deepEqual(signingPlan("mac"), [
    "host-helper-executable", "host-helper-bundle", "outer-electron-app"
  ]);
  assert.deepEqual(signingPlan("linux"), []);
});
```

- [ ] **Step 2: Run package tests and verify RED**

Run:

```bash
cd apps/desktop
node --test tests/host-computer-package.test.mjs tests/host-computer-signing.test.mjs
```

Expected: FAIL because release signing verification is not implemented.

- [ ] **Step 3: Implement least-privilege nested signing and verification**

Give the helper hardened runtime and only entitlements proven necessary by live testing;
do not grant network server/client, microphone, camera, contacts, calendars, location, or
Apple Events by default. Sign the helper executable and bundle with the same Developer ID
team, then sign the outer app. Preserve the helper bundle identity across updates so TCC
grants remain stable. The verifier runs:

```bash
codesign --verify --deep --strict --verbose=4 Homun.app
codesign -d --entitlements :- Homun.app/Contents/Resources/host-computer/HomunComputerService.app
spctl --assess --type execute --verbose=4 Homun.app
xcrun stapler validate Homun.app
```

Parse failures and print paths/identities without secrets. In CI, build the nested helper
for `arm64` and `x86_64`, create or verify a universal binary, sign, build the DMG/ZIP,
notarize, staple, verify again, and upload only after every check passes.

- [ ] **Step 4: Run local package contracts and signed CI gate**

Run locally:

```bash
cd apps/desktop
node --test tests/host-computer-package.test.mjs tests/host-computer-signing.test.mjs
npm run typecheck
```

On the release runner, run `npm run verify:host-computer-package -- --app <Homun.app>`.
Expected: local structural tests pass; CI confirms the nested and outer signatures,
Gatekeeper assessment, notarization ticket, universal architectures, and packaged helper
version.

- [ ] **Step 5: Commit release packaging**

```bash
git add .github/workflows/build.yml apps/desktop
git commit -m "build(computer): sign and verify host helper"
```

### Task 6: Execute the macOS beta and GA acceptance matrix

**Files:**
- Create: `docs/testing/host-computer-macos-matrix.md`
- Modify: `README.md`
- Create: `SECURITY.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Create the evidence template before testing**

Record app version, macOS version, architecture, display arrangement/scaling, input device,
provider locality, grant level, action, expected/actual result, artifact/screen recording,
and issue link. Required matrix:

```text
Fixture: every semantic action, stale snapshot, secure field denial
Finder: list/open/select/drag, destructive approval
Notes: observe/type/save approval, multi-window
Xcode: navigate/read, editor typing approval, terminal input denial
Safari or Chrome: navigate/form, password field denial, download approval
Terminal, iTerm, Warp: observe only; all input paths denied
Multiple displays: Retina + scaled + negative-origin arrangement
Input: mouse, trackpad, keyboard takeover
Lifecycle: lock/unlock, sleep/wake, helper crash/restart, app quit/relaunch
Permissions: none, AX only, capture only, both, revoked during session
Packaging: clean install, upgrade preserving bundle identity, factory reset
```

- [ ] **Step 2: Run the full automated gate from a clean checkout**

Run:

```bash
cargo test -p local-first-host-computer
cargo test -p local-first-local-computer-session
cargo test -p local-first-desktop-gateway host_computer
cargo test -p local-first-engine
swift test --package-path runtimes/host-computer/macos
cd apps/desktop
node --test src/lib/hostComputerState.test.mjs tests/host-computer-package.test.mjs \
  tests/host-computer-reset.test.mjs tests/host-computer-signing.test.mjs
npm run test:ui-contract
npm run typecheck
cd ../..
git diff --check
```

Expected: every listed command exits 0. Do not describe unrelated or excluded workspace
tests as passing.

- [ ] **Step 3: Run the real beta matrix with observation first**

Use an internal feature flag and begin with Observe grants only. Verify fixture, Finder,
Notes, Xcode, one browser, protected targets, displays, and physical takeover. Then enable
Control for the same bounded set and run every approval/denial. Capture silent screen
recordings and written results. Any secure-field, Terminal, stale-target, approval, or
takeover failure blocks beta expansion.

- [ ] **Step 4: Validate crash, upgrade, reset, and release assets**

Kill the helper during observation and mutation; expected: fail closed, no repeated action,
desktop survives, user sees unavailable/retry. Upgrade a signed prior beta to the candidate;
expected: stable helper identity and valid existing grants. Factory reset; expected: no
grants, sessions, artifacts, sockets, or cached state, and clear TCC revocation guidance.
Install the actual DMG/ZIP candidate and repeat a Finder/Notes protected-target canary.

- [ ] **Step 5: Publish truthful documentation and release notes**

Only after the recorded beta matrix and signed-asset checks pass, update README, SECURITY,
privacy/provider disclosure, supported macOS version, permissions, protected targets,
Terminal limitation, physical takeover, reset behavior, and troubleshooting. Mark Windows
and Linux host-app control unsupported; keep their existing contained computer behavior.

- [ ] **Step 6: Commit acceptance evidence and documentation**

```bash
git add docs/testing/host-computer-macos-matrix.md README.md SECURITY.md docs/roadmap.md
git commit -m "docs(computer): record macOS control acceptance"
```

## Release completion gate

- [ ] Settings clearly separates Docker-contained and Mac-app control.
- [ ] Grants and TCC prompts require explicit local user interaction and are revocable.
- [ ] Chat renders accurate source, app/window, approval, takeover, suspension, and completion states.
- [ ] Factory reset removes all Homun-owned host-control state and explains system-owned TCC revocation.
- [ ] Nested helper and outer app signatures, notarization, stapling, architectures, and update identity are verified on actual release assets.
- [ ] Automated targeted suites and every required real-app/device scenario have recorded evidence.
- [ ] Secure targets, Terminal input, stale snapshots, approval bypass, or takeover regression are release blockers.
- [ ] Documentation states exact support and limitations; GA is not claimed from mocks or fixture-only tests.
- [ ] `git diff --check` passes and the worktree is clean.
