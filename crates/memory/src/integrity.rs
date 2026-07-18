use crate::{
    MemoryBackupReport, PERSONAL_WORKSPACE, THREADS_WORKSPACE, UserId, WorkspaceId,
    current_timestamp,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnknownScopeCount {
    pub workspace_id: String,
    pub rows_by_table: BTreeMap<String, u64>,
    pub total_rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryIntegrityReport {
    pub generated_at: String,
    pub schema_version: u32,
    pub integrity_ok: bool,
    pub foreign_key_violations: u64,
    pub rows_by_table: BTreeMap<String, u64>,
    pub relation_duplicate_groups: u64,
    pub relation_duplicate_extras: u64,
    pub canonical_entity_duplicate_groups: u64,
    pub canonical_entity_duplicate_extras: u64,
    pub graphify_relation_duplicate_groups: u64,
    pub graphify_relation_duplicate_extras: u64,
    pub dangling_relations: u64,
    pub orphan_embeddings: u64,
    pub orphan_evidence_links: u64,
    pub memories_missing_fts: u64,
    pub stale_fts_rows: u64,
    pub missing_wiki_links: u64,
    pub invalid_json_rows: u64,
    pub active_memory_duplicate_groups: u64,
    pub active_memory_duplicate_extras: u64,
    pub unknown_scope_rows: u64,
    pub unknown_scopes: Vec<UnknownScopeCount>,
    pub active_source_grants: u64,
    pub expired_but_active_grants: u64,
    pub revoked_grant_inconsistencies: u64,
    pub orphan_grant_children: u64,
    pub checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MemoryRepairAction {
    RemoveGraphifyDuplicateRelations { workspace_id: WorkspaceId },
    RemoveOrphanEmbeddings,
    RemoveOrphanEvidenceLinks,
    RemoveMissingWikiLinks,
    RebuildFts,
    PurgeUnknownWorkspace { workspace_id: WorkspaceId },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryRepairEstimate {
    pub action: MemoryRepairAction,
    pub estimated_rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryIntegrityRepairPreview {
    pub audit_checksum: String,
    pub actions: Vec<MemoryRepairAction>,
    pub estimates: Vec<MemoryRepairEstimate>,
    pub approval_token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryIntegrityRepairRequest {
    pub audit_checksum: String,
    pub actions: Vec<MemoryRepairAction>,
    pub approval_token: String,
    pub backup_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryIntegrityRepairResult {
    pub before: MemoryIntegrityReport,
    pub after: MemoryIntegrityReport,
    pub backup: MemoryBackupReport,
    pub applied: Vec<MemoryRepairEstimate>,
}

pub(crate) fn audit_memory_integrity_on(
    connection: &Connection,
    known_scopes: &[(UserId, WorkspaceId)],
) -> Result<MemoryIntegrityReport, String> {
    let integrity_ok = sqlite_integrity_ok(connection)?;
    audit_memory_integrity_with_status_on(connection, known_scopes, integrity_ok)
}

pub(crate) fn audit_memory_integrity_with_status_on(
    connection: &Connection,
    known_scopes: &[(UserId, WorkspaceId)],
    integrity_ok: bool,
) -> Result<MemoryIntegrityReport, String> {
    let schema_version = connection
        .query_row(
            "select value from schema_metadata where key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?
        .parse::<u32>()
        .map_err(|error| error.to_string())?;
    let foreign_key_violations = pragma_row_count(connection, "pragma foreign_key_check")?;
    let rows_by_table = rows_by_table(connection)?;

    let (relation_duplicate_groups, relation_duplicate_extras) = duplicate_counts(
        connection,
        "select count(*), coalesce(sum(duplicate_count - 1), 0)
         from (
             select count(*) as duplicate_count from relations
             group by user_id, workspace_id, source_ref, relation_type, target_ref
             having count(*) > 1
         )",
    )?;
    let (canonical_entity_duplicate_groups, canonical_entity_duplicate_extras) = duplicate_counts(
        connection,
        "select count(*), coalesce(sum(duplicate_count - 1), 0)
             from (
                 select count(*) as duplicate_count from entities
                 group by user_id, workspace_id, canonical_key
                 having count(*) > 1
             )",
    )?;
    let (graphify_relation_duplicate_groups, graphify_relation_duplicate_extras) =
        duplicate_counts(
            connection,
            "select count(*), coalesce(sum(duplicate_count - 1), 0)
             from (
                 select count(*) as duplicate_count from relations
                 where json_valid(metadata_json)
                   and (json_extract(metadata_json, '$.adapter') = 'graphify'
                        or json_extract(metadata_json, '$.source') = 'graphify')
                 group by user_id, workspace_id, source_ref, relation_type, target_ref
                 having count(*) > 1
             )",
        )?;
    let (active_memory_duplicate_groups, active_memory_duplicate_extras) = duplicate_counts(
        connection,
        "select count(*), coalesce(sum(duplicate_count - 1), 0)
         from (
             select count(*) as duplicate_count from memories
             where status in ('candidate', 'confirmed')
             group by user_id, workspace_id, memory_type, lower(trim(text))
             having count(*) > 1
         )",
    )?;

    let dangling_relations = count_query(
        connection,
        "select count(*) from relations r
         where not exists (
             select 1 from memories m
             where m.ref = r.source_ref and m.user_id = r.user_id and m.workspace_id = r.workspace_id
             union all
             select 1 from entities e
             where e.ref = r.source_ref and e.user_id = r.user_id and e.workspace_id = r.workspace_id
         ) or not exists (
             select 1 from memories m
             where m.ref = r.target_ref and m.user_id = r.user_id and m.workspace_id = r.workspace_id
             union all
             select 1 from entities e
             where e.ref = r.target_ref and e.user_id = r.user_id and e.workspace_id = r.workspace_id
         )",
    )?;
    let orphan_embeddings = count_query(
        connection,
        "select count(*) from memory_embeddings e
         where not exists (
             select 1 from memories m
             where m.ref = e.ref and m.user_id = e.user_id and m.workspace_id = e.workspace_id
         )",
    )?;
    let orphan_evidence_links = count_query(
        connection,
        "select count(*) from memory_evidence e
         where not exists (select 1 from memories m where m.ref = e.memory_ref)
            or not exists (select 1 from memory_events v where v.ref = e.evidence_ref)",
    )?;
    let memories_missing_fts = count_query(
        connection,
        "select count(*) from memories m
         where not exists (
             select 1 from memory_search_fts f
             where f.ref = m.ref and f.user_id = m.user_id and f.workspace_id = m.workspace_id
         )",
    )?;
    let stale_fts_rows = count_query(
        connection,
        "select count(*) from memory_search_fts f
         where not exists (
             select 1 from memories m
             where m.ref = f.ref and m.user_id = f.user_id and m.workspace_id = f.workspace_id
               and m.text = f.text
               and coalesce((
                   select group_concat(value, ' ') from json_each(
                       case when json_valid(m.aliases_json) then m.aliases_json else '[]' end
                   )
               ), '') = f.aliases
         )",
    )?;
    let missing_wiki_links = count_query(
        connection,
        "select count(*) from wiki_pages w,
             json_each(case when json_valid(w.linked_refs_json) then w.linked_refs_json else '[]' end) link
         where not exists (
             select 1 from memories m
             where m.ref = link.value and m.user_id = w.user_id and m.workspace_id = w.workspace_id
             union all
             select 1 from entities e
             where e.ref = link.value and e.user_id = w.user_id and e.workspace_id = w.workspace_id
         )",
    )?;
    let invalid_json_rows = count_query(connection, INVALID_JSON_ROWS_SQL)?;

    let (unknown_scopes, unknown_scope_rows) = unknown_scopes(connection, known_scopes)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_secs()
        .min(i64::MAX as u64) as i64;
    let active_source_grants = count_query(
        connection,
        "select count(*) from memory_source_grants where revoked_at is null",
    )?;
    let expired_but_active_grants = connection
        .query_row(
            "select count(*) from memory_source_grants
             where revoked_at is null and expires_at is not null and expires_at <= ?1",
            [now],
            |row| row.get::<_, u64>(0),
        )
        .map_err(|error| error.to_string())?;
    let revoked_grant_inconsistencies = count_query(
        connection,
        "select count(*) from memory_source_grants g
         where g.revoked_at is not null and exists (
             select 1 from memory_source_access_events e
             where e.grant_id = g.id and e.outcome = 'allow' and e.created_at >= g.revoked_at
         )",
    )?;
    let orphan_grant_children = count_query(
        connection,
        "select
             (select count(*) from memory_source_grant_collections c
              where not exists (select 1 from memory_source_grants g where g.id = c.grant_id))
           + (select count(*) from memory_source_grant_overrides o
              where not exists (select 1 from memory_source_grants g where g.id = o.grant_id))
           + (select count(*) from memory_source_access_events e
              where e.grant_id is not null
                and not exists (select 1 from memory_source_grants g where g.id = e.grant_id))",
    )?;

    let mut report = MemoryIntegrityReport {
        generated_at: current_timestamp(),
        schema_version,
        integrity_ok,
        foreign_key_violations,
        rows_by_table,
        relation_duplicate_groups,
        relation_duplicate_extras,
        canonical_entity_duplicate_groups,
        canonical_entity_duplicate_extras,
        graphify_relation_duplicate_groups,
        graphify_relation_duplicate_extras,
        dangling_relations,
        orphan_embeddings,
        orphan_evidence_links,
        memories_missing_fts,
        stale_fts_rows,
        missing_wiki_links,
        invalid_json_rows,
        active_memory_duplicate_groups,
        active_memory_duplicate_extras,
        unknown_scope_rows,
        unknown_scopes,
        active_source_grants,
        expired_but_active_grants,
        revoked_grant_inconsistencies,
        orphan_grant_children,
        checksum: String::new(),
    };
    report.checksum = report_checksum(&report)?;
    Ok(report)
}

pub(crate) fn preview_memory_integrity_repair_on(
    connection: &Connection,
    known_scopes: &[(UserId, WorkspaceId)],
    actions: Vec<MemoryRepairAction>,
) -> Result<MemoryIntegrityRepairPreview, String> {
    let audit = audit_memory_integrity_on(connection, known_scopes)?;
    preview_for_audit_on(connection, known_scopes, &audit, actions)
}

pub(crate) fn preview_for_audit_on(
    connection: &Connection,
    known_scopes: &[(UserId, WorkspaceId)],
    audit: &MemoryIntegrityReport,
    actions: Vec<MemoryRepairAction>,
) -> Result<MemoryIntegrityRepairPreview, String> {
    let actions = canonical_actions(actions)?;
    if actions.is_empty() {
        return Err("integrity repair requires at least one explicit action".to_string());
    }
    let known = known_scopes
        .iter()
        .map(|(user, workspace)| (user.as_str().to_string(), workspace.as_str().to_string()))
        .collect::<HashSet<_>>();
    let mut estimates = Vec::with_capacity(actions.len());
    for action in &actions {
        let estimated_rows = match action {
            MemoryRepairAction::RemoveGraphifyDuplicateRelations { workspace_id } => {
                if workspace_id.as_str().trim().is_empty()
                    || !known
                        .iter()
                        .any(|(_, workspace)| workspace == workspace_id.as_str())
                {
                    return Err(format!(
                        "graphify duplicate repair requires a registered workspace: {}",
                        workspace_id.as_str()
                    ));
                }
                graphify_duplicate_extras_for_workspace(connection, known_scopes, workspace_id)?
            }
            MemoryRepairAction::RemoveOrphanEmbeddings => audit.orphan_embeddings,
            MemoryRepairAction::RemoveOrphanEvidenceLinks => audit.orphan_evidence_links,
            MemoryRepairAction::RemoveMissingWikiLinks => audit.missing_wiki_links,
            MemoryRepairAction::RebuildFts => audit
                .memories_missing_fts
                .saturating_add(audit.stale_fts_rows),
            MemoryRepairAction::PurgeUnknownWorkspace { workspace_id } => {
                if workspace_id.as_str().trim().is_empty()
                    || matches!(
                        workspace_id.as_str(),
                        PERSONAL_WORKSPACE | THREADS_WORKSPACE
                    )
                    || known
                        .iter()
                        .any(|(_, workspace)| workspace == workspace_id.as_str())
                {
                    return Err(format!(
                        "workspace is not eligible for unknown-scope purge: {}",
                        workspace_id.as_str()
                    ));
                }
                audit
                    .unknown_scopes
                    .iter()
                    .find(|scope| scope.workspace_id == workspace_id.as_str())
                    .map(|scope| scope.total_rows)
                    .ok_or_else(|| {
                        format!("unknown workspace not present: {}", workspace_id.as_str())
                    })?
            }
        };
        estimates.push(MemoryRepairEstimate {
            action: action.clone(),
            estimated_rows,
        });
    }
    let approval_token = repair_approval_token(&audit.checksum, &actions)?;
    Ok(MemoryIntegrityRepairPreview {
        audit_checksum: audit.checksum.clone(),
        actions,
        estimates,
        approval_token,
    })
}

pub(crate) fn canonical_actions(
    actions: Vec<MemoryRepairAction>,
) -> Result<Vec<MemoryRepairAction>, String> {
    let mut encoded = actions
        .into_iter()
        .map(|action| {
            serde_json::to_string(&action)
                .map(|json| (json, action))
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    encoded.sort_by(|left, right| left.0.cmp(&right.0));
    for pair in encoded.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err("integrity repair contains duplicate actions".to_string());
        }
    }
    Ok(encoded.into_iter().map(|(_, action)| action).collect())
}

pub(crate) fn repair_approval_token(
    audit_checksum: &str,
    actions: &[MemoryRepairAction],
) -> Result<String, String> {
    let canonical = serde_json::to_vec(actions).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(audit_checksum.as_bytes());
    hasher.update([0]);
    hasher.update(canonical);
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn graphify_duplicate_extras_for_workspace(
    connection: &Connection,
    known_scopes: &[(UserId, WorkspaceId)],
    workspace_id: &WorkspaceId,
) -> Result<u64, String> {
    let mut total = 0_u64;
    for (user_id, known_workspace) in known_scopes {
        if known_workspace != workspace_id {
            continue;
        }
        let extras = connection
            .query_row(
                "select coalesce(sum(duplicate_count - 1), 0)
                 from (
                     select count(*) duplicate_count from relations
                     where user_id = ?1 and workspace_id = ?2
                       and json_valid(metadata_json)
                       and (json_extract(metadata_json, '$.adapter') = 'graphify'
                            or json_extract(metadata_json, '$.source') = 'graphify')
                     group by source_ref, relation_type, target_ref
                     having count(*) > 1
                 )",
                (user_id.as_str(), workspace_id.as_str()),
                |row| row.get::<_, u64>(0),
            )
            .map_err(|error| error.to_string())?;
        total = total.saturating_add(extras);
    }
    Ok(total)
}

fn sqlite_integrity_ok(connection: &Connection) -> Result<bool, String> {
    let mut statement = connection
        .prepare("pragma integrity_check")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|error| error.to_string())?);
    }
    Ok(results.iter().all(|result| {
        result == "ok" || result == "malformed inverted index for FTS5 table main.memory_search_fts"
    }))
}

fn pragma_row_count(connection: &Connection, pragma: &str) -> Result<u64, String> {
    let mut statement = connection
        .prepare(pragma)
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([]).map_err(|error| error.to_string())?;
    let mut count = 0_u64;
    while rows.next().map_err(|error| error.to_string())?.is_some() {
        count = count.saturating_add(1);
    }
    Ok(count)
}

fn count_query(connection: &Connection, sql: &str) -> Result<u64, String> {
    connection
        .query_row(sql, [], |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn duplicate_counts(connection: &Connection, sql: &str) -> Result<(u64, u64), String> {
    connection
        .query_row(sql, [], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|error| error.to_string())
}

fn rows_by_table(connection: &Connection) -> Result<BTreeMap<String, u64>, String> {
    let mut counts = BTreeMap::new();
    for table in [
        "schema_metadata",
        "memory_events",
        "memories",
        "memory_embeddings",
        "memory_search_fts",
        "entities",
        "relations",
        "memory_evidence",
        "wiki_pages",
        "routines",
        "automation_candidates",
        "access_audit",
        "tombstones",
        "memory_source_grants",
        "memory_source_grant_collections",
        "memory_source_grant_overrides",
        "memory_source_access_events",
        "memory_publication_proposals",
        "memory_publication_links",
    ] {
        counts.insert(
            table.to_string(),
            count_query(connection, &format!("select count(*) from {table}"))?,
        );
    }
    Ok(counts)
}

fn unknown_scopes(
    connection: &Connection,
    known_scopes: &[(UserId, WorkspaceId)],
) -> Result<(Vec<UnknownScopeCount>, u64), String> {
    let known = known_scopes
        .iter()
        .map(|(user, workspace)| (user.as_str().to_string(), workspace.as_str().to_string()))
        .collect::<HashSet<_>>();
    let mut unknown = BTreeMap::<String, BTreeMap<String, u64>>::new();

    for (table, user_column, workspace_column) in [
        ("memory_events", "user_id", "workspace_id"),
        ("memories", "user_id", "workspace_id"),
        ("memory_embeddings", "user_id", "workspace_id"),
        ("memory_search_fts", "user_id", "workspace_id"),
        ("entities", "user_id", "workspace_id"),
        ("relations", "user_id", "workspace_id"),
        ("wiki_pages", "user_id", "workspace_id"),
        ("routines", "user_id", "workspace_id"),
        ("automation_candidates", "user_id", "workspace_id"),
        ("access_audit", "user_id", "workspace_id"),
        ("tombstones", "user_id", "workspace_id"),
        (
            "memory_source_grants",
            "consumer_user_id",
            "consumer_workspace_id",
        ),
        (
            "memory_source_grants",
            "source_user_id",
            "source_workspace_id",
        ),
        (
            "memory_source_access_events",
            "consumer_user_id",
            "consumer_workspace_id",
        ),
        (
            "memory_source_access_events",
            "consumer_user_id",
            "source_workspace_id",
        ),
        (
            "memory_publication_proposals",
            "source_user_id",
            "source_workspace_id",
        ),
        (
            "memory_publication_proposals",
            "destination_user_id",
            "destination_workspace_id",
        ),
    ] {
        let sql = format!(
            "select {user_column}, {workspace_column}, count(*) from {table}
             group by {user_column}, {workspace_column}"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (user_id, workspace_id, count) = row.map_err(|error| error.to_string())?;
            if known.contains(&(user_id, workspace_id.clone())) {
                continue;
            }
            let table_counts = unknown.entry(workspace_id).or_default();
            *table_counts.entry(table.to_string()).or_default() += count;
        }
    }

    for json_column in ["source_ref_json", "destination_ref_json"] {
        let sql = format!(
            "select json_extract({json_column}, '$.user_id'),
                    json_extract({json_column}, '$.workspace_id'), count(*)
             from memory_publication_links
             where json_valid({json_column})
             group by json_extract({json_column}, '$.user_id'),
                      json_extract({json_column}, '$.workspace_id')"
        );
        let mut statement = connection
            .prepare(&sql)
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (user_id, workspace_id, count) = row.map_err(|error| error.to_string())?;
            if known.contains(&(user_id, workspace_id.clone())) {
                continue;
            }
            let table_counts = unknown.entry(workspace_id).or_default();
            *table_counts
                .entry("memory_publication_links".to_string())
                .or_default() += count;
        }
    }

    let unknown_scopes = unknown
        .into_iter()
        .map(|(workspace_id, rows_by_table)| UnknownScopeCount {
            total_rows: rows_by_table.values().sum(),
            workspace_id,
            rows_by_table,
        })
        .collect::<Vec<_>>();
    let total = unknown_scopes.iter().map(|scope| scope.total_rows).sum();
    Ok((unknown_scopes, total))
}

fn report_checksum(report: &MemoryIntegrityReport) -> Result<String, String> {
    let mut stable = report.clone();
    stable.generated_at.clear();
    stable.checksum.clear();
    let encoded = serde_json::to_vec(&stable).map_err(|error| error.to_string())?;
    let digest = Sha256::digest(encoded);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

const INVALID_JSON_ROWS_SQL: &str = r#"
    select coalesce(sum(invalid), 0) from (
        select case when not json_valid(payload_json) then 1 else 0 end invalid from memory_events
        union all
        select case when not json_valid(aliases_json) or not json_valid(language_hints_json)
                          or not json_valid(metadata_json) or not json_valid(supersedes_json)
                         then 1 else 0 end from memories
        union all
        select case when not json_valid(aliases_json) or not json_valid(metadata_json)
                         then 1 else 0 end from entities
        union all
        select case when not json_valid(evidence_json) or not json_valid(metadata_json)
                         then 1 else 0 end from relations
        union all
        select case when not json_valid(linked_refs_json) then 1 else 0 end from wiki_pages
        union all
        select case when not json_valid(schedule_hint_json) or not json_valid(evidence_json)
                          or not json_valid(metadata_json) then 1 else 0 end from routines
        union all
        select case when not json_valid(actions_json) or not json_valid(evidence_json)
                          or not json_valid(proposal_json) then 1 else 0 end from automation_candidates
        union all
        select case when not json_valid(reasons_json) then 1 else 0 end from access_audit
        union all
        select case when not json_valid(injected_refs_json) then 1 else 0 end
          from memory_source_access_events
        union all
        select case when not json_valid(source_ref_json)
                          or (candidate_json is not null and not json_valid(candidate_json))
                          or (resolution_json is not null and not json_valid(resolution_json))
                         then 1 else 0 end from memory_publication_proposals
        union all
        select case when not json_valid(source_ref_json) or not json_valid(destination_ref_json)
                         then 1 else 0 end from memory_publication_links
    )
"#;
