//! macOS **Seatbelt** (`sandbox-exec`) profile GENERATOR from a `SandboxPolicy`.
//!
//! ADR 0023 (`docs/decisions/0023-sandbox-enforcement-and-unified-approval.md`),
//! step 3 — the **macOS enforcement** rung of the sandbox axis. This turns a
//! `SandboxPolicy` (from `crate::tool_safety`) into the TinyScheme S-expression
//! that a LATER task will hand to `sandbox-exec -p <profile>` to fence
//! `run_in_project`'s `bash` subprocess.
//!
//! **PURE-ADDITION phase.** This module is *pure string generation*: no
//! `sandbox-exec` invocation, no `std::fs`, no `Command`, no spawning, no wiring.
//! `seatbelt_profile` is a total function of its input (plus one deterministic
//! per-machine env read for the temp dir — see below), so it is identical to run
//! anywhere and fully unit-testable. Nothing here is called by the chat loop yet;
//! that is the wiring task.
//!
//! Mirrors `codex-rs/core/src/seatbelt.rs` (the Codex reference): a
//! **closed-by-default** profile that allows reads broadly and permits writes only
//! under the policy's writable roots (plus the system temp dir for scratch).
//!
//! ## Fidelity deviations from Codex (intentional, documented)
//! - **Roots are INLINED as string literals** — `(subpath "/abs/path")` — rather
//!   than passed as `-D NAME=...` params with `(subpath (param "NAME"))`. Codex
//!   uses `-D` params; inlining is simpler and makes the generated profile a pure
//!   function of the policy (unit-testable end to end). The wiring task can switch
//!   to `-D` params later if it prefers to keep paths out of the profile text.
//! - **`(allow sysctl-read)`** allows *all* sysctl reads, where Codex ships a long
//!   explicit sysctl-name allowlist. Allow-all is a faithful-enough base for the
//!   read surface (sysctl reads are informational); see the `// TODO` below — the
//!   exact Codex allowlist can be pasted in later for tighter fidelity.
#![allow(dead_code)] // nothing is wired into the loop yet — pure generator phase.

use crate::tool_safety::SandboxPolicy;

/// Generate a macOS Seatbelt (`sandbox-exec`) profile string for a sandbox policy.
///
/// Returns `None` for [`SandboxPolicy::DangerFullAccess`] (no fence → the caller
/// runs the subprocess unsandboxed). For [`SandboxPolicy::ReadOnly`] and
/// [`SandboxPolicy::WorkspaceWrite`] returns `Some(profile)`.
///
/// Mirrors `codex-rs/core/src/seatbelt.rs`: closed-by-default (`deny default`),
/// reads allowed broadly (`allow file-read*`), writes allowed ONLY under the
/// policy's writable roots plus the system temp dir. Everything not explicitly
/// allowed stays denied by the leading `(deny default)` — including the network,
/// which is why no `(deny network*)` directive is needed: it is already blocked
/// unless we add an `(allow network*)`.
///
/// Behavior by policy:
/// - `DangerFullAccess` → `None`.
/// - `ReadOnly` → base profile; `file-write*` is allowed **only** for the temp dir
///   (scratch writes work, but the project tree and the rest of the filesystem are
///   read-only). No project-root write subpaths.
/// - `WorkspaceWrite { writable_roots, network_access }` → base profile plus a
///   `(subpath "<root>")` for each writable root **and** the temp dir under
///   `file-write*`. If `network_access` is `true`, an `(allow network*)` is added;
///   if `false`, nothing network-related is emitted (default-deny already blocks
///   it).
pub fn seatbelt_profile(policy: &SandboxPolicy) -> Option<String> {
    match policy {
        // No fence: caller runs unsandboxed.
        SandboxPolicy::DangerFullAccess => None,
        // Read-only: only the temp dir is writable (for scratch); no project roots.
        SandboxPolicy::ReadOnly => Some(build_profile(&[], /* allow_network */ false)),
        // Workspace-write: the writable roots (+ temp dir) are writable.
        SandboxPolicy::WorkspaceWrite {
            writable_roots,
            network_access,
        } => {
            let roots: Vec<String> = writable_roots
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            Some(build_profile(&roots, *network_access))
        }
    }
}

