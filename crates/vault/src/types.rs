use crate::VaultCategory;
use local_first_secrets::SecretRef;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct VaultRecordId(String);

impl VaultRecordId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        if value.is_empty()
            || value.contains('/')
            || value.contains('\\')
            || value == "."
            || value == ".."
            || value.contains("..")
        {
            return Err(format!("invalid vault record id: {value}"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VaultRecord {
    pub id: VaultRecordId,
    pub category: VaultCategory,
    pub label: String,
    pub secret_ref: SecretRef,
    pub metadata: serde_json::Value,
}

impl VaultRecord {
    pub fn new(
        id: VaultRecordId,
        category: VaultCategory,
        label: impl Into<String>,
        secret_ref: SecretRef,
        metadata: serde_json::Value,
    ) -> Result<Self, String> {
        reject_forbidden_metadata(&metadata)?;
        Ok(Self {
            id,
            category,
            label: label.into(),
            secret_ref,
            metadata,
        })
    }
}

fn reject_forbidden_metadata(value: &serde_json::Value) -> Result<(), String> {
    match value {
        serde_json::Value::Object(map) => {
            for (key, value) in map {
                let normalized = key.to_ascii_lowercase().replace(['-', ' '], "_");
                if matches!(
                    normalized.as_str(),
                    "cvv" | "cvc" | "cv2" | "cvv2" | "security_code" | "card_security_code"
                ) {
                    return Err(
                        "CVV/CV2 must be one-shot and cannot be stored in Vault metadata"
                            .to_string(),
                    );
                }
                reject_forbidden_metadata(value)?;
            }
            Ok(())
        }
        serde_json::Value::Array(values) => {
            for value in values {
                reject_forbidden_metadata(value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
