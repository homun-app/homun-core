//! Codex-style tool-safety policy vocabulary + the pure decision function.
//!
//! First step of ADR 0023 (`docs/decisions/0023-sandbox-enforcement-and-unified-approval.md`):
//! the two orthogonal policy axes Codex settled on — a **sandbox mode** (the
//! physical fence: what the process CAN do) and an **approval policy** (the UX
//! axis: WHEN to stop and ask) — plus a pure decision function that combines them
//! with the already-computed facts about a single tool call. This mirrors
//! `codex-rs/core/src/safety.rs::assess_command_safety`.
//!
//! **PURE-ADDITION / seam-types phase.** Nothing here is wired into the chat loop
//! yet (that is a later task): `assess_tool_safety` is a total, IO-free function
//! so it is identical to run anywhere and fully unit-testable. The truth table it
//! encodes is a **behavior-preserving** restatement of TODAY's confirmation logic
//! in `stream_chat_via_openai` (main.rs ~21334 for MCP writes, ~21444 for Composio
//! writes): both reduce to
//!
//! ```text
//! needs_confirm = is_effectful_write && approval != Never && !pre_authorized
//! ```
//!
//! where `Never` is today's `autonomous` flag, and `pre_authorized` is today's
//! `workspace_scoped` (MCP) / `composio_tool_allowed` (Composio) escape hatch.
//! `Reject` is reserved for a later step (read-only violations) and is not
//! produced yet.
#![allow(dead_code)] // nothing is wired into the loop yet — this is a seam-types phase.

use std::path::PathBuf;

/// Codex `SandboxPolicy` — the physical fence (what the process CAN do), per session/workspace.
#[derive(Debug, Clone, PartialEq)]
pub enum SandboxPolicy {
    /// No fence — explicit user choice, never the default.
    DangerFullAccess,
    /// Read anywhere allowed; NO writes outside a scratch tmp.
    ReadOnly,
    /// Writes ONLY under the workspace roots (+ tmp); no non-local network unless allowed.
    WorkspaceWrite {
        writable_roots: Vec<PathBuf>,
        network_access: bool,
    },
}

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

/// Codex `AskForApproval` — WHEN to stop and ask (the UX axis), independent of the fence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskForApproval {
    /// Ask for everything except a known-safe allowlist.
    UnlessTrusted,
    /// Run sandboxed; ask only if a command fails and wants more privilege.
    OnFailure,
    /// The model asks when it judges it needs to.
    OnRequest,
    /// Never ask (autonomous runs; presumes a tight sandbox).
    Never,
}

/// Which OS fence an auto-approved tool runs under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxKind {
    None,
    MacosSeatbelt,
    LinuxSeccomp,
}

/// The outcome of assessing a tool call — Codex's `SafetyCheck`.
#[derive(Debug, Clone, PartialEq)]
pub enum SafetyDecision {
    /// Execute now, under this fence.
    AutoApprove { sandbox: SandboxKind },
    /// Stop and surface a confirmation to the user (the chat branch emits the card).
    AskUser,
    /// Hard refuse (e.g. a mutating tool under read-only).
    Reject { reason: String },
}

