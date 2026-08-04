# Release Stability Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Homun installer candidate depend on reproducible kernel, security, artifact, and installed-upgrade evidence before it can be published.

**Architecture:** Keep `scripts/pre_release_gate.py` as the deterministic entry point and make the existing installer matrix depend on one validation job. Improve the existing process-level crash and soak harnesses instead of adding another execution lifecycle, then add deterministic checksum artifacts and an explicit post-build/pre-publication installed-candidate gate.

**Tech Stack:** Rust integration tests, Python `unittest`, Node.js built-ins and `node:test`, GitHub Actions, Electron Builder.

---

### Task 1: Make gateway crash failures diagnosable and remove the port reservation race

**Files:**
- Modify: `crates/desktop-gateway/tests/gateway_crash_recovery.rs`

- [ ] Add tests proving a reserved loopback port cannot be rebound before release and proving bounded log output retains the error tail.
- [ ] Run `cargo test -p local-first-desktop-gateway --test gateway_crash_recovery reserved_port -- --nocapture` and the bounded-log test; confirm they fail because the helpers do not exist.
- [ ] Add `ReservedPort`, release it immediately before `Command::spawn`, and include bounded log text in every startup panic.
- [ ] Run the crash-recovery integration target repeatedly and confirm every run passes with no orphan gateway process.
- [ ] Commit as `test(gateway): stabilize crash recovery harness`.

### Task 2: Promote formatting, warning denial, and npm audit into the deterministic gate

**Files:**
- Modify: `scripts/pre_release_gate.py`
- Modify: `scripts/test_pre_release_gate.py`

- [ ] Add failing plan-contract assertions for Rust formatting, workspace Clippy with `-D warnings`, and desktop `npm audit --audit-level=high` before the existing suites.
- [ ] Run `python3 -m unittest scripts.test_pre_release_gate -v` and confirm the new assertions fail.
- [ ] Add the three deterministic commands while preserving fail-fast ordering and optional live checks at the end.
- [ ] Run the plan-contract tests and the three new commands directly.
- [ ] Commit as `ci(release): make warnings and audits mandatory`.

### Task 3: Require canonical evidence in the hard-restart soak

**Files:**
- Modify: `scripts/stability_soak.py`
- Modify: `scripts/test_stability_soak.py`
- Modify: `scripts/test_pre_release_gate.py`

- [ ] Add failing evaluator tests for a terminal task with zero terminal events, zero assistant identities, and duplicate evidence.
- [ ] Add a failing plan test requiring optional soak invocation with `--hard-restart`.
- [ ] Run both Python test modules and observe the expected failures.
- [ ] Require exactly one terminal event and assistant identity for every expected turn, and implement `SIGKILL` restart without changing metadata-only reporting.
- [ ] Run unit tests and `python3 scripts/stability_soak.py --hard-restart` against an isolated profile.
- [ ] Commit as `test(runtime): harden canonical restart soak`.

### Task 4: Generate deterministic installer checksums

**Files:**
- Create: `apps/desktop/scripts/create-artifact-checksums.mjs`
- Create: `apps/desktop/tests/artifact-checksums.test.mjs`
- Modify: `apps/desktop/package.json`

- [ ] Add Node tests for sorted SHA-256 output, checksum-file exclusion, platform-independent basenames, and failure on an empty artifact set.
- [ ] Run `node --test tests/artifact-checksums.test.mjs` and confirm module-not-found failure.
- [ ] Implement the script with Node `crypto`, deterministic bytewise filename ordering, and atomic output replacement.
- [ ] Add a `release:checksums` package script and run the focused tests.
- [ ] Commit as `feat(release): generate installer checksums`.

### Task 5: Make GitHub packaging depend on release readiness

**Files:**
- Modify: `.github/workflows/build.yml`
- Modify: `apps/desktop/tests/electron-main-names.test.mjs`

- [ ] Add workflow-contract assertions that the installer matrix has `needs: validate`, that validation runs the deterministic gate and RustSec audit, and that each platform uploads checksums.
- [ ] Run the focused Electron workflow-contract test and confirm it fails on the missing validation job.
- [x] Add a `validate` job, pin the Node 24 RustSec audit-check to commit `858dc40f52ca2b8570b7a997c1c4e35c6fc9a432`, make the build matrix depend on it, and generate/upload checksum manifests for workflow artifacts and tag drafts.
- [ ] Ensure publishing credentials remain scoped only to tag-only upload steps and draft creation remains unchanged.
- [ ] Run Electron tests, YAML inspection tests, and `actionlint` when available.
- [ ] Commit as `ci(release): gate installer matrix on kernel readiness`.

### Task 6: Define and execute the installed upgrade gate

**Files:**
- Create: `docs/testing/release-candidate-matrix.md`
- Modify: `docs/release-macos.md`
- Modify: `docs/METHODOLOGY.md`
- Modify: `docs/STATO.md`

- [ ] Document exact pre-tag dispatch, artifact inspection, isolated-profile upgrade, canonical turn, HITL, cancellation, hard restart, uncertain-effect resolution, Vault, memory, connector, sandbox, signature, notarization, checksum, and updater checks.
- [ ] Explicitly require that any failure leaves the release draft unpublished and that stale `v0.1.1079`/`v0.1.1093` drafts are not promoted.
- [ ] Run link/path checks, `git diff --check`, and the complete deterministic pre-release gate.
- [ ] Push the branch and run `Build installers` with `workflow_dispatch` on the branch.
- [ ] Inspect all three workflow artifacts and checksum manifests; record the run URL and result in `docs/STATO.md`.
- [ ] Merge only after the branch CI and dispatch build are green; then configure repository protection and rerun CI on `main`.

### Final Verification

- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run `cargo clippy --workspace --all-targets --locked -- -D warnings`.
- [ ] Run `python3 scripts/pre_release_gate.py`.
- [ ] Run `cargo audit` and `npm --prefix apps/desktop audit --audit-level=high`.
- [ ] Confirm the worktree is clean and no gateway process from test fixtures remains.
- [ ] Confirm no version tag or public release was created by this work.
