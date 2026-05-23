use crate::{SecretError, SecretMaterial, SecretRef, SecretResult};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub trait SecretKeyProvider: Send + Sync {
    fn key_for(&self, reference: &SecretRef) -> [u8; 32];
}

#[derive(Debug, Clone)]
pub struct DevelopmentSecretKeyProvider {
    seed: [u8; 32],
}

impl DevelopmentSecretKeyProvider {
    pub fn new(seed: [u8; 32]) -> Self {
        Self { seed }
    }
}

impl SecretKeyProvider for DevelopmentSecretKeyProvider {
    fn key_for(&self, reference: &SecretRef) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(self.seed);
        hasher.update(reference.as_str().as_bytes());
        hasher.finalize().into()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedSecretPayload {
    pub encrypted: bool,
    pub algorithm: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn encrypt_secret(
    key_provider: &dyn SecretKeyProvider,
    reference: &SecretRef,
    material: &SecretMaterial,
) -> SecretResult<EncryptedSecretPayload> {
    let key = key_provider.key_for(reference);
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|error| SecretError::Crypto(error.to_string()))?;
    let mut nonce = [0u8; 24];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), material.expose_bytes())
        .map_err(|_| SecretError::Crypto("encryption failed".to_string()))?;

    Ok(EncryptedSecretPayload {
        encrypted: true,
        algorithm: "xchacha20poly1305".to_string(),
        nonce: base64::engine::general_purpose::STANDARD.encode(nonce),
        ciphertext: base64::engine::general_purpose::STANDARD.encode(ciphertext),
    })
}

pub fn decrypt_secret(
    key_provider: &dyn SecretKeyProvider,
    reference: &SecretRef,
    encrypted: &EncryptedSecretPayload,
) -> SecretResult<SecretMaterial> {
    if !encrypted.encrypted || encrypted.algorithm != "xchacha20poly1305" {
        return Err(SecretError::Crypto(
            "unsupported encrypted secret payload".to_string(),
        ));
    }
    let key = key_provider.key_for(reference);
    let cipher = XChaCha20Poly1305::new_from_slice(&key)
        .map_err(|error| SecretError::Crypto(error.to_string()))?;
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(&encrypted.nonce)
        .map_err(|error| SecretError::Crypto(error.to_string()))?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(&encrypted.ciphertext)
        .map_err(|error| SecretError::Crypto(error.to_string()))?;
    let plaintext = cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| SecretError::Crypto("decryption failed".to_string()))?;
    Ok(SecretMaterial::from_bytes(plaintext))
}
