use crate::{LocalPinVerifier, VaultRecord, VaultRecordId};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use local_first_secrets::{SecretMaterial, SecretRef};
use rand::RngCore;
use rusqlite::{Connection, params};
use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::Mutex;

const VAULT_MASTER_KEY_LEN: usize = 32;
const VAULT_KEY_NONCE_LEN: usize = 24;

/// Master key wrapped by a PIN-derived key. Legacy algorithm: the PIN
/// cryptographically gates all machine use, so unattended automations are
/// impossible without it. Kept for read/migration only — never written anew.
const VAULT_KEYRING_PIN_ALGORITHM: &str = "xchacha20poly1305-pin-v1";
/// Master key wrapped by a random 256-bit key held in the OS keychain. The
/// system can obtain the master key with NO PIN, so it can inject/compare vault
/// values autonomously. At-rest protection is delegated to the OS keychain
/// (like password-manager autofill) — a deliberate trade-off for autonomy.
const VAULT_KEYRING_SYSTEM_ALGORITHM: &str = "xchacha20poly1305-syskey-v1";

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
        if algorithm != VAULT_KEYRING_PIN_ALGORITHM {
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

    /// The wrapping algorithm currently stored in the keyring, if any. Lets
    /// callers tell a legacy PIN-wrapped vault (`-pin-v1`) apart from a
    /// system-wrapped one (`-syskey-v1`) so they can migrate or use accordingly.
    pub fn keyring_algorithm(&self) -> Result<Option<String>, String> {
        Ok(self
            .load_wrapped_master_key()?
            .map(|(algorithm, _, _)| algorithm))
    }

    /// Return the system-wrapped master key, creating a fresh random one on the
    /// first call (fresh install). No PIN — the system uses this for injection
    /// and dedup. Idempotent: an existing key is never rotated.
    pub fn ensure_local_master_key_system(
        &self,
        wrap_key: &[u8; VAULT_MASTER_KEY_LEN],
    ) -> Result<[u8; VAULT_MASTER_KEY_LEN], String> {
        match self.unlock_local_master_key_system(wrap_key) {
            Ok(key) => Ok(key),
            Err(error) if error == "Vault master key is not configured" => {
                let mut key = [0_u8; VAULT_MASTER_KEY_LEN];
                rand::rngs::OsRng.fill_bytes(&mut key);
                self.store_wrapped_master_key_system(wrap_key, &key)?;
                Ok(key)
            }
            Err(error) => Err(error),
        }
    }

    /// Unwrap the master key with the system wrap key (no PIN). Errors if the
    /// keyring is absent or is still PIN-wrapped (migration required first).
    pub fn unlock_local_master_key_system(
        &self,
        wrap_key: &[u8; VAULT_MASTER_KEY_LEN],
    ) -> Result<[u8; VAULT_MASTER_KEY_LEN], String> {
        let Some((algorithm, nonce, ciphertext)) = self.load_wrapped_master_key()? else {
            return Err("Vault master key is not configured".to_string());
        };
        if algorithm != VAULT_KEYRING_SYSTEM_ALGORITHM {
            return Err("vault master key is not wrapped with the system key".to_string());
        }
        // The wrap key is a random 256-bit key, so it doubles directly as the
        // AEAD key — no KDF needed (unlike the PIN path).
        let plaintext = decrypt_with_master_key(wrap_key, &nonce, &ciphertext)?;
        if plaintext.len() != VAULT_MASTER_KEY_LEN {
            return Err("invalid vault master key length".to_string());
        }
        let mut key = [0_u8; VAULT_MASTER_KEY_LEN];
        key.copy_from_slice(&plaintext);
        Ok(key)
    }

    /// Wrap `master_key` under the system wrap key and persist it in the keyring
    /// tagged `-syskey-v1`. Overwrites any prior wrapping (this is how migration
    /// re-wraps the same master key without touching per-record ciphertext).
    pub fn store_wrapped_master_key_system(
        &self,
        wrap_key: &[u8; VAULT_MASTER_KEY_LEN],
        master_key: &[u8; VAULT_MASTER_KEY_LEN],
    ) -> Result<(), String> {
        let (nonce, ciphertext) = encrypt_with_master_key(wrap_key, master_key.as_ref())?;
        self.conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?
            .execute(
                "insert into vault_local_keyring (id, algorithm, nonce, ciphertext)
                 values (1, ?1, ?2, ?3)
                 on conflict(id) do update set
                    algorithm=excluded.algorithm,
                    nonce=excluded.nonce,
                    ciphertext=excluded.ciphertext,
                    updated_at=CURRENT_TIMESTAMP",
                params![VAULT_KEYRING_SYSTEM_ALGORITHM, nonce, ciphertext],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// One-time migration for legacy vaults: unwrap the PIN-wrapped master key
    /// (requires the PIN once) and re-wrap it under the system key. The master
    /// key VALUE is preserved, so every per-record ciphertext stays valid.
    pub fn migrate_pin_wrapped_master_key_to_system(
        &self,
        verifier: &LocalPinVerifier,
        pin: &str,
        wrap_key: &[u8; VAULT_MASTER_KEY_LEN],
    ) -> Result<[u8; VAULT_MASTER_KEY_LEN], String> {
        // unlock_local_master_key enforces that the keyring is `-pin-v1`, so this
        // rejects double-migration (a `-syskey-v1` keyring errors cleanly).
        let key = self.unlock_local_master_key(verifier, pin)?;
        self.store_wrapped_master_key_system(wrap_key, &key)?;
        Ok(key)
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
                 -- algorithm literal matches VAULT_KEYRING_PIN_ALGORITHM (legacy write path)
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

    /// Atomically persist a record's metadata AND (optionally) its secret material
    /// in a SINGLE transaction — both-or-neither. The prior save path took two
    /// separate `Mutex<Connection>` locks (`put` then `put_secret_material`) with no
    /// transaction, so a failure between them could leave orphaned secret material
    /// or partial state ("errore di salvataggio"). Here the conn is locked ONCE,
    /// both upserts run inside one tx, and any error drops the tx → rollback →
    /// nothing is written. Encryption happens BEFORE the tx so a crypto failure
    /// never leaves a half-open transaction. This is the method the gateway save
    /// path uses; `put`/`put_secret_material` stay for other callers.
    pub fn put_record_with_secret(
        &self,
        record: &VaultRecord,
        master_key: &[u8; VAULT_MASTER_KEY_LEN],
        secret: Option<SecretMaterial>,
    ) -> Result<(), String> {
        let metadata_json =
            serde_json::to_string(&record.metadata).map_err(|error| error.to_string())?;
        // Encrypt with the exact crypto `put_secret_material` uses (reuse, don't
        // reinvent) before opening the tx — a crypto error must not abort mid-tx.
        let encrypted_secret = match secret {
            Some(material) => Some(encrypt_with_master_key(master_key, material.expose_bytes())?),
            None => None,
        };
        let conn = self
            .conn
            .lock()
            .map_err(|_| "vault sqlite lock poisoned".to_string())?;
        // `unchecked_transaction` takes `&self`, so it works through the MutexGuard
        // (the &mut-requiring `transaction()` would not). On any early return the tx
        // is dropped without commit → SQLite rolls it back.
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        tx.execute(
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
        if let Some((nonce, ciphertext)) = encrypted_secret {
            tx.execute(
                "insert into vault_secret_material (record_id, algorithm, nonce, ciphertext)
                 values (?1, 'xchacha20poly1305-master-v1', ?2, ?3)
                 on conflict(record_id) do update set
                    algorithm=excluded.algorithm,
                    nonce=excluded.nonce,
                    ciphertext=excluded.ciphertext,
                    updated_at=CURRENT_TIMESTAMP",
                params![record.id.to_string(), nonce, ciphertext],
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
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

/// Domain tag folded into the Argon2 salt so the pin-wrap key is cryptographically
/// distinct from the PIN verifier digest even though both derive from the same
/// (salt, PIN): different salt input → independent key, so the stored verifier
/// digest can never be replayed as the master-key wrap key.
const PIN_WRAP_DOMAIN: &[u8] = b"homun-vault-master-key-wrap-v1";

/// Derive the 32-byte master-key wrap key with Argon2id (memory-hard, resists
/// GPU brute force of the short PIN). Uses the SAME cost params the verifier was
/// created with, read from `verifier`, so it stays consistent within a run.
fn pin_wrap_key(verifier: &LocalPinVerifier, pin: &str) -> Result<[u8; 32], String> {
    let raw_salt = hex_decode(&verifier.salt_hex)?;
    // Domain-separate by prepending the tag to the salt input.
    let mut salt = Vec::with_capacity(PIN_WRAP_DOMAIN.len() + raw_salt.len());
    salt.extend_from_slice(PIN_WRAP_DOMAIN);
    salt.extend_from_slice(&raw_salt);
    crate::pin::derive_pin_digest(
        pin.as_bytes(),
        &salt,
        verifier.mem_kib,
        verifier.time_cost,
        verifier.parallelism,
    )
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

    // ADR: system-key wrapping. The 32-byte wrap key stands in for the value
    // held in the OS keychain; unit tests inject it directly so the crypto is
    // exercised without touching the platform keychain (`security` CLI).
    const TEST_WRAP_KEY: [u8; VAULT_MASTER_KEY_LEN] = [7_u8; VAULT_MASTER_KEY_LEN];

    #[test]
    fn sqlite_vault_master_key_round_trips_under_system_wrap_key() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();

        // Fresh vault: no keyring yet.
        assert_eq!(store.keyring_algorithm().unwrap(), None);

        let key = store
            .ensure_local_master_key_system(&TEST_WRAP_KEY)
            .expect("ensure system master key");
        assert_eq!(
            store.keyring_algorithm().unwrap().as_deref(),
            Some("xchacha20poly1305-syskey-v1")
        );

        // Unlock with the same wrap key returns the same master key, no PIN.
        assert_eq!(
            store
                .unlock_local_master_key_system(&TEST_WRAP_KEY)
                .expect("unlock system master key"),
            key
        );
        // ensure is idempotent: it does not rotate an existing key.
        assert_eq!(
            store
                .ensure_local_master_key_system(&TEST_WRAP_KEY)
                .expect("ensure is idempotent"),
            key
        );

        // A different wrap key must not decrypt the master key.
        let mut wrong = TEST_WRAP_KEY;
        wrong[0] ^= 0xff;
        assert!(store.unlock_local_master_key_system(&wrong).is_err());
    }

    #[test]
    fn sqlite_vault_migration_pin_to_system_preserves_all_secret_values() {
        let store = SQLiteVaultStore::open_in_memory().unwrap();
        let verifier = LocalPinVerifier::create("123456").unwrap();
        store.set_local_pin_verifier(verifier.clone()).unwrap();

        // Legacy state: master key wrapped by the PIN, records encrypted under it.
        let master_key = store
            .ensure_local_master_key(&verifier, "123456")
            .expect("legacy master key");
        assert_eq!(
            store.keyring_algorithm().unwrap().as_deref(),
            Some("xchacha20poly1305-pin-v1")
        );
        let record_id = VaultRecordId::new("vault_card_1").unwrap();
        store
            .put_secret_material(
                &record_id,
                &master_key,
                local_first_secrets::SecretMaterial::from_string("4111111111111111"),
            )
            .expect("put legacy secret");

        // Migrate the WRAPPING only (pin -> syskey). The master key value is unchanged.
        let migrated = store
            .migrate_pin_wrapped_master_key_to_system(&verifier, "123456", &TEST_WRAP_KEY)
            .expect("migrate to syskey");
        assert_eq!(migrated, master_key);
        assert_eq!(
            store.keyring_algorithm().unwrap().as_deref(),
            Some("xchacha20poly1305-syskey-v1")
        );

        // The pre-existing ciphertext is still decryptable with the SAME master key,
        // now obtained via the system wrap key with NO PIN.
        let system_key = store
            .unlock_local_master_key_system(&TEST_WRAP_KEY)
            .expect("unlock via syskey");
        assert_eq!(system_key, master_key);
        let recovered = store
            .get_secret_material(&record_id, &system_key)
            .expect("get secret after migration")
            .expect("secret present");
        assert_eq!(recovered.expose_utf8().unwrap(), "4111111111111111");

        // Migrating from a non-pin keyring (already migrated) must fail cleanly.
        assert!(
            store
                .migrate_pin_wrapped_master_key_to_system(&verifier, "123456", &TEST_WRAP_KEY)
                .is_err()
        );
    }

    #[test]
    fn vault_save_is_atomic_on_metadata_failure() {
        // Atomicity contract for the gateway save path: the record metadata AND the
        // secret material must be written both-or-neither. We force the SECOND write
        // (secret material) to fail via a trigger AFTER the record row is inserted —
        // a non-transactional put would leave an orphaned record; the transactional
        // `put_record_with_secret` must roll the record write back too.
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

        // Same-module test: reach the private conn to install a failing trigger on
        // the secret-material table so the second statement in the tx aborts.
        store
            .conn
            .lock()
            .unwrap()
            .execute_batch(
                "create trigger vault_fail_secret before insert on vault_secret_material
                 begin select raise(abort, 'forced secret-material failure'); end;",
            )
            .unwrap();

        let result = store.put_record_with_secret(
            &record,
            &master_key,
            Some(local_first_secrets::SecretMaterial::from_string("4111111111111111")),
        );
        assert!(result.is_err(), "the forced secret write must fail");

        // Both-or-neither: because the secret write failed, the record write must be
        // rolled back too — no orphaned metadata, no orphaned secret material.
        assert!(
            store.get(&record_id).unwrap().is_none(),
            "record metadata must roll back with the failed secret write"
        );
        assert!(
            store
                .get_secret_material(&record_id, &master_key)
                .unwrap()
                .is_none(),
            "no orphaned secret material"
        );
    }

    #[test]
    fn vault_put_record_with_secret_commits_both_on_success() {
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
            serde_json::json!({"redacted_preview": "[VAULT:payments:card:last4=1111]"}),
        )
        .unwrap();

        store
            .put_record_with_secret(
                &record,
                &master_key,
                Some(local_first_secrets::SecretMaterial::from_string("4111111111111111")),
            )
            .expect("atomic save");

        assert_eq!(store.get(&record_id).unwrap().unwrap().label, "Carta personale");
        assert_eq!(
            store
                .get_secret_material(&record_id, &master_key)
                .unwrap()
                .unwrap()
                .expose_utf8()
                .unwrap(),
            "4111111111111111"
        );
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
