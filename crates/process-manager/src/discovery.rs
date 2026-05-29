use crate::{DiscoveredProcess, RuntimeResourceSnapshot};
use std::process::Command;

pub trait RuntimeDiscoveryProbe {
    fn listeners_on_port(&self, port: u16) -> Vec<DiscoveredProcess>;
    fn matching_processes(&self, needle: &str) -> Vec<DiscoveredProcess>;
    fn resources_for_pid(&self, pid: u32) -> Option<RuntimeResourceSnapshot>;
}

#[derive(Debug, Default, Clone, Copy)]
pub struct LocalRuntimeDiscovery;

impl RuntimeDiscoveryProbe for LocalRuntimeDiscovery {
    fn listeners_on_port(&self, port: u16) -> Vec<DiscoveredProcess> {
        let output = Command::new("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN"])
            .output();
        let Ok(output) = output else {
            return vec![];
        };
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .skip(1)
            .filter_map(|line| parse_lsof_line(line, port))
            .collect()
    }

    fn matching_processes(&self, needle: &str) -> Vec<DiscoveredProcess> {
        let output = Command::new("ps").args(["-axo", "pid=,command="]).output();
        let Ok(output) = output else {
            return vec![];
        };
        let text = String::from_utf8_lossy(&output.stdout);
        text.lines()
            .filter_map(|line| parse_ps_line(line))
            .filter(|process| process.command.contains(needle))
            .collect()
    }

    fn resources_for_pid(&self, pid: u32) -> Option<RuntimeResourceSnapshot> {
        let output = Command::new("ps")
            .args(["-o", "rss=,%cpu=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut parts = text.split_whitespace();
        let rss_kb = parts.next()?.parse::<u64>().ok()?;
        let cpu = parts.next().and_then(|value| value.parse::<f32>().ok());
        Some(RuntimeResourceSnapshot {
            total_memory_mb: total_memory_mb(),
            available_memory_mb: None,
            process_memory_mb: Some(rss_kb / 1024),
            process_cpu_percent: cpu,
        })
    }
}

fn parse_lsof_line(line: &str, target_port: u16) -> Option<DiscoveredProcess> {
    let columns = line.split_whitespace().collect::<Vec<_>>();
    if columns.len() < 9 {
        return None;
    }
    let pid = columns.get(1)?.parse::<u32>().ok()?;
    let name = columns.get(8)?;
    if !name.ends_with(&format!(":{target_port}")) {
        return None;
    }
    Some(DiscoveredProcess {
        pid,
        command: columns.first().unwrap_or(&"unknown").to_string(),
        cwd: None,
        port: Some(target_port),
    })
}

fn parse_ps_line(line: &str) -> Option<DiscoveredProcess> {
    let trimmed = line.trim();
    let (pid, command) = trimmed.split_once(' ')?;
    Some(DiscoveredProcess {
        pid: pid.trim().parse::<u32>().ok()?,
        command: command.trim().to_string(),
        cwd: None,
        port: None,
    })
}

fn total_memory_mb() -> Option<u64> {
    let output = Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()?;
    let bytes = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(bytes / 1024 / 1024)
}
