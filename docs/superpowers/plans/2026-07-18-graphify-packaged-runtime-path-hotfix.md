# Graphify Packaged Runtime Path Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent project analysis from writing relative Graphify runtime files into a signed packaged application bundle.

**Architecture:** Keep Electron and gateway startup paths unchanged. Constrain only the Graphify child process by setting its current directory to the existing gateway-managed `_mirror`; verify the real `run_graphify` path with a fake CLI that records its working directory.

**Tech Stack:** Rust 2024, `std::process::Command`, Cargo tests, Electron Builder release pipeline, macOS codesign/Gatekeeper/notarization tools.

---

### Task 1: Add the packaged-path regression

**Files:**
- Modify: `crates/desktop-gateway/src/sandbox.rs`

- [ ] **Step 1: Add a Unix-only test module for the real Graphify runner**

Append a `#[cfg(all(test, unix))]` module. Create isolated project, output,
fake-binary, and marker paths under `std::env::temp_dir()` using a UUID. Put an
executable `graphify` script in the isolated binary directory that records `$PWD` to
the test's absolute marker path:

```sh
if [ "$1" = "--help" ]; then exit 0; fi
printf '%s' "$PWD" > '<absolute-marker-path>'
mkdir -p "$2/graphify-out"
printf '{"nodes":[],"edges":[]}' > "$2/graphify-out/graph.json"
```

Exercise a private `run_graphify_with_cli` seam shared with the public wrapper and
pass the absolute fake executable directly. Do not mutate process-wide `PATH` and do
not depend on a real `~/.local/bin/graphify`. Assert the recorded directory equals
`out.join("_mirror")` and use a drop guard to clean the temporary tree on failure.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cargo test -p local-first-desktop-gateway sandbox::tests::graphify_runs_from_gateway_managed_mirror -- --exact --nocapture
```

Expected: FAIL because the fake CLI records the repository/application working directory instead of `<out>/_mirror`.

- [ ] **Step 3: Commit the failing regression**

```bash
git add crates/desktop-gateway/src/sandbox.rs
git commit -m "test(gateway): reproduce graphify bundle write"
```

### Task 2: Constrain the Graphify subprocess

**Files:**
- Modify: `crates/desktop-gateway/src/sandbox.rs`

- [ ] **Step 1: Apply the minimal production change**

Set the child working directory on the existing Graphify command:

```rust
let extracted = Command::new("graphify")
    .args(["update"])
    .arg(&work)
    .arg("--no-cluster")
    .current_dir(&work)
    .env("PATH", &path)
    .output()
```

Canonicalize the output directory before deriving `work`, so an explicitly relative
`HOMUN_DATA_DIR` still supplies one absolute path to both `current_dir` and the
Graphify target argument. Add a concise comment explaining that Graphify writes
auxiliary relative files and a packaged gateway must never let those land in the
signed app bundle.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run the same focused Cargo command from Task 1, plus:

```bash
cargo test -p local-first-desktop-gateway sandbox::tests::graphify_managed_mirror_is_absolute_when_output_root_is_relative -- --exact --nocapture
```

Expected: PASS; the marker equals the gateway-managed mirror.

- [ ] **Step 3: Run the gateway sandbox test scope**

Run:

```bash
cargo test -p local-first-desktop-gateway sandbox -- --nocapture
```

Expected: all selected tests pass.

- [ ] **Step 4: Commit the fix**

```bash
git add crates/desktop-gateway/src/sandbox.rs
git commit -m "fix(gateway): keep graphify runtime files outside app bundle"
```

### Task 3: Verify, integrate, and release

**Files:**
- No source changes expected.

- [ ] **Step 1: Run repository verification**

Install browser/desktop dependencies as needed, then run:

```bash
make test
python3 scripts/pre_release_gate.py
```

Expected: browser tests and typecheck pass, the full Rust workspace passes, and the release gate ends with `ALL GREEN`.

- [ ] **Step 2: Fast-forward the verified branch into `main`**

Use a clean integration worktree based on the fetched `main`, fast-forward merge the hotfix branch, and rerun the focused regression on the merged commit.

- [ ] **Step 3: Push and tag the next patch release**

Push `main`, create the next unused annotated `v0.1.x` tag, and push the tag. Confirm `main`, `origin/main`, and the dereferenced tag share one commit.

- [ ] **Step 4: Monitor all native build jobs**

Wait for Linux, macOS, and Windows jobs to finish successfully. Confirm the macOS artifact is signed/notarized and Windows signing succeeds; publish the release only after all expected installers and updater metadata exist.

- [ ] **Step 5: Install and verify the macOS artifact before launch**

Verify the downloaded digest and DMG, install the app while retaining the previous version in `~/.homun/backups/app`, then run:

```bash
codesign --verify --deep --strict /Applications/homun.app
spctl --assess --type execute --verbose=2 /Applications/homun.app
xcrun stapler validate /Applications/homun.app
```

Expected: all three checks pass.

- [ ] **Step 6: Verify the exact post-launch regression**

Launch the installed app, map both registered projects twice, and confirm:

```bash
test ! -e /Applications/homun.app/Contents/graphify-out
codesign --verify --deep --strict /Applications/homun.app
spctl --assess --type execute --verbose=2 /Applications/homun.app
xcrun stapler validate /Applications/homun.app
```

Expected: no runtime output exists inside the bundle and all signature/notarization checks still pass.

- [ ] **Step 7: Re-run the metadata-only integrity audit twice**

Expected: Memory and Vault integrity are true, unknown scopes and Graphify duplicate relations are zero, both project graphs are fresh with zero duplicate nodes, and repeated analysis preserves Memory/Vault/graph checksums.
