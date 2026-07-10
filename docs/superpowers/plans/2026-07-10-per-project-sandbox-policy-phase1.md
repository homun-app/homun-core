# Per-project Sandbox Policy — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make `sandbox_mode` and `approval_policy` settable **per workspace** (project + Personal), inheriting a global default when a workspace has no override, surfaced in a dedicated Settings › Sandbox page.

**Architecture:** Add optional override fields to the existing `WorkspaceRecord` (workspaces.json). The `resolved_sandbox_mode()`/`resolved_approval_policy()` resolvers become workspace-aware — precedence env > per-workspace override > global default (`runtime-settings.json`) > built-in. Every chokepoint already passes `thread_id`, so it inherits per-project behavior once the resolvers take `(state, thread_id)`. A new `POST /api/workspaces/{id}/policy` persists overrides; a new React page edits them.

**Tech Stack:** Rust (crate `local-first-desktop-gateway`, `crates/desktop-gateway/src/main.rs`), Axum, serde_json, React 19 + TS (`apps/desktop/src`), i18next.

## Global Constraints

- Rust comments in English; docs/UI copy in Italian (project rule).
- No `Co-Authored-By` trailer on commits; do not push.
- Reconciliation invariant: the OS kernel fence stays UNCONDITIONAL — no `sandbox_mode` value (per-project or global) disables it. `danger` only relaxes app-level approval.
- Absent override field = `None` = inherit the global default → upgrade is behavior-preserving.
- Env `HOMUN_SANDBOX_MODE` / `HOMUN_APPROVAL_POLICY` remain the absolute top-precedence override (tests/CI).
- Reuse the existing partial-merge pattern (`merge_runtime_settings`, main.rs) so a control posting one field never clobbers siblings.
- Tokens: sandbox = `read-only|workspace-write|danger`; approval = `never|on-request|on-failure|untrusted` (whatever `SandboxMode::parse`/`AskForApproval::parse` accept — verify in `tool_safety.rs`).

---

### Task 1: Per-workspace override fields on `WorkspaceRecord`

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`struct WorkspaceRecord` ~47799)
- Test: same file's `mod tests`

**Interfaces:**
- Produces: `WorkspaceRecord.sandbox_mode: Option<String>`, `WorkspaceRecord.approval_policy: Option<String>` (both `#[serde(default)]`).

- [ ] **Step 1: Write the failing test** — a workspaces.json blob WITHOUT the new fields deserializes with `None`, and WITH them round-trips.

```rust
#[test]
fn workspace_record_policy_overrides_default_to_none_and_round_trip() {
    let legacy: super::WorkspaceRecord =
        serde_json::from_str(r#"{"id":"w1","name":"P","folder":"/tmp/p"}"#).unwrap();
    assert_eq!(legacy.sandbox_mode, None);
    assert_eq!(legacy.approval_policy, None);
    let with: super::WorkspaceRecord = serde_json::from_str(
        r#"{"id":"w1","name":"P","sandbox_mode":"read-only","approval_policy":"never"}"#,
    ).unwrap();
    assert_eq!(with.sandbox_mode.as_deref(), Some("read-only"));
    let back = serde_json::to_string(&with).unwrap();
    assert!(back.contains("read-only"));
}
```

- [ ] **Step 2: Run to verify it fails** — `cargo test -p local-first-desktop-gateway workspace_record_policy_overrides -- --nocapture` → FAIL (unknown fields / compile error).
- [ ] **Step 3: Implement** — add to `WorkspaceRecord` (keep existing derives incl. `Serialize, Deserialize, Clone`):

```rust
    /// ADR 0023 — per-workspace policy overrides. `None` = inherit the global default
    /// (`runtime-settings.json`). Absent in legacy workspaces.json → None → behavior-preserving.
    #[serde(default)]
    sandbox_mode: Option<String>,
    #[serde(default)]
    approval_policy: Option<String>,
```

- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): per-workspace sandbox_mode/approval_policy override fields`.

---

### Task 2: Workspace-aware resolvers (`resolved_sandbox_mode`/`resolved_approval_policy`)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`resolved_sandbox_mode` ~19165, `resolved_approval_policy` ~19184; reuse the workspace lookup from `project_root_for_thread` ~11401)
- Test: same file's `mod tests` (use the existing `TEST_ENV_LOCK` + a temp data dir helper — grep `TEST_ENV_LOCK` and the workspaces-file test setup)

**Interfaces:**
- Produces:
  - `fn workspace_record_for_thread(state: &AppState, thread_id: Option<&str>) -> Option<WorkspaceRecord>`
  - `fn resolved_sandbox_mode(state: &AppState, thread_id: Option<&str>) -> crate::tool_safety::SandboxMode`
  - `fn resolved_approval_policy(state: &AppState, thread_id: Option<&str>) -> crate::tool_safety::AskForApproval`
- Consumes: `WorkspaceRecord.sandbox_mode/approval_policy` (Task 1); `store.workspace_for_thread` + `load_workspaces_file()` (existing, see `project_root_for_thread`).

- [ ] **Step 1: Write the failing test** — precedence env > workspace-override > global-default > built-in, for sandbox_mode. (Model on the existing `resolved_sandbox_mode_precedence_*` test; it currently calls `resolved_sandbox_mode()` with no args — this test calls the new `(state, thread_id)` form. Build an `AppState` + a workspaces.json with one workspace whose `sandbox_mode = Some("read-only")`, a thread mapped to it, and a global default of `workspace-write`.)

```rust
#[test]
fn resolved_sandbox_mode_workspace_override_beats_global_default() {
    let _g = TEST_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    std::env::remove_var("HOMUN_SANDBOX_MODE");
    // ... set up a temp data dir with runtime-settings.json {sandbox_mode:"workspace-write"}
    //     and workspaces.json [{id:"proj", name:"Proj", folder:"/tmp/x", sandbox_mode:"read-only"}]
    //     and a thread "t1" whose workspace_for_thread => "proj" (use the store test helper).
    let state = /* test AppState wired to that data dir + store */;
    assert_eq!(super::resolved_sandbox_mode(&state, Some("t1")), SandboxMode::ReadOnly);
    // Global fallback: a thread with no override inherits the global default.
    assert_eq!(super::resolved_sandbox_mode(&state, Some("t_no_override")), SandboxMode::WorkspaceWrite);
    // Env wins over everything.
    std::env::set_var("HOMUN_SANDBOX_MODE", "danger");
    assert_eq!(super::resolved_sandbox_mode(&state, Some("t1")), SandboxMode::Danger);
    std::env::remove_var("HOMUN_SANDBOX_MODE");
}
```

(If wiring a full `AppState` in a unit test is heavy, extract the pure core `fn resolve_mode(env: Option<&str>, ws_override: Option<&str>, global: &str) -> SandboxMode` and unit-test THAT directly + a thin `resolved_sandbox_mode` that gathers the three inputs. Prefer this — it's DRY and avoids AppState wiring. Mirror for approval.)

- [ ] **Step 2: Run to verify it fails** — `cargo test -p local-first-desktop-gateway resolved_sandbox_mode_workspace_override -- --nocapture` → FAIL.
- [ ] **Step 3: Implement** — add the helper + rewrite the resolvers. Sketch (pure-core variant):

```rust
/// The WorkspaceRecord for a thread's workspace (mirrors project_root_for_thread's lookup).
fn workspace_record_for_thread(state: &AppState, thread_id: Option<&str>) -> Option<WorkspaceRecord> {
    let workspace_id = thread_id
        .and_then(|tid| lock_store(state).ok().and_then(|s| s.workspace_for_thread(tid).ok()))
        .unwrap_or_else(active_workspace_id);
    load_workspaces_file().workspaces.into_iter().find(|w| w.id == workspace_id)
}

/// Pure precedence core (unit-testable): env > workspace override > global default > built-in.
fn resolve_sandbox_mode_core(env: Option<&str>, ws: Option<&str>, global: &str) -> crate::tool_safety::SandboxMode {
    use crate::tool_safety::SandboxMode;
    if let Some(m) = env.map(str::trim).filter(|s| !s.is_empty()) { return SandboxMode::parse(m); }
    if let Some(m) = ws.map(str::trim).filter(|s| !s.is_empty()) { return SandboxMode::parse(m); }
    SandboxMode::parse(global)
}

