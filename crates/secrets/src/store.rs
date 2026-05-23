use crate::{SecretMaterial, SecretMetadata, SecretRef, SecretResult};
use std::collections::BTreeMap;
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
