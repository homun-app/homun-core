use local_first_secrets::{SecretMaterial, SecretRef};

#[test]
fn secret_ref_parses_and_formats_stable_refs() {
    let reference = SecretRef::new("user_1", "workspace_1", "github", "conn_1").unwrap();

    assert_eq!(
        reference.as_str(),
        "secret://user_1/workspace_1/github/conn_1"
    );
    assert_eq!(reference.user_id(), "user_1");
    assert_eq!(reference.workspace_id(), "workspace_1");
    assert_eq!(reference.provider_id(), "github");
    assert_eq!(reference.connection_id(), "conn_1");
    assert_eq!(reference.as_str().parse::<SecretRef>().unwrap(), reference);
}

#[test]
fn secret_ref_rejects_path_traversal_and_legacy_plaintext() {
    assert!(SecretRef::new("user_1", "workspace_1", "github", "../conn").is_err());
    assert!("sk-live-secret".parse::<SecretRef>().is_err());
}

#[test]
fn secret_material_redacts_debug_and_refuses_json_serialization() {
    let material = SecretMaterial::from_string("sk-secret");

    assert_eq!(format!("{material:?}"), "SecretMaterial([REDACTED])");
    assert!(serde_json::to_value(&material).is_err());
    assert_eq!(material.expose_utf8().unwrap(), "sk-secret");
}