/// Assemble the profile text: the fixed closed-by-default base, then the
/// `file-write*` allow covering `writable_roots` + the system temp dir, then an
/// optional `(allow network*)`.
///
/// `writable_roots` are the project roots to make writable (empty for read-only);
/// the temp dir is ALWAYS added so scratch writes work under every fenced policy.
fn build_profile(writable_roots: &[String], allow_network: bool) -> String {
    // The one allowed env read: whitelist the machine's temp dir so scratch writes
    // (e.g. `$TMPDIR/...`) succeed under the fence. `std::env::temp_dir()` reads
    // `TMPDIR` (falling back to `/tmp`); this makes the profile deterministic per
    // machine, which is exactly right for a per-machine profile generator.
    let tmp = std::env::temp_dir();
    let tmp = tmp.to_string_lossy();

    let mut out = String::new();
    out.push_str(BASE_PROFILE);

    // WRITES: only under the writable roots (+ tmp). Everything else stays denied
    // by the `(deny default)` in the base above.
    out.push_str("\n; WRITES: only under the writable roots (+ tmp); everything else stays\n");
    out.push_str("; denied by the (deny default) above.\n");
    out.push_str("(allow file-write*\n");
    for root in writable_roots {
        out.push_str("  (subpath \"");
        out.push_str(&escape_sb_path(root));
        out.push_str("\")\n");
    }
    out.push_str("  (subpath \"");
    out.push_str(&escape_sb_path(&tmp));
    out.push_str("\"))\n");

    // NETWORK: default-deny already blocks it; only emit an allow when requested.
    if allow_network {
        out.push_str("\n; network explicitly allowed for this policy\n");
        out.push_str("(allow network*)\n");
    }

    out
}

/// The fixed, closed-by-default base of the Seatbelt profile — identical for every
/// fenced policy. Mirrors the Codex base: `deny default`, broad reads, child
/// processes inherit the sandbox, a set of harmless sysctl reads, and `/dev/null`
/// writes. The per-policy `file-write*` / `network*` allows are appended by
/// `build_profile`.
const BASE_PROFILE: &str = r#"(version 1)

; closed by default
(deny default)

; reads allowed broadly (Codex allows file-read* globally)
(allow file-read*)

; child processes inherit the sandbox
(allow process-exec)
(allow process-fork)
(allow signal (target self))

; a set of harmless sysctl reads programs expect.
; TODO: paste the exact Codex sysctl-name allowlist here for tighter fidelity;
; (allow sysctl-read) allows ALL sysctl reads, which is a faithful-enough base.
(allow sysctl-read)

; writes to the essential null device
(allow file-write-data
  (require-all (path "/dev/null")))
"#;

