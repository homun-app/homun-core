use local_first_memory::{SQLiteMemoryStore, UserId, WorkspaceId};
use rusqlite::Connection;

#[test]
fn purge_workspace_removes_every_owned_or_cross_scope_row() {
    let db_path = temp_db("complete");
    let store = SQLiteMemoryStore::open(&db_path).unwrap();
    seed_all_scope_tables(&db_path);

    let report = store
        .purge_workspace(
            &UserId::new("local-user"),
            &WorkspaceId::new("deleted-project"),
        )
        .unwrap();

    assert!(report.total_deleted >= 18);
    assert_eq!(report.workspace_id, "deleted-project");
    assert_scope_absent(&db_path, "deleted-project");
    assert_eq!(
        count_where(
            &db_path,
            "memories",
            "user_id = 'local-user' and workspace_id = 'kept-project'"
        ),
        1
    );
    drop(store);
    remove_db(&db_path);
}

#[test]
fn purge_workspace_rolls_back_every_table_on_failure() {
    let db_path = temp_db("rollback");
    let store = SQLiteMemoryStore::open(&db_path).unwrap();
    seed_all_scope_tables(&db_path);
    let connection = Connection::open(&db_path).unwrap();
    connection
        .execute_batch(
            "create trigger fail_event_delete before delete on memory_events
             when old.workspace_id = 'deleted-project'
             begin select raise(abort, 'forced purge failure'); end;",
        )
        .unwrap();
    let before = count_scope_rows(&db_path, "deleted-project");

    let result = store.purge_workspace(
        &UserId::new("local-user"),
        &WorkspaceId::new("deleted-project"),
    );

    assert!(result.is_err());
    assert_eq!(count_scope_rows(&db_path, "deleted-project"), before);
    drop(connection);
    drop(store);
    remove_db(&db_path);
}

fn seed_all_scope_tables(path: &std::path::Path) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            r#"
            insert into memory_events values
              ('event-del','local-user','deleted-project','unix:1','test','fact','{}','personal','internal');
            insert into memories
              (ref,user_id,workspace_id,memory_type,text,aliases_json,language_hints_json,
               confidence,status,privacy_domain,sensitivity,metadata_json,created_at,updated_at,
               supersedes_json)
            values
              ('memory-del','local-user','deleted-project','fact','delete me','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]'),
              ('memory-keep','local-user','kept-project','fact','keep me','[]','[]',1.0,
               'confirmed','personal','internal','{}','unix:1','unix:1','[]');
            insert into memory_embeddings (ref,user_id,workspace_id,model,dim,vector)
              values ('memory-del','local-user','deleted-project','test',1,x'00000000');
            insert into memory_search_fts (ref,user_id,workspace_id,text,aliases)
              values ('memory-del','local-user','deleted-project','delete me',''),
                     ('memory-keep','local-user','kept-project','keep me','');
            insert into entities values
              ('entity-del','local-user','deleted-project','person','Delete','delete','[]','personal','internal','{}');
            insert into relations values
              ('relation-del','local-user','deleted-project','memory-del','mentions','entity-del',1.0,
               'personal','internal','[]','{}');
            insert into memory_evidence values ('memory-del','event-del','evidence');
            insert into wiki_pages values
              ('wiki-del','local-user','deleted-project','delete.md','Delete','body','["memory-del"]',
               'personal','internal');
            insert into routines values
              ('routine-del','local-user','deleted-project','Delete','delete',1.0,'active','null',
               'personal','internal','[]','{}','unix:1','unix:1');
            insert into automation_candidates values
              ('automation-del','local-user','deleted-project','routine-del','Delete','delete','manual',
               '[]','low',0,'candidate','personal','internal','[]','{}','unix:1','unix:1');
            insert into access_audit
              (ref,user_id,workspace_id,actor_id,purpose,decision,reasons_json)
              values ('audit-del','local-user','deleted-project','test','test','allow','[]');
            insert into tombstones (ref,user_id,workspace_id,reason)
              values ('tombstone-del','local-user','deleted-project','test');
            insert into memory_source_grants values
              ('grant-del','local-user','kept-project','local-user','deleted-project','internal',null,null,
               1,'test','unix:1','unix:1');
            insert into memory_source_grant_collections values ('grant-del','knowledge');
            insert into memory_source_grant_overrides values ('grant-del','memory-del','allow');
            insert into memory_source_access_events values
              ('access-del','local-user','kept-project','deleted-project','grant-del',1,null,'allow',
               'allowed',1,'[]',1);
            insert into memory_publication_proposals
              (id,source_ref_json,source_user_id,source_workspace_id,destination_user_id,
               destination_workspace_id,proposed_text,proposed_memory_type,proposed_collection,
               proposed_privacy_domain,proposed_sensitivity,status,reason_code,proposed_by,
               created_at,updated_at)
              values ('proposal-del','{"workspace_id":"deleted-project"}','local-user','deleted-project',
               'local-user','kept-project','safe','fact','knowledge','personal','internal','pending',
               'pending','test','unix:1','unix:1');
            insert into memory_publication_links values
              ('{"workspace_id":"deleted-project","local_id":"source"}',
               '{"workspace_id":"kept-project","local_id":"destination"}','test','unix:1');
            "#,
        )
        .unwrap();
}

fn assert_scope_absent(path: &std::path::Path, workspace: &str) {
    for (table, predicate) in [
        ("memory_events", "workspace_id"),
        ("memories", "workspace_id"),
        ("memory_embeddings", "workspace_id"),
        ("memory_search_fts", "workspace_id"),
        ("entities", "workspace_id"),
        ("relations", "workspace_id"),
        ("wiki_pages", "workspace_id"),
        ("routines", "workspace_id"),
        ("automation_candidates", "workspace_id"),
        ("access_audit", "workspace_id"),
        ("tombstones", "workspace_id"),
    ] {
        assert_eq!(
            count_where(path, table, &format!("{predicate} = '{workspace}'")),
            0,
            "scope remains in {table}"
        );
    }
    for table in [
        "memory_evidence",
        "memory_source_grants",
        "memory_source_grant_collections",
        "memory_source_grant_overrides",
        "memory_source_access_events",
        "memory_publication_proposals",
        "memory_publication_links",
    ] {
        assert_eq!(
            count_where(path, table, "1 = 1"),
            0,
            "row remains in {table}"
        );
    }
}

fn count_scope_rows(path: &std::path::Path, workspace: &str) -> i64 {
    [
        "memory_events",
        "memories",
        "memory_embeddings",
        "entities",
        "relations",
        "wiki_pages",
        "routines",
        "automation_candidates",
        "access_audit",
        "tombstones",
    ]
    .into_iter()
    .map(|table| count_where(path, table, &format!("workspace_id = '{workspace}'")))
    .sum()
}

fn count_where(path: &std::path::Path, table: &str, predicate: &str) -> i64 {
    Connection::open(path)
        .unwrap()
        .query_row(
            &format!("select count(*) from {table} where {predicate}"),
            [],
            |row| row.get(0),
        )
        .unwrap()
}

fn temp_db(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "memory-purge-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

fn remove_db(path: &std::path::Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
    let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
}
