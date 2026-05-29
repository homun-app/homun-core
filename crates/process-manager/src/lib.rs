//! Local process supervision for sidecars and helper runtimes.

mod discovery;
mod error;
mod health;
mod log_buffer;
mod manager;
mod sidecars;
mod store;
mod supervisor;
mod types;

pub use discovery::{LocalRuntimeDiscovery, RuntimeDiscoveryProbe};
pub use error::{ProcessManagerError, ProcessManagerResult};
pub use health::{DefaultHealthProbe, HealthProbe, HealthProbeResult, evaluate_health};
pub use log_buffer::{LogBuffer, LogEntry, LogStream};
pub use manager::{ProcessDetail, ProcessManager};
pub use sidecars::{McpProcessConfig, SidecarProcessCatalog};
pub use store::ProcessRegistryStore;
pub use supervisor::{FakeProcessSupervisor, LocalProcessSupervisor, ProcessSupervisor};
pub use types::{
    DiscoveredProcess, HealthCheck, ProcessKind, ProcessSnapshot, ProcessSpec, ProcessStatus,
    RestartPolicy, RuntimeControlSnapshot, RuntimeControlStatus, RuntimeResourceSnapshot,
};
