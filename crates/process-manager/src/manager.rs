use crate::supervisor::configured_snapshot;
use crate::{
    DefaultHealthProbe, HealthProbe, LocalProcessSupervisor, LogEntry, ProcessManagerError,
    ProcessManagerResult, ProcessRegistryStore, ProcessSnapshot, ProcessSpec, ProcessStatus,
    ProcessSupervisor, RuntimeControlSnapshot, RuntimeControlStatus, RuntimeDiscoveryProbe,
    RuntimeResourceSnapshot, evaluate_health,
};

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

    pub fn restart(&mut self, id: &str) -> ProcessManagerResult<ProcessSnapshot> {
        let spec = self.require_spec(id)?;
        let restarting =
            ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Restarting);
        self.store.record_snapshot(&restarting)?;
        let _ = self.supervisor.stop(&spec)?;
        let snapshot = self.supervisor.start(&spec)?;
        self.store.record_snapshot(&snapshot)?;
        Ok(snapshot)
    }

    pub fn check_health(&mut self, id: &str) -> ProcessManagerResult<ProcessSnapshot> {
        let spec = self.require_spec(id)?;
        let current = self.supervisor.snapshot(&spec).or_else(|_| {
            self.store
                .latest_snapshot(id)?
                .ok_or_else(|| ProcessManagerError::NotFound(id.to_string()))
        })?;
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

    pub fn runtime_control_snapshot(
        &self,
        id: &str,
        discovery: &impl RuntimeDiscoveryProbe,
    ) -> ProcessManagerResult<RuntimeControlSnapshot> {
        let spec = self.require_spec(id)?;
        let managed = self
            .store
            .latest_snapshot(id)?
            .unwrap_or_else(|| configured_snapshot(&spec));
        let port = runtime_port(&spec);
        let port_owner = port.and_then(|port| discovery.listeners_on_port(port).into_iter().next());
        let duplicates = discovery.matching_processes(&runtime_needle(&spec));
        let resource_pid = managed
            .pid
            .or_else(|| port_owner.as_ref().map(|process| process.pid));
        let resources = resource_pid
            .and_then(|pid| discovery.resources_for_pid(pid))
            .unwrap_or_else(RuntimeResourceSnapshot::empty);
        let status = runtime_control_status(&managed, port_owner.as_ref(), &duplicates);
        let message = runtime_control_message(&status);

        Ok(RuntimeControlSnapshot {
            process_id: id.to_string(),
            status,
            managed,
            port,
            port_owner,
            duplicates,
            resources,
            message,
        })
    }

    pub fn ensure_runtime_started(
        &mut self,
        id: &str,
        discovery: &impl RuntimeDiscoveryProbe,
    ) -> ProcessManagerResult<ProcessSnapshot> {
        let spec = self.require_spec(id)?;
        let control = self.runtime_control_snapshot(id, discovery)?;
        match control.status {
            RuntimeControlStatus::Configured
            | RuntimeControlStatus::Stopped
            | RuntimeControlStatus::Unhealthy => self.start(id),
            RuntimeControlStatus::ManagedRunning => match self.supervisor.snapshot(&spec) {
                Ok(snapshot) if snapshot.status == ProcessStatus::Running => {
                    self.store.record_snapshot(&snapshot)?;
                    Ok(snapshot)
                }
                Ok(snapshot) => {
                    self.store.record_snapshot(&snapshot)?;
                    if control.port_owner.is_some() {
                        Ok(snapshot)
                    } else {
                        self.start(id)
                    }
                }
                Err(_) if control.port_owner.is_some() => Ok(control.managed),
                Err(_) => {
                    let stopped =
                        ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Stopped);
                    self.store.record_snapshot(&stopped)?;
                    self.start(id)
                }
            },
            RuntimeControlStatus::ExternalRunning
            | RuntimeControlStatus::Ready
            | RuntimeControlStatus::DuplicateConflict => Ok(control.managed),
        }
    }

    fn require_spec(&self, id: &str) -> ProcessManagerResult<ProcessSpec> {
        self.store
            .get_spec(id)?
            .ok_or_else(|| ProcessManagerError::NotFound(id.to_string()))
    }
}

impl<H: HealthProbe> ProcessManager<LocalProcessSupervisor, H> {
    pub fn logs(&self, id: &str, limit: usize) -> ProcessManagerResult<Vec<LogEntry>> {
        let mut logs = self.supervisor.logs(id)?;
        if logs.len() > limit {
            logs = logs.split_off(logs.len() - limit);
        }
        Ok(logs)
    }
}

fn runtime_control_status(
    managed: &ProcessSnapshot,
    port_owner: Option<&crate::DiscoveredProcess>,
    duplicates: &[crate::DiscoveredProcess],
) -> RuntimeControlStatus {
    if duplicates.len() > 1 {
        return RuntimeControlStatus::DuplicateConflict;
    }
    match managed.status {
        ProcessStatus::Healthy => RuntimeControlStatus::Ready,
        ProcessStatus::Running | ProcessStatus::Starting | ProcessStatus::Restarting => {
            RuntimeControlStatus::ManagedRunning
        }
        ProcessStatus::Unhealthy | ProcessStatus::Failed => RuntimeControlStatus::Unhealthy,
        ProcessStatus::Stopped | ProcessStatus::Exited => {
            if port_owner.is_some() {
                RuntimeControlStatus::ExternalRunning
            } else {
                RuntimeControlStatus::Stopped
            }
        }
        ProcessStatus::Configured => {
            if port_owner.is_some() {
                RuntimeControlStatus::ExternalRunning
            } else {
                RuntimeControlStatus::Configured
            }
        }
    }
}

fn runtime_control_message(status: &RuntimeControlStatus) -> String {
    match status {
        RuntimeControlStatus::Configured => "runtime configured, not running".to_string(),
        RuntimeControlStatus::ManagedRunning => "managed runtime process is running".to_string(),
        RuntimeControlStatus::ExternalRunning => {
            "runtime port is already served by an external process".to_string()
        }
        RuntimeControlStatus::Ready => "runtime is healthy".to_string(),
        RuntimeControlStatus::Unhealthy => "runtime health check failed".to_string(),
        RuntimeControlStatus::DuplicateConflict => {
            "multiple runtime processes detected; resolve duplicates before starting".to_string()
        }
        RuntimeControlStatus::Stopped => "runtime stopped".to_string(),
    }
}

fn runtime_port(spec: &ProcessSpec) -> Option<u16> {
    match &spec.health_check {
        crate::HealthCheck::HttpGet { url, .. } => {
            url.rsplit_once(':')?.1.split('/').next()?.parse().ok()
        }
        _ => None,
    }
}

fn runtime_needle(spec: &ProcessSpec) -> String {
    spec.args
        .iter()
        .find(|arg| arg.contains("server.py"))
        .cloned()
        .unwrap_or_else(|| spec.command.clone())
}
