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

- [x] Add failing tests for `full`, `confirm`, `autonomous`, and `read_only` chat approvals.
- [x] Run the focused chat approval tests and confirm policy mismatches fail.
- [x] Normalize `task.input_json.approval` into `ExecutionPolicy`, preserving explicit non-chat permission rules.
- [x] Re-run the focused tests and confirm all approval mappings pass.

### Task 2: Effect host contract

**Files:**
- Create: `crates/desktop-gateway/src/effect_host.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Add failing unit tests for logical-call identity, policy denial before prepare, completed replay, started-to-uncertain resolution, and legacy receipt reuse.
- [x] Run the focused host tests and confirm the missing module/API is the failure.
- [x] Implement `EffectRequest`, `EffectDecision`, `EffectLease`, and `EffectHost` begin/complete/mark-uncertain methods.
- [x] Keep canonical JSON hashing and receipt identity private to the host.
- [x] Re-run the focused tests and confirm they pass without warnings.

### Task 3: Generic tool migration

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [x] Cover replay/no-redispatch at the host boundary used by the executor.
- [x] Replace the inline generic receipt block with `EffectHost::begin` and map `Replay`/`Resolve` to existing `ToolOutcome` semantics.
- [x] Complete the claimed lease through the host after domain dispatch and route `use_computer` through the same boundary.
- [x] Remove obsolete receipt identity and canonical hashing helpers from `main.rs`.
- [x] Run focused gateway receipt tests and confirm they pass.

### Task 4: Channel adapter-output migration

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [x] Add failing tests that matching channel adapter output is authorized and a non-channel/read-only contract cannot use the adapter-output path.
- [x] Replace `channel_reply_receipt` and manual store transitions with the effect host.
- [x] Preserve replay, uncertain status projection, and post-completion `thread.updated` publication.
- [x] Run the focused channel projection tests and confirm they pass.

### Task 5: Browser mutation migration

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [x] Add failing tests for browser effect classification; the host tests cover missing durable scope fail-closed.
- [x] Carry the validated contract and run id from the manager executor into `GatewayBrowseExecutor`, `GatewayBrowserExecutor`, and `BrowserToolCtx`.
- [x] Keep browser navigation/observation receipt-free.
- [x] After browser safety and payment validation, claim an `ExternalWrite` receipt immediately before `BrowserMethod::Act` and complete or mark uncertain around the sidecar call.
- [x] Guard `browser_rehydrate` with the same host immediately before the rehydrate sidecar mutation.
- [x] Run browser safety, rehydrate, payment approval, and gateway receipt tests.

### Task 6: Cleanup, documentation, and verification

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-29-general-effect-host-design.md`
- Modify: `docs/superpowers/plans/2026-07-29-general-effect-host.md`

- [x] Remove duplicated or dead receipt helpers and stale comments.
- [x] Document the general effect sequence and browser/channel ownership boundary.
- [x] Run `rustfmt --edition 2024 --check` on every changed Rust file. The workspace-wide check remains red on unrelated pre-existing formatting drift, so no broad mechanical churn was included.
- [x] Run `cargo test -p local-first-desktop-gateway effect_host -- --nocapture`.
- [x] Run `cargo test -p local-first-desktop-gateway execution_runtime -- --nocapture`.
- [x] Run `cargo test --workspace`.
- [x] Run `RUSTFLAGS='-D warnings' cargo build --workspace`.
- [x] Run frontend typecheck/build and Electron tests.
- [x] Restart the dev app from this worktree and verify ports `1420` and `18765` plus gateway health.

### Task 7: Review hardening

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/task-runtime/tests/effect_receipts.rs`
- Modify: `crates/engine/src/contract.rs`
- Modify: `crates/engine/src/agent_loop.rs`
- Modify: `crates/desktop-gateway/src/effect_host.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Make capability prepare+claim atomic under task owner, lease, revision, and fence.
- [x] Fence adapter-output claims to the authoritative execution revision.
- [x] Carry browser effects through the general `ToolOutcome` and suspend on uncertain receipts.
- [x] Type unknown connector transport outcomes and suspend instead of completing their receipts.
- [x] Prevent Telegram retry after a timeout or lost response.
- [x] Bind channel output to the contract thread and channel operation.
- [x] Prevent `read_only` chat metadata from widening approval to `Preauthorized`.
- [x] Add regression tests for reclaimed attempts, browser suspension, connector finish policy, channel scope, Telegram retry policy, and stale read-only metadata.

### Task 8: Recovery and lease-generation hardening

**Files:**
- Modify: `crates/task-runtime/src/{types,lease,store,execution_store}.rs`
- Modify: `crates/desktop-gateway/src/{main,execution_projection,execution_runtime}.rs`
- Test: `crates/task-runtime/tests/{lease,effect_receipts}.rs`
- Test: `crates/desktop-gateway/src/main.rs`

- [x] Preserve `SuspendedEffect.receipt_ref` through the recursive browse result and manager outcome.
- [x] Persist an immutable lease generation distinct from heartbeat time.
- [x] Fence heartbeat, effect claim, worker result guard, and execution commit against that generation.
- [x] Reject acquisition of any active lease, including a concurrent runner with the same worker id.
- [x] Apply the pre-dispatch-only Telegram retry policy to text and inline-button sends.
- [x] Resolve uncertain receipts for both suspended revisions and terminal adapter output.
- [x] Make verified `NotApplied` receipts safely dispatchable again without changing logical identity.
- [x] Keep uncertain channel projection pending until receipt resolution and projector replay.
- [x] Expose authenticated list/resolve endpoints and replay committed projections after resolution.
- [x] Serialize resolution plus terminal replay per receipt and reject concurrent followers without redispatch.
- [x] Re-run the complete backend/frontend/Electron verification matrix after these changes.
- [x] Restart the dev app and verify both ports plus gateway health.
