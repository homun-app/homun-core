# Browser Checkpoint Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve a thread's exact live browser page across sidecar/gateway loss and provide bounded, encrypted, policy-governed draft rehydration when the page itself is gone.

**Architecture:** Extend the existing browser sidecar protocol rather than adding another browser service. The TypeScript runtime owns page adoption and safe control capture, task-runtime owns metadata-only checkpoint rows, a dedicated encrypted gateway store owns draft values, and the existing browser executor restores only the active objective revision before forcing a fresh snapshot. Rehydration is an explicit `external_write`; no uncertain browser operation, click, submit, booking, or payment is replayed.

**Tech Stack:** Rust, TypeScript, Playwright/CDP, serde/serde_json, rusqlite/SQLite, local-first-secrets, Tokio, Vitest, Cargo tests.

---

### Task 1: TypeScript checkpoint and safe-draft contract

**Files:**
- Modify: `runtimes/browser-automation/src/contracts.ts`
- Modify: `runtimes/browser-automation/src/browser/session_manager.ts`
- Modify: `runtimes/browser-automation/src/server.ts`
- Modify: `runtimes/browser-automation/tests/contracts.test.ts`
- Modify: `runtimes/browser-automation/tests/browser_fixture.test.ts`

- [ ] **Step 1: Write failing protocol and capture tests**

Add tests named:

```ts
it("accepts checkpoint restore and rehydrate methods", () => { /* parse all three */ });
it("captures only bounded non-sensitive visible form controls", async () => { /* assert safe fields and omitted count */ });
it("checkpoint output excludes password payment file hidden and contenteditable values", async () => { /* inspect JSON */ });
```

The fixture must include ordinary passenger fields plus password, `autocomplete="cc-number"`, CVV,
file, hidden, and contenteditable controls. Assert the excluded test values never occur in
`JSON.stringify(checkpoint)`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run tests/contracts.test.ts tests/browser_fixture.test.ts --test-timeout=20000
```

Expected: FAIL because `browser.checkpoint`, `browser.restore`, `browser.rehydrate`, and manager
methods do not exist.

- [ ] **Step 3: Add bounded checkpoint types and capture**

Add browser methods and versioned types equivalent to:

```ts
type BrowserCheckpoint = {
  schemaVersion: 1;
  targetId: string;
  url: string;
  origin: string;
  browserEpoch: string;
  cdpTargetId?: string;
  generation: number;
  controls: DraftControl[];
  omittedSensitiveCount: number;
  omittedBoundedCount: number;
};
```

Capture at most 32 visible enabled eligible controls, 2,000 characters each and 16 KiB total.
Return values only in the checkpoint object. Do not append checkpoint values to snapshots, console
messages, or errors.

- [ ] **Step 4: Wire sidecar dispatch and verify GREEN**

Dispatch `browser.checkpoint`, `browser.restore`, and `browser.rehydrate` using strict parameter
parsers. Re-run the focused tests and expect PASS.

- [ ] **Step 5: Commit the browser contract slice**

```bash
git add runtimes/browser-automation/src runtimes/browser-automation/tests
git commit -m "feat: add browser checkpoint protocol"
```

### Task 2: Shared-page detach and exact CDP adoption

**Files:**
- Modify: `runtimes/browser-automation/src/browser/session_manager.ts`
- Modify: `runtimes/browser-automation/src/server.ts`
- Modify: `runtimes/browser-automation/tests/session_manager.test.ts`
- Modify: `runtimes/browser-automation/tests/integration_stdio.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Use one Chromium server plus two managers connected over CDP. The first manager opens a labelled
page, fills a value without submit, checkpoints generation `N`, then detaches without closing. The
second manager restores the checkpoint.

Assertions:

```ts
expect(restored.tier).toBe("adopted_live_page");
expect(after.generation).toBe(N + 1);
expect(after.snapshot).toContain("Ada");
expect(await firstContext.pages()).toHaveLength(1);
```

