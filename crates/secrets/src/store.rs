use crate::{
    EncryptedSecretPayload, SecretKeyProvider, SecretMaterial, SecretMetadata, SecretRef,
    SecretResult, decrypt_secret, encrypt_secret,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub trait SecretStore {
    fn put(&self, reference: SecretRef, material: SecretMaterial) -> SecretResult<SecretMetadata>;
    fn get(&self, reference: &SecretRef) -> SecretResult<Option<SecretMaterial>>;
    fn delete(&self, reference: &SecretRef) -> SecretResult<()>;
    fn metadata(&self, reference: &SecretRef) -> SecretResult<Option<SecretMetadata>>;
}

#[derive(Default)]
pub struct InMemorySecretStore {
    entries: Mutex<BTreeMap<SecretRef, (Option<SecretMaterial>, SecretMetadata)>>,
}

pub struct EncryptedFileSecretStore<K> {
    path: PathBuf,
    key_provider: K,
    entries: Mutex<BTreeMap<SecretRef, EncryptedSecretRecord>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct EncryptedSecretRecord {
    metadata: SecretMetadata,
    encrypted: Option<EncryptedSecretPayload>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct EncryptedSecretFile {
    version: u32,
    secrets: Vec<EncryptedSecretRecord>,
}

impl<K: SecretKeyProvider> EncryptedFileSecretStore<K> {
    pub fn open(path: impl AsRef<Path>, key_provider: K) -> SecretResult<Self> {
        let path = path.as_ref().to_path_buf();
        let mut entries = BTreeMap::new();
        if path.exists() {
            let file = fs::read_to_string(&path)?;
            if !file.trim().is_empty() {
                let parsed: EncryptedSecretFile = serde_json::from_str(&file)?;
                for record in parsed.secrets {
                    entries.insert(record.metadata.reference.clone(), record);
                }
            }
        }
        Ok(Self {
            path,
            key_provider,
            entries: Mutex::new(entries),
        })
    }

    /// All stored references (any status). Lets callers find a secret saved under a
    /// different scope than expected (e.g. a provider key saved while a project was
    /// active, read back from another workspace).
    pub fn references(&self) -> Vec<SecretRef> {
        self.entries
            .lock()
            .map(|entries| entries.keys().cloned().collect())
            .unwrap_or_default()
    }

    fn persist(&self, entries: &BTreeMap<SecretRef, EncryptedSecretRecord>) -> SecretResult<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = EncryptedSecretFile {
            version: 1,
            secrets: entries.values().cloned().collect(),
        };
        fs::write(&self.path, serde_json::to_vec_pretty(&file)?)?;
        Ok(())
    }
}

impl SecretStore for InMemorySecretStore {
    fn put(&self, reference: SecretRef, material: SecretMaterial) -> SecretResult<SecretMetadata> {
        let mut entries = self.entries.lock().expect("secret store lock poisoned");
        let metadata = entries
            .get(&reference)
            .map(|(_, metadata)| metadata.clone().rotated())
            .unwrap_or_else(|| SecretMetadata::new(reference.clone()));
        entries.insert(reference, (Some(material), metadata.clone()));
        Ok(metadata)
    }

    fn get(&self, reference: &SecretRef) -> SecretResult<Option<SecretMaterial>> {
        let entries = self.entries.lock().expect("secret store lock poisoned");
        Ok(entries
            .get(reference)
            .and_then(|(material, _)| material.clone()))
    }

    fn delete(&self, reference: &SecretRef) -> SecretResult<()> {
        let mut entries = self.entries.lock().expect("secret store lock poisoned");
        if let Some((_material, metadata)) = entries.remove(reference) {
            entries.insert(reference.clone(), (None, metadata.deleted()));
        }
        Ok(())
    }

    fn metadata(&self, reference: &SecretRef) -> SecretResult<Option<SecretMetadata>> {
        let entries = self.entries.lock().expect("secret store lock poisoned");
        Ok(entries.get(reference).map(|(_, metadata)| metadata.clone()))
    }
}

impl<K: SecretKeyProvider> SecretStore for EncryptedFileSecretStore<K> {
    fn put(&self, reference: SecretRef, material: SecretMaterial) -> SecretResult<SecretMetadata> {
        let mut entries = self.entries.lock().expect("secret store lock poisoned");
        let metadata = entries
            .get(&reference)
            .map(|record| record.metadata.clone().rotated())
            .unwrap_or_else(|| SecretMetadata::new(reference.clone()));
        let encrypted = encrypt_secret(&self.key_provider, &reference, &material)?;
        entries.insert(
            reference,
            EncryptedSecretRecord {
                metadata: metadata.clone(),
                encrypted: Some(encrypted),
            },
        );
        self.persist(&entries)?;
        Ok(metadata)
    }

    fn get(&self, reference: &SecretRef) -> SecretResult<Option<SecretMaterial>> {
        let entries = self.entries.lock().expect("secret store lock poisoned");
        let Some(record) = entries.get(reference) else {
            return Ok(None);
        };
        let Some(encrypted) = &record.encrypted else {
            return Ok(None);
        };
        Ok(Some(decrypt_secret(
            &self.key_provider,
            reference,
            encrypted,
        )?))
    }

    fn delete(&self, reference: &SecretRef) -> SecretResult<()> {
        let mut entries = self.entries.lock().expect("secret store lock poisoned");
        if let Some(record) = entries.get(reference).cloned() {
            entries.insert(
                reference.clone(),
                EncryptedSecretRecord {
                    metadata: record.metadata.deleted(),
                    encrypted: None,
                },
            );
            self.persist(&entries)?;
        }
        Ok(())
    }

    fn metadata(&self, reference: &SecretRef) -> SecretResult<Option<SecretMetadata>> {
        let entries = self.entries.lock().expect("secret store lock poisoned");
        Ok(entries.get(reference).map(|record| record.metadata.clone()))
    }
}
