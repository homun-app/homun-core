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
        let pattern = pattern.into();
        assert!(
            pattern != "*",
            "catch-all execution adapters are forbidden; register an exact or prefix kind"
        );
        self.registrations
            .push(TaskExecutorRegistration { pattern, adapter });
    }

    pub(crate) fn resolve(&self, task_kind: &str) -> Option<Arc<dyn GatewayExecutionAdapter>> {
        self.registrations
            .iter()
            .find(|registration| pattern_matches(&registration.pattern, task_kind))
            .map(|registration| registration.adapter.clone())
    }
}

fn pattern_matches(pattern: &str, task_kind: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        return task_kind.starts_with(prefix);
    }
    pattern == task_kind
}

#[cfg(test)]
mod tests {
    use super::TaskExecutorRegistry;
    use crate::LocalTaskExecutionError;
    use crate::execution_adapter_context::ExecutionAdapterContext;
    use crate::execution_runtime::GatewayExecutionAdapter;
    use local_first_execution_protocol::ExecutionOutcome;
    use std::sync::Arc;

    struct NamedAdapter(&'static str);

    impl GatewayExecutionAdapter for NamedAdapter {
        fn name(&self) -> &'static str {
            self.0
        }

        fn execute(
            &self,
            _context: &ExecutionAdapterContext,
        ) -> Result<ExecutionOutcome, LocalTaskExecutionError> {
            Ok(ExecutionOutcome::completed(serde_json::Value::Null))
        }
    }

    #[test]
    fn registry_resolves_only_explicit_patterns() {
        let mut registry = TaskExecutorRegistry::new();
        registry.register("capability.browser.*", Arc::new(NamedAdapter("browser")));
        registry.register("capability.*", Arc::new(NamedAdapter("capability")));
        registry.register("subagent.*", Arc::new(NamedAdapter("subagent")));
        registry.register("proactive_prompt", Arc::new(NamedAdapter("proactive")));
        registry.register("chat_turn", Arc::new(NamedAdapter("chat")));
        registry.register("local_shell_task", Arc::new(NamedAdapter("shell")));
        for (kind, expected) in [
            ("capability.browser.browser.snapshot", "browser"),
            ("capability.github.github.search", "capability"),
            ("subagent.MemoryAgent", "subagent"),
            ("proactive_prompt", "proactive"),
            ("chat_turn", "chat"),
        ] {
            assert_eq!(
                registry.resolve(kind).expect("registered adapter").name(),
                expected
            );
        }
        assert!(registry.resolve("browser_task").is_none());
        assert!(registry.resolve("unknown").is_none());
    }

    #[test]
    fn registry_rejects_catch_all_registration() {
        let mut registry = TaskExecutorRegistry::new();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            registry.register("*", Arc::new(NamedAdapter("fallback")));
        }));

        assert!(result.is_err(), "catch-all adapters must fail closed");
    }
}
