use local_first_local_computer_session::{
    ArtifactCreate, ComputerEventCreate, ComputerSessionSnapshot, LocalComputerSessionManager,
    SurfaceKind,
};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
struct BrowserPreviewSmoke {
    url: String,
    path: String,
    bytes: u64,
}

pub fn run_local_computer_smoke_test(
    manager: &LocalComputerSessionManager,
    workspace_root: &Path,
    user_id: &str,
    workspace_id: &str,
    session_id: &str,
) -> Result<ComputerSessionSnapshot, String> {
    append_computer_event(
        manager,
        session_id,
        SurfaceKind::Browser,
        "computer_action_started",
        "running",
        "Verificare sidecar browser locale",
        "Richiesta health via stdio al runtime Playwright locale",
        serde_json::json!({ "method": "browser.health" }),
        false,
    )?;

    match browser_sidecar_preview(workspace_root) {
        Ok(preview) => {
            let artifact_id = "local_smoke_browser_preview";
            manager.create_artifact(ArtifactCreate {
                session_id: session_id.to_string(),
                artifact_id: artifact_id.to_string(),
                title: "local-browser-preview.png".to_string(),
                kind: "screenshot".to_string(),
                path_ref: preview.path.clone(),
                size_bytes: preview.bytes,
                preview_ref: Some(preview.path.clone()),
            })?;
            append_computer_event(
                manager,
                session_id,
                SurfaceKind::Browser,
                "computer_action_completed",
                "done",
                "Preview browser disponibile",
                "Screenshot redatto prodotto dal sidecar locale",
                serde_json::json!({
                    "url": preview.url,
                    "artifact_id": artifact_id,
                    "preview": "redacted"
                }),
                false,
            )?;
        }
        Err(error) => {
            append_computer_event(
                manager,
                session_id,
                SurfaceKind::Browser,
                "computer_action_failed",
                "failed",
                "Sidecar browser non disponibile",
                &error,
                serde_json::json!({ "error": error }),
                true,
            )?;
        }
    }

    append_computer_event(
        manager,
        session_id,
        SurfaceKind::Shell,
        "computer_action_started",
        "running",
        "Eseguire comando shell read-only",
        "date '+%Y-%m-%d %H:%M:%S %Z'",
        serde_json::json!({ "command": "date" }),
        false,
    )?;
    let transcript = run_date_command()?;
    manager.start_surface(session_id, SurfaceKind::Shell, "Terminale locale")?;
    manager.append_terminal_output(session_id, user_id, workspace_id, &transcript)?;
    manager.create_artifact(ArtifactCreate {
        session_id: session_id.to_string(),
        artifact_id: "local_smoke_transcript".to_string(),
        title: "local-smoke-transcript.txt".to_string(),
        kind: "terminal".to_string(),
        path_ref: "artifact://local-smoke-transcript".to_string(),
        size_bytes: transcript.len() as u64,
        preview_ref: None,
    })?;
    append_computer_event(
        manager,
        session_id,
        SurfaceKind::Shell,
        "computer_action_completed",
        "done",
        "Comando shell completato",
        "Output terminale redatto nella timeline",
        serde_json::json!({ "command": "date", "output": "redacted" }),
        false,
    )?;

    manager
        .read_model()
        .snapshot(session_id, user_id, workspace_id)?
        .ok_or_else(|| format!("session not found: {session_id}"))
}

fn append_computer_event(
    manager: &LocalComputerSessionManager,
    session_id: &str,
    surface: SurfaceKind,
    kind: &str,
    status: &str,
    title: &str,
    subtitle: &str,
    payload: serde_json::Value,
    approval_required: bool,
) -> Result<(), String> {
    if matches!(surface, SurfaceKind::Browser | SurfaceKind::Shell) {
        manager.start_surface(
            session_id,
            surface,
            match surface {
                SurfaceKind::Browser => "Browser locale",
                SurfaceKind::Shell => "Terminale locale",
                SurfaceKind::Files => "File",
                SurfaceKind::Logs => "Log",
            },
        )?;
    }
    manager.append_event(ComputerEventCreate {
        session_id: session_id.to_string(),
        surface,
        kind: kind.to_string(),
        status: status.to_string(),
        title: title.to_string(),
        subtitle: subtitle.to_string(),
        payload,
        artifact_refs: vec![],
        approval_required,
    })?;
    Ok(())
}

