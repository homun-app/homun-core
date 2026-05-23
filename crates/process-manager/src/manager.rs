use crate::{
    DefaultHealthProbe, HealthProbe, ProcessManagerError, ProcessManagerResult,
    ProcessRegistryStore, ProcessSnapshot, ProcessSpec, ProcessStatus, ProcessSupervisor,
    evaluate_health,
};
use crate::supervisor::configured_snapshot;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessDetail {
    pub spec: ProcessSpec,
    pub snapshot: ProcessSnapshot,
}

pub struct ProcessManager<S, H = DefaultHealthProbe> {
    store: ProcessRegistryStore,
    supervisor: S,
    health_probe: H,
}

impl<S: ProcessSupervisor> ProcessManager<S, DefaultHealthProbe> {
    pub fn new(store: ProcessRegistryStore, supervisor: S) -> Self {
        Self {
            store,
            supervisor,
            health_probe: DefaultHealthProbe,
        }
    }
}

impl<S: ProcessSupervisor, H: HealthProbe> ProcessManager<S, H> {
    pub fn with_health_probe(store: ProcessRegistryStore, supervisor: S, health_probe: H) -> Self {
        Self {
            store,
            supervisor,
            health_probe,
        }
    }

    pub fn register(&self, spec: ProcessSpec) -> ProcessManagerResult<()> {
        self.store.upsert_spec(&spec)?;
        self.store.record_snapshot(&configured_snapshot(&spec))?;
        Ok(())
    }

    pub fn start(&mut self, id: &str) -> ProcessManagerResult<ProcessSnapshot> {
        let spec = self.require_spec(id)?;
        let snapshot = self.supervisor.start(&spec)?;
        self.store.record_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    pub fn stop(&mut self, id: &str) -> ProcessManagerResult<ProcessSnapshot> {
        let spec = self.require_spec(id)?;
        let snapshot = self.supervisor.stop(&spec)?;
        self.store.record_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    pub fn check_health(&mut self, id: &str) -> ProcessManagerResult<ProcessSnapshot> {
        let spec = self.require_spec(id)?;
        let current = self
            .supervisor
            .snapshot(&spec)
            .or_else(|_| self.store.latest_snapshot(id)?.ok_or_else(|| ProcessManagerError::NotFound(id.to_string())))?;
        let health = evaluate_health(&spec, &current, &self.health_probe);
        let mut snapshot = current;
        snapshot.status = if health.healthy {
            ProcessStatus::Healthy
        } else {
            ProcessStatus::Unhealthy
        };
        snapshot.message = Some(health.message);
        self.store.record_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    pub fn detail(&self, id: &str) -> ProcessManagerResult<Option<ProcessDetail>> {
        let Some(spec) = self.store.get_spec(id)? else {
            return Ok(None);
        };
        let snapshot = self
            .store
            .latest_snapshot(id)?
            .unwrap_or_else(|| configured_snapshot(&spec));
        Ok(Some(ProcessDetail { spec, snapshot }))
    }

    fn require_spec(&self, id: &str) -> ProcessManagerResult<ProcessSpec> {
        self.store
            .get_spec(id)?
            .ok_or_else(|| ProcessManagerError::NotFound(id.to_string()))
    }
}
