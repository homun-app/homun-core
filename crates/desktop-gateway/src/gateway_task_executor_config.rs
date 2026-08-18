use std::env;

pub(crate) const TASK_EXECUTOR_MANUAL_WORKER_ID: &str = "desktop-gateway-manual-run";
pub(crate) const TASK_EXECUTOR_POLL_INTERVAL_MS: u64 = 1_000;
pub(crate) const TASK_EXECUTOR_WORKER_ID: &str = "desktop-gateway-background-worker";

/// How many independent background workers pull from the task queue. Each worker
/// owns its own lease id, so two workers never grab the same task; the
/// ResourceGovernor does the real gating. Default 3 gives useful parallelism
/// across resource classes without hammering SQLite.
pub(crate) const TASK_EXECUTOR_DEFAULT_WORKER_COUNT: usize = 3;

fn task_executor_worker_enabled_from_env(value: Option<&str>) -> bool {
    value
        .map(|raw| {
            let normalized = raw.trim().to_lowercase();
            !matches!(normalized.as_str(), "0" | "false" | "off" | "disabled")
        })
        .unwrap_or(true)
}

fn task_executor_worker_count_from_env(value: Option<&str>) -> usize {
    value
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|&count| (1..=16).contains(&count))
        .unwrap_or(TASK_EXECUTOR_DEFAULT_WORKER_COUNT)
}

pub(crate) fn task_executor_worker_enabled() -> bool {
    task_executor_worker_enabled_from_env(env::var("HOMUN_TASK_EXECUTOR_WORKER").ok().as_deref())
}

pub(crate) fn task_executor_worker_count() -> usize {
    task_executor_worker_count_from_env(env::var("HOMUN_TASK_WORKER_COUNT").ok().as_deref())
}

/// Worker id for index `n`. Stable per index so leases survive across ticks and
/// `recover_stale_leases` can still identify ownership after a crash.
pub(crate) fn task_executor_worker_id(index: usize) -> String {
    format!("{TASK_EXECUTOR_WORKER_ID}-{index}")
}

#[cfg(test)]
mod tests {
    use super::{
        TASK_EXECUTOR_DEFAULT_WORKER_COUNT, TASK_EXECUTOR_MANUAL_WORKER_ID,
        TASK_EXECUTOR_POLL_INTERVAL_MS, task_executor_worker_count_from_env,
        task_executor_worker_enabled_from_env, task_executor_worker_id,
    };

    #[test]
    fn worker_enabled_defaults_on_and_accepts_common_disabled_values() {
        assert!(task_executor_worker_enabled_from_env(None));
        assert!(task_executor_worker_enabled_from_env(Some("1")));
        assert!(!task_executor_worker_enabled_from_env(Some("0")));
        assert!(!task_executor_worker_enabled_from_env(Some(" false ")));
        assert!(!task_executor_worker_enabled_from_env(Some("off")));
        assert!(!task_executor_worker_enabled_from_env(Some("DISABLED")));
    }

    #[test]
    fn worker_count_clamps_and_defaults() {
        assert_eq!(task_executor_worker_count_from_env(Some("5")), 5);
        assert_eq!(
            task_executor_worker_count_from_env(Some("0")),
            TASK_EXECUTOR_DEFAULT_WORKER_COUNT
        );
        assert_eq!(
            task_executor_worker_count_from_env(Some("99")),
            TASK_EXECUTOR_DEFAULT_WORKER_COUNT
        );
        assert_eq!(
            task_executor_worker_count_from_env(None),
            TASK_EXECUTOR_DEFAULT_WORKER_COUNT
        );
    }

    #[test]
    fn worker_id_is_stable_per_index() {
        assert_eq!(
            task_executor_worker_id(0),
            "desktop-gateway-background-worker-0"
        );
        assert_eq!(
            task_executor_worker_id(2),
            "desktop-gateway-background-worker-2"
        );
    }

    #[test]
    fn manual_worker_and_poll_interval_are_stable() {
        assert_eq!(TASK_EXECUTOR_MANUAL_WORKER_ID, "desktop-gateway-manual-run");
        assert_eq!(TASK_EXECUTOR_POLL_INTERVAL_MS, 1_000);
    }
}