fn browser_sidecar_preview(workspace_root: &Path) -> Result<BrowserPreviewSmoke, String> {
    let runtime_dir = workspace_root.join("runtimes/browser-automation");
    let artifact_root = workspace_root.join("target/local-computer-artifacts");
    let mut child = Command::new("node")
        .arg("node_modules/tsx/dist/cli.mjs")
        .arg("src/server.ts")
        .current_dir(runtime_dir)
        .env("BROWSER_AUTOMATION_ARTIFACT_ROOT", &artifact_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("browser sidecar spawn failed: {error}"))?;

    let requests = [
        serde_json::json!({
            "id": "local_computer_health",
            "method": "browser.health",
            "params": {}
        }),
        serde_json::json!({
            "id": "local_computer_open",
            "method": "browser.open",
            "params": {
                "url": "about:blank",
                "label": "local-preview"
            }
        }),
        serde_json::json!({
            "id": "local_computer_screenshot",
            "method": "browser.screenshot",
            "params": {
                "target_id": "local-preview",
                "file_name": "local-browser-preview.png",
                "full_page": false
            }
        }),
        serde_json::json!({
            "id": "local_computer_stop",
            "method": "browser.stop",
            "params": {}
        }),
    ];
    if let Some(stdin) = child.stdin.as_mut() {
        for request in requests {
            writeln!(stdin, "{request}")
                .map_err(|error| format!("browser sidecar write failed: {error}"))?;
        }
    }
    drop(child.stdin.take());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "browser sidecar stdout unavailable".to_string())?;
    let mut responses = Vec::new();
    for line in BufReader::new(stdout).lines() {
        responses.push(line.map_err(|error| format!("browser sidecar read failed: {error}"))?);
        if responses.len() == 4 {
            break;
        }
    }
    let _ = child.kill();
    let _ = child.wait();

    let health = response_by_id(&responses, "local_computer_health")?;
    ensure_ok(&health)?;
    let open = response_by_id(&responses, "local_computer_open")?;
    ensure_ok(&open)?;
    let screenshot = response_by_id(&responses, "local_computer_screenshot")?;
    ensure_ok(&screenshot)?;
    let path = screenshot["result"]["path"]
        .as_str()
        .ok_or_else(|| "browser screenshot path missing".to_string())?;
    let bytes = screenshot["result"]["bytes"]
        .as_u64()
        .ok_or_else(|| "browser screenshot bytes missing".to_string())?;
    let url = open["result"]["url"]
        .as_str()
        .unwrap_or("about:blank")
        .to_string();
    Ok(BrowserPreviewSmoke {
        url,
        path: normalize_path(path),
        bytes,
    })
}

fn response_by_id(lines: &[String], id: &str) -> Result<serde_json::Value, String> {
    for line in lines {
        let value: serde_json::Value = serde_json::from_str(line.trim())
            .map_err(|error| format!("browser sidecar invalid response: {error}"))?;
        if value.get("id").and_then(serde_json::Value::as_str) == Some(id) {
            return Ok(value);
        }
    }
    Err(format!("browser sidecar response missing: {id}"))
}

fn ensure_ok(response: &serde_json::Value) -> Result<(), String> {
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        return Ok(());
    }
    Err(response.to_string())
}

fn normalize_path(path: &str) -> String {
    PathBuf::from(path).display().to_string()
}

fn run_date_command() -> Result<String, String> {
    let output = Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S %Z")
        .output()
        .map_err(|error| format!("date command failed: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        return Err(format!(
            "date command exited with {}: {stderr}",
            output.status
        ));
    }
    Ok(format!(
        "local-smoke % date '+%Y-%m-%d %H:%M:%S %Z'\n{stdout}"
    ))
}
