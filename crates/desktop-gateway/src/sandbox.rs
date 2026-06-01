//! Skill execution sandbox — reuses the SAME contained-computer Docker container
//! as the browser (`lfpa-cc`), which now ships a shell + curl/python/git/jq.
//!
//! Lifecycle: ensure the Docker daemon is up (auto-start Docker Desktop on macOS),
//! ensure the container is running (via `up.sh`), then run skill commands in it
//! with `docker exec`. The container is loopback-only and runs as a non-root
//! `agent` user, so it doubles as an isolated sandbox for SKILL.md scripts.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// The contained-computer container name (matches the browser's).
pub const CONTAINER: &str = "lfpa-cc";
/// Where skills are copied inside the container.
const CONTAINER_SKILLS_DIR: &str = "/home/agent/skills";
const TIMEOUT_SECS: u64 = 60;
const MAX_OUTPUT_CHARS: usize = 8000;

fn cli_ok(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn docker_running() -> bool {
    cli_ok("docker", &["info", "--format", "{{.ServerVersion}}"])
}

pub fn container_up() -> bool {
    Command::new("docker")
        .args(["ps", "--filter", &format!("name={CONTAINER}"), "--format", "{{.Names}}"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(CONTAINER))
        .unwrap_or(false)
}

/// Ensures the Docker daemon is reachable, starting Docker Desktop on macOS and
/// polling up to ~60s. Returns a human-actionable error otherwise.
pub fn ensure_docker() -> Result<(), String> {
    if docker_running() {
        return Ok(());
    }
    if !cli_ok("docker", &["--version"]) {
        return Err("Docker non è installato. Installa Docker Desktop per eseguire le skill.".to_string());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").args(["-a", "Docker"]).status();
    }
    for _ in 0..60 {
        std::thread::sleep(Duration::from_secs(1));
        if docker_running() {
            return Ok(());
        }
    }
    Err("Docker è installato ma non si avvia. Avvia Docker Desktop e riprova.".to_string())
}

/// Locates `up.sh` for the contained computer (env override, else repo-relative).
fn up_script() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("LOCAL_FIRST_CONTAINED_COMPUTER_UP") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    for base in ["runtimes/contained-computer/up.sh", "../runtimes/contained-computer/up.sh"] {
        let path = PathBuf::from(base);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// Ensures the contained computer is running, bringing it up via `up.sh` if not.
pub fn ensure_contained_computer() -> Result<(), String> {
    ensure_docker()?;
    if container_up() {
        return Ok(());
    }
    if let Some(script) = up_script() {
        // up.sh builds the image (with the skill toolchain) and runs the container.
        let _ = Command::new("bash").arg(&script).output();
        for _ in 0..30 {
            if container_up() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    Err("Il computer contenuto (lfpa-cc) non è attivo e non sono riuscito ad avviarlo. \
Avvialo con runtimes/contained-computer/up.sh."
        .to_string())
}

/// Copies an installed skill's files into the container so its scripts are
/// runnable. Best-effort.
pub fn sync_skill(skill_dir: &Path, skill_id: &str) {
    let dest = format!("{CONTAINER_SKILLS_DIR}/{skill_id}");
    let _ = Command::new("docker").args(["exec", CONTAINER, "mkdir", "-p", &dest]).output();
    let _ = Command::new("docker")
        .args(["cp", &format!("{}/.", skill_dir.display()), &format!("{CONTAINER}:{dest}")])
        .output();
}

/// Runs a shell command inside the contained computer, returning combined
/// stdout+stderr (capped). `skill_id`, if given, sets the working directory.
/// The command runs as the non-root `agent` user in the isolated container; a
/// `timeout` guards against hangs. Shell features (pipes) are intentional —
/// SKILL.md instructions like `curl … | jq` need them.
pub fn run_command(command: &str, skill_id: Option<&str>) -> Result<String, String> {
    ensure_contained_computer()?;
    let workdir = skill_id
        .map(|id| format!("{CONTAINER_SKILLS_DIR}/{id}"))
        .unwrap_or_else(|| "/home/agent".to_string());
    let output = Command::new("docker")
        .args([
            "exec",
            "-w",
            &workdir,
            CONTAINER,
            "timeout",
            &TIMEOUT_SECS.to_string(),
            "bash",
            "-lc",
            command,
        ])
        .output()
        .map_err(|e| format!("docker non avviato: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        combined.push_str("\n[stderr] ");
        combined.push_str(&stderr);
    }
    Ok(combined.chars().take(MAX_OUTPUT_CHARS).collect())
}
