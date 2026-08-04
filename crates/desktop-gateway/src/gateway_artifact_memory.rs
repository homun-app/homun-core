// Artifact memory and provenance graph registration for generated/project files.
use crate::gateway_memory_graph::{provenance_key_fragment, upsert_memory_relation};
use crate::*;
pub(crate) fn artifact_memory_kind(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".pdf") {
        "pdf".to_string()
    } else if lower.ends_with(".pptx") {
        "presentation".to_string()
    } else if lower.ends_with(".docx") {
        "document".to_string()
    } else if lower.ends_with(".xlsx") || lower.ends_with(".csv") {
        "spreadsheet".to_string()
    } else if lower.ends_with(".html") {
        "html".to_string()
    } else if lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".webp")
    {
        "image".to_string()
    } else if lower.ends_with(".json") {
        "data".to_string()
    } else if lower.ends_with(".md") || lower.ends_with(".txt") {
        "document".to_string()
    } else {
        "file".to_string()
    }
}

fn artifact_memory_matches(memory: &MemoryRecord, thread_slug: &str, name: &str) -> bool {
    memory.memory_type == "artifact"
        && !matches!(
            memory.status,
            MemoryStatus::Deleted | MemoryStatus::Rejected | MemoryStatus::Stale
        )
        && memory
            .metadata
            .get("thread_slug")
            .and_then(|value| value.as_str())
            == Some(thread_slug)
        && memory.metadata.get("name").and_then(|value| value.as_str()) == Some(name)
}

fn provenance_label(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn provenance_normalized_label(value: &str) -> String {
    value
        .trim()
        .trim_matches('/')
        .replace('\\', "/")
        .to_ascii_lowercase()
}

pub(crate) fn artifact_provenance_labels(
    name: &str,
    metadata: &serde_json::Value,
) -> std::collections::HashSet<String> {
    let mut labels = std::collections::HashSet::new();
    let mut push = |value: &str| {
        let normalized = provenance_normalized_label(value);
        if !normalized.is_empty() {
            labels.insert(normalized);
        }
    };
    push(name);
    for key in [
        "title",
        "path_ref",
        "project_relative_path",
        "managed_path",
        "project_path",
    ] {
        if let Some(value) = metadata.get(key).and_then(|value| value.as_str()) {
            push(value);
            if let Some(file_name) = std::path::Path::new(value)
                .file_name()
                .and_then(|value| value.to_str())
            {
                push(file_name);
            }
        }
    }
    labels
}

fn decision_affects_artifact(
    decision: &MemoryRecord,
    artifact_labels: &std::collections::HashSet<String>,
) -> bool {
    let affected = decision
        .metadata
        .get("affects_labels")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(provenance_label);
    affected
        .map(|label| provenance_normalized_label(&label))
        .any(|label| artifact_labels.contains(&label))
}

fn explicit_artifact_source_refs(metadata: &serde_json::Value) -> Vec<MemoryRef> {
    let mut refs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for key in [
        "decision_refs",
        "plan_refs",
        "task_refs",
        "source_memory_refs",
        "derived_from_refs",
    ] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let values: Vec<&serde_json::Value> = if let Some(array) = value.as_array() {
            array.iter().collect()
        } else {
            vec![value]
        };
        for value in values {
            let Some(raw) = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let Ok(reference) = raw.parse::<MemoryRef>() else {
                continue;
            };
            if seen.insert(reference.to_string()) {
                refs.push(reference);
            }
        }
    }
    refs
}

