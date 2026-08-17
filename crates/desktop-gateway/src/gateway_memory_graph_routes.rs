//! Memory graph HTTP projection routes.
//!
//! Owns `/api/memory/graph`, graph entity merge, and Graphify import adapter
//! DTOs/projection helpers. Graph maintenance, persistence, wiki rebuilds, and
//! low-level relation upserts stay in their dedicated owners.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};

use crate::*;

#[derive(Deserialize)]
pub(crate) struct MemoryGraphQuery {
    pub(crate) workspace: Option<String>,
    pub(crate) thread: Option<String>,
}

#[derive(Serialize)]
struct GraphNode {
    id: String,
    kind: String, // project | decision | file | alternative | fact | preference | entity
    label: String,
    detail: String,
    entity_type: String,
}

#[derive(Serialize)]
struct GraphEdge {
    source: String,
    target: String,
    label: String,
}

#[derive(Serialize)]
pub(crate) struct MemoryGraphResponse {
    workspace: String,
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    /// True when a large code graph was reduced to its most-connected "backbone" for
    /// rendering (the full graph stays queryable via query_code_graph). UI shows a banner.
    #[serde(default)]
    truncated: bool,
    /// Total nodes before any truncation (so the UI can say "N di M").
    #[serde(default)]
    total_nodes: usize,
}

pub(crate) fn resolve_memory_query_scope(
    state: &AppState,
    query: &MemoryGraphQuery,
) -> MemoryWorkspaceId {
    if let Some(tid) = query.thread.as_deref().filter(|t| !t.trim().is_empty()) {
        lock_store(state)
            .ok()
            .and_then(|store| store.workspace_for_thread(tid).ok())
            .filter(|w| !w.trim().is_empty())
            .map(MemoryWorkspaceId::new)
            .unwrap_or_else(gateway_memory_workspace_id)
    } else if let Some(workspace) = query.workspace.as_deref().filter(|w| !w.trim().is_empty()) {
        MemoryWorkspaceId::new(workspace)
    } else {
        gateway_memory_workspace_id()
    }
}

#[derive(Deserialize)]
pub(crate) struct MemoryGraphMergeRequest {
    survivor_ref: String,
    absorbed_ref: String,
    #[serde(default)]
    reason: Option<String>,
}

fn graph_push_node(
    nodes: &mut Vec<GraphNode>,
    seen: &mut std::collections::HashSet<String>,
    id: &str,
    kind: &str,
    label: String,
    detail: String,
    entity_type: &str,
) {
    if seen.insert(id.to_string()) {
        nodes.push(GraphNode {
            id: id.to_string(),
            kind: kind.to_string(),
            label,
            detail,
            entity_type: entity_type.to_string(),
        });
    }
}

fn graph_entity_alias_detail(entity_name: &str, aliases: &[String]) -> String {
    let self_key = normalized_entity_name(entity_name);
    let mut seen = std::collections::HashSet::<String>::new();
    let mut out = Vec::<String>::new();
    for alias in aliases {
        let trimmed = alias.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = normalized_entity_name(trimmed);
        if key.is_empty() || key == self_key {
            continue;
        }
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }
    out.join(", ")
}

fn project_graph_entity_duplicates_root(
    entity: &MemoryEntity,
    project_id: &str,
    project_label: &str,
) -> bool {
    if entity.reference.to_string() == project_id || entity.entity_type != "project" {
        return false;
    }
    let root_key = normalized_entity_name(project_label);
    if root_key.is_empty() {
        return false;
    }
    normalized_entity_name(&entity.name) == root_key
        || entity
            .aliases
            .iter()
            .any(|alias| normalized_entity_name(alias) == root_key)
}

fn dedupe_graph_edges(edges: &mut Vec<GraphEdge>) {
    let mut seen = std::collections::HashSet::<(String, String, String)>::new();
    edges
        .retain(|edge| seen.insert((edge.source.clone(), edge.target.clone(), edge.label.clone())));
}

