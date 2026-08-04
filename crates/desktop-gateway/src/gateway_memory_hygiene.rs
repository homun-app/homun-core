// Memory graph hygiene suggestions and shared entity-name normalization.
use crate::*;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct MemoryHygieneSuggestion {
    pub(crate) survivor_ref: String,
    pub(crate) absorbed_ref: String,
    pub(crate) survivor_label: String,
    pub(crate) absorbed_label: String,
    pub(crate) reason: String,
    pub(crate) safe_auto_merge: bool,
    pub(crate) confidence: f64,
}

pub(crate) fn normalized_entity_name(name: &str) -> String {
    sanitize_dedup_key("name", name)
        .strip_prefix("name:")
        .unwrap_or("")
        .to_string()
}

fn verified_identity_aliases(entity: &MemoryEntity) -> std::collections::BTreeSet<String> {
    entity
        .aliases
        .iter()
        .map(|alias| alias.trim().to_lowercase())
        .filter(|alias| {
            alias.contains('@')
                || alias.starts_with("telegram:")
                || alias.starts_with("whatsapp:")
                || alias.starts_with("email:")
        })
        .collect()
}

pub(crate) fn memory_hygiene_suggestions_for_scope(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) -> Result<Vec<MemoryHygieneSuggestion>, String> {
    let mut people: Vec<MemoryEntity> = facade
        .list_entities_for_ui(user, workspace)
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|entity| entity.entity_type == "person")
        .filter(|entity| entity.metadata.get("merged_into").is_none())
        .collect();
    people.sort_by(|a, b| a.canonical_key.cmp(&b.canonical_key));
    let mut out = Vec::new();
    for i in 0..people.len() {
        for j in (i + 1)..people.len() {
            let left = &people[i];
            let right = &people[j];
            let left_handles = verified_identity_aliases(left);
            let right_handles = verified_identity_aliases(right);
            let shared_handle = left_handles.intersection(&right_handles).next().cloned();
            let same_name = !left.name.trim().is_empty()
                && normalized_entity_name(&left.name) == normalized_entity_name(&right.name);
            let (reason, safe_auto_merge, confidence) = if let Some(handle) = shared_handle {
                (
                    format!("same verified identity alias: {handle}"),
                    true,
                    0.99,
                )
            } else if same_name {
                ("same normalized person name".to_string(), false, 0.72)
            } else {
                continue;
            };
            out.push(MemoryHygieneSuggestion {
                survivor_ref: left.reference.to_string(),
                absorbed_ref: right.reference.to_string(),
                survivor_label: left.name.clone(),
                absorbed_label: right.name.clone(),
                reason,
                safe_auto_merge,
                confidence,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_hygiene_normalizes_entity_names_for_matching() {
        assert_eq!(normalized_entity_name(" Fabio Rossi "), "fabio-rossi");
        assert_eq!(normalized_entity_name(""), "");
    }

    #[test]
    fn gateway_memory_hygiene_accepts_only_verified_identity_aliases() {
        let entity = MemoryEntity {
            reference: MemoryRef::generated(
                MemoryRefKind::Entity,
                MemoryUserId::new("local"),
                MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
            ),
            user_id: MemoryUserId::new("local"),
            workspace_id: MemoryWorkspaceId::new(PERSONAL_WORKSPACE),
            entity_type: "person".to_string(),
            name: "Fabio".to_string(),
            canonical_key: "person:fabio".to_string(),
            aliases: vec![
                "telegram:fabio".to_string(),
                "Fabio Rossi".to_string(),
                "fabio@example.com".to_string(),
            ],
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: MemoryDataSensitivity::Private,
            metadata: serde_json::json!({}),
        };

        let aliases = verified_identity_aliases(&entity);
        assert!(aliases.contains("telegram:fabio"));
        assert!(aliases.contains("fabio@example.com"));
        assert!(!aliases.contains("fabio rossi"));
    }
}
