use crate::{HealthCheck, ProcessSnapshot, ProcessSpec, ProcessStatus};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HealthProbeResult {
    pub healthy: bool,
    pub message: String,
}

impl HealthProbeResult {
    pub fn healthy(message: impl Into<String>) -> Self {
        Self {
            healthy: true,
            message: message.into(),
        }
    }

    pub fn unhealthy(message: impl Into<String>) -> Self {
        Self {
            healthy: false,
            message: message.into(),
        }
    }
}

pub trait HealthProbe {
    fn http_get(&self, url: &str, timeout_ms: u64) -> HealthProbeResult;
}

pub struct DefaultHealthProbe;

impl HealthProbe for DefaultHealthProbe {
    fn http_get(&self, url: &str, timeout_ms: u64) -> HealthProbeResult {
        let client = match reqwest::blocking::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
        {
            Ok(client) => client,
            Err(error) => return HealthProbeResult::unhealthy(error.to_string()),
        };
        match client.get(url).send() {
            Ok(response) if response.status().is_success() => {
                HealthProbeResult::healthy(format!("http {}", response.status().as_u16()))
            }
            Ok(response) => HealthProbeResult::unhealthy(format!("http {}", response.status())),
            Err(error) => HealthProbeResult::unhealthy(error.to_string()),
        }
    }
}

pub fn evaluate_health(
    spec: &ProcessSpec,
    snapshot: &ProcessSnapshot,
    probe: &dyn HealthProbe,
) -> HealthProbeResult {
    match &spec.health_check {
        HealthCheck::None => HealthProbeResult::healthy("health check disabled"),
        HealthCheck::ProcessAlive => match snapshot.status {
            ProcessStatus::Running | ProcessStatus::Healthy => {
                HealthProbeResult::healthy("process alive")
            }
            _ => HealthProbeResult::unhealthy("process is not running"),
        },
        HealthCheck::HttpGet { url, timeout_ms } => probe.http_get(url, *timeout_ms),
    }
}
