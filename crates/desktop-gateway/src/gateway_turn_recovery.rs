//! Lease-aware chat turn recovery at gateway startup.
//!
//! This module owns the critical startup ordering between process fencing,
//! projection replay, broker recovery, chat placeholder repair, and recovery
//! workers. Keep unrelated background services in `main.rs` or their own owner.

use std::future::Future;
use std::pin::Pin;

use local_first_task_runtime::TaskRecord;
use time::{Duration, OffsetDateTime};

use crate::AppState;

const AGENT_JOURNAL_RETENTION_DAYS: i64 = 30;
const AGENT_JOURNAL_RETENTION_BATCH: usize = 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayTurnRecoveryStep {
    BumpProcessGenerationAndPurgeJournal,
    DrainProjectionOutbox,
    RecoverChatTurnsFromBroker,
    MarkRecoveredMessagesRetrying,
    StartProjectionWorker,
    StartSteeringControl,
}

const GATEWAY_TURN_RECOVERY_STEPS: &[GatewayTurnRecoveryStep] = &[
    GatewayTurnRecoveryStep::BumpProcessGenerationAndPurgeJournal,
    GatewayTurnRecoveryStep::DrainProjectionOutbox,
    GatewayTurnRecoveryStep::RecoverChatTurnsFromBroker,
    GatewayTurnRecoveryStep::MarkRecoveredMessagesRetrying,
    GatewayTurnRecoveryStep::StartProjectionWorker,
    GatewayTurnRecoveryStep::StartSteeringControl,
];

trait GatewayTurnRecoveryRunner {
    fn bump_process_generation_and_purge_journal(&mut self);
    fn drain_projection_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + 'a>>;
    fn recover_chat_turns_from_broker(&mut self);
    fn mark_recovered_messages_retrying(&mut self);
    fn start_projection_worker(&mut self);
    fn start_steering_control(&mut self);
}

struct RuntimeGatewayTurnRecoveryRunner<'a> {
    state: &'a AppState,
    process_generation: u64,
    recovered_chat_turns: Vec<TaskRecord>,
}

impl RuntimeGatewayTurnRecoveryRunner<'_> {
    fn new(state: &AppState) -> RuntimeGatewayTurnRecoveryRunner<'_> {
        RuntimeGatewayTurnRecoveryRunner {
            state,
            process_generation: 0,
            recovered_chat_turns: Vec::new(),
        }
    }
}

impl GatewayTurnRecoveryRunner for RuntimeGatewayTurnRecoveryRunner<'_> {
    fn bump_process_generation_and_purge_journal(&mut self) {
        let store = self
            .state
            .task_store
            .lock()
            .expect("task store lock at boot");
        self.process_generation = store
            .bump_process_generation()
            .expect("bump process generation");
        let journal_cutoff = (OffsetDateTime::now_utc()
            - Duration::days(AGENT_JOURNAL_RETENTION_DAYS))
        .unix_timestamp();
        if let Err(error) =
            store.purge_terminal_agent_runs_before(journal_cutoff, AGENT_JOURNAL_RETENTION_BATCH)
        {
            eprintln!("agent journal: retention error: {error}");
        }
    }

    fn drain_projection_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + 'a>> {
        Box::pin(async move {
            match crate::projection_worker::drain_at_startup(self.state, self.process_generation)
                .await
            {
                Ok(replayed) if replayed > 0 => {
                    eprintln!("execution projection: drained {replayed} durable outbox rows");
                }
                Ok(_) => {}
                Err(error) => {
                    eprintln!(
                        "execution projection: startup replay deferred to worker: {}",
                        error.message
                    );
                }
            }
        })
    }

    fn recover_chat_turns_from_broker(&mut self) {
        let store = self
            .state
            .task_store
            .lock()
            .expect("task store lock at boot");
        if let Err(error) = store.abort_orphaned_running_agent_runs("gateway_restart") {
            eprintln!("agent journal: boot recovery error: {error}");
        }
        let user_id = crate::gateway_user_id();
        let workspace_id = crate::gateway_workspace_id();
        let recovered = local_first_task_runtime::broker::recover_chat_turns_at_boot(
            &store,
            &user_id,
            &workspace_id,
            self.process_generation,
        )
        .unwrap_or_else(|e| {
            eprintln!("turn broker: recovery error: {e}");
            Vec::new()
        });
        eprintln!(
            "turn broker: recovery generation={} recovered={} turns",
            self.process_generation,
            recovered.len()
        );
        self.recovered_chat_turns = recovered
            .iter()
            .filter_map(|task_id| {
                store
                    .get_task(task_id, &user_id, &workspace_id)
                    .ok()
                    .flatten()
            })
            .collect::<Vec<_>>();
    }

    fn mark_recovered_messages_retrying(&mut self) {
        for task in &self.recovered_chat_turns {
            crate::set_chat_turn_message_delivery_state(
                self.state,
                task,
                local_first_desktop_gateway::MessageDeliveryState::Retrying,
            );
        }
    }

    fn start_projection_worker(&mut self) {
        crate::projection_worker::start(self.state.clone());
    }

    fn start_steering_control(&mut self) {
        crate::steering_control::start(self.state.clone());
    }
}

