//! `homun-linux-sandbox` — the Linux Landlock helper binary (ADR 0023).
//!
//! A tiny, standalone, single-threaded process. `run_in_project` (in `main.rs`)
//! spawns THIS binary, which applies the Landlock filesystem fence to *itself* and
//! then `exec`s the requested command, so the fenced program inherits the
//! restriction. Doing the fence in a fresh dedicated process avoids the classic
//! post-`fork` hazard of restricting a multi-threaded async runtime in place.
//!
//! CLI:
//! ```text
//! homun-linux-sandbox --allow-write <path> [--allow-write <path>...] -- <program> [args...]
//! ```
//! - Each `--allow-write <path>` adds a writable workspace root (writes are fenced
//!   to these; reads + exec stay allowed everywhere).
//! - Everything after the literal `--` is the command to run (program + args).
//!
//! Fail-closed: if the fence cannot be enforced (Landlock unavailable on the
//! kernel, or a ruleset error), the helper prints the error to stderr and exits
//! non-zero WITHOUT exec'ing — it never runs the command unfenced.
//!
//! Off Linux this compiles to a stub `main` that errors out, so the workspace still
//! builds on macOS/Windows (the real body is `#[cfg(target_os = "linux")]`). The
//! `landlock` crate is a Linux-only dependency, so nothing Landlock-related is even
//! referenced off Linux.
//!
//! Follow-up (out of scope here): the packaged Linux app must SHIP this binary next
//! to the gateway executable (electron-builder `package:prepare` copies it into the
//! resources dir). `run_in_project` resolves it via `HOMUN_LINUX_SANDBOX_BIN` or the
//! gateway's sibling directory; the CI integration test uses `CARGO_BIN_EXE_...` and
//! needs no bundling.

// On Linux, pull in the fence module by path (a `src/bin/` target is its own crate,
// so it can't reach `main.rs`'s `mod landlock_fence;` — we include the same file).
#[cfg(target_os = "linux")]
#[path = "../landlock_fence.rs"]
mod landlock_fence;

#[cfg(target_os = "linux")]
fn main() {
    use std::os::unix::process::CommandExt; // for Command::exec
    use std::path::PathBuf;
    use std::process::Command;

    let mut writable_roots: Vec<PathBuf> = Vec::new();
    let mut program_and_args: Vec<String> = Vec::new();

    // Parse: repeated `--allow-write <path>`, then a literal `--`, then the command.
    let mut args = std::env::args().skip(1);
    let mut saw_separator = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--allow-write" => {
                let Some(path) = args.next() else {
                    eprintln!("homun-linux-sandbox: --allow-write requires a path argument");
                    std::process::exit(2);
                };
                writable_roots.push(PathBuf::from(path));
            }
            "--" => {
                saw_separator = true;
                // Everything after `--` is the command to run.
                program_and_args.extend(args.by_ref());
                break;
            }
            other => {
                eprintln!(
                    "homun-linux-sandbox: unexpected argument {other:?} (expected --allow-write or --)"
                );
                std::process::exit(2);
            }
        }
    }

    if !saw_separator || program_and_args.is_empty() {
        eprintln!(
            "usage: homun-linux-sandbox --allow-write <path> [--allow-write <path>...] -- <program> [args...]"
        );
        std::process::exit(2);
    }

    // Apply the Landlock fence to THIS process. Fail closed on any error — do NOT
    // exec the command unfenced.
    if let Err(error) = landlock_fence::apply_landlock_workspace_write(&writable_roots) {
        eprintln!("homun-linux-sandbox: could not enforce the workspace fence: {error}");
        std::process::exit(3);
    }

    // Fence is in force. Replace this process with the requested command so it (and
    // any children) inherit the Landlock restriction. `exec` only returns on error.
    let (program, rest) = program_and_args.split_first().expect("non-empty (checked)");
    let error = Command::new(program).args(rest).exec();
    // If we reach here, exec failed (e.g. program not found). Surface it and exit.
    eprintln!("homun-linux-sandbox: failed to exec {program:?}: {error}");
    std::process::exit(127);
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("homun-linux-sandbox: Linux only (Landlock is a Linux kernel feature)");
    std::process::exit(1);
}
