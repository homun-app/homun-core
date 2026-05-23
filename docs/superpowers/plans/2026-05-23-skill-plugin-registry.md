# Skill Plugin Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Skill/Plugin Registry so skills and plugin bundles are installable, versioned, permission-aware and visible as capability tools.

**Architecture:** Extend the Capability Layer with focused skill/plugin contracts, a SQLite registry and a read-only `SkillCapabilityProvider`. The registry stores manifests and user/workspace install state; execution remains disabled until a later sandbox runtime block.

**Tech Stack:** Rust 2024, serde, serde_json, rusqlite, time, local-first-capabilities.

---

## File Structure

- Modify `crates/capabilities/src/types.rs` for richer manifest/install contracts.
- Add `crates/capabilities/src/skill_plugin.rs` for registry and provider logic.
- Modify `crates/capabilities/src/lib.rs` to export the new module.
- Add `crates/capabilities/tests/skill_plugin_registry.rs`.
- Update `PROJECT.md`.
- Update `docs/work-memory.md`.

### Task 1: Skill And Plugin Contracts

- [x] Write failing contract tests for `SkillToolManifest`, `PluginManifest`, `SkillInstallRecord` and `PluginInstallRecord`.
- [x] Run `cargo test -p local-first-capabilities --test skill_plugin_registry contracts_serialize_skill_plugin_manifests`.
- [x] Implement the contract types in `types.rs`.
- [x] Run targeted test until green.
- [ ] Commit as `Add skill plugin contracts`.

### Task 2: SQLite Registry

- [ ] Write failing tests for schema migrations, skill install round trip, user/workspace isolation and plugin bundled skill registration.
- [ ] Run targeted tests and verify failures.
- [ ] Implement `SkillPluginRegistryStore` in `skill_plugin.rs`.
- [ ] Run targeted tests until green.
- [ ] Commit as `Add skill plugin registry`.

### Task 3: Capability Provider Integration

- [ ] Write failing tests that `SkillCapabilityProvider` exposes only enabled install tools and policy filters them through `CapabilityFacade`.
- [ ] Run targeted tests and verify failures.
- [ ] Implement `SkillCapabilityProvider` and export it.
- [ ] Run targeted tests until green.
- [ ] Commit as `Expose skill plugin capabilities`.

### Task 4: Verification And Docs

- [ ] Run `cargo test -p local-first-capabilities --test skill_plugin_registry`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document skill plugin registry`.
