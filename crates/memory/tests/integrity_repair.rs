use local_first_memory::{
    MemoryError, MemoryFacade, MemoryIntegrityRepairRequest, MemoryRepairAction, SQLiteMemoryStore,
    UserId, WorkspaceId,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};

#[test]
fn repair_preview_never_mutates_and_binds_actions_to_audit_checksum() {
    let db_path = temp_db("preview");
    let facade = seeded_facade(&db_path);
    let known = known_scopes();
    let before = file_hash(&db_path);

    let preview = facade
        .preview_integrity_repair(&known, requested_actions())
        .unwrap();

    assert_eq!(file_hash(&db_path), before);
    assert!(!preview.approval_token.is_empty());
    assert_eq!(
        preview.audit_checksum,
        facade.audit_integrity(&known).unwrap().checksum
    );
    assert_eq!(preview.estimates.len(), preview.actions.len());
    drop(facade);
    remove_db(&db_path);
}

#[test]
fn repair_refuses_stale_token_and_missing_backup() {
    let db_path = temp_db("refuse");
    let facade = seeded_facade(&db_path);
    let known = known_scopes();
    let preview = facade
        .preview_integrity_repair(&known, requested_actions())
        .unwrap();

    let missing_backup = MemoryIntegrityRepairRequest {
        audit_checksum: preview.audit_checksum.clone(),
        actions: preview.actions.clone(),
        approval_token: preview.approval_token.clone(),
        backup_path: None,
    };
    assert!(matches!(
        facade.apply_integrity_repair(&known, missing_backup),
        Err(MemoryError::Policy(_))
    ));

    let backup_path = temp_db("stale-backup");
    let stale = MemoryIntegrityRepairRequest {
        audit_checksum: preview.audit_checksum,
        actions: preview.actions,
        approval_token: "stale-token".to_string(),
        backup_path: Some(backup_path.clone()),
    };
    assert!(matches!(
        facade.apply_integrity_repair(&known, stale),
        Err(MemoryError::Policy(_))
    ));
    assert!(!backup_path.exists());

    drop(facade);
    remove_db(&db_path);
}