Add a separate explicit-stop test asserting the owned page closes.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run tests/session_manager.test.ts tests/integration_stdio.test.ts --test-timeout=30000
```

Expected: FAIL because abnormal detach still follows `stop()` and no exact target adoption exists.

- [ ] **Step 3: Implement CDP identity and lifecycle detach**

For shared CDP contexts only:

- obtain `cdpTargetId` with `Target.getTargetInfo`;
- carry `browserEpoch` from `BROWSER_AUTOMATION_BROWSER_EPOCH`;
- on stdin EOF, leave pages alive and let process exit close the CDP socket;
- on explicit `browser.stop`, close owned pages;
- on restore, adopt only exact epoch and target id, seed generation `N`, clear refs, then require a
  fresh snapshot.

Host-launched and isolated contexts retain close-on-EOF behavior.

- [ ] **Step 4: Verify GREEN and full browser suite**

```bash
npm run typecheck
npm test
```

Expected: typecheck passes and all browser tests pass.

- [ ] **Step 5: Commit the adoption slice**

```bash
git add runtimes/browser-automation/src runtimes/browser-automation/tests
git commit -m "feat: preserve shared browser pages across sidecar loss"
```

### Task 3: Rust browser protocol parity

**Files:**
- Modify: `crates/browser-automation/src/types.rs`
- Modify: `crates/browser-automation/tests/contracts.rs`
- Modify: `crates/browser-automation/tests/client.rs`

- [ ] **Step 1: Write failing serialization tests**

Extend the method inventory test to require exact wire names:

```rust
(BrowserMethod::Checkpoint, "browser.checkpoint"),
(BrowserMethod::Restore, "browser.restore"),
(BrowserMethod::Rehydrate, "browser.rehydrate"),
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-browser-automation contracts -- --nocapture
```

Expected: compile failure for missing enum variants.

- [ ] **Step 3: Add enum variants and strict response types**

Add serde variants and bounded Rust structs mirroring the TypeScript checkpoint, restore result,
draft manifest, and rehydrate result. Values remain inside a private checkpoint payload type and
must not implement `Display`.

- [ ] **Step 4: Verify GREEN and commit**

```bash
cargo test -p local-first-browser-automation
git add crates/browser-automation
git commit -m "feat: add browser recovery wire contracts"
```

### Task 4: Revision-guarded checkpoint metadata store

**Files:**
- Modify: `crates/task-runtime/src/store.rs`
- Create: `crates/task-runtime/tests/browser_checkpoints.rs`

- [ ] **Step 1: Write failing store tests**

Create tests proving:

```rust
checkpoint_round_trips_metadata_without_draft_values();
stale_objective_revision_cannot_overwrite_checkpoint();
terminal_objective_cannot_load_restorable_checkpoint();
checkpoint_cleanup_is_scope_exact_and_idempotent();
expired_checkpoints_are_returned_for_secret_cleanup_then_deleted();
```

Inspect the SQLite file text/rows and assert sentinel draft values never occur.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-task-runtime browser_checkpoint -- --nocapture
```

Expected: compile failure for missing record and store methods.

- [ ] **Step 3: Add schema and methods**

Add `BrowserCheckpointRecord`, `NewBrowserCheckpoint`, and methods:

```rust
upsert_browser_checkpoint(&NewBrowserCheckpoint) -> Result<bool>;
load_active_browser_checkpoint(user, workspace, thread, target) -> Result<Option<_>>;
delete_browser_checkpoints_for_thread(user, workspace, thread) -> Result<Vec<String>>;
delete_browser_checkpoints_for_objective(user, workspace, thread, revision) -> Result<Vec<String>>;
take_expired_browser_checkpoint_secret_refs(now) -> Result<Vec<String>>;
```

The upsert joins/validates `objective_contracts.status='active'` and exact revision in one
transaction. Store metadata only.

- [ ] **Step 4: Verify GREEN and commit**

```bash
cargo test -p local-first-task-runtime browser_checkpoint -- --nocapture
git add crates/task-runtime
git commit -m "feat: persist browser checkpoint metadata"
```

### Task 5: Dedicated encrypted draft store

