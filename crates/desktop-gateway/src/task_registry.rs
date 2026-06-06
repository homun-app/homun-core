#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatewayTaskExecutorKind {
    CapabilityBrowser,
    CapabilityGeneric,
    Subagent,
    /// Scheduled/recurring "do this and tell me" task: runs a full agent turn on
    /// the goal and delivers the result (proactivity).
    ProactivePrompt,
    LegacyShell,
    LegacyLocal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskExecutorRegistration {
    pattern: String,
    kind: GatewayTaskExecutorKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TaskExecutorRegistry {
    registrations: Vec<TaskExecutorRegistration>,
}

impl TaskExecutorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_defaults() -> Self {
        let mut registry = Self::new();
        registry.register(
            "capability.browser.*",
            GatewayTaskExecutorKind::CapabilityBrowser,
        );
        registry.register("capability.*", GatewayTaskExecutorKind::CapabilityGeneric);
        registry.register("subagent.*", GatewayTaskExecutorKind::Subagent);
        registry.register("proactive_prompt", GatewayTaskExecutorKind::ProactivePrompt);
        registry.register("local_shell_task", GatewayTaskExecutorKind::LegacyShell);
        registry.register("*", GatewayTaskExecutorKind::LegacyLocal);
        registry
    }

    pub fn register(&mut self, pattern: impl Into<String>, kind: GatewayTaskExecutorKind) {
        self.registrations.push(TaskExecutorRegistration {
            pattern: pattern.into(),
            kind,
        });
    }

    pub fn resolve(&self, task_kind: &str) -> Option<GatewayTaskExecutorKind> {
        self.registrations
            .iter()
            .find(|registration| pattern_matches(&registration.pattern, task_kind))
            .map(|registration| registration.kind)
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
    use super::{GatewayTaskExecutorKind, TaskExecutorRegistry};

    #[test]
    fn registry_resolves_specific_patterns_before_fallbacks() {
        let registry = TaskExecutorRegistry::with_defaults();

        assert_eq!(
            registry.resolve("capability.browser.browser.snapshot"),
            Some(GatewayTaskExecutorKind::CapabilityBrowser)
        );
        assert_eq!(
            registry.resolve("capability.github.github.search"),
            Some(GatewayTaskExecutorKind::CapabilityGeneric)
        );
        assert_eq!(
            registry.resolve("subagent.MemoryAgent"),
            Some(GatewayTaskExecutorKind::Subagent)
        );
        assert_eq!(
            registry.resolve("proactive_prompt"),
            Some(GatewayTaskExecutorKind::ProactivePrompt)
        );
        // The durable browser_task executor was retired (browser is driven inline
        // by chat now); the kind falls through to the `*` LegacyLocal fallback.
        assert_eq!(
            registry.resolve("browser_task"),
            Some(GatewayTaskExecutorKind::LegacyLocal)
        );
        assert_eq!(
            registry.resolve("unknown"),
            Some(GatewayTaskExecutorKind::LegacyLocal)
        );
    }
}
