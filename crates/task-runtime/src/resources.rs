use crate::{ResourceClass, TaskRecord, TaskRuntimeResult, TaskStatus, TaskStore};
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct ResourceLimits {
    limits: HashMap<ResourceClass, u32>,
}

impl ResourceLimits {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn conservative_defaults() -> Self {
        Self::new()
            .with_limit(ResourceClass::LlmInference, 1)
            .with_limit(ResourceClass::BrowserSession, 1)
            .with_limit(ResourceClass::GraphIndexing, 1)
            .with_limit(ResourceClass::MemoryIndexing, 1)
            .with_limit(ResourceClass::FilesystemIo, 2)
            .with_limit(ResourceClass::NetworkIo, 4)
            .with_limit(ResourceClass::ConnectorApi, 4)
            .with_limit(ResourceClass::ComputerSession, 1)
            .with_limit(ResourceClass::ShellProcess, 2)
            .with_limit(ResourceClass::BackgroundMaintenance, 1)
    }

    pub fn with_limit(mut self, class: ResourceClass, units: u32) -> Self {
        self.limits.insert(class, units);
        self
    }

    pub fn limit_for(&self, class: ResourceClass) -> Option<u32> {
        self.limits.get(&class).copied()
    }
}

pub struct ResourceGovernor {
    limits: ResourceLimits,
}

impl ResourceGovernor {
    pub fn new(limits: ResourceLimits) -> Self {
        Self { limits }
    }

    pub fn can_start(&self, store: &TaskStore, task: &TaskRecord) -> TaskRuntimeResult<bool> {
        Ok(self.unavailable_reason(store, task)?.is_none())
    }

    pub fn reserve(
        &self,
        store: &TaskStore,
        task: &TaskRecord,
        owner: &str,
    ) -> TaskRuntimeResult<()> {
        store.reserve_resources(task, owner)
    }

    pub fn release(&self, store: &TaskStore, task: &TaskRecord) -> TaskRuntimeResult<()> {
        store.release_resources(task)
    }

    pub fn mark_waiting_if_unavailable(
        &self,
        store: &TaskStore,
        task: &TaskRecord,
    ) -> TaskRuntimeResult<bool> {
        if let Some(reason) = self.unavailable_reason(store, task)? {
            store.update_task_status(
                &task.task_id,
                &task.user_id,
                &task.workspace_id,
                TaskStatus::WaitingResource,
                Some(&reason),
            )?;
            return Ok(true);
        }
        Ok(false)
    }

    fn unavailable_reason(
        &self,
        store: &TaskStore,
        task: &TaskRecord,
    ) -> TaskRuntimeResult<Option<String>> {
        for requirement in &task.resource_requirements {
            let Some(limit) = self.limits.limit_for(requirement.class) else {
                continue;
            };
            let used =
                store.resource_usage(&task.user_id, &task.workspace_id, requirement.class)?;
            let available = limit.saturating_sub(used);
            if requirement.units > available {
                return Ok(Some(format!(
                    "resource {} requires {} units but only {} available",
                    requirement.class.as_str(),
                    requirement.units,
                    available
                )));
            }
        }
        Ok(None)
    }
}
