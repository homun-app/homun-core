use crate::execution_runtime::GatewayExecutionAdapter;
use std::sync::Arc;

#[derive(Clone)]
struct TaskExecutorRegistration {
    pattern: String,
    adapter: Arc<dyn GatewayExecutionAdapter>,
}

#[derive(Clone, Default)]
pub(crate) struct TaskExecutorRegistry {
    registrations: Vec<TaskExecutorRegistration>,
}

impl TaskExecutorRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn register(
        &mut self,
        pattern: impl Into<String>,
        adapter: Arc<dyn GatewayExecutionAdapter>,
    ) {
        self.registrations.push(TaskExecutorRegistration {
            pattern: pattern.into(),
            adapter,
        });
    }

    pub(crate) fn resolve(&self, task_kind: &str) -> Option<Arc<dyn GatewayExecutionAdapter>> {
        self.registrations
            .iter()
            .find(|registration| pattern_matches(&registration.pattern, task_kind))
            .map(|registration| registration.adapter.clone())
    }
}

fn pattern_matches(pattern: &str, task_kind: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return task_kind.starts_with(prefix);
    }
    pattern == task_kind
}

#[cfg(test)]
mod tests {
    use super::TaskExecutorRegistry;
    use crate::execution_runtime::{AdapterExecution, GatewayExecutionAdapter};
    use crate::{AppState, LocalTaskExecutionError};
    use local_first_execution_protocol::{ExecutionOutcome, ValidatedExecutionContract};
    use std::sync::Arc;

    struct NamedAdapter(&'static str);

    impl GatewayExecutionAdapter for NamedAdapter {
        fn name(&self) -> &'static str {
            self.0
        }

        fn execute(
            &self,
            _state: &AppState,
            _contract: &ValidatedExecutionContract,
        ) -> Result<AdapterExecution, LocalTaskExecutionError> {
            Ok(AdapterExecution::canonical(ExecutionOutcome::completed(
                serde_json::Value::Null,
            )))
        }
    }

    #[test]
    fn registry_resolves_specific_patterns_before_fallbacks() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.browser.*", Arc::new(NamedAdapter("browser")));
        registry.register("capability.*", Arc::new(NamedAdapter("capability")));
        registry.register("subagent.*", Arc::new(NamedAdapter("subagent")));
        registry.register("proactive_prompt", Arc::new(NamedAdapter("proactive")));
        registry.register("chat_turn", Arc::new(NamedAdapter("chat")));
        registry.register("local_shell_task", Arc::new(NamedAdapter("shell")));
        registry.register("*", Arc::new(NamedAdapter("local")));

        for (kind, expected) in [
            ("capability.browser.browser.snapshot", "browser"),
            ("capability.github.github.search", "capability"),
            ("subagent.MemoryAgent", "subagent"),
            ("proactive_prompt", "proactive"),
            ("chat_turn", "chat"),
            ("browser_task", "local"),
            ("unknown", "local"),
        ] {
            assert_eq!(
                registry.resolve(kind).expect("registered adapter").name(),
                expected
            );
        }
    }
}
