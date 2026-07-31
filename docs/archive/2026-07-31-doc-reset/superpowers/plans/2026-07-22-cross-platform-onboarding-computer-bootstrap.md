# Cross-platform Homun Computer Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-run prerequisite detection refresh without restarting Homun and add a truthful, blocking Homun Computer preparation step that builds, starts, and verifies `homun-cc` on Windows, macOS, and Linux.

**Architecture:** Consolidate Docker discovery and native container creation in `sandbox.rs`, then expose a concurrency-safe setup coordinator through two gateway endpoints. The React wizard consumes phase status through a small tested view-model module and renders a dedicated preparation step before model selection.

**Tech Stack:** Rust 2024, Axum, Tokio, Reqwest, SHA-256, React 19, TypeScript, Node test runner, Electron packaging, Docker Desktop/Engine.

---

## File map

- Modify `crates/desktop-gateway/src/sandbox.rs`: platform-aware Docker resolution, host-home fallback, native Docker build/run lifecycle, image hashing, and pure argument tests.
- Create `crates/desktop-gateway/src/setup_computer.rs`: setup phase/state model and concurrency-safe coordinator.
- Modify `crates/desktop-gateway/src/main.rs`: coordinator in `AppState`, setup routes, bootstrap orchestration, CDP/noVNC verification, and fresh prerequisite detection.
- Create `apps/desktop/src/lib/onboardingComputer.mjs`: pure JavaScript onboarding phase/view-model helpers used by Node tests.
- Create `apps/desktop/src/lib/onboardingComputer.ts`: typed mirror used by React.
- Create `apps/desktop/src/lib/onboardingComputer.test.mjs`: frontend state and retry contract tests.
- Modify `apps/desktop/src/lib/coreBridge.ts`: setup-computer API types and methods.
- Modify `apps/desktop/src/components/OnboardingWizard.tsx`: explicit recheck and new blocking computer-preparation step.
- Modify `apps/desktop/src/styles.css`: flat progress surface and preparation-state styling.
- Modify `apps/desktop/src/i18n/locales/{en,it,fr,de,es}.json`: localized onboarding copy.
- Modify `apps/desktop/package.json`: focused onboarding-computer test script.
- Modify `apps/desktop/scripts/check-ui-contract.mjs`: packaged/UI invariants for the new flow.
- Create `apps/desktop/tests/contained-computer-package.test.mjs`: package context and Bash-independence contract.
- Create `docs/architecture/contained-computer.md`: document the native cross-platform bootstrap and setup endpoints.

### Task 1: Fresh cross-platform prerequisite detection

**Files:**
- Modify: `crates/desktop-gateway/src/sandbox.rs:20-160`
- Modify: `crates/desktop-gateway/src/main.rs:28631-28675`
- Test: `crates/desktop-gateway/src/sandbox.rs` (`mod tests`)
- Test: `crates/desktop-gateway/src/main.rs` (`mod tests`)

- [ ] **Step 1: Write failing resolver and home-directory tests**

Add pure helpers and tests that describe all platforms without depending on the host running the test:

```rust
#[test]
fn windows_docker_candidates_follow_program_files_without_path_restart() {
    let candidates = docker_candidate_paths(
        "windows",
        Some(r"D:\Apps"),
        None,
        None,
    );
    assert_eq!(
        candidates[0],
        PathBuf::from(r"D:\Apps\Docker\Docker\resources\bin\docker.exe")
    );
    assert!(candidates.contains(&PathBuf::from(
        r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"
    )));
}

#[test]
fn windows_home_falls_back_to_userprofile() {
    assert_eq!(
        host_home_dir_from(None, Some(r"C:\Users\Fabio"), Path::new(r"C:\Temp")),
        PathBuf::from(r"C:\Users\Fabio")
    );
}

#[test]
fn setup_docker_probe_uses_sandbox_resolver_contract() {
    assert!(super::setup_docker_status_from(false, false).docker_installed == false);
    assert!(super::setup_docker_status_from(true, true).docker_running);
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway windows_docker_candidates_
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway setup_docker_probe_
```

Expected: compile failure because the pure resolver/status helpers do not exist.

