use local_first_local_computer_session::{
    ArtifactCreate, ComputerEventCreate, ComputerSessionSnapshot, LocalComputerSessionManager,
    SurfaceKind,
};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

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

    match browser_sidecar_health(workspace_root) {
        Ok(status) => {
            append_computer_event(
                manager,
                session_id,
                SurfaceKind::Browser,
                "computer_action_completed",
                "done",
                "Sidecar browser pronto",
                &status,
                serde_json::json!({ "status": status }),
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

fn browser_sidecar_health(workspace_root: &Path) -> Result<String, String> {
    let runtime_dir = workspace_root.join("runtimes/browser-automation");
    let mut child = Command::new("node")
        .arg("node_modules/tsx/dist/cli.mjs")
        .arg("src/server.ts")
        .current_dir(runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("browser sidecar spawn failed: {error}"))?;

    let request = serde_json::json!({
        "id": "local_computer_smoke",
        "method": "browser.health",
        "params": {}
    });
    if let Some(stdin) = child.stdin.as_mut() {
        writeln!(stdin, "{request}")
            .map_err(|error| format!("browser sidecar write failed: {error}"))?;
    }
    drop(child.stdin.take());

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "browser sidecar stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("browser sidecar read failed: {error}"))?;
    let _ = child.kill();
    let _ = child.wait();

    let response: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("browser sidecar invalid response: {error}"))?;
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        let transport = response["result"]["transport"].as_str().unwrap_or("stdio");
        Ok(format!("browser.health ok via {transport}"))
    } else {
        Err(response.to_string())
    }
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
