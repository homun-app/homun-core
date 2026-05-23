use crate::{ProcessKind, ProcessManagerError, ProcessManagerResult, ProcessSnapshot, ProcessSpec, ProcessStatus};
use std::collections::{BTreeMap, BTreeSet};

pub trait ProcessSupervisor {
    fn start(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot>;
    fn stop(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot>;
    fn snapshot(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot>;
}

#[derive(Default)]
pub struct FakeProcessSupervisor {
    running: BTreeSet<String>,
    pids: BTreeMap<String, u32>,
    next_pid: u32,
}

impl ProcessSupervisor for FakeProcessSupervisor {
    fn start(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        if self.next_pid == 0 {
            self.next_pid = 10_001;
        }
        let pid = *self.pids.entry(spec.id.clone()).or_insert_with(|| {
            let pid = self.next_pid;
            self.next_pid += 1;
            pid
        });
        self.running.insert(spec.id.clone());
        Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running).with_pid(pid))
    }

    fn stop(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        self.running.remove(&spec.id);
        Ok(ProcessSnapshot::new(
            &spec.id,
            spec.kind.clone(),
            ProcessStatus::Stopped,
        ))
    }

    fn snapshot(&mut self, spec: &ProcessSpec) -> ProcessManagerResult<ProcessSnapshot> {
        if self.running.contains(&spec.id) {
            Ok(ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Running)
                .with_pid(*self.pids.get(&spec.id).unwrap_or(&10_001)))
        } else {
            Err(ProcessManagerError::NotFound(spec.id.clone()))
        }
    }
}

pub(crate) fn configured_snapshot(spec: &ProcessSpec) -> ProcessSnapshot {
    ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Configured)
}

#[allow(dead_code)]
pub(crate) fn failed_snapshot(spec: &ProcessSpec, message: impl Into<String>) -> ProcessSnapshot {
    ProcessSnapshot::new(&spec.id, spec.kind.clone(), ProcessStatus::Failed).with_message(message)
}

#[allow(dead_code)]
fn _kind_used(_kind: ProcessKind) {}
