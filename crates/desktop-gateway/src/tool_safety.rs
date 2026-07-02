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
}
