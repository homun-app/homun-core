//! Secure local secret storage contracts.

mod crypto;
mod error;
mod keychain;
mod store;
mod types;

pub use crypto::{
    DevelopmentSecretKeyProvider, EncryptedSecretPayload, SecretKeyProvider, decrypt_secret,
    encrypt_secret,
};
pub use error::{SecretError, SecretResult};
pub use keychain::SystemKeychainSecretStore;
pub use store::{EncryptedFileSecretStore, InMemorySecretStore, SecretStore};
pub use types::{SecretMaterial, SecretMetadata, SecretRef, SecretStatus};
