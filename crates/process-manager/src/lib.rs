//! Local process supervision for sidecars and helper runtimes.

mod error;
mod store;
mod types;

pub use error::{ProcessManagerError, ProcessManagerResult};
pub use store::ProcessRegistryStore;
pub use types::{
    HealthCheck, ProcessKind, ProcessSnapshot, ProcessSpec, ProcessStatus, RestartPolicy,
};