/// Decide how a tool call should proceed, from the two policy axes plus the
/// already-computed facts about the call. PURE — no AppState, no IO — so it is
/// fully unit-testable and identical to run anywhere (Codex's approach).
///
/// - `is_effectful_write`: the tool mutates external state (today: membership in
///   the gateway's `composio_writes` set).
/// - `pre_authorized`: this specific call is already trusted for THIS turn — the
///   "known-safe allowlist" analog (MCP: the write is jailed under the thread's
///   workspace root; Composio: the tool is on the user's always-allow list).
/// - `sandbox_kind_for(&sandbox)`: which OS fence the current SandboxPolicy maps to.
///
/// Behavior-preserving encoding of TODAY's confirmation logic:
///   `needs_confirm = is_effectful_write && approval != Never && !pre_authorized`
/// (`Never` == today's `autonomous`; `pre_authorized` == today's
/// `workspace_scoped` / `composio_tool_allowed`.) Everything else auto-approves
/// under the current fence. `Reject` is reserved for a later step (read-only
/// violations) — not produced here yet.
pub fn assess_tool_safety(
    approval: AskForApproval,
    sandbox: &SandboxPolicy,
    is_effectful_write: bool,
    pre_authorized: bool,
) -> SafetyDecision {
    // Autonomous (`Never`) runs never stop to ask, whatever the write is.
    if approval == AskForApproval::Never {
        return SafetyDecision::AutoApprove {
            sandbox: sandbox_kind_for(sandbox),
        };
    }
    // An effectful write that isn't already trusted for this turn → surface a card.
    if is_effectful_write && !pre_authorized {
        return SafetyDecision::AskUser;
    }
    // Reads, and pre-authorized writes, auto-approve under the current fence.
    SafetyDecision::AutoApprove {
        sandbox: sandbox_kind_for(sandbox),
    }
}

/// Map a SandboxPolicy to the OS fence kind for THIS platform.
///
/// For now: `DangerFullAccess` -> `None` (no enforcement). `ReadOnly` /
/// `WorkspaceWrite` return the platform fence (Macos on macOS, Linux on Linux) —
/// but enforcement itself is a LATER step; this only NAMES the intended fence.
/// Windows (and any other target) stays `None`: approval-only for now.
pub fn sandbox_kind_for(sandbox: &SandboxPolicy) -> SandboxKind {
    match sandbox {
        SandboxPolicy::DangerFullAccess => SandboxKind::None,
        SandboxPolicy::ReadOnly | SandboxPolicy::WorkspaceWrite { .. } => {
            if cfg!(target_os = "macos") {
                SandboxKind::MacosSeatbelt
            } else if cfg!(target_os = "linux") {
                SandboxKind::LinuxSeccomp
            } else {
                SandboxKind::None
            }
        }
    }
}

// ============================================================================
// Sandbox axis (ADR 0023, step 2b): the classification vocabulary.
//
// PURE-ADDITION / SHADOW phase. These functions say (a) what a tool call does to
// the filesystem/exec surface (its `ToolFootprint`) and (b) what a sandbox fence
// WOULD decide about it (a `ShadowVerdict`) — with NO enforcement. Nothing here is
// wired into the loop yet; wiring + real path resolution come in a later task.
// This mirrors how Codex decides whether a command needs write access, except
// Homun's builtins are structured (explicit `path` args) so we match on names
// instead of parsing a shell command.
// ============================================================================

/// What a chat tool call does to the filesystem / exec surface — the input to the
/// sandbox axis. Homun's builtins are structured (explicit `path` args), so this
/// is a direct match, not a shell-command parse (Codex has to parse; we don't).
#[derive(Debug, Clone, PartialEq)]
pub enum ToolFootprint {
    /// Reads a path only; safe under every sandbox level.
    ReadOnly,
    /// Writes to a filesystem path. `path` is the raw arg as received (may be
    /// relative or absolute — resolution happens at the wiring site, not here).
    Write { path: String },
    /// Runs an arbitrary command in the project dir (run_in_project).
    Exec,
    /// Runs inside the existing container sandbox (run_in_sandbox) — already fenced.
    Contained,
    /// Not a filesystem/exec tool (mcp/composio/browser/memory/artifact/plan/…).
    NonFilesystem,
}

