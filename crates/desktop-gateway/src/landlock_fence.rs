//! Linux **Landlock** filesystem fence — the Linux enforcement rung of ADR 0023
//! (`docs/decisions/0023-sandbox-enforcement-and-unified-approval.md`), mirroring
//! the macOS Seatbelt `workspace-write` profile (`crate::seatbelt`).
//!
//! Landlock (Linux LSM, kernel ≥ 5.13) lets an **unprivileged** process drop its
//! own filesystem rights. We use it exactly like the macOS `workspace-write`
//! profile: **reads and exec stay allowed everywhere**, **writes are denied except
//! under the workspace roots** (project + tool caches).
//!
//! The whole file is Linux-only (`#![cfg(target_os = "linux")]` in `main.rs`'s
//! `mod` line), so it never compiles on macOS/Windows — the `landlock` crate is a
//! `cfg(target_os = "linux")` dependency and is absent off Linux.
//!
//! ## Why "handle only the write family"
//! Landlock's model: an access right that is **handled** by the ruleset is *denied*
//! everywhere except where a `PathBeneath` rule re-allows it; an access right that
//! is **not handled** stays *allowed* everywhere. So by handling ONLY
//! `AccessFs::from_write(abi)` (create/write/remove/…), and re-allowing it under
//! the workspace roots, we get: writes fenced to the roots, reads + exec free —
//! the exact shape of the Seatbelt `(allow file-read*)` + scoped `(allow
//! file-write*)` profile.
//!
//! ## Best-effort compatibility
//! `Ruleset::default()` uses `CompatLevel::BestEffort`, so on a kernel with an older
//! Landlock ABI the newer write bits are silently dropped rather than hard-erroring
//! — the fence degrades instead of failing. We still **fail closed** if the kernel
//! provides *no* Landlock at all (`RulesetStatus::NotEnforced`): the caller (the
//! helper binary) must refuse to exec unfenced.
//!
//! This process (and every child it later forks/execs) inherits the restriction,
//! which is why the helper binary can `exec` the fenced command right after calling
//! this.
//!
// TODO(ADR 0023): seccomp network-off — v1 is the FILESYSTEM fence only, at parity
// with the macOS v1 (which likewise allows network). A later rung adds a seccomp
// filter to drop network syscalls when the policy's `network_access` is false.
#![cfg(target_os = "linux")]

use std::path::PathBuf;

use landlock::{
    ABI, Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr,
    RulesetStatus,
};

/// Apply a Landlock workspace-write fence to the CURRENT process (and its future
/// children): WRITES are allowed only under `writable_roots`; READS and EXEC stay
/// allowed everywhere. Mirrors the macOS Seatbelt `workspace-write` profile.
///
/// Best-effort ABI compatibility (older kernels degrade instead of hard-erroring);
/// returns `Err` if a fence could NOT be enforced at all (so the caller can fail
/// closed rather than run unfenced).
///
/// Semantics:
/// - Handles ONLY the write family (`AccessFs::from_write(ABI)`). Reads/exec are
///   NOT handled ⇒ allowed everywhere. Writes ARE handled ⇒ denied everywhere
///   except under a `PathBeneath` rule.
/// - One `PathBeneath::new(PathFd::new(root)?, AccessFs::from_write(ABI))` rule per
///   root that actually exists. A root whose `PathFd::new` fails (e.g. a
///   not-yet-created `~/.cargo`) is skipped rather than aborting the whole fence —
///   a missing dir has nothing to write to anyway.
/// - After `restrict_self()`, if Landlock is entirely unavailable on this kernel
///   (`RulesetStatus::NotEnforced`) we return `Err` so the helper fails closed.
///   `FullyEnforced` / `PartiallyEnforced` (best-effort on an older ABI) are both
///   acceptable — the fence is in force.
pub fn apply_landlock_workspace_write(writable_roots: &[PathBuf]) -> Result<(), String> {
    // Base ABI. V1 is the original Landlock filesystem ABI (kernel ≥ 5.13) and is
    // the write family we mirror from Seatbelt. `BestEffort` (the default compat
    // level of `Ruleset::default()`) means a newer kernel still enforces V1's write
    // bits and an older/unsupported kernel degrades to NotEnforced (caught below)
    // rather than erroring.
    let abi = ABI::V1;
    let write_access = AccessFs::from_write(abi);

    // Handle only the write family, then create the ruleset. `?` here surfaces a
    // ruleset-construction failure as an error string (fail closed).
    let mut ruleset = Ruleset::default()
        .handle_access(write_access)
        .map_err(|e| format!("landlock: handle_access failed: {e}"))?
        .create()
        .map_err(|e| format!("landlock: create failed: {e}"))?;

    // Re-allow writes under each existing workspace root. Skip roots we can't open
    // (nonexistent), so a missing cache dir doesn't sink the whole fence.
    for root in writable_roots {
        match PathFd::new(root) {
            Ok(fd) => {
                ruleset = ruleset
                    .add_rule(PathBeneath::new(fd, write_access))
                    .map_err(|e| {
                        format!("landlock: add_rule for {} failed: {e}", root.display())
                    })?;
            }
            // Nonexistent / unopenable root: nothing to fence there. The macOS
            // profile likewise falls back gracefully for non-existent roots.
            Err(_) => continue,
        }
    }

    let status = ruleset
        .restrict_self()
        .map_err(|e| format!("landlock: restrict_self failed: {e}"))?;

    match status.ruleset {
        // Fence is in force (fully, or best-effort on an older ABI). Good.
        RulesetStatus::FullyEnforced | RulesetStatus::PartiallyEnforced => Ok(()),
        // Kernel provides no Landlock at all → we could NOT fence. Fail closed so
        // the caller refuses to run the command unfenced.
        RulesetStatus::NotEnforced => Err("landlock unavailable".to_string()),
    }
}
