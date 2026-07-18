use local_first_memory::{MemoryFacade, SQLiteMemoryStore, UserId, WorkspaceId};
use rusqlite::Connection;

#[test]
fn audit_counts_corruption_without_returning_user_content() {
    let db_path = temp_db("corruption");
    let store = SQLiteMemoryStore::open(&db_path).unwrap();
    seed_corruption(&db_path);
    let facade = MemoryFacade::new(store);
    let known_scopes = vec![
        (UserId::new("local-user"), WorkspaceId::new("project-a")),
        (UserId::new("local-user"), WorkspaceId::new("source-a")),
        (UserId::new("local-user"), WorkspaceId::new("source-b")),
    ];

    let report = facade.audit_integrity(&known_scopes).unwrap();

    assert!(report.integrity_ok);
    assert_eq!(report.foreign_key_violations, 1);
    assert_eq!(report.graphify_relation_duplicate_extras, 1);
    assert_eq!(report.dangling_relations, 1);
    assert_eq!(report.orphan_embeddings, 1);
    assert_eq!(report.orphan_evidence_links, 1);
    assert_eq!(report.memories_missing_fts, 5);
    assert_eq!(report.stale_fts_rows, 1);
    assert_eq!(report.missing_wiki_links, 1);
    assert_eq!(report.canonical_entity_duplicate_extras, 1);
    assert_eq!(report.active_memory_duplicate_extras, 1);
    assert_eq!(report.unknown_scope_rows, 1);
    assert_eq!(report.invalid_json_rows, 1);
    assert_eq!(report.active_source_grants, 1);
    assert_eq!(report.expired_but_active_grants, 1);
    assert_eq!(report.revoked_grant_inconsistencies, 1);
    assert_eq!(report.orphan_grant_children, 1);
    assert!(!report.checksum.is_empty());

    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("PRIVATE_SENTINEL"));
    assert!(!encoded.contains("memory-known-a"));
    assert!(!encoded.contains("entity-known-a"));

    drop(facade);
    remove_db(&db_path);
}

#[test]
fn audit_checksum_is_stable_when_only_generation_time_changes() {
    let db_path = temp_db("checksum");
    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&db_path).unwrap());
    let known_scopes = vec![(UserId::new("local-user"), WorkspaceId::new("project-a"))];

    let first = facade.audit_integrity(&known_scopes).unwrap();
    let second = facade.audit_integrity(&known_scopes).unwrap();

    assert_eq!(first.checksum, second.checksum);
    drop(facade);
    remove_db(&db_path);
}

fn seed_corruption(path: &std::path::Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .unwrap();
    connection
        .execute_batch(
            r#"
            drop index idx_entities_canonical;

            insert into memories
              (ref,user_id,workspace_id,memory_type,text,aliases_json,language_hints_json,
               confidence,status,privacy_domain,sensitivity,metadata_json,created_at,updated_at,
               supersedes_json)
            values
              ('memory-known-a','local-user','project-a','fact','PRIVATE_SENTINEL','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory-known-b','local-user','project-a','fact','  private_sentinel  ','[]','[]',1.0,
               'candidate','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory-known-c','local-user','project-a','fact','other','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory-known-d','local-user','project-a','fact','fourth','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory-unknown','local-user','unknown-project','fact','unknown','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]');

            insert into memory_search_fts (ref,user_id,workspace_id,text,aliases)
              values ('stale-fts','local-user','project-a','stale','');
            insert into memory_embeddings (ref,user_id,workspace_id,model,dim,vector)
              values ('orphan-embedding','local-user','project-a','test',1,x'00000000');

            insert into entities values
              ('entity-known-a','local-user','project-a','symbol','PRIVATE_SENTINEL','same-key','[]',
               'personal','internal','{"adapter":"graphify"}'),
              ('entity-known-b','local-user','project-a','symbol','duplicate','same-key','[]',
               'personal','internal','{"adapter":"graphify"}');

            insert into relations values
              ('relation-graph-a','local-user','project-a','entity-known-a','calls','entity-known-b',
               1.0,'personal','internal','[]','{"adapter":"graphify"}'),
              ('relation-graph-b','local-user','project-a','entity-known-a','calls','entity-known-b',
               1.0,'personal','internal','[]','{"adapter":"graphify"}'),
              ('relation-dangling','local-user','project-a','entity-known-a','calls','missing-target',
               1.0,'personal','internal','[]','{}');

            insert into memory_evidence values
              ('memory-known-a','missing-event','PRIVATE_SENTINEL');
            insert into wiki_pages values
              ('wiki-known','local-user','project-a','private.md','PRIVATE_SENTINEL','PRIVATE_SENTINEL',
               '["missing-wiki-target"]','personal','internal');
            insert into routines values
              ('routine-invalid-json','local-user','project-a','PRIVATE_SENTINEL','private',1.0,'active',
               'null','personal','internal','[]','{invalid','unix:1','unix:1');

            insert into memory_source_grants values
              ('grant-expired','local-user','project-a','local-user','source-a','internal',1,null,
               1,'test','unix:1','unix:1'),
              ('grant-revoked','local-user','project-a','local-user','source-b','internal',null,10,
               2,'test','unix:1','unix:1');
            insert into memory_source_access_events values
              ('access-after-revoke','local-user','project-a','source-b','grant-revoked',2,null,'allow',
               'allowed',0,'[]',11);
            insert into memory_source_grant_collections values ('missing-grant','knowledge');
            "#,
        )
        .unwrap();
}

fn temp_db(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "memory-integrity-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

fn remove_db(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}
