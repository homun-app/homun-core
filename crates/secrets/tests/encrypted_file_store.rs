use local_first_secrets::{
    DevelopmentSecretKeyProvider, EncryptedFileSecretStore, SecretMaterial, SecretRef, SecretStore,
};
use std::fs;

#[test]
fn encrypted_file_store_round_trips_without_plaintext_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.json");
    let provider = DevelopmentSecretKeyProvider::new([7u8; 32]);
    let store = EncryptedFileSecretStore::open(&path, provider).unwrap();
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();

    store
        .put(reference.clone(), SecretMaterial::from_string("ghp_secret_value"))
        .unwrap();

    let raw_file = fs::read_to_string(&path).unwrap();
    assert!(!raw_file.contains("ghp_secret_value"));
    assert!(raw_file.contains("xchacha20poly1305"));

    let reopened = EncryptedFileSecretStore::open(
        &path,
        DevelopmentSecretKeyProvider::new([7u8; 32]),
    )
    .unwrap();
    let material = reopened.get(&reference).unwrap().unwrap();
    assert_eq!(material.expose_utf8().unwrap(), "ghp_secret_value");
}

#[test]
fn encrypted_file_store_fails_with_wrong_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("secrets.json");
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();

    EncryptedFileSecretStore::open(&path, DevelopmentSecretKeyProvider::new([1u8; 32]))
        .unwrap()
        .put(reference.clone(), SecretMaterial::from_string("ghp_secret_value"))
        .unwrap();

    let reopened = EncryptedFileSecretStore::open(
        &path,
        DevelopmentSecretKeyProvider::new([2u8; 32]),
    )
    .unwrap();

    assert!(reopened.get(&reference).is_err());
}
