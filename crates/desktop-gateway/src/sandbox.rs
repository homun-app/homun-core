//! Skill execution sandbox — reuses the SAME contained-computer Docker container
//! as the browser (`homun-cc`), which now ships a shell + curl/python/git/jq.
//!
//! Lifecycle: ensure the Docker daemon is up (auto-starting the platform's Docker
//! engine — Docker Desktop / Colima on macOS, Docker Desktop on Windows, the
//! systemd service or Docker Desktop on Linux), ensure the container is running
//! (through native Docker CLI calls), then run skill commands in it with
//! `docker exec`. The container is loopback-only and runs as a non-root `agent`
//! user, so it doubles as an isolated sandbox for SKILL.md scripts.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The contained-computer container name (matches the browser's).
pub const CONTAINER: &str = "homun-cc";
const CONTAINED_IMAGE: &str = "homun-contained-computer";
const CONTAINED_BASE_IMAGE: &str = "debian:trixie-slim";
/// Where skills are copied inside the container.
const CONTAINER_SKILLS_DIR: &str = "/home/agent/skills";

/// Host directory holding generated artifacts (bind-mounted into the container
/// at `/home/agent/output`). Overridable via `HOMUN_ARTIFACTS_DIR`.
pub fn artifacts_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HOMUN_ARTIFACTS_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    host_home_dir().join(".homun").join("artifacts")
}

/// Host directory holding the contained computer's browser profile (bind-mounted at
/// `/data/profile`). Persisting it across container recycles keeps cookies/logins, so
/// the browser looks like a returning user and hits far fewer captchas. Overridable
/// via `HOMUN_CC_PROFILE_DIR`.
pub fn cc_profile_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("HOMUN_CC_PROFILE_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    host_home_dir().join(".homun").join("cc-profile")
}

fn host_home_dir_from(home: Option<&str>, user_profile: Option<&str>, fallback: &Path) -> PathBuf {
    home.or(user_profile)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| fallback.to_path_buf())
}

fn host_home_dir() -> PathBuf {
    let home = std::env::var("HOME").ok();
    let user_profile = std::env::var("USERPROFILE").ok();
    host_home_dir_from(
        home.as_deref(),
        user_profile.as_deref(),
        &std::env::temp_dir(),
    )
}

/// The per-conversation output directory INSIDE the container.
pub fn container_output_dir(thread: &str) -> String {
    format!("/home/agent/output/{thread}")
}

/// Base URL of the on-device Whisper STT server (published from the contained
/// computer). Overridable via `HOMUN_WHISPER_URL` for tests/alternate setups.
pub fn whisper_base_url() -> String {
    std::env::var("HOMUN_WHISPER_URL").unwrap_or_else(|_| "http://127.0.0.1:9100".to_string())
}

/// Absolute path of a skill's directory INSIDE the container. Used both to set
/// the working dir and to substitute the skill's `{baseDir}` template variable so
/// its scripts resolve (e.g. `python3 {baseDir}/scripts/x.py`).
pub fn container_skill_dir(skill_id: &str) -> String {
    format!("{CONTAINER_SKILLS_DIR}/{skill_id}")
}
const TIMEOUT_SECS: u64 = 60;
const MAX_OUTPUT_CHARS: usize = 8000;

fn cli_ok(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Absolute paths where the Docker CLI commonly lives. This is evaluated on
/// every probe so a runtime installed while Homun is open becomes visible
/// without refreshing the process PATH.
fn docker_candidate_paths(
    platform: &str,
    program_files: Option<&str>,
    home: Option<&str>,
    explicit: Option<&str>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        paths.push(PathBuf::from(value));
    }
    match platform {
        "windows" => {
            if let Some(root) = program_files
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                paths.push(PathBuf::from(format!(
                    r"{}\Docker\Docker\resources\bin\docker.exe",
                    root.trim_end_matches(['\\', '/'])
                )));
            }
            paths.push(PathBuf::from(
                r"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
            ));
        }
        "macos" => {
            if let Some(root) = home {
                paths.push(PathBuf::from(root).join(".docker/bin/docker"));
            }
            paths.extend([
                PathBuf::from("/usr/local/bin/docker"),
                PathBuf::from("/opt/homebrew/bin/docker"),
                PathBuf::from("/Applications/Docker.app/Contents/Resources/bin/docker"),
            ]);
        }
        "linux" => {
            if let Some(root) = home {
                paths.push(PathBuf::from(root).join(".docker/bin/docker"));
            }
            paths.extend([
                PathBuf::from("/usr/bin/docker"),
                PathBuf::from("/usr/local/bin/docker"),
            ]);
        }
        _ => {}
    }
    paths.dedup();
    paths
}

