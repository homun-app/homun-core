//! Background services started after lease-aware chat recovery.
//!
//! Keep this module scoped to post-recovery background work. The jobs below may
//! touch stores or publish runtime state, so their startup order is part of the
//! gateway boot contract.

use crate::AppState;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayBackgroundStartupStep {
    SweepStaleDatedSuggestions,
    SweepGraphOnStartup,
    VacuumAllStores,
    StartTaskExecutorWorker,
    SpawnMemoryConsolidationTick,
    SpawnEmbeddingCatchup,
    SpawnMemoryHygieneSweep,
    SpawnThreadBrowserSessionReaper,
    SpawnContainedComputerIdleReaper,
    SpawnBrowserHandoffReaper,
    SpawnConnectorEventPoller,
    StartProactivityAutoReview,
    SpawnComputerLivePublisher,
}

const GATEWAY_BACKGROUND_STARTUP_STEPS: &[GatewayBackgroundStartupStep] = &[
    GatewayBackgroundStartupStep::SweepStaleDatedSuggestions,
    GatewayBackgroundStartupStep::SweepGraphOnStartup,
    GatewayBackgroundStartupStep::VacuumAllStores,
    GatewayBackgroundStartupStep::StartTaskExecutorWorker,
    GatewayBackgroundStartupStep::SpawnMemoryConsolidationTick,
    GatewayBackgroundStartupStep::SpawnEmbeddingCatchup,
    GatewayBackgroundStartupStep::SpawnMemoryHygieneSweep,
    GatewayBackgroundStartupStep::SpawnThreadBrowserSessionReaper,
    GatewayBackgroundStartupStep::SpawnContainedComputerIdleReaper,
    GatewayBackgroundStartupStep::SpawnBrowserHandoffReaper,
    GatewayBackgroundStartupStep::SpawnConnectorEventPoller,
    GatewayBackgroundStartupStep::StartProactivityAutoReview,
    GatewayBackgroundStartupStep::SpawnComputerLivePublisher,
];

trait GatewayBackgroundStartupRunner {
    fn sweep_stale_dated_suggestions(&mut self);
    fn sweep_graph_on_startup(&mut self);
    fn vacuum_all_stores(&mut self);
    fn start_task_executor_worker(&mut self);
    fn spawn_memory_consolidation_tick(&mut self);
    fn spawn_embedding_catchup(&mut self);
    fn spawn_memory_hygiene_sweep(&mut self);
    fn spawn_thread_browser_session_reaper(&mut self);
    fn spawn_contained_computer_idle_reaper(&mut self);
    fn spawn_browser_handoff_reaper(&mut self);
    fn spawn_connector_event_poller(&mut self);
    fn start_proactivity_auto_review(&mut self);
    fn spawn_computer_live_publisher(&mut self);
}

struct RuntimeGatewayBackgroundStartupRunner {
    state: AppState,
}

impl RuntimeGatewayBackgroundStartupRunner {
    fn new(state: AppState) -> RuntimeGatewayBackgroundStartupRunner {
        RuntimeGatewayBackgroundStartupRunner { state }
    }
}

impl GatewayBackgroundStartupRunner for RuntimeGatewayBackgroundStartupRunner {
    fn sweep_stale_dated_suggestions(&mut self) {
        let st = self.state.clone();
        tokio::spawn(async move {
            crate::gateway_proactivity::sweep_stale_dated_suggestions_once(&st).await
        });
    }

    fn sweep_graph_on_startup(&mut self) {
        let st = self.state.clone();
        tokio::task::spawn_blocking(move || crate::sweep_graph_on_startup(&st));
    }

    fn vacuum_all_stores(&mut self) {
        let st = self.state.clone();
        tokio::task::spawn_blocking(move || {
            crate::vacuum_all_stores(&st);
            eprintln!("startup VACUUM: all stores compacted");
        });
    }

    fn start_task_executor_worker(&mut self) {
        crate::start_task_executor_worker(self.state.clone());
    }

    fn spawn_memory_consolidation_tick(&mut self) {
        crate::gateway_memory_background::spawn_memory_consolidation_tick(self.state.clone());
    }

    fn spawn_embedding_catchup(&mut self) {
        crate::gateway_memory_background::spawn_embedding_catchup(self.state.clone());
    }

    fn spawn_memory_hygiene_sweep(&mut self) {
        crate::gateway_memory_background::spawn_memory_hygiene_sweep(self.state.clone());
    }

    fn spawn_thread_browser_session_reaper(&mut self) {
        crate::spawn_thread_browser_session_reaper(self.state.clone());
    }

    fn spawn_contained_computer_idle_reaper(&mut self) {
        crate::spawn_contained_computer_idle_reaper(self.state.clone());
    }

    fn spawn_browser_handoff_reaper(&mut self) {
        crate::spawn_browser_handoff_reaper(self.state.clone());
    }

    fn spawn_connector_event_poller(&mut self) {
        crate::spawn_connector_event_poller(self.state.clone());
    }

