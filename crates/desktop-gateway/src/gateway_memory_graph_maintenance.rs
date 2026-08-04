// Deterministic memory graph maintenance: mention links, orphan sweep, and wiki reconciliation.
use crate::*;

pub(crate) fn normalize_project_scope_entities(
    workspace: &MemoryWorkspaceId,
    entities: Vec<ExtractedEntity>,
) -> Vec<ExtractedEntity> {
    let workspace_root_key = format!("workspace:{}", workspace.as_str());
    entities
        .into_iter()
        .map(|mut entity| {
            if entity.entity_type == "project" && entity.canonical_key != workspace_root_key {
                entity.entity_type = "topic".to_string();
                let slug = sanitize_dedup_key("topic", &entity.name)
                    .strip_prefix("topic:")
                    .unwrap_or(entity.name.as_str())
                    .to_string();
                entity.canonical_key = format!("topic:{slug}");
                let extra = serde_json::json!({
                    "demoted_from_entity_type": "project",
                    "demotion_reason": "workspace root is canonical",
                });
                merge_object_metadata(&mut entity.metadata, Some(&extra));
            }
            entity
        })
        .collect()
}

/// G2 — the missing link of the graph: deterministic memory→entity "mentions"
/// edges within ONE workspace. An entity is linked to a memory when its name (or
/// an alias, ≥3 chars) appears in the memory text, case-insensitively. The LLM
/// never computes these (it already extracted both sides); plain code does.
/// Idempotent: existing (source→target) pairs are skipped.
/// Generic words that denote "the user" abstractly — every personal fact starts with
/// one ("l'utente preferisce…"), so person:self must NOT be linked by these or it
/// would absorb the whole scope. Self is linked only by its SPECIFIC aliases (a name).
fn is_generic_self_word(needle: &str) -> bool {
    matches!(
        needle,
        "utente" | "l'utente" | "l’utente" | "user" | "self" | "tu" | "io" | "me" | "mi"
    )
}

pub(crate) fn link_memory_mentions(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    items: &[(MemoryRef, String)],
) {
    let Ok(entities) = facade.list_entities_for_ui(user_id, workspace) else {
        return;
    };
    link_mentions_core(facade, user_id, workspace, items, &entities, false);
}

/// Core of the mention-linker: connect each memory to the entities it names
/// (name/alias substring, ≥3 chars). When `resurrect` is set, a tombstoned entity
/// matched by a live memory is un-tombstoned — this is how regeneration heals
/// entities a previous orphan-sweep wrongly killed (e.g. "Jannik Sinner").
fn link_mentions_core(
    facade: &MemoryFacade,
    user_id: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    items: &[(MemoryRef, String)],
    entities: &[MemoryEntity],
    resurrect: bool,
) {
    if items.is_empty() || entities.is_empty() {
        return;
    }
    let mut existing: std::collections::HashSet<(String, String)> = facade
        .list_relations_for_ui(user_id, workspace)
        .map(|rels| {
            rels.into_iter()
                .map(|r| (r.source_ref.to_string(), r.target_ref.to_string()))
                .collect()
        })
        .unwrap_or_default();
    for (memory_ref, text) in items {
        let hay = text.to_lowercase();
        for entity in entities {
            // Entities folded into another by an identity merge are permanently dead.
            if entity.metadata.get("merged_into").is_some() {
                continue;
            }
            // person:self IS linkable (so the unified "you" node collects memories that
            // name you, e.g. "Fabio"), but it must NOT match the generic self-words
            // that prefix nearly every personal fact ("l'utente…") — that would link
            // everything to self. So for self we match only its specific aliases.
            let is_self = entity.canonical_key == "person:self";
            let mentioned = std::iter::once(&entity.name)
                .chain(entity.aliases.iter())
                .any(|name| {
                    let needle = name.trim().to_lowercase();
                    if needle.chars().count() < 3 || (is_self && is_generic_self_word(&needle)) {
                        return false;
                    }
                    hay.contains(&needle)
                });
            if !mentioned {
                continue;
            }
            // A live memory names this entity → it is NOT an orphan. If a previous
            // orphan-sweep tombstoned it (because the forward-only linker had missed
            // the edge), resurrect it now.
            if resurrect {
                let _ = facade.untombstone_entity(&entity.reference, user_id, workspace);
            }
            let pair = (memory_ref.to_string(), entity.reference.to_string());
            if !existing.insert(pair) {
                continue;
            }
            let relation = MemoryRelation {
                reference: MemoryRef::generated(
                    MemoryRefKind::Relation,
                    user_id.clone(),
                    workspace.clone(),
                ),
                user_id: user_id.clone(),
                workspace_id: workspace.clone(),
                source_ref: memory_ref.clone(),
                relation_type: "mentions".to_string(),
                target_ref: entity.reference.clone(),
                confidence: 0.7,
                privacy_domain: PrivacyDomain::new("personal"),
                sensitivity: MemoryDataSensitivity::Internal,
                evidence: Vec::new(),
                metadata: serde_json::json!({ "source": "mention-linker" }),
            };
            let _ = facade.upsert_relation(&relation);
        }
    }
}

