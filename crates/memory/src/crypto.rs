use crate::{UserId, WorkspaceId};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedJson {
    pub encrypted: bool,
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub trait KeyProvider: Send + Sync {
    fn key_for(&self, user_id: &UserId, workspace_id: &WorkspaceId) -> [u8; 32];
}

#[derive(Debug, Clone)]
pub struct DevelopmentKeyProvider {
    seed: [u8; 32],
}

impl DevelopmentKeyProvider {
    pub fn new(seed: [u8; 32]) -> Self {
        Self { seed }
    }
}

impl KeyProvider for DevelopmentKeyProvider {
    fn key_for(&self, user_id: &UserId, workspace_id: &WorkspaceId) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.seed);
        hasher.update(user_id.as_str().as_bytes());
        hasher.update(workspace_id.as_str().as_bytes());
        hasher.finalize().into()
    }
}

pub fn encrypt_json(
    key_provider: &dyn KeyProvider,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    value: &serde_json::Value,
) -> Result<EncryptedJson, String> {
    let key = key_provider.key_for(user_id, workspace_id);
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|error| error.to_string())?;
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let plaintext = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
        .map_err(|_| "encryption failed".to_string())?;

    Ok(EncryptedJson {
        encrypted: true,
        algorithm: "xchacha20poly1305".to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        ciphertext: base64::engine::general_purpose::STANDARD.encode(ciphertext),
    })
}

pub fn decrypt_json(
    key_provider: &dyn KeyProvider,
    user_id: &UserId,
    workspace_id: &WorkspaceId,
    encrypted: &EncryptedJson,
) -> Result<serde_json::Value, String> {
    if encrypted.algorithm != "xchacha20poly1305" || !encrypted.encrypted {
        return Err("unsupported encrypted payload".to_string());
    }
    let key = key_provider.key_for(user_id, workspace_id);
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|error| error.to_string())?;
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(&encrypted.nonce)
        .map_err(|error| error.to_string())?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|error| error.to_string())?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "decryption failed".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|error| error.to_string())
}