fn ensure_project_graph_connectivity(
    project_id: &str,
    nodes: &[GraphNode],
    edges: &mut Vec<GraphEdge>,
) {
    if project_id.is_empty() {
        return;
    }
    let node_ids: std::collections::HashSet<String> =
        nodes.iter().map(|node| node.id.clone()).collect();
    if !node_ids.contains(project_id) {
        return;
    }
    let mut adjacency: std::collections::HashMap<String, Vec<String>> =
        node_ids.iter().map(|id| (id.clone(), Vec::new())).collect();
    for edge in edges.iter() {
        if node_ids.contains(&edge.source) && node_ids.contains(&edge.target) {
            adjacency
                .entry(edge.source.clone())
                .or_default()
                .push(edge.target.clone());
            adjacency
                .entry(edge.target.clone())
                .or_default()
                .push(edge.source.clone());
        }
    }
    let mut visited = std::collections::HashSet::<String>::new();
    let existing: std::collections::HashSet<(String, String)> = edges
        .iter()
        .map(|edge| (edge.source.clone(), edge.target.clone()))
        .collect();
    for node in nodes {
        if visited.contains(&node.id) {
            continue;
        }
        let mut stack = vec![node.id.clone()];
        let mut component = Vec::<String>::new();
        let mut contains_root = false;
        while let Some(id) = stack.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            if id == project_id {
                contains_root = true;
            }
            component.push(id.clone());
            if let Some(neighbors) = adjacency.get(&id) {
                for neighbor in neighbors {
                    if !visited.contains(neighbor) {
                        stack.push(neighbor.clone());
                    }
                }
            }
        }
        if contains_root {
            continue;
        }
        let Some(target) = component
            .iter()
            .find(|id| id.as_str() != project_id)
            .cloned()
        else {
            continue;
        };
        if existing.contains(&(project_id.to_string(), target.clone())) {
            continue;
        }
        edges.push(GraphEdge {
            source: project_id.to_string(),
            target,
            label: "nel progetto".to_string(),
        });
    }
}

/// Spike (Graphify per progetti): import a code knowledge graph produced by the
/// Graphify CLI (`graph.json`: nodes id/label/source_file, links source/target/
/// relation) into a project workspace as entities + entity↔entity relations. The
/// memory_graph projection then renders it with the force-directed viz, for free.
/// Adopt-the-extractor, own-the-graph: Graphify does the multi-language AST work;
/// the graph, query and UI stay in our SQLite.
#[derive(Deserialize)]
pub(crate) struct GraphifyImportRequest {
    workspace_id: String,
    /// Directory containing graphify-out/graph.json (the project root or the out dir).
    dir: String,
}

pub(crate) async fn memory_graphify_import(
    State(state): State<AppState>,
    Json(req): Json<GraphifyImportRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let mut path = std::path::PathBuf::from(&req.dir);
    if path.join("graphify-out/graph.json").exists() {
        path = path.join("graphify-out/graph.json");
    } else if path.join("graph.json").exists() {
        path = path.join("graph.json");
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "graphify_no_file",
        message: format!("graph.json not found in {}: {e}", req.dir),
    })?;
    let graph: serde_json::Value = serde_json::from_str(&raw).map_err(|e| GatewayError {
        status: StatusCode::BAD_REQUEST,
        code: "graphify_bad_json",
        message: e.to_string(),
    })?;
    let user = gateway_memory_user_id();
    let ws = MemoryWorkspaceId::new(&req.workspace_id);
    let report = memory_facade(&state)
        .import_graphify_value(&user, &ws, &graph)
        .map_err(|error| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "graphify_import_failed",
            message: error.to_string(),
        })?;
    Ok(Json(serde_json::json!({
        "entities": report.unique_nodes,
        "relations": report.unique_edges,
        "report": report,
    })))
}

