# Unified SandboxPolicy Resolution + Honest Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every effectful tool (bash, file-writes) obey ONE user-resolvable `SandboxPolicy` at the execution chokepoint, so the sandbox axis is real and honest — the prerequisite for the Settings UI (#1) that flips the default to `workspace-write`.

**Architecture:** A single rootless-mode resolver (`resolved_sandbox_mode()`, precedence env > persisted `RuntimeSettings.sandbox_mode` > default `danger`) feeds two consumers: (a) `run_in_project` builds its `SandboxPolicy` from the mode instead of hardcoding `workspace-write`; (b) the chat chokepoint gates `write_file`/`edit_file` — under `read-only` it denies and emits a `SANDBOX_ESCALATE` card whose approval re-runs the write (still project-jailed). Everything is behavior-preserving until #1 flips the default (default `danger` → all paths identical to today; `HOMUN_TOOL_SAFETY=1` → `workspace-write`, identical to today).

**Tech Stack:** Rust (axum gateway, `crates/desktop-gateway`), the existing pure `tool_safety.rs` classification module, Seatbelt (macOS) / Landlock (Linux) fences, React/TypeScript renderer (`apps/desktop`).

**Scope note — approval axis is OUT.** This plan implements the **sandbox** axis only. The **approval** axis (`AskForApproval`, `approval_policy` setting + UI wiring) already functions via the existing autonomous-based logic and belongs to task **#1** (Settings UI), which owns `approval_policy` end-to-end. Do NOT add `approval_policy` here.

**Key existing facts (verified 2026-07-03):**
- `tool_safety.rs` already defines `SandboxPolicy` (`DangerFullAccess`/`ReadOnly`/`WorkspaceWrite{writable_roots,network_access}`), `ToolFootprint`, `tool_footprint(name,args)`, `sandbox_shadow_verdict(footprint,policy,is_under_writable_root)` — all PURE and unit-tested.
- `seatbelt_profile(&SandboxPolicy)` already handles `ReadOnly` (tmp-only writes) and `WorkspaceWrite` (roots + tmp); returns `None` for `DangerFullAccess`.
- `run_in_project` (`main.rs:12200`) gates the fence on `sandboxed = tool_safety_enabled() && (cfg!(macos)||cfg!(linux))` and currently hardcodes `workspace_write_roots(&root, HOME)` → always `WorkspaceWrite`.
- `build_sandbox_command(writable_roots, command)` has 3 `cfg` arms (macОS `sandbox-exec`, Linux `homun-linux-sandbox`, other=Err). The macOS arm hardcodes `WorkspaceWrite`.
- `write_project_file`/`edit_project_file` (`main.rs:11881`/`11905`) already confine via `jail_in_root` (project-only) — KEEP unconditional (least-privilege for file-tools + defense-in-depth).
- Chokepoint `execute_chat_tool(ctx, name, args_raw, call_id) -> String`; `write_file` dispatch at `main.rs:21317`, `edit_file` at `21357`. `shadow_log_sandbox` (observe-only) runs at the top.
- Escalation: `SANDBOX_ESCALATE_OPEN/CLOSE` markers (`main.rs:36923`); `run_escalate` endpoint (`main.rs:37079`) currently re-runs **bash only** via `run_bash_unsandboxed`; provenance gate `sandbox_escalate_matches(text, command)` (`main.rs:37021`).
- Frontend escalate card is bash-specific: `ChatView.tsx:5983` parses `{arguments:{command,cwd}}`; `SandboxEscalateCard` (`7233`) calls `coreBridge.runEscalate(command, cwd, ctx)` (`coreBridge.ts:1909`).

**Build/test gates:** `cargo test -p desktop-gateway` (unit); `cargo check -p desktop-gateway`; `cd apps/desktop && npm run build` (tsc) + `npm run test:ui-contract`. Cross-platform (Linux) validated via CI (`build.yml` job `landlock-fence`), NOT locally on macOS. **Do NOT touch `apps/desktop/scripts/check-ui-contract.mjs` — a concurrent vault session owns its uncommitted change.**

---

## Task 1: Foundation — `SandboxMode` resolver + persisted `sandbox_mode` field

Introduce the single rootless mode + its resolution, defaulting to `danger` (behavior-preserving). No consumer changes yet.

**Files:**
- Modify: `crates/desktop-gateway/src/tool_safety.rs` (add `SandboxMode` enum, after `SandboxPolicy` ~line 41)
- Modify: `crates/desktop-gateway/src/main.rs` (`RuntimeSettings` ~27334; `tool_safety_enabled` ~18623; add `resolved_sandbox_mode`)
- Test: inline `#[cfg(test)]` in both files

- [ ] **Step 1: Write the failing test for `SandboxMode::parse`/`as_str`** (in `tool_safety.rs` tests module)