**Files:**
- Create: `crates/desktop-gateway/src/browser_checkpoint.rs`
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/lib.rs`

- [ ] **Step 1: Write failing encryption and redaction tests**

Tests must save a payload containing sentinel PII, then assert:

- the dedicated file contains ciphertext but not the sentinel;
- the connector `secrets.json` is untouched;
- SQLite metadata and journal events contain no sentinel;
- delete removes encrypted material while remaining idempotent;
- payload bounds and schema version are validated fail closed.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-desktop-gateway browser_checkpoint -- --nocapture
```

Expected: compile failure for missing module/store.

- [ ] **Step 3: Implement the focused module**

`browser_checkpoint.rs` owns:

```rust
BrowserCheckpointDraftStore;
BrowserCheckpointEnvelope;
persist_checkpoint_from_sidecar(...);
load_draft_manifest(...);
resolve_rehydrate_values(...);
clear_checkpoint_secrets(...);
strip_private_checkpoint_metadata(...);
```

Back it with a distinct `EncryptedFileSecretStore<DevelopmentSecretKeyProvider>` opened at
`browser-checkpoint-secrets.json` using the existing secret key seed. Use provider id
`browser-checkpoint` and an opaque hashed connection id.

- [ ] **Step 4: Verify GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway browser_checkpoint -- --nocapture
git add crates/desktop-gateway/src/browser_checkpoint.rs crates/desktop-gateway/src/main.rs crates/desktop-gateway/src/lib.rs
git commit -m "feat: encrypt browser draft checkpoints separately"
```

### Task 6: Gateway checkpoint persistence and restore-before-use

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/browser_checkpoint.rs`
- Modify: `crates/desktop-gateway/src/hitl_resume.rs`

- [ ] **Step 1: Write failing gateway tests**

Add tests proving:

```rust
browser_result_private_checkpoint_is_persisted_then_stripped();
fresh_sidecar_restores_only_matching_active_objective_revision();
restore_forces_snapshot_before_any_model_requested_action();
timeout_never_replays_the_failed_rpc();
epoch_mismatch_degrades_to_url_restore();
read_only_contract_never_offers_draft_rehydration();
```

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-desktop-gateway browser_checkpoint -- --nocapture
```

Expected: failing assertions because a missing warm client currently spawns a blank sidecar.

- [ ] **Step 3: Implement checkpoint extraction and restore**

After each confirmed snapshot/post-action observation:

1. remove private checkpoint data from the value;
2. encrypt the draft in the dedicated store;
3. revision-guard metadata upsert;
4. return only the normal snapshot to model context.

When no warm client exists, load the matching checkpoint, spawn the sidecar, call restore once, and
force a fresh snapshot. Never retry the operation that lost the client. Derive browser epoch from the
contained Chromium/container identity and pass it through sidecar env.

- [ ] **Step 4: Extend OpenWork metadata safely**

Persist metadata-only recovery status in `OpenWorkSnapshot`:

```rust
browser_checkpoint_available: bool,
browser_checkpoint_generation: Option<u64>,
browser_recovery_tier: Option<String>,
```

No URL, field descriptor, draft ref, or value enters HITL payloads.

- [ ] **Step 5: Verify GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway browser_checkpoint -- --nocapture
git add crates/desktop-gateway/src
git commit -m "feat: restore browser checkpoints before continuation"
```

### Task 7: Explicit rehydration through the effect policy

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/browser_checkpoint.rs`
- Modify: `crates/desktop-gateway/src/semantic_decision.rs`

- [ ] **Step 1: Write failing authorization tests**

Tests must prove `browser_rehydrate`:

- is classified `external_write`;
- is absent under a read-only contract;
- requires exact active revision and opaque draft reference;
- requires a fresh current-generation ref to an empty matching control;
- rejects payment-floor, credential, populated, ambiguous, cross-origin, submit, click, key, and
  batch shapes;
- never places the decrypted value in a tool result, trace, error, or receipt.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-desktop-gateway browser_rehydrate -- --nocapture
```

Expected: FAIL because no rehydration tool or policy classification exists.

- [ ] **Step 3: Implement the explicit tool path**

