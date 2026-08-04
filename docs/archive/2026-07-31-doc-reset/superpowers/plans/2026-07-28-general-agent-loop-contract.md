# General Agent Loop Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal and resumed turns share one validated objective, effect, memory, continuation, and terminal-status contract.

**Architecture:** Extend the existing objective contract and `OpenWorkSnapshot`; do not add a second scheduler or HITL protocol. The semantic decision module owns validation and effect-policy projection, the HITL module owns durable resume snapshots, and the broker turn executor owns terminal objective status.

**Tech Stack:** Rust, serde/serde_json, SQLite/rusqlite, Tokio, Cargo tests, Electron/Vite smoke validation.

---

### Task 1: Contract helpers and resume validation

**Files:**
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Modify: `crates/desktop-gateway/src/hitl_resume.rs`

- [x] Add failing tests proving a read-only active contract cannot gain write effects on resume, a mixed contract retains exact effects and memory intent, and an agent-loop resume has no selected capability.
- [x] Run `cargo test -p local-first-desktop-gateway hitl_resume -- --nocapture` and verify the new assertions fail against the hard-coded write list.
- [x] Add shared mode fallback/effect-policy parsing helpers and make `hitl_resume_semantic_decision` restore the durable contract then call `validate_decision`.
- [x] Re-run the focused test and verify it passes.

### Task 2: Durable OpenWork contract and complete objective

**Files:**
- Modify: `crates/desktop-gateway/src/hitl_resume.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`

- [x] Add failing serialization and harness tests for objective revision, completion policy, memory/Vault intent, and remaining plan steps.
- [x] Add a failing projection test proving a new objective retains the bounded complete source request while a same-objective resume keeps the active objective.
- [x] Run the focused tests and verify they fail because the fields/request-aware projection do not exist.
- [x] Extend `OpenWorkSnapshot` with a backward-compatible resume contract and bounded plan steps; snapshot them when persisting the wait.
- [x] Add request-aware objective projection and include durable resume data in the harness slot.
- [x] Re-run the focused tests and verify they pass.

### Task 3: One effect policy for exposure and dispatch

**Files:**
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Add failing tests for filesystem, artifact, and external tool classification and for a mixed contract that allows only one of those classes.
- [x] Run the focused tests and verify current mode-only pruning permits a disallowed effect.
- [x] Implement `ObjectiveEffectPolicy` and route both pruning and execution-time checks through it, retaining read-only mode only as a legacy fallback.
- [x] Re-run the focused tests and verify exposure and dispatch agree.

### Task 4: Objective terminal projection

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`

- [x] Add failing store tests for revision-guarded `active -> completed/cancelled` transitions and stale revision rejection.
- [x] Add failing turn-executor decision tests for delivered, free wait, hold wait, parked, cancelled, and no-answer branches.
- [x] Run the focused tests and verify objective status currently remains active.
- [x] Implement the guarded store transition and a pure objective-status projection used by the broker terminal boundary.
- [x] Re-run the focused tests and verify only final delivery completes the matching objective.

### Task 5: Contract documentation and regression verification

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-28-general-agent-loop-contract-design.md`
- Modify: `docs/superpowers/plans/2026-07-28-general-agent-loop-contract.md`

- [x] Update the live contract with effect-policy, resume snapshot, memory/Vault, and objective-terminal invariants.
- [x] Run scoped `rustfmt --check` on changed Rust modules. Global `cargo fmt --all -- --check` remains non-clean on unrelated pre-existing files and is not bulk-applied.
- [x] Run `cargo test -p local-first-desktop-gateway hitl_resume -- --nocapture`.
- [x] Run `cargo test -p local-first-task-runtime objective_contract -- --nocapture`.
- [x] Run `cargo test --workspace`.
- [x] Run `RUSTFLAGS='-D warnings' cargo build --workspace` and confirm no compiler warnings.
- [x] Install desktop dependencies and run desktop build, UI-contract and Electron tests.
- [x] Install browser-runtime dependencies and run typecheck, 79 tests and zero-vulnerability audit.

### Task 6: Runtime smoke and completeness audit

**Files:**
- Runtime evidence only; update docs only if the observed contract differs.

- [x] Stop the old development instance and launch `npm run electron:dev` from this worktree.
- [ ] Complete the entire generic browser/HITL test through form draft. Search, three Choice waits and same-contract resumes passed; the post-choice browser reset from generation 76 to 1 before form completion.
- [x] Inspect SQLite and trace evidence for exact effect policy, memory/Vault intent, objective revision, wait payload, browser generation continuity, message/task/run terminal states, and objective status.
- [x] Compare implementation against the previous security, sandbox, Vault, connector, long-running, stream ownership, and external-agent-loop analyses.
- [x] Report implemented, partially implemented, and still missing items separately in the implementation audit and final handoff.
