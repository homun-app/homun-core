use local_first_desktop_gateway::browser_checkpoint::BrowserCheckpointSecretStore;
use local_first_secrets::{DevelopmentSecretKeyProvider, EncryptedFileSecretStore};
use std::fs;

/// 32-byte local key for at-rest secret encryption, generated once into a 0600
/// file. Connection API keys are encrypted with this; only `secret_ref`s live in
/// the registry DB.
pub(crate) fn gateway_secret_key_seed() -> Result<[u8; 32], std::io::Error> {
    let path = crate::gateway_paths::gateway_data_dir()?.join("secret-key");
    if let Ok(bytes) = fs::read(&path)
        && let Some(seed) = seed_from_existing_bytes(&bytes)
    {
        return Ok(seed);
    }
    let seed = generate_secret_key_seed();
    crate::gateway_file_security::write_private_file(&path, &seed)?;
    Ok(seed)
}

fn seed_from_existing_bytes(bytes: &[u8]) -> Option<[u8; 32]> {
    if bytes.len() != 32 {
        return None;
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(bytes);
    Some(seed)
}

fn generate_secret_key_seed() -> [u8; 32] {
    let mut seed = [0u8; 32];
    seed[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    seed
}

pub(crate) fn open_gateway_secret_store()
-> Result<EncryptedFileSecretStore<DevelopmentSecretKeyProvider>, std::io::Error> {
    let seed = gateway_secret_key_seed()?;
    let base = crate::gateway_paths::gateway_data_dir()?;
    EncryptedFileSecretStore::open(
        base.join("secrets.json"),
        DevelopmentSecretKeyProvider::new(seed),
    )
    .map_err(|error| std::io::Error::other(error.to_string()))
}

pub(crate) fn open_browser_checkpoint_secret_store()
-> Result<BrowserCheckpointSecretStore, std::io::Error> {
    let seed = gateway_secret_key_seed()?;
    let base = crate::gateway_paths::gateway_data_dir()?;
    BrowserCheckpointSecretStore::open(base.join("browser-checkpoint-secrets.json"), seed)
        .map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_from_existing_bytes_accepts_exactly_32_bytes() {
        assert_eq!(seed_from_existing_bytes(&[3u8; 32]), Some([3u8; 32]));
        assert_eq!(seed_from_existing_bytes(&[3u8; 31]), None);
        assert_eq!(seed_from_existing_bytes(&[3u8; 33]), None);
    }

    #[test]
    fn generate_secret_key_seed_returns_32_non_zero_bytes() {
        let seed = generate_secret_key_seed();

        assert_eq!(seed.len(), 32);
        assert_ne!(seed, [0u8; 32]);
    }
}
