// Contact relationship routes and their canonical memory-graph mirror.
use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::*;

#[derive(Serialize)]
pub(crate) struct RelationshipView {
    id: i64,
    other_reference: String,
    other_name: String,
    relationship_type: String,
    outgoing: bool,
}

pub(crate) async fn contact_relationships(
    State(state): State<AppState>,
    Json(request): Json<ContactRefRequest>,
) -> Result<Json<Vec<RelationshipView>>, GatewayError> {
    let id = parse_contact_ref(&request.reference).ok_or_else(|| GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    })?;
    let store = lock_store(&state)?;
    let relations = store.relationships_for(id).map_err(|error| GatewayError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        code: "contact_relationships",
        message: error.to_string(),
    })?;
    Ok(Json(
        relations
            .into_iter()
            .map(|r| RelationshipView {
                id: r.id,
                other_reference: format!("contact_{}", r.other_contact_id),
                other_name: r.other_name,
                relationship_type: r.relationship_type,
                outgoing: r.outgoing,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub(crate) struct RelationshipAddRequest {
    reference: String,
    other_reference: String,
    relationship_type: String,
}

pub(crate) async fn contact_relationship_add(
    State(state): State<AppState>,
    Json(request): Json<RelationshipAddRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let not_found = || GatewayError {
        status: StatusCode::NOT_FOUND,
        code: "contact_not_found",
        message: "contact not found".to_string(),
    };
    let from = parse_contact_ref(&request.reference).ok_or_else(not_found)?;
    let to = parse_contact_ref(&request.other_reference).ok_or_else(not_found)?;
    let kind = request.relationship_type.trim();
    if from == to || kind.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "relationship_invalid",
            message: "invalid relationship".to_string(),
        });
    }
    let store = lock_store(&state)?;
    store
        .add_relationship(from, to, kind)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "relationship_add",
            message: error.to_string(),
        })?;
    let from_contact = store.contact_by_id(from).ok().flatten();
    let to_contact = store.contact_by_id(to).ok().flatten();
    drop(store);
    if let (Some(from_contact), Some(to_contact)) = (from_contact, to_contact) {
        {
            let facade = memory_facade(&state);
            let _ = mirror_contact_relationship_to_memory_graph(
                facade,
                &from_contact,
                &to_contact,
                kind,
            );
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub(crate) struct RelationshipRemoveRequest {
    id: i64,
}

pub(crate) async fn contact_relationship_remove(
    State(state): State<AppState>,
    Json(request): Json<RelationshipRemoveRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let store = lock_store(&state)?;
    let existing = store
        .relationship_by_id(request.id)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "relationship_lookup",
            message: error.to_string(),
        })?;
    store
        .remove_relationship(request.id)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "relationship_remove",
            message: error.to_string(),
        })?;
    drop(store);
    if let Some(existing) = existing {
        {
            let facade = memory_facade(&state);
            let _ = tombstone_contact_relationship_memory_graph_edge(
                facade,
                existing.from_contact_id,
                existing.to_contact_id,
                &existing.relationship_type,
            );
        }
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn mirror_contact_relationship_to_memory_graph(
    facade: &MemoryFacade,
    from_contact: &chat_store::StoredContact,
    to_contact: &chat_store::StoredContact,
    relationship_type: &str,
) -> Result<(), String> {
    let Some(source_ref) = from_contact
        .entity_ref
        .as_ref()
        .and_then(|reference| reference.parse::<MemoryRef>().ok())
    else {
        return Ok(());
    };
    let Some(target_ref) = to_contact
        .entity_ref
        .as_ref()
        .and_then(|reference| reference.parse::<MemoryRef>().ok())
    else {
        return Ok(());
    };
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
    let relation_type = canonical_contact_relationship_type(relationship_type);
    let relation_ref = contact_relationship_memory_ref(
        from_contact.id,
        to_contact.id,
        relationship_type,
        &user,
        &workspace,
    );
    facade
        .upsert_relation(&MemoryRelation {
            reference: relation_ref,
            user_id: user,
            workspace_id: workspace,
            source_ref,
            relation_type,
            target_ref,
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new("personal"),
            sensitivity: MemoryDataSensitivity::Private,
            evidence: vec![],
            metadata: serde_json::json!({
                "source": "contact_relationships",
                "read_model": "contact_relationships",
                "from_contact_id": from_contact.id,
                "to_contact_id": to_contact.id,
                "relationship_type": relationship_type,
                "from_contact_name": from_contact.name,
                "to_contact_name": to_contact.name,
            }),
        })
        .map_err(|error| error.to_string())
}

fn tombstone_contact_relationship_memory_graph_edge(
    facade: &MemoryFacade,
    from_contact_id: i64,
    to_contact_id: i64,
    relationship_type: &str,
) -> Result<(), String> {
    let user = gateway_memory_user_id();
    let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
    let relation_ref = contact_relationship_memory_ref(
        from_contact_id,
        to_contact_id,
        relationship_type,
        &user,
        &workspace,
    );
    facade
        .tombstone_ref(
            &relation_ref,
            &user,
            &workspace,
            "contact relationship removed",
        )
        .map_err(|error| error.to_string())
}

fn contact_relationship_memory_ref(
    from_contact_id: i64,
    to_contact_id: i64,
    relationship_type: &str,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
) -> MemoryRef {
    MemoryRef::new(
        MemoryRefKind::Relation,
        user.clone(),
        workspace.clone(),
        format!(
            "contact_relationship:{}:{}:{}",
            from_contact_id,
            to_contact_id,
            slugify_contact_relationship_type(relationship_type)
        ),
    )
}

fn canonical_contact_relationship_type(value: &str) -> String {
    let slug = slugify_contact_relationship_type(value);
    match slug.as_str() {
        "partner" | "spouse" | "wife" | "husband" | "moglie" | "marito" | "partner_of" => {
            "partner_of".to_string()
        }
        "child" | "figlio" | "figlia" | "child_of" => "child_of".to_string(),
        "parent" | "padre" | "madre" | "genitore" | "parent_of" => "parent_of".to_string(),
        "sibling" | "fratello" | "sorella" | "sibling_of" => "sibling_of".to_string(),
        "works_as" | "colleague" | "collega" => "works_as".to_string(),
        "" => "relates_to".to_string(),
        _ => slug,
    }
}

fn slugify_contact_relationship_type(value: &str) -> String {
    let mut out = String::new();
    let mut last_was_sep = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_was_sep = false;
        } else if matches!(ch, '_' | '-' | ' ' | '/' | '.') && !last_was_sep && !out.is_empty() {
            out.push('_');
            last_was_sep = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contact_relationships_are_mirrored_into_canonical_memory_graph() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = gateway_memory_user_id();
        let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
        let from = test_contact(1, "Fabio", "entity:local:personal:person:fabio");
        let to = test_contact(2, "Laura", "entity:local:personal:person:laura");

        mirror_contact_relationship_to_memory_graph(&facade, &from, &to, "partner_of").unwrap();

        let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();
        let relation = relations
            .iter()
            .find(|relation| {
                relation.source_ref.to_string() == "entity:local:personal:person:fabio"
                    && relation.target_ref.to_string() == "entity:local:personal:person:laura"
            })
            .expect("contact relationship mirrored into canonical graph");
        assert_eq!(relation.relation_type, "partner_of");
        assert_eq!(
            relation
                .metadata
                .get("source")
                .and_then(|value| value.as_str()),
            Some("contact_relationships")
        );
        assert_eq!(
            relation
                .metadata
                .get("relationship_type")
                .and_then(|value| value.as_str()),
            Some("partner_of")
        );
    }

    #[test]
    fn removed_contact_relationship_tombstones_canonical_graph_edge() {
        let facade = MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap());
        let user = gateway_memory_user_id();
        let workspace = MemoryWorkspaceId::new(PERSONAL_WORKSPACE);
        let from = test_contact(1, "Fabio", "entity:local:personal:person:fabio");
        let to = test_contact(2, "Laura", "entity:local:personal:person:laura");

        mirror_contact_relationship_to_memory_graph(&facade, &from, &to, "partner_of").unwrap();
        tombstone_contact_relationship_memory_graph_edge(&facade, 1, 2, "partner_of").unwrap();

        let relations = facade.list_relations_for_ui(&user, &workspace).unwrap();
        assert!(
            relations.iter().all(|relation| {
                relation.source_ref.to_string() != "entity:local:personal:person:fabio"
                    || relation.target_ref.to_string() != "entity:local:personal:person:laura"
            }),
            "tombstoned contact relationship should disappear from canonical graph UI"
        );
    }

    fn test_contact(id: i64, name: &str, entity_ref: &str) -> chat_store::StoredContact {
        chat_store::StoredContact {
            id,
            name: name.to_string(),
            nickname: None,
            notes: String::new(),
            contact_type: "personal".to_string(),
            is_self: false,
            preferred_channel: None,
            avatar: None,
            entity_ref: Some(entity_ref.to_string()),
            response_mode: String::new(),
            tone_of_voice: String::new(),
            persona_instructions: String::new(),
            profile_id: None,
            birthday: None,
            identities: Vec::new(),
        }
    }
}
