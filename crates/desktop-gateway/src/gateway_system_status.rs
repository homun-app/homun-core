//! Gateway system status owner.
//!
//! Owns the `/api/system/status` read model and the local diagnostic helpers
//! used by Settings. Browser control routes remain with their runtime owner.

use super::*;

const CONTAINED_CONTAINER_NAME: &str = "homun-cc";

#[derive(Debug, Serialize)]
pub(crate) struct DockerStatus {
    installed: bool,
    running: bool,
    container_up: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct SystemStatusResponse {
    docker: DockerStatus,
    contained_enabled: bool,
    contained_cdp_ok: bool,
    gateway_memory_mb: u64,
    container_memory_mb: Option<u64>,
    browser_sessions: usize,
}

/// Run a CLI command, returning trimmed stdout on success.
fn run_cli(program: &str, args: &[&str]) -> Option<String> {
    std::process::Command::new(program)
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Resident memory of this gateway process, in MB, best-effort via `ps`.
fn gateway_memory_mb() -> u64 {
    let pid = std::process::id().to_string();
    run_cli("ps", &["-o", "rss=", "-p", &pid])
        .and_then(|stdout| stdout.split_whitespace().next().map(str::to_string))
        .and_then(|kb| kb.parse::<u64>().ok())
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

/// Parse the first figure of a `docker stats` MemUsage cell.
fn parse_docker_mem_mb(usage: &str) -> Option<u64> {
    let first = usage.split('/').next()?.trim();
    let digits: String = first
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let value: f64 = digits.parse().ok()?;
    let mb = if first.contains("GiB") || first.contains("GB") {
        value * 1024.0
    } else if first.contains("KiB") || first.contains("KB") {
        value / 1024.0
    } else {
        value
    };
    Some(mb.round() as u64)
}

/// System/Computer status for Settings: Docker state, gateway memory usage,
/// contained CDP reachability, and live browser-session count.
pub(crate) async fn system_status(State(state): State<AppState>) -> Json<SystemStatusResponse> {
    let browser_sessions = state
        .browser_thread_sessions
        .lock()
        .map(|map| map.len())
        .unwrap_or(0);
    let cdp = contained_computer_cdp_endpoint();
    let contained_enabled = cdp.is_some();
    let contained_cdp_ok = if let Some(endpoint) = cdp.as_ref() {
        state
            .http
            .get(format!("{}/json/version", endpoint.trim_end_matches('/')))
            .timeout(std::time::Duration::from_millis(800))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    } else {
        false
    };
    let (docker, gateway_mb, container_mb) = tokio::task::spawn_blocking(|| {
        let installed = run_cli("docker", &["--version"]).is_some();
        let running =
            installed && run_cli("docker", &["info", "--format", "{{.ServerVersion}}"]).is_some();
        let filter = format!("name={CONTAINED_CONTAINER_NAME}");
        let container_up = running
            && run_cli(
                "docker",
                &["ps", "--filter", &filter, "--format", "{{.Names}}"],
            )
            .map(|names| names.contains(CONTAINED_CONTAINER_NAME))
            .unwrap_or(false);
        let container_mb = if container_up {
            run_cli(
                "docker",
                &[
                    "stats",
                    "--no-stream",
                    "--format",
                    "{{.MemUsage}}",
                    CONTAINED_CONTAINER_NAME,
                ],
            )
            .as_deref()
            .and_then(parse_docker_mem_mb)
        } else {
            None
        };
        (
            DockerStatus {
                installed,
                running,
                container_up,
            },
            gateway_memory_mb(),
            container_mb,
        )
    })
    .await
    .unwrap_or((
        DockerStatus {
            installed: false,
            running: false,
            container_up: false,
        },
        0,
        None,
    ));

    Json(SystemStatusResponse {
        docker,
        contained_enabled,
        contained_cdp_ok,
        gateway_memory_mb: gateway_mb,
        container_memory_mb: container_mb,
        browser_sessions,
    })
}

#[test]
fn owner_parses_docker_memory_units() {
    assert_eq!(
        parse_docker_mem_mb("123.4MiB / 512MiB"),
        Some(123),
        "MiB values are rounded to the nearest MB"
    );
    assert_eq!(
        parse_docker_mem_mb("1.5GiB / 4GiB"),
        Some(1536),
        "GiB values are converted to MB"
    );
    assert_eq!(
        parse_docker_mem_mb("512KiB / 1GiB"),
        Some(1),
        "KiB values are converted and rounded to MB"
    );
    assert_eq!(parse_docker_mem_mb("not-a-number"), None);
}
