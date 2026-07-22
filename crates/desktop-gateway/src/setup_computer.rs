use serde::Serialize;
use std::sync::Mutex;

use crate::sandbox::ContainedComputerBootstrapPhase;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupComputerPhase {
    Idle,
    CheckingDocker,
    PreparingImage,
    StartingContainer,
    VerifyingBrowser,
    Ready,
    Failed,
}

pub fn phase_from_sandbox(phase: ContainedComputerBootstrapPhase) -> SetupComputerPhase {
    match phase {
        ContainedComputerBootstrapPhase::CheckingDocker => SetupComputerPhase::CheckingDocker,
        ContainedComputerBootstrapPhase::PreparingImage => SetupComputerPhase::PreparingImage,
        ContainedComputerBootstrapPhase::StartingContainer => SetupComputerPhase::StartingContainer,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SetupComputerStatus {
    pub phase: SetupComputerPhase,
    pub ready: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginSetup {
    Start { generation: u64 },
    AlreadyRunning,
    AlreadyReady,
}

#[derive(Debug)]
struct CoordinatorState {
    generation: u64,
    active_generation: Option<u64>,
    phase: SetupComputerPhase,
    error: Option<String>,
}

impl Default for CoordinatorState {
    fn default() -> Self {
        Self {
            generation: 0,
            active_generation: None,
            phase: SetupComputerPhase::Idle,
            error: None,
        }
    }
}

#[derive(Debug, Default)]
pub struct SetupComputerCoordinator {
    inner: Mutex<CoordinatorState>,
}

impl SetupComputerCoordinator {
    pub fn begin(&self, observed_healthy: bool) -> BeginSetup {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if observed_healthy {
            state.active_generation = None;
            state.phase = SetupComputerPhase::Ready;
            state.error = None;
            return BeginSetup::AlreadyReady;
        }
        if state.active_generation.is_some() {
            return BeginSetup::AlreadyRunning;
        }
        state.generation = state.generation.saturating_add(1);
        state.active_generation = Some(state.generation);
        state.phase = SetupComputerPhase::CheckingDocker;
        state.error = None;
        BeginSetup::Start {
            generation: state.generation,
        }
    }

    pub fn advance(&self, generation: u64, phase: SetupComputerPhase) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation == Some(generation) {
            state.phase = phase;
            state.error = None;
        }
    }

    pub fn ready(&self, generation: u64) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation == Some(generation) {
            state.active_generation = None;
            state.phase = SetupComputerPhase::Ready;
            state.error = None;
        }
    }

    pub fn fail(&self, generation: u64, message: impl Into<String>) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.active_generation == Some(generation) {
            state.active_generation = None;
            state.phase = SetupComputerPhase::Failed;
            state.error = Some(message.into());
        }
    }

    pub fn status(&self) -> SetupComputerStatus {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        SetupComputerStatus {
            phase: state.phase,
            ready: state.phase == SetupComputerPhase::Ready,
            error: state.error.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{BeginSetup, SetupComputerCoordinator, SetupComputerPhase, phase_from_sandbox};
    use crate::sandbox::ContainedComputerBootstrapPhase;

    #[test]
    fn coordinator_deduplicates_active_bootstrap() {
        let coordinator = SetupComputerCoordinator::default();

        let first = coordinator.begin(false);
        let second = coordinator.begin(false);

        assert!(matches!(first, BeginSetup::Start { generation: 1 }));
        assert_eq!(second, BeginSetup::AlreadyRunning);
    }

    #[test]
    fn coordinator_retries_after_failure_and_ignores_stale_updates() {
        let coordinator = SetupComputerCoordinator::default();
        let BeginSetup::Start { generation } = coordinator.begin(false) else {
            panic!("first bootstrap must start");
        };
        coordinator.fail(generation, "build failed");

        let BeginSetup::Start { generation: retry } = coordinator.begin(false) else {
            panic!("failed bootstrap must be retryable");
        };
        assert!(retry > generation);
        coordinator.ready(generation);

        assert_ne!(coordinator.status().phase, SetupComputerPhase::Ready);
    }

    #[test]
    fn observed_healthy_container_is_immediately_ready() {
        let coordinator = SetupComputerCoordinator::default();

        assert_eq!(coordinator.begin(true), BeginSetup::AlreadyReady);
        let status = coordinator.status();
        assert_eq!(status.phase, SetupComputerPhase::Ready);
        assert!(status.ready);
    }

    #[test]
    fn sandbox_phases_map_to_stable_setup_phases() {
        assert_eq!(
            phase_from_sandbox(ContainedComputerBootstrapPhase::CheckingDocker),
            SetupComputerPhase::CheckingDocker
        );
        assert_eq!(
            phase_from_sandbox(ContainedComputerBootstrapPhase::PreparingImage),
            SetupComputerPhase::PreparingImage
        );
        assert_eq!(
            phase_from_sandbox(ContainedComputerBootstrapPhase::StartingContainer),
            SetupComputerPhase::StartingContainer
        );
    }

    #[test]
    fn status_serializes_stable_phase_names() {
        let coordinator = SetupComputerCoordinator::default();
        let BeginSetup::Start { generation } = coordinator.begin(false) else {
            panic!("bootstrap must start");
        };
        coordinator.advance(generation, SetupComputerPhase::PreparingImage);

        let value = serde_json::to_value(coordinator.status()).expect("serialize status");
        assert_eq!(value["phase"], "preparing_image");
        assert_eq!(value["ready"], false);
    }
}