```rust
#[test]
fn sandbox_mode_parses_forgivingly_and_defaults_to_danger() {
    assert_eq!(SandboxMode::parse("read-only"), SandboxMode::ReadOnly);
    assert_eq!(SandboxMode::parse("readonly"), SandboxMode::ReadOnly);
    assert_eq!(SandboxMode::parse("workspace-write"), SandboxMode::WorkspaceWrite);
    assert_eq!(SandboxMode::parse("workspace_write"), SandboxMode::WorkspaceWrite);
    assert_eq!(SandboxMode::parse("danger-full-access"), SandboxMode::Danger);
    assert_eq!(SandboxMode::parse("garbage"), SandboxMode::Danger);
    assert_eq!(SandboxMode::parse(""), SandboxMode::Danger);
    assert_eq!(SandboxMode::ReadOnly.as_str(), "read-only");
    assert_eq!(SandboxMode::WorkspaceWrite.as_str(), "workspace-write");
    assert_eq!(SandboxMode::Danger.as_str(), "danger");
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cargo test -p desktop-gateway sandbox_mode_parses_forgivingly -- --nocapture`
Expected: FAIL — `cannot find type SandboxMode`.

- [ ] **Step 3: Add the `SandboxMode` enum** (in `tool_safety.rs`, after the `SandboxPolicy` enum)

```rust
/// The resolved sandbox MODE (rootless) — the user/policy CHOICE, before a caller
/// binds it to concrete writable roots. Roots differ per tool: `run_in_project` gets
/// project + tool caches (`workspace_write_roots`), the file-write tools stay
/// project-only (`jail_in_root`). Keeping the mode rootless is what lets one resolver
/// serve both without leaking one consumer's roots into the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    Danger,
}

impl SandboxMode {
    /// Forgiving parse (settings/env are user-facing strings). Anything unknown or
    /// empty falls back to `Danger` — the current default, so an unrecognized value
    /// never silently enables a fence.
    pub fn parse(raw: &str) -> SandboxMode {
        match raw.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "read-only" | "readonly" => SandboxMode::ReadOnly,
            "workspace-write" | "workspace" => SandboxMode::WorkspaceWrite,
            _ => SandboxMode::Danger,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            SandboxMode::ReadOnly => "read-only",
            SandboxMode::WorkspaceWrite => "workspace-write",
            SandboxMode::Danger => "danger",
        }
    }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `cargo test -p desktop-gateway sandbox_mode_parses_forgivingly`
Expected: PASS.

- [ ] **Step 5: Add `sandbox_mode` to `RuntimeSettings`** (`main.rs:27334`)

```rust
struct RuntimeSettings {
    /// Adaptive scaffolding floor (ADR 0018): `off` (default) | `shadow` | `on`.
    #[serde(default = "default_adaptive_floor")]
    adaptive_floor: String,
    /// Sandbox mode (ADR 0023): `danger` (default) | `read-only` | `workspace-write`.
    /// The persisted source for `resolved_sandbox_mode`; exposed in Settings by task #1.
    #[serde(default = "default_sandbox_mode")]
    sandbox_mode: String,
}

fn default_sandbox_mode() -> String {
    "danger".to_string()
}
```

Update `impl Default for RuntimeSettings` to add `sandbox_mode: default_sandbox_mode()`. Update `set_runtime_settings` (`main.rs:27384`) to normalize the new field, right after the `adaptive_floor` normalization:

```rust
settings.sandbox_mode = crate::tool_safety::SandboxMode::parse(&settings.sandbox_mode)
    .as_str()
    .to_string();
```

- [ ] **Step 6: Add `resolved_sandbox_mode()` + rewire `tool_safety_enabled()`** (`main.rs`, next to `tool_safety_enabled` ~18623)

```rust
/// The single source of truth for the sandbox axis. Precedence, mirroring
/// `adaptive_floor_mode`: env override > persisted RuntimeSettings > default(`danger`).
/// `HOMUN_TOOL_SAFETY=1` stays a back-compat alias for `workspace-write` so existing
/// validations/tests keep meaning the same thing; `HOMUN_SANDBOX_MODE` is the explicit
/// per-run override. Default `danger` → behavior-preserving (no fence) until task #1
/// flips the persisted default.
fn resolved_sandbox_mode() -> crate::tool_safety::SandboxMode {
    use crate::tool_safety::SandboxMode;
    if let Ok(m) = std::env::var("HOMUN_SANDBOX_MODE") {
        if !m.trim().is_empty() {
            return SandboxMode::parse(&m);
        }
    }
    if std::env::var("HOMUN_TOOL_SAFETY").as_deref() == Ok("1") {
        return SandboxMode::WorkspaceWrite;
    }
    SandboxMode::parse(&load_runtime_settings().sandbox_mode)
}

