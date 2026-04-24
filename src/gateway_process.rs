use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::config::Config;

pub enum GatewayProcessStatus {
    Running(String),
    Stale,
    NotRunning,
}

fn pid_file() -> PathBuf {
    Config::data_dir().join("homun.pid")
}

/// Check if a process is alive by PID string.
#[cfg(unix)]
fn is_process_alive(pid_str: &str) -> bool {
    pid_str
        .parse::<u32>()
        .ok()
        .map(|pid| {
            std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_process_alive(_pid_str: &str) -> bool {
    // On Windows, assume alive if PID file exists (conservative).
    true
}

pub fn status() -> GatewayProcessStatus {
    let pid_file = pid_file();
    let Ok(pid_str) = std::fs::read_to_string(&pid_file) else {
        return GatewayProcessStatus::NotRunning;
    };

    let pid = pid_str.trim();
    if is_process_alive(pid) {
        GatewayProcessStatus::Running(pid.to_string())
    } else {
        let _ = std::fs::remove_file(&pid_file);
        GatewayProcessStatus::Stale
    }
}

pub fn prepare_pid_file() -> Result<PathBuf> {
    let pid_file = pid_file();

    if pid_file.exists() {
        if let Ok(pid_str) = std::fs::read_to_string(&pid_file) {
            if let Ok(old_pid) = pid_str.trim().parse::<u32>() {
                terminate_existing_process(old_pid);
            }
        }
    }

    std::fs::write(&pid_file, std::process::id().to_string())?;
    Ok(pid_file)
}

pub fn cleanup_pid_file(pid_file: &Path) {
    let _ = std::fs::remove_file(pid_file);
}

/// Stop the running gateway via PID file. Returns true if a running process was stopped.
pub fn stop_gateway() -> Result<bool> {
    let pid_file = pid_file();

    let pid_str = match std::fs::read_to_string(&pid_file) {
        Ok(s) => s,
        Err(_) => {
            eprintln!("No gateway running (PID file not found)");
            return Ok(false);
        }
    };

    let pid = pid_str.trim();

    if !is_process_alive(pid) {
        eprintln!("Process {pid} not found (stale PID file). Cleaning up.");
        let _ = std::fs::remove_file(&pid_file);
        return Ok(false);
    }

    stop_process(pid, &pid_file)
}

#[cfg(unix)]
fn terminate_existing_process(old_pid: u32) {
    use std::process::Command;

    let _ = Command::new("kill")
        .arg("-TERM")
        .arg(old_pid.to_string())
        .output();

    tracing::info!("Sent TERM signal to existing instance (PID {})", old_pid);

    for i in 1..=10 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        let check = Command::new("kill")
            .arg("-0")
            .arg(old_pid.to_string())
            .output();
        if check.is_err() || check.map(|o| !o.status.success()).unwrap_or(true) {
            tracing::info!("Previous instance terminated after {}ms", i * 500);
            break;
        }
    }
}

#[cfg(windows)]
fn terminate_existing_process(old_pid: u32) {
    use std::process::Command;

    let _ = Command::new("taskkill")
        .args(["/PID", &old_pid.to_string(), "/F"])
        .output();
    tracing::info!("Killed existing instance (PID {})", old_pid);
    std::thread::sleep(std::time::Duration::from_secs(1));
}

#[cfg(not(any(unix, windows)))]
fn terminate_existing_process(_old_pid: u32) {}

#[cfg(unix)]
fn stop_process(pid: &str, pid_file: &Path) -> Result<bool> {
    let status = std::process::Command::new("kill")
        .args(["-TERM", pid])
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("Sent stop signal to gateway (PID {pid})");
            for _ in 0..50 {
                std::thread::sleep(std::time::Duration::from_millis(100));
                if !pid_file.exists() {
                    println!("Gateway stopped.");
                    return Ok(true);
                }
            }
            println!("Gateway may still be stopping (PID file not yet removed).");
            Ok(true)
        }
        _ => {
            eprintln!("Failed to stop process {pid}. Cleaning up stale PID file.");
            let _ = std::fs::remove_file(pid_file);
            Ok(false)
        }
    }
}

#[cfg(not(unix))]
fn stop_process(pid: &str, pid_file: &Path) -> Result<bool> {
    let status = std::process::Command::new("taskkill")
        .args(["/PID", pid, "/F"])
        .status();
    match status {
        Ok(s) if s.success() => {
            println!("Gateway stopped (PID {pid}).");
            let _ = std::fs::remove_file(pid_file);
            Ok(true)
        }
        _ => {
            eprintln!("Failed to stop process {pid}. Cleaning up stale PID file.");
            let _ = std::fs::remove_file(pid_file);
            Ok(false)
        }
    }
}
