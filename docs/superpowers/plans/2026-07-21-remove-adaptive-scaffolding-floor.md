# Remove Adaptive Scaffolding Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the obsolete adaptive-scaffolding experiment while preserving Homun's canonical memory, safety, routing, planning, and verification behavior.

**Architecture:** Delete the experiment at its boundaries first (UI and runtime-settings API), then collapse the gateway onto the existing flag-off behavior. Keep historical ADR material but update live architecture documents and mark ADR 0018 superseded.

**Tech Stack:** React/TypeScript desktop UI, Rust/Axum desktop gateway, JSON runtime settings, Node contract tests, Cargo tests.

---

### Task 1: Contract tests

**Files:**
- Modify: `apps/desktop/scripts/check-ui-contract.mjs`
- Modify: `crates/desktop-gateway/src/main.rs`

- [x] Add a UI contract assertion that `AdaptiveFloorBlock` and the adaptive-floor translation keys are absent.
- [x] Change the runtime-settings test expectation so serialized settings omit `adaptive_floor` and legacy input is discarded.
- [x] Run both focused tests and confirm they fail for the old implementation.

### Task 2: Desktop surface

**Files:**
- Modify: `apps/desktop/src/components/SettingsView.tsx`
- Modify: `apps/desktop/src/lib/coreBridge.ts`
- Modify: `apps/desktop/src/i18n/locales/en.json`
- Modify: `apps/desktop/src/i18n/locales/it.json`

- [x] Delete `AdaptiveFloorBlock` and its render site.
- [x] Remove `adaptive_floor` from `RuntimeSettings`.
- [x] Remove all localized labels.
- [x] Run the UI contract and typecheck.

### Task 3: Canonical gateway loop

**Files:**
- Delete: `crates/desktop-gateway/src/scaffold.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/model_registry.rs`

- [x] Remove the scaffold module, resolver, telemetry, routing relaxation, arguments, and tests.
- [x] Restore uniform verification and direct capability routing.
- [x] Remove adaptive-floor-only model-tier tests and comments while retaining tier-based role selection.
- [x] Run targeted gateway tests.

### Task 4: Current documentation

**Files:**
- Modify: `docs/decisions/0018-adaptive-harness-subagents-triggers.md`
- Modify: `docs/architecture/agent-loop.md`
- Modify: `docs/architecture/capability-registry.md`
- Modify: `docs/system-overview.md`
- Modify: `docs/STATO.md`

- [x] Mark ADR 0018 superseded by the canonical-loop decision.
- [x] Remove claims that adaptive-floor is a current or pending runtime option.
- [x] Leave archived plans and historical audits unchanged.

### Task 5: Verification and integration

- [x] Run gateway tests covering runtime settings, routing, and plan verification.
- [x] Run desktop UI contract, typecheck, and production build.
- [x] Run `git diff --check` and inspect the complete diff.
- [x] Commit without co-author trailers and merge locally into `main` without touching unrelated user files.
