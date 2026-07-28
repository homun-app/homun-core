use local_first_browser_automation::{
    BrowserDraftControl, MAX_BROWSER_DRAFT_BYTES, MAX_BROWSER_DRAFT_CONTROLS,
    MAX_BROWSER_DRAFT_VALUE_CHARS,
};
use local_first_secrets::{
    DevelopmentSecretKeyProvider, EncryptedFileSecretStore, SecretMaterial, SecretRef, SecretStore,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

const BROWSER_CHECKPOINT_PROVIDER: &str = "browser-checkpoint";

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDraftSecret {
    pub schema_version: u8,
    pub objective_revision: u64,
    pub target_id: String,
    pub origin: String,
    pub generation: u64,
    pub controls: Vec<BrowserDraftControl>,
}

impl std::fmt::Debug for BrowserDraftSecret {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BrowserDraftSecret")
            .field("schema_version", &self.schema_version)
            .field("objective_revision", &self.objective_revision)
            .field("target_id", &self.target_id)
            .field("origin", &self.origin)
            .field("generation", &self.generation)
            .field(
                "controls",
                &format_args!("[REDACTED; {}]", self.controls.len()),
            )
            .finish()
    }
}

pub struct BrowserCheckpointSecretStore {
    inner: EncryptedFileSecretStore<DevelopmentSecretKeyProvider>,
}

impl BrowserCheckpointSecretStore {
    pub fn open(path: impl AsRef<Path>, seed: [u8; 32]) -> Result<Self, String> {
        Ok(Self {
            inner: EncryptedFileSecretStore::open(path, DevelopmentSecretKeyProvider::new(seed))
                .map_err(|error| error.to_string())?,
        })
    }

    pub fn put(
        &self,
        user_id: &str,
        workspace_id: &str,
        opaque_id: &str,
        payload: &BrowserDraftSecret,
    ) -> Result<String, String> {
        validate_payload(payload)?;
        let reference = SecretRef::new(
            user_id,
            workspace_id,
            BROWSER_CHECKPOINT_PROVIDER,
            opaque_id,
        )
        .map_err(|error| error.to_string())?;
        let encoded = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
        if encoded.len() > MAX_BROWSER_DRAFT_BYTES {
            return Err("browser draft exceeds encrypted payload bound".into());
        }
        self.inner
            .put(reference.clone(), SecretMaterial::from_bytes(encoded))
            .map_err(|error| error.to_string())?;
        Ok(reference.to_string())
    }