fn resolved_sandbox_mode(state: &AppState, thread_id: Option<&str>) -> crate::tool_safety::SandboxMode {
    let env = std::env::var("HOMUN_SANDBOX_MODE").ok();
    let ws = workspace_record_for_thread(state, thread_id).and_then(|w| w.sandbox_mode);
    resolve_sandbox_mode_core(env.as_deref(), ws.as_deref(), &load_runtime_settings().sandbox_mode)
}
```

Mirror `resolved_approval_policy(state, thread_id)` with `AskForApproval::parse` and `HOMUN_APPROVAL_POLICY`.

- [ ] **Step 4: Run to verify it passes** — same command → PASS. Keep/adapt the OLD precedence test (`resolved_sandbox_mode_precedence_env_beats_persisted_beats_default`) by pointing it at `resolve_sandbox_mode_core` (env/global only, ws=None).
- [ ] **Step 5: Commit** — `feat(gateway): workspace-aware sandbox/approval resolvers (env > project > global > default)`.

---

### Task 3: Thread the resolvers through the chokepoints

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — `resolved_sandbox_policy` (~19179) and EVERY call site of `resolved_sandbox_mode()`/`resolved_approval_policy()` (grep both — `write_project_file`/`edit_project_file`/`apply_patch_in_project`; MCP branch `resolved_sandbox_policy(ctx.state, ctx.thread_id)` + the new read-only MCP gate; Composio branch; `shadow_log_sandbox`; `effective_approval` callers).
- Test: same file's `mod tests`

**Interfaces:**
- Consumes: Task 2 resolvers.
- Produces: `resolved_sandbox_policy(state, thread_id)` now uses the workspace-aware mode. `write_project_file`/`edit_project_file`/`apply_patch_in_project` already receive `(state, thread_id)` — pass them into `resolved_sandbox_mode`.

- [ ] **Step 1: Write the failing test** — `write_project_file` refuses in a read-only WORKSPACE and writes in a workspace-write workspace, driven by the workspace override (not the global). Reuse the temp-data-dir/store setup from Task 2.

```rust
#[test]
fn write_project_file_honors_per_workspace_read_only() {
    let _g = TEST_ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    std::env::remove_var("HOMUN_SANDBOX_MODE");
    // global default = workspace-write; workspace "ro" override = read-only, "rw" = none (inherit).
    // thread t_ro -> "ro", t_rw -> "rw".
    let state = /* ... */;
    let blocked = super::write_project_file(&state, Some("t_ro"), "note.txt", "x");
    assert!(blocked.starts_with(super::READ_ONLY_BLOCKED_MARKER));
    let ok = super::write_project_file(&state, Some("t_rw"), "note.txt", "x");
    assert!(!ok.starts_with(super::READ_ONLY_BLOCKED_MARKER));
}
```

- [ ] **Step 2: Run to verify it fails** — currently `write_project_file` calls `resolved_sandbox_mode()` (global only) → the per-workspace read-only doesn't apply → FAIL.
- [ ] **Step 3: Implement** — change `resolved_sandbox_mode()`→`resolved_sandbox_mode(state, thread_id)` at each chokepoint. `write_project_file(state, thread_id, ...)` already has both. `resolved_sandbox_policy(state, thread_id)` calls `resolved_sandbox_mode(state, thread_id)`. In the MCP/Composio branches use `ctx.state`, `ctx.thread_id`. In `shadow_log_sandbox` it already has `(state, thread_id)`. `effective_approval(autonomous, resolved_approval_policy(ctx.state, ctx.thread_id))`.
- [ ] **Step 4: Run to verify it passes** — `cargo test -p local-first-desktop-gateway write_project_file_honors_per_workspace -- --nocapture` PASS; then full crate `cargo test -p local-first-desktop-gateway` (nothing regressed; the known `import_pptx` flaky is fixed now → expect 0 failures).
- [ ] **Step 5: Commit** — `feat(gateway): chokepoints honor per-workspace sandbox/approval policy`.

---

### Task 4: `POST /api/workspaces/{id}/policy` (persist overrides, partial-merge)

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` — add route near the other `/api/workspaces` routes (grep `"/api/workspaces`); add handler `set_workspace_policy`; a pure `merge_workspace_policy(record, patch)` helper mirroring `merge_runtime_settings`; save via the existing workspaces-file writer (grep `save_workspaces_file`/how `load_workspaces_file` is written back).
- Test: same file's `mod tests`

**Interfaces:**
- Consumes: Task 1 fields.
- Produces: `POST /api/workspaces/{id}/policy` body `{ sandbox_mode?: string, approval_policy?: string }` (each optional; `null` clears → back to inherit). Response: the updated `WorkspaceRecord` summary. Pure `fn merge_workspace_policy(current: &WorkspaceRecord, patch: &serde_json::Value) -> WorkspaceRecord`.

- [ ] **Step 1: Write the failing test** — partial-merge: set only `sandbox_mode`, `approval_policy` override untouched; token normalization (unknown → dropped/None); `null` clears to None.

