# Per-project Sandbox Policy — Phase 2 (writable_roots) + Phase 3 (skill confirmations)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD, one commit per task.

**Goal:** Extend the per-workspace policy (Phase 1: mode + approval) with **per-project extra writable folders** for the sandboxed execution fence (Phase 2) and **per-project skill-confirmation categories** (Phase 3). Both inherit a global default. `network_access` per-project is DEFERRED (Linux fence TODO — see spec).

**Architecture:** Reuse Phase 1's machinery — `Option` override fields on `WorkspaceRecord`, workspace-aware resolvers with precedence env > project > global default > built-in, the `POST /api/workspaces/{id}/policy` partial-merge endpoint, and the Settings › Sandbox page rows. Phase 2 threads resolved writable_roots into `run_in_project`'s `build_sandbox_command`. Phase 3 composes per-project categories with the existing skill `ConfirmationPolicy` at the approval gate.

**Tech Stack:** Rust (`crates/desktop-gateway/src/main.rs`, `tool_safety.rs`, `seatbelt.rs`, `landlock_fence.rs`), React/TS (`apps/desktop/src`).

## Global Constraints

- Rust comments English; UI copy Italian. No `Co-Authored-By`. Do not push.
- Reconciliation invariant: OS fence unconditional; writable_roots only ADD folders (never remove the fence). The project root is ALWAYS writable; per-project extra roots are additive.
- Absent override = None = inherit global default. Env stays top precedence.
- The `seatbelt_fence` (macOS, main.rs ~55598) and `crates/desktop-gateway/tests/linux_sandbox.rs` (Linux) integration tests MUST stay green — they are the fence guardrail. If a change would edit them, STOP.
- `network_access` per-project is OUT OF SCOPE (deferred). Do NOT add a network UI toggle.

---

### Task 1: `writable_roots` global default + per-workspace override field

**Files:** Modify `crates/desktop-gateway/src/main.rs` — `RuntimeSettings` (~27300, add `writable_roots: Vec<String>` `#[serde(default)]`) and `WorkspaceRecord` (add `writable_roots: Option<Vec<String>>` `#[serde(default)]`). Test: `mod tests`.

**Interfaces:** Produces `RuntimeSettings.writable_roots: Vec<String>` (global default, empty = just the project root), `WorkspaceRecord.writable_roots: Option<Vec<String>>` (None = inherit).

- [ ] **Step 1 — failing test:** legacy JSON (no field) → `writable_roots` is `vec![]` (RuntimeSettings) / `None` (WorkspaceRecord); with field round-trips.
```rust
#[test]
fn writable_roots_fields_default_and_round_trip() {
    let rs: super::RuntimeSettings = serde_json::from_str("{}").unwrap();
    assert!(rs.writable_roots.is_empty());
    let wr: super::WorkspaceRecord = serde_json::from_str(r#"{"id":"w","name":"W","writable_roots":["/tmp/extra"]}"#).unwrap();
    assert_eq!(wr.writable_roots.as_deref(), Some(&["/tmp/extra".to_string()][..]));
}
```
- [ ] **Step 2 — run red.** `cargo test -p local-first-desktop-gateway writable_roots_fields_default -- --nocapture`
- [ ] **Step 3 — implement** the two fields.
- [ ] **Step 4 — run green.**
- [ ] **Step 5 — commit:** `feat(gateway): writable_roots global default + per-workspace override fields`

---

### Task 2: `resolved_writable_roots(state, thread_id)` resolver

**Files:** Modify `main.rs` (near `resolved_sandbox_mode`). Test: `mod tests`.

**Interfaces:** Consumes Task 1 fields + `workspace_record_for_thread` + `project_root_for_thread` (Phase 1). Produces `fn resolved_writable_roots(state: &AppState, thread_id: Option<&str>) -> Vec<std::path::PathBuf>` = **project root FIRST** (always) + resolved extra roots (per-workspace override if `Some`, else global `runtime-settings.writable_roots`), each jailed/validated to an existing absolute dir; de-duplicated. Pure core `fn resolve_extra_roots(ws: Option<&[String]>, global: &[String]) -> Vec<String>` (override replaces, not merges — a project that sets its list owns it).