Expose `browser_rehydrate` only inside the browser subagent and only when the validated objective
allows `external_write` and a matching draft manifest exists. Tool arguments contain only current
snapshot ref plus opaque draft ref. The gateway resolves/decrypts the value, calls the private
sidecar `browser.rehydrate`, records metadata-only outcome, and zeroizes/drops plaintext promptly.

- [ ] **Step 4: Verify GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway browser_rehydrate -- --nocapture
git add crates/desktop-gateway/src
git commit -m "feat: rehydrate browser drafts through effect policy"
```

### Task 8: Terminal cleanup and recovery observability

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs`
- Modify: `crates/desktop-gateway/src/turn_executor.rs`
- Modify: `crates/desktop-gateway/src/browser_checkpoint.rs`
- Modify: `crates/task-runtime/src/store.rs`

- [ ] **Step 1: Write failing lifecycle tests**

Cover objective complete, objective cancel, thread archive, thread delete, close browser, close all,
idle expiry, superseding revision, startup expiry cleanup, and missing secret. Each path must remove
metadata and ciphertext idempotently without changing task/run terminal ownership.

- [ ] **Step 2: Run and verify RED**

```bash
cargo test -p local-first-desktop-gateway browser_checkpoint_cleanup -- --nocapture
```

- [ ] **Step 3: Wire cleanup and metadata-only events**

Emit only:

```text
browser_checkpoint_saved
browser_restore_adopted
browser_restore_draft_available
browser_draft_rehydrated
browser_restore_degraded
browser_checkpoint_cleared
```

Payloads contain tier, generation, counts, and typed reason only. Reuse the existing terminal
objective projection and revision guard; do not create a second terminal owner.

- [ ] **Step 4: Verify GREEN and commit**

```bash
cargo test -p local-first-desktop-gateway browser_checkpoint_cleanup -- --nocapture
git add crates/desktop-gateway/src crates/task-runtime/src/store.rs
git commit -m "fix: clear browser checkpoints at terminal boundaries"
```

### Task 9: Documentation and complete verification

**Files:**
- Modify: `docs/TURN_CONTRACT.md`
- Modify: `docs/superpowers/specs/2026-07-28-browser-checkpoint-recovery-design.md`
- Modify: `docs/superpowers/plans/2026-07-28-browser-checkpoint-recovery.md`

- [ ] **Step 1: Update the live contract and mark completed plan items**

Document recovery tiers, explicit rehydration, no uncertain replay, secret separation, generation
monotonicity, and cleanup ownership.

- [ ] **Step 2: Run formatting and static checks**

```bash
git diff --check
rustfmt --edition 2024 --check <each changed Rust file that is baseline-clean>
npm run typecheck --prefix runtimes/browser-automation
```

- [ ] **Step 3: Run complete automated verification**

```bash
npm test --prefix runtimes/browser-automation
cargo test --workspace
RUSTFLAGS='-D warnings' cargo build --workspace
npm run build --prefix apps/desktop
npm run test:ui-contract --prefix apps/desktop
npm run test:electron --prefix apps/desktop
npm audit --omit=dev --prefix apps/desktop
npm audit --prefix runtimes/browser-automation
```

Expected: all tests/builds pass; production/browser audits report zero vulnerabilities.

- [ ] **Step 4: Run deterministic loss smoke**

Use a local form fixture through the real sidecar/gateway path. Fill without submit, record `N`,
terminate the sidecar, continue, and prove exact adoption plus `N+1`. Then close the page, restore URL,
prove fields stay empty until explicit rehydration, rehydrate safe controls, and prove no submit.

- [ ] **Step 5: Run the development train-flow smoke**

Start the dev application from this worktree. Prove the same objective/revision survives Choice HITL,
force one sidecar loss after selecting a result, reach the passenger-form draft without restarting
discovery, and verify no invented passenger or Vault values.

- [ ] **Step 6: Commit verification docs**

```bash
git add docs/TURN_CONTRACT.md docs/superpowers/specs/2026-07-28-browser-checkpoint-recovery-design.md docs/superpowers/plans/2026-07-28-browser-checkpoint-recovery.md
git commit -m "docs: record browser recovery verification"
```