#[allow(clippy::too_many_arguments)]
fn upsert_artifact_evidence_provenance_graph(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    privacy_domain: &str,
    artifact_ref: &MemoryRef,
    memory_ref: &MemoryRef,
    thread_slug: &str,
    name: &str,
    metadata: &serde_json::Value,
) -> Result<(), String> {
    let artifact_labels = artifact_provenance_labels(name, metadata);
    let explicit_refs: std::collections::HashSet<String> = explicit_artifact_source_refs(metadata)
        .into_iter()
        .filter(|reference| reference.user_id == *user && reference.workspace_id == *workspace)
        .map(|reference| reference.to_string())
        .collect();
    let decisions = facade
        .list_memories_for_ui(user, workspace)
        .unwrap_or_default()
        .into_iter()
        .filter(|memory| {
            memory.memory_type == "decision"
                && matches!(
                    memory.status,
                    MemoryStatus::Confirmed | MemoryStatus::Candidate
                )
                && (decision_affects_artifact(memory, &artifact_labels)
                    || explicit_refs.contains(&memory.reference.to_string()))
        })
        .collect::<Vec<_>>();
    let decision_refs: std::collections::HashSet<String> = decisions
        .iter()
        .map(|decision| decision.reference.to_string())
        .collect();
    for decision in decisions {
        let decision_fragment = provenance_key_fragment(&decision.reference.key);
        let artifact_fragment = provenance_key_fragment(name);
        upsert_memory_relation(
            facade,
            user,
            workspace,
            privacy_domain,
            format!("decision_affects_artifact:{decision_fragment}:{artifact_fragment}"),
            decision.reference.clone(),
            "affects",
            artifact_ref.clone(),
            vec![decision.reference.clone(), memory_ref.clone()],
            serde_json::json!({
                "source": "artifact_provenance",
                "evidence": "decision_affects_label_or_ref",
                "thread_slug": thread_slug,
                "name": name,
            }),
        )?;
        upsert_memory_relation(
            facade,
            user,
            workspace,
            privacy_domain,
            format!("artifact_derived_from_decision:{artifact_fragment}:{decision_fragment}"),
            artifact_ref.clone(),
            "derived_from",
            decision.reference.clone(),
            vec![decision.reference.clone(), memory_ref.clone()],
            serde_json::json!({
                "source": "artifact_provenance",
                "evidence": "decision_affects_label_or_ref",
                "thread_slug": thread_slug,
                "name": name,
            }),
        )?;
    }
    for source_ref in explicit_artifact_source_refs(metadata)
        .into_iter()
        .filter(|reference| reference.user_id == *user && reference.workspace_id == *workspace)
    {
        if source_ref == *memory_ref || decision_refs.contains(&source_ref.to_string()) {
            continue;
        }
        let source_fragment = provenance_key_fragment(&source_ref.key);
        let artifact_fragment = provenance_key_fragment(name);
        upsert_memory_relation(
            facade,
            user,
            workspace,
            privacy_domain,
            format!("artifact_derived_from_ref:{artifact_fragment}:{source_fragment}"),
            artifact_ref.clone(),
            "derived_from",
            source_ref.clone(),
            vec![source_ref.clone(), memory_ref.clone()],
            serde_json::json!({
                "source": "artifact_provenance",
                "evidence": "explicit_metadata_ref",
                "thread_slug": thread_slug,
                "name": name,
            }),
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn upsert_artifact_provenance_graph(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    privacy_domain: &str,
    artifact_ref: &MemoryRef,
    memory_ref: &MemoryRef,
    thread_slug: &str,
    name: &str,
    metadata: &serde_json::Value,
) -> Result<(), String> {
    let project_key = format!("project:{}", workspace.as_str());
    let project_ref = MemoryRef::new(
        MemoryRefKind::Entity,
        user.clone(),
        workspace.clone(),
        project_key.clone(),
    );
    facade
        .upsert_entity(&MemoryEntity {
            reference: project_ref.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            entity_type: "project".to_string(),
            name: workspace.as_str().to_string(),
            canonical_key: project_key,
            aliases: vec![workspace.as_str().to_string()],
            privacy_domain: PrivacyDomain::new(privacy_domain),
            sensitivity: MemoryDataSensitivity::Internal,
            metadata: serde_json::json!({
                "source": "artifact_provenance",
                "workspace": workspace.as_str(),
            }),
        })
        .map_err(|error| error.to_string())?;
    upsert_memory_relation(
        facade,
        user,
        workspace,
        privacy_domain,
        format!(
            "artifact_belongs_to_project:{}:{}",
            provenance_key_fragment(thread_slug),
            provenance_key_fragment(name)
        ),
        artifact_ref.clone(),
        "belongs_to_project",
        project_ref,
        vec![memory_ref.clone()],
        serde_json::json!({
            "source": "artifact_provenance",
            "thread_slug": thread_slug,
            "name": name,
        }),
    )?;

    if let Some(producer) = metadata
        .get("producer")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let producer_key = format!("tool:{producer}");
        let producer_ref = MemoryRef::new(
            MemoryRefKind::Entity,
            user.clone(),
            workspace.clone(),
            producer_key.clone(),
        );
        facade
            .upsert_entity(&MemoryEntity {
                reference: producer_ref.clone(),
                user_id: user.clone(),
                workspace_id: workspace.clone(),
                entity_type: "tool".to_string(),
                name: producer.to_string(),
                canonical_key: producer_key,
                aliases: vec![producer.to_string()],
                privacy_domain: PrivacyDomain::new(privacy_domain),
                sensitivity: MemoryDataSensitivity::Internal,
                metadata: serde_json::json!({
                    "source": "artifact_provenance",
                    "producer": producer,
                }),
            })
            .map_err(|error| error.to_string())?;
        upsert_memory_relation(
            facade,
            user,
            workspace,
            privacy_domain,
            format!(
                "artifact_produced:{}:{}:{}",
                provenance_key_fragment(producer),
                provenance_key_fragment(thread_slug),
                provenance_key_fragment(name)
            ),
            producer_ref,
            "produced",
            artifact_ref.clone(),
            vec![memory_ref.clone()],
            serde_json::json!({
                "source": "artifact_provenance",
                "thread_slug": thread_slug,
                "name": name,
                "producer": producer,
            }),
        )?;
    }

    if let Some(relative_path) = metadata
        .get("project_relative_path")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let file_key = format!("file:{relative_path}");
        let file_ref = MemoryRef::new(
            MemoryRefKind::Entity,
            user.clone(),
            workspace.clone(),
            file_key.clone(),
        );
        let file_name = std::path::Path::new(relative_path)
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(relative_path);
        facade
            .upsert_entity(&MemoryEntity {
                reference: file_ref.clone(),
                user_id: user.clone(),
                workspace_id: workspace.clone(),
                entity_type: "file".to_string(),
                name: relative_path.to_string(),
                canonical_key: file_key,
                aliases: vec![relative_path.to_string(), file_name.to_string()],
                privacy_domain: PrivacyDomain::new(privacy_domain),
                sensitivity: MemoryDataSensitivity::Internal,
                metadata: serde_json::json!({
                    "source": "artifact_provenance",
                    "project_relative_path": relative_path,
                    "project_path": metadata.get("project_path").cloned().unwrap_or(serde_json::Value::Null),
                }),
            })
            .map_err(|error| error.to_string())?;
        upsert_memory_relation(
            facade,
            user,
            workspace,
            privacy_domain,
            format!(
                "artifact_file:{}:{}",
                provenance_key_fragment(thread_slug),
                provenance_key_fragment(relative_path)
            ),
            artifact_ref.clone(),
            "relates_to",
            file_ref,
            vec![memory_ref.clone()],
            serde_json::json!({
                "source": "artifact_provenance",
                "thread_slug": thread_slug,
                "name": name,
                "project_relative_path": relative_path,
            }),
        )?;
    }

    upsert_artifact_evidence_provenance_graph(
        facade,
        user,
        workspace,
        privacy_domain,
        artifact_ref,
        memory_ref,
        thread_slug,
        name,
        metadata,
    )?;

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn upsert_artifact_memory_record(
    facade: &MemoryFacade,
    user: &MemoryUserId,
    workspace: &MemoryWorkspaceId,
    lifecycle: &MemoryLifecycleRequest,
    privacy_domain: &str,
    thread_slug: &str,
    name: &str,
    text: String,
    metadata: serde_json::Value,
) -> Result<MemoryRef, String> {
    let existing = facade
        .list_memories_for_ui(user, workspace)
        .unwrap_or_default()
        .into_iter()
        .find(|memory| artifact_memory_matches(memory, thread_slug, name));
    let record = if let Some(existing) = existing {
        facade
            .update_memory(
                lifecycle,
                &existing.reference,
                MemoryUpdatePatch {
                    text: Some(text),
                    aliases: None,
                    language_hints: None,
                    confidence: Some(1.0),
                    privacy_domain: Some(PrivacyDomain::new(privacy_domain)),
                    sensitivity: Some(MemoryDataSensitivity::Internal),
                    metadata: Some(metadata.clone()),
                    last_seen_at: None,
                },
            )
            .map_err(|error| error.to_string())?
    } else {
        let record = facade
            .create_memory_candidate(MemoryCreateRequest {
                request: lifecycle.clone(),
                memory_type: "artifact".to_string(),
                text,
                aliases: vec![name.to_string()],
                language_hints: Vec::new(),
                confidence: 1.0,
                privacy_domain: PrivacyDomain::new(privacy_domain),
                sensitivity: MemoryDataSensitivity::Internal,
                evidence_refs: Vec::new(),
                metadata: metadata.clone(),
            })
            .map_err(|error| error.to_string())?;
        facade
            .confirm_memory(lifecycle, &record.reference, "artifact generated")
            .map_err(|error| error.to_string())?
    };
    let canonical_key = format!("artifact:{thread_slug}:{name}");
    let entity_ref = MemoryRef::new(
        MemoryRefKind::Entity,
        user.clone(),
        workspace.clone(),
        canonical_key.clone(),
    );
    facade
        .upsert_entity(&MemoryEntity {
            reference: entity_ref.clone(),
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            entity_type: "artifact".to_string(),
            name: name.to_string(),
            canonical_key,
            aliases: vec![name.to_string()],
            privacy_domain: PrivacyDomain::new(privacy_domain),
            sensitivity: MemoryDataSensitivity::Internal,
            metadata: metadata.clone(),
        })
        .map_err(|error| error.to_string())?;
    let relation_ref = MemoryRef::new(
        MemoryRefKind::Relation,
        user.clone(),
        workspace.clone(),
        format!("artifact_described_by:{thread_slug}:{name}"),
    );
    facade
        .upsert_relation(&MemoryRelation {
            reference: relation_ref,
            user_id: user.clone(),
            workspace_id: workspace.clone(),
            source_ref: record.reference.clone(),
            relation_type: "describes".to_string(),
            target_ref: entity_ref.clone(),
            confidence: 1.0,
            privacy_domain: PrivacyDomain::new(privacy_domain),
            sensitivity: MemoryDataSensitivity::Internal,
            evidence: vec![record.reference.clone()],
            metadata: serde_json::json!({
                "source": "artifact_runtime",
                "thread_slug": thread_slug,
                "name": name,
            }),
        })
        .map_err(|error| error.to_string())?;
    upsert_artifact_provenance_graph(
        facade,
        user,
        workspace,
        privacy_domain,
        &entity_ref,
        &record.reference,
        thread_slug,
        name,
        &metadata,
    )?;
    Ok(record.reference)
}

#[allow(clippy::too_many_arguments)]
fn remember_artifact_memory(
    state: &AppState,
    thread_id: Option<&str>,
    thread_slug: &str,
    name: &str,
    size_bytes: u64,
    updated: bool,
    producer: &str,
    delivered_to: Option<&str>,
    extra_metadata: Option<&serde_json::Value>,
) -> Result<(MemoryUserId, MemoryWorkspaceId, MemoryRef), String> {
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid artifact name".to_string());
    }
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let privacy_domain = if workspace.as_str() == PERSONAL_WORKSPACE {
        "personal"
    } else {
        "project"
    };
    let kind = artifact_memory_kind(name);
    let managed_path = sandbox::artifacts_dir().join(thread_slug).join(name);
    let project_path = delivered_to.map(|path| path.to_string()).or_else(|| {
        active_workspace_folder().map(|folder| {
            std::path::Path::new(&folder)
                .join(name)
                .to_string_lossy()
                .to_string()
        })
    });
    let text = if updated {
        format!(
            "Artifact {name} ({kind}) aggiornato nel thread {}.",
            thread_id.unwrap_or(thread_slug)
        )
    } else {
        format!(
            "Artifact {name} ({kind}) creato nel thread {}.",
            thread_id.unwrap_or(thread_slug)
        )
    };
    let mut metadata = serde_json::json!({
        "source": "artifact_runtime",
        "producer": producer,
        "thread_id": thread_id,
        "thread_slug": thread_slug,
        "name": name,
        "title": name,
        "artifact_type": kind,
        "path_ref": format!("{thread_slug}/{name}"),
        "managed_path": managed_path.to_string_lossy().to_string(),
        "project_path": project_path,
        "size_bytes": size_bytes,
        "updated": updated,
        "lifecycle_status": "active",
    });
    merge_object_metadata(&mut metadata, extra_metadata);
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "artifact-runtime".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "artifact_created".to_string(),
    };
    let facade = memory_facade(state);
    let reference = upsert_artifact_memory_record(
        facade,
        &user,
        &workspace,
        &lifecycle,
        privacy_domain,
        thread_slug,
        name,
        text,
        metadata,
    )?;
    Ok((user, workspace, reference))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn register_artifact_memory(
    state: &AppState,
    thread_id: Option<&str>,
    thread_slug: &str,
    name: &str,
    size_bytes: u64,
    updated: bool,
    producer: &str,
    delivered_to: Option<&str>,
) {
    register_artifact_memory_with_metadata(
        state,
        thread_id,
        thread_slug,
        name,
        size_bytes,
        updated,
        producer,
        delivered_to,
        None,
    )
    .await;
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn register_artifact_memory_with_metadata(
    state: &AppState,
    thread_id: Option<&str>,
    thread_slug: &str,
    name: &str,
    size_bytes: u64,
    updated: bool,
    producer: &str,
    delivered_to: Option<&str>,
    extra_metadata: Option<&serde_json::Value>,
) {
    if let Ok((user, workspace, _reference)) = remember_artifact_memory(
        state,
        thread_id,
        thread_slug,
        name,
        size_bytes,
        updated,
        producer,
        delivered_to,
        extra_metadata,
    ) {
        backfill_embeddings(state, &user, &workspace, 4).await;
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn emit_rendered_deck_artifacts(
    state: &AppState,
    tx: &StreamSink,
    accumulated: &mut String,
    thread_id: Option<&str>,
    thread_slug: &str,
    producer: &str,
    quality_metadata: Option<&serde_json::Value>,
    // Generalized for F2-T8 (make_document templated path): deck call sites
    // pass `DECK_ARTIFACT_NAMES`, documents pass their own
    // {stem}-prefixed names. Missing files are silently skipped either way,
    // which is exactly what lets the make_document degraded-render branch
    // reuse this same helper: pass all 3 expected names, only the ones that
    // actually exist on disk get emitted.
    names: &[&str],
) -> Vec<String> {
    let host_dir = sandbox::artifacts_dir().join(thread_slug);
    let mut produced = Vec::new();
    for &fname in names {
        if let Ok(meta) = std::fs::metadata(host_dir.join(fname)) {
            if meta.len() == 0 {
                continue;
            }
            let mut marker = serde_json::json!({
                "name": fname,
                "thread": thread_slug,
                "size": meta.len(),
                "updated": false,
                "source": "managed",
                "managed_path": host_dir.join(fname).to_string_lossy().to_string(),
            });
            merge_object_metadata(&mut marker, quality_metadata);
            let m = format!("‹‹ARTIFACT››{marker}‹‹/ARTIFACT››");
            accumulated.push_str(&m);
            let _ = emit_stream_event(tx, GenerateStreamEvent::Delta { text: m }).await;
            register_artifact_memory_with_metadata(
                state,
                thread_id,
                thread_slug,
                fname,
                meta.len(),
                false,
                producer,
                None,
                quality_metadata,
            )
            .await;
            produced.push(fname.to_string());
        }
    }
    produced
}

pub(crate) const DECK_ARTIFACT_NAMES: &[&str] =
    &["deck.pptx", "deck.html", "deck.pdf", "deck.json"];

fn remember_project_file_artifact_memory(
    state: &AppState,
    thread_id: Option<&str>,
    relative_path: &str,
    size_bytes: u64,
    producer: &str,
) -> Result<(MemoryUserId, MemoryWorkspaceId, MemoryRef), String> {
    let relative_path = relative_path.trim();
    if relative_path.is_empty() {
        return Err("empty project artifact path".to_string());
    }
    let root = project_root_for_thread(state, thread_id)
        .ok_or_else(|| "project root unavailable".to_string())?;
    let project_path = jail_in_root(&root, relative_path)?;
    let user = gateway_memory_user_id();
    let workspace = gateway_memory_workspace_id();
    let privacy_domain = if workspace.as_str() == PERSONAL_WORKSPACE {
        "personal"
    } else {
        "project"
    };
    let kind = artifact_memory_kind(relative_path);
    let title = std::path::Path::new(relative_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(relative_path);
    let thread_slug = artifact_thread_slug(Some(&format!("project-{}", workspace.as_str())));
    let text = format!("Artifact {relative_path} ({kind}) creato o aggiornato nel progetto.");
    let metadata = serde_json::json!({
        "source": "artifact_runtime",
        "producer": producer,
        "thread_id": thread_id,
        "thread_slug": thread_slug,
        "name": relative_path,
        "title": title,
        "artifact_type": kind,
        "path_ref": relative_path,
        "project_relative_path": relative_path,
        "managed_path": null,
        "project_path": project_path.to_string_lossy().to_string(),
        "size_bytes": size_bytes,
        "updated": true,
        "lifecycle_status": "active",
    });
    let lifecycle = MemoryLifecycleRequest {
        actor_id: "artifact-runtime".to_string(),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        purpose: "project_file_written".to_string(),
    };
    let facade = memory_facade(state);
    let reference = upsert_artifact_memory_record(
        facade,
        &user,
        &workspace,
        &lifecycle,
        privacy_domain,
        &thread_slug,
        relative_path,
        text,
        metadata,
    )?;
    Ok((user, workspace, reference))
}

pub(crate) async fn register_project_file_artifact_memory(
    state: &AppState,
    thread_id: Option<&str>,
    relative_path: &str,
    size_bytes: u64,
    producer: &str,
) {
    if let Ok((user, workspace, _reference)) =
        remember_project_file_artifact_memory(state, thread_id, relative_path, size_bytes, producer)
    {
        backfill_embeddings(state, &user, &workspace, 4).await;
    }
}

fn mcp_filesystem_project_relative_path(
    state: &AppState,
    thread_id: Option<&str>,
    mcp_provider: &str,
    mcp_tool: &str,
    args: &serde_json::Value,
) -> Option<String> {
    let root = project_root_for_thread(state, thread_id)?;
    mcp_filesystem_project_relative_path_for_root(&root, mcp_provider, mcp_tool, args)
}

pub(crate) fn mcp_filesystem_project_relative_path_for_root(
    root: &std::path::Path,
    mcp_provider: &str,
    mcp_tool: &str,
    args: &serde_json::Value,
) -> Option<String> {
    let provider_slug = mcp_provider.strip_prefix("mcp:").unwrap_or(mcp_provider);
    if provider_slug != "filesystem" {
        return None;
    }
    if !matches!(
        mcp_tool,
        "create" | "insert" | "str_replace" | "write" | "write_file"
    ) {
        return None;
    }
    let raw_path = args.get("path").and_then(|value| value.as_str())?.trim();
    if raw_path.is_empty() {
        return None;
    }
    let path = if raw_path.starts_with('/') || raw_path.starts_with('~') {
        fs_expand_abs(raw_path)?
    } else {
        jail_in_root(root, raw_path).ok()?
    };
    if !path_within(root, &path) {
        return None;
    }
    path.strip_prefix(root)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .filter(|relative| !relative.trim().is_empty())
}

pub(crate) async fn register_mcp_filesystem_artifact_memory(
    state: &AppState,
    thread_id: Option<&str>,
    mcp_provider: &str,
    mcp_tool: &str,
    args: &serde_json::Value,
) {
    let Some(relative_path) =
        mcp_filesystem_project_relative_path(state, thread_id, mcp_provider, mcp_tool, args)
    else {
        return;
    };
    let size = project_root_for_thread(state, thread_id)
        .and_then(|root| jail_in_root(&root, &relative_path).ok())
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|metadata| metadata.len())
        .or_else(|| {
            args.get("content")
                .and_then(|value| value.as_str())
                .map(|content| content.len() as u64)
        })
        .unwrap_or_default();
    register_project_file_artifact_memory(state, thread_id, &relative_path, size, "mcp_filesystem")
        .await;
}

#[cfg(test)]
mod tests {
    #[test]
    fn artifact_memory_kind_classifies_generated_file_formats() {
        assert_eq!(super::artifact_memory_kind("brief.pdf"), "pdf");
        assert_eq!(super::artifact_memory_kind("deck.pptx"), "presentation");
        assert_eq!(super::artifact_memory_kind("data/checkpoint.json"), "data");
        assert_eq!(super::artifact_memory_kind("notes.md"), "document");
    }

    #[test]
    fn artifact_provenance_labels_normalizes_paths_and_file_names() {
        let labels = super::artifact_provenance_labels(
            "Report.pdf",
            &serde_json::json!({
                "project_relative_path": "Reports/Final Report.pdf",
                "managed_path": "/tmp/Homun/Reports/Final Report.pdf"
            }),
        );

        assert!(labels.contains("report.pdf"));
        assert!(labels.contains("reports/final report.pdf"));
        assert!(labels.contains("final report.pdf"));
    }
}