- [ ] **Step 3: Implement the fresh resolver contract**

Implement a resolver evaluated on every call:

```rust
fn docker_candidate_paths(
    platform: &str,
    program_files: Option<&str>,
    home: Option<&str>,
    explicit: Option<&str>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value));
    }
    match platform {
        "windows" => {
            if let Some(root) = program_files {
                paths.push(PathBuf::from(root).join(r"Docker\Docker\resources\bin\docker.exe"));
            }
            paths.push(PathBuf::from(
                r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
            ));
        }
        "macos" => {
            if let Some(root) = home {
                paths.push(PathBuf::from(root).join(".docker/bin/docker"));
            }
            paths.extend([
                PathBuf::from("/usr/local/bin/docker"),
                PathBuf::from("/opt/homebrew/bin/docker"),
                PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
            ]);
        }
        "linux" => {
            if let Some(root) = home {
                paths.push(PathBuf::from(root).join(".docker/bin/docker"));
            }
            paths.extend([
                PathBuf::from("/usr/bin/docker"),
                PathBuf::from("/usr/local/bin/docker"),
            ]);
        }
        _ => {}
    }
    paths.dedup();
    paths
}

pub fn docker_installed() -> bool {
    docker_bin() != "docker" || cli_ok("docker", &["--version"])
}
```

Replace setup's bare `run_cli("docker", ...)` checks with `sandbox::docker_installed()` and `sandbox::docker_running()`. Keep installed/running as distinct fields.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway docker_
```

Expected: all resolver/setup Docker tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/desktop-gateway/src/sandbox.rs crates/desktop-gateway/src/main.rs
git commit -m "fix: refresh onboarding runtime detection"
```

### Task 2: Native Docker lifecycle without Bash

**Files:**
- Modify: `crates/desktop-gateway/src/sandbox.rs:330-450`
- Test: `crates/desktop-gateway/src/sandbox.rs` (`mod tests`)

- [ ] **Step 1: Write failing image-hash and Docker-argument tests**

Add tests for the pure parts before changing execution:

```rust
#[test]
fn contained_computer_run_args_preserve_runtime_contract() {
    let args = contained_computer_run_args(&ContainedComputerRunConfig {
        artifacts_dir: PathBuf::from("/host/artifacts"),
        profile_dir: PathBuf::from("/host/profile"),
        timezone: "Europe/Rome".to_string(),
        network: Some("homun-net".to_string()),
    });
    assert!(args.windows(2).any(|pair| pair == ["--name", "homun-cc"]));
    assert!(args.windows(2).any(|pair| pair == ["--network", "homun-net"]));
    assert!(args.contains(&"127.0.0.1:9222:9222".to_string()));
    assert!(args.contains(&"127.0.0.1:6080:6080".to_string()));
    assert!(args.contains(&"127.0.0.1:9100:9000".to_string()));
    assert!(args.contains(&"TZ=Europe/Rome".to_string()));
}

#[test]
fn contained_computer_hash_is_deterministic_and_tracks_inputs() {
    let root = test_contained_computer_context();
    let first = contained_computer_def_hash_at(&root).expect("first hash");
    let second = contained_computer_def_hash_at(&root).expect("second hash");
    assert_eq!(first, second);
    fs::write(root.join("entrypoint.sh"), "changed").expect("change input");
    assert_ne!(first, contained_computer_def_hash_at(&root).expect("changed hash"));
}
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway contained_computer_run_args_
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway contained_computer_hash_
```

Expected: compile failure because native config/argument/hash helpers are absent.

- [ ] **Step 3: Implement Rust-native image hashing**

Replace the Bash hash command with SHA-256 over a stable ordered input list:

```rust
const CC_HASH_FILES: &[&str] = &[
    "Dockerfile",
    "entrypoint.sh",
    "deck_render.py",
    "deck_qa.py",
    "doc_render.py",
    "design_tokens.py",
    "fonts_embed.py",
    "fonts_manifest.py",
    "whisper_server.py",
    "novnc-view.html",
];

fn contained_computer_def_hash_at(dir: &Path) -> Option<String> {
    let mut hasher = sha2::Sha256::new();
    for relative in CC_HASH_FILES {
        hasher.update(fs::read(dir.join(relative)).ok()?);
    }
    let mut fonts = fs::read_dir(dir.join("fonts"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("woff2"))
        .collect::<Vec<_>>();
    fonts.sort();
    for font in fonts {
        hasher.update(fs::read(font).ok()?);
    }
    Some(format!("{:x}", hasher.finalize())[..16].to_string())
}
```