/// G5 — "re-optimize" after deletions: first re-link live memories to entities
/// (idempotent — also heals links missed when a duplicate memory was deduped
/// away), then tombstone entities left with ZERO edges, so the graph never
/// keeps orphans. Protected from the sweep: the user node (person:self),
/// channel identities, and entities backing a curated contact (entity_ref).
fn sweep_graph_orphans(state: &AppState, workspace: &MemoryWorkspaceId) {
    // Contact-backed entity refs are sacred — the address book links to them.
    // Collected FIRST so the chat-store lock is dropped before facade work.
    let protected: std::collections::HashSet<String> = lock_store(state)
        .ok()
        .and_then(|store| store.list_contacts().ok())
        .map(|contacts| contacts.into_iter().filter_map(|c| c.entity_ref).collect())
        .unwrap_or_default();
    let user = gateway_memory_user_id();
    let facade = memory_facade(state);
    let items: Vec<(MemoryRef, String)> = facade
        .list_memories_for_ui(&user, workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| !matches!(m.status, MemoryStatus::Deleted | MemoryStatus::Rejected))
        .filter(|m| {
            matches!(
                m.memory_type.as_str(),
                "fact" | "preference" | "decision" | "goal"
            )
        })
        .map(|m| (m.reference, m.text))
        .collect();
    // Re-link against ALL entities INCLUDING tombstoned ones, resurrecting any that a
    // live memory still names (heals entities a prior orphan-sweep wrongly killed —
    // they had 0 edges only because the forward-only linker never connected them).
    // EXCLUDE the imported code graph (source="graphify"): those entities are rebuilt
    // wholesale by build_project_graph, not mention-linked from personal facts. Skipping
    // them keeps the sweep cheap on big repos (idra ~48k code entities) — otherwise
    // mention-matching would be O(facts × 48k) and loading them is pure waste here.
    let is_graphify =
        |e: &MemoryEntity| e.metadata.get("source").and_then(|v| v.as_str()) == Some("graphify");
    let all_entities: Vec<MemoryEntity> = facade
        .list_entities_including_tombstoned(&user, workspace)
        .unwrap_or_default()
        .into_iter()
        .map(|(entity, _dead)| entity)
        .filter(|e| !is_graphify(e))
        .collect();
    link_mentions_core(facade, &user, workspace, &items, &all_entities, true);
    let touched: std::collections::HashSet<String> = facade
        .list_relations_for_ui(&user, workspace)
        .unwrap_or_default()
        .into_iter()
        .flat_map(|r| [r.source_ref.to_string(), r.target_ref.to_string()])
        .collect();
    for entity in facade
        .list_entities_for_ui(&user, workspace)
        .unwrap_or_default()
    {
        let id = entity.reference.to_string();
        let is_channel_identity = entity.canonical_key.starts_with("person:whatsapp:")
            || entity.canonical_key.starts_with("person:telegram:");
        if touched.contains(&id)
            || entity.canonical_key == "person:self"
            || is_channel_identity
            || protected.contains(&id)
            || is_graphify(&entity)
        {
            continue;
        }
        let _ = facade.tombstone_entity(
            &entity.reference,
            &user,
            workspace,
            "orphan: no live memory references it",
        );
    }
    // F6: refresh the human-readable profile view from the (now-consistent) graph.
    if workspace.as_str() == PERSONAL_WORKSPACE {
        rebuild_profile_wiki(facade, &user, workspace);
    }
}

