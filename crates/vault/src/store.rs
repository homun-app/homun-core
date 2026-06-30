use crate::{LocalPinVerifier, VaultRecord, VaultRecordId};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use local_first_secrets::{SecretMaterial, SecretRef};
use rand::RngCore;
use rusqlite::{Connection, params};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;

const VAULT_MASTER_KEY_LEN: usize = 32;
const VAULT_KEY_NONCE_LEN: usize = 24;

pub trait VaultStore {
    fn put(&self, record: VaultRecord) -> Result<(), String>;
    fn get(&self, id: &VaultRecordId) -> Result<Option<VaultRecord>, String>;
    fn list(&self) -> Result<Vec<VaultRecord>, String>;
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
                );
                create table if not exists vault_local_pin (
                    id integer primary key check (id = 1),
                    verifier_json text not null,
                    updated_at text not null default CURRENT_TIMESTAMP
                );
                create table if not exists vault_local_keyring (
                    id integer primary key check (id = 1),
                    algorithm text not null,
                    nonce text not null,
                    ciphertext text not null,
                    updated_at text not null default CURRENT_TIMESTAMP
                );
                create table if not exists vault_secret_material (
                    record_id text primary key,
                    algorithm text not null,
                    nonce text not null,
                    ciphertext text not null,
                    updated_at text not null default CURRENT_TIMESTAMP
                );",
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_local_pin_verifier(&self, verifier: LocalPinVerifier) -> Result<(), String> {
        let verifier_json = serde_json::to_string(&verifier).map_err(|error| error.to_string())?;
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute(
                "insert into vault_local_pin (id, verifier_json)
                 values (1, ?1)
                 on conflict(id) do update set
                    verifier_json=excluded.verifier_json,
                    updated_at=CURRENT_TIMESTAMP",
                params![verifier_json],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn local_pin_verifier(&self) -> Result<Option<LocalPinVerifier>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("select verifier_json from vault_local_pin where id = 1")
            .map_err(|error| error.to_string())?;
        let mut rows = stmt.query([]).map_err(|error| error.to_string())?;
        let Some(row) = rows.next().map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        let verifier_json = row.get::<_, String>(0).map_err(|error| error.to_string())?;
        serde_json::from_str(&verifier_json)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    pub fn clear_local_pin_verifier(&self) -> Result<(), String> {
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute("delete from vault_local_pin where id = 1", [])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn ensure_local_master_key(
        &self,
        verifier: &LocalPinVerifier,
        pin: &str,
    ) -> Result<[u8; VAULT_MASTER_KEY_LEN], String> {
        match self.unlock_local_master_key(verifier, pin) {
            Ok(key) => Ok(key),
            Err(error) if error == "Vault master key is not configured" => {
                let mut key = [0_u8; VAULT_MASTER_KEY_LEN];
                rand::rngs::OsRng.fill_bytes(&mut key);
                self.store_wrapped_master_key(verifier, pin, &key)?;
                Ok(key)
            }
            Err(error) => Err(error),
        }
    }

    pub fn unlock_local_master_key(
        &self,
        verifier: &LocalPinVerifier,
        pin: &str,
    ) -> Result<[u8; VAULT_MASTER_KEY_LEN], String> {
        let row = self.load_wrapped_master_key()?;
        let Some((algorithm, nonce, ciphertext)) = row else {
            return Err("Vault master key is not configured".to_string());
        };
        if algorithm != "xchacha20poly1305-pin-v1" {
            return Err("unsupported vault master key algorithm".to_string());
        }
        let plaintext = decrypt_master_key(verifier, pin, &nonce, &ciphertext)?;
        if plaintext.len() != VAULT_MASTER_KEY_LEN {
            return Err("invalid vault master key length".to_string());
        }
        let mut key = [0_u8; VAULT_MASTER_KEY_LEN];
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    pub fn rewrap_local_master_key(
        &self,
        old_verifier: &LocalPinVerifier,
        old_pin: &str,
        new_verifier: &LocalPinVerifier,
        new_pin: &str,
    ) -> Result<(), String> {
        let key = self.unlock_local_master_key(old_verifier, old_pin)?;
        self.store_wrapped_master_key(new_verifier, new_pin, &key)
    }

    fn store_wrapped_master_key(
        &self,
        verifier: &LocalPinVerifier,
        pin: &str,
        key: &[u8; VAULT_MASTER_KEY_LEN],
    ) -> Result<(), String> {
        let (nonce, ciphertext) = encrypt_master_key(verifier, pin, key)?;
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute(
                "insert into vault_local_keyring (id, algorithm, nonce, ciphertext)
                 values (1, 'xchacha20poly1305-pin-v1', ?1, ?2)
                 on conflict(id) do update set
                    algorithm=excluded.algorithm,
                    nonce=excluded.nonce,
                    ciphertext=excluded.ciphertext,
                    updated_at=CURRENT_TIMESTAMP",
                params![nonce, ciphertext],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn load_wrapped_master_key(&self) -> Result<Option<(String, String, String)>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare("select algorithm, nonce, ciphertext from vault_local_keyring where id = 1")
            .map_err(|error| error.to_string())?;
        let mut rows = stmt.query([]).map_err(|error| error.to_string())?;
        let Some(row) = rows.next().map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        Ok(Some((
            row.get::<_, String>(0).map_err(|error| error.to_string())?,
            row.get::<_, String>(1).map_err(|error| error.to_string())?,
            row.get::<_, String>(2).map_err(|error| error.to_string())?,
        )))
    }

    pub fn put_secret_material(
        &self,
        record_id: &VaultRecordId,
        master_key: &[u8; VAULT_MASTER_KEY_LEN],
        material: SecretMaterial,
    ) -> Result<(), String> {
        let (nonce, ciphertext) = encrypt_with_master_key(master_key, material.expose_bytes())?;
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute(
                "insert into vault_secret_material (record_id, algorithm, nonce, ciphertext)
                 values (?1, 'xchacha20poly1305-master-v1', ?2, ?3)
                 on conflict(record_id) do update set
                    algorithm=excluded.algorithm,
                    nonce=excluded.nonce,
                    ciphertext=excluded.ciphertext,
                    updated_at=CURRENT_TIMESTAMP",
                params![record_id.to_string(), nonce, ciphertext],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_secret_material(
        &self,
        record_id: &VaultRecordId,
        master_key: &[u8; VAULT_MASTER_KEY_LEN],
    ) -> Result<Option<SecretMaterial>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "select algorithm, nonce, ciphertext
                 from vault_secret_material where record_id = ?1",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = stmt
            .query(params![record_id.to_string()])
            .map_err(|error| error.to_string())?;
        let Some(row) = rows.next().map_err(|error| error.to_string())? else {
            return Ok(None);
        };
        let algorithm = row.get::<_, String>(0).map_err(|error| error.to_string())?;
        if algorithm != "xchacha20poly1305-master-v1" {
            return Err("unsupported vault secret material algorithm".to_string());
        }
        let nonce = row.get::<_, String>(1).map_err(|error| error.to_string())?;
        let ciphertext = row.get::<_, String>(2).map_err(|error| error.to_string())?;
        decrypt_with_master_key(master_key, &nonce, &ciphertext)
            .map(|bytes| Some(SecretMaterial::from_bytes(bytes)))
    }
}

fn encrypt_master_key(
    verifier: &LocalPinVerifier,
    pin: &str,
    key: &[u8; VAULT_MASTER_KEY_LEN],
) -> Result<(String, String), String> {
    if !verifier.verify(pin) {
        return Err("Invalid Vault PIN".to_string());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(&pin_wrap_key(verifier, pin)?)
        .map_err(|error| error.to_string())?;
    let mut nonce = [0_u8; VAULT_KEY_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), key.as_ref())
        .map_err(|_| "vault master key encryption failed".to_string())?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(nonce),
        base64::engine::general_purpose::STANDARD.encode(ciphertext),
    ))
}

fn decrypt_master_key(
    verifier: &LocalPinVerifier,
    pin: &str,
    nonce: &str,
    ciphertext: &str,
) -> Result<Vec<u8>, String> {
    if !verifier.verify(pin) {
        return Err("Invalid Vault PIN".to_string());
    }
    let cipher = XChaCha20Poly1305::new_from_slice(&pin_wrap_key(verifier, pin)?)
        .map_err(|error| error.to_string())?;
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(nonce)
        .map_err(|error| error.to_string())?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|error| error.to_string())?;
    cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "vault master key decryption failed".to_string())
}

fn pin_wrap_key(verifier: &LocalPinVerifier, pin: &str) -> Result<[u8; 32], String> {
    let salt = hex_decode(&verifier.salt_hex)?;
    let mut digest = Sha256::new();
    digest.update(b"homun-vault-master-key-wrap-v1");
    digest.update(&salt);
    digest.update(pin.as_bytes());
    let mut key: [u8; 32] = digest.finalize().into();
    for _ in 1..verifier.iterations {
        let mut next = Sha256::new();
        next.update(b"homun-vault-master-key-wrap-v1");
        next.update(key);
        next.update(&salt);
        next.update(pin.as_bytes());
        key = next.finalize().into();
    }
    Ok(key)
}

fn encrypt_with_master_key(
    master_key: &[u8; VAULT_MASTER_KEY_LEN],
    plaintext: &[u8],
) -> Result<(String, String), String> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(master_key).map_err(|error| error.to_string())?;
    let mut nonce = [0_u8; VAULT_KEY_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| "vault secret encryption failed".to_string())?;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(nonce),
        base64::engine::general_purpose::STANDARD.encode(ciphertext),
    ))
}

