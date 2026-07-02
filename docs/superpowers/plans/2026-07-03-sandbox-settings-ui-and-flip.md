# Sandbox Settings UI + Flip Default — Implementation Plan (ADR 0023 #1)

> Subagent-driven + TDD. Follows the #2 plan (sandbox honesty) which is COMPLETE — the sandbox axis is
> now resolved from one source and honored by bash + write_file/edit_file, `read-only` validated by executing.

**Goal:** Expose the sandbox **mode** as a user setting in Settings and **flip the shipped default** from
`danger` to `workspace-write`, so the OS fence is ON by default (honest now that it covers bash + writes).

**Why now:** #2 made the fence honest. `tool_safety_enabled()` is derived from the mode; flipping the default
activates the already-validated enforcement (bash under Seatbelt/Landlock; writes project-jailed; read-only →
escalation). The approval-axis UI + its 4-level wiring is a SEPARATE later increment (#1b) — do NOT add a dead
`approval_policy` dropdown here.

**Behavior change (the point):** after the flip, every `run_in_project` bash command runs under the OS fence by
default, and out-of-root writes trigger the escalation card. Common tooling (npm/cargo/git/node/python) writes to
project + caches (`workspace_write_roots`) and keeps working — validated in #2. MCP/Composio approval is unchanged
(assess_tool_safety was designed byte-equivalent to the legacy boolean).

**Scope note:** approval axis (expose + wire `approval_policy`) = #1b, later. This plan is sandbox-mode-only + flip.

---

## Task 0: Backend — make `set_runtime_settings` MERGE partial updates (fixes a clobber the flip exposes)

**Why:** `set_runtime_settings(Json(mut settings): Json<RuntimeSettings>)` deserializes the WHOLE struct from the
POST body, so a caller sending only `{adaptive_floor}` (as `AdaptiveFloorBlock` does) resets `sandbox_mode` to its
serde default, and vice-versa. With two Settings controls this means saving one clobbers the other. Fix once, in the
backend, with PATCH semantics — robust for every caller.

**Files:** `crates/desktop-gateway/src/main.rs` (`set_runtime_settings` ~symbol; `get_runtime_settings`).

- [ ] **Step 1 (test first):** Add a unit test `set_runtime_settings_merges_partial_updates` that: writes a settings file with `{adaptive_floor:"on", sandbox_mode:"danger"}`, then applies a partial update `{sandbox_mode:"read-only"}` (as raw JSON), and asserts the persisted result is `{adaptive_floor:"on", sandbox_mode:"read-only"}` — i.e. `adaptive_floor` is PRESERVED, not reset. (Use a temp `HOMUN_DATA_DIR` or the existing test hook for the data dir; if none exists, test the pure merge helper below instead.)
- [ ] **Step 2:** Change the endpoint to accept a partial and merge. Simplest robust approach: take `Json(patch): Json<serde_json::Value>`, load the current `RuntimeSettings`, serialize it to a `serde_json::Value` object, overlay the patch's top-level keys onto it, deserialize back to `RuntimeSettings`, normalize (adaptive_floor + sandbox_mode), save, return the full object. Extract a pure helper `merge_runtime_settings(current: &RuntimeSettings, patch: &serde_json::Value) -> RuntimeSettings` so the test can be pure. Keep normalization (both fields) after merge.
- [ ] **Step 3:** `cargo test -p local-first-desktop-gateway merge` — green. `cargo check` clean.
- [ ] **Step 4:** Commit `fix(gateway): merge partial runtime-settings updates so controls don't clobber each other (ADR 0023 #1)`.

## Task 1: Backend — flip the default sandbox mode to workspace-write

**Files:** `crates/desktop-gateway/src/main.rs` (`default_sandbox_mode` — from #2 Task 1).

- [ ] **Step 1:** Change `default_sandbox_mode()` return from `"danger"` to `"workspace-write"`. Update its doc comment: this is the shipped default (fence ON) as of ADR 0023 #1; `HOMUN_SANDBOX_MODE=danger` / setting `danger` opts out.
- [ ] **Step 2:** Verify no test asserts the disk default is `danger` (after #2 Task 1's hermetic-test fix there should be none — the precedence test is env-driven). Grep to confirm; fix any that break.
- [ ] **Step 3:** `cargo test -p local-first-desktop-gateway` — green.
- [ ] **Step 4:** VALIDATE BY EXECUTING (macOS) — a `#[ignore]` runtime test (or reuse the read-only one's structure) confirming under `SandboxPolicy::WorkspaceWrite{writable_roots:[root], network_access:true}`: (a) a bash write INSIDE `root` SUCCEEDS, (b) a bash write to a sibling path OUTSIDE `root` is DENIED. Proves the flipped default is usable AND enforcing. Paste output.
- [ ] **Step 5:** Commit `feat(gateway): flip default sandbox mode to workspace-write (ADR 0023 #1)`.

## Task 2: Frontend — expose the sandbox mode in Settings › Runtime

**Files:** `apps/desktop/src/lib/coreBridge.ts` (`RuntimeSettings` interface ~706), `apps/desktop/src/components/SettingsView.tsx` (runtime pane; mirror `AdaptiveFloorBlock` ~1323), i18n files (en + it).

- [ ] **Step 1:** Extend the `RuntimeSettings` TS interface (coreBridge.ts ~706) to add `sandbox_mode: string;` (alongside `adaptive_floor`). The GET/POST already round-trip the whole object, so no bridge fn change needed.
- [ ] **Step 2:** Add a `SandboxModeBlock` component in SettingsView.tsx modeled on `AdaptiveFloorBlock`, but a **3-option control** (segmented buttons or a `<select>`), values `read-only` | `workspace-write` | `danger`, reading `settings.sandbox_mode` (default to `"workspace-write"` if absent) and saving via `coreBridge.setRuntimeSettings({ ...current, sandbox_mode: value })`. IMPORTANT: `setRuntimeSettings` replaces the whole object — read the current settings first and spread them so `adaptive_floor` is not clobbered (check how AdaptiveFloorBlock saves; if it posts only `{adaptive_floor}` the backend must merge — VERIFY the backend `set_runtime_settings` behavior: if it overwrites the whole file, the UI must send the full object; adapt accordingly).
- [ ] **Step 3:** Copy: title "Sandbox" / it "Sandbox"; description explaining the 3 levels succinctly (read-only = no writes outside tmp; workspace-write = writes only in the project + caches, the default; danger = no fence, full access — with a warning tone). A "danger" selection should show a subtle warning. Use i18n keys `settings.sandboxMode*` (en + it), following the existing `settings.adaptiveFloor*` key pattern.
- [ ] **Step 4:** Mount `<SandboxModeBlock />` in the runtime pane near `AdaptiveFloorBlock` / `ConcurrencyBlock`.
- [ ] **Step 5:** `cd apps/desktop && npm run build && npm run test:ui-contract` — green. Do NOT touch `check-ui-contract.mjs`.
- [ ] **Step 6:** Commit `feat(desktop): sandbox mode selector in Settings › Runtime (ADR 0023 #1)`.

## Task 3: Docs + STATO

- [ ] Update ADR 0023 (mode now user-settable + default flipped; approval-axis UI still pending = #1b). Update `architecture/desktop-shell.md` (default is workspace-write). Update STATO ⭐ RIPRESA (#1 sandbox-UI + flip done; next = #1b approval axis, then apply_patch, then subagents). Commit `docs: sandbox mode settable + default flipped to workspace-write (ADR 0023 #1)`.

---

## Self-review
- Coverage: flip (T1) + validate-executing (T1.4) + UI expose (T2) + docs (T3). Approval axis explicitly deferred to #1b (no dead control). 
- Risk: the flip activates enforcement by default → T1.4 validates usability (in-project writes work) AND enforcement (out-of-root denied) by EXECUTING. App-level Electron smoke can't run headless overnight → flag in STATO/PR for user smoke.
- The `set_runtime_settings` whole-object-overwrite risk (T2.2) is called out so the UI sends a merged object and doesn't clobber `adaptive_floor`.