/// The graph-completeness INVARIANT: regenerate the auto-derived `mentions` edges
/// for a scope from scratch — wipe the old mention-linker edges (drops stale ones),
/// then re-derive from the live facts and tombstone any entity left orphan. This is
/// the "rebuild, don't patch" principle: run it on startup, after writes, and after
/// delete/forget so the structural layer is always complete and consistent
/// (no forward-only gaps, no orphans, no stale edges). Cheap at personal scale.
pub(crate) fn regenerate_graph_links(state: &AppState, workspace: &MemoryWorkspaceId) {
    {
        let facade = memory_facade(state);
        let _ = facade.clear_mention_links(&gateway_memory_user_id(), workspace);
    }
    // ADR 0027: this sweep is EVENTUALLY-CONSISTENT under lock-free access. clear+re-link
    // are separate store ops (never one atomic guard — they weren't under the old outer
    // Mutex either, which was dropped between the two calls), so a concurrent reader may
    // observe a transient half-swept graph. That is acceptable: it runs on startup and
    // after writes, and settles to a complete/consistent projection within the same tick.
    // sweep_graph_orphans re-links ALL live facts + tombstones zero-edge entities.
    sweep_graph_orphans(state, workspace);
}

pub(crate) fn reconcile_memory_scope(state: &AppState, workspace: &MemoryWorkspaceId) {
    regenerate_graph_links(state, workspace);
    let user = gateway_memory_user_id();
    {
        let facade = memory_facade(state);
        rebuild_decisions_wiki(facade, &user, workspace);
        rebuild_project_brief(facade, &user, workspace);
        rebuild_status_wiki(facade, &user, workspace);
        if workspace.as_str() == PERSONAL_WORKSPACE {
            rebuild_profile_wiki(facade, &user, workspace);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_graph_maintenance_demotes_non_root_project_entities() {
        let workspace = MemoryWorkspaceId::new("workspace_homun");
        let entities = normalize_project_scope_entities(
            &workspace,
            vec![
                ExtractedEntity {
                    entity_type: "project".to_string(),
                    name: "Homun".to_string(),
                    canonical_key: "project:homun".to_string(),
                    aliases: vec!["homun".to_string()],
                    privacy_domain: PrivacyDomain::new("work"),
                    sensitivity: MemoryDataSensitivity::Private,
                    metadata: serde_json::json!({ "scope": "project" }),
                },
                ExtractedEntity {
                    entity_type: "project".to_string(),
                    name: "Workspace Root".to_string(),
                    canonical_key: "workspace:workspace_homun".to_string(),
                    aliases: Vec::new(),
                    privacy_domain: PrivacyDomain::new("work"),
                    sensitivity: MemoryDataSensitivity::Private,
                    metadata: serde_json::json!({ "scope": "project" }),
                },
            ],
        );

        assert_eq!(entities[0].entity_type, "topic");
        assert_eq!(entities[0].canonical_key, "topic:homun");
        assert_eq!(
            entities[0]
                .metadata
                .get("demoted_from_entity_type")
                .and_then(serde_json::Value::as_str),
            Some("project")
        );
        assert_eq!(entities[1].entity_type, "project");
        assert_eq!(entities[1].canonical_key, "workspace:workspace_homun");
    }

    #[test]
    fn gateway_memory_graph_maintenance_keeps_generic_self_words_unlinkable() {
        assert!(is_generic_self_word("utente"));
        assert!(is_generic_self_word("l'utente"));
        assert!(!is_generic_self_word("fabio"));
    }
}
