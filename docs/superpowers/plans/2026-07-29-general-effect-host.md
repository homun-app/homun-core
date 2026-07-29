# General Effect Host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every consequential gateway dispatch through one contract-authorized durable effect host.

**Architecture:** Add a focused `effect_host` module over `TaskStore` and `ValidatedExecutionContract`, then replace duplicate receipt code in generic tools and channel projection. Carry the same validated scope into browser recursion and claim immediately before mutating sidecar calls, while preserving all existing domain gates.

**Tech Stack:** Rust 2024, Tokio, SQLite task runtime, canonical execution protocol, existing browser safety and gateway tests.

---

### Task 1: Canonical chat execution policy

**Files:**
- Modify: `crates/desktop-gateway/src/execution_runtime.rs`
- Test: `crates/desktop-gateway/src/execution_runtime.rs`

- [ ] Add failing tests for `full`, `confirm`, `autonomous`, and `read_only` chat approvals.
- [ ] Run `cargo test -p local-first-desktop-gateway execution_runtime::tests::chat_approval -- --nocapture` and confirm policy mismatches fail.
- [ ] Normalize `task.input_json.approval` into `ExecutionPolicy`, preserving explicit non-chat permission rules.
- [ ] Re-run the focused tests and confirm all approval mappings pass.

### Task 2: Effect host contract

**Files:**
- Create: `crates/desktop-gateway/src/effect_host.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [ ] Add failing unit tests for logical-call identity, policy denial before prepare, completed replay, started-to-uncertain resolution, and legacy receipt reuse.
- [ ] Run `cargo test -p local-first-desktop-gateway effect_host::tests -- --nocapture` and confirm the missing module/API is the failure.
- [ ] Implement `EffectRequest`, `EffectKind`, `EffectDecision`, `EffectLease`, and `EffectHost` begin/complete/mark-uncertain methods.
- [ ] Keep canonical JSON hashing and receipt identity private to the host.
- [ ] Re-run the focused tests and confirm they pass without warnings.

### Task 3: Generic tool migration

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [ ] Add a failing executor test proving replay returns persisted tool output without entering `execute_chat_tool`.
- [ ] Replace the inline generic receipt block with `EffectHost::begin` and map `Replay`/`Resolve` to existing `ToolOutcome` semantics.
- [ ] Complete the claimed lease through the host after domain dispatch.
- [ ] Remove obsolete receipt identity and canonical hashing helpers from `main.rs`.
- [ ] Run focused gateway receipt tests and confirm they pass.

### Task 4: Channel adapter-output migration

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [ ] Add failing tests that matching channel adapter output is authorized and a non-channel/read-only contract cannot use the adapter-output path.
- [ ] Replace `channel_reply_receipt` and manual store transitions with the effect host.
- [ ] Preserve replay, uncertain status projection, and post-completion `thread.updated` publication.
- [ ] Run the focused channel projection tests and confirm they pass.

### Task 5: Browser mutation migration

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [ ] Add failing tests for browser effect classification and missing durable scope.
- [ ] Carry the validated contract and run id from the manager executor into `GatewayBrowseExecutor`, `GatewayBrowserExecutor`, and `BrowserToolCtx`.
- [ ] Keep browser navigation/observation receipt-free.
- [ ] After browser safety and payment gates, claim an `ExternalWrite` receipt immediately before `BrowserMethod::Act` and complete or mark uncertain around the sidecar call.
- [ ] Guard `browser_rehydrate` with the same host immediately before the rehydrate sidecar mutation.
- [ ] Run browser safety, rehydrate, and gateway receipt tests.

### Task 6: Cleanup, documentation, and verification

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-29-general-effect-host-design.md`
- Modify: `docs/superpowers/plans/2026-07-29-general-effect-host.md`

- [ ] Remove duplicated or dead receipt helpers and stale comments.
- [ ] Document the general effect sequence and browser/channel ownership boundary.
- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run `cargo test -p local-first-desktop-gateway effect_host -- --nocapture`.
- [ ] Run `cargo test -p local-first-desktop-gateway execution_runtime -- --nocapture`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `RUSTFLAGS='-D warnings' cargo build --workspace`.
- [ ] Run frontend typecheck/build and Electron tests.
- [ ] Restart the dev app from this worktree and verify ports `1420` and `18765` plus gateway health.
