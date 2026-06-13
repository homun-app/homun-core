use local_first_secrets::{SecretRef, SystemKeychainSecretStore};

#[test]
fn system_keychain_store_exposes_service_scoped_metadata_without_material() {
    let store = SystemKeychainSecretStore::new("homun-test");
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();

    assert_eq!(store.service(), "homun-test");
    assert_eq!(
        store.account_for(&reference),
        "secret://user_1/workspace_1/github/conn_1"
    );
}