- [ ] **Step 4: Implement native build and run commands**

Introduce explicit phases and checked commands:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainedComputerBootstrapPhase {
    CheckingDocker,
    PreparingImage,
    StartingContainer,
}

pub fn ensure_contained_computer_with_progress(
    mut report: impl FnMut(ContainedComputerBootstrapPhase),
) -> Result<(), String> {
    report(ContainedComputerBootstrapPhase::CheckingDocker);
    ensure_docker()?;
    if container_up() && container_definition_fresh() {
        return Ok(());
    }
    report(ContainedComputerBootstrapPhase::PreparingImage);
    build_contained_computer_image()?;
    report(ContainedComputerBootstrapPhase::StartingContainer);
    start_contained_computer_container()?;
    wait_for_container_running()
}
```

`build_contained_computer_image()` must run optional `docker pull`, then checked `docker build` with the label and `--no-cache` flag. `start_contained_computer_container()` must create host directories, optionally reset the browser profile, remove stale `homun-cc`, and execute `docker run` using the pure argument builder. Do not invoke `bash`, PowerShell, WSL, or a login shell.

Keep `ensure_contained_computer()` as the compatibility wrapper:

```rust
pub fn ensure_contained_computer() -> Result<(), String> {
    ensure_contained_computer_with_progress(|_| {})
}
```

- [ ] **Step 5: Run focused sandbox tests and verify GREEN**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway contained_computer_
```

Expected: native lifecycle contract tests pass and existing sandbox tests remain green.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/sandbox.rs
git commit -m "feat: bootstrap contained computer natively"
```

### Task 3: Setup bootstrap coordinator and API

**Files:**
- Create: `crates/desktop-gateway/src/setup_computer.rs`
- Modify: `crates/desktop-gateway/src/main.rs:1-40,235-275,1015-1056,1295-1310,28630-28920`
- Test: `crates/desktop-gateway/src/setup_computer.rs`
- Test: `crates/desktop-gateway/src/main.rs` (`mod tests`)

- [ ] **Step 1: Write failing coordinator tests**

Create the module with tests first:

```rust
#[test]
fn coordinator_deduplicates_active_bootstrap() {
    let coordinator = SetupComputerCoordinator::default();
    let first = coordinator.begin();
    let second = coordinator.begin();
    assert!(matches!(first, BeginSetup::Start { generation: 1 }));
    assert_eq!(second, BeginSetup::AlreadyRunning);
}

#[test]
fn coordinator_retries_after_failure_and_ignores_stale_updates() {
    let coordinator = SetupComputerCoordinator::default();
    let BeginSetup::Start { generation } = coordinator.begin() else { panic!() };
    coordinator.fail(generation, "build failed");
    let BeginSetup::Start { generation: retry } = coordinator.begin() else { panic!() };
    assert!(retry > generation);
    coordinator.ready(generation);
    assert_ne!(coordinator.status().phase, SetupComputerPhase::Ready);
}
```

- [ ] **Step 2: Run coordinator test and verify RED**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway setup_computer::tests
```

Expected: compile failure because the module and coordinator do not exist.

- [ ] **Step 3: Implement the state model**