- [ ] **Step 1 — failing test:** pure core precedence (ws override replaces global; None inherits global) + `resolved_writable_roots` always includes the project root first.
```rust
#[test]
fn resolve_extra_roots_override_replaces_global() {
    assert_eq!(super::resolve_extra_roots(Some(&["/a".into()]), &["/g".into()]), vec!["/a".to_string()]);
    assert_eq!(super::resolve_extra_roots(None, &["/g".into()]), vec!["/g".to_string()]);
}
```
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement.** `resolved_writable_roots`: start with `project_root_for_thread(...)` (if Some), push resolved extra roots (filter to existing abs dirs via a jail/exists check), dedup.
- [ ] **Step 4 — run green.**
- [ ] **Step 5 — commit:** `feat(gateway): resolved_writable_roots (project root + per-project extra folders)`

---

### Task 3: Thread resolved writable_roots into the execution fence

**Files:** Modify `main.rs` `run_in_project` (~12329) — replace its local `writable_roots` computation with `resolved_writable_roots(state, thread_id)`. Test: `mod tests` (reuse the seatbelt test harness pattern from ~55598, macOS-gated).

**Interfaces:** Consumes Task 2. The bash fence now writes to the project root PLUS the per-project extra roots.

- [ ] **Step 1 — failing test** (macOS-gated, mirror `seatbelt_fence`): with a workspace whose `writable_roots = [extra_dir]`, `build_sandbox_command(&resolved_writable_roots(state, thread_for_that_ws), "echo ok > extra_dir/f")` ALLOWS the write; a dir NOT in the roots is denied. (If wiring a full state is heavy, test `resolved_writable_roots` returns the extra dir + `build_sandbox_command(&[project,extra], ...)` allows both — the existing seatbelt test already proves build_sandbox_command honors its roots.)
- [ ] **Step 2 — run red / confirm.**
- [ ] **Step 3 — implement:** in `run_in_project`, `let writable_roots = resolved_writable_roots(&state, thread_id.as_deref());` (drop the old single-root computation). Keep `build_sandbox_command(&writable_roots, command)`.
- [ ] **Step 4 — run green:** `cargo test -p local-first-desktop-gateway -- --nocapture` (all pass incl. `seatbelt_fence` UNCHANGED); `cargo build`.
- [ ] **Step 5 — commit:** `feat(gateway): per-project extra writable folders honored by the exec fence`

---

### Task 4: Extend the policy endpoint + Sandbox page for writable_roots

**Files:** Modify `main.rs` `merge_workspace_policy` (accept `writable_roots: array | null`) + `RuntimeSettings` default endpoint (already `set_runtime_settings` — add writable_roots to the mergeable set). Modify `apps/desktop/src/components/SandboxSettingsView.tsx` + `coreBridge.ts` + i18n. Test: `mod tests` (merge) + `npm run test:ui-contract`.

**Interfaces:** `POST /api/workspaces/{id}/policy` body gains optional `writable_roots: string[] | null`. Default section gains a global writable-roots editor via `setRuntimeSettings({writable_roots})`.

