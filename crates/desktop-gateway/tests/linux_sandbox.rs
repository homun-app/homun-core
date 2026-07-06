//! CI validation for the Linux Landlock fence (ADR 0023). Runs in the ubuntu
//! backend-test job; the whole file is Linux-only, so it's cfg'd out on macOS.
//!
//! Locates the `homun-linux-sandbox` helper via `CARGO_BIN_EXE_homun-linux-sandbox`
//! (Cargo sets this for integration tests), runs commands through it, and asserts the
//! filesystem fence actually holds: a write INSIDE the allowed root succeeds; a write
//! OUTSIDE it (into `$HOME`) is denied.
//!
//! GitHub `ubuntu-*` runners generally provide Landlock, so the real assertions run.
//! If the kernel lacks Landlock, the helper fails closed with "landlock unavailable";
//! the tests detect that and SKIP explicitly (printing a notice) rather than reporting
//! a false pass — we can't validate a fence the kernel doesn't provide, but we must
//! not claim it works either.
#![cfg(target_os = "linux")]

use std::path::Path;
use std::process::Command;

/// Path to the built helper binary, injected by Cargo for integration tests.
const HELPER: &str = env!("CARGO_BIN_EXE_homun-linux-sandbox");

/// stderr signature the helper prints (exit code 3) when the kernel provides no
/// Landlock at all — see `apply_landlock_workspace_write` / `main` in the helper.
const LANDLOCK_UNAVAILABLE: &str = "landlock unavailable";

/// Run the helper with one writable root and a `bash -lc` script; return
/// (exit_code, combined stdout+stderr).
fn run_helper(allow_write: &Path, script: &str) -> (Option<i32>, String) {
    let output = Command::new(HELPER)
        .arg("--allow-write")
        .arg(allow_write)
        .arg("--")
        .arg("bash")
        .arg("-lc")
        .arg(script)
        .output()
        .expect("failed to spawn homun-linux-sandbox helper");
    let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.code(), combined)
}

/// True if this run couldn't enforce Landlock (kernel too old / feature off). The
/// helper fails closed and prints the "landlock unavailable" signature.
fn fence_unavailable(exit: Option<i32>, out: &str) -> bool {
    exit == Some(3) && out.contains(LANDLOCK_UNAVAILABLE)
}

#[test]
fn write_inside_root_succeeds_and_outside_is_denied() {
    let workspace = std::env::temp_dir().join(format!("homun-landlock-test-{}", std::process::id()));
    std::fs::create_dir_all(&workspace).expect("create workspace temp dir");

    let ok_file = workspace.join("ok.txt");
    let evil_file = format!(
        "{}/.homun-landlock-test-EVIL",
        std::env::var("HOME").unwrap_or_else(|_| "/root".to_string())
    );
    // Best-effort: make sure no stale EVIL file from a prior run confuses the assert.
    let _ = std::fs::remove_file(&evil_file);

    // In-workspace write must succeed; out-of-workspace write into $HOME must fail.
    // `|| true` keeps the script's overall exit at 0 so we assert on file existence,
    // not on the shell's exit code.
    let script = format!(
        "echo hi; echo data > {ok:?}; echo evil > {evil:?} 2>&1 || true",
        ok = ok_file,
        evil = evil_file,
    );
    let (exit, out) = run_helper(&workspace, &script);

    if fence_unavailable(exit, &out) {
        eprintln!(
            "SKIP write_inside_root_succeeds_and_outside_is_denied: Landlock unavailable on this \
             kernel (helper failed closed). Fence could not be validated here."
        );
        let _ = std::fs::remove_dir_all(&workspace);
        return;
    }

    // The in-workspace write succeeded.
    assert!(
        ok_file.exists(),
        "in-workspace write should succeed under the fence; helper output:\n{out}"
    );
    let ok_contents = std::fs::read_to_string(&ok_file).unwrap_or_default();
    assert!(ok_contents.contains("data"), "ok.txt should contain the written data");

    // The out-of-workspace write was denied: the EVIL file must NOT exist, and the
    // command output should carry a permission error (Landlock surfaces EACCES /
    // "Operation not permitted"; the shell renders it as "Permission denied").
    assert!(
        !Path::new(&evil_file).exists(),
        "out-of-workspace write to $HOME should be denied by the fence, but the file exists"
    );
    let denied = out.contains("Permission denied")
        || out.contains("Operation not permitted")
        || out.contains("permission");
    assert!(
        denied,
        "expected a permission error for the out-of-workspace write; helper output:\n{out}"
    );

    // Cleanup (both files; EVIL should not exist but remove defensively).
    let _ = std::fs::remove_file(&evil_file);
    let _ = std::fs::remove_dir_all(&workspace);
}

#[test]
fn normal_command_runs_and_exits_zero_under_the_fence() {
    let workspace = std::env::temp_dir().join(format!(
        "homun-landlock-test-basic-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&workspace).expect("create workspace temp dir");

    let (exit, out) = run_helper(&workspace, "echo ok");

    if fence_unavailable(exit, &out) {
        eprintln!(
            "SKIP normal_command_runs_and_exits_zero_under_the_fence: Landlock unavailable on this \
             kernel (helper failed closed)."
        );
        let _ = std::fs::remove_dir_all(&workspace);
        return;
    }

    assert_eq!(exit, Some(0), "a plain command should exit 0 under the fence; output:\n{out}");
    assert!(out.contains("ok"), "expected the command's output; got:\n{out}");

    let _ = std::fs::remove_dir_all(&workspace);
}