pub(crate) async fn memory_graph(
    State(state): State<AppState>,
    Query(query): Query<MemoryGraphQuery>,
) -> Result<Json<MemoryGraphResponse>, GatewayError> {
    let facade = memory_facade(&state);
    let user = gateway_memory_user_id();
    // Prefer the thread's project (so the Memoria tab shows the CONVERSATION's graph),
    // then an explicit workspace, then the active workspace.
    let ws = resolve_memory_query_scope(&state, &query);

    // Embed this scope's memories in the background (no-op once all have vectors), so
    // the semantic dedup/recall keeps improving. Non-blocking: this response uses the
    // vectors already stored.
    {
        let (st, scope_user, scope_ws) = (state.clone(), user.clone(), ws.clone());
        tokio::spawn(async move {
            backfill_embeddings(&st, &scope_user, &scope_ws, 80).await;
        });
    }

    let workspace_record = if ws.as_str() == PERSONAL_WORKSPACE || ws.as_str() == THREADS_WORKSPACE
    {
        None
    } else {
        load_workspaces_file()
            .workspaces
            .into_iter()
            .find(|workspace| workspace.id == ws.as_str())
    };
    if let Some(workspace) = workspace_record.as_ref()
        && let Err(error) = upsert_workspace_root_memory_entity(facade, workspace)
    {
        eprintln!("memory graph workspace root sync failed: {error}");
    }

    // Root label per scope: the personal graph is "Personal", not "Project".
    let project_label = match ws.as_str() {
        PERSONAL_WORKSPACE => "Personal".to_string(),
        THREADS_WORKSPACE => "Conversations".to_string(),
        _ => workspace_record
            .as_ref()
            .map(|workspace| workspace.name.clone())
            .unwrap_or_else(|| "Project".to_string()),
    };

    let mut nodes: Vec<GraphNode> = Vec::new();
    let mut edges: Vec<GraphEdge> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    let entities_for_scope = facade.list_entities_for_ui(&user, &ws).unwrap_or_default();
    let canonical_project_root =
        if ws.as_str() == PERSONAL_WORKSPACE || ws.as_str() == THREADS_WORKSPACE {
            None
        } else {
            let root_key = format!("workspace:{}", ws.as_str());
            entities_for_scope
                .iter()
                .find(|entity| entity.canonical_key == root_key)
                .map(|entity| entity.reference.to_string())
        };
    let project_id = canonical_project_root
        .clone()
        .unwrap_or_else(|| "project::root".to_string());
    graph_push_node(
        &mut nodes,
        &mut seen,
        &project_id,
        "project",
        project_label.clone(),
        String::new(),
        if canonical_project_root.is_some() {
            "project"
        } else {
            ""
        },
    );

    let live: Vec<_> = facade
        .list_memories_for_ui(&user, &ws)
        .unwrap_or_default()
        .into_iter()
        .filter(|m| !matches!(m.status, MemoryStatus::Deleted | MemoryStatus::Rejected))
        .collect();
    // Embeddings for this scope (if any) → semantic collapse of paraphrases the lexical
    // overlap misses ("JSON come formato" vs "JSON invece di SQLite", cross-language).
    let embeddings: std::collections::HashMap<String, Vec<f32>> = facade
        .list_embeddings(&user, &ws)
        .map(|v| v.into_iter().map(|(r, vec)| (r.to_string(), vec)).collect())
        .unwrap_or_default();
    // Read-time dedup: collapse near-duplicate decisions/facts/preferences (the
    // extractor re-phrases the same thing across turns) so the graph stays clean even
    // for memories stored before write-time dedup existed. Keep the richest (longest).
    let drop_refs: std::collections::HashSet<String> = {
        let dedupe_kinds = ["decision", "fact", "preference"];
        let mut order: Vec<usize> = (0..live.len()).collect();
        order.sort_by_key(|&i| std::cmp::Reverse(live[i].text.chars().count()));
        let mut kept: Vec<(String, std::collections::HashSet<String>, Option<Vec<f32>>)> =
            Vec::new();
        let mut drops: std::collections::HashSet<String> = std::collections::HashSet::new();
        for &i in &order {
            let memory = &live[i];
            if !dedupe_kinds.contains(&memory.memory_type.as_str()) {
                continue;
            }
            let tokens = dedup_tokens(&memory.text);
            let vector = embeddings.get(&memory.reference.to_string()).cloned();
            let duplicate = kept.iter().any(|(ty, ex_tokens, ex_vec)| {
                ty == &memory.memory_type
                    && (jaccard(&tokens, ex_tokens) >= DEDUP_JACCARD
                        || match (vector.as_ref(), ex_vec.as_ref()) {
                            (Some(a), Some(b)) => cosine(a, b) >= DEDUP_COSINE,
                            _ => false,
                        })
            });
            if duplicate {
                drops.insert(memory.reference.to_string());
            } else {
                kept.push((memory.memory_type.clone(), tokens, vector));
            }
        }
        drops
    };
    {
        for memory in &live {
            if drop_refs.contains(&memory.reference.to_string()) {
                continue;
            }
            let kind = memory.memory_type.as_str();
            if kind == "decision" {
                let node_id = memory.reference.to_string();
                let label: String = memory.text.chars().take(70).collect();
                let mut detail = memory.text.clone();
                // Rationale + rejected alternatives → detail, and a node per alternative.
                if let Some(decision) = memory.metadata.get("decision") {
                    if let Some(rationale) = decision.get("rationale").and_then(|r| r.as_str())
                        && !rationale.is_empty()
                        && !detail.contains(rationale)
                    {
                        detail.push_str(&format!("\n\nWhy: {rationale}"));
                    }
                    if let Some(alts) = decision.get("alternatives").and_then(|a| a.as_array()) {
                        for alt in alts {
                            let Some(option) = alt.get("option").and_then(|o| o.as_str()) else {
                                continue;
                            };
                            if option.is_empty() {
                                continue;
                            }
                            let why = alt
                                .get("rejected_because")
                                .and_then(|w| w.as_str())
                                .unwrap_or("");
                            let alt_id = format!("alt::{node_id}::{option}");
                            graph_push_node(
                                &mut nodes,
                                &mut seen,
                                &alt_id,
                                "alternative",
                                option.to_string(),
                                why.to_string(),
                                "",
                            );
                            edges.push(GraphEdge {
                                source: node_id.clone(),
                                target: alt_id,
                                label: "scartata".to_string(),
                            });
                        }
                    }
                }
                graph_push_node(
                    &mut nodes, &mut seen, &node_id, "decision", label, detail, "",
                );
                edges.push(GraphEdge {
                    source: project_id.clone(),
                    target: node_id.clone(),
                    label: "decision".to_string(),
                });
                // Files / artifacts the decision affects.
                if let Some(affected) = memory
                    .metadata
                    .get("affects_labels")
                    .and_then(|a| a.as_array())
                {
                    for item in affected {
                        let Some(name) = item.as_str() else { continue };
                        if name.is_empty() {
                            continue;
                        }
                        let file_id = format!("file::{name}");
                        let kind = if name.contains('.') { "file" } else { "entity" };
                        graph_push_node(
                            &mut nodes,
                            &mut seen,
                            &file_id,
                            kind,
                            name.to_string(),
                            String::new(),
                            "file",
                        );
                        edges.push(GraphEdge {
                            source: node_id.clone(),
                            target: file_id,
                            label: "touches".to_string(),
                        });
                    }
                }
            } else if kind == "fact" || kind == "preference" {
                let node_id = memory.reference.to_string();
                let label: String = memory.text.chars().take(70).collect();
                graph_push_node(
                    &mut nodes,
                    &mut seen,
                    &node_id,
                    kind,
                    label,
                    memory.text.clone(),
                    "",
                );
                edges.push(GraphEdge {
                    source: project_id.clone(),
                    target: node_id,
                    label: kind.to_string(),
                });
            }
        }
    }

    // Explicit entity↔entity relations recorded for this workspace.
    {
        let mut ref_label: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for entity in &entities_for_scope {
            if ws.as_str() != PERSONAL_WORKSPACE
                && ws.as_str() != THREADS_WORKSPACE
                && project_graph_entity_duplicates_root(entity, &project_id, &project_label)
            {
                continue;
            }
            let id = entity.reference.to_string();
            ref_label.insert(id.clone(), entity.name.clone());
            graph_push_node(
                &mut nodes,
                &mut seen,
                &id,
                "entity",
                entity.name.clone(),
                graph_entity_alias_detail(&entity.name, &entity.aliases),
                &entity.entity_type,
            );
        }
        if let Ok(relations) = facade.list_relations_for_ui(&user, &ws) {
            for relation in relations {
                let source = relation.source_ref.to_string();
                let target = relation.target_ref.to_string();
                if seen.contains(&source) && seen.contains(&target) && source != target {
                    // "mentions" edges (G2, memory→entity) read better in Italian.
                    let label = if relation.relation_type == "mentions" {
                        "riguarda".to_string()
                    } else {
                        relation.relation_type
                    };
                    edges.push(GraphEdge {
                        source,
                        target,
                        label,
                    });
                }
            }
        }
    }

    // Wiki pages join the graph through their linked_refs — but NOT the auto-generated
    // VIEW pages (profilo.md, decisioni.md). Those are projections OF the memory we
    // build FROM the graph; re-projecting them back in is circular and, since the
    // profile links every fact, creates a hub that visually duplicates the scope root.
    // They live in the wiki tab. Only hand-authored/specific pages appear as nodes.
    let is_generated_view = |path: &str| matches!(path, "profilo.md" | "decisioni.md");
    if let Ok(pages) = facade.list_wiki_pages_for_ui(&user, &ws) {
        for page in pages {
            if is_generated_view(&page.path) {
                continue;
            }
            let page_id = format!("wiki::{}", page.path);
            let mut linked_any = false;
            for linked in &page.linked_refs {
                let target = linked.to_string();
                if seen.contains(&target) {
                    if !linked_any {
                        graph_push_node(
                            &mut nodes,
                            &mut seen,
                            &page_id,
                            "wiki",
                            page.title.clone(),
                            format!("Pagina wiki · {}", page.path),
                            "",
                        );
                        edges.push(GraphEdge {
                            source: project_id.clone(),
                            target: page_id.clone(),
                            label: "wiki".to_string(),
                        });
                        linked_any = true;
                    }
                    edges.push(GraphEdge {
                        source: page_id.clone(),
                        target,
                        label: "cita".to_string(),
                    });
                }
            }
        }
    }

    if ws.as_str() != PERSONAL_WORKSPACE && ws.as_str() != THREADS_WORKSPACE {
        ensure_project_graph_connectivity(&project_id, &nodes, &mut edges);
    }
    dedupe_graph_edges(&mut edges);

    // Large code graphs (idra ~53k nodes) would freeze the force-graph. Render only the
    // most-connected "backbone": keep all non-entity nodes (project/facts/decisions —
    // always few) + the top entity nodes by degree, then drop edges to pruned nodes. The
    // FULL graph stays queryable via query_code_graph; this only bounds what's DRAWN.
    const GRAPH_RENDER_CAP: usize = 2000;
    let total_nodes = nodes.len();
    let truncated = total_nodes > GRAPH_RENDER_CAP;
    if truncated {
        let mut degree: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for edge in &edges {
            *degree.entry(edge.source.clone()).or_default() += 1;
            *degree.entry(edge.target.clone()).or_default() += 1;
        }
        // Entity nodes ranked by degree; everything else (the few non-entity nodes) kept.
        let mut entity_nodes: Vec<&GraphNode> =
            nodes.iter().filter(|n| n.kind == "entity").collect();
        entity_nodes.sort_by(|a, b| {
            degree
                .get(&b.id)
                .unwrap_or(&0)
                .cmp(degree.get(&a.id).unwrap_or(&0))
        });
        let non_entity = total_nodes - entity_nodes.len();
        let entity_budget = GRAPH_RENDER_CAP.saturating_sub(non_entity);
        let mut keep: std::collections::HashSet<String> = nodes
            .iter()
            .filter(|n| n.kind != "entity")
            .map(|n| n.id.clone())
            .collect();
        for node in entity_nodes.into_iter().take(entity_budget) {
            keep.insert(node.id.clone());
        }
        nodes.retain(|n| keep.contains(&n.id));
        edges.retain(|e| keep.contains(&e.source) && keep.contains(&e.target));
    }

    Ok(Json(MemoryGraphResponse {
        workspace: ws.as_str().to_string(),
        nodes,
        edges,
        truncated,
        total_nodes,
    }))
}

