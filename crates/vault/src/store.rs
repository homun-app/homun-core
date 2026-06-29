use crate::{VaultRecord, VaultRecordId};
use local_first_secrets::SecretRef;
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
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

pub struct SQLiteVaultStore {
    conn: Mutex<Connection>,
}

impl SQLiteVaultStore {
    pub fn open_in_memory() -> Result<Self, String> {
        let store = Self {
            conn: Mutex::new(Connection::open_in_memory().map_err(|error| error.to_string())?),
        };
        store.init()?;
        Ok(store)
    }

    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let store = Self {
            conn: Mutex::new(Connection::open(path).map_err(|error| error.to_string())?),
        };
        store.init()?;
        Ok(store)
    }

    fn init(&self) -> Result<(), String> {
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute_batch(
                "create table if not exists vault_records (
                    id text primary key,
                    category text not null,
                    label text not null,
                    secret_ref text not null,
                    metadata_json text not null,
                    created_at text not null default CURRENT_TIMESTAMP,
                    updated_at text not null default CURRENT_TIMESTAMP
                );",
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
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

impl VaultStore for SQLiteVaultStore {
    fn put(&self, record: VaultRecord) -> Result<(), String> {
        let metadata_json =
            serde_json::to_string(&record.metadata).map_err(|error| error.to_string())?;
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute(
                "insert into vault_records (id, category, label, secret_ref, metadata_json)
                 values (?1, ?2, ?3, ?4, ?5)
                 on conflict(id) do update set
                    category=excluded.category,
                    label=excluded.label,
                    secret_ref=excluded.secret_ref,
                    metadata_json=excluded.metadata_json,
                    updated_at=CURRENT_TIMESTAMP",
                params![
                    record.id.to_string(),
                    category_key(record.category),
                    record.label,
                    record.secret_ref.to_string(),
                    metadata_json
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn get(&self, id: &VaultRecordId) -> Result<Option<VaultRecord>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "select id, category, label, secret_ref, metadata_json
                 from vault_records where id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = stmt
            .query(params![id.to_string()])
            .map_err(|error| error.to_string())?;
        let Some(row) = rows.next().map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        let record_id = VaultRecordId::from_str(
            row.get::<_, String>(0)
                .map_err(|error| error.to_string())?
                .as_str(),
        )?;
        let category = category_from_key(
            row.get::<_, String>(1)
                .map_err(|error| error.to_string())?
                .as_str(),
        )?;
        let label = row.get::<_, String>(2).map_err(|error| error.to_string())?;
        let secret_ref = SecretRef::from_str(
            row.get::<_, String>(3)
                .map_err(|error| error.to_string())?
                .as_str(),
        )
        .map_err(|error| error.to_string())?;
        let metadata = serde_json::from_str(
            row.get::<_, String>(4)
                .map_err(|error| error.to_string())?
                .as_str(),
        )
        .map_err(|error| error.to_string())?;
        Ok(Some(VaultRecord::new(
            record_id, category, label, secret_ref, metadata,
        )?))
    }

    fn delete(&self, id: &VaultRecordId) -> Result<(), String> {
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute(
                "delete from vault_records where id = ?1",
                params![id.to_string()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn category_key(category: crate::VaultCategory) -> &'static str {
    match category {
        crate::VaultCategory::Payments => "payments",
        crate::VaultCategory::Identity => "identity",
        crate::VaultCategory::Health => "health",
        crate::VaultCategory::Vehicles => "vehicles",
        crate::VaultCategory::Credentials => "credentials",
        crate::VaultCategory::PrivateNotes => "private_notes",
    }
}

fn category_from_key(value: &str) -> Result<crate::VaultCategory, String> {
    match value {
        "payments" => Ok(crate::VaultCategory::Payments),
        "identity" => Ok(crate::VaultCategory::Identity),
        "health" => Ok(crate::VaultCategory::Health),
        "vehicles" => Ok(crate::VaultCategory::Vehicles),
        "credentials" => Ok(crate::VaultCategory::Credentials),
        "private_notes" => Ok(crate::VaultCategory::PrivateNotes),
        other => Err(format!("unknown vault category: {other}")),
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

    #[test]
    fn sqlite_vault_store_round_trips_metadata_only_records() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();
        let secret_ref = SecretRef::new("user_1", "workspace_1", "vault", "card_1").unwrap();
        let record = VaultRecord::new(
            VaultRecordId::new("vault_record_1").unwrap(),
            VaultCategory::Payments,
            "Carta personale",
            secret_ref.clone(),
            serde_json::json!({
                "network": "visa",
                "last4": "1111",
                "redacted_preview": "[VAULT:payments:card:last4=1111]"
            }),
        )
        .unwrap();

        store.put(record.clone()).unwrap();
        let saved = store.get(&record.id).unwrap().unwrap();

        assert_eq!(saved.category, VaultCategory::Payments);
        assert_eq!(saved.label, "Carta personale");
        assert_eq!(saved.secret_ref, secret_ref);
        assert_eq!(saved.metadata["last4"], "1111");
        assert!(
            !saved
                .metadata
                .to_string()
                .to_ascii_lowercase()
                .contains("cvv")
        );
    }
}
