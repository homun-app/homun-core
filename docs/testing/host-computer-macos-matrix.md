# Host Computer Control macOS acceptance matrix

This is the release evidence contract for Host Computer Control. A row is complete
only when the named evidence exists; code presence is not a substitute for a physical
or signed-artifact check.

## Automated gates

| Area | Gate | Expected result |
| --- | --- | --- |
| Rust protocol, grants, redaction, session policy | `cargo test -p local-first-host-computer` | all tests pass |
| Isolated worker contract | `cargo test -p local-first-local-computer-session` | all tests pass |
| Gateway integration | `cargo test -p local-first-desktop-gateway host_computer` | all matching tests pass |
| Agent engine regression | `cargo test -p local-first-engine` | all tests pass |
| Native helper | `swift test --package-path runtimes/host-computer/macos` | all tests pass |
| Desktop state, packaging, reset, signing | Node test files under `apps/desktop` | all tests pass |
| Desktop contracts | `npm run test:ui-contract` and `npm run typecheck` | both pass |
| Gateway compilation | `cargo check -p local-first-desktop-gateway` | succeeds; baseline warnings are recorded, not described as warning-free |
| Patch hygiene | `git diff --check` | no whitespace errors |

The packaging suite must include a real helper launch and authenticated Unix-socket
handshake. The reset suite must use a temporary data root and prove removal of the
grant database plus WAL/SHM, journal, runtime socket root, and cached artifacts.

## Rendered UI gates

Inspect the real Settings -> Computer page at these viewport sizes:

| Viewport | Required evidence |
| --- | --- |
| 1280 x 800 | Mac Apps section remains readable after scrolling; no horizontal clipping |
| 1440 x 900 | permission rows, safety copy, and app grant controls align cleanly |
| 1728 x 1117 | contained and host surfaces remain visually separate; no nested-card clutter |

Repeat the inspection with the native helper unavailable and available. In the
available state, password-manager bundle identifiers must not appear, no app may be
preselected, and the authorize button must remain disabled until the user explicitly
chooses an app. Browser console errors caused by deliberately restarting the isolated
test gateway are excluded; the stable final page must report zero current errors.

## Physical macOS acceptance

These checks require a disposable test workspace and deliberate TCC interaction. Do
not run them against a user's active Homun workspace.

| Scenario | Pass condition |
| --- | --- |
| First launch without TCC grants | clear setup state; no automatic permission prompt |
| Accessibility grant | status becomes granted after returning from System Settings |
| Screen Recording grant | status becomes granted after the OS-required restart/refresh |
| Observe Notes/TextEdit | bounded semantic tree contains labels/roles and redacts values marked sensitive |
| Observe/control browser | signed app grant is required; a reversible press succeeds |
| Consequential text/send action | exact approval summary appears; deny performs no action; approve is single-use |
| Physical mouse/keyboard takeover | active action pauses and its prior resume generation is rejected |
| Password manager/login/auth UI | app grant is rejected or target is hard-denied; no screenshot/value is disclosed |
| Terminal input | hard-denied even with a control grant and an approval attempt |
| App update/signature change | old grant no longer resolves |
| Grant revoke during session | session cancels and snapshots are cleared |
| Helper/gateway crash | orphan helper exits; next launch creates a fresh private session |
| Factory reset | all grants, journal, sockets, and artifacts disappear and cannot be restored by a watchdog respawn |

Record macOS version, CPU architecture, Homun commit, target app versions, permission
state before/after, and the sanitized journal outcome for every physical run.

## Signed release-candidate gate

A release candidate is acceptable only if the actual packaged `.app` passes:

```bash
cd apps/desktop
npm run verify:host-computer-package -- --app "/path/to/Homun.app" --expected-arch arm64
```

The CI release job must run the same verifier after electron-builder and notarization.
Missing Apple credentials, an unsigned local build, failed Gatekeeper assessment, an
unstapled ticket, mismatched teams, forbidden entitlements, or the wrong architecture
is a failed or unavailable release gate, never a passing result.

The current distribution target is macOS Apple Silicon (`arm64`). Universal
`arm64+x86_64` support remains a separate distribution project and must not be listed
as supported until both the Rust gateway and Swift helper are built and verified for
both architectures.

## Local engineering evidence — 2026-07-21

Verified on macOS 26.5.1 (25F80), Apple Silicon (`arm64`), from the
`fabio/host-computer-control` worktree at `ecdd4f28`:

- 52 host-computer Rust integration tests passed;
- 9 local-computer-session tests passed;
- 8 focused gateway host-computer tests passed;
- 95 engine tests passed;
- 36 Swift helper tests passed;
- 42 Electron tests passed, including the package, reset, startup-order, and signing contracts, a real helper bundle
  launch and authenticated Unix-socket handshake;
- UI contract, TypeScript typecheck, production frontend build, and gateway `cargo check` passed;
- `npm run package:prepare` produced an `arm64` gateway and an `arm64` nested helper
  under `.package/resources`;
- the complete `scripts/pre_release_gate.py` finished green; its deck-renderer suite
  reported 4 explicit environment skips, which are recorded rather than counted as passes;
- gateway check retained 44 pre-existing gateway warnings and one pre-existing
  memory warning, so this result is not described as warning-free;
- the factory-reset test removed every host-control state path from a temporary data
  root and rejected broad/unrelated roots.

## Local rendered and helper-lifecycle evidence — 2026-07-21

The packaged desktop app and its native helper were exercised against disposable data
and user-data roots. No existing Homun workspace or macOS privacy permission was changed.

- first launch kept Mac Apps disabled and did not preselect an application;
- enabling the beta started one helper and reported Accessibility and Screen Recording
  as `not_determined`, with a clear setup state and no automatic permission prompt;
- the running-app selector excluded protected password-manager targets and kept
  authorization disabled until an application was selected;
- disabling and re-enabling the beta produced an observed helper process count of
  `1 -> 0 -> 1`, proving that opt-out shuts down the launchd-owned helper rather than
  leaking a duplicate process;
- a fresh packaged launch completed broker recovery before graph regeneration and did
  not reproduce the prior one-shot `database is locked` crash;
- the real Settings page was inspected at 1280 x 800, 1440 x 900, and 1728 x 1117;
  it remained readable, had no horizontal overflow, and accepted a physical mouse-wheel
  scroll at the smallest viewport;
- the stable inspected page showed no current console errors attributable to the final
  application state.

Not claimed by this run: granting real TCC permissions, observing or controlling a
third-party app, approval execution, physical takeover during a live action, protected
target behavior against a live third-party UI, signed-identity invalidation after an app
update, or a real Developer ID signed and notarized release candidate. The Mac was locked
during the external OS inspection and no privacy permission was changed. Intel/universal
compatibility is also not claimed. These rows remain explicit physical or release gates,
not passing placeholders.