fn decrypt_with_master_key(
    master_key: &[u8; VAULT_MASTER_KEY_LEN],
    nonce: &str,
    ciphertext: &str,
) -> Result<Vec<u8>, String> {
    let cipher =
        XChaCha20Poly1305::new_from_slice(master_key).map_err(|error| error.to_string())?;
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(nonce)
        .map_err(|error| error.to_string())?;
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(ciphertext)
        .map_err(|error| error.to_string())?;
    cipher
        .decrypt(XNonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "vault secret decryption failed".to_string())
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("invalid hex length".to_string());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks(2) {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("invalid hex digit".to_string()),
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

    fn list(&self) -> Result<Vec<VaultRecord>, String> {
        let records = self
            .records
            .lock()
            .map_err(|_| "vault store lock poisoned".to_string())?;
        Ok(records.values().cloned().collect())
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

    fn list(&self) -> Result<Vec<VaultRecord>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        let mut stmt = conn
            .prepare(
                "select id, category, label, secret_ref, metadata_json
                 from vault_records
                 order by updated_at desc, label asc, id asc",
            )
            .map_err(|error| error.to_string())?;
        let mut rows = stmt.query([]).map_err(|error| error.to_string())?;
        let mut records = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
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
            records.push(VaultRecord::new(
                record_id, category, label, secret_ref, metadata,
            )?);
        }
        Ok(records)
    }

    fn delete(&self, id: &VaultRecordId) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        conn.execute(
            "delete from vault_secret_material where record_id = ?1",
            params![id.to_string()],
        )
        .map_err(|error| error.to_string())?;
        conn.execute(
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

    #[test]
    fn sqlite_vault_store_lists_metadata_only_records() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();
        let first = VaultRecord::new(
            VaultRecordId::new("vault_record_1").unwrap(),
            VaultCategory::Payments,
            "Carta personale",
            SecretRef::new("user_1", "workspace_1", "vault", "card_1").unwrap(),
            serde_json::json!({
                "redacted_preview": "[VAULT:payments:card:last4=1111]"
            }),
        )
        .unwrap();
        let second = VaultRecord::new(
            VaultRecordId::new("vault_record_2").unwrap(),
            VaultCategory::Health,
            "Allergie",
            SecretRef::new("user_1", "workspace_1", "vault", "health_1").unwrap(),
            serde_json::json!({
                "redacted_preview": "[VAULT:health:allergies]"
            }),
        )
        .unwrap();

        store.put(first.clone()).unwrap();
        store.put(second.clone()).unwrap();
        let records = store.list().unwrap();

        assert_eq!(records.len(), 2);
        assert_eq!(
            records
                .iter()
                .map(|record| record.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Allergie", "Carta personale"]
        );
        assert_eq!(
            records[0].metadata["redacted_preview"],
            "[VAULT:health:allergies]"
        );
        assert!(
            !records
                .iter()
                .any(|record| record.metadata.to_string().contains("4111111111111111"))
        );
    }

    #[test]
    fn sqlite_vault_store_persists_local_pin_verifier_without_plaintext() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();
        let verifier = LocalPinVerifier::create("123456").unwrap();

        store.set_local_pin_verifier(verifier).unwrap();
        let saved = store.local_pin_verifier().unwrap().unwrap();

        assert!(saved.verify("123456"));
        assert!(!saved.verify("654321"));
        assert!(!serde_json::to_string(&saved).unwrap().contains("123456"));
    }

    #[test]
    fn sqlite_vault_master_key_is_wrapped_by_pin_and_survives_authorized_pin_change() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();
        let old_verifier = LocalPinVerifier::create("123456").unwrap();
        store.set_local_pin_verifier(old_verifier.clone()).unwrap();

        let original_key = store
            .ensure_local_master_key(&old_verifier, "123456")
            .expect("master key");

        assert_eq!(
            store
                .unlock_local_master_key(&old_verifier, "123456")
                .expect("unlock"),
            original_key
        );
        assert!(
            store
                .unlock_local_master_key(&old_verifier, "654321")
                .is_err()
        );

        let new_verifier = LocalPinVerifier::create("654321").unwrap();
        store
            .rewrap_local_master_key(&old_verifier, "123456", &new_verifier, "654321")
            .expect("rewrap");
        store.set_local_pin_verifier(new_verifier.clone()).unwrap();

        assert_eq!(
            store
                .unlock_local_master_key(&new_verifier, "654321")
                .expect("unlock with new pin"),
            original_key
        );
        assert!(
            store
                .unlock_local_master_key(&new_verifier, "123456")
                .is_err()
        );
    }

    #[test]
    fn sqlite_vault_secret_material_is_encrypted_under_local_master_key() {
        let path = std::env::temp_dir().join(format!(
            "homun-vault-secret-material-{}.sqlite",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = SQLiteVaultStore::open(&path).unwrap();
        let verifier = LocalPinVerifier::create("123456").unwrap();
        store.set_local_pin_verifier(verifier.clone()).unwrap();
        let master_key = store
            .ensure_local_master_key(&verifier, "123456")
            .expect("master key");
        let record_id = VaultRecordId::new("vault_card_1").unwrap();
        let secret = local_first_secrets::SecretMaterial::from_string("4111111111111111");

        store
            .put_secret_material(&record_id, &master_key, secret)
            .expect("put secret");
        let saved = store
            .get_secret_material(&record_id, &master_key)
            .expect("get secret")
            .expect("saved secret");
        assert_eq!(saved.expose_utf8().unwrap(), "4111111111111111");

        let mut wrong_key = master_key;
        wrong_key[0] ^= 0xff;
        assert!(store.get_secret_material(&record_id, &wrong_key).is_err());

        drop(store);
        let bytes = std::fs::read(&path).unwrap();
        let db = String::from_utf8_lossy(&bytes);
        assert!(!db.contains("4111111111111111"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sqlite_vault_delete_removes_metadata_and_secret_material() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();
        let verifier = LocalPinVerifier::create("123456").unwrap();
        store.set_local_pin_verifier(verifier.clone()).unwrap();
        let master_key = store
            .ensure_local_master_key(&verifier, "123456")
            .expect("master key");
        let record_id = VaultRecordId::new("vault_card_1").unwrap();
        let record = VaultRecord::new(
            record_id.clone(),
            VaultCategory::Payments,
            "Carta personale",
            SecretRef::new("user_1", "workspace_1", "vault", record_id.as_str()).unwrap(),
            serde_json::json!({
                "redacted_preview": "[VAULT:payments:card:last4=1111]"
            }),
        )
        .unwrap();
        store.put(record).unwrap();
        store
            .put_secret_material(
                &record_id,
                &master_key,
                local_first_secrets::SecretMaterial::from_string("4111111111111111"),
            )
            .expect("put secret");

        store.delete(&record_id).unwrap();

        assert!(store.get(&record_id).unwrap().is_none());
        assert!(
            store
                .get_secret_material(&record_id, &master_key)
                .unwrap()
                .is_none()
        );
    }
}