/// Classify a chat tool by name + JSON args into its filesystem footprint.
/// Only the core file/shell builtins get a specific footprint; everything else is
/// `NonFilesystem`.
///
/// NOTE: artifact/deck tools (create_artifact, deck builders, …) also write, but to
/// *controlled* locations, so fencing them needs their own writable-root story — a
/// later refinement. For now they fall through to `NonFilesystem`.
pub fn tool_footprint(name: &str, args: &serde_json::Value) -> ToolFootprint {
    match name {
        "read_file" | "read_text_file" | "list_files" | "list_directory" => ToolFootprint::ReadOnly,
        "write_file" | "edit_file" => ToolFootprint::Write {
            path: args
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string(),
        },
        // apply_patch writes too, but touches N paths internally (parsed from the
        // patch body, not a single `path` arg). We classify it as a Write with a
        // synthetic placeholder path so shadow-log / read-only detection treat it
        // like any other write; the concrete per-file jailing happens at the wiring
        // site (apply_patch_under_root), which routes every touched path through
        // jail_in_root.
        "apply_patch" => ToolFootprint::Write {
            path: "<apply_patch>".to_string(),
        },
        "run_in_project" => ToolFootprint::Exec,
        "run_in_sandbox" => ToolFootprint::Contained,
        _ => ToolFootprint::NonFilesystem,
    }
}

/// What a sandbox fence WOULD decide for a footprint — computed in SHADOW so we can
/// log it before any enforcement exists. Never blocks anything itself.
#[derive(Debug, Clone, PartialEq)]
pub enum ShadowVerdict {
    /// The fence would allow this.
    Allow,
    /// The fence WOULD block/redirect this; `reason` explains why (for the shadow log).
    WouldFence { reason: String },
}