pub(crate) async fn memory_graph_merge(
    State(state): State<AppState>,
    Json(request): Json<MemoryGraphMergeRequest>,
) -> Result<Json<serde_json::Value>, GatewayError> {
    let survivor_ref =
        MemoryRef::from_str(&request.survivor_ref).map_err(|message| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "memory_bad_survivor_ref",
            message,
        })?;
    let absorbed_ref =
        MemoryRef::from_str(&request.absorbed_ref).map_err(|message| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "memory_bad_absorbed_ref",
            message,
        })?;
    if survivor_ref.user_id != absorbed_ref.user_id
        || survivor_ref.workspace_id != absorbed_ref.workspace_id
    {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "memory_merge_scope_mismatch",
            message: "Both entities must belong to the same memory scope.".to_string(),
        });
    }
    let reason = request
        .reason
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("merged from memory graph");
    {
        let facade = memory_facade(&state);
        facade
            .merge_entities(
                &survivor_ref,
                &absorbed_ref,
                &survivor_ref.user_id,
                &survivor_ref.workspace_id,
                reason,
            )
            .map_err(|error| GatewayError::memory(error.to_string()))?;
    }
    reconcile_memory_scope(&state, &survivor_ref.workspace_id);
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_memory_graph_routes_link_orphan_nodes_to_project_root() {
        let root = "entity:project-root:local:workspace_test:workspace:workspace_test".to_string();
        let orphan = "entity:project-root:local:workspace_test:topic:isolated".to_string();
        let mut edges = Vec::new();
        let nodes = vec![
            GraphNode {
                id: root.clone(),
                kind: "project".to_string(),
                label: "test-homun".to_string(),
                detail: String::new(),
                entity_type: "project".to_string(),
            },
            GraphNode {
                id: orphan.clone(),
                kind: "entity".to_string(),
                label: "isolated".to_string(),
                detail: String::new(),
                entity_type: "topic".to_string(),
            },
        ];

        ensure_project_graph_connectivity(&root, &nodes, &mut edges);

        assert!(edges.iter().any(|edge| {
            edge.source == root && edge.target == orphan && edge.label == "nel progetto"
        }));
    }

    #[test]
    fn gateway_memory_graph_routes_link_detached_components_to_project_root() {
        let root = "project::root".to_string();
        let a = "entity:local:local-user:workspace_test:topic:a".to_string();
        let b = "entity:local:local-user:workspace_test:topic:b".to_string();
        let nodes = vec![
            GraphNode {
                id: root.clone(),
                kind: "project".to_string(),
                label: "test-homun".to_string(),
                detail: String::new(),
                entity_type: "project".to_string(),
            },
            GraphNode {
                id: a.clone(),
                kind: "entity".to_string(),
                label: "A".to_string(),
                detail: String::new(),
                entity_type: "topic".to_string(),
            },
            GraphNode {
                id: b.clone(),
                kind: "entity".to_string(),
                label: "B".to_string(),
                detail: String::new(),
                entity_type: "topic".to_string(),
            },
        ];
        let mut edges = vec![GraphEdge {
            source: a.clone(),
            target: b.clone(),
            label: "related".to_string(),
        }];

        ensure_project_graph_connectivity(&root, &nodes, &mut edges);

        assert!(edges.iter().any(|edge| {
            edge.source == root
                && (edge.target == a || edge.target == b)
                && edge.label == "nel progetto"
        }));
    }

    #[test]
    fn gateway_memory_graph_routes_alias_detail_deduplicates_and_hides_self_aliases() {
        let detail = graph_entity_alias_detail(
            "Restituisce la somma di due numeri.",
            &[
                "Restituisce la somma di due numeri.".to_string(),
                "hello_rationale_2".to_string(),
                "rationale_for somma()".to_string(),
                "rationale_for somma()".to_string(),
                " rationale_for somma() ".to_string(),
            ],
        );

        assert_eq!(detail, "hello_rationale_2, rationale_for somma()");
    }

    #[test]
    fn gateway_memory_graph_routes_hide_project_entities_that_duplicate_root_label() {
        let root = "entity:local:local-user:workspace_test:workspace:workspace_test";
        let duplicate = local_first_memory::MemoryEntity {
            reference: local_first_memory::MemoryRef::new(
                local_first_memory::MemoryRefKind::Entity,
                local_first_memory::UserId::new("local-user"),
                local_first_memory::WorkspaceId::new("__personal__"),
                "project:test-homun",
            ),
            user_id: local_first_memory::UserId::new("local-user"),
            workspace_id: local_first_memory::WorkspaceId::new("__personal__"),
            entity_type: "project".to_string(),
            name: "test-homun".to_string(),
            canonical_key: "project:test-homun".to_string(),
            aliases: Vec::new(),
            privacy_domain: local_first_memory::PrivacyDomain::new("work"),
            sensitivity: MemoryDataSensitivity::Private,
            metadata: serde_json::json!({}),
        };

        assert!(project_graph_entity_duplicates_root(
            &duplicate,
            root,
            "test-homun"
        ));
    }

    #[test]
    fn gateway_memory_graph_routes_dedupe_identical_edges() {
        let mut edges = vec![
            GraphEdge {
                source: "entity:note".to_string(),
                target: "entity:somma".to_string(),
                label: "rationale_for".to_string(),
            },
            GraphEdge {
                source: "entity:note".to_string(),
                target: "entity:somma".to_string(),
                label: "rationale_for".to_string(),
            },
            GraphEdge {
                source: "entity:note".to_string(),
                target: "entity:somma".to_string(),
                label: "documents".to_string(),
            },
        ];

        dedupe_graph_edges(&mut edges);

        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].label, "rationale_for");
        assert_eq!(edges[1].label, "documents");
    }
}
