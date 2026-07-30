# Browser Sidecar Crash Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove process-level browser recovery and fail-closed browser effect replay using the existing Homun contracts.

**Architecture:** Exercise the production TypeScript stdio entrypoint against a separate real Chromium process, hard-kill it, then restore through a replacement sidecar. Exercise the existing Rust effect host with a browser-scoped receipt and require `Uncertain -> Resolve`, without adding another adapter or persistence path.

**Tech Stack:** TypeScript, Vitest, Playwright CDP, Rust, SQLite task runtime.

---

### Task 1: Real Sidecar Process Crash E2E

**Files:**
- Create: `runtimes/browser-automation/tests/crash_recovery_stdio.test.ts`

- [x] **Step 1: Add a JSON-lines sidecar client helper**

Spawn `node node_modules/tsx/dist/cli.mjs src/server.ts` with the shared CDP endpoint and browser
epoch in its environment. Correlate each response by request id and reject on timeout, process exit
or sidecar protocol error.

- [x] **Step 2: Drive a real browser draft to a checkpoint**

Start a local fixture server and external Chromium, then call `browser.open`, `browser.snapshot`,
`browser.act` and `browser.checkpoint` through stdio. Assert the checkpoint carries a CDP target id.

- [x] **Step 3: Hard-kill and replace the sidecar**

Send `SIGKILL`, confirm Chromium still exposes the checkpoint target, spawn a second sidecar and call
`browser.restore` with the persisted checkpoint fields.

- [x] **Step 4: Assert recovery boundaries**

Require `adopted_live_page`, generation advancement on the first fresh snapshot, preserved draft
text, a new ref generation and rejection of the old ref.

- [x] **Step 5: Run the focused sidecar gate**

Run: `npm test -- --run tests/crash_recovery_stdio.test.ts`

Expected: one passing process-level recovery test with no leaked Chromium or sidecar process.

### Task 2: Browser Effect Receipt Replay Boundary

**Files:**
- Modify: `crates/desktop-gateway/src/effect_host.rs`

- [x] **Step 1: Add a browser-scoped receipt test**

Prepare and begin an `ExternalWrite` request whose operation is `browser_act`, then abandon the
dispatch lease to model process loss after dispatch and before acknowledgement.

- [x] **Step 2: Prove fail-closed replay**

Assert the persisted status is `Uncertain` and a second begin for the same idempotency key returns
`Resolve`; it must never return `Execute`.

- [x] **Step 3: Run the focused Rust gate**

Run: `cargo test -p local-first-desktop-gateway effect_host::tests::browser_action_process_loss`

Expected: the browser-specific replay test passes.

### Task 3: Verification and Documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-browser-sidecar-crash-recovery-design.md`
- Modify: `docs/STATO.md`
- Modify: `docs/TURN_CONTRACT.md`

- [x] **Step 1: Run sidecar tests and typecheck**

Run: `cd runtimes/browser-automation && npm test && npm run typecheck`

Expected: all tests pass and TypeScript reports no errors.

- [x] **Step 2: Run Rust production gates**

Run: `cargo fmt --all -- --check`

Run: `cargo clippy --workspace --all-targets -- -D warnings`

Run: `cargo test --workspace`

Expected: formatting, warning-free compilation and all tests pass.

- [x] **Step 3: Run desktop gates and audits**

Run the repository's documented Electron test, UI contract, build and dependency audit commands.

Expected: all gates pass with no unresolved warning or vulnerability.

- [x] **Step 4: Verify the active dev runtime**

Confirm the Vite, gateway and Electron development processes are running from the current worktree;
restart only stale components and exercise the health endpoint.

- [x] **Step 5: Record the result**

Mark this plan complete, set the design status to implemented and verified, and update the canonical
status/turn-contract documents with the exact bounded guarantee and remaining provider gaps.

- [x] **Step 6: Commit and push**

Stage only this increment, commit without co-author metadata and push `main`.