/// Evaluate a footprint against a sandbox policy — PURE, SHADOW (no side effect, no
/// IO). Path resolution is NOT done here: the caller precomputes
/// `is_under_writable_root` (whether the Write target resolves under one of the
/// policy's writable roots) and passes it in, keeping this function pure and total.
///
/// Truth table:
/// - `DangerFullAccess` → always Allow (no fence).
/// - `ReadOnly` / `Contained` / `NonFilesystem` footprint → always Allow (any policy).
/// - `Write` under `SandboxPolicy::ReadOnly` → WouldFence.
/// - `Write` under `SandboxPolicy::WorkspaceWrite` → Allow iff `is_under_writable_root`.
/// - `Exec` under `SandboxPolicy::ReadOnly` → WouldFence.
/// - `Exec` under `SandboxPolicy::WorkspaceWrite` → Allow (the command runs; the OS
///   fence in a later step confines ITS writes — the shadow level doesn't fence the
///   exec itself).
pub fn sandbox_shadow_verdict(
    footprint: &ToolFootprint,
    policy: &SandboxPolicy,
    is_under_writable_root: bool,
) -> ShadowVerdict {
    // DangerFullAccess removes the fence entirely, whatever the footprint.
    if let SandboxPolicy::DangerFullAccess = policy {
        return ShadowVerdict::Allow;
    }
    match footprint {
        // Safe under every fenced policy — no write/exec surface to confine.
        ToolFootprint::ReadOnly | ToolFootprint::Contained | ToolFootprint::NonFilesystem => {
            ShadowVerdict::Allow
        }
        ToolFootprint::Write { path } => match policy {
            SandboxPolicy::ReadOnly => ShadowVerdict::WouldFence {
                reason: format!("write to {path} under read-only sandbox"),
            },
            SandboxPolicy::WorkspaceWrite { .. } => {
                if is_under_writable_root {
                    ShadowVerdict::Allow
                } else {
                    ShadowVerdict::WouldFence {
                        reason: format!("write to {path} outside workspace roots"),
                    }
                }
            }
            // DangerFullAccess already handled above.
            SandboxPolicy::DangerFullAccess => ShadowVerdict::Allow,
        },
        ToolFootprint::Exec => match policy {
            SandboxPolicy::ReadOnly => ShadowVerdict::WouldFence {
                reason: "exec under read-only sandbox".to_string(),
            },
            // The exec runs; the OS fence (later step) confines its writes.
            SandboxPolicy::WorkspaceWrite { .. } => ShadowVerdict::Allow,
            SandboxPolicy::DangerFullAccess => ShadowVerdict::Allow,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The platform fence `sandbox_kind_for` should name for a fenced policy on
    /// THIS build target — kept in one place so the test assertions read the same
    /// mapping the function does, without hard-coding a single OS.
    fn expected_fenced_kind() -> SandboxKind {
        if cfg!(target_os = "macos") {
            SandboxKind::MacosSeatbelt
        } else if cfg!(target_os = "linux") {
            SandboxKind::LinuxSeccomp
        } else {
            SandboxKind::None
        }
    }

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

    // ---- assess_tool_safety: the full truth table ------------------------------

    #[test]
    fn never_autoapproves_even_an_unauthorized_write() {
        // Autonomous run: the card is skipped whatever the write is.
        let decision = assess_tool_safety(
            AskForApproval::Never,
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from("/ws")],
                network_access: false,
            },
            /* is_effectful_write */ true,
            /* pre_authorized */ false,
        );
        assert_eq!(
            decision,
            SafetyDecision::AutoApprove {
                sandbox: expected_fenced_kind()
            }
        );
    }

    #[test]
    fn on_request_write_not_preauthorized_asks_user() {
        let decision = assess_tool_safety(
            AskForApproval::OnRequest,
            &SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![],
                network_access: false,
            },
            /* is_effectful_write */ true,
            /* pre_authorized */ false,
        );
        assert_eq!(decision, SafetyDecision::AskUser);
    }

    #[test]
    fn on_request_write_preauthorized_autoapproves() {
        // pre_authorized == today's workspace_scoped / composio_tool_allowed.
        let decision = assess_tool_safety(
            AskForApproval::OnRequest,
            &SandboxPolicy::ReadOnly,
            /* is_effectful_write */ true,
            /* pre_authorized */ true,
        );
        assert_eq!(
            decision,
            SafetyDecision::AutoApprove {
                sandbox: expected_fenced_kind()
            }
        );
    }

    #[test]
    fn on_request_non_write_read_tool_autoapproves() {
        let decision = assess_tool_safety(
            AskForApproval::OnRequest,
            &SandboxPolicy::ReadOnly,
            /* is_effectful_write */ false,
            /* pre_authorized */ false,
        );
        assert_eq!(
            decision,
            SafetyDecision::AutoApprove {
                sandbox: expected_fenced_kind()
            }
        );
    }

    // The remaining approval variants share the write/pre_authorized truth table
    // (only `Never` short-circuits). Spot-check that they behave like OnRequest.
    #[test]
    fn unless_trusted_and_on_failure_follow_the_write_table() {
        for approval in [AskForApproval::UnlessTrusted, AskForApproval::OnFailure] {
            let ask = assess_tool_safety(approval, &SandboxPolicy::ReadOnly, true, false);
            assert_eq!(ask, SafetyDecision::AskUser, "{approval:?} + unauth write → AskUser");

            let auto = assess_tool_safety(approval, &SandboxPolicy::ReadOnly, true, true);
            assert_eq!(
                auto,
                SafetyDecision::AutoApprove { sandbox: expected_fenced_kind() },
                "{approval:?} + pre-authorized write → AutoApprove"
            );
        }
    }

    // ---- sandbox_kind_for: fence naming ---------------------------------------

    #[test]
    fn danger_full_access_maps_to_no_fence() {
        assert_eq!(sandbox_kind_for(&SandboxPolicy::DangerFullAccess), SandboxKind::None);
    }

    #[test]
    fn autoapprove_sandbox_is_none_under_danger_full_access() {
        let decision = assess_tool_safety(
            AskForApproval::OnRequest,
            &SandboxPolicy::DangerFullAccess,
            false,
            false,
        );
        assert_eq!(decision, SafetyDecision::AutoApprove { sandbox: SandboxKind::None });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn workspace_write_and_read_only_map_to_seatbelt_on_macos() {
        assert_eq!(sandbox_kind_for(&SandboxPolicy::ReadOnly), SandboxKind::MacosSeatbelt);
        assert_eq!(
            sandbox_kind_for(&SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from("/ws")],
                network_access: true,
            }),
            SandboxKind::MacosSeatbelt
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn workspace_write_and_read_only_map_to_seccomp_on_linux() {
        assert_eq!(sandbox_kind_for(&SandboxPolicy::ReadOnly), SandboxKind::LinuxSeccomp);
        assert_eq!(
            sandbox_kind_for(&SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from("/ws")],
                network_access: true,
            }),
            SandboxKind::LinuxSeccomp
        );
    }

    // ---- SandboxPolicy construction / equality --------------------------------

    #[test]
    fn workspace_write_construction_and_equality() {
        let a = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/ws"), PathBuf::from("/tmp/scratch")],
            network_access: true,
        };
        let b = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/ws"), PathBuf::from("/tmp/scratch")],
            network_access: true,
        };
        assert_eq!(a, b);

        if let SandboxPolicy::WorkspaceWrite { writable_roots, network_access } = &a {
            assert_eq!(writable_roots.len(), 2);
            assert!(*network_access);
        } else {
            panic!("expected WorkspaceWrite");
        }
    }

    #[test]
    fn workspace_write_differs_on_network_and_roots() {
        let base = SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/ws")],
            network_access: false,
        };
        assert_ne!(
            base,
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from("/ws")],
                network_access: true,
            }
        );
        assert_ne!(
            base,
            SandboxPolicy::WorkspaceWrite {
                writable_roots: vec![PathBuf::from("/other")],
                network_access: false,
            }
        );
        assert_ne!(base, SandboxPolicy::ReadOnly);
        assert_ne!(SandboxPolicy::ReadOnly, SandboxPolicy::DangerFullAccess);
    }

    // ---- tool_footprint: name + args → filesystem footprint --------------------

    #[test]
    fn read_tools_are_read_only() {
        for name in ["read_file", "read_text_file", "list_files", "list_directory"] {
            assert_eq!(
                tool_footprint(name, &serde_json::json!({"path": "/x"})),
                ToolFootprint::ReadOnly,
                "{name} should be ReadOnly"
            );
        }
    }

    #[test]
    fn write_tools_capture_the_path_arg() {
        for name in ["write_file", "edit_file"] {
            assert_eq!(
                tool_footprint(name, &serde_json::json!({"path": "/x"})),
                ToolFootprint::Write { path: "/x".to_string() },
                "{name} should capture path"
            );
        }
    }

    #[test]
    fn apply_patch_is_a_write_with_synthetic_path() {
        // apply_patch has no single `path` arg (paths live in the patch body), so it
        // is classified as a Write with a synthetic placeholder so read-only detection
        // and shadow logging treat it as a write. Per-path jailing is done at wiring.
        assert_eq!(
            tool_footprint("apply_patch", &serde_json::json!({})),
            ToolFootprint::Write {
                path: "<apply_patch>".to_string()
            }
        );
    }

    #[test]
    fn write_tool_missing_path_arg_yields_empty_path() {
        // Missing / non-string path → empty string (resolution happens at the wiring site).
        assert_eq!(
            tool_footprint("write_file", &serde_json::json!({})),
            ToolFootprint::Write { path: String::new() }
        );
        assert_eq!(
            tool_footprint("edit_file", &serde_json::json!({"path": 42})),
            ToolFootprint::Write { path: String::new() }
        );
    }

    #[test]
    fn run_in_project_is_exec() {
        assert_eq!(
            tool_footprint("run_in_project", &serde_json::json!({"command": "ls"})),
            ToolFootprint::Exec
        );
    }

    #[test]
    fn run_in_sandbox_is_contained() {
        assert_eq!(
            tool_footprint("run_in_sandbox", &serde_json::json!({"command": "ls"})),
            ToolFootprint::Contained
        );
    }

    #[test]
    fn non_filesystem_tools_are_non_filesystem() {
        for name in [
            "browser_navigate",
            "recall_memory",
            "composio_execute",
            "create_artifact",
            "update_plan",
            "unknown_tool",
        ] {
            assert_eq!(
                tool_footprint(name, &serde_json::json!({})),
                ToolFootprint::NonFilesystem,
                "{name} should be NonFilesystem"
            );
        }
    }

    // ---- sandbox_shadow_verdict: the full shadow truth table -------------------

    fn ws_policy() -> SandboxPolicy {
        SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/ws")],
            network_access: false,
        }
    }

    #[test]
    fn danger_full_access_never_fences_any_footprint() {
        for fp in [
            ToolFootprint::ReadOnly,
            ToolFootprint::Write { path: "/anywhere".to_string() },
            ToolFootprint::Exec,
            ToolFootprint::Contained,
            ToolFootprint::NonFilesystem,
        ] {
            assert_eq!(
                sandbox_shadow_verdict(&fp, &SandboxPolicy::DangerFullAccess, false),
                ShadowVerdict::Allow,
                "DangerFullAccess should Allow {fp:?}"
            );
        }
    }

    #[test]
    fn safe_footprints_always_allow_regardless_of_policy() {
        // ReadOnly / Contained / NonFilesystem are safe under every policy.
        let policies = [
            SandboxPolicy::ReadOnly,
            ws_policy(),
            SandboxPolicy::DangerFullAccess,
        ];
        for policy in &policies {
            for fp in [
                ToolFootprint::ReadOnly,
                ToolFootprint::Contained,
                ToolFootprint::NonFilesystem,
            ] {
                assert_eq!(
                    sandbox_shadow_verdict(&fp, policy, false),
                    ShadowVerdict::Allow,
                    "{fp:?} under {policy:?} should Allow"
                );
            }
        }
    }

    #[test]
    fn write_under_read_only_policy_would_fence() {
        assert_eq!(
            sandbox_shadow_verdict(
                &ToolFootprint::Write { path: "/x".to_string() },
                &SandboxPolicy::ReadOnly,
                // is_under_writable_root is irrelevant under a read-only policy.
                true,
            ),
            ShadowVerdict::WouldFence {
                reason: "write to /x under read-only sandbox".to_string()
            }
        );
    }

    #[test]
    fn write_under_workspace_write_allows_only_inside_roots() {
        // Inside a writable root → Allow.
        assert_eq!(
            sandbox_shadow_verdict(
                &ToolFootprint::Write { path: "/ws/a".to_string() },
                &ws_policy(),
                /* is_under_writable_root */ true,
            ),
            ShadowVerdict::Allow
        );
        // Outside → WouldFence.
        assert_eq!(
            sandbox_shadow_verdict(
                &ToolFootprint::Write { path: "/etc/passwd".to_string() },
                &ws_policy(),
                /* is_under_writable_root */ false,
            ),
            ShadowVerdict::WouldFence {
                reason: "write to /etc/passwd outside workspace roots".to_string()
            }
        );
    }

    #[test]
    fn exec_under_read_only_policy_would_fence() {
        assert_eq!(
            sandbox_shadow_verdict(&ToolFootprint::Exec, &SandboxPolicy::ReadOnly, false),
            ShadowVerdict::WouldFence {
                reason: "exec under read-only sandbox".to_string()
            }
        );
    }

    #[test]
    fn exec_under_workspace_write_is_allowed_at_shadow_level() {
        // The command runs; the OS fence in a later step confines ITS writes — the
        // shadow verdict does not fence the exec itself.
        assert_eq!(
            sandbox_shadow_verdict(&ToolFootprint::Exec, &ws_policy(), false),
            ShadowVerdict::Allow
        );
    }
}
