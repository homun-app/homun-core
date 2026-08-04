// Persistence of extracted memory graph entities and relations.
use crate::gateway_memory_graph_maintenance::normalize_project_scope_entities;
use crate::*;

pub(crate) fn persist_graph(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    entities: Vec<ExtractedEntity>,
    relations: Vec<ExtractedRelation>,
    project_ws: Option<&MemoryWorkspaceId>,
) {
    let (mut project_entities, personal_entities): (Vec<_>, Vec<_>) =
        entities.into_iter().partition(|entity| {
            project_ws.is_some()
                && entity
                    .metadata
                    .get("scope")
                    .and_then(serde_json::Value::as_str)
                    == Some("project")
        });
    let (project_relations, personal_relations): (Vec<_>, Vec<_>) =
        relations.into_iter().partition(|relation| {
            project_ws.is_some()
                && relation
                    .metadata
                    .get("scope")
                    .and_then(serde_json::Value::as_str)
                    == Some("project")
        });
    if let Some(project) = project_ws {
        project_entities = normalize_project_scope_entities(project, project_entities);
        persist_graph_scope(
            facade,
            user_id,
            project,
            project_entities,
            project_relations,
        );
    }
    persist_graph_scope(
        facade,
        user_id,
        workspace,
        personal_entities,
        personal_relations,
    );
}

fn persist_graph_scope(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    entities: Vec<ExtractedEntity>,
    relations: Vec<ExtractedRelation>,
) {
    if entities.is_empty() && relations.is_empty() {
        return;
    }
    let mut key_to_ref: std::collections::HashMap<String, MemoryRef> =
        std::collections::HashMap::new();
    let mut existing_relations = facade
        .list_relations_for_ui(user_id, workspace)
        .unwrap_or_default();
    if let Ok(existing) = facade.list_entities_for_ui(user_id, workspace) {
        for entity in existing {
            key_to_ref.insert(entity.canonical_key.clone(), entity.reference);
        }
    }
    // `person:self` exists only when an admitted relation actually needs it. This
    // avoids an orphan user node on unrelated technical analyses.
    let needs_self = relations.iter().any(|relation| {
        relation.source_ref == "person:self" || relation.target_ref == "person:self"
    });
    if needs_self && !key_to_ref.contains_key("person:self") {
        let reference =
            MemoryRef::generated(MemoryRefKind::Entity, user_id.clone(), workspace.clone());
        let entity = MemoryEntity {
            reference: reference.clone(),
            user_id: user_id.clone(),
            workspace_id: workspace.clone(),
            entity_type: "person".to_string(),
            name: "Tu".to_string(),
            canonical_key: "person:self".to_string(),
            aliases: Vec::new(),
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: MemoryDataSensitivity::Internal,
            metadata: serde_json::json!({ "self": true }),
        };
        if facade.upsert_entity(&entity).is_ok() {
            key_to_ref.insert("person:self".to_string(), reference);
        }
    }
    for extracted in entities {
        if extracted.canonical_key.trim().is_empty() {
            continue;
        }
        let reference = key_to_ref
            .get(&extracted.canonical_key)
            .cloned()
            .unwrap_or_else(|| {
                MemoryRef::generated(MemoryRefKind::Entity, user_id.clone(), workspace.clone())
            });
        let entity = MemoryEntity {
            reference: reference.clone(),
            user_id: user_id.clone(),
            workspace_id: workspace.clone(),
            entity_type: extracted.entity_type,
            name: extracted.name,
            canonical_key: extracted.canonical_key.clone(),
            aliases: extracted.aliases,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: extracted.sensitivity,
            metadata: extracted.metadata,
        };
        if facade.upsert_entity(&entity).is_ok() {
            key_to_ref.insert(extracted.canonical_key, reference);
        }
    }
    for extracted in relations {
        let (Some(source), Some(target)) = (
            key_to_ref.get(&extracted.source_ref),
            key_to_ref.get(&extracted.target_ref),
        ) else {
            continue;
        };
        let evidence = extracted
            .evidence_refs
            .iter()
            .filter_map(|reference| reference.parse::<MemoryRef>().ok())
            .filter(|reference| {
                reference.user_id == *user_id && reference.workspace_id == *workspace
            })
            .collect();
        let reference = existing_relations
            .iter()
            .find(|relation| {
                relation.source_ref == *source
                    && relation.target_ref == *target
                    && relation.relation_type == extracted.relation_type
            })
            .map(|relation| relation.reference.clone())
            .unwrap_or_else(|| {
                MemoryRef::generated(MemoryRefKind::Relation, user_id.clone(), workspace.clone())
            });
        let relation = MemoryRelation {
            reference,
            user_id: user_id.clone(),
            workspace_id: workspace.clone(),
            source_ref: source.clone(),
            relation_type: extracted.relation_type,
            target_ref: target.clone(),
            confidence: extracted.confidence,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: extracted.sensitivity,
            evidence,
            metadata: extracted.metadata,
        };
        if facade.upsert_relation(&relation).is_ok()
            && !existing_relations
                .iter()
                .any(|existing| existing.reference == relation.reference)
        {
            existing_relations.push(relation);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_graph_persistence_bootstraps_self_only_when_relation_needs_it() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = MemoryUserId::new("local");
        let workspace = MemoryWorkspaceId::new("project-a");

        persist_graph_scope(
            &facade,
            &user,
            &workspace,
            vec![ExtractedEntity {
                entity_type: "topic".to_string(),
                name: "Runtime".to_string(),
                canonical_key: "topic:runtime".to_string(),
                aliases: Vec::new(),
                privacy_domain: PrivacyDomain::new("work"),
                sensitivity: MemoryDataSensitivity::Private,
                metadata: serde_json::json!({}),
            }],
            vec![ExtractedRelation {
                source_ref: "person:self".to_string(),
                relation_type: "uses".to_string(),
                target_ref: "topic:runtime".to_string(),
                confidence: 0.8,
                privacy_domain: PrivacyDomain::new("work"),
                sensitivity: MemoryDataSensitivity::Private,
                evidence_refs: Vec::new(),
                metadata: serde_json::json!({}),
            }],
        );

        let entities = facade.list_entities_for_ui(&user, &workspace).unwrap();
        assert!(
            entities
                .iter()
                .any(|entity| entity.canonical_key == "person:self")
        );
        assert!(
            entities
                .iter()
                .any(|entity| entity.canonical_key == "topic:runtime")
        );
        let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();
        assert_eq!(relations.len(), 1);
        assert_eq!(relations[0].relation_type, "uses");
    }
}