#[test]
fn approved_repair_backs_up_then_fixes_only_structural_actions() {
    let db_path = temp_db("apply");
    let backup_path = temp_db("apply-backup");
    let facade = seeded_facade(&db_path);
    let known = known_scopes();
    let before = facade.audit_integrity(&known).unwrap();
    assert_eq!(before.active_memory_duplicate_extras, 1);
    let preview = facade
        .preview_integrity_repair(&known, requested_actions())
        .unwrap();
    let result = facade
        .apply_integrity_repair(
            &known,
            MemoryIntegrityRepairRequest {
                audit_checksum: preview.audit_checksum,
                actions: preview.actions,
                approval_token: preview.approval_token,
                backup_path: Some(backup_path.clone()),
            },
        )
        .unwrap();

    assert!(backup_path.is_file());
    assert!(result.backup.bytes_copied > 0);
    assert_eq!(result.before.checksum, before.checksum);
    assert_eq!(result.after.graphify_relation_duplicate_extras, 0);
    assert_eq!(result.after.orphan_embeddings, 0);
    assert_eq!(result.after.orphan_evidence_links, 0);
    assert_eq!(result.after.missing_wiki_links, 0);
    assert_eq!(result.after.memories_missing_fts, 0);
    assert_eq!(result.after.stale_fts_rows, 0);
    assert_eq!(result.after.unknown_scope_rows, 0);
    assert_eq!(result.after.active_memory_duplicate_extras, 1);

    let backup = Connection::open(&backup_path).unwrap();
    assert_eq!(
        backup
            .query_row("select count(*) from relations", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        backup
            .query_row(
                "select count(*) from memories where workspace_id = 'unknown-project'",
                [],
                |row| row.get::<_, u64>(0),
            )
            .unwrap(),
        1
    );

    drop(backup);
    drop(facade);
    remove_db(&db_path);
    remove_db(&backup_path);
}

#[test]
fn repair_actions_roll_back_together_when_a_later_action_fails() {
    let db_path = temp_db("rollback");
    let backup_path = temp_db("rollback-backup");
    let facade = seeded_facade(&db_path);
    let known = known_scopes();
    let actions = vec![
        MemoryRepairAction::RemoveOrphanEmbeddings,
        MemoryRepairAction::RemoveOrphanEvidenceLinks,
    ];
    let preview = facade.preview_integrity_repair(&known, actions).unwrap();
    Connection::open(&db_path)
        .unwrap()
        .execute_batch(
            "create trigger fail_evidence_repair before delete on memory_evidence
             begin select raise(abort, 'forced repair failure'); end;",
        )
        .unwrap();

    let result = facade.apply_integrity_repair(
        &known,
        MemoryIntegrityRepairRequest {
            audit_checksum: preview.audit_checksum,
            actions: preview.actions,
            approval_token: preview.approval_token,
            backup_path: Some(backup_path.clone()),
        },
    );

    assert!(matches!(result, Err(MemoryError::Store(_))));
    let after = facade.audit_integrity(&known).unwrap();
    assert_eq!(after.orphan_embeddings, 1);
    assert_eq!(after.orphan_evidence_links, 1);
    assert!(backup_path.is_file());

    drop(facade);
    remove_db(&db_path);
    remove_db(&backup_path);
}

fn requested_actions() -> Vec<MemoryRepairAction> {
    vec![
        MemoryRepairAction::RemoveGraphifyDuplicateRelations {
            workspace_id: WorkspaceId::new("project-a"),
        },
        MemoryRepairAction::RemoveOrphanEmbeddings,
        MemoryRepairAction::RemoveOrphanEvidenceLinks,
        MemoryRepairAction::RemoveMissingWikiLinks,
        MemoryRepairAction::RebuildFts,
        MemoryRepairAction::PurgeUnknownWorkspace {
            workspace_id: WorkspaceId::new("unknown-project"),
        },
    ]
}

fn known_scopes() -> Vec<(UserId, WorkspaceId)> {
    vec![(UserId::new("local-user"), WorkspaceId::new("project-a"))]
}

fn seeded_facade(path: &std::path::Path) -> MemoryFacade {
    let store = SQLiteMemoryStore::open(path).unwrap();
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            r#"
            insert into memories
              (ref,user_id,workspace_id,memory_type,text,aliases_json,language_hints_json,
               confidence,status,privacy_domain,sensitivity,metadata_json,created_at,updated_at,
               supersedes_json)
            values
              ('memory:local:local-user:project-a:a','local-user','project-a','fact','same private fact','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory:local:local-user:project-a:b','local-user','project-a','fact',' SAME PRIVATE FACT ','[]','[]',1.0,
               'candidate','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory:local:local-user:unknown-project:a','local-user','unknown-project','fact','unknown','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]');
            insert into memory_search_fts (ref,user_id,workspace_id,text,aliases)
              values ('stale-fts','local-user','project-a','stale','');
            insert into memory_embeddings (ref,user_id,workspace_id,model,dim,vector)
              values ('orphan-embedding','local-user','project-a','test',1,x'00000000');
            insert into entities values
              ('entity-a','local-user','project-a','symbol','A','a','[]','personal','internal',
               '{"adapter":"graphify"}'),
              ('entity-b','local-user','project-a','symbol','B','b','[]','personal','internal',
               '{"adapter":"graphify"}');
            insert into relations values
              ('relation-z','local-user','project-a','entity-a','calls','entity-b',1.0,
               'personal','internal','[]','{"adapter":"graphify"}'),
              ('relation-a','local-user','project-a','entity-a','calls','entity-b',1.0,
               'personal','internal','[]','{"adapter":"graphify"}');
            insert into memory_evidence values
              ('memory:local:local-user:project-a:a','event:local:local-user:project-a:missing','private note');
            insert into wiki_pages values
              ('wiki-a','local-user','project-a','project.md','Project','body',
               '["memory:local:local-user:project-a:a","memory:local:local-user:project-a:missing"]',
               'personal','internal');
            "#,
        )
        .unwrap();
    drop(connection);
    MemoryFacade::new(store)
}

fn file_hash(path: &std::path::Path) -> String {
    let digest = Sha256::digest(std::fs::read(path).unwrap());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn temp_db(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "memory-repair-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

fn remove_db(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}
