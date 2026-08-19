//! Memory-backed prompt context helpers for artifact provenance and workflow status.
//!
//! This module owns read-model text assembled from the canonical memory graph.
//! It intentionally does not own recall tool execution, memory learning, or the
//! agent loop.

use crate::gateway_recall_context::format_recall_entry;
use crate::*;

pub(crate) fn artifact_quality_summary(metadata: &serde_json::Value) -> Option<String> {
    let status = metadata
        .get("quality_status")
        .and_then(|value| value.as_str())?;
    let mut parts = vec![format!("quality: {status}")];
    if let Some(slide_count) = metadata
        .get("quality_slide_count")
        .and_then(|value| value.as_u64())
    {
        parts.push(format!("slides: {slide_count}"));
    }
    let issues = metadata
        .get("quality_issues")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|issue| {
                    let code = issue.get("code").and_then(|value| value.as_str())?;
                    let message = issue
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("");
                    if message.is_empty() {
                        Some(code.to_string())
                    } else {
                        Some(format!("{code}: {message}"))
                    }
                })
                .take(3)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !issues.is_empty() {
        parts.push(format!("issues: {}", issues.join("; ")));
    }
    Some(parts.join("; "))
}

pub(crate) fn artifact_provenance_context_for_query(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    query: &str,
) -> Option<String> {
    let query_lc = query.to_ascii_lowercase();
    let provenance_query = [
        "artifact",
        "artef",
        "deliverable",
        "provenance",
        "provenienza",
        "decision",
        "decisione",
        "deriv",
        "why",
        "perché",
        "perche",
        "dove",
        "where",
        "salvat",
        "saved",
        "lavoro",
        "workflow",
    ]
    .iter()
    .any(|needle| query_lc.contains(needle));
    if !provenance_query {
        return None;
    }

    let memories = facade
        .list_memories_for_ui(user, workspace)
        .unwrap_or_default();
    let memory_by_ref: std::collections::HashMap<String, MemoryRecord> = memories
        .iter()
        .cloned()
        .map(|memory| (memory.reference.to_string(), memory))
        .collect();
    let artifact_memories: Vec<&MemoryRecord> = memories
        .iter()
        .filter(|memory| {
            memory.memory_type == "artifact"
                && matches!(
                    memory.status,
                    MemoryStatus::Confirmed | MemoryStatus::Candidate
                )
        })
        .collect();
    if artifact_memories.is_empty() {
        return None;
    }

    let entities = facade
        .list_entities_for_ui(user, workspace)
        .unwrap_or_default();
    let entity_by_ref: std::collections::HashMap<String, MemoryEntity> = entities
        .iter()
        .cloned()
        .map(|entity| (entity.reference.to_string(), entity))
        .collect();
    let relations = facade
        .list_relations_for_ui(user, workspace)
        .unwrap_or_default();
    let artifact_entity_for_memory = |artifact: &MemoryRecord| -> Option<MemoryRef> {
        relations
            .iter()
            .find(|relation| {
                relation.relation_type == "describes"
                    && relation.source_ref == artifact.reference
                    && entity_by_ref
                        .get(&relation.target_ref.to_string())
                        .is_some_and(|entity| entity.entity_type == "artifact")
            })
            .map(|relation| relation.target_ref.clone())
            .or_else(|| {
                let thread_slug = artifact
                    .metadata
                    .get("thread_slug")
                    .and_then(|value| value.as_str())?;
                let name = artifact
                    .metadata
                    .get("name")
                    .and_then(|value| value.as_str())?;
                Some(MemoryRef::new(
                    MemoryRefKind::Entity,
                    user.clone(),
                    workspace.clone(),
                    format!("artifact:{thread_slug}:{name}"),
                ))
            })
    };

    let mut lines = Vec::new();
    for artifact in artifact_memories {
        let labels = artifact_provenance_labels(
            artifact
                .metadata
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(&artifact.text),
            &artifact.metadata,
        );
        let query_hits_artifact = labels.iter().any(|label| {
            query_lc.contains(label)
                || std::path::Path::new(label)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|file_name| query_lc.contains(&file_name.to_ascii_lowercase()))
        });
        if !query_hits_artifact
            && ![
                "artifact",
                "artef",
                "deliverable",
                "provenance",
                "provenienza",
                "workflow",
            ]
            .iter()
            .any(|needle| query_lc.contains(needle))
        {
            continue;
        }

        let Some(artifact_ref) = artifact_entity_for_memory(artifact) else {
            continue;
        };
        let artifact_name = artifact
            .metadata
            .get("title")
            .and_then(|value| value.as_str())
            .or_else(|| {
                artifact
                    .metadata
                    .get("name")
                    .and_then(|value| value.as_str())
            })
            .unwrap_or_else(|| artifact.text.lines().next().unwrap_or("artifact"));
        let mut detail = format!("- {artifact_name}");
        if let Some(kind) = artifact
            .metadata
            .get("artifact_type")
            .and_then(|value| value.as_str())
        {
            detail.push_str(&format!(" ({kind})"));
        }
        let mut path_bits = Vec::new();
        if let Some(path) = artifact
            .metadata
            .get("project_relative_path")
            .and_then(|value| value.as_str())
        {
            path_bits.push(format!("project path: {path}"));
        }
        if let Some(path) = artifact
            .metadata
            .get("path_ref")
            .and_then(|value| value.as_str())
            && !path_bits.iter().any(|bit| bit.contains(path))
        {
            path_bits.push(format!("ref: {path}"));
        }
        if let Some(path) = artifact
            .metadata
            .get("managed_path")
            .and_then(|value| value.as_str())
            && !path_bits.iter().any(|bit| bit.contains(path))
        {
            path_bits.push(format!("local managed path: {path}"));
        }
        if !path_bits.is_empty() {
            detail.push_str(&format!(" [{}]", path_bits.join("; ")));
        }
        if let Some(quality) = artifact_quality_summary(&artifact.metadata) {
            detail.push_str(&format!("; {quality}"));
        }

        let mut producers: Vec<String> = artifact
            .metadata
            .get("producer")
            .and_then(|value| value.as_str())
            .map(|value| vec![value.to_string()])
            .unwrap_or_default();
        let mut source_refs = std::collections::BTreeSet::new();
        for relation in &relations {
            if relation.target_ref == artifact_ref
                && relation.relation_type == "produced"
                && let Some(entity) = entity_by_ref.get(&relation.source_ref.to_string())
            {
                producers.push(entity.name.clone());
            }
            if relation.target_ref == artifact_ref && relation.relation_type == "affects" {
                source_refs.insert(relation.source_ref.to_string());
            }
            if relation.source_ref == artifact_ref && relation.relation_type == "derived_from" {
                source_refs.insert(relation.target_ref.to_string());
            }
        }
        producers.sort();
        producers.dedup();
        if !producers.is_empty() {
            detail.push_str(&format!("; produced by {}", producers.join(", ")));
            for producer in &producers {
                if let Some(workflow) = producer_workflow_contract(producer) {
                    detail.push_str(&format!("; derives from workflow {producer} / {workflow}"));
                    break;
                }
            }
        }

        let mut source_lines = Vec::new();
        for source_ref in source_refs {
            if let Some(memory) = memory_by_ref.get(&source_ref) {
                let label = if memory.memory_type == "decision" {
                    "decision"
                } else {
                    memory.memory_type.as_str()
                };
                source_lines.push(format!(
                    "{label}: {}",
                    format_recall_entry(&memory.text, &memory.metadata)
                ));
            } else if let Some(entity) = entity_by_ref.get(&source_ref) {
                source_lines.push(format!("{}: {}", entity.entity_type, entity.name));
            } else {
                source_lines.push(format!("source ref: {source_ref}"));
            }
        }
        if !source_lines.is_empty() {
            detail.push_str(&format!("; derived from {}", source_lines.join(" | ")));
        }
        lines.push(detail);
    }
    if lines.is_empty() {
        return None;
    }
    lines.sort();
    lines.dedup();
    Some(format!(
        "ARTIFACT PROVENANCE FROM CANONICAL MEMORY GRAPH:\n{}",
        lines.into_iter().take(8).collect::<Vec<_>>().join("\n")
    ))
}

