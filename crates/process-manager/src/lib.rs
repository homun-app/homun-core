//! Local process supervision for sidecars and helper runtimes.

mod error;
mod health;
mod log_buffer;
mod manager;
mod store;
mod supervisor;
mod types;

pub use error::{ProcessManagerError, ProcessManagerResult};
pub use health::{DefaultHealthProbe, HealthProbe, HealthProbeResult, evaluate_health};
pub use log_buffer::{LogBuffer, LogEntry, LogStream};
pub use manager::{ProcessDetail, ProcessManager};
pub use store::ProcessRegistryStore;
pub use supervisor::{FakeProcessSupervisor, LocalProcessSupervisor, ProcessSupervisor};
pub use types::{
    HealthCheck, ProcessKind, ProcessSnapshot, ProcessSpec, ProcessStatus, RestartPolicy,
};
