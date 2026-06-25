use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use time::OffsetDateTime;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UserId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WorkspaceId(String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProviderId(String);

impl UserId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl WorkspaceId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl ProviderId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for UserId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for WorkspaceId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<&str> for ProviderId {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityProviderKind {
    Native,
    Mcp,
    Managed,
    Browser,
    Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataBoundary {
    Local,
    LocalNetwork,
    ManagedCloud,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionClass {
    Read,
    Draft,
    WriteWithConfirmation,
    ApprovedAutomation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManagedProviderMetadata {
    pub provider_name: String,
    pub data_boundary: DataBoundary,
    pub auth_mode: String,
    pub data_categories: Vec<String>,
    pub retention_notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityTool {
    pub name: String,
    pub provider_id: ProviderId,
    pub provider_kind: CapabilityProviderKind,
    pub action: ActionClass,
    pub description: String,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Active,
    Expired,
    Failed,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityConnection {
    pub id: String,
    pub provider_id: ProviderId,
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub status: ConnectionStatus,
    pub display_name: String,
    pub privacy_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityCall {
    pub provider_id: ProviderId,
    pub tool_name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityCallResult {
    pub provider_id: ProviderId,
    pub tool_name: String,
    pub output: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerStatus {
    Active,
    Disabled,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CapabilityTrigger {
    pub id: String,
    pub provider_id: ProviderId,
    pub name: String,
    pub status: TriggerStatus,
    pub privacy_domains: Vec<String>,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillPermissions {
    pub network: Vec<String>,
    pub filesystem: Vec<String>,
    pub privacy_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillToolManifest {
    pub name: String,
    pub description: String,
    pub action: ActionClass,
    pub privacy_domains: Vec<String>,
    pub sensitivity: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillManifest {
    pub id: String,
    pub version: String,
    pub description: String,
    pub runtime: String,
    pub tools: Vec<SkillToolManifest>,
    pub permissions: SkillPermissions,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginChannel {
    Stable,
    Beta,
}

impl Default for PluginChannel {
    fn default() -> Self {
        Self::Stable
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginEntitlement {
    Free,
    Paid,
}

impl Default for PluginEntitlement {
    fn default() -> Self {
        Self::Free
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginCapabilityKind {
    Panel,
    Skill,
    Workflow,
    Connector,
    TemplateCatalog,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginSignature {
    pub algorithm: String,
    pub public_key: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginCapabilityDeclaration {
    pub id: String,
    pub kind: PluginCapabilityKind,
    pub description: String,
    pub action: ActionClass,
    pub privacy_domains: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginRegistryEntry {
    pub plugin_id: String,
    pub version: String,
    pub channel: PluginChannel,
    pub min_homun_version: Option<String>,
    pub entitlement: PluginEntitlement,
    pub manifest_url: String,
    pub package_url: String,
    pub package_sha256: String,
    pub signature: PluginSignature,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginRegistryValidationError {
    BetaChannelDisabled,
    IncompatibleHomunVersion,
    InvalidPackageDigest,
    InvalidPublicKey,
    InvalidSignature,
    PackageDigestMismatch,
    UntrustedPublicKey,
    UnsupportedSignatureAlgorithm,
}

impl PluginRegistryEntry {
    pub fn validate_metadata(&self) -> Result<(), PluginRegistryValidationError> {
        let Some(digest) = self.package_sha256.strip_prefix("sha256:") else {
            return Err(PluginRegistryValidationError::InvalidPackageDigest);
        };
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(PluginRegistryValidationError::InvalidPackageDigest);
        }
        if self.signature.algorithm.to_ascii_lowercase() != "ed25519" {
            return Err(PluginRegistryValidationError::UnsupportedSignatureAlgorithm);
        }
        Ok(())
    }

    pub fn package_digest_matches(&self, package_bytes: &[u8]) -> bool {
        let Some(expected) = self.package_sha256.strip_prefix("sha256:") else {
            return false;
        };
        let actual = format!("{:x}", Sha256::digest(package_bytes));
        expected.eq_ignore_ascii_case(&actual)
    }

    pub fn verify_package_signature(
        &self,
        package_bytes: &[u8],
    ) -> Result<(), PluginRegistryValidationError> {
        self.validate_metadata()?;
        if !self.package_digest_matches(package_bytes) {
            return Err(PluginRegistryValidationError::PackageDigestMismatch);
        }
        let public_key = decode_fixed_hex::<32>(&self.signature.public_key)
            .ok_or(PluginRegistryValidationError::InvalidPublicKey)?;
        let signature_bytes = decode_fixed_hex::<64>(&self.signature.signature)
            .ok_or(PluginRegistryValidationError::InvalidSignature)?;
        let verifying_key = VerifyingKey::from_bytes(&public_key)
            .map_err(|_| PluginRegistryValidationError::InvalidPublicKey)?;
        let signature = Signature::from_bytes(&signature_bytes);
        verifying_key
            .verify(package_bytes, &signature)
            .map_err(|_| PluginRegistryValidationError::InvalidSignature)
    }

    pub fn verify_install_candidate(
        &self,
        package_bytes: &[u8],
        homun_version: &str,
        beta_enabled: bool,
        trusted_public_keys: &[String],
    ) -> Result<(), PluginRegistryValidationError> {
        if !self.is_available_for_channel_policy(beta_enabled) {
            return Err(PluginRegistryValidationError::BetaChannelDisabled);
        }
        if !self.is_compatible_with_homun(homun_version) {
            return Err(PluginRegistryValidationError::IncompatibleHomunVersion);
        }
        if !trusted_public_keys
            .iter()
            .any(|key| key.eq_ignore_ascii_case(&self.signature.public_key))
        {
            return Err(PluginRegistryValidationError::UntrustedPublicKey);
        }
        self.verify_package_signature(package_bytes)
    }

    pub fn is_available_for_channel_policy(&self, beta_enabled: bool) -> bool {
        match self.channel {
            PluginChannel::Stable => true,
            PluginChannel::Beta => beta_enabled,
        }
    }

    pub fn is_compatible_with_homun(&self, homun_version: &str) -> bool {
        let Some(min_version) = self.min_homun_version.as_deref() else {
            return true;
        };
        let Some(current) = parse_plugin_semver(homun_version) else {
            return false;
        };
        let Some(minimum) = parse_plugin_semver(min_version) else {
            return false;
        };
        current >= minimum
    }

    pub fn is_newer_than(&self, installed_version: &str) -> bool {
        let Some(candidate) = parse_plugin_semver(&self.version) else {
            return false;
        };
        let Some(installed) = parse_plugin_semver(installed_version) else {
            return false;
        };
        candidate > installed
    }
}

fn decode_fixed_hex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 {
        return None;
    }
    let mut out = [0_u8; N];
    for index in 0..N {
        out[index] = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

fn parse_plugin_semver(value: &str) -> Option<Version> {
    Version::parse(value.strip_prefix('v').unwrap_or(value)).ok()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginRegistryIndex {
    pub schema_version: u32,
    pub generated_at: String,
    pub plugins: Vec<PluginRegistryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPackageManifest {
    pub schema_version: u32,
    pub plugin_id: String,
    pub version: String,
    pub manifest_path: String,
    pub files: Vec<PluginPackageFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginPackageFile {
    pub path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginPackageValidationError {
    EmptyPackage,
    InvalidDigest,
    MissingManifest,
    UnsafePath,
}

impl PluginPackageManifest {
    pub fn validate_layout(&self) -> Result<(), PluginPackageValidationError> {
        if self.files.is_empty() {
            return Err(PluginPackageValidationError::EmptyPackage);
        }
        if !is_safe_package_path(&self.manifest_path) {
            return Err(PluginPackageValidationError::UnsafePath);
        }
        if !self
            .files
            .iter()
            .any(|file| file.path == self.manifest_path)
        {
            return Err(PluginPackageValidationError::MissingManifest);
        }
        for file in &self.files {
            if !is_safe_package_path(&file.path) {
                return Err(PluginPackageValidationError::UnsafePath);
            }
            if !is_sha256_digest(&file.sha256) {
                return Err(PluginPackageValidationError::InvalidDigest);
            }
        }
        Ok(())
    }
}

fn is_safe_package_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn is_sha256_digest(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginLicenseClaims {
    pub plugin_id: String,
    pub licensee: String,
    pub entitlement: PluginEntitlement,
    pub issued_at: i64,
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginLicenseToken {
    pub claims: PluginLicenseClaims,
    pub signature: PluginSignature,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginLicenseValidationError {
    Expired,
    InvalidPublicKey,
    InvalidSignature,
    PluginMismatch,
    SerializationFailed,
    UnsupportedSignatureAlgorithm,
}

impl PluginLicenseToken {
    pub fn verify_offline(
        &self,
        plugin_id: &str,
        now_unix: i64,
    ) -> Result<(), PluginLicenseValidationError> {
        if self.claims.plugin_id != plugin_id {
            return Err(PluginLicenseValidationError::PluginMismatch);
        }
        if self
            .claims
            .expires_at
            .is_some_and(|expires_at| now_unix > expires_at)
        {
            return Err(PluginLicenseValidationError::Expired);
        }
        if self.signature.algorithm.to_ascii_lowercase() != "ed25519" {
            return Err(PluginLicenseValidationError::UnsupportedSignatureAlgorithm);
        }
        let public_key = decode_fixed_hex::<32>(&self.signature.public_key)
            .ok_or(PluginLicenseValidationError::InvalidPublicKey)?;
        let signature_bytes = decode_fixed_hex::<64>(&self.signature.signature)
            .ok_or(PluginLicenseValidationError::InvalidSignature)?;
        let verifying_key = VerifyingKey::from_bytes(&public_key)
            .map_err(|_| PluginLicenseValidationError::InvalidPublicKey)?;
        let signature = Signature::from_bytes(&signature_bytes);
        let payload = serde_json::to_vec(&self.claims)
            .map_err(|_| PluginLicenseValidationError::SerializationFailed)?;
        verifying_key
            .verify(&payload, &signature)
            .map_err(|_| PluginLicenseValidationError::InvalidSignature)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    #[serde(default)]
    pub channel: PluginChannel,
    #[serde(default)]
    pub min_homun_version: Option<String>,
    pub display_name: String,
    #[serde(default)]
    pub entitlement: PluginEntitlement,
    #[serde(default)]
    pub signature: Option<PluginSignature>,
    #[serde(default)]
    pub capabilities: Vec<PluginCapabilityDeclaration>,
    pub skills: Vec<SkillManifest>,
}

impl PluginManifest {
    pub fn new(
        id: impl Into<String>,
        version: impl Into<String>,
        display_name: impl Into<String>,
        skills: Vec<SkillManifest>,
    ) -> Self {
        Self {
            id: id.into(),
            version: version.into(),
            channel: PluginChannel::Stable,
            min_homun_version: None,
            display_name: display_name.into(),
            entitlement: PluginEntitlement::Free,
            signature: None,
            capabilities: Vec::new(),
            skills,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillTrustLevel {
    Untrusted,
    Reviewed,
    TrustedLocal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkillInstallRecord {
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub skill_id: String,
    pub version: String,
    pub source_path: String,
    pub trust_level: SkillTrustLevel,
    pub manifest_hash: Option<String>,
    pub enabled: bool,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl SkillInstallRecord {
    pub fn new(
        user_id: UserId,
        workspace_id: WorkspaceId,
        skill_id: impl Into<String>,
        version: impl Into<String>,
        source_path: impl Into<String>,
        trust_level: SkillTrustLevel,
    ) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            user_id,
            workspace_id,
            skill_id: skill_id.into(),
            version: version.into(),
            source_path: source_path.into(),
            trust_level,
            manifest_hash: None,
            enabled: true,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    pub fn with_manifest_hash(mut self, manifest_hash: impl Into<String>) -> Self {
        self.manifest_hash = Some(manifest_hash.into());
        self
    }

    pub fn provider_id(&self) -> ProviderId {
        ProviderId::new(format!("skill:{}", self.skill_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginInstallRecord {
    pub user_id: UserId,
    pub workspace_id: WorkspaceId,
    pub plugin_id: String,
    pub version: String,
    pub source_path: String,
    pub trust_level: SkillTrustLevel,
    pub manifest_hash: Option<String>,
    pub enabled: bool,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

impl PluginInstallRecord {
    pub fn new(
        user_id: UserId,
        workspace_id: WorkspaceId,
        plugin_id: impl Into<String>,
        version: impl Into<String>,
        source_path: impl Into<String>,
        trust_level: SkillTrustLevel,
    ) -> Self {
        let now = OffsetDateTime::now_utc();
        Self {
            user_id,
            workspace_id,
            plugin_id: plugin_id.into(),
            version: version.into(),
            source_path: source_path.into(),
            trust_level,
            manifest_hash: None,
            enabled: true,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    pub fn with_manifest_hash(mut self, manifest_hash: impl Into<String>) -> Self {
        self.manifest_hash = Some(manifest_hash.into());
        self
    }
}
