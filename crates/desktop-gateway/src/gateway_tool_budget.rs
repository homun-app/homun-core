//! Runtime tool budget and per-turn live-set policy.
//!
//! This owner keeps the model/tool loop limits and the progressive disclosure
//! live/deferred split out of the gateway monolith. Browser-specific budgets
//! remain in `gateway_browser_tools`; this module only owns the normal turn
//! backstops and the core tool set.

use std::env;

/// Soft round budget for a normal turn. NOT the primary control: the turn ends when
/// the MODEL stops calling tools (natural termination) or the no-progress guard trips
/// (it repeats the same calls). This is a generous backstop so a long agentic task
/// (large refactor, multi-file scaffold) isn't truncated. Env: `HOMUN_CHAT_MAX_ROUNDS`.
const MAX_TOOL_ROUNDS: usize = 40;

/// Absolute hard ceiling on rounds in ONE turn: pure anti-runaway backstop. With the
/// per-step budget doing the real bounding, this sits far above real tasks.
/// Env-overridable: `HOMUN_CHAT_HARD_CEILING`.
const HARD_ROUND_CEILING: usize = 600;

/// Native tools that are ALWAYS loaded. Everything else is deferred and discovered on demand.
const CORE_TOOL_NAMES: &[&str] = &[
    "find_capability",
    "use_computer",
    "suggest_capabilities",
    "github_search",
    "recall_memory",
    "resolve_datetime",
    "use_skill",
    "update_plan",
    "create_automation",
    "update_automation",
    "schedule_task",
    "send_message",
    "query_code_graph",
    "query_git_history",
    "read_file",
    "write_file",
    "edit_file",
    "apply_patch",
    "list_files",
    "run_in_project",
];

/// Hard anti-runaway ceiling for one turn.
pub(crate) fn hard_round_ceiling() -> usize {
    positive_usize_env("HOMUN_CHAT_HARD_CEILING").unwrap_or(HARD_ROUND_CEILING)
}

/// Soft round budget for a normal non-browser turn.
pub(crate) fn chat_max_rounds() -> usize {
    positive_usize_env("HOMUN_CHAT_MAX_ROUNDS").unwrap_or(MAX_TOOL_ROUNDS)
}

fn positive_usize_env(name: &str) -> Option<usize> {
    env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|n| *n > 0)
}

/// Which tools stay in the live, non-deferred set for this turn.
///
/// The fixed core stays live on every turn. `browse` joins only while the thread
/// holds a warm browser session or an active checkpoint, so a mid-browser task
/// can continue without making browser globally live for every thread.
pub(crate) fn tool_stays_live_this_turn(name: &str, browser_continuation_available: bool) -> bool {
    CORE_TOOL_NAMES.contains(&name) || (browser_continuation_available && name == "browse")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn clear_budget_env() {
        unsafe {
            env::remove_var("HOMUN_CHAT_MAX_ROUNDS");
            env::remove_var("HOMUN_CHAT_HARD_CEILING");
        }
    }

    #[test]
    fn normal_turn_budgets_use_defaults_without_env() {
        let _guard = env_lock().lock().expect("env lock");
        clear_budget_env();

        assert_eq!(chat_max_rounds(), 40);
        assert_eq!(hard_round_ceiling(), 600);
    }

    #[test]
    fn normal_turn_budgets_accept_positive_env_overrides() {
        let _guard = env_lock().lock().expect("env lock");
        clear_budget_env();
        unsafe {
            env::set_var("HOMUN_CHAT_MAX_ROUNDS", "75");
            env::set_var("HOMUN_CHAT_HARD_CEILING", "900");
        }

        assert_eq!(chat_max_rounds(), 75);
        assert_eq!(hard_round_ceiling(), 900);

        clear_budget_env();
    }

    #[test]
    fn normal_turn_budgets_ignore_invalid_or_zero_env_overrides() {
        let _guard = env_lock().lock().expect("env lock");
        clear_budget_env();
        unsafe {
            env::set_var("HOMUN_CHAT_MAX_ROUNDS", "0");
            env::set_var("HOMUN_CHAT_HARD_CEILING", "not-a-number");
        }

        assert_eq!(chat_max_rounds(), 40);
        assert_eq!(hard_round_ceiling(), 600);

        clear_budget_env();
    }

    #[test]
    fn live_tool_policy_keeps_core_and_browser_continuation_only() {
        assert!(tool_stays_live_this_turn("run_in_project", false));
        assert!(tool_stays_live_this_turn("run_in_project", true));
        assert!(!tool_stays_live_this_turn("browse", false));
        assert!(tool_stays_live_this_turn("browse", true));
        assert!(!tool_stays_live_this_turn("run_in_sandbox", true));
    }
}