- [ ] **Step 1 — failing test:** `merge_workspace_policy` sets/clears `writable_roots` (array sets, `null` clears to None, partial — doesn't touch mode/approval).
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement:** merge logic + UI: each workspace row (and the Default section) gets a small multi-folder list editor (add/remove text rows of absolute paths) → posts `writable_roots`. Copy: "Cartelle extra scrivibili oltre la root del progetto (per script/build)." i18n en+it.
- [ ] **Step 4 — verify:** `cargo test -p local-first-desktop-gateway merge_workspace_policy -- --nocapture`; `npm run build && npm run test:ui-contract && npm run test:electron`.
- [ ] **Step 5 — commit:** `feat(sandbox): per-project + default extra writable folders (endpoint + Settings UI)`

---

### Task 5: `skill_confirmations` per-workspace field + resolver

**Files:** Modify `main.rs` — `WorkspaceRecord.skill_confirmations: Option<Vec<String>>` `#[serde(default)]` + `RuntimeSettings.skill_confirmations: Vec<String>` `#[serde(default)]`; resolver `resolved_skill_confirmations(state, thread_id) -> Vec<SensitiveCategory>`. Test: `mod tests`.

**Interfaces:** Categories are the existing `crate::skills::SensitiveCategory` tokens (`delete|financial|medical|sensitive-data`). Produces the set of categories that must FORCE a confirm in this workspace regardless of the active skill. `resolve` precedence: env none; per-workspace override if Some, else global default, else empty.

- [ ] **Step 1 — failing test:** round-trip + precedence (ws override replaces global) parsing to `SensitiveCategory` (reuse `SensitiveCategory::parse`).
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement** the fields + resolver (map strings → `SensitiveCategory` via the forgiving parser, drop unknown).
- [ ] **Step 4 — run green.**
- [ ] **Step 5 — commit:** `feat(gateway): per-workspace skill-confirmation categories + resolver`

---

### Task 6: Compose per-project skill confirmations into the approval gate

**Files:** Modify `main.rs` — the approval sites that already call `skill_policy_forces_confirm(ctx.active_sensitive, is_write)` (MCP ~22282, Composio ~22394 — grep `skill_policy_forces_confirm`). At turn setup, seed `ctx.active_sensitive` (or a parallel `project_sensitive`) with `resolved_skill_confirmations(state, thread_id)` so the project's categories force a confirm even with NO sensitive skill active. Test: `mod tests`.

**Interfaces:** Consumes Task 5. The existing `skill_policy_forces_confirm(active, is_effectful) = is_effectful && !active.is_empty()` already forces confirm when the set is non-empty — so ADD the project categories into the active set at setup.

- [ ] **Step 1 — failing test:** `skill_policy_forces_confirm` fires for an effectful action when the project has a category set even with no skill active (i.e. the setup merges project categories into `active_sensitive`). Test the merge helper: `fn merged_sensitive(skill: &[SensitiveCategory], project: &[SensitiveCategory]) -> Vec<SensitiveCategory>` (dedup union).
- [ ] **Step 2 — run red.**
- [ ] **Step 3 — implement:** where `active_sensitive` is initialized for the turn (Phase-earlier work — grep `active_sensitive: Vec::new()` / `LoopState.active_sensitive`), seed it with `resolved_skill_confirmations(state, thread_id)` (union, dedup). This is fail-safe (only ADDS confirms).
- [ ] **Step 4 — run green:** targeted + full crate `cargo test -p local-first-desktop-gateway`.
- [ ] **Step 5 — commit:** `feat(gateway): project skill-confirmation categories force confirm at the gate`

---

### Task 7: Skill-confirmations UI in the Sandbox page

**Files:** Modify `SandboxSettingsView.tsx` + `coreBridge.ts` (endpoint already accepts it via merge) + i18n. Test: `npm run test:ui-contract` + build + electron.

- [ ] **Step 1 — extend the merge** in `merge_workspace_policy` to accept `skill_confirmations: array|null` (Rust — a quick test that it partial-merges).
- [ ] **Step 2 — UI:** each workspace row (+ Default) gets 4 checkboxes (delete/financial/medical/sensitive-data); toggling posts the array via `setWorkspacePolicy`/`setRuntimeSettings`. Copy: "Categorie che richiedono SEMPRE conferma in questo progetto." i18n en+it.
- [ ] **Step 3 — verify:** `npm run build && npm run test:ui-contract && npm run test:electron`; `cargo test -p local-first-desktop-gateway merge_workspace_policy`.
- [ ] **Step 4 — commit:** `feat(sandbox): per-project + default skill-confirmation categories (endpoint + Settings UI)`

---

## Self-Review notes
- Spec coverage: Phase 2 writable_roots (Tasks 1–4), Phase 3 skill-confirmations (Tasks 5–7). `network_access` deliberately deferred (spec updated 2026-07-10). All resolvers reuse Phase 1's `workspace_record_for_thread` + precedence pattern; all UI reuses the Phase 1 Sandbox page + `setWorkspacePolicy`/`setRuntimeSettings`.
- Guardrail: `seatbelt_fence` + `linux_sandbox.rs` must stay UNCHANGED and green (Task 3).
- Type consistency: `resolved_writable_roots`, `resolve_extra_roots`, `resolved_skill_confirmations`, `merged_sensitive`, `merge_workspace_policy` (extended), `setWorkspacePolicy` (patch gains `writable_roots?`, `skill_confirmations?`).
