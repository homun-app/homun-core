use base64::Engine as _;
use std::{env, fs};

/// Keychain service under which the vault wrap key lives (macOS).
#[cfg(target_os = "macos")]
const VAULT_WRAP_KEY_KEYCHAIN_SERVICE: &str = "homun-vault-master-wrap";

/// Load-or-create the 32-byte key that WRAPS the vault master key.
/// Precedence:
///   1. `HOMUN_VAULT_WRAP_KEY` (base64) for tests/CI.
///   2. OS keychain on macOS.
///   3. A 0600 file under the gateway data dir.
pub(crate) fn resolve_vault_wrap_key() -> Result<[u8; 32], std::io::Error> {
    if let Ok(encoded) = env::var("HOMUN_VAULT_WRAP_KEY") {
        let encoded = encoded.trim();
        if !encoded.is_empty() {
            return decode_vault_wrap_key(encoded).ok_or_else(|| {
                std::io::Error::other("HOMUN_VAULT_WRAP_KEY must be 32 base64-encoded bytes")
            });
        }
    }
    #[cfg(target_os = "macos")]
    {
        match keychain_vault_wrap_key() {
            Ok(key) => return Ok(key),
            Err(error) => {
                eprintln!(
                    "[gateway] vault wrap key: keychain unavailable ({error}); using file fallback"
                );
            }
        }
    }
    file_vault_wrap_key()
}

#[cfg(target_os = "macos")]
fn keychain_vault_wrap_key() -> Result<[u8; 32], std::io::Error> {
    use local_first_secrets::{SecretMaterial, SecretRef, SecretStore};

    let store =
        local_first_secrets::SystemKeychainSecretStore::new(VAULT_WRAP_KEY_KEYCHAIN_SERVICE);
    let reference =
        SecretRef::new("homun", "local", "vault", "master-wrap").map_err(std::io::Error::other)?;
    if let Some(material) = store.get(&reference).map_err(std::io::Error::other)? {
        let encoded = material.expose_utf8().map_err(std::io::Error::other)?;
        return decode_vault_wrap_key(encoded.trim()).ok_or_else(|| {
            std::io::Error::other(
                "vault wrap key in keychain is corrupt (expected 32 base64 bytes)",
            )
        });
    }
    let key = generate_vault_wrap_key();
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    store
        .put(reference, SecretMaterial::from_string(encoded))
        .map_err(std::io::Error::other)?;
    Ok(key)
}

/// File fallback for the vault wrap key (0600). Used on platforms without a
/// keychain backend or when the keychain is unreachable.
fn file_vault_wrap_key() -> Result<[u8; 32], std::io::Error> {
    let path = crate::gateway_paths::gateway_data_dir()?.join("vault-wrap-key");
    if let Ok(bytes) = fs::read(&path)
        && let Some(key) = decode_vault_wrap_key(String::from_utf8_lossy(&bytes).trim())
    {
        return Ok(key);
    }
    let key = generate_vault_wrap_key();
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    crate::gateway_file_security::write_private_file(&path, encoded.as_bytes())?;
    Ok(key)
}

/// Mirrors `gateway_secret_key_seed`: two UUIDv4 (getrandom-backed) = 32 bytes.
fn generate_vault_wrap_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    key
}

fn decode_vault_wrap_key(encoded: &str) -> Option<[u8; 32]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    if bytes.len() != 32 {
        return None;
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Some(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_vault_wrap_key_accepts_exactly_32_base64_bytes() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([9u8; 32]);

        assert_eq!(decode_vault_wrap_key(&encoded), Some([9u8; 32]));
        assert_eq!(decode_vault_wrap_key("not-base64"), None);
        assert_eq!(
            decode_vault_wrap_key(&base64::engine::general_purpose::STANDARD.encode([9u8; 31])),
            None
        );
    }

    #[test]
    fn generate_vault_wrap_key_returns_32_non_zero_bytes() {
        let key = generate_vault_wrap_key();

        assert_eq!(key.len(), 32);
        assert_ne!(key, [0u8; 32]);
    }
}
