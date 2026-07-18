use local_first_secrets::{SecretMaterial, SecretRef};
use local_first_vault::{SQLiteVaultStore, VaultCategory, VaultRecord, VaultRecordId, VaultStore};
use rusqlite::Connection;

const TEST_WRAP_KEY: [u8; 32] = [9_u8; 32];

#[test]
fn vault_audit_reports_structure_without_secret_values() {
    let db_path = temp_path("audit-source");
    let store = SQLiteVaultStore::open(&db_path).unwrap();
    let master_key = store
        .ensure_local_master_key_system(&TEST_WRAP_KEY)
        .unwrap();
    let first = record("record-a", "Primary Card");
    store
        .put_record_with_secret(
            &first,
            &master_key,
            Some(SecretMaterial::from_string("VAULT_SECRET_SENTINEL")),
        )
        .unwrap();
    store.put(record("record-b", " primary card ")).unwrap();
    seed_corruption(&db_path, first.secret_ref.to_string());

    let report = store.audit_integrity().unwrap();
    let repeated = store.audit_integrity().unwrap();

    assert!(report.integrity_ok);
    assert_eq!(report.foreign_key_violations, 0);
    assert_eq!(report.total_records, 3);
    assert_eq!(report.total_secret_rows, 2);
    assert_eq!(report.orphan_secret_rows, 1);
    assert_eq!(report.records_without_material, 2);
    assert_eq!(report.duplicate_label_groups, 1);
    assert_eq!(report.duplicate_label_extras, 1);
    assert_eq!(report.invalid_metadata_json_rows, 1);
    assert_eq!(report.forbidden_metadata_key_rows, 1);
    assert_eq!(report.keyring_algorithms["xchacha20poly1305-syskey-v1"], 1);
    assert_eq!(report.secret_algorithms["xchacha20poly1305-master-v1"], 1);
    assert_eq!(report.secret_algorithms["unknown"], 1);
    assert!(!report.checksum.is_empty());
    assert_eq!(report.checksum, repeated.checksum);

    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("VAULT_SECRET_SENTINEL"));
    assert!(!encoded.contains("ciphertext"));
    assert!(!encoded.contains("nonce"));

    drop(store);
    remove_db(&db_path);
}

#[test]
fn vault_backup_is_consistent_and_in_memory_backup_is_rejected() {
    let source = temp_path("backup-source");
    let destination = temp_path("backup-destination");
    let store = SQLiteVaultStore::open(&source).unwrap();
    let master_key = store
        .ensure_local_master_key_system(&TEST_WRAP_KEY)
        .unwrap();
    let source_record = record("record-a", "Primary Card");
    store
        .put_record_with_secret(
            &source_record,
            &master_key,
            Some(SecretMaterial::from_string("backup-secret")),
        )
        .unwrap();

    let backup = store.backup_to(&destination).unwrap();

    assert_eq!(backup.source, source);
    assert_eq!(backup.destination, destination);
    assert!(backup.bytes > 0);
    let copied = SQLiteVaultStore::open(&destination).unwrap();
    assert_eq!(copied.list().unwrap().len(), 1);
    assert_eq!(
        copied
            .get_secret_material(&source_record.id, &master_key)
            .unwrap()
            .unwrap()
            .expose_utf8()
            .unwrap(),
        "backup-secret"
    );
    assert!(
        SQLiteVaultStore::open_in_memory()
            .unwrap()
            .backup_to(&temp_path("memory-backup"))
            .is_err()
    );

    drop(copied);
    drop(store);
    remove_db(&source);
    remove_db(&destination);
}

fn record(id: &str, label: &str) -> VaultRecord {
    VaultRecord::new(
        VaultRecordId::new(id).unwrap(),
        VaultCategory::Payments,
        label,
        SecretRef::new("local-user", "local-workspace", "vault", id).unwrap(),
        serde_json::json!({"redacted_preview": "[VAULT:payments:card:last4=1111]"}),
    )
    .unwrap()
}

fn seed_corruption(path: &std::path::Path, secret_ref: String) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute(
            "update vault_records set metadata_json = ?1 where id = 'record-a'",
            [r#"{"nested":{"password":"VAULT_SECRET_SENTINEL"}}"#],
        )
        .unwrap();
    connection
        .execute(
            "insert into vault_records (id, category, label, secret_ref, metadata_json)
             values ('record-invalid', 'payments', 'Invalid JSON', ?1, '{invalid')",
            [secret_ref],
        )
        .unwrap();
    connection
        .execute(
            "insert into vault_secret_material (record_id, algorithm, nonce, ciphertext)
             values ('orphan-secret', 'VAULT_SECRET_SENTINEL',
                     'VAULT_SECRET_SENTINEL', 'VAULT_SECRET_SENTINEL')",
            [],
        )
        .unwrap();
}

fn temp_path(label: &str) -> std::path::PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("vault-integrity-{label}-{unique}.sqlite"))
}

fn remove_db(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}
