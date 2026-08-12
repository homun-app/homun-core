use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Configuration for retry with exponential backoff and jitter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetryConfig {
    pub max_retries: u32,
    pub base_backoff_ms: u64,
    pub max_backoff_ms: u64,
    pub jitter_factor: f64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_backoff_ms: 1000,
            max_backoff_ms: 30_000,
            jitter_factor: 0.5,
        }
    }
}

impl RetryConfig {
    /// Compute backoff duration for a given attempt (0-indexed).
    pub fn backoff(&self, attempt: u32) -> Duration {
        let base = self.base_backoff_ms as f64 * (2_f64).powi(attempt as i32);
        let capped = base.min(self.max_backoff_ms as f64);
        let jitter_range = capped * self.jitter_factor;
        let jitter = jitter_range * pseudo_random_jitter(attempt);
        Duration::from_millis((capped + jitter) as u64)
    }
}

/// Deterministic pseudo-random jitter in [0.0, 1.0) based on attempt number.
/// Uses a simple hash so tests are reproducible without pulling in a rand crate.
fn pseudo_random_jitter(attempt: u32) -> f64 {
    let hash = (attempt as u64)
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1)
        >> 33;
    (hash as f64) / (u32::MAX as f64)
}

/// Circuit breaker states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitState {
    Closed,
    Open,
    HalfOpen,
}

/// Per-provider state tracked by the circuit breaker.
#[derive(Debug, Clone)]
struct ProviderState {
    state: CircuitState,
    consecutive_failures: u32,
    last_failure_time: Option<Instant>,
}

impl Default for ProviderState {
    fn default() -> Self {
        Self {
            state: CircuitState::Closed,
            consecutive_failures: 0,
            last_failure_time: None,
        }
    }
}

/// Circuit breaker that tracks consecutive failures per model provider.
///
/// State machine: Closed → Open (after threshold) → HalfOpen (after cooldown)
/// → Closed (probe succeeds) or Open (probe fails).
#[derive(Debug)]
pub struct CircuitBreaker {
    states: Mutex<HashMap<String, ProviderState>>,
    failure_threshold: u32,
    cooldown_seconds: u64,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(5, 60)
    }
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, cooldown_seconds: u64) -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
            failure_threshold,
            cooldown_seconds,
        }
    }

    /// Returns `true` if the circuit allows a request for the given provider.
    ///
    /// - Closed: always allow.
    /// - Open: allow only if cooldown has elapsed (transition to HalfOpen).
    /// - HalfOpen: allow (one probe request).
    pub fn allow_request(&self, provider: &str) -> bool {
        let mut states = self.states.lock().unwrap();
        let entry = states.entry(provider.to_string()).or_default();
        match entry.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                if let Some(last_failure) = entry.last_failure_time
                    && last_failure.elapsed() >= Duration::from_secs(self.cooldown_seconds)
                {
                    entry.state = CircuitState::HalfOpen;
                    return true;
                }
                false
            }
            CircuitState::HalfOpen => true,
        }
    }

    /// Record a successful request — closes the circuit.
    pub fn record_success(&self, provider: &str) {
        let mut states = self.states.lock().unwrap();
        let entry = states.entry(provider.to_string()).or_default();
        entry.state = CircuitState::Closed;
        entry.consecutive_failures = 0;
    }

    /// Record a failed request — may open the circuit.
    pub fn record_failure(&self, provider: &str) {
        let mut states = self.states.lock().unwrap();
        let entry = states.entry(provider.to_string()).or_default();
        entry.consecutive_failures += 1;
        entry.last_failure_time = Some(Instant::now());
        match entry.state {
            CircuitState::HalfOpen => {
                entry.state = CircuitState::Open;
            }
            CircuitState::Closed => {
                if entry.consecutive_failures >= self.failure_threshold {
                    entry.state = CircuitState::Open;
                }
            }
            CircuitState::Open => {}
        }
    }

    /// Snapshot of the current circuit state for a provider.
    pub fn state(&self, provider: &str) -> CircuitState {
        let states = self.states.lock().unwrap();
        states
            .get(provider)
            .map(|e| e.state)
            .unwrap_or(CircuitState::Closed)
    }

    /// Number of consecutive failures recorded for a provider.
    pub fn consecutive_failures(&self, provider: &str) -> u32 {
        let states = self.states.lock().unwrap();
        states
            .get(provider)
            .map(|e| e.consecutive_failures)
            .unwrap_or(0)
    }
}
