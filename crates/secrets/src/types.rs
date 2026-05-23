use crate::{SecretError, SecretResult};
use serde::{Deserialize, Serialize, Serializer};
use std::fmt::{Debug, Display, Formatter};
use std::str::FromStr;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SecretRef(String);

impl SecretRef {
    pub fn new(
        user_id: impl AsRef<str>,
        workspace_id: impl AsRef<str>,
        provider_id: impl AsRef<str>,
        connection_id: impl AsRef<str>,
    ) -> SecretResult<Self> {
        let parts = [
            user_id.as_ref(),
            workspace_id.as_ref(),
            provider_id.as_ref(),
            connection_id.as_ref(),
        ];
        for part in parts {
            validate_part(part)?;
        }
        Ok(Self(format!(
            "secret://{}/{}/{}/{}",
            parts[0], parts[1], parts[2], parts[3]
        )))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn user_id(&self) -> &str {
        self.parts()[0]
    }

    pub fn workspace_id(&self) -> &str {
        self.parts()[1]
    }

    pub fn provider_id(&self) -> &str {
        self.parts()[2]
    }

    pub fn connection_id(&self) -> &str {
        self.parts()[3]
    }

    fn parts(&self) -> [&str; 4] {
        let rest = self.0.trim_start_matches("secret://");
        let mut parts = rest.split('/');
        [
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
            parts.next().unwrap_or_default(),
        ]
    }
}

impl FromStr for SecretRef {
    type Err = SecretError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some(rest) = value.strip_prefix("secret://") else {
            return Err(SecretError::InvalidRef(
                "secret refs must use secret:// scheme".to_string(),
            ));
        };
        let parts: Vec<_> = rest.split('/').collect();
        if parts.len() != 4 {
            return Err(SecretError::InvalidRef(
                "secret refs must have user/workspace/provider/connection".to_string(),
            ));
        }
        Self::new(parts[0], parts[1], parts[2], parts[3])
    }
}

impl Display for SecretRef {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SecretMaterial {
    bytes: Vec<u8>,
}

impl SecretMaterial {
    pub fn from_string(value: impl Into<String>) -> Self {
        Self {
            bytes: value.into().into_bytes(),
        }
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub fn expose_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn expose_utf8(&self) -> SecretResult<String> {
        Ok(String::from_utf8(self.bytes.clone())?)
    }
}

impl Debug for SecretMaterial {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretMaterial([REDACTED])")
    }
}

impl Serialize for SecretMaterial {
    fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        Err(serde::ser::Error::custom(
            "SecretMaterial cannot be serialized",
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretStatus {
    Active,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretMetadata {
    pub reference: SecretRef,
    pub status: SecretStatus,
    pub version: u64,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl SecretMetadata {
    pub fn new(reference: SecretRef) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            reference,
            status: SecretStatus::Active,
            version: 1,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn rotated(mut self) -> Self {
        self.status = SecretStatus::Active;
        self.version += 1;
        self.updated_at = OffsetDateTime::now_utc();
        self
    }

    pub fn deleted(mut self) -> Self {
        self.status = SecretStatus::Deleted;
        self.updated_at = OffsetDateTime::now_utc();
        self
    }
}

fn validate_part(part: &str) -> SecretResult<()> {
    if part.is_empty()
        || part.contains('/')
        || part.contains('\\')
        || part == "."
        || part == ".."
        || part.contains("..")
    {
        return Err(SecretError::InvalidRef(format!("invalid path segment: {part}")));
    }
    Ok(())
}