pub(crate) fn producer_workflow_contract(producer: &str) -> Option<&'static str> {
    match producer {
        "make_deck" => Some("DeckWorkflow"),
        "make_document" => Some("DocumentWorkflow"),
        _ => None,
    }
}

pub(crate) fn workflow_status_context_for_query(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    query: &str,
) -> Option<String> {
    let query_lc = query.to_ascii_lowercase();
    let status_query = [
        "workflow",
        "stato",
        "punto",
        "perché",
        "perche",
        "why",
        "next",
        "prossimo",
        "aperto",
        "open loop",
        "blocc",
        "manca",
        "resta",
    ]
    .iter()
    .any(|needle| query_lc.contains(needle));
    if !status_query {
        return None;
    }

    let memories = facade
        .list_memories_for_ui(user, workspace)
        .unwrap_or_default();
    let live = |memory: &&MemoryRecord| {
        matches!(
            memory.status,
            MemoryStatus::Confirmed | MemoryStatus::Candidate
        ) && memory.superseded_by.is_none()
            && !memory.text.trim().is_empty()
    };
    let mut goals: Vec<&MemoryRecord> = memories
        .iter()
        .filter(live)
        .filter(|memory| memory.memory_type == "goal")
        .collect();
    let mut open_loops: Vec<&MemoryRecord> = memories
        .iter()
        .filter(|memory| active_open_loop_record(memory))
        .collect();
    let mut decisions: Vec<&MemoryRecord> = memories
        .iter()
        .filter(live)
        .filter(|memory| memory.memory_type == "decision")
        .collect();
    let mut outcomes: Vec<&MemoryRecord> = memories
        .iter()
        .filter(live)
        .filter(|memory| {
            memory.memory_type == "fact"
                && (memory
                    .metadata
                    .get("certainty")
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| matches!(value, "committed" | "completed" | "verified"))
                    || memory
                        .metadata
                        .get("source")
                        .and_then(|value| value.as_str())
                        == Some("runtime_plan_step"))
        })
        .collect();
    goals.sort_by_key(|memory| std::cmp::Reverse(memory.text.chars().count()));
    open_loops.sort_by_key(|memory| std::cmp::Reverse(memory.text.chars().count()));
    decisions.sort_by_key(|memory| std::cmp::Reverse(memory.text.chars().count()));
    outcomes.sort_by_key(|memory| std::cmp::Reverse(memory.text.chars().count()));

    if goals.is_empty() && open_loops.is_empty() && decisions.is_empty() && outcomes.is_empty() {
        return None;
    }

    let mut sections = Vec::new();
    if !goals.is_empty() {
        let mut lines = vec!["Objectives:".to_string()];
        for goal in goals.into_iter().take(4) {
            lines.push(format!("- {}", goal.text.trim()));
        }
        sections.push(lines.join("\n"));
    }
    if !open_loops.is_empty() {
        let mut lines = vec!["Open loops / next work:".to_string()];
        for open_loop in open_loops.into_iter().take(6) {
            lines.push(format!(
                "- {} (ref: {})",
                open_loop.text.trim(),
                open_loop.reference
            ));
        }
        sections.push(lines.join("\n"));
    }
    if !outcomes.is_empty() {
        let mut lines = vec!["Verified outcomes / current state:".to_string()];
        for outcome in outcomes.into_iter().take(4) {
            lines.push(format!(
                "- {}",
                format_recall_entry(&outcome.text, &outcome.metadata)
            ));
        }
        sections.push(lines.join("\n"));
    }
    if !decisions.is_empty() {
        let mut lines = vec!["Recent decisions / why:".to_string()];
        for decision in decisions.into_iter().take(6) {
            lines.push(format!(
                "- {}",
                format_recall_entry(&decision.text, &decision.metadata)
            ));
        }
        sections.push(lines.join("\n"));
    }
    if let Some(provenance) = artifact_provenance_context_for_query(facade, user, workspace, query)
    {
        sections.push(format!("Evidence artifacts:\n{provenance}"));
    }

    Some(format!(
        "WORKFLOW STATUS FROM CANONICAL MEMORY:\n{}",
        sections.join("\n\n")
    ))
}
