use local_first_secrets::{
    InMemorySecretStore, SecretMaterial, SecretRef, SecretStatus, SecretStore,
};

#[test]
fn in_memory_store_round_trips_secret_material_and_metadata() {
    let store = InMemorySecretStore::default();
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();
    let material = SecretMaterial::from_string("ghp_secret");

    let metadata = store.put(reference.clone(), material.clone()).unwrap();

    assert_eq!(metadata.reference, reference);
    assert_eq!(metadata.status, SecretStatus::Active);
    assert_eq!(metadata.version, 1);
    assert_eq!(store.get(&metadata.reference).unwrap(), Some(material));
    assert_eq!(
        store
            .metadata(&metadata.reference)
            .unwrap()
            .unwrap()
            .version,
        1
    );
}

#[test]
fn in_memory_store_rotates_versions_and_deletes_secrets() {
    let store = InMemorySecretStore::default();
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();

    store
        .put(reference.clone(), SecretMaterial::from_string("first"))
        .unwrap();
    let rotated = store
        .put(reference.clone(), SecretMaterial::from_string("second"))
        .unwrap();

    assert_eq!(rotated.version, 2);
    assert_eq!(
        store
            .get(&reference)
            .unwrap()
            .unwrap()
            .expose_utf8()
            .unwrap(),
        "second"
    );
    store.delete(&reference).unwrap();
    assert!(store.get(&reference).unwrap().is_none());
    assert_eq!(
        store.metadata(&reference).unwrap().unwrap().status,
        SecretStatus::Deleted
    );
}