```rust
#[test]
fn merge_workspace_policy_is_partial_and_normalizes() {
    let cur = super::WorkspaceRecord { id:"w".into(), name:"W".into(), folder:None,
        sandbox_mode: Some("read-only".into()), approval_policy: Some("never".into()) };
    let merged = super::merge_workspace_policy(&cur, &serde_json::json!({"approval_policy":"on-request"}));
    assert_eq!(merged.sandbox_mode.as_deref(), Some("read-only")); // untouched
    assert_eq!(merged.approval_policy.as_deref(), Some("on-request"));
    let cleared = super::merge_workspace_policy(&cur, &serde_json::json!({"sandbox_mode": null}));
    assert_eq!(cleared.sandbox_mode, None); // back to inherit
}
```

- [ ] **Step 2: Run to verify it fails** — `cargo test -p local-first-desktop-gateway merge_workspace_policy -- --nocapture` → FAIL (fn missing).
- [ ] **Step 3: Implement** — `merge_workspace_policy` (overlay patch keys onto the record's policy fields, `null`→None, unknown token → None via `SandboxMode::parse`/`AskForApproval::parse` round-trip, other unknown keys ignored). Handler: load workspaces file, find id (404 if absent), merge, save, return summary. Route `.route("/api/workspaces/{id}/policy", post(set_workspace_policy))`.
- [ ] **Step 4: Run to verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `feat(gateway): POST /api/workspaces/{id}/policy — persist per-workspace overrides (partial-merge)`.

---

### Task 5: Settings › Sandbox page (React)

**Files:**
- Create: `apps/desktop/src/components/SandboxSettingsView.tsx` (or a section in SettingsView if that's the pattern — grep how Model & Runtime pane is structured)
- Modify: `apps/desktop/src/components/SettingsView.tsx` (add nav item "Sandbox"); `apps/desktop/src/lib/coreBridge.ts` (add `setWorkspacePolicy(id, patch)` → POST the endpoint; add `listWorkspaces()` if not present); `apps/desktop/src/i18n/locales/{en,it}.json`
- Test: `apps/desktop/scripts/check-ui-contract.mjs` expectations if it asserts settings sections; electron tests if applicable.

**Interfaces:**
- Consumes: `GET` workspaces list (grep existing `/api/workspaces` GET in coreBridge), `POST /api/workspaces/{id}/policy` (Task 4), the existing global `runtime.settings` for the Default section.

- [ ] **Step 1: Write/extend the UI-contract expectation** — the Sandbox page exists with a "Default" section and a per-workspace list. (If `check-ui-contract.mjs` enumerates settings panes, add "Sandbox"; else add a lightweight assertion.) Run `npm run test:ui-contract` → FAIL.
- [ ] **Step 2: Implement the page** — `SandboxSettingsView`:
  - **Default** block: reuse the existing `SandboxModeBlock`/`ApprovalPolicyBlock` (from the earlier sandbox work in SettingsView) posting to `coreBridge.setRuntimeSettings` (unchanged), relabeled "Default per tutti i progetti".
  - **Workspace list**: fetch workspaces; per row show name + effective badge (`override` if `record.sandbox_mode`/`approval_policy` set, else `eredita`); expand → two selects each with an explicit `Eredita default` option (value `""` → POST `null`) plus the token values; onChange → `coreBridge.setWorkspacePolicy(id, {axis: value||null})`.
  - Keep the reconciliation copy (danger note). i18n keys en+it.
- [ ] **Step 3: Wire nav + coreBridge** — add `setWorkspacePolicy(id, patch): Promise<void>` to coreBridge (POST `/api/workspaces/${id}/policy`); ensure a workspaces getter exists; add "Sandbox" to the Settings nav.
- [ ] **Step 4: Verify** — `npm run build` (tsc+vite), `npm run test:ui-contract`, `npm run test:electron` all PASS. Live smoke: open Settings › Sandbox, set a project to read-only, confirm workspaces.json gets `sandbox_mode:"read-only"` for that id and a thread in that project now blocks writes.
- [ ] **Step 5: Commit** — `feat(desktop): Settings › Sandbox page — global default + per-workspace overrides`.

---

## Self-Review notes
- Spec coverage: Phase-1 slice (sandbox_mode + approval_policy per-workspace + dedicated page + resolution + endpoint + tests) — all mapped to Tasks 1–5. `writable_roots`/`network` (Phase 2) and `skill_confirmations` (Phase 3) are deliberately OUT of this plan (separate plans).
- Personal workspace: it resolves through the same `workspace_for_thread`/workspaces.json path; if Personal has no record, it inherits the global default (acceptable for Phase 1; a dedicated Personal record row can be added in Task 5 by seeding a `personal` entry if the list lacks it).
- Type consistency: `resolved_sandbox_mode(state, thread_id)` / `resolved_approval_policy(state, thread_id)` / `workspace_record_for_thread` / `merge_workspace_policy` / `setWorkspacePolicy` names used consistently across tasks.