/// ADR 0023 gate, now DERIVED from the sandbox axis (was `HOMUN_TOOL_SAFETY==1`).
/// Deliberately NOT influenced by the approval axis: with the default mode `danger`
/// this returns false (legacy behavior); `HOMUN_TOOL_SAFETY=1` → `workspace-write` →
/// true, exactly as before. Kept a fn (not LazyLock) so tests toggle env per case.
fn tool_safety_enabled() -> bool {
    resolved_sandbox_mode() != crate::tool_safety::SandboxMode::Danger
}
```

Delete the old `tool_safety_enabled` body (the `std::env::var("HOMUN_TOOL_SAFETY")...=="1"` one) and its now-stale doc-comment lines that describe the boolean; replace with the above.

- [ ] **Step 7: Write the failing test for the resolver precedence** (`main.rs` tests module)

```rust
#[test]
fn resolved_sandbox_mode_precedence_env_over_default() {
    use crate::tool_safety::SandboxMode;
    // NB: env-var tests share process state; scope with a mutex if the suite runs them
    // in parallel. Here we set/clear explicitly.
    std::env::remove_var("HOMUN_SANDBOX_MODE");
    std::env::remove_var("HOMUN_TOOL_SAFETY");
    assert_eq!(resolved_sandbox_mode(), SandboxMode::Danger); // default
    std::env::set_var("HOMUN_TOOL_SAFETY", "1");
    assert_eq!(resolved_sandbox_mode(), SandboxMode::WorkspaceWrite); // alias
    std::env::set_var("HOMUN_SANDBOX_MODE", "read-only");
    assert_eq!(resolved_sandbox_mode(), SandboxMode::ReadOnly); // explicit override wins
    std::env::remove_var("HOMUN_SANDBOX_MODE");
    std::env::remove_var("HOMUN_TOOL_SAFETY");
    assert!(!tool_safety_enabled()); // danger → disabled
}
```

- [ ] **Step 8: Run the full crate tests, verify green**

Run: `cargo test -p desktop-gateway resolved_sandbox_mode_precedence && cargo test -p desktop-gateway`
Expected: PASS; **no regressions** (existing sandbox/fence tests still pass — default is `danger`, `HOMUN_TOOL_SAFETY=1` still maps to workspace-write).

- [ ] **Step 9: Commit**

```bash
git add crates/desktop-gateway/src/tool_safety.rs crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): single SandboxMode resolver + persisted sandbox_mode (ADR 0023 #2)"
```

---

## Task 2: `run_in_project` honors the resolved mode (read-only bash becomes real)

Make the bash fence build its policy from `resolved_sandbox_mode` instead of hardcoding workspace-write.

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`build_sandbox_command` 3 arms ~12093/12125/12160; `run_in_project` ~12221–12232)
- Test: inline `#[cfg(test)]` (unit for command build) + one `#[ignore]` runtime test

- [ ] **Step 1: Change `build_sandbox_command` to take a `&SandboxPolicy`** (all 3 `cfg` arms)

macOS arm (`~12093`) — use the passed policy instead of constructing WorkspaceWrite:

```rust
#[cfg(target_os = "macos")]
fn build_sandbox_command(
    policy: &crate::tool_safety::SandboxPolicy,
    command: &str,
) -> Result<tokio::process::Command, String> {
    match crate::seatbelt::seatbelt_profile(policy) {
        Some(profile) => {
            let mut c = tokio::process::Command::new("sandbox-exec");
            c.arg("-p").arg(profile).arg("bash").arg("-lc").arg(command);
            Ok(c)
        }
        // DangerFullAccess → None; never fenced here (caller handles danger before this).
        None => Err("no seatbelt profile for the sandbox policy".to_string()),
    }
}
```

Linux arm (`~12125`) — derive the `--allow-write` roots from the policy (empty for read-only):

```rust
#[cfg(target_os = "linux")]
fn build_sandbox_command(
    policy: &crate::tool_safety::SandboxPolicy,
    command: &str,
) -> Result<tokio::process::Command, String> {
    use crate::tool_safety::SandboxPolicy;
    let writable_roots: Vec<std::path::PathBuf> = match policy {
        SandboxPolicy::WorkspaceWrite { writable_roots, .. } => writable_roots.clone(),
        SandboxPolicy::ReadOnly => Vec::new(), // no writable roots → Landlock fences all writes
        SandboxPolicy::DangerFullAccess => {
            return Err("danger-full-access has no fence to build".to_string());
        }
    };
    let helper = match std::env::var_os("HOMUN_LINUX_SANDBOX_BIN") {
        Some(path) => std::path::PathBuf::from(path),
        None => {
            let exe = std::env::current_exe()
                .map_err(|e| format!("cannot resolve current executable: {e}"))?;
            let dir = exe
                .parent()
                .ok_or_else(|| "current executable has no parent directory".to_string())?;
            dir.join("homun-linux-sandbox")
        }
    };
    if !helper.is_file() {
        return Err(format!(
            "linux sandbox helper not found at {} (set HOMUN_LINUX_SANDBOX_BIN)",
            helper.display()
        ));
    }
    let mut c = tokio::process::Command::new(&helper);
    for root in &writable_roots {
        c.arg("--allow-write").arg(root);
    }
    c.arg("--").arg("bash").arg("-lc").arg(command);
    Ok(c)
}
```

Other arm (`~12160`) — update signature only:

```rust
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn build_sandbox_command(
    _policy: &crate::tool_safety::SandboxPolicy,
    _command: &str,
) -> Result<tokio::process::Command, String> {
    Err("no sandbox backend on this platform".to_string())
}
```

- [ ] **Step 2: Update `run_in_project` to resolve the mode → policy** (`~12221–12232`)

Replace the hardcoded `writable_roots`/`build_sandbox_command(&writable_roots, command)` block:

```rust
    let sandboxed =
        tool_safety_enabled() && (cfg!(target_os = "macos") || cfg!(target_os = "linux"));
    if !sandboxed {
        return RunProjectOutcome::Completed(run_bash_unsandboxed(&root, command).await);
    }
    // Build the concrete policy from the resolved mode. `tool_safety_enabled()` is
    // true here, so the mode is ReadOnly or WorkspaceWrite (never Danger).
    use crate::tool_safety::SandboxMode;
    let policy = match resolved_sandbox_mode() {
        SandboxMode::ReadOnly => crate::tool_safety::SandboxPolicy::ReadOnly,
        SandboxMode::WorkspaceWrite => crate::tool_safety::SandboxPolicy::WorkspaceWrite {
            writable_roots: workspace_write_roots(&root, std::env::var("HOME").ok().as_deref()),
            network_access: true,
        },
        // Unreachable: sandboxed == (mode != Danger). Fail closed rather than run raw.
        SandboxMode::Danger => {
            return RunProjectOutcome::Completed(
                "Command NOT executed: internal sandbox resolution error.".to_string(),
            );
        }
    };
    let mut cmd = match build_sandbox_command(&policy, command) {
        Ok(cmd) => cmd,
        Err(error) => {
            return RunProjectOutcome::Completed(format!(
                "Command NOT executed: the workspace sandbox could not start ({error}). \
The command was not run unsandboxed."
            ));
        }
    };
```

- [ ] **Step 3: Fix the existing `build_sandbox_command` unit tests** to pass a policy

Find tests calling `build_sandbox_command(&roots, ...)` (search `build_sandbox_command(` in tests) and update them to `build_sandbox_command(&SandboxPolicy::WorkspaceWrite{ writable_roots: roots, network_access: true }, ...)`. Add one new unit test for the read-only profile (macOS-only, pure — builds the profile string, no exec):

```rust
#[cfg(target_os = "macos")]
#[test]
fn read_only_policy_yields_a_profile_without_project_write_subpath() {
    use crate::tool_safety::SandboxPolicy;
    let profile = crate::seatbelt::seatbelt_profile(&SandboxPolicy::ReadOnly)
        .expect("read-only has a profile");
    // Read-only allows writes ONLY to tmp; there is no project subpath in the profile.
    assert!(profile.contains("(allow file-write*"));
    assert!(!profile.contains("/proj")); // no project root made writable
}
```

- [ ] **Step 4: Run unit tests, verify green**

Run: `cargo test -p desktop-gateway`
Expected: PASS (workspace-write behavior unchanged; new read-only profile test green).

- [ ] **Step 5: Add a runtime `#[ignore]` test proving read-only DENIES a write** (macOS; the "validate by executing" lesson)

```rust
// Runtime validation: under HOMUN_SANDBOX_MODE=read-only, a bash write to the project
// is DENIED by the fence. Ignored by default (needs sandbox-exec, macOS only); run with
// `cargo test -p desktop-gateway read_only_bash_denies_project_write -- --ignored --nocapture`.
#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore]
async fn read_only_bash_denies_project_write() {
    use crate::tool_safety::SandboxPolicy;
    let dir = std::env::temp_dir().join(format!("homun-ro-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let policy = SandboxPolicy::ReadOnly;
    let mut cmd = build_sandbox_command(&policy, "echo hi > blocked.txt").unwrap();
    cmd.current_dir(&dir);
    let out = cmd.output().await.unwrap();
    assert!(!out.status.success(), "write must be denied under read-only");
    assert!(!dir.join("blocked.txt").exists(), "file must NOT be created");
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 6: Run the runtime test locally (macOS), verify it denies**

Run: `cargo test -p desktop-gateway read_only_bash_denies_project_write -- --ignored --nocapture`
Expected: PASS (status non-success, file absent). If it does NOT deny, STOP — the profile is wrong; do not proceed.

- [ ] **Step 7: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): run_in_project honors resolved sandbox mode incl. read-only (ADR 0023 #2)"
```

- [ ] **Step 8: Extend the Linux CI fence job to also assert read-only denies**

In `.github/workflows/build.yml`, in the `landlock-fence` job, add a second invocation running the fence with **no** `--allow-write` roots and asserting the write is denied (mirror the existing workspace-write assertion; consult the existing job's command). Push and confirm the job is green on the PR. (Linux is NOT locally executable on macOS — CI is the oracle.)

---

## Task 3: File-write tools gate on the resolved mode at the chokepoint

Under `read-only`, `write_file`/`edit_file` deny and emit a `SANDBOX_ESCALATE` card. Under `workspace-write`/`danger` they proceed unchanged (still `jail_in_root`).

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (add `emit_write_escalate_card` + `sandbox_gate_write`; call at `write_file` `~21317` and `edit_file` `~21357`)
- Test: inline

- [ ] **Step 1: Add the escalate-card emitter for writes** (near `emit_approval_card` ~18634)

```rust
/// ADR 0023 #2: a file-write blocked by the read-only sandbox surfaces the SAME
/// escalation card as a fenced bash command — approving re-runs the write (still
/// project-jailed). The marker carries the tool + its arguments so `run_escalate`
/// can re-dispatch and `sandbox_escalate_write_matches` can verify provenance.
async fn emit_write_escalate_card(
    ctx: &mut ChatToolCtx<'_>,
    name: &str,
    args_val: &serde_json::Value,
) -> String {
    let approval =
        create_pending_approval(ctx.state, name, args_val, "file write", ctx.thread_id, true);
    let marker = match approval.as_ref() {
        Some(a) => serde_json::json!({
            "approval_id": a.approval_id, "tool": name, "arguments": args_val,
        }),
        None => serde_json::json!({ "tool": name, "arguments": args_val }),
    }
    .to_string();
    let card = format!(
        "\n\nThis write was blocked by the read-only sandbox.\n\
{SANDBOX_ESCALATE_OPEN}{marker}{SANDBOX_ESCALATE_CLOSE}\n"
    );
    ctx.accumulated.push_str(&card);
    let _ = emit_stream_event(ctx.tx, GenerateStreamEvent::Delta { text: card }).await;
    *ctx.pending_confirm = true;
    "AWAITING USER CONFIRMATION: the write was blocked by the read-only sandbox and \
proposed via an escalation card. Do NOT say it was written."
        .to_string()
}

/// Returns `Some(model-facing string)` when a write tool must NOT proceed under the
/// resolved sandbox mode (today: read-only → escalation card). `None` = proceed to the
/// normal dispatch. Non-write footprints and workspace-write/danger modes return None.
async fn sandbox_gate_write(
    ctx: &mut ChatToolCtx<'_>,
    name: &str,
    args_val: &serde_json::Value,
) -> Option<String> {
    use crate::tool_safety::{tool_footprint, SandboxMode, ToolFootprint};
    if !matches!(tool_footprint(name, args_val), ToolFootprint::Write { .. }) {
        return None;
    }
    match resolved_sandbox_mode() {
        SandboxMode::ReadOnly => Some(emit_write_escalate_card(ctx, name, args_val).await),
        // workspace-write / danger: proceed; jail_in_root confines to the project.
        SandboxMode::WorkspaceWrite | SandboxMode::Danger => None,
    }
}
```

- [ ] **Step 2: Call the gate in the `write_file` branch** (`~21317`, right after `args_val` is parsed)

```rust
    } else if name == "write_file" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(blocked) = sandbox_gate_write(ctx, "write_file", &args_val).await {
            return blocked;
        }
        // …existing path/content extraction + dispatch unchanged…
```

- [ ] **Step 3: Call the gate in the `edit_file` branch** (`~21357`, after `args_val` is parsed)

```rust
    } else if name == "edit_file" {
        let args_val: serde_json::Value =
            serde_json::from_str(args_raw).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(blocked) = sandbox_gate_write(ctx, "edit_file", &args_val).await {
            return blocked;
        }
        // …existing old/new extraction + dispatch unchanged…
```

- [ ] **Step 4: Write a unit test for `sandbox_gate_write`'s decision** (pure logic split)

Because `sandbox_gate_write` needs `ChatToolCtx`, extract the DECISION into a pure helper and test that instead:

```rust
/// Pure: does a write tool need the read-only escalation under this mode? (Testable
/// without ChatToolCtx.) `sandbox_gate_write` calls this, then emits the card if true.
fn write_needs_read_only_escalation(name: &str, args: &serde_json::Value, mode: crate::tool_safety::SandboxMode) -> bool {
    use crate::tool_safety::{tool_footprint, SandboxMode, ToolFootprint};
    matches!(tool_footprint(name, args), ToolFootprint::Write { .. })
        && mode == SandboxMode::ReadOnly
}
```

Refactor `sandbox_gate_write` to use it (`if write_needs_read_only_escalation(name, args_val, resolved_sandbox_mode()) { Some(emit...) } else { None }`). Test:

```rust
#[test]
fn write_tools_escalate_only_under_read_only() {
    use crate::tool_safety::SandboxMode;
    let args = serde_json::json!({ "path": "src/x.rs", "content": "hi" });
    assert!(write_needs_read_only_escalation("write_file", &args, SandboxMode::ReadOnly));
    assert!(!write_needs_read_only_escalation("write_file", &args, SandboxMode::WorkspaceWrite));
    assert!(!write_needs_read_only_escalation("write_file", &args, SandboxMode::Danger));
    // Non-write tools never escalate.
    let ra = serde_json::json!({ "path": "src/x.rs" });
    assert!(!write_needs_read_only_escalation("read_text_file", &ra, SandboxMode::ReadOnly));
}
```

- [ ] **Step 5: Run tests + typecheck the gateway, verify green**

Run: `cargo test -p desktop-gateway write_tools_escalate_only_under_read_only && cargo check -p desktop-gateway`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): read-only sandbox gates write_file/edit_file at the chokepoint (ADR 0023 #2)"
```

---

## Task 4: `run_escalate` re-runs file writes on approval (still project-jailed)

Extend the escalation endpoint + provenance gate to handle `write_file`/`edit_file`.

**Files:**
- Modify: `crates/desktop-gateway/src/main.rs` (`RunEscalateRequest` struct near `run_escalate` ~37060; `run_escalate` ~37079; add `sandbox_escalate_write_matches`)
- Test: inline

- [ ] **Step 1: Read the current `RunEscalateRequest` struct** (search `struct RunEscalateRequest`) and make `command`/`cwd` optional + add write fields

```rust
#[derive(Deserialize)]
struct RunEscalateRequest {
    // bash escalation (existing)
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    // file-write escalation (new): tool ∈ {write_file, edit_file}
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    old_string: Option<String>,
    #[serde(default)]
    new_string: Option<String>,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
}
```

- [ ] **Step 2: Add the write provenance matcher** (near `sandbox_escalate_matches` ~37021)

```rust
/// Provenance for a file-write escalation: the stored message must carry a
/// SANDBOX_ESCALATE card whose `tool` and `arguments` deep-equal the request's, so
/// only the exact proposed write can run. Mirrors `sandbox_escalate_matches` (bash).
fn sandbox_escalate_write_matches(
    text: &str,
    tool: &str,
    arguments: &serde_json::Value,
) -> bool {
    let Some(marker) = confirm_marker_value(text, SANDBOX_ESCALATE_OPEN, SANDBOX_ESCALATE_CLOSE)
    else {
        return false;
    };
    marker.get("tool").and_then(|v| v.as_str()) == Some(tool)
        && marker.get("arguments") == Some(arguments)
}
```

- [ ] **Step 3: Branch `run_escalate` on `tool`** (`~37079`)

At the top of `run_escalate`, before the existing bash provenance/exec block, add the write branch:

```rust
    // File-write escalation branch (ADR 0023 #2): re-run the exact blocked write.
    if let Some(tool) = request.tool.as_deref() {
        if tool == "write_file" || tool == "edit_file" {
            let arguments = match tool {
                "write_file" => serde_json::json!({
                    "path": request.path.clone().unwrap_or_default(),
                    "content": request.content.clone().unwrap_or_default(),
                }),
                _ => serde_json::json!({
                    "path": request.path.clone().unwrap_or_default(),
                    "old_string": request.old_string.clone().unwrap_or_default(),
                    "new_string": request.new_string.clone().unwrap_or_default(),
                }),
            };
            let confirmed = match (&request.thread_id, &request.message_id) {
                (Some(tid), Some(mid)) => lock_store(&state)
                    .ok()
                    .and_then(|s| s.message(tid, mid).ok().flatten())
                    .is_some_and(|m| sandbox_escalate_write_matches(&m.text, tool, &arguments)),
                _ => false,
            };
            if !confirmed {
                return Err(GatewayError {
                    status: StatusCode::FORBIDDEN,
                    code: "sandbox_escalate_required",
                    message: "Re-run a write only from its matching escalation card.".to_string(),
                });
            }
            // Re-run through the canonical executor — STILL jail_in_root (project-scoped).
            let path = request.path.clone().unwrap_or_default();
            let output = if tool == "write_file" {
                write_project_file(&state, request.thread_id.as_deref(), &path,
                    &request.content.clone().unwrap_or_default())
            } else {
                edit_project_file(&state, request.thread_id.as_deref(), &path,
                    &request.old_string.clone().unwrap_or_default(),
                    &request.new_string.clone().unwrap_or_default())
            };
            // Rewrite the card marker to a done-note so it can't reopen on reload.
            if let (Some(tid), Some(mid)) = (&request.thread_id, &request.message_id) {
                if let Ok(store) = lock_store(&state) {
                    if let Ok(Some(m)) = store.message(tid, mid) {
                        let rewritten = rewrite_sandbox_escalate_to_done(&m.text, &path);
                        let _ = store.set_message_text(tid, mid, &rewritten);
                    }
                }
            }
            return Ok(Json(serde_json::json!({ "ok": true, "output": output })));
        }
    }
    // …existing bash path below (uses request.command); guard for None command…
```

For the existing bash path, replace `request.command` usage with `request.command.clone().unwrap_or_default()` (or early-error if `None`). Confirm `rewrite_sandbox_escalate_to_done` matches on the marker generically (it rewrites by locating the marker, not by the command string — verify at `~37130`; if it requires the command, pass `&path` for writes or generalize it to rewrite the whole marker block regardless of payload).

- [ ] **Step 4: Write a unit test for `sandbox_escalate_write_matches`**

```rust
#[test]
fn write_escalate_matches_only_the_proposed_write() {
    let args = serde_json::json!({ "path": "src/x.rs", "content": "hi" });
    let text = format!(
        "This write was blocked.\n{SANDBOX_ESCALATE_OPEN}{}{SANDBOX_ESCALATE_CLOSE}\n",
        serde_json::json!({ "approval_id": "a1", "tool": "write_file", "arguments": args })
    );
    assert!(sandbox_escalate_write_matches(&text, "write_file", &args));
    // Wrong path → reject.
    let other = serde_json::json!({ "path": "src/evil.rs", "content": "hi" });
    assert!(!sandbox_escalate_write_matches(&text, "write_file", &other));
    // Wrong tool → reject.
    assert!(!sandbox_escalate_write_matches(&text, "edit_file", &args));
}
```

- [ ] **Step 5: Run tests + check, verify green**

Run: `cargo test -p desktop-gateway write_escalate_matches_only_the_proposed_write && cargo check -p desktop-gateway`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add crates/desktop-gateway/src/main.rs
git commit -m "feat(gateway): escalation endpoint re-runs blocked file writes, project-jailed (ADR 0023 #2)"
```

---

## Task 5: Frontend — generalize the escalate card to file writes

Parse the write payload from the marker and let `SandboxEscalateCard` approve a write.

**Files:**
- Modify: `apps/desktop/src/components/ChatView.tsx` (parse ~5983; render ~6219; `SandboxEscalateCard` ~7233)
- Modify: `apps/desktop/src/lib/coreBridge.ts` (`electronRunEscalate` ~1909; `runEscalate` export ~2749)
- Test: `npm run build` (tsc) — no unit harness for this component; validate via typecheck + a manual smoke note

- [ ] **Step 1: Generalize the marker parse** (`ChatView.tsx:5983`)

```tsx
  // ADR 0023: a shell command OR a file write blocked by the sandbox → "run with full
  // access" card. Payload: {tool?, arguments:{command,cwd} | {path,content} | {path,old_string,new_string}}.
  let sandboxEscalate:
    | { kind: "command"; command: string; cwd: string }
    | { kind: "write"; tool: "write_file" | "edit_file"; args: Record<string, string> }
    | null = null;
  const escMatch = text.match(SANDBOX_ESCALATE_RE);
  if (escMatch) {
    try {
      const parsed = JSON.parse(escMatch[1]) as {
        tool?: string;
        arguments?: Record<string, string>;
      };
      const a = parsed.arguments ?? {};
      if (parsed.tool === "write_file" || parsed.tool === "edit_file") {
        if (typeof a.path === "string") {
          sandboxEscalate = { kind: "write", tool: parsed.tool, args: a };
        }
      } else if (typeof a.command === "string") {
        sandboxEscalate = { kind: "command", command: a.command, cwd: a.cwd ?? "" };
      }
    } catch {
      /* malformed → just hide it */
    }
  }
```

- [ ] **Step 2: Pass the discriminated payload to the card** (`ChatView.tsx:6219`)

```tsx
        <SandboxEscalateCard
          escalate={sandboxEscalate}
          messageId={messageId}
          threadId={threadId}
        />
```

- [ ] **Step 3: Update `SandboxEscalateCard`** (`ChatView.tsx:7233`) to accept the union and call the right bridge

```tsx
function SandboxEscalateCard({
  escalate,
  messageId,
  threadId,
}: {
  escalate:
    | { kind: "command"; command: string; cwd: string }
    | { kind: "write"; tool: "write_file" | "edit_file"; args: Record<string, string> };
  messageId?: string;
  threadId?: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [output, setOutput] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async () => {
    setStatus("running");
    setNote(null);
    try {
      const result =
        escalate.kind === "command"
          ? await coreBridge.runEscalate(
              { command: escalate.command, cwd: escalate.cwd },
              { threadId, messageId },
            )
          : await coreBridge.runEscalate(
              { tool: escalate.tool, ...escalate.args },
              { threadId, messageId },
            );
      if (!result.ok) {
        setStatus("error");
        setNote(result.summary || t("chat.failed"));
        return;
      }
      setOutput(result.output ?? "");
      setStatus("done");
    } catch (error) {
      setStatus("error");
      setNote((error as Error).message);
    }
  };
  // …done/idle rendering: show `escalate.command` for command kind, `escalate.args.path`
  //   for write kind; keep the existing styling. Header copy: writes → "This write was
  //   blocked by the read-only sandbox. Write it anyway?"…
```

Update the two render blocks (`done` header + the idle header/`<code>`) to branch on `escalate.kind` — command shows the command, write shows the path. Keep the existing classes/icons.

- [ ] **Step 4: Update the bridge to accept a payload object** (`coreBridge.ts:1909` + export `2749`)

```ts
async function electronRunEscalate(
  payload: Record<string, string>,
  ctx?: { threadId?: string; messageId?: string },
): Promise<{ ok: boolean; output?: string; summary?: string }> {
  return gatewayPostJson("/api/capabilities/run/escalate", {
    ...payload,
    ...(ctx?.threadId ? { thread_id: ctx.threadId } : {}),
    ...(ctx?.messageId ? { message_id: ctx.messageId } : {}),
  });
}
```

Update the exported `runEscalate` signature (`~2749`) to `(payload, ctx) => electronRunEscalate(payload, ctx)`. Grep for other `runEscalate(` call sites and update them to the object form (the bash card in Step 3 already uses `{ command, cwd }`).

- [ ] **Step 5: Typecheck + ui-contract, verify green**

Run: `cd apps/desktop && npm run build && npm run test:ui-contract`
Expected: tsc clean; ui-contract green. (Do NOT modify `scripts/check-ui-contract.mjs`.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/components/ChatView.tsx apps/desktop/src/lib/coreBridge.ts
git commit -m "feat(desktop): sandbox escalation card handles blocked file writes (ADR 0023 #2)"
```

---

## Task 6: Docs + STATO

**Files:**
- Modify: `docs/decisions/0023-sandbox-enforcement-and-unified-approval.md` (mark step "sandbox onesto" complete; add the MCP/Composio honest-limitation note)
- Modify: `docs/architecture/desktop-shell.md` (or the tool-exec map) — document the resolver + the file-tool gate + the MCP/Composio limitation
- Modify: `docs/STATO.md` (⭐ RIPRESA: #2 done, resolver unified, read-only honest across bash+writes; next = #1 Settings UI + flip default)

- [ ] **Step 1: Update ADR 0023** — under "Sequenza", note step 3/4 progress: sandbox axis now resolved from one source and honored by bash + file-writes; add an explicit paragraph: "MCP/Composio: the sandbox axis does NOT fence them (external processes/network, like Codex); their gate is the approval axis. This is a documented limitation, not silent."

- [ ] **Step 2: Update the architecture map** — add `resolved_sandbox_mode` as the single source; the two consumers (bash fence, chokepoint write-gate); the escalation flow for writes; the MCP/Composio limitation. Update the Mermaid if present.

- [ ] **Step 3: Update STATO.md ⭐ RIPRESA** — concise: "#2 COMPLETO — risoluzione SandboxPolicy unica (`resolved_sandbox_mode`, precedenza env>setting>default), bash + write_file/edit_file onorano il mode; read-only reale (bash fenced, writes → escalation card project-jailed); MCP/Composio = limite documentato (asse approval). Validato eseguendo (macOS) + CI (Linux). PROSSIMO = #1 Settings UI (`sandbox_mode` + `approval_policy`) + **flip default a workspace-write**."

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: sandbox axis resolved + honored across effectful tools; MCP/Composio limitation noted (ADR 0023 #2)"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 resolver → Task 1; §2 bash honors policy → Task 2; §3 file-tools gate → Task 3; §5 escalation for writes → Task 4 + Task 5 (frontend); §4 MCP/Composio limitation → Task 6 (documented, no enforcement by design). Testing (unit + execute-on-macOS + CI-on-Linux) → distributed across Tasks 1–5. Approval axis explicitly deferred to #1 (scope note).
- **Placeholder scan:** no TBD/TODO-as-work; every code step shows real code. Task 2 Step 8 (CI) and Task 5 Step 3 (render branches) reference "consult the existing job/blocks" — the executor reads the exact lines cited; the target shape is specified.
- **Type consistency:** `SandboxMode{ReadOnly,WorkspaceWrite,Danger}` + `parse`/`as_str` used identically in Tasks 1–3; `resolved_sandbox_mode()` no-arg everywhere; `build_sandbox_command(&SandboxPolicy, &str)` consistent across all 3 arms and the call site; `sandbox_escalate_write_matches(text, tool, &Value)` consistent between Task 4 def and test; `runEscalate(payload, ctx)` object-form consistent between coreBridge and both card kinds.
- **Known follow-ups (out of scope, not gaps):** approval-axis UI/wiring (#1); network-off under workspace-write; artifact/deck write tools footprint (`tool_footprint` leaves them `NonFilesystem`).
