use crate::{
    DataSensitivity, MemoryRecord, MemoryRef, MemoryRefKind, PERSONAL_WORKSPACE, THREADS_WORKSPACE,
    UserId, WorkspaceId, contains_secret,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
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

#[derive(Debug, Clone, PartialEq)]
pub struct AuthorizedMemorySource {
    pub source_user_id: UserId,
    pub source_workspace_id: WorkspaceId,
    pub source_label: String,
    pub grant_id: Option<String>,
    pub policy: Option<MemorySourcePolicy>,
    pub policy_version: u64,
}

pub(crate) fn validate_memory_source_grant_intrinsic(
    grant: &MemorySourceGrant,
) -> Result<(), String> {
    let required_identities = [
        ("empty_grant_id", grant.id.as_str()),
        ("empty_consumer_user", grant.consumer_user_id.as_str()),
        (
            "empty_consumer_workspace",
            grant.consumer_workspace_id.as_str(),
        ),
        ("empty_source_user", grant.source_user_id.as_str()),
        ("empty_source_workspace", grant.source_workspace_id.as_str()),
        ("empty_created_by", grant.created_by.as_str()),
    ];
    for (error, value) in required_identities {
        if value.trim().is_empty() {
            return Err(error.to_string());
        }
    }

    let consumer_workspace = grant.consumer_workspace_id.as_str();
    let source_workspace = grant.source_workspace_id.as_str();
    if matches!(consumer_workspace, PERSONAL_WORKSPACE | THREADS_WORKSPACE) {
        return Err("reserved_consumer_scope".to_string());
    }
    if source_workspace == THREADS_WORKSPACE {
        return Err("reserved_source_scope".to_string());
    }
    if grant.consumer_user_id != grant.source_user_id {
        return Err("cross_user_source_not_supported".to_string());
    }
    if grant.consumer_user_id == grant.source_user_id
        && grant.consumer_workspace_id == grant.source_workspace_id
    {
        return Err("source_equals_consumer".to_string());
    }
    if grant.collections.is_empty() && grant.overrides.is_empty() {
        return Err("empty_source_policy".to_string());
    }
    for reference in grant.overrides.keys() {
        if reference.kind != MemoryRefKind::Memory {
            return Err("invalid_override_kind".to_string());
        }
        if reference.user_id != grant.source_user_id
            || reference.workspace_id != grant.source_workspace_id
        {
            return Err("override_outside_source".to_string());
        }
    }
    if grant.policy_version == 0 {
        return Err("invalid_policy_version".to_string());
    }

    Ok(())
}

pub fn resolve_memory_sources(
    consumer_user: &UserId,
    consumer_workspace: &WorkspaceId,
    grants: &[MemorySourceGrant],
    now_unix: i64,
) -> Result<Vec<AuthorizedMemorySource>, String> {
    if consumer_user.as_str().trim().is_empty() {
        return Err("empty_consumer_user".to_string());
    }
    if consumer_workspace.as_str().trim().is_empty() {
        return Err("empty_consumer_workspace".to_string());
    }
    if matches!(
        consumer_workspace.as_str(),
        PERSONAL_WORKSPACE | THREADS_WORKSPACE
    ) {
        return Err("reserved_consumer_scope".to_string());
    }

    let mut linked = Vec::new();
    let mut active_source_scopes = BTreeSet::new();

    for grant in grants.iter().filter(|grant| {
        grant.consumer_user_id == *consumer_user
            && grant.consumer_workspace_id == *consumer_workspace
    }) {
        validate_memory_source_grant_intrinsic(grant)?;

        if grant.revoked_at.is_some() || grant.expires_at.is_some_and(|expiry| expiry <= now_unix) {
            continue;
        }

        let source_scope = (
            grant.source_user_id.as_str().to_string(),
            grant.source_workspace_id.as_str().to_string(),
        );
        if !active_source_scopes.insert(source_scope) {
            return Err("duplicate_active_source".to_string());
        }

        linked.push(AuthorizedMemorySource {
            source_user_id: grant.source_user_id.clone(),
            source_workspace_id: grant.source_workspace_id.clone(),
            source_label: if grant.source_workspace_id.as_str() == PERSONAL_WORKSPACE {
                "Personal".to_string()
            } else {
                grant.source_workspace_id.as_str().to_string()
            },
            grant_id: Some(grant.id.clone()),
            policy: Some(MemorySourcePolicy {
                collections: grant.collections.clone(),
                max_sensitivity: grant.max_sensitivity,
                overrides: grant.overrides.clone(),
            }),
            policy_version: grant.policy_version,
        });
    }

    linked.sort_unstable_by(|left, right| {
        (
            left.source_user_id.as_str(),
            left.source_workspace_id.as_str(),
            left.grant_id.as_deref(),
        )
            .cmp(&(
                right.source_user_id.as_str(),
                right.source_workspace_id.as_str(),
                right.grant_id.as_deref(),
            ))
    });

    let mut sources = Vec::with_capacity(linked.len() + 1);
    sources.push(AuthorizedMemorySource {
        source_user_id: consumer_user.clone(),
        source_workspace_id: consumer_workspace.clone(),
        source_label: consumer_workspace.as_str().to_string(),
        grant_id: None,
        policy: None,
        policy_version: 0,
    });
    sources.extend(linked);
    Ok(sources)
}

pub fn memory_source_policy_fingerprint(sources: &[AuthorizedMemorySource]) -> u64 {
    let mut encoded_sources = sources.iter().map(encode_source).collect::<Vec<_>>();
    encoded_sources.sort_unstable();

    let mut canonical = Vec::new();
    push_field(&mut canonical, 1, b"homun-memory-source-policy-v1");
    push_u64(&mut canonical, 2, encoded_sources.len() as u64);
    for source in encoded_sources {
        push_field(&mut canonical, 3, &source);
    }

    let digest = Sha256::digest(canonical);
    u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix is 8 bytes"))
}

fn encode_source(source: &AuthorizedMemorySource) -> Vec<u8> {
    let mut encoded = Vec::new();
    push_u8(
        &mut encoded,
        1,
        if source.grant_id.is_some() { 1 } else { 0 },
    );
    push_field(&mut encoded, 2, source.source_user_id.as_str().as_bytes());
    push_field(
        &mut encoded,
        3,
        source.source_workspace_id.as_str().as_bytes(),
    );
    match &source.grant_id {
        Some(grant_id) => push_field(&mut encoded, 4, grant_id.as_bytes()),
        None => push_field(&mut encoded, 5, &[]),
    }
    push_u64(&mut encoded, 6, source.policy_version);
    match &source.policy {
        Some(policy) => {
            push_u8(&mut encoded, 7, 1);
            for collection in &policy.collections {
                push_u8(&mut encoded, 8, collection_tag(*collection));
            }
            push_u8(&mut encoded, 9, sensitivity_tag(policy.max_sensitivity));

            let mut overrides = policy
                .overrides
                .iter()
                .map(|(reference, effect)| encode_override(reference, *effect))
                .collect::<Vec<_>>();
            overrides.sort_unstable();
            for entry in overrides {
                push_field(&mut encoded, 10, &entry);
            }
        }
        None => push_u8(&mut encoded, 7, 0),
    }
    encoded
}

fn encode_override(reference: &MemoryRef, effect: MemoryGrantOverrideEffect) -> Vec<u8> {
    let mut encoded = Vec::new();
    push_u8(&mut encoded, 1, memory_ref_kind_tag(reference.kind));
    push_field(&mut encoded, 2, reference.scope.as_bytes());
    push_field(&mut encoded, 3, reference.user_id.as_str().as_bytes());
    push_field(&mut encoded, 4, reference.workspace_id.as_str().as_bytes());
    push_field(&mut encoded, 5, reference.key.as_bytes());
    push_u8(
        &mut encoded,
        6,
        match effect {
            MemoryGrantOverrideEffect::Allow => 1,
            MemoryGrantOverrideEffect::Deny => 2,
        },
    );
    encoded
}

fn push_field(buffer: &mut Vec<u8>, tag: u8, value: &[u8]) {
    buffer.push(tag);
    buffer.extend_from_slice(&(value.len() as u64).to_be_bytes());
    buffer.extend_from_slice(value);
}

fn push_u8(buffer: &mut Vec<u8>, tag: u8, value: u8) {
    push_field(buffer, tag, &[value]);
}

fn push_u64(buffer: &mut Vec<u8>, tag: u8, value: u64) {
    push_field(buffer, tag, &value.to_be_bytes());
}

fn collection_tag(collection: MemoryCollectionKey) -> u8 {
    match collection {
        MemoryCollectionKey::Preferences => 1,
        MemoryCollectionKey::Profile => 2,
        MemoryCollectionKey::Knowledge => 3,
        MemoryCollectionKey::Decisions => 4,
        MemoryCollectionKey::Goals => 5,
        MemoryCollectionKey::Artifacts => 6,
        MemoryCollectionKey::Episodes => 7,
    }
}

fn sensitivity_tag(sensitivity: DataSensitivity) -> u8 {
    match sensitivity {
        DataSensitivity::Public => 1,
        DataSensitivity::Internal => 2,
        DataSensitivity::Private => 3,
        DataSensitivity::Confidential => 4,
        DataSensitivity::Secret => 5,
    }
}

fn memory_ref_kind_tag(kind: MemoryRefKind) -> u8 {
    match kind {
        MemoryRefKind::Event => 1,
        MemoryRefKind::Memory => 2,
        MemoryRefKind::Entity => 3,
        MemoryRefKind::Relation => 4,
        MemoryRefKind::Wiki => 5,
        MemoryRefKind::Graph => 6,
        MemoryRefKind::Routine => 7,
        MemoryRefKind::Automation => 8,
        MemoryRefKind::Audit => 9,
    }
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
    use crate::MemoryRefKind;
    use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
    use std::collections::HashMap;

    #[derive(Serialize, Deserialize)]
    struct OverrideEntry {
        memory_ref: MemoryRef,
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
                memory_ref: reference.clone(),
                effect: *effect,
            })
            .collect::<Vec<_>>();
        entries.sort_unstable_by(|left, right| {
            memory_ref_sort_key(&left.memory_ref).cmp(&memory_ref_sort_key(&right.memory_ref))
        });
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
            let reference = entry.memory_ref;
            if overrides.contains_key(&reference) {
                return Err(D::Error::custom("duplicate memory_ref entry"));
            }
            overrides.insert(reference, entry.effect);
        }

        Ok(overrides)
    }

    fn memory_ref_sort_key(reference: &MemoryRef) -> (&'static str, &str, &str, &str, &str) {
        (
            memory_ref_kind_name(reference.kind),
            reference.scope.as_str(),
            reference.user_id.as_str(),
            reference.workspace_id.as_str(),
            reference.key.as_str(),
        )
    }

    fn memory_ref_kind_name(kind: MemoryRefKind) -> &'static str {
        match kind {
            MemoryRefKind::Event => "event",
            MemoryRefKind::Memory => "memory",
            MemoryRefKind::Entity => "entity",
            MemoryRefKind::Relation => "relation",
            MemoryRefKind::Wiki => "wiki",
            MemoryRefKind::Graph => "graph",
            MemoryRefKind::Routine => "routine",
            MemoryRefKind::Automation => "automation",
            MemoryRefKind::Audit => "audit",
        }
    }
}
