//! Secure local secret storage contracts.

mod error;
mod store;
mod types;

pub use error::{SecretError, SecretResult};
pub use store::{InMemorySecretStore, SecretStore};
pub use types::{SecretMaterial, SecretMetadata, SecretRef, SecretStatus};