    fn start_proactivity_auto_review(&mut self) {
        crate::gateway_proactivity::start_proactivity_auto_review(self.state.clone());
    }

    fn spawn_computer_live_publisher(&mut self) {
        crate::spawn_computer_live_publisher(self.state.clone());
    }
}

pub(crate) fn start_gateway_background_services(state: AppState) {
    let mut runner = RuntimeGatewayBackgroundStartupRunner::new(state);
    run_gateway_background_startup_steps(&mut runner);
}

fn run_gateway_background_startup_steps(runner: &mut impl GatewayBackgroundStartupRunner) {
    for step in GATEWAY_BACKGROUND_STARTUP_STEPS {
        match step {
            GatewayBackgroundStartupStep::SweepStaleDatedSuggestions => {
                runner.sweep_stale_dated_suggestions()
            }
            GatewayBackgroundStartupStep::SweepGraphOnStartup => runner.sweep_graph_on_startup(),
            GatewayBackgroundStartupStep::VacuumAllStores => runner.vacuum_all_stores(),
            GatewayBackgroundStartupStep::StartTaskExecutorWorker => {
                runner.start_task_executor_worker()
            }
            GatewayBackgroundStartupStep::SpawnMemoryConsolidationTick => {
                runner.spawn_memory_consolidation_tick()
            }
            GatewayBackgroundStartupStep::SpawnEmbeddingCatchup => runner.spawn_embedding_catchup(),
            GatewayBackgroundStartupStep::SpawnMemoryHygieneSweep => {
                runner.spawn_memory_hygiene_sweep()
            }
            GatewayBackgroundStartupStep::SpawnThreadBrowserSessionReaper => {
                runner.spawn_thread_browser_session_reaper()
            }
            GatewayBackgroundStartupStep::SpawnContainedComputerIdleReaper => {
                runner.spawn_contained_computer_idle_reaper()
            }
            GatewayBackgroundStartupStep::SpawnBrowserHandoffReaper => {
                runner.spawn_browser_handoff_reaper()
            }
            GatewayBackgroundStartupStep::SpawnConnectorEventPoller => {
                runner.spawn_connector_event_poller()
            }
            GatewayBackgroundStartupStep::StartProactivityAutoReview => {
                runner.start_proactivity_auto_review()
            }
            GatewayBackgroundStartupStep::SpawnComputerLivePublisher => {
                runner.spawn_computer_live_publisher()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GatewayBackgroundStartupRunner, run_gateway_background_startup_steps};

    #[derive(Default)]
    struct RecordingRunner {
        calls: Vec<&'static str>,
    }

    impl GatewayBackgroundStartupRunner for RecordingRunner {
        fn sweep_stale_dated_suggestions(&mut self) {
            self.calls.push("sweep_stale_dated_suggestions");
        }

        fn sweep_graph_on_startup(&mut self) {
            self.calls.push("sweep_graph_on_startup");
        }

        fn vacuum_all_stores(&mut self) {
            self.calls.push("vacuum_all_stores");
        }

        fn start_task_executor_worker(&mut self) {
            self.calls.push("start_task_executor_worker");
        }

        fn spawn_memory_consolidation_tick(&mut self) {
            self.calls.push("spawn_memory_consolidation_tick");
        }

        fn spawn_embedding_catchup(&mut self) {
            self.calls.push("spawn_embedding_catchup");
        }

        fn spawn_memory_hygiene_sweep(&mut self) {
            self.calls.push("spawn_memory_hygiene_sweep");
        }

        fn spawn_thread_browser_session_reaper(&mut self) {
            self.calls.push("spawn_thread_browser_session_reaper");
        }

        fn spawn_contained_computer_idle_reaper(&mut self) {
            self.calls.push("spawn_contained_computer_idle_reaper");
        }

        fn spawn_browser_handoff_reaper(&mut self) {
            self.calls.push("spawn_browser_handoff_reaper");
        }

        fn spawn_connector_event_poller(&mut self) {
            self.calls.push("spawn_connector_event_poller");
        }

        fn start_proactivity_auto_review(&mut self) {
            self.calls.push("start_proactivity_auto_review");
        }

        fn spawn_computer_live_publisher(&mut self) {
            self.calls.push("spawn_computer_live_publisher");
        }
    }

    #[test]
    fn runs_gateway_background_startup_in_contract_order() {
        let mut runner = RecordingRunner::default();

        run_gateway_background_startup_steps(&mut runner);

        assert_eq!(
            runner.calls,
            [
                "sweep_stale_dated_suggestions",
                "sweep_graph_on_startup",
                "vacuum_all_stores",
                "start_task_executor_worker",
                "spawn_memory_consolidation_tick",
                "spawn_embedding_catchup",
                "spawn_memory_hygiene_sweep",
                "spawn_thread_browser_session_reaper",
                "spawn_contained_computer_idle_reaper",
                "spawn_browser_handoff_reaper",
                "spawn_connector_event_poller",
                "start_proactivity_auto_review",
                "spawn_computer_live_publisher",
            ]
        );
    }
}
