use local_first_local_computer_session::{
    ArtifactCreate, ComputerEventCreate, ComputerSessionSnapshot, LocalComputerSessionManager,
    SurfaceKind,
};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone)]
struct BrowserPreviewSmoke {
    url: String,
    path: String,
    bytes: u64,
    form_draft_completed: bool,
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
                    "preview": "redacted",
                    "form_draft_completed": preview.form_draft_completed
                }),
                false,
            )?;
            append_computer_event(
                manager,
                session_id,
                SurfaceKind::Browser,
                "browser_form_draft_completed",
                "done",
                "Form compilato in bozza",
                "Nessun submit eseguito",
                serde_json::json!({
                    "url": preview.url,
                    "submitted": false,
                    "payload_redacted": true
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
    let fixture_url = start_form_fixture_server()?;
    let mut child = Command::new("node")
        .arg("node_modules/tsx/dist/cli.mjs")
        .arg("src/server.ts")
        .current_dir(runtime_dir)
        .env("BROWSER_AUTOMATION_ARTIFACT_ROOT", &artifact_root)
        .env("BROWSER_AUTOMATION_ALLOW_PRIVATE_NETWORK", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("browser sidecar spawn failed: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "browser sidecar stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "browser sidecar stdout unavailable".to_string())?;
    let mut reader = BufReader::new(stdout);

    let health = send_sidecar_request(
        &mut stdin,
        &mut reader,
        serde_json::json!({
            "id": "local_computer_health",
            "method": "browser.health",
            "params": {}
        }),
    )?;
    ensure_ok(&health)?;
    let open = send_sidecar_request(
        &mut stdin,
        &mut reader,
        serde_json::json!({
            "id": "local_computer_open",
            "method": "browser.open",
            "params": {
                "url": fixture_url,
                "label": "local-preview"
            }
        }),
    )?;
    ensure_ok(&open)?;
    let snapshot = send_sidecar_request(
        &mut stdin,
        &mut reader,
        serde_json::json!({
            "id": "local_computer_snapshot_before_fill",
            "method": "browser.snapshot",
            "params": {
                "target_id": "local-preview"
            }
        }),
    )?;
    ensure_ok(&snapshot)?;
    let input_ref = find_ref_by_name(&snapshot, "Name")?;
    let fill = send_sidecar_request(
        &mut stdin,
        &mut reader,
        serde_json::json!({
            "id": "local_computer_fill_draft",
            "method": "browser.act",
            "params": {
                "target_id": "local-preview",
                "kind": "fill",
                "fields": [
                    {
                        "ref": input_ref,
                        "value": "Draft redatto"
                    }
                ]
            }
        }),
    )?;
    ensure_ok(&fill)?;
    let screenshot = send_sidecar_request(
        &mut stdin,
        &mut reader,
        serde_json::json!({
            "id": "local_computer_screenshot",
            "method": "browser.screenshot",
            "params": {
                "target_id": "local-preview",
                "file_name": "local-browser-preview.png",
                "full_page": false
            }
        }),
    )?;
    ensure_ok(&screenshot)?;
    let _ = send_sidecar_request(
        &mut stdin,
        &mut reader,
        serde_json::json!({
            "id": "local_computer_stop",
            "method": "browser.stop",
            "params": {}
        }),
    );
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
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
        form_draft_completed: true,
    })
}

fn send_sidecar_request(
    stdin: &mut std::process::ChildStdin,
    reader: &mut BufReader<std::process::ChildStdout>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let expected_id = request
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    writeln!(stdin, "{request}")
        .map_err(|error| format!("browser sidecar write failed: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("browser sidecar flush failed: {error}"))?;
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("browser sidecar read failed: {error}"))?;
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|error| format!("browser sidecar invalid response: {error}"))?;
    if value.get("id").and_then(serde_json::Value::as_str) != Some(expected_id.as_str()) {
        return Err(format!("browser sidecar response mismatch: {expected_id}"));
    }
    Ok(value)
}

fn start_form_fixture_server() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("fixture server bind failed: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("fixture server address failed: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("fixture server nonblocking failed: {error}"))?;
    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut handled = 0;
        while Instant::now() < deadline && handled < 8 {
            match listener.accept() {
                Ok((stream, _)) => {
                    handled += 1;
                    let _ = respond_form_fixture(stream);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => break,
            }
        }
    });
    Ok(format!("http://{address}/"))
}

fn respond_form_fixture(mut stream: TcpStream) -> Result<(), String> {
    let mut buffer = [0_u8; 1024];
    let _ = stream.read(&mut buffer);
    let body = r##"<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Local Draft Fixture</title></head>
  <body>
    <main>
      <h1>Booking Draft</h1>
      <label>Name<input aria-label="Name" name="name"></label>
      <button id="submit" type="button">Submit</button>
      <p id="result" aria-live="polite"></p>
    </main>
    <script>
      document.querySelector("#submit").addEventListener("click", () => {
        document.querySelector("#result").textContent = "Submitted";
      });
    </script>
  </body>
</html>"##;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|error| format!("fixture server write failed: {error}"))
}

fn find_ref_by_name(response: &serde_json::Value, name: &str) -> Result<String, String> {
    response["result"]["refs"]
        .as_array()
        .and_then(|refs| {
            refs.iter().find_map(|entry| {
                (entry.get("name").and_then(serde_json::Value::as_str) == Some(name))
                    .then(|| entry.get("ref").and_then(serde_json::Value::as_str))
                    .flatten()
                    .map(str::to_string)
            })
        })
        .ok_or_else(|| format!("browser ref missing: {name}"))
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