pub(crate) async fn recover_gateway_chat_turns_at_startup(state: &AppState) {
    eprintln!("turn broker: the only chat path; running lease-aware boot recovery");
    let mut runner = RuntimeGatewayTurnRecoveryRunner::new(state);
    run_gateway_turn_recovery_steps(&mut runner).await;
}

async fn run_gateway_turn_recovery_steps(runner: &mut impl GatewayTurnRecoveryRunner) {
    for step in GATEWAY_TURN_RECOVERY_STEPS {
        match step {
            GatewayTurnRecoveryStep::BumpProcessGenerationAndPurgeJournal => {
                runner.bump_process_generation_and_purge_journal()
            }
            GatewayTurnRecoveryStep::DrainProjectionOutbox => {
                runner.drain_projection_outbox().await
            }
            GatewayTurnRecoveryStep::RecoverChatTurnsFromBroker => {
                runner.recover_chat_turns_from_broker()
            }
            GatewayTurnRecoveryStep::MarkRecoveredMessagesRetrying => {
                runner.mark_recovered_messages_retrying()
            }
            GatewayTurnRecoveryStep::StartProjectionWorker => runner.start_projection_worker(),
            GatewayTurnRecoveryStep::StartSteeringControl => runner.start_steering_control(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;

    use super::{GatewayTurnRecoveryRunner, run_gateway_turn_recovery_steps};

    #[derive(Default)]
    struct RecordingRunner {
        calls: Vec<&'static str>,
    }

    impl GatewayTurnRecoveryRunner for RecordingRunner {
        fn bump_process_generation_and_purge_journal(&mut self) {
            self.calls.push("bump_process_generation_and_purge_journal");
        }

        fn drain_projection_outbox<'a>(&'a mut self) -> Pin<Box<dyn Future<Output = ()> + 'a>> {
            Box::pin(async move {
                self.calls.push("drain_projection_outbox");
            })
        }

        fn recover_chat_turns_from_broker(&mut self) {
            self.calls.push("recover_chat_turns_from_broker");
        }

        fn mark_recovered_messages_retrying(&mut self) {
            self.calls.push("mark_recovered_messages_retrying");
        }

        fn start_projection_worker(&mut self) {
            self.calls.push("start_projection_worker");
        }

        fn start_steering_control(&mut self) {
            self.calls.push("start_steering_control");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn runs_gateway_turn_recovery_in_contract_order() {
        let mut runner = RecordingRunner::default();

        run_gateway_turn_recovery_steps(&mut runner).await;

        assert_eq!(
            runner.calls,
            [
                "bump_process_generation_and_purge_journal",
                "drain_projection_outbox",
                "recover_chat_turns_from_broker",
                "mark_recovered_messages_retrying",
                "start_projection_worker",
                "start_steering_control",
            ]
        );
    }
}
