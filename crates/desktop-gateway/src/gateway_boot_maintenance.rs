//! Idempotent gateway maintenance jobs that run after `AppState` is assembled.
//!
//! Keep this module scoped to boot-time cleanup/backfill work. Recovery,
//! worker startup, and long-running background services have separate owners.

use crate::AppState;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GatewayBootMaintenanceStep {
    InitActiveWorkspaceFromDisk,
    SeedDefaultSkills,
    GcStaleTasks,
    BackfillContacts,
    BackfillMentions,
    UnifyOwnerIdentity,
    CancelHomunCheckins,
}

const GATEWAY_BOOT_MAINTENANCE_STEPS: &[GatewayBootMaintenanceStep] = &[
    GatewayBootMaintenanceStep::InitActiveWorkspaceFromDisk,
    GatewayBootMaintenanceStep::SeedDefaultSkills,
    GatewayBootMaintenanceStep::GcStaleTasks,
    GatewayBootMaintenanceStep::BackfillContacts,
    GatewayBootMaintenanceStep::BackfillMentions,
    GatewayBootMaintenanceStep::UnifyOwnerIdentity,
    GatewayBootMaintenanceStep::CancelHomunCheckins,
];

trait GatewayBootMaintenanceRunner {
    fn init_active_workspace_from_disk(&mut self);
    fn seed_default_skills(&mut self);
    fn gc_stale_tasks(&mut self);
    fn backfill_contacts(&mut self);
    fn backfill_mentions(&mut self);
    fn unify_owner_identity(&mut self);
    fn cancel_homun_checkins(&mut self);
}

struct RuntimeGatewayBootMaintenanceRunner<'a> {
    state: &'a AppState,
}

impl GatewayBootMaintenanceRunner for RuntimeGatewayBootMaintenanceRunner<'_> {
    fn init_active_workspace_from_disk(&mut self) {
        crate::init_active_workspace_from_disk();
    }

    fn seed_default_skills(&mut self) {
        crate::seed_default_skills();
    }

    fn gc_stale_tasks(&mut self) {
        crate::gateway_task_maintenance::gc_stale_tasks(self.state);
    }

    fn backfill_contacts(&mut self) {
        crate::backfill_contacts(self.state);
    }

    fn backfill_mentions(&mut self) {
        crate::backfill_mentions(self.state);
    }

    fn unify_owner_identity(&mut self) {
        crate::unify_owner_identity(self.state);
    }

    fn cancel_homun_checkins(&mut self) {
        crate::gateway_task_maintenance::cancel_homun_checkins(self.state);
    }
}

pub(crate) fn run_gateway_boot_maintenance(state: &AppState) {
    let mut runner = RuntimeGatewayBootMaintenanceRunner { state };
    run_gateway_boot_maintenance_steps(&mut runner);
}

fn run_gateway_boot_maintenance_steps(runner: &mut impl GatewayBootMaintenanceRunner) {
    for step in GATEWAY_BOOT_MAINTENANCE_STEPS {
        match step {
            GatewayBootMaintenanceStep::InitActiveWorkspaceFromDisk => {
                runner.init_active_workspace_from_disk()
            }
            GatewayBootMaintenanceStep::SeedDefaultSkills => runner.seed_default_skills(),
            GatewayBootMaintenanceStep::GcStaleTasks => runner.gc_stale_tasks(),
            GatewayBootMaintenanceStep::BackfillContacts => runner.backfill_contacts(),
            GatewayBootMaintenanceStep::BackfillMentions => runner.backfill_mentions(),
            GatewayBootMaintenanceStep::UnifyOwnerIdentity => runner.unify_owner_identity(),
            GatewayBootMaintenanceStep::CancelHomunCheckins => runner.cancel_homun_checkins(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GatewayBootMaintenanceRunner, run_gateway_boot_maintenance_steps};

    #[derive(Default)]
    struct RecordingRunner {
        calls: Vec<&'static str>,
    }

    impl GatewayBootMaintenanceRunner for RecordingRunner {
        fn init_active_workspace_from_disk(&mut self) {
            self.calls.push("init_active_workspace_from_disk");
        }

        fn seed_default_skills(&mut self) {
            self.calls.push("seed_default_skills");
        }

        fn gc_stale_tasks(&mut self) {
            self.calls.push("gc_stale_tasks");
        }

        fn backfill_contacts(&mut self) {
            self.calls.push("backfill_contacts");
        }

        fn backfill_mentions(&mut self) {
            self.calls.push("backfill_mentions");
        }

        fn unify_owner_identity(&mut self) {
            self.calls.push("unify_owner_identity");
        }

        fn cancel_homun_checkins(&mut self) {
            self.calls.push("cancel_homun_checkins");
        }
    }

    #[test]
    fn runs_gateway_boot_maintenance_in_contract_order() {
        let mut runner = RecordingRunner::default();

        run_gateway_boot_maintenance_steps(&mut runner);

        assert_eq!(
            runner.calls,
            [
                "init_active_workspace_from_disk",
                "seed_default_skills",
                "gc_stale_tasks",
                "backfill_contacts",
                "backfill_mentions",
                "unify_owner_identity",
                "cancel_homun_checkins",
            ]
        );
    }
}
