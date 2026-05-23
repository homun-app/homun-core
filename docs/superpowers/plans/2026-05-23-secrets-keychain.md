# Secrets Keychain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure local secret storage so provider registries keep only `secret_ref` while actual credentials live in an encrypted/keychain-backed store.

**Architecture:** Add a new `local-first-secrets` crate with typed refs, non-serializable secret material, audit-safe metadata, in-memory test store, encrypted file store and system keychain boundary. Integrate it into the Capability Registry through a helper that stores connection credentials and persists only references.

**Tech Stack:** Rust 2024, serde, serde_json, XChaCha20Poly1305, rand, sha2, base64, local-first-capabilities.

---

## File Structure

- Add `crates/secrets/Cargo.toml`.
- Add `crates/secrets/src/lib.rs`.
- Add `crates/secrets/src/error.rs`.
- Add `crates/secrets/src/types.rs`.
- Add `crates/secrets/src/crypto.rs`.
- Add `crates/secrets/src/store.rs`.
- Add `crates/secrets/src/keychain.rs`.
- Add `crates/secrets/tests/*.rs`.
- Modify root `Cargo.toml`.
- Modify `crates/capabilities/Cargo.toml`.
- Modify `crates/capabilities/src/registry.rs`.
- Add capability registry tests for secret-store integration.
- Update `PROJECT.md` and `docs/work-memory.md`.

---

### Task 1: Secret Contracts And In-Memory Store

- [x] Write failing tests for `SecretRef`, redacted `SecretMaterial`, metadata and `InMemorySecretStore`.
- [x] Run `cargo test -p local-first-secrets --test contracts --test memory_store` and verify failures.
- [x] Implement crate skeleton, types, errors and in-memory store.
- [x] Run targeted tests until green.
- [x] Commit as `Add secrets contracts`.

### Task 2: Encrypted File Store And Keychain Boundary

- [x] Write failing tests for encrypted file round trip, no plaintext on disk, wrong-key failure and system keychain unsupported-safe boundary.
- [x] Run targeted tests and verify failures.
- [x] Implement XChaCha20Poly1305 encryption, encrypted file store and system keychain wrapper.
- [x] Run targeted tests until green.
- [x] Commit as `Add encrypted secret store`.

### Task 3: Capability Registry Integration

- [ ] Write failing test that stores a connection secret via registry helper and proves DB only contains `secret_ref`, not raw credentials.
- [ ] Run targeted capability registry test and verify failure.
- [ ] Add `local-first-secrets` dependency and registry helper.
- [ ] Run targeted tests until green.
- [ ] Commit as `Integrate secrets with capability registry`.

### Task 4: Verification And Docs

- [ ] Run `cargo test -p local-first-secrets`.
- [ ] Run `cargo test --workspace`.
- [ ] Run `make test`.
- [ ] Update `PROJECT.md`, this plan and `docs/work-memory.md`.
- [ ] Run `git diff --check`.
- [ ] Commit as `Document secrets keychain runtime`.
