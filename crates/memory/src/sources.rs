use crate::{DataSensitivity, MemoryRecord, MemoryRef, UserId, WorkspaceId, contains_secret};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCollectionKey {
    Preferences,
    Profile,
    Knowledge,
    Decisions,
    Goals,
    Artifacts,
    Episodes,
}

impl MemoryCollectionKey {
    pub fn matches(&self, memory: &MemoryRecord) -> bool {
        let is_personal_profile = memory.memory_type == "fact"
            && memory
                .metadata
                .get("scope")
                .and_then(serde_json::Value::as_str)
                == Some("personal");

        match self {
            Self::Preferences => memory.memory_type == "preference",
            Self::Profile => is_personal_profile,
            Self::Knowledge => {
                memory.memory_type == "note"
                    || (memory.memory_type == "fact" && !is_personal_profile)
            }
            Self::Decisions => memory.memory_type == "decision",
            Self::Goals => matches!(
                memory.memory_type.as_str(),
                "goal" | "objective" | "open_loop"
            ),
            Self::Artifacts => memory.memory_type == "artifact",
            Self::Episodes => memory.memory_type == "episode",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryGrantOverrideEffect {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySourceGrant {
    pub id: String,
    pub consumer_user_id: UserId,
    pub consumer_workspace_id: WorkspaceId,
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub collections: BTreeSet<MemoryCollectionKey>,
    pub max_sensitivity: DataSensitivity,
    #[serde(with = "memory_ref_override_map")]
    pub overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>,
    pub expires_at: Option<i64>,
    pub revoked_at: Option<i64>,
    pub policy_version: u64,
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemorySourceDecision {
    allowed: bool,
    reason: &'static str,
}

impl MemorySourceDecision {
    pub fn allow() -> Self {
        Self {
            allowed: true,
            reason: "allowed",
        }
    }

    pub fn deny(reason: &'static str) -> Self {
        Self {
            allowed: false,
            reason,
        }
    }

    pub fn is_allowed(&self) -> bool {
        self.allowed
    }

    pub fn reason(&self) -> &'static str {
        self.reason
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemorySourcePolicy {
    pub collections: BTreeSet<MemoryCollectionKey>,
    pub max_sensitivity: DataSensitivity,
    #[serde(with = "memory_ref_override_map")]
    pub overrides: HashMap<MemoryRef, MemoryGrantOverrideEffect>,
}

impl MemorySourcePolicy {
    pub fn for_collections(
        collections: Vec<MemoryCollectionKey>,
        max_sensitivity: DataSensitivity,
    ) -> Self {
        Self {
            collections: collections.into_iter().collect(),
            max_sensitivity,
            overrides: HashMap::new(),
        }
    }

    pub fn set_override(&mut self, reference: MemoryRef, effect: MemoryGrantOverrideEffect) {
        self.overrides.insert(reference, effect);
    }

    pub fn allows(&self, memory: &MemoryRecord) -> MemorySourceDecision {
        if memory.sensitivity == DataSensitivity::Secret {
            return MemorySourceDecision::deny("secret_never_shareable");
        }

        let payload = serde_json::json!({
            "text": &memory.text,
            "metadata": &memory.metadata,
        });
        if contains_secret(&payload) {
            return MemorySourceDecision::deny("vault_payload_never_shareable");
        }

        if memory.sensitivity > self.max_sensitivity {
            return MemorySourceDecision::deny("sensitivity_above_grant");
        }

        let override_effect = self.overrides.get(&memory.reference);
        if override_effect == Some(&MemoryGrantOverrideEffect::Deny) {
            return MemorySourceDecision::deny("memory_explicitly_denied");
        }

        if self
            .collections
            .iter()
            .any(|collection| collection.matches(memory))
            || override_effect == Some(&MemoryGrantOverrideEffect::Allow)
        {
            return MemorySourceDecision::allow();
        }

        MemorySourceDecision::deny("collection_not_allowed")
    }
}

mod memory_ref_override_map {
    use super::{MemoryGrantOverrideEffect, MemoryRef};
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
    use std::{collections::HashMap, str::FromStr};

    #[derive(Serialize, Deserialize)]
    struct OverrideEntry {
        memory_ref: String,
        effect: MemoryGrantOverrideEffect,
    }

    pub(super) fn serialize<S>(
        overrides: &HashMap<MemoryRef, MemoryGrantOverrideEffect>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut entries = overrides
            .iter()
            .map(|(reference, effect)| OverrideEntry {
                memory_ref: reference.to_string(),
                effect: *effect,
            })
            .collect::<Vec<_>>();
        entries.sort_unstable_by(|left, right| left.memory_ref.cmp(&right.memory_ref));
        entries.serialize(serializer)
    }

    pub(super) fn deserialize<'de, D>(
        deserializer: D,
    ) -> Result<HashMap<MemoryRef, MemoryGrantOverrideEffect>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let entries = Vec::<OverrideEntry>::deserialize(deserializer)?;
        let mut overrides = HashMap::with_capacity(entries.len());

        for entry in entries {
            let reference = MemoryRef::from_str(&entry.memory_ref).map_err(D::Error::custom)?;
            if overrides.contains_key(&reference) {
                return Err(D::Error::custom(format!(
                    "duplicate memory_ref {}",
                    entry.memory_ref
                )));
            }
            overrides.insert(reference, entry.effect);
        }

        Ok(overrides)
    }
}
