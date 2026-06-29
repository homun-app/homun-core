use crate::{VaultRecord, VaultRecordId};
use std::collections::BTreeMap;
use std::sync::Mutex;

pub trait VaultStore {
    fn put(&self, record: VaultRecord) -> Result<(), String>;
    fn get(&self, id: &VaultRecordId) -> Result<Option<VaultRecord>, String>;
    fn delete(&self, id: &VaultRecordId) -> Result<(), String>;
}

#[derive(Default)]
pub struct InMemoryVaultStore {
    records: Mutex<BTreeMap<VaultRecordId, VaultRecord>>,
}

impl VaultStore for InMemoryVaultStore {
    fn put(&self, record: VaultRecord) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "vault store lock poisoned".to_string())?;
        records.insert(record.id.clone(), record);
        Ok(())
    }

    fn get(&self, id: &VaultRecordId) -> Result<Option<VaultRecord>, String> {
        let records = self
            .records
            .lock()
            .map_err(|_| "vault store lock poisoned".to_string())?;
        Ok(records.get(id).cloned())
    }

    fn delete(&self, id: &VaultRecordId) -> Result<(), String> {
        let mut records = self
            .records
            .lock()
            .map_err(|_| "vault store lock poisoned".to_string())?;
        records.remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{VaultCategory, VaultRecord, VaultRecordId};
    use local_first_secrets::SecretRef;

    #[test]
    fn vault_store_keeps_metadata_separate_from_secret_material() {
        let store = InMemoryVaultStore::default();
        let secret_ref = SecretRef::new("user_1", "workspace_1", "vault", "card_1").unwrap();
        let record = VaultRecord::new(
            VaultRecordId::new("vault_record_1").unwrap(),
            VaultCategory::Payments,
            "Carta personale",
            secret_ref.clone(),
            serde_json::json!({
                "network": "visa",
                "last4": "1111",
                "expires": "12/30"
            }),
        )
        .unwrap();

        store.put(record.clone()).unwrap();
        let saved = store.get(&record.id).unwrap().unwrap();

        assert_eq!(saved.secret_ref, secret_ref);
        assert_eq!(saved.metadata["last4"], "1111");
        assert!(!saved.metadata.to_string().contains("4111111111111111"));
        assert!(
            !saved
                .metadata
                .to_string()
                .to_ascii_lowercase()
                .contains("cvv")
        );
    }

    #[test]
    fn vault_record_rejects_cvv_metadata() {
        let secret_ref = SecretRef::new("user_1", "workspace_1", "vault", "card_1").unwrap();
        let err = VaultRecord::new(
            VaultRecordId::new("vault_record_1").unwrap(),
            VaultCategory::Payments,
            "Carta personale",
            secret_ref,
            serde_json::json!({"last4": "1111", "cvv": "123"}),
        )
        .unwrap_err();

        assert!(err.contains("CVV"));
    }
}