/// Resolves the `docker` executable, preferring an ABSOLUTE path so invocations
/// succeed regardless of the inherited PATH. Honors `HOMUN_DOCKER_BIN`; falls back
/// to the bare name `"docker"` (PATH lookup) when no known location exists.
fn docker_bin() -> String {
    let explicit = std::env::var("HOMUN_DOCKER_BIN").ok();
    let program_files = std::env::var("ProgramFiles").ok();
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok());
    let candidates = docker_candidate_paths(
        std::env::consts::OS,
        program_files.as_deref(),
        home.as_deref(),
        explicit.as_deref(),
    );
    if let Some(explicit) = explicit.map(|value| value.trim().to_string())
        && !explicit.is_empty()
    {
        return explicit;
    }
    for candidate in candidates {
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "docker".to_string()
}

pub fn docker_running() -> bool {
    cli_ok(&docker_bin(), &["info", "--format", "{{.ServerVersion}}"])
}

pub fn container_up() -> bool {
    Command::new(docker_bin())
        .args([
            "ps",
            "--filter",
            &format!("name={CONTAINER}"),
            "--format",
            "{{.Names}}",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(CONTAINER))
        .unwrap_or(false)
}

/// Forcibly stops and removes the contained computer (`docker rm -f`). Since the
/// container runs with `--rm`, this reclaims its writable layer entirely; the
/// next `ensure_contained_computer()` re-creates it from the cached image — a
/// clean slate. Used by the idle reaper so accumulated scratch can't pile up.
pub fn recycle_container() -> bool {
    Command::new(docker_bin())
        .args(["rm", "-f", CONTAINER])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// How long to poll for the daemon after launching the engine. A cold start of
/// Docker Desktop / Colima can take well over a minute, so default to ~150s.
/// Overridable via `HOMUN_DOCKER_START_TIMEOUT_SECS`.
fn docker_start_timeout_secs() -> u64 {
    std::env::var("HOMUN_DOCKER_START_TIMEOUT_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(150)
}

/// Spawns a long-running starter (e.g. `colima start`) detached, swallowing its
/// stdio so it doesn't block us — the poll in `ensure_docker` detects readiness.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn launch_detached(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .is_ok()
}

/// Best-effort, OS-aware launch of a Docker engine. Returns a short diagnostic
/// label of WHAT we tried to start (for logs and error messages), or `None` if
/// no known mechanism applied on this platform.
///
/// Each platform knows several engine "flavors" and tries them in the order they
/// are most likely to be the one installed.
#[cfg(target_os = "macos")]
fn start_docker_engine() -> Option<String> {
    // 1) Docker Desktop. The app bundle is usually "Docker"; some installs name
    //    it "Docker Desktop". `open -a` resolves via LaunchServices regardless of
    //    install location and reports failure (non-zero) when the app is absent.
    for app in ["Docker", "Docker Desktop"] {
        let opened = Command::new("open")
            .args(["-a", app])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if opened {
            return Some(format!("Docker Desktop ({app})"));
        }
    }
    // 2) Colima — popular CLI alternative. `colima start` blocks until the VM is
    //    ready, so run it detached and let the poll detect readiness.
    if cli_ok("colima", &["version"]) && launch_detached("colima", &["start"]) {
        return Some("Colima".to_string());
    }
    None
}

#[cfg(target_os = "windows")]
fn start_docker_engine() -> Option<String> {
    // Docker Desktop's launcher; honor a custom %ProgramFiles% before the default.
    let mut candidates: Vec<String> = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        candidates.push(format!(r"{pf}\Docker\Docker\Docker Desktop.exe"));
    }
    candidates.push(r"C:\Program Files\Docker\Docker\Docker Desktop.exe".to_string());
    for exe in candidates {
        if Path::new(&exe).is_file() && Command::new(&exe).spawn().is_ok() {
            return Some("Docker Desktop".to_string());
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn start_docker_engine() -> Option<String> {
    // 1) Docker Desktop for Linux runs as a per-user systemd service.
    if cli_ok("systemctl", &["--user", "start", "docker-desktop"]) {
        return Some("Docker Desktop (user service)".to_string());
    }
    // 2) Native Docker Engine (system service). Usually already running; if not,
    //    starting it needs privileges and may fail without an interactive polkit
    //    agent — best effort.
    if cli_ok("systemctl", &["start", "docker"]) {
        return Some("Docker Engine (systemd)".to_string());
    }
    // 3) Colima.
    if cli_ok("colima", &["version"]) && launch_detached("colima", &["start"]) {
        return Some("Colima".to_string());
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn start_docker_engine() -> Option<String> {
    None
}

fn docker_not_installed_msg() -> String {
    #[cfg(target_os = "macos")]
    return "Docker is not installed. Install Docker Desktop (or Colima) to run skills."
        .to_string();
    #[cfg(target_os = "windows")]
    return "Docker is not installed. Install Docker Desktop for Windows to run skills."
        .to_string();
    #[cfg(target_os = "linux")]
    return "Docker is not installed. Install Docker Engine or Docker Desktop to run skills."
        .to_string();
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return "Docker is not installed. Install it to run skills.".to_string();
}

fn docker_start_failed_msg(attempted: Option<&str>) -> String {
    let tail = match attempted {
        Some(what) => format!(" I tried to start it ({what}) but it didn't become ready in time."),
        None => " I couldn't find a way to start it automatically on this system.".to_string(),
    };
    #[cfg(target_os = "macos")]
    return format!(
        "Docker is installed but not ready.{tail} Open Docker Desktop (or start Colima) manually and try again."
    );
    #[cfg(target_os = "windows")]
    return format!(
        "Docker is installed but not ready.{tail} Open Docker Desktop manually and try again."
    );
    #[cfg(target_os = "linux")]
    return format!(
        "Docker is installed but not ready.{tail} Start the service (e.g. `systemctl --user start docker-desktop` or `sudo systemctl start docker`) and try again."
    );
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    return format!("Docker is installed but not ready.{tail}");
}

/// True when a Docker CLI exists — either as a real file at a known absolute
/// location (robust under a truncated PATH) or resolvable+runnable via PATH.
/// Distinguishes "Docker isn't installed" from "Docker is installed but the
/// daemon is down", so we don't bail before attempting `start_docker_engine()`.
pub fn docker_installed() -> bool {
    docker_bin() != "docker" || cli_ok("docker", &["--version"])
}

/// Ensures the Docker daemon is reachable, auto-starting the platform's Docker
/// engine (Docker Desktop / Colima / systemd, depending on the OS) and polling
/// until it's ready. Returns a human-actionable, OS-specific error otherwise.
pub fn ensure_docker() -> Result<(), String> {
    if docker_running() {
        return Ok(());
    }
    if !docker_installed() {
        return Err(docker_not_installed_msg());
    }
    let started = start_docker_engine();
    match &started {
        Some(what) => eprintln!("sandbox: starting Docker engine via {what}"),
        None => eprintln!("sandbox: no known method to start Docker on this system"),
    }
    let timeout = docker_start_timeout_secs();
    for _ in 0..timeout {
        std::thread::sleep(Duration::from_secs(1));
        if docker_running() {
            return Ok(());
        }
    }
    Err(docker_start_failed_msg(started.as_deref()))
}

/// Locates `up.sh` for the contained computer (env override, else repo-relative).
fn up_script() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HOMUN_CONTAINED_COMPUTER_UP") {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }
    for base in [
        "runtimes/contained-computer/up.sh",
        "../runtimes/contained-computer/up.sh",
    ] {
        let path = PathBuf::from(base);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

const CC_HASH_FILES: &[&str] = &[
    "Dockerfile",
    "entrypoint.sh",
    "deck_render.py",
    "deck_qa.py",
    "doc_render.py",
    "design_tokens.py",
    "fonts_embed.py",
    "fonts_manifest.py",
    "whisper_server.py",
    "novnc-view.html",
];

/// Short content hash of every file baked into the contained-computer image.
/// Implemented in Rust so freshness checks work in packaged Windows builds
/// without Bash, WSL, `shasum`, or `sha256sum`.
fn contained_computer_def_hash_at(dir: &Path) -> Option<String> {
    let mut hasher = Sha256::new();
    for relative in CC_HASH_FILES {
        hasher.update(fs::read(dir.join(relative)).ok()?);
    }
    let mut fonts = fs::read_dir(dir.join("fonts"))
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("woff2"))
        .collect::<Vec<_>>();
    fonts.sort();
    for font in fonts {
        hasher.update(fs::read(font).ok()?);
    }
    let digest = format!("{:x}", hasher.finalize());
    Some(digest[..16].to_string())
}

fn contained_computer_def_hash() -> Option<String> {
    let dir = up_script()?.parent()?.to_path_buf();
    contained_computer_def_hash_at(&dir)
}

/// The `homun.cc_hash` label the running container was built with (None if missing).
fn running_image_hash() -> Option<String> {
    let out = Command::new(docker_bin())
        .args([
            "inspect",
            CONTAINER,
            "--format",
            "{{index .Config.Labels \"homun.cc_hash\"}}",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!hash.is_empty() && hash != "<no value>").then_some(hash)
}

/// True when the running container was built from the CURRENT image definition. If
/// the current hash can't be computed, assume fresh (keep today's behavior).
fn container_definition_fresh() -> bool {
    match contained_computer_def_hash() {
        Some(want) => running_image_hash().as_deref() == Some(want.as_str()),
        None => true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ContainedComputerRunConfig {
    artifacts_dir: PathBuf,
    profile_dir: PathBuf,
    timezone: String,
    network: Option<String>,
}

fn contained_computer_run_args(config: &ContainedComputerRunConfig) -> Vec<String> {
    let mut args = vec![
        "run".to_string(),
        "-d".to_string(),
        "--rm".to_string(),
        "--name".to_string(),
        CONTAINER.to_string(),
    ];
    if let Some(network) = config
        .network
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.extend(["--network".to_string(), network.to_string()]);
    }
    args.extend([
        "--shm-size=512m".to_string(),
        "--tmpfs".to_string(),
        "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777".to_string(),
        "-e".to_string(),
        format!("TZ={}", config.timezone),
        "-p".to_string(),
        "127.0.0.1:9222:9222".to_string(),
        "-p".to_string(),
        "127.0.0.1:6080:6080".to_string(),
        "-p".to_string(),
        "127.0.0.1:9100:9000".to_string(),
        "-v".to_string(),
        "homun-whisper-cache:/home/agent/.cache".to_string(),
        "-v".to_string(),
        format!("{}:/home/agent/output", config.artifacts_dir.display()),
        "-v".to_string(),
        format!("{}:/data/profile", config.profile_dir.display()),
        CONTAINED_IMAGE.to_string(),
    ]);
    args
}

fn run_docker_checked(args: &[String], failure: &str) -> Result<(), String> {
    let output = Command::new(docker_bin())
        .args(args)
        .output()
        .map_err(|_| failure.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(failure.to_string())
    }
}

fn contained_computer_context_dir() -> Result<PathBuf, String> {
    up_script()
        .and_then(|script| script.parent().map(Path::to_path_buf))
        .filter(|dir| dir.join("Dockerfile").is_file())
        .ok_or_else(|| "Homun Computer resources are missing from this installation.".to_string())
}

fn build_contained_computer_image() -> Result<(), String> {
    let dir = contained_computer_context_dir()?;
    let hash = contained_computer_def_hash_at(&dir).ok_or_else(|| {
        "Homun Computer resources are incomplete in this installation.".to_string()
    })?;
    let no_cache = std::env::var("HOMUN_CC_NO_CACHE")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    let no_pull = std::env::var("HOMUN_CC_NO_PULL")
        .ok()
        .is_some_and(|value| !value.trim().is_empty());
    if !no_cache && !no_pull {
        let _ = Command::new(docker_bin())
            .args(["pull", CONTAINED_BASE_IMAGE])
            .output();
    }
    let mut args = vec!["build".to_string()];
    if no_cache {
        args.push("--no-cache".to_string());
    }
    args.extend([
        "--label".to_string(),
        format!("homun.cc_hash={hash}"),
        "-t".to_string(),
        CONTAINED_IMAGE.to_string(),
        dir.to_string_lossy().into_owned(),
    ]);
    run_docker_checked(&args, "Homun Computer image build failed.")
}

fn start_contained_computer_container() -> Result<(), String> {
    let artifacts = artifacts_dir();
    let profile = cc_profile_dir();
    fs::create_dir_all(&artifacts)
        .map_err(|_| "Homun could not create its artifact directory.".to_string())?;
    if std::env::var("HOMUN_CC_RESET_PROFILE").as_deref() == Ok("1") {
        let _ = fs::remove_dir_all(&profile);
    }
    fs::create_dir_all(&profile)
        .map_err(|_| "Homun could not create its browser profile directory.".to_string())?;
    let _ = Command::new(docker_bin())
        .args(["rm", "-f", CONTAINER])
        .output();
    let config = ContainedComputerRunConfig {
        artifacts_dir: artifacts,
        profile_dir: profile,
        timezone: crate::effective_user_tz_name(),
        network: std::env::var("HOMUN_CC_NETWORK").ok(),
    };
    run_docker_checked(
        &contained_computer_run_args(&config),
        "Homun Computer container failed to start.",
    )
}

fn wait_for_container_running() -> Result<(), String> {
    for _ in 0..30 {
        if container_up() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    Err("Homun Computer did not become ready after Docker started it.".to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainedComputerBootstrapPhase {
    CheckingDocker,
    PreparingImage,
    StartingContainer,
}

/// Ensures the contained computer is running and built from the current
/// definition using only the Docker CLI, identically on Windows, macOS, and Linux.
pub fn ensure_contained_computer_with_progress(
    mut report: impl FnMut(ContainedComputerBootstrapPhase),
) -> Result<(), String> {
    report(ContainedComputerBootstrapPhase::CheckingDocker);
    ensure_docker()?;
    if container_up() && container_definition_fresh() {
        return Ok(());
    }
    report(ContainedComputerBootstrapPhase::PreparingImage);
    build_contained_computer_image()?;
    report(ContainedComputerBootstrapPhase::StartingContainer);
    start_contained_computer_container()?;
    wait_for_container_running()
}

pub fn ensure_contained_computer() -> Result<(), String> {
    ensure_contained_computer_with_progress(|_| {})
}

/// Source-tree noise excluded from extraction: vendored deps (site-packages catches
/// any venv), build output, caches, and heavy data files + shell wrappers that aren't
/// the project's program structure. Mirrors the gateway's `is_noise_dir`/`is_code_file`.
const GRAPHIFY_EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    "site-packages",
    "target",
    "vendor",
    ".venv",
    "venv",
    "*.egg-info",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".next",
    "coverage",
    "dist",
    "build",
    "__pycache__",
    "graphify-out",
    "*.csv",
    "*.log",
    "*.so",
    "*.mat",
    "*.sav",
    "*.db",
    "*.dat",
    "*.jsonl",
    "*.parquet",
    "*.lock",
    "*.sh",
    "*.bash",
];

/// PATH with `~/.local/bin` prepended — where `uv tool install` puts CLIs (graphify,
/// like the pypi MCP servers). Lets us find host-managed tools without a login shell.
fn host_tools_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    match std::env::var("HOME") {
        Ok(home) => {
            let local = format!("{home}/.local/bin");
            if base.split(':').any(|p| p == local) {
                base
            } else {
                format!("{local}:{base}")
            }
        }
        Err(_) => base,
    }
}

/// Protective default ignores for an auto-initialised project repo: keep SECRETS and
/// heavy/vendored trees out of the very first commit (a fresh `git init` + add-all would
/// otherwise capture .env/keys). Only written when the folder has no .gitignore.
const DEFAULT_GITIGNORE: &str = "# Generated by Homun when versioning was enabled.\n\
.env\n.env.*\n*.key\n*.pem\n*.p12\n*.pfx\nsecrets/\n.secrets/\ncredentials*\n\
.DS_Store\nnode_modules/\n.venv/\nvenv/\n__pycache__/\n*.pyc\ntarget/\ndist/\n\
build/\n.next/\ncoverage/\n*.log\n";

/// Ensure a project folder is under git, so versioning + history-back + the git change
/// signal work uniformly across ALL projects. Respects an EXISTING repo (never re-inits,
/// never touches its history); only `git init`s a folder that is NOT a repo, writing a
/// protective .gitignore FIRST (no secrets in the baseline) then a single baseline commit
/// so there's a state to revert to. Homun's own future commits go on a dedicated branch
/// (caller's concern); this never rewrites history. Returns true if the folder is git-backed.
pub fn ensure_project_git(folder: &Path) -> bool {
    let git = |args: &[&str]| {
        Command::new("git")
            .arg("-C")
            .arg(folder)
            .args(args)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    // Already a git work-tree (or inside one)? Use it as-is.
    let inside = Command::new("git")
        .arg("-C")
        .arg(folder)
        .args(["rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false);
    if inside {
        return true;
    }
    if !git(&["init"]) {
        return false;
    }
    // Protective .gitignore BEFORE the baseline add (so secrets are excluded from it).
    let gitignore = folder.join(".gitignore");
    if !gitignore.exists() {
        let _ = std::fs::write(&gitignore, DEFAULT_GITIGNORE);
    }
    // Baseline commit with an inline identity so it works without a global git config,
    // and gpgsign off so a signing-required setup can't block it.
    let identity = [
        "-c",
        "user.name=Homun",
        "-c",
        "user.email=homun@local",
        "-c",
        "commit.gpgsign=false",
    ];
    let mut add = identity.to_vec();
    add.extend(["add", "-A"]);
    git(&add);
    let mut commit = identity.to_vec();
    commit.extend([
        "commit",
        "-m",
        "Homun: initial baseline (versioning enabled)",
    ]);
    git(&commit);
    true
}

/// Ensures the `graphify` CLI is on the host, installing it via `uv` if missing — the
/// same host-managed pattern as the pypi MCP servers (uvx). Best-effort.
fn ensure_graphify(graphify: &Path, path: &str) -> Result<(), String> {
    let present = Command::new(graphify)
        .arg("--help")
        .env("PATH", path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if present {
        return Ok(());
    }
    let install = Command::new("uv")
        .args(["tool", "install", "graphifyy"])
        .env("PATH", path)
        .output()
        .map_err(|e| format!("graphify missing and `uv` not available on the host: {e}"))?;
    if !install.status.success() {
        return Err(format!(
            "graphify install via uv failed: {}",
            String::from_utf8_lossy(&install.stderr)
        ));
    }
    Ok(())
}

/// One-shot HOST extraction: copy the project into a temp workdir (excluding vendored/
/// data trees — the user's repo is never written), build the code graph with graphify
/// (`--no-cluster` = tree-sitter only, offline, no LLM), and write graph.json into `out`.
/// Runs on the host (managed via `uv`, like the MCP servers): ~2.4x faster than the
/// Docker sidecar on macOS and no memory cap. `--no-cluster` is offline, so dropping
/// container isolation here costs nothing (it only reads code and writes JSON).
pub fn run_graphify(project: &Path, out: &Path) -> Result<(), String> {
    let path = host_tools_path();
    run_graphify_with_cli(project, out, Path::new("graphify"), &path)
}

fn run_graphify_with_cli(
    project: &Path,
    out: &Path,
    graphify: &Path,
    path: &str,
) -> Result<(), String> {
    ensure_graphify(graphify, path)?;
    std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
    // Resolve once before changing the subprocess cwd. A relative HOMUN_DATA_DIR is
    // supported, but passing its relative mirror after chdir would resolve it twice.
    let out = std::fs::canonicalize(out).map_err(|e| e.to_string())?;
    // PERSISTENT mirror (not a throwaway _work): kept between runs so both rsync AND
    // graphify are INCREMENTAL — rsync copies only changed files, graphify (its AST
    // cache lives in _mirror/graphify-out/cache) re-parses only those. This makes the
    // "refresh when code changes" path cost seconds, not a full re-extraction. The
    // mirror is gateway-managed (outside the user's repo); the source is never written.
    let work = out.join("_mirror");
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;

    // Mirror the project, excluding noise. `--inplace` skips temp-file+rename (avoids
    // mkstempat errors on live trees where scrapers write during the copy). `--delete`
    // drops files removed from the source so the graph stays accurate on deletions. We
    // do NOT hard-fail on rsync's non-zero exit: codes 23/24 mean "some source files
    // changed/vanished mid-copy" — expected on a live project. The real gate is whether
    // graphify produces a graph.json below.
    let mut rsync = Command::new("rsync");
    rsync
        .arg("-a")
        .arg("--inplace")
        .arg("--delete")
        .arg("--exclude=graphify-out");
    for pattern in GRAPHIFY_EXCLUDES {
        rsync.arg(format!("--exclude={pattern}"));
    }
    rsync
        .arg(format!("{}/", project.display()))
        .arg(format!("{}/", work.display()));
    let copied = rsync
        .env("PATH", &path)
        .output()
        .map_err(|e| format!("rsync failed to start: {e}"))?;
    if !copied.status.success() {
        eprintln!(
            "project-graph: rsync reported files changed during the copy (continuing): {}",
            String::from_utf8_lossy(&copied.stderr)
                .lines()
                .next_back()
                .unwrap_or("")
        );
    }

    // Code-only graph: deterministic tree-sitter, no LLM, no network.
    let extracted = Command::new(graphify)
        .args(["update"])
        .arg(&work)
        .arg("--no-cluster")
        // Graphify writes auxiliary paths relative to its cwd. Keep those inside the
        // managed mirror: a packaged gateway may otherwise mutate its signed app bundle.
        .current_dir(&work)
        .env("PATH", path)
        .output()
        .map_err(|e| format!("graphify: failed to start: {e}"))?;
    let produced = work.join("graphify-out/graph.json");
    if !produced.is_file() {
        let stderr = String::from_utf8_lossy(&extracted.stderr);
        return Err(format!(
            "graphify: no graph.json produced. {}",
            stderr.lines().rev().take(3).collect::<Vec<_>>().join(" | ")
        ));
    }
    std::fs::copy(&produced, out.join("graph.json")).map_err(|e| e.to_string())?;
    // Keep _mirror (+ its graphify-out/cache) so the next refresh is incremental.
    Ok(())
}

/// Copies an installed skill's files into the container so its scripts are
/// runnable. Best-effort.
pub fn sync_skill(skill_dir: &Path, skill_id: &str) {
    let docker = docker_bin();
    let dest = format!("{CONTAINER_SKILLS_DIR}/{skill_id}");
    let _ = Command::new(&docker)
        .args(["exec", CONTAINER, "mkdir", "-p", &dest])
        .output();
    let _ = Command::new(&docker)
        .args([
            "cp",
            &format!("{}/.", skill_dir.display()),
            &format!("{CONTAINER}:{dest}"),
        ])
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
    let output = Command::new(docker_bin())
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
        .map_err(|e| format!("docker not started: {e}"))?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        combined.push_str("\n[stderr] ");
        combined.push_str(&stderr);
    }
    Ok(combined.chars().take(MAX_OUTPUT_CHARS).collect())
}

#[cfg(test)]
mod platform_tests {
    use super::{
        ContainedComputerRunConfig, contained_computer_def_hash_at, contained_computer_run_args,
        docker_candidate_paths, host_home_dir_from,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn windows_docker_candidates_follow_program_files_without_path_restart() {
        let candidates = docker_candidate_paths("windows", Some(r"D:\Apps"), None, None);

        assert_eq!(
            candidates[0],
            PathBuf::from(r"D:\Apps\Docker\Docker\resources\bin\docker.exe")
        );
        assert!(candidates.contains(&PathBuf::from(
            r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"
        )));
    }

    #[test]
    fn explicit_docker_binary_has_priority_on_every_platform() {
        let candidates = docker_candidate_paths(
            "linux",
            None,
            Some("/home/fabio"),
            Some("/opt/custom/docker"),
        );

        assert_eq!(candidates[0], PathBuf::from("/opt/custom/docker"));
    }

    #[test]
    fn windows_home_falls_back_to_userprofile() {
        assert_eq!(
            host_home_dir_from(None, Some(r"C:\Users\Fabio"), Path::new(r"C:\Temp")),
            PathBuf::from(r"C:\Users\Fabio")
        );
    }

    #[test]
    fn contained_computer_run_args_preserve_runtime_contract() {
        let args = contained_computer_run_args(&ContainedComputerRunConfig {
            artifacts_dir: PathBuf::from("/host/artifacts"),
            profile_dir: PathBuf::from("/host/profile"),
            timezone: "Europe/Rome".to_string(),
            network: Some("homun-net".to_string()),
        });

        assert!(args.windows(2).any(|pair| pair == ["--name", "homun-cc"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["--network", "homun-net"])
        );
        assert!(args.contains(&"127.0.0.1:9222:9222".to_string()));
        assert!(args.contains(&"127.0.0.1:6080:6080".to_string()));
        assert!(args.contains(&"127.0.0.1:9100:9000".to_string()));
        assert!(args.contains(&"TZ=Europe/Rome".to_string()));
        assert!(args.contains(&"homun-whisper-cache:/home/agent/.cache".to_string()));
        assert!(args.contains(&"/host/artifacts:/home/agent/output".to_string()));
        assert!(args.contains(&"/host/profile:/data/profile".to_string()));
    }

    #[test]
    fn contained_computer_hash_is_deterministic_and_tracks_inputs() {
        let root = std::env::temp_dir().join(format!(
            "homun-cc-hash-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _cleanup = TestDir(root.clone());
        fs::create_dir_all(root.join("fonts")).expect("create hash fixture");
        for relative in [
            "Dockerfile",
            "entrypoint.sh",
            "deck_render.py",
            "deck_qa.py",
            "doc_render.py",
            "design_tokens.py",
            "fonts_embed.py",
            "fonts_manifest.py",
            "whisper_server.py",
            "novnc-view.html",
        ] {
            fs::write(root.join(relative), relative).expect("write hash input");
        }
        fs::write(root.join("fonts/body.woff2"), b"font-a").expect("write font");

        let first = contained_computer_def_hash_at(&root).expect("first hash");
        let second = contained_computer_def_hash_at(&root).expect("second hash");
        assert_eq!(first, second);

        fs::write(root.join("entrypoint.sh"), "changed").expect("change input");
        assert_ne!(
            first,
            contained_computer_def_hash_at(&root).expect("changed hash")
        );
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::run_graphify_with_cli;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    struct TestDir(PathBuf);

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn assert_graphify_runs_from_gateway_managed_mirror(root: PathBuf) {
        let _cleanup = TestDir(root.clone());
        let project = root.join("project");
        let out = root.join("out");
        let fake_bin = root.join("bin");
        fs::create_dir_all(&project).expect("create project");
        fs::create_dir_all(&fake_bin).expect("create fake bin");
        let marker = fs::canonicalize(&root)
            .expect("canonical test root")
            .join("graphify-pwd");
        fs::write(project.join("main.rs"), "fn main() {}\n").expect("write project file");

        let fake_graphify = fake_bin.join("graphify");
        fs::write(
            &fake_graphify,
            format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"--help\" ]; then exit 0; fi\n\
                 printf '%s' \"$PWD\" > '{}'\n\
                 mkdir -p \"$2/graphify-out\"\n\
                 printf '{{\"nodes\":[],\"edges\":[]}}' > \"$2/graphify-out/graph.json\"\n",
                marker.display()
            ),
        )
        .expect("write fake graphify");
        let mut permissions = fs::metadata(&fake_graphify)
            .expect("stat fake graphify")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&fake_graphify, permissions).expect("make fake graphify executable");

        let fake_graphify = fs::canonicalize(fake_graphify).expect("canonical fake graphify");
        let path = std::env::var("PATH").unwrap_or_default();
        run_graphify_with_cli(&project, &out, &fake_graphify, &path)
            .expect("run graphify through the real gateway path");

        let recorded = PathBuf::from(fs::read_to_string(&marker).expect("read cwd marker"));
        assert_eq!(
            fs::canonicalize(recorded).expect("canonical recorded cwd"),
            fs::canonicalize(out.join("_mirror")).expect("canonical managed mirror"),
            "Graphify auxiliary relative files must stay outside the signed app bundle"
        );
    }

    #[test]
    fn graphify_runs_from_gateway_managed_mirror() {
        assert_graphify_runs_from_gateway_managed_mirror(std::env::temp_dir().join(format!(
            "homun-graphify-cwd-test-{}",
            uuid::Uuid::new_v4().simple()
        )));
    }

    #[test]
    fn graphify_managed_mirror_is_absolute_when_output_root_is_relative() {
        assert_graphify_runs_from_gateway_managed_mirror(PathBuf::from("target").join(format!(
            "homun-graphify-relative-cwd-test-{}",
            uuid::Uuid::new_v4().simple()
        )));
    }
}
