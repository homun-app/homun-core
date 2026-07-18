//! Skill execution sandbox — reuses the SAME contained-computer Docker container
//! as the browser (`homun-cc`), which now ships a shell + curl/python/git/jq.
//!
//! Lifecycle: ensure the Docker daemon is up (auto-starting the platform's Docker
//! engine — Docker Desktop / Colima on macOS, Docker Desktop on Windows, the
//! systemd service or Docker Desktop on Linux), ensure the container is running
//! (via `up.sh`), then run skill commands in it with `docker exec`. The container
//! is loopback-only and runs as a non-root `agent` user, so it doubles as an
//! isolated sandbox for SKILL.md scripts.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The contained-computer container name (matches the browser's).
pub const CONTAINER: &str = "homun-cc";
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
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(".homun")
        .join("artifacts")
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
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir())
        .join(".homun")
        .join("cc-profile")
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

/// Absolute paths where the `docker` CLI commonly lives, per OS. Probed so we
/// keep working even when the gateway inherited a truncated GUI/launchd PATH (a
/// macOS .app launched from Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`, which
/// omits `/usr/local/bin` — where Docker Desktop's `docker` symlink sits).
#[cfg(target_os = "macos")]
const DOCKER_CANDIDATES: &[&str] = &[
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
];
#[cfg(target_os = "linux")]
const DOCKER_CANDIDATES: &[&str] = &[
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
];
#[cfg(target_os = "windows")]
const DOCKER_CANDIDATES: &[&str] = &[r"C:\Program Files\Docker\Docker\resources\bin\docker.exe"];
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
const DOCKER_CANDIDATES: &[&str] = &[];

/// Resolves the `docker` executable, preferring an ABSOLUTE path so invocations
/// succeed regardless of the inherited PATH. Honors `HOMUN_DOCKER_BIN`; falls back
/// to the bare name `"docker"` (PATH lookup) when no known location exists.
fn docker_bin() -> String {
    if let Ok(explicit) = std::env::var("HOMUN_DOCKER_BIN") {
        if !explicit.trim().is_empty() {
            return explicit;
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        let p = format!("{home}/.docker/bin/docker");
        if Path::new(&p).is_file() {
            return p;
        }
    }
    for cand in DOCKER_CANDIDATES {
        if Path::new(cand).is_file() {
            return cand.to_string();
        }
    }
    "docker".to_string()
}

/// The current PATH with the resolved docker binary's directory prepended, so a
/// child process (e.g. `up.sh`, which calls `docker`/`curl` by name) finds them
/// even if the gateway itself inherited a truncated PATH. Unix-only separator —
/// the only consumer is the bash-launched `up.sh`.
fn path_with_docker_dir() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let docker = docker_bin();
    if let Some(dir) = Path::new(&docker)
        .parent()
        .map(|d| d.to_string_lossy().into_owned())
    {
        if !dir.is_empty() && !current.split(':').any(|p| p == dir) {
            return if current.is_empty() {
                dir
            } else {
                format!("{dir}:{current}")
            };
        }
    }
    current
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
fn docker_installed() -> bool {
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

/// Short content hash of the contained-computer image definition (Dockerfile +
/// entrypoint), computed with the SAME shell command as up.sh so the gateway- and
/// manually-stamped `homun.cc_hash` labels always agree. Lets us tell a stale running
/// container (built from an older app version) from a fresh one.
fn contained_computer_def_hash() -> Option<String> {
    let dir = up_script()?.parent()?.to_path_buf();
    if !dir.join("Dockerfile").is_file() {
        return None;
    }
    // Hash ALL files baked into the image (everything COPY'd), so a renderer/QA change
    // (deck_render.py/deck_qa.py) triggers a rebuild too. MUST match up.sh's HASH_FILES list.
    let out = Command::new("bash")
        .arg("-c")
        .arg(
            "cat Dockerfile entrypoint.sh deck_render.py deck_qa.py doc_render.py design_tokens.py whisper_server.py novnc-view.html 2>/dev/null | \
             { command -v shasum >/dev/null 2>&1 && shasum -a 256 || sha256sum; } | cut -c1-16",
        )
        .current_dir(&dir)
        .output()
        .ok()?;
    let hash = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!hash.is_empty()).then_some(hash)
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

/// Ensures the contained computer is running AND built from the current definition,
/// (re)building via `up.sh` when it's down OR stale (e.g. an app update changed the
/// Dockerfile/entrypoint). up.sh's own `docker rm -f` recycles a stale container.
pub fn ensure_contained_computer() -> Result<(), String> {
    ensure_docker()?;
    if container_up() && container_definition_fresh() {
        return Ok(());
    }
    if let Some(script) = up_script() {
        // up.sh builds the image (with the skill toolchain) and runs the container,
        // bind-mounting the artifacts dir so generated files land on the host.
        let _ = Command::new("bash")
            .arg(&script)
            .env("HOMUN_ARTIFACTS_DIR", artifacts_dir())
            .env("HOMUN_CC_PROFILE_DIR", cc_profile_dir())
            // Stamp the built image with the definition hash so a later update can
            // detect a stale running container and rebuild it.
            .env(
                "HOMUN_CC_HASH",
                contained_computer_def_hash().unwrap_or_default(),
            )
            // Layer D: the container defaults to UTC (debian-slim ships no
            // /etc/localtime). Pass the user's effective IANA zone so `date`,
            // Python AND Chromium's clock inside the container match the user —
            // otherwise date-defaulting web forms pick the wrong day near the
            // UTC midnight boundary.
            .env("HOMUN_TZ", crate::effective_user_tz_name())
            .env("PATH", path_with_docker_dir())
            .output();
        for _ in 0..30 {
            if container_up() {
                return Ok(());
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
    Err(
        "The contained computer (homun-cc) is not running and I couldn't start it. \
Start it with runtimes/contained-computer/up.sh."
            .to_string(),
    )
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