/// Escape a path for safe inlining as a `"..."` string literal inside the Seatbelt
/// S-expression. Backslashes are doubled and double-quotes are backslash-escaped
/// (TinyScheme string-literal rules). Absolute paths rarely contain either, but we
/// escape defensively. Backslash MUST be replaced first so the quote-escape's own
/// backslashes are not double-escaped.
fn escape_sb_path(p: &str) -> String {
    p.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// The temp-dir subpath line the generator always appends under `file-write*`,
    /// computed the same way the function does so the assertions don't hard-code a
    /// single machine's `$TMPDIR`.
    fn tmp_subpath_line() -> String {
        let tmp = std::env::temp_dir();
        format!("(subpath \"{}\")", escape_sb_path(&tmp.to_string_lossy()))
    }

    // ---- DangerFullAccess: no fence -------------------------------------------

    #[test]
    fn danger_full_access_has_no_profile() {
        assert_eq!(seatbelt_profile(&SandboxPolicy::DangerFullAccess), None);
    }

    // ---- ReadOnly: base + tmp-only writes -------------------------------------

    #[test]
    fn read_only_profile_has_base_and_reads_but_no_project_writes() {
        let profile = seatbelt_profile(&SandboxPolicy::ReadOnly).expect("ReadOnly → Some");

        // Base shape.
        assert!(profile.contains("(version 1)"), "missing version");
        assert!(profile.contains("(deny default)"), "missing deny default");
        assert!(profile.contains("(allow file-read*)"), "missing file-read*");
        assert!(profile.contains("(allow process-exec)"), "missing process-exec");
        assert!(profile.contains("(allow process-fork)"), "missing process-fork");
        assert!(profile.contains("(allow signal (target self))"), "missing signal self");
        assert!(profile.contains("(allow sysctl-read)"), "missing sysctl-read");

        // Writes are allowed only for the temp dir — the file-write* block exists
        // and contains the tmp subpath, but NO project-root subpath.
        assert!(profile.contains("(allow file-write*"), "missing file-write* block");
        assert!(
            profile.contains(&tmp_subpath_line()),
            "read-only must still allow scratch writes to the temp dir"
        );

        // Read-only means no network allow either.
        assert!(!profile.contains("(allow network*)"), "read-only must not allow network");
    }

    #[test]
    fn read_only_profile_has_no_project_root_subpath() {
        // The ONLY subpath under file-write* is the temp dir. Any other project
        // path (a typical macOS home dir) must be absent.
        let profile = seatbelt_profile(&SandboxPolicy::ReadOnly).unwrap();
        assert!(
            !profile.contains("(subpath \"/Users/"),
            "read-only profile leaked a project-root write subpath:\n{profile}"
        );
    }

    // ---- WorkspaceWrite: base + root writes -----------------------------------

    #[test]
    fn workspace_write_no_network_allows_the_root_and_tmp_but_not_network() {
        let profile = seatbelt_profile(&SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/Users/x/proj")],
            network_access: false,
        })
        .expect("WorkspaceWrite → Some");

        assert!(profile.contains("(allow file-write*"), "missing file-write* block");
        assert!(
            profile.contains("(subpath \"/Users/x/proj\")"),
            "missing the writable-root subpath:\n{profile}"
        );
        assert!(
            profile.contains(&tmp_subpath_line()),
            "workspace-write must also allow the temp dir"
        );
        assert!(
            !profile.contains("(allow network*)"),
            "network_access=false must not emit an allow"
        );
    }

    #[test]
    fn workspace_write_with_network_allows_network() {
        let profile = seatbelt_profile(&SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from("/Users/x/proj")],
            network_access: true,
        })
        .unwrap();
        assert!(
            profile.contains("(allow network*)"),
            "network_access=true must emit (allow network*):\n{profile}"
        );
    }

    #[test]
    fn multiple_writable_roots_each_get_their_own_subpath() {
        let profile = seatbelt_profile(&SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![
                PathBuf::from("/Users/x/proj"),
                PathBuf::from("/Users/x/other"),
            ],
            network_access: false,
        })
        .unwrap();
        assert!(profile.contains("(subpath \"/Users/x/proj\")"), "first root missing");
        assert!(profile.contains("(subpath \"/Users/x/other\")"), "second root missing");
    }

    // ---- escape_sb_path -------------------------------------------------------

    #[test]
    fn escape_sb_path_escapes_quotes_and_backslashes() {
        // A quote becomes \" and a backslash becomes \\ .
        assert_eq!(escape_sb_path(r#"/a/b"c"#), r#"/a/b\"c"#);
        assert_eq!(escape_sb_path(r"/a\b"), r"/a\\b");
        // Combined: backslash-then-quote is escaped without double-escaping.
        assert_eq!(escape_sb_path(r#"/a\"b"#), r#"/a\\\"b"#);
        // A plain path is unchanged.
        assert_eq!(escape_sb_path("/Users/x/proj"), "/Users/x/proj");
    }

    #[test]
    fn quoted_root_is_escaped_in_the_generated_profile() {
        // A pathological root containing a quote must be inlined escaped so the
        // S-expression stays well-formed.
        let profile = seatbelt_profile(&SandboxPolicy::WorkspaceWrite {
            writable_roots: vec![PathBuf::from(r#"/weird/"quote"#)],
            network_access: false,
        })
        .unwrap();
        assert!(
            profile.contains(r#"(subpath "/weird/\"quote")"#),
            "quote in a root path was not escaped:\n{profile}"
        );
    }
}