Define serialized phases and generation-guarded transitions:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupComputerPhase {
    Idle,
    CheckingDocker,
    PreparingImage,
    StartingContainer,
    VerifyingBrowser,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupComputerStatus {
    pub phase: SetupComputerPhase,
    pub ready: bool,
    pub error: Option<String>,
}

pub struct SetupComputerCoordinator {
    inner: Mutex<CoordinatorState>,
}
```

`begin`, `advance`, `ready`, and `fail` must update only the active generation. `begin` may restart from `idle`, `failed`, or an unhealthy `ready`, but not while another generation is active.

- [ ] **Step 4: Add API routes and orchestration**

Add the coordinator to every `AppState` constructor and register:

```rust
.route("/api/setup/computer/prepare", post(prepare_setup_computer))
.route("/api/setup/computer/status", get(get_setup_computer_status))
```

The prepare handler calls `begin()` and spawns one task. The task maps sandbox phases into coordinator phases, then performs bounded async readiness probes:

```rust
async fn verify_setup_computer(http: &reqwest::Client) -> Result<(), String> {
    wait_for_http_ok(http, "http://127.0.0.1:9222/json/version", 60).await
        .map_err(|_| "Homun Computer started, but its browser did not become ready.".to_string())?;
    wait_for_http_ok(http, "http://127.0.0.1:6080/vnc.html", 60).await
        .map_err(|_| "Homun Computer started, but its live view did not become ready.".to_string())
}
```

Return only classified, sanitized messages. Do not return raw Docker stderr or environment contents.

- [ ] **Step 5: Add endpoint/state tests**

Cover status serialization and start deduplication:

```rust
#[test]
fn setup_computer_status_serializes_stable_phase_names() {
    let status = SetupComputerStatus::for_phase(SetupComputerPhase::PreparingImage);
    let value = serde_json::to_value(status).expect("serialize status");
    assert_eq!(value["phase"], "preparing_image");
    assert_eq!(value["ready"], false);
}
```

- [ ] **Step 6: Run setup tests and verify GREEN**

Run:

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway setup_computer
```

Expected: coordinator and setup API contract tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/desktop-gateway/src/setup_computer.rs crates/desktop-gateway/src/main.rs
git commit -m "feat: coordinate onboarding computer bootstrap"
```

### Task 4: Typed frontend bootstrap model

**Files:**
- Create: `apps/desktop/src/lib/onboardingComputer.mjs`
- Create: `apps/desktop/src/lib/onboardingComputer.ts`
- Create: `apps/desktop/src/lib/onboardingComputer.test.mjs`
- Modify: `apps/desktop/src/lib/coreBridge.ts:1107-1170`
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Write failing Node view-model tests**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { computerProgressRows, canContinueFromComputer } from "./onboardingComputer.mjs";

test("preparing image completes only the Docker row", () => {
  assert.deepEqual(
    computerProgressRows("preparing_image").map((row) => row.state),
    ["done", "active", "pending", "pending"],
  );
});

test("only observed ready status unlocks model selection", () => {
  assert.equal(canContinueFromComputer({ phase: "ready", ready: true, error: null }), true);
  assert.equal(canContinueFromComputer({ phase: "starting_container", ready: false, error: null }), false);
});

test("failed state exposes retry without completing progress", () => {
  assert.equal(computerProgressRows("failed").some((row) => row.state === "error"), true);
});
```

- [ ] **Step 2: Add test script and verify RED**

Add:

```json
"test:onboarding-computer": "node --test src/lib/onboardingComputer.test.mjs"
```

Run `npm run test:onboarding-computer` from `apps/desktop`.

Expected: FAIL because the view-model module does not exist.

- [ ] **Step 3: Implement JS and typed mirror**

Expose stable types:

```ts
export type SetupComputerPhase =
  | "idle"
  | "checking_docker"
  | "preparing_image"
  | "starting_container"
  | "verifying_browser"
  | "ready"
  | "failed";

export interface SetupComputerStatus {
  phase: SetupComputerPhase;
  ready: boolean;
  error: string | null;
}
```

Implement the four-row phase mapping identically in `.mjs` and `.ts`, and add `coreBridge.prepareSetupComputer()` plus `coreBridge.setupComputerStatus()`.

- [ ] **Step 4: Run frontend model tests and typecheck**

Run:

```bash
npm run test:onboarding-computer
npm run typecheck
```

Expected: 3 tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/package.json apps/desktop/src/lib/onboardingComputer.mjs apps/desktop/src/lib/onboardingComputer.ts apps/desktop/src/lib/onboardingComputer.test.mjs apps/desktop/src/lib/coreBridge.ts
git commit -m "test: define onboarding computer state model"
```

### Task 5: Dedicated onboarding preparation step

**Files:**
- Modify: `apps/desktop/src/components/OnboardingWizard.tsx:1-380`
- Modify: `apps/desktop/src/styles.css:15759-16180`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`
- Modify: `apps/desktop/src/i18n/locales/fr.json`
- Modify: `apps/desktop/src/i18n/locales/de.json`
- Modify: `apps/desktop/src/i18n/locales/es.json`
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`

- [ ] **Step 1: Add failing UI-contract assertions**

Require the explicit step and actions:

```javascript
assertContains("src/components/OnboardingWizard.tsx", 'type Step = "prereq" | "computer" | "model" | "done"', "onboarding must have a computer preparation step");
assertContains("src/components/OnboardingWizard.tsx", "prepareSetupComputer", "computer step must start backend preparation");
assertContains("src/components/OnboardingWizard.tsx", "setupComputerStatus", "computer step must render observed backend status");
assertContains("src/components/OnboardingWizard.tsx", 't("onboarding.checkAgain")', "prerequisite screen must expose immediate recheck");
```

Run `npm run test:ui-contract`.

Expected: FAIL on the missing computer step.

- [ ] **Step 2: Implement immediate prerequisite recheck**

Extract `probePrerequisites` with an `isCheckingPrerequisites` guard. Keep the 4-second poll and wire a visible button that calls the same function immediately. The button must remain usable after Docker/Ollama installers close.

- [ ] **Step 3: Implement the computer step lifecycle**

Change the state union and normal transition:

```tsx
type Step = "prereq" | "computer" | "model" | "done";

async function enterComputerStep() {
  setStep("computer");
  await coreBridge.prepareSetupComputer();
}
```

While `step === "computer"`, poll `setupComputerStatus()` every second. On `ready`, enable Continue to the model step. On `failed`, show the returned safe error and a Try again button that calls `prepareSetupComputer()` once.

Render one flat surface with:

```tsx
<h1>{t("onboarding.computerTitle")}</h1>
<p>{t("onboarding.computerSubtitle")}</p>
<ul className="onb-computer-capabilities">
  <li>{t("onboarding.computerCapabilityBrowser")}</li>
  <li>{t("onboarding.computerCapabilityTools")}</li>
  <li>{t("onboarding.computerCapabilityArtifacts")}</li>
</ul>
```

Map the four progress rows through `computerProgressRows(status.phase)`. Do not infer readiness client-side.

- [ ] **Step 4: Add all five locale entries**

Add matching keys to every locale:

```json
{
  "checkAgain": "Check again",
  "computerTitle": "Preparing Homun Computer",
  "computerSubtitle": "Homun is creating an isolated computer for browsing, tools, and artifact creation.",
  "computerCapabilityBrowser": "Browse with a real contained browser",
  "computerCapabilityTools": "Run tools and skills in isolation",
  "computerCapabilityArtifacts": "Create files that remain available on this computer",
  "computerPhaseDocker": "Docker available",
  "computerPhaseImage": "Homun Computer image prepared",
  "computerPhaseContainer": "homun-cc started",
  "computerPhaseBrowser": "Browser and live view verified",
  "computerRetry": "Try again",
  "computerContinue": "Choose your AI model"
}
```

Translate naturally in Italian, French, German, and Spanish. Keep locale key parity exact.

- [ ] **Step 5: Add flat progress styling**

Use one `.onb-computer-progress` surface with separators, not nested cards. Add `.pending`, `.active`, `.done`, and `.error` row states, ensuring readable contrast in the onboarding dark theme.

- [ ] **Step 6: Run UI contracts, i18n parity, model tests, and typecheck**

Run:

```bash
npm run test:ui-contract
node --test tests/i18n-parity.test.mjs
npm run test:onboarding-computer
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/OnboardingWizard.tsx apps/desktop/src/styles.css apps/desktop/src/i18n/locales apps/desktop/scripts/check-ui-contract.mjs
git commit -m "feat: prepare Homun Computer during onboarding"
```

### Task 6: Packaging and architecture contracts

**Files:**
- Create: `apps/desktop/tests/contained-computer-package.test.mjs`
- Modify: `apps/desktop/package.json`
- Create: `docs/architecture/contained-computer.md`

- [ ] **Step 1: Write the failing package test**

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "../..");

test("packaged contained computer uses native gateway bootstrap", async () => {
  const prepare = await readFile(path.join(appRoot, "scripts", "prepare-package.mjs"), "utf8");
  const sandbox = await readFile(path.join(repoRoot, "crates", "desktop-gateway", "src", "sandbox.rs"), "utf8");
  assert.match(prepare, /contained-computer/);
  assert.match(sandbox, /docker_build_args|build_contained_computer_image/);
  assert.doesNotMatch(sandbox, /Command::new\("bash"\).*up_script/s);
});
```

Add `test:contained-computer-package` to `package.json`, run it, and expect RED until the native bootstrap markers are present.

- [ ] **Step 2: Align package contract and documentation**

Confirm `prepare-package.mjs` copies the full runtime context on every platform and document:

- setup endpoints and phases;
- native Docker CLI lifecycle;
- Windows/macOS/Linux executable resolution;
- CDP and noVNC acceptance checks;
- `up.sh` as a developer helper, not a packaged dependency.

- [ ] **Step 3: Run package and Electron tests**

Run:

```bash
npm run test:contained-computer-package
npm run test:electron
```

Expected: package contract passes; all Electron tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/tests/contained-computer-package.test.mjs apps/desktop/package.json docs/architecture
git commit -m "docs: define cross-platform computer bootstrap contract"
```

### Task 7: End-to-end verification and rendered UX

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run focused Rust gates**

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway setup_computer
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway contained_computer_
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway docker_
```

Expected: all focused tests pass.

- [ ] **Step 2: Run the full gateway binary suite**

```bash
CARGO_TARGET_DIR=/Users/fabio/Projects/Homun/app/target cargo test -p local-first-desktop-gateway --bin local-first-desktop-gateway
```

Expected: no failures; report ignored tests separately.

- [ ] **Step 3: Run frontend and production-build gates**

```bash
npm run test:onboarding-computer
npm run test:ui-contract
npm run test:electron
npm run typecheck
npm run build
```

Expected: all commands exit 0. A Vite large-chunk warning is non-fatal and must be reported as a warning, not hidden.

- [ ] **Step 4: Render and inspect the onboarding flow**

Run the isolated gateway on a non-default port with a temporary `HOMUN_DATA_DIR`, launch Vite, and inspect at 1440×900 and a narrower desktop width. Verify:

- Check again is visible and usable;
- the computer step explains isolation and capabilities;
- exactly four truthful progress rows render;
- failed state has an inline reason and Try again;
- ready state is the only normal path to model selection;
- browser console has no errors.

- [ ] **Step 5: Run static cross-platform checks**

```bash
git grep -n 'Command::new("bash")' -- crates/desktop-gateway/src/sandbox.rs
git diff --check
git status --short
```

Expected: no packaged bootstrap dependency on Bash, no whitespace errors, and only intentional branch changes.

If the Windows Rust target is installed, also run:

```bash
cargo check -p local-first-desktop-gateway --target x86_64-pc-windows-gnu
```

If it is unavailable, do not call Windows green: report that Windows compilation/package execution remains a CI and physical fresh-install gate.

- [ ] **Step 6: Commit any verification-only corrections**

If verification required changes:

```bash
git add <only-the-corrected-files>
git commit -m "fix: close onboarding bootstrap verification gaps"
```

If no changes were needed, do not create an empty commit.

### Task 8: Integration readiness

**Files:**
- No code changes expected.

- [ ] **Step 1: Inspect final branch scope**

```bash
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff --check main...HEAD
```

Expected: commits and files are limited to prerequisite refresh, native contained-computer bootstrap, setup coordinator/API, onboarding UI/locales, package contracts, and documentation.

- [ ] **Step 2: Record platform evidence honestly**

Report separately:

- locally verified Rust/frontend/rendered-app results;
- Windows compile/package CI status, if run;
- macOS/Linux compile/package status, if run;
- physical fresh-install smoke tests still required before release.

- [ ] **Step 3: Use branch-finishing workflow**

Invoke `superpowers:finishing-a-development-branch` and offer local merge, push/PR, keep, or discard. Do not merge or push without the user's selected option.