    pub fn get(
        &self,
        reference: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<Option<BrowserDraftSecret>, String> {
        let reference: SecretRef = reference
            .parse()
            .map_err(|error: local_first_secrets::SecretError| error.to_string())?;
        if reference.user_id() != user_id
            || reference.workspace_id() != workspace_id
            || reference.provider_id() != BROWSER_CHECKPOINT_PROVIDER
        {
            return Err("browser draft secret scope mismatch".into());
        }
        let Some(material) = self
            .inner
            .get(&reference)
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        let payload: BrowserDraftSecret =
            serde_json::from_slice(material.expose_bytes()).map_err(|error| error.to_string())?;
        validate_payload(&payload)?;
        Ok(Some(payload))
    }

    pub fn delete(&self, reference: &str) -> Result<(), String> {
        let reference: SecretRef = reference
            .parse()
            .map_err(|error: local_first_secrets::SecretError| error.to_string())?;
        if reference.provider_id() != BROWSER_CHECKPOINT_PROVIDER {
            return Err("not a browser checkpoint secret reference".into());
        }
        self.inner
            .delete(&reference)
            .map_err(|error| error.to_string())
    }
}

fn validate_payload(payload: &BrowserDraftSecret) -> Result<(), String> {
    if payload.schema_version != 1 {
        return Err("unsupported browser draft schema version".into());
    }
    if payload.target_id.trim().is_empty() || payload.origin.trim().is_empty() {
        return Err("browser draft scope is incomplete".into());
    }
    if payload.controls.len() > MAX_BROWSER_DRAFT_CONTROLS {
        return Err("browser draft has too many controls".into());
    }
    for control in &payload.controls {
        if is_sensitive_control(control) {
            return Err("browser draft contains a sensitive control".into());
        }
        let valid_value = match &control.value {
            serde_json::Value::String(value) => {
                value.chars().count() <= MAX_BROWSER_DRAFT_VALUE_CHARS
            }
            serde_json::Value::Bool(_) => true,
            serde_json::Value::Array(values) => {
                values.len() <= MAX_BROWSER_DRAFT_CONTROLS
                    && values.iter().all(|value| {
                        value.as_str().is_some_and(|value| {
                            value.chars().count() <= MAX_BROWSER_DRAFT_VALUE_CHARS
                        })
                    })
            }
            _ => false,
        };
        if !valid_value {
            return Err("browser draft contains an invalid or oversized value".into());
        }
    }
    Ok(())
}

fn is_sensitive_control(control: &BrowserDraftControl) -> bool {
    let descriptor = format!(
        "{} {} {} {} {}",
        control.control_type,
        control.name.as_deref().unwrap_or_default(),
        control.id.as_deref().unwrap_or_default(),
        control.autocomplete.as_deref().unwrap_or_default(),
        control.label.as_deref().unwrap_or_default(),
    )
    .to_ascii_lowercase();
    control.control_type.eq_ignore_ascii_case("password")
        || control.control_type.eq_ignore_ascii_case("file")
        || descriptor.contains("cc-number")
        || descriptor.contains("credit-card")
        || descriptor.contains("card-number")
        || descriptor.contains("security-code")
        || descriptor.contains("cvv")
        || descriptor.contains("cvc")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn payload(value: &str) -> BrowserDraftSecret {
        BrowserDraftSecret {
            schema_version: 1,
            objective_revision: 3,
            target_id: "booking".into(),
            origin: "https://rail.example".into(),
            generation: 7,
            controls: vec![BrowserDraftControl {
                draft_ref: "draft-1".into(),
                tag: "input".into(),
                control_type: "email".into(),
                name: Some("passenger_email".into()),
                id: None,
                autocomplete: Some("email".into()),
                label: Some("Email".into()),
                form_id: Some("booking".into()),
                value: json!(value),
            }],
        }
    }

    #[test]
    fn encrypted_draft_is_separate_round_trips_and_deletes_idempotently() {
        let root = std::env::temp_dir().join(format!(
            "homun-browser-checkpoint-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let checkpoint_path = root.join("browser-checkpoint-secrets.json");
        let connector_path = root.join("secrets.json");
        std::fs::write(&connector_path, b"connector-store-sentinel").unwrap();
        let store = BrowserCheckpointSecretStore::open(&checkpoint_path, [7u8; 32]).unwrap();
        let sentinel = "ada.private@example.test";

        let reference = store
            .put("user", "workspace", "opaque-1", &payload(sentinel))
            .unwrap();
        let raw = std::fs::read_to_string(&checkpoint_path).unwrap();
        assert!(!raw.contains(sentinel));
        assert_eq!(
            std::fs::read_to_string(&connector_path).unwrap(),
            "connector-store-sentinel"
        );
        assert_eq!(
            store.get(&reference, "user", "workspace").unwrap().unwrap(),
            payload(sentinel)
        );

        store.delete(&reference).unwrap();
        store.delete(&reference).unwrap();
        assert!(
            store
                .get(&reference, "user", "workspace")
                .unwrap()
                .is_none()
        );
        assert!(
            !std::fs::read_to_string(&checkpoint_path)
                .unwrap()
                .contains(sentinel)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_schema_sensitive_controls_and_scope_fail_closed() {
        let root = std::env::temp_dir().join(format!(
            "homun-browser-checkpoint-invalid-test-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let store =
            BrowserCheckpointSecretStore::open(root.join("drafts.json"), [9u8; 32]).unwrap();
        let mut invalid = payload("safe");
        invalid.schema_version = 2;
        assert!(
            store
                .put("user", "workspace", "bad-schema", &invalid)
                .is_err()
        );
        invalid.schema_version = 1;
        invalid.controls[0].control_type = "password".into();
        assert!(
            store
                .put("user", "workspace", "password", &invalid)
                .is_err()
        );

        let reference = store
            .put("user", "workspace", "valid", &payload("safe"))
            .unwrap();
        assert!(store.get(&reference, "other-user", "workspace").is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
