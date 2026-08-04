// Shared memory graph helpers used by runtime-plan and artifact provenance owners.
use crate::*;
pub(crate) fn provenance_key_fragment(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['.', '-']).trim();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn upsert_memory_relation(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    privacy_domain: &str,
    relation_key: String,
    source_ref: MemoryRef,
    relation_type: &str,
    target_ref: MemoryRef,
    evidence: Vec<MemoryRef>,
    metadata: serde_json::Value,
) -> Result<(), String> {
    facade
        .upsert_relation(&MemoryRelation {
            reference: MemoryRef::new(
                MemoryRefKind::Relation,
                user.clone(),
                workspace.clone(),
                relation_key,
            ),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            source_ref,
            relation_type: relation_type.to_string(),
            target_ref,
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new(privacy_domain),
            sensitivity: MemoryDataSensitivity::Internal,
            evidence,
            metadata,
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn provenance_key_fragment_sanitizes_unstable_relation_keys() {
        assert_eq!(
            super::provenance_key_fragment(" reports/final v1.pdf "),
            "reports-final-v1.pdf"
        );
        assert_eq!(super::provenance_key_fragment("///"), "unknown");
    }
}
