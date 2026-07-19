use local_first_memory::{
    AuthorizedMemorySource, DataSensitivity, MemoryCollectionKey, MemoryEvidence, MemoryFacade,
    MemoryPublicationCandidate, MemoryPublicationDestination, MemoryPublicationEditInput,
    MemoryPublicationLink, MemoryPublicationProposal, MemoryPublicationReasonCode,
    MemoryPublicationResolution, MemoryPublicationStatus, MemoryPublicationStoreError,
    MemoryRecord, MemoryRef, MemoryRefKind, MemorySourceGrant, MemoryStatus, PrivacyDomain,
    SQLiteMemoryStore, UserId, WorkspaceId, recall_source_on_facade,
};
use rusqlite::Connection;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};

const OWNER: &str = "owner";
const PROJECT: &str = "project-a";

struct PublicationFixture {
    facade: MemoryFacade,
    owner: UserId,
    project: WorkspaceId,
}

impl PublicationFixture {
    fn new() -> Self {
        Self {
            facade: MemoryFacade::new(SQLiteMemoryStore::open_in_memory().unwrap()),
            owner: UserId::new(OWNER),
            project: WorkspaceId::new(PROJECT),
        }
    }

    fn project_destination(&self) -> MemoryPublicationDestination {
        MemoryPublicationDestination::new(self.owner.clone(), self.project.clone())
    }

    fn personal_destination(&self) -> MemoryPublicationDestination {
        MemoryPublicationDestination::personal(self.owner.clone())
    }

    fn insert_source_preference(&self, text: &str) -> MemoryRecord {
        let record = memory(&self.owner, &self.project, "preference", text);
        self.facade.upsert_memory(&record).unwrap();
        record
    }

    fn get_source(&self, reference: &MemoryRef) -> MemoryRecord {
        self.facade
            .get_memory_for_ui(reference, &self.owner, &self.project)
            .unwrap()
            .unwrap()
    }

    fn personal_memories(&self) -> Vec<MemoryRecord> {
        self.facade
            .list_memories_for_ui(&self.owner, &WorkspaceId::new("__personal__"))
            .unwrap()
    }
}

fn memory(user: &UserId, workspace: &WorkspaceId, kind: &str, text: &str) -> MemoryRecord {
    MemoryRecord {
        reference: MemoryRef::generated(MemoryRefKind::Memory, user.clone(), workspace.clone()),
        user_id: user.clone(),
        workspace_id: workspace.clone(),
        memory_type: kind.to_string(),
        text: text.to_string(),
        aliases: vec!["Italian preference".to_string()],
        language_hints: vec!["it".to_string()],
        confidence: 0.9,
        status: MemoryStatus::Confirmed,
        privacy_domain: PrivacyDomain::new("personal"),
        sensitivity: DataSensitivity::Private,
        metadata: serde_json::json!({"subject": "style"}),
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
        last_seen_at: None,
        supersedes: vec![],
        superseded_by: None,
        correction_of: None,
    }
}

fn choose_create_new(facade: &MemoryFacade, proposal_id: &str) {
    let proposal = facade
        .get_publication_proposal(proposal_id)
        .unwrap()
        .unwrap();
    facade
        .set_publication_resolution_at_version(
            proposal_id,
            OWNER,
            proposal.proposal_version,
            MemoryPublicationResolution::CreateNew,
        )
        .unwrap();
}

fn publication_version(facade: &MemoryFacade, proposal_id: &str) -> u64 {
    facade
        .get_publication_proposal(proposal_id)
        .unwrap()
        .unwrap()
        .proposal_version
}

#[test]
fn historical_source_grant_link_permanently_blocks_copy_publication() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Linked source must remain read only");
    let consumer = WorkspaceId::new("project-b");
    assert!(!fixture
        .facade
        .has_memory_source_grant_link(&fixture.owner, &consumer, &fixture.project)
        .unwrap());
    fixture
        .facade
        .upsert_memory_source_grant(&MemorySourceGrant {
            id: "grant-publication-firewall".to_string(),
            consumer_user_id: fixture.owner.clone(),
            consumer_workspace_id: consumer.clone(),
            source_user_id: fixture.owner.clone(),
            source_workspace_id: fixture.project.clone(),
            collections: BTreeSet::from([MemoryCollectionKey::Preferences]),
            max_sensitivity: DataSensitivity::Private,
            overrides: HashMap::new(),
            expires_at: Some(10),
            revoked_at: None,
            policy_version: 1,
            created_by: OWNER.to_string(),
            created_at: "unix:1".to_string(),
            updated_at: "unix:1".to_string(),
        })
        .unwrap();
    assert!(fixture
        .facade
        .has_memory_source_grant_link(&fixture.owner, &consumer, &fixture.project)
        .unwrap());
    fixture
        .facade
        .revoke_memory_source_grant(
            &fixture.owner,
            &consumer,
            "grant-publication-firewall",
            11,
        )
        .unwrap();
    assert!(fixture
        .facade
        .has_memory_source_grant_link(&fixture.owner, &consumer, &fixture.project)
        .unwrap());

    let error = fixture
        .facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::new(fixture.owner.clone(), consumer),
            OWNER,
        )
        .unwrap_err();
    assert_eq!(error.as_str(), "linked_memory_read_only");
}

#[test]
fn publication_between_never_linked_scopes_remains_allowed() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Local publication remains supported");
    let destination = MemoryPublicationDestination::new(
        fixture.owner.clone(),
        WorkspaceId::new("project-never-linked"),
    );

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &destination, OWNER)
        .unwrap();

    assert_eq!(proposal.source_workspace_id, fixture.project);
    assert_eq!(proposal.destination_workspace_id, destination.workspace_id);
}

#[test]
fn edited_publication_persists_only_validated_safe_payload_and_source_revision() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal_with_edit(
            &source,
            &fixture.personal_destination(),
            OWNER,
            Some(&MemoryPublicationEditInput {
                proposed_text: Some("Prefers concise Italian replies".to_string()),
                proposed_memory_type: Some("preference".to_string()),
                proposed_privacy_domain: Some(PrivacyDomain::new("personal")),
                proposed_sensitivity: Some(DataSensitivity::Private),
            }),
        )
        .unwrap();

    assert_eq!(proposal.proposed_text, "Prefers concise Italian replies");
    assert_eq!(
        proposal.proposed_collection,
        MemoryCollectionKey::Preferences
    );
    assert!(!proposal.source_revision.is_empty());
}

#[test]
fn source_revision_hashes_full_record_and_ordered_evidence() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    let mut changed = fixture.get_source(&source.reference);
    changed.aliases.push("Italian reply preference".to_string());
    changed.language_hints.push("en".to_string());
    changed.confidence = 0.85;
    changed.metadata = serde_json::json!({"subject": "style", "priority": "high"});
    changed.last_seen_at = Some("unix:2.000000000".to_string());
    changed.updated_at = "unix:2.000000000".to_string();
    fixture.facade.upsert_memory(&changed).unwrap();
    fixture
        .facade
        .link_evidence(&MemoryEvidence {
            memory_ref: source.reference.clone(),
            evidence_ref: MemoryRef::generated(
                MemoryRefKind::Memory,
                fixture.owner.clone(),
                fixture.project.clone(),
            ),
            note: "Captured after preview".to_string(),
        })
        .unwrap();

    assert_eq!(
        fixture
            .facade
            .update_publication_proposal_at_version(
                &proposal.id,
                OWNER,
                proposal.proposal_version,
                &MemoryPublicationEditInput {
                    proposed_text: Some("Prefers concise Italian replies".to_string()),
                    proposed_memory_type: None,
                    proposed_privacy_domain: None,
                    proposed_sensitivity: None,
                },
            )
            .unwrap_err()
            .as_str(),
        "publication_source_changed"
    );
}

#[test]
fn server_first_proposal_keeps_source_values_and_pending_edit_revalidates_them() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    // A no-op preview must be the exact persisted source, not a client-side
    // default such as a note or a public/general memory.
    assert_eq!(proposal.proposed_text, source.text);
    assert_eq!(proposal.proposed_memory_type, "preference");
    assert_eq!(
        proposal.proposed_privacy_domain,
        PrivacyDomain::new("personal")
    );
    assert_eq!(proposal.proposed_sensitivity, DataSensitivity::Private);
    choose_create_new(&fixture.facade, &proposal.id);

    let updated = fixture
        .facade
        .update_publication_proposal_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
            &MemoryPublicationEditInput {
                proposed_text: Some("Prefers concise Italian replies".to_string()),
                proposed_memory_type: Some("note".to_string()),
                proposed_privacy_domain: Some(PrivacyDomain::new("work")),
                proposed_sensitivity: Some(DataSensitivity::Private),
            },
        )
        .unwrap();

    assert_eq!(updated.proposed_memory_type, "note");
    assert_eq!(updated.proposed_privacy_domain, PrivacyDomain::new("work"));
    assert_eq!(updated.proposed_collection, MemoryCollectionKey::Knowledge);
    assert!(updated.resolution.is_none());
    assert_eq!(updated.status, MemoryPublicationStatus::Pending);
}

#[test]
fn reopening_a_pending_publication_returns_the_same_server_preview() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let first = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let reopened = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    assert_eq!(reopened.id, first.id);
    assert_eq!(reopened.proposal_version, first.proposal_version);
    assert_eq!(reopened, first);
}

#[test]
fn reopening_a_pending_publication_preserves_its_reviewed_payload() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let first = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let edited = fixture
        .facade
        .update_publication_proposal_at_version(
            &first.id,
            OWNER,
            first.proposal_version,
            &MemoryPublicationEditInput {
                proposed_text: Some("Prefers concise Italian replies".to_string()),
                proposed_memory_type: Some("note".to_string()),
                proposed_privacy_domain: Some(PrivacyDomain::new("work")),
                proposed_sensitivity: Some(DataSensitivity::Private),
            },
        )
        .unwrap();
    let reopened = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    assert_eq!(reopened.id, first.id);
    assert_eq!(reopened.proposal_version, edited.proposal_version);
    assert_eq!(reopened.proposed_text, edited.proposed_text);
    assert_eq!(reopened.proposed_memory_type, edited.proposed_memory_type);
    assert_eq!(
        reopened.proposed_privacy_domain,
        edited.proposed_privacy_domain
    );
}

#[test]
fn reopening_after_source_change_fails_stale_pending_and_creates_a_fresh_preview() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let first = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let mut changed = fixture.get_source(&source.reference);
    changed.text = "Prefers concise Italian replies".to_string();
    changed.updated_at = "unix:2.000000000".to_string();
    fixture.facade.upsert_memory(&changed).unwrap();

    let fresh = fixture
        .facade
        .create_publication_proposal(&changed, &fixture.personal_destination(), OWNER)
        .unwrap();
    let stale = fixture
        .facade
        .get_publication_proposal(&first.id)
        .unwrap()
        .unwrap();

    assert_ne!(fresh.id, first.id);
    assert_eq!(fresh.proposed_text, changed.text);
    assert_eq!(stale.status, MemoryPublicationStatus::Failed);
    assert_eq!(
        stale.failure_reason.as_deref(),
        Some("publication_source_changed")
    );
}

#[test]
fn reopening_rebases_same_pending_preview_when_destination_gains_a_duplicate() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let first = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let duplicate = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    fixture.facade.upsert_memory(&duplicate).unwrap();

    let rebased = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(rebased.id, first.id);
    assert_eq!(rebased.proposal_version, first.proposal_version + 1);
    assert_eq!(rebased.resolution, None);
    assert_eq!(
        rebased.candidate,
        Some(MemoryPublicationCandidate::CompatibleDuplicate {
            destination_ref: duplicate.reference,
        })
    );
}

#[test]
fn reopening_rebases_when_the_previous_destination_candidate_disappears() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let duplicate = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    fixture.facade.upsert_memory(&duplicate).unwrap();
    let first = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert!(first.candidate.is_some());
    fixture
        .facade
        .tombstone_ref(
            &duplicate.reference,
            &fixture.owner,
            &WorkspaceId::new("__personal__"),
            "removed while closed",
        )
        .unwrap();

    let rebased = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(rebased.id, first.id);
    assert_eq!(rebased.proposal_version, first.proposal_version + 1);
    assert_eq!(rebased.candidate, None);
}

#[test]
fn destination_drift_rebases_resolution_then_requires_the_new_preview_version() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let duplicate = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    fixture.facade.upsert_memory(&duplicate).unwrap();

    assert_eq!(
        fixture
            .facade
            .set_publication_resolution_at_version(
                &proposal.id,
                OWNER,
                proposal.proposal_version,
                MemoryPublicationResolution::CreateNew,
            )
            .unwrap_err()
            .as_str(),
        "publication_preview_stale"
    );
    let rebased = fixture
        .facade
        .get_publication_proposal(&proposal.id)
        .unwrap()
        .unwrap();
    assert_eq!(rebased.proposal_version, proposal.proposal_version + 1);
    assert_eq!(rebased.resolution, None);
    fixture
        .facade
        .set_publication_resolution_at_version(
            &rebased.id,
            OWNER,
            rebased.proposal_version,
            MemoryPublicationResolution::UpdateExisting {
                destination_ref: duplicate.reference,
            },
        )
        .unwrap();
}

#[test]
fn concurrent_reopens_converge_on_one_destination_rebase() {
    let facade = Arc::new(MemoryFacade::new(
        SQLiteMemoryStore::open_in_memory().unwrap(),
    ));
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let first = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    let duplicate = memory(
        &owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    facade.upsert_memory(&duplicate).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let facade = Arc::clone(&facade);
        let barrier = Arc::clone(&barrier);
        let source = source.clone();
        let owner = owner.clone();
        joins.push(std::thread::spawn(move || {
            barrier.wait();
            facade.create_publication_proposal(
                &source,
                &MemoryPublicationDestination::personal(owner),
                OWNER,
            )
        }));
    }
    barrier.wait();
    let proposals = joins
        .into_iter()
        .map(|join| join.join().unwrap().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(proposals[0].id, first.id);
    assert_eq!(proposals[0].id, proposals[1].id);
    assert_eq!(proposals[0].proposal_version, first.proposal_version + 1);
    assert_eq!(proposals[0].proposal_version, proposals[1].proposal_version);
}

#[test]
fn legacy_pending_destination_revision_is_rebased_before_resume() {
    let path = unique_db_path("destination-revision-v6");
    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let proposal = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    Connection::open(&path)
        .unwrap()
        .execute(
            "update memory_publication_proposals
             set destination_revision = 'legacy_unverifiable'
             where id = ?1",
            [&proposal.id],
        )
        .unwrap();

    let resumed = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner),
            OWNER,
        )
        .unwrap();
    assert_eq!(resumed.id, proposal.id);
    assert_eq!(resumed.proposal_version, proposal.proposal_version + 1);
    assert_ne!(resumed.destination_revision, "legacy_unverifiable");
    drop(facade);
    remove_sqlite_files(&path);
}

#[test]
fn concurrent_server_first_creates_resume_one_pending_preview() {
    let facade = Arc::new(MemoryFacade::new(
        SQLiteMemoryStore::open_in_memory().unwrap(),
    ));
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let mut joins = Vec::new();
    for _ in 0..2 {
        let facade = Arc::clone(&facade);
        let barrier = Arc::clone(&barrier);
        let source = source.clone();
        let owner = owner.clone();
        joins.push(std::thread::spawn(move || {
            barrier.wait();
            facade.create_publication_proposal(
                &source,
                &MemoryPublicationDestination::personal(owner),
                OWNER,
            )
        }));
    }
    barrier.wait();
    let proposals = joins
        .into_iter()
        .map(|join| join.join().unwrap().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(proposals[0].id, proposals[1].id);
    assert_eq!(proposals[0].proposal_version, proposals[1].proposal_version);
    assert_eq!(proposals[0].status, MemoryPublicationStatus::Pending);
}

#[test]
fn stale_preview_versions_cannot_edit_reject_or_approve_after_a_newer_review() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let preview_a = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(preview_a.proposal_version, 1);

    let preview_b = fixture
        .facade
        .update_publication_proposal_at_version(
            &preview_a.id,
            OWNER,
            preview_a.proposal_version,
            &MemoryPublicationEditInput {
                proposed_text: Some("Prefers concise Italian replies".to_string()),
                proposed_memory_type: None,
                proposed_privacy_domain: None,
                proposed_sensitivity: None,
            },
        )
        .unwrap();
    assert_eq!(preview_b.proposal_version, 2);

    for stale in [
        fixture.facade.update_publication_proposal_at_version(
            &preview_a.id,
            OWNER,
            preview_a.proposal_version,
            &MemoryPublicationEditInput {
                proposed_text: Some("stale overwrite".to_string()),
                proposed_memory_type: None,
                proposed_privacy_domain: None,
                proposed_sensitivity: None,
            },
        ),
        fixture.facade.reject_publication_at_version(
            &preview_a.id,
            OWNER,
            preview_a.proposal_version,
        ),
    ] {
        assert_eq!(stale.unwrap_err().as_str(), "publication_conflict");
    }
    assert_eq!(
        fixture
            .facade
            .set_publication_resolution_at_version(
                &preview_a.id,
                OWNER,
                preview_a.proposal_version,
                MemoryPublicationResolution::CreateNew,
            )
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    assert!(fixture.personal_memories().is_empty());

    let reviewed = fixture
        .facade
        .set_publication_resolution_at_version(
            &preview_b.id,
            OWNER,
            preview_b.proposal_version,
            MemoryPublicationResolution::CreateNew,
        )
        .unwrap();
    assert_eq!(reviewed.proposal_version, 3);
    let approved = fixture
        .facade
        .approve_publication_at_version(&reviewed.id, OWNER, reviewed.proposal_version)
        .unwrap();
    assert_eq!(approved.proposal.status, MemoryPublicationStatus::Approved);
    assert_eq!(approved.proposal.proposal_version, 4);
}

#[test]
fn concurrent_edit_and_approve_accept_exactly_one_preview_version() {
    let facade = Arc::new(MemoryFacade::new(
        SQLiteMemoryStore::open_in_memory().unwrap(),
    ));
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let proposal = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    choose_create_new(&facade, &proposal.id);
    let version = publication_version(&facade, &proposal.id);
    let barrier = Arc::new(Barrier::new(3));

    let approve_facade = Arc::clone(&facade);
    let approve_id = proposal.id.clone();
    let approve_barrier = Arc::clone(&barrier);
    let approve = std::thread::spawn(move || {
        approve_barrier.wait();
        approve_facade.approve_publication_at_version(&approve_id, OWNER, version)
    });
    let edit_facade = Arc::clone(&facade);
    let edit_id = proposal.id.clone();
    let edit_barrier = Arc::clone(&barrier);
    let edit = std::thread::spawn(move || {
        edit_barrier.wait();
        edit_facade.update_publication_proposal_at_version(
            &edit_id,
            OWNER,
            version,
            &MemoryPublicationEditInput {
                proposed_text: Some("Prefers concise Italian replies".to_string()),
                proposed_memory_type: None,
                proposed_privacy_domain: None,
                proposed_sensitivity: None,
            },
        )
    });
    barrier.wait();
    let approve = approve.join().unwrap();
    let edit = edit.join().unwrap();
    assert_eq!(usize::from(approve.is_ok()) + usize::from(edit.is_ok()), 1);

    let personal = facade
        .list_memories_for_ui(&owner, &WorkspaceId::new("__personal__"))
        .unwrap();
    if approve.is_ok() {
        assert_eq!(personal.len(), 1);
        assert!(edit.is_err());
    } else {
        assert!(personal.is_empty());
        assert!(approve.is_err());
        let current = facade
            .get_publication_proposal(&proposal.id)
            .unwrap()
            .unwrap();
        assert_eq!(current.status, MemoryPublicationStatus::Pending);
        assert_eq!(current.proposal_version, version + 1);
    }
}

#[test]
fn edited_publication_rejects_secret_payload_and_stale_source_before_writing() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let secret = fixture.facade.create_publication_proposal_with_edit(
        &source,
        &fixture.personal_destination(),
        OWNER,
        Some(&MemoryPublicationEditInput {
            proposed_text: Some("api_key=super-secret-value".to_string()),
            proposed_memory_type: None,
            proposed_privacy_domain: None,
            proposed_sensitivity: None,
        }),
    );
    assert_eq!(secret.unwrap_err().as_str(), "secret_never_shareable");

    let proposal = fixture
        .facade
        .create_publication_proposal_with_edit(
            &source,
            &fixture.personal_destination(),
            OWNER,
            Some(&MemoryPublicationEditInput {
                proposed_text: Some("Edited, but reviewed".to_string()),
                proposed_memory_type: None,
                proposed_privacy_domain: None,
                proposed_sensitivity: None,
            }),
        )
        .unwrap();
    let mut changed = fixture.get_source(&source.reference);
    changed.text = "Changed after preview".to_string();
    changed.updated_at = "unix:2.000000000".to_string();
    fixture.facade.upsert_memory(&changed).unwrap();
    choose_create_new(&fixture.facade, &proposal.id);

    assert_eq!(
        fixture
            .facade
            .approve_publication_at_version(
                &proposal.id,
                OWNER,
                publication_version(&fixture.facade, &proposal.id)
            )
            .unwrap_err()
            .as_str(),
        "publication_source_changed"
    );
    assert!(fixture.personal_memories().is_empty());
}

#[test]
fn approved_publication_creates_destination_and_marks_source_alias_atomically() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    choose_create_new(&fixture.facade, &proposal.id);
    let result = fixture
        .facade
        .approve_publication_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
        )
        .unwrap();

    assert_eq!(result.proposal.status, MemoryPublicationStatus::Approved);
    assert_eq!(result.destination.workspace_id.as_str(), "__personal__");
    assert_eq!(result.destination.text, "Prefers Italian");
    assert_eq!(result.destination.status, MemoryStatus::Confirmed);
    assert_eq!(
        result.destination.metadata["publication"]["source_ref"],
        serde_json::to_value(&source.reference).unwrap()
    );
    assert_eq!(
        result.destination.metadata["publication_source_ref"],
        serde_json::to_value(&source.reference).unwrap()
    );
    assert_eq!(
        fixture.get_source(&source.reference).metadata["published_alias"],
        true
    );
    assert_eq!(
        fixture
            .facade
            .get_publication_link(&source.reference)
            .unwrap()
            .unwrap()
            .destination_ref,
        result.destination.reference
    );
}

#[test]
fn published_destination_exposes_structural_publication_link_to_recall_dedup() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    choose_create_new(&fixture.facade, &proposal.id);
    let result = fixture
        .facade
        .approve_publication_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
        )
        .unwrap();
    let personal = AuthorizedMemorySource {
        source_user_id: fixture.owner.clone(),
        source_workspace_id: WorkspaceId::new("__personal__"),
        source_label: "Personal memory".to_string(),
        grant_id: None,
        policy: None,
        policy_version: 0,
    };
    let pack =
        recall_source_on_facade(&fixture.facade, &personal, "Prefers Italian", &[], None).unwrap();
    let hit = pack
        .hits
        .iter()
        .find(|hit| hit.memory_ref == result.destination.reference.to_string())
        .expect(&format!("missing destination hit: {:?}", pack.hits));
    assert_eq!(
        hit.publication_link,
        Some(serde_json::to_string(&result.destination.reference).unwrap())
    );
}

#[test]
fn rejected_publication_does_not_modify_either_scope() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    choose_create_new(&fixture.facade, &proposal.id);

    let rejected = fixture
        .facade
        .reject_publication_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
        )
        .unwrap();

    assert_eq!(rejected.status, MemoryPublicationStatus::Rejected);
    assert!(fixture.personal_memories().is_empty());
    assert!(
        fixture
            .get_source(&source.reference)
            .metadata
            .get("published_alias")
            .is_none()
    );
}

#[test]
fn published_source_cannot_create_a_second_publication_and_approve_is_idempotent() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    choose_create_new(&fixture.facade, &proposal.id);

    let first = fixture
        .facade
        .approve_publication_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
        )
        .unwrap();
    let repeated = fixture
        .facade
        .approve_publication_at_version(&proposal.id, OWNER, first.proposal.proposal_version)
        .unwrap();
    let duplicate =
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.personal_destination(), OWNER);

    assert_eq!(repeated.destination.reference, first.destination.reference);
    assert_eq!(fixture.personal_memories().len(), 1);
    assert_eq!(
        duplicate.unwrap_err().as_str(),
        "publication_already_published"
    );
}

#[test]
fn compatible_destination_duplicate_is_reused_not_copied() {
    let fixture = PublicationFixture::new();
    let existing = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    fixture.facade.upsert_memory(&existing).unwrap();
    let source = fixture.insert_source_preference("Prefers Italian");

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(
        proposal.reason_code,
        MemoryPublicationReasonCode::PublicationDuplicateCompatible
    );
    assert_eq!(
        fixture
            .facade
            .approve_publication_at_version(
                &proposal.id,
                OWNER,
                publication_version(&fixture.facade, &proposal.id)
            )
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    fixture
        .facade
        .set_publication_resolution_at_version(
            &proposal.id,
            OWNER,
            proposal.proposal_version,
            MemoryPublicationResolution::UpdateExisting {
                destination_ref: existing.reference.clone(),
            },
        )
        .unwrap();

    let result = fixture
        .facade
        .approve_publication_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
        )
        .unwrap();
    assert_eq!(result.destination.reference, existing.reference);
    assert_eq!(fixture.personal_memories().len(), 1);
}

#[test]
fn incompatible_same_subject_requires_explicit_create_new_and_records_conflict() {
    let fixture = PublicationFixture::new();
    let mut existing = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers terse replies",
    );
    existing.metadata = serde_json::json!({"subject_key": "reply_style"});
    fixture.facade.upsert_memory(&existing).unwrap();
    let mut source = fixture.insert_source_preference("Prefers Italian");
    source.metadata = serde_json::json!({"subject_key": "reply_style"});
    fixture.facade.upsert_memory(&source).unwrap();

    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(
        proposal.reason_code,
        MemoryPublicationReasonCode::PublicationConflict
    );
    assert_eq!(
        fixture
            .facade
            .approve_publication_at_version(&proposal.id, OWNER, proposal.proposal_version)
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );

    fixture
        .facade
        .set_publication_resolution_at_version(
            &proposal.id,
            OWNER,
            proposal.proposal_version,
            MemoryPublicationResolution::CreateNew,
        )
        .unwrap();
    let result = fixture
        .facade
        .approve_publication_at_version(
            &proposal.id,
            OWNER,
            publication_version(&fixture.facade, &proposal.id),
        )
        .unwrap();
    assert_ne!(result.destination.reference, existing.reference);
    assert_eq!(fixture.personal_memories().len(), 2);
}

#[test]
fn stale_or_invalid_update_existing_resolution_fails_closed() {
    let fixture = PublicationFixture::new();
    let existing = memory(
        &fixture.owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers Italian",
    );
    fixture.facade.upsert_memory(&existing).unwrap();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    let wrong = MemoryRef::generated(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        WorkspaceId::new("__personal__"),
    );
    assert_eq!(
        fixture
            .facade
            .set_publication_resolution_at_version(
                &proposal.id,
                OWNER,
                proposal.proposal_version,
                MemoryPublicationResolution::UpdateExisting {
                    destination_ref: wrong,
                },
            )
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    fixture
        .facade
        .set_publication_resolution_at_version(
            &proposal.id,
            OWNER,
            proposal.proposal_version,
            MemoryPublicationResolution::UpdateExisting {
                destination_ref: existing.reference.clone(),
            },
        )
        .unwrap();
    let mut changed = existing.clone();
    changed.text = "Changed after selection".to_string();
    fixture.facade.upsert_memory(&changed).unwrap();
    assert_eq!(
        fixture
            .facade
            .approve_publication_at_version(
                &proposal.id,
                OWNER,
                publication_version(&fixture.facade, &proposal.id)
            )
            .unwrap_err()
            .as_str(),
        "publication_preview_stale"
    );
}

#[test]
fn proposal_validates_owner_scope_tombstone_secret_vault_and_alias() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");

    let cross_owner = MemoryPublicationDestination::personal(UserId::new("other"));
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &cross_owner, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_scope_mismatch"
    );
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.personal_destination(), "other")
            .unwrap_err()
            .as_str(),
        "publication_actor_mismatch"
    );
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.project_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "publication_same_scope"
    );

    let mut secret = source.clone();
    secret.reference = MemoryRef::generated(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        fixture.project.clone(),
    );
    secret.sensitivity = DataSensitivity::Secret;
    fixture.facade.upsert_memory(&secret).unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&secret, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "secret_never_shareable"
    );

    let mut vault = source.clone();
    vault.reference = MemoryRef::generated(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        fixture.project.clone(),
    );
    vault.text = "password: never-share".to_string();
    fixture.facade.upsert_memory(&vault).unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&vault, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "vault_payload_never_shareable"
    );

    fixture
        .facade
        .tombstone_ref(&source.reference, &fixture.owner, &fixture.project, "test")
        .unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "publication_source_not_found"
    );
}

#[test]
fn approval_revalidates_source_and_rejection_is_terminal() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();

    fixture
        .facade
        .tombstone_ref(
            &source.reference,
            &fixture.owner,
            &fixture.project,
            "before approval",
        )
        .unwrap();
    assert_eq!(
        fixture
            .facade
            .approve_publication_at_version(&proposal.id, OWNER, proposal.proposal_version)
            .unwrap_err()
            .as_str(),
        "publication_source_not_found"
    );
    assert!(fixture.personal_memories().is_empty());

    let source = fixture.insert_source_preference("Different preference");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    fixture
        .facade
        .reject_publication_at_version(&proposal.id, OWNER, proposal.proposal_version)
        .unwrap();
    assert_eq!(
        fixture
            .facade
            .approve_publication_at_version(
                &proposal.id,
                OWNER,
                publication_version(&fixture.facade, &proposal.id)
            )
            .unwrap_err()
            .as_str(),
        "publication_not_pending"
    );
}

#[test]
fn commit_transaction_rejects_source_snapshot_changed_after_facade_revalidation() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let personal = WorkspaceId::new("__personal__");
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    store.upsert_memory(&source).unwrap();
    let proposal = pending_store_proposal(&source, &owner, &personal);
    store.create_memory_publication_proposal(&proposal).unwrap();
    let destination_snapshot = store.list_memories(&owner, &personal).unwrap();

    // This is the deterministic interleaving point: the facade has already
    // captured its source and destination preview, then another writer changes
    // a committed source field before the approval transaction begins.
    let mut changed = source.clone();
    changed.language_hints.push("en".to_string());
    changed.aliases.push("English preference".to_string());
    changed.confidence = 0.8;
    changed.metadata = serde_json::json!({"subject": "style", "changed": true});
    changed.updated_at = "unix:2.000000000".to_string();
    store.upsert_memory(&changed).unwrap();

    let destination = memory(&owner, &personal, "preference", "Prefers Italian");
    let link = MemoryPublicationLink {
        source_ref: source.reference.clone(),
        destination_ref: destination.reference.clone(),
        approved_by: OWNER.to_string(),
        created_at: "unix:3.000000000".to_string(),
    };
    let error = store
        .commit_publication(
            &proposal,
            &destination,
            &source,
            &link,
            &source,
            &[],
            &destination_snapshot,
        )
        .unwrap_err();
    assert_eq!(
        error,
        MemoryPublicationStoreError::Conflict("publication_source_changed".to_string())
    );
    assert!(store.list_memories(&owner, &personal).unwrap().is_empty());
    assert!(
        store
            .get_memory_publication_link(&source.reference)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_memory_publication_proposal(&proposal.id)
            .unwrap()
            .unwrap()
            .status
            == MemoryPublicationStatus::Pending
    );
}

#[test]
fn commit_transaction_rejects_new_destination_conflict_after_candidate_revalidation() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let personal = WorkspaceId::new("__personal__");
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    store.upsert_memory(&source).unwrap();
    let proposal = pending_store_proposal(&source, &owner, &personal);
    store.create_memory_publication_proposal(&proposal).unwrap();
    let destination_snapshot = store.list_memories(&owner, &personal).unwrap();

    // A new same-subject record arrives after candidate revalidation. The full
    // destination-scope snapshot makes this a conflict before alias/link writes.
    let competing = memory(&owner, &personal, "preference", "Prefers Italian");
    store.upsert_memory(&competing).unwrap();
    let destination = memory(&owner, &personal, "preference", "Prefers Italian");
    let link = MemoryPublicationLink {
        source_ref: source.reference.clone(),
        destination_ref: destination.reference.clone(),
        approved_by: OWNER.to_string(),
        created_at: "unix:3.000000000".to_string(),
    };
    let error = store
        .commit_publication(
            &proposal,
            &destination,
            &source,
            &link,
            &source,
            &[],
            &destination_snapshot,
        )
        .unwrap_err();
    assert_eq!(
        error,
        MemoryPublicationStoreError::Conflict("publication_conflict".to_string())
    );
    assert_eq!(
        store.list_memories(&owner, &personal).unwrap(),
        vec![competing]
    );
    assert!(
        store
            .get_memory_publication_link(&source.reference)
            .unwrap()
            .is_none()
    );
}

#[test]
fn commit_transaction_rejects_update_existing_target_changed_after_snapshot() {
    let store = SQLiteMemoryStore::open_in_memory().unwrap();
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let personal = WorkspaceId::new("__personal__");
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    let existing = memory(&owner, &personal, "preference", "Prefers Italian");
    store.upsert_memory(&source).unwrap();
    store.upsert_memory(&existing).unwrap();
    let mut proposal = pending_store_proposal(&source, &owner, &personal);
    proposal.candidate = Some(MemoryPublicationCandidate::CompatibleDuplicate {
        destination_ref: existing.reference.clone(),
    });
    proposal.resolution = Some(MemoryPublicationResolution::UpdateExisting {
        destination_ref: existing.reference.clone(),
    });
    proposal.reason_code = MemoryPublicationReasonCode::PublicationDuplicateCompatible;
    store.create_memory_publication_proposal(&proposal).unwrap();
    let destination_snapshot = store.list_memories(&owner, &personal).unwrap();

    // The exact update target changes after the facade captured the candidate
    // and snapshot. The transaction must reject it before any alias/link write.
    let mut changed_target = existing.clone();
    changed_target.text = "Changed by another approval".to_string();
    changed_target.updated_at = "unix:2.000000000".to_string();
    store.upsert_memory(&changed_target).unwrap();
    let link = MemoryPublicationLink {
        source_ref: source.reference.clone(),
        destination_ref: existing.reference.clone(),
        approved_by: OWNER.to_string(),
        created_at: "unix:3.000000000".to_string(),
    };
    let error = store
        .commit_publication(
            &proposal,
            &existing,
            &source,
            &link,
            &source,
            &[],
            &destination_snapshot,
        )
        .unwrap_err();
    assert_eq!(
        error,
        MemoryPublicationStoreError::Conflict("publication_conflict".to_string())
    );
    assert_eq!(
        store.list_memories(&owner, &personal).unwrap(),
        vec![changed_target]
    );
    assert!(
        store
            .get_memory_publication_link(&source.reference)
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .get_memory(&source.reference, &owner, &project)
            .unwrap()
            .unwrap()
            .metadata
            .get("published_alias")
            .is_none()
    );
}

fn pending_store_proposal(
    source: &MemoryRecord,
    owner: &UserId,
    destination_workspace: &WorkspaceId,
) -> MemoryPublicationProposal {
    MemoryPublicationProposal {
        id: uuid::Uuid::new_v4().to_string(),
        proposal_version: 1,
        source_ref: source.reference.clone(),
        source_user_id: source.user_id.clone(),
        source_workspace_id: source.workspace_id.clone(),
        destination_user_id: owner.clone(),
        destination_workspace_id: destination_workspace.clone(),
        proposed_text: source.text.clone(),
        proposed_memory_type: source.memory_type.clone(),
        proposed_collection: MemoryCollectionKey::Preferences,
        proposed_privacy_domain: source.privacy_domain.clone(),
        proposed_sensitivity: source.sensitivity,
        source_revision: "sha256:test".to_string(),
        destination_revision: "sha256:test-destination".to_string(),
        candidate: None,
        resolution: Some(MemoryPublicationResolution::CreateNew),
        status: MemoryPublicationStatus::Pending,
        reason_code: MemoryPublicationReasonCode::Pending,
        failure_reason: None,
        proposed_by: OWNER.to_string(),
        decided_by: None,
        created_at: "unix:1.000000000".to_string(),
        updated_at: "unix:1.000000000".to_string(),
    }
}

#[test]
fn forced_commit_failure_rolls_back_destination_alias_and_link() {
    let path = unique_db_path("rollback");
    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
    let owner = UserId::new(OWNER);
    let project = WorkspaceId::new(PROJECT);
    let source = memory(&owner, &project, "preference", "Prefers Italian");
    facade.upsert_memory(&source).unwrap();
    let proposal = facade
        .create_publication_proposal(
            &source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    choose_create_new(&facade, &proposal.id);

    Connection::open(&path)
        .unwrap()
        .execute_batch(
            "create trigger fail_publication_before_status
             before update of status on memory_publication_proposals
             when new.status = 'approved'
             begin select raise(abort, 'forced publication failure'); end;",
        )
        .unwrap();

    let result = facade.approve_publication(&proposal.id, OWNER);
    assert!(result.is_err());
    assert!(
        facade
            .list_memories_for_ui(&owner, &WorkspaceId::new("__personal__"))
            .unwrap()
            .is_empty()
    );
    assert!(
        facade
            .get_memory_for_ui(&source.reference, &owner, &project)
            .unwrap()
            .unwrap()
            .metadata
            .get("published_alias")
            .is_none()
    );
    assert!(
        facade
            .get_publication_link(&source.reference)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        facade
            .get_publication_proposal(&proposal.id)
            .unwrap()
            .unwrap()
            .status,
        MemoryPublicationStatus::Failed
    );
    drop(facade);
    remove_sqlite_files(&path);
}

#[test]
fn concurrent_approvals_are_idempotent_after_a_durable_approval() {
    // Repeated, barrier-synchronised starts exercise concurrent approval without
    // assuming which approver wins each round.
    for attempt in 0..64 {
        let facade = Arc::new(MemoryFacade::new(
            SQLiteMemoryStore::open_in_memory().unwrap(),
        ));
        let owner = UserId::new(OWNER);
        let project = WorkspaceId::new(PROJECT);
        let source = memory(&owner, &project, "preference", "Prefers Italian");
        facade.upsert_memory(&source).unwrap();
        let proposal = facade
            .create_publication_proposal(
                &source,
                &MemoryPublicationDestination::personal(owner.clone()),
                OWNER,
            )
            .unwrap();
        choose_create_new(&facade, &proposal.id);
        let barrier = Arc::new(Barrier::new(3));
        let mut joins = Vec::new();
        for _ in 0..2 {
            let facade = Arc::clone(&facade);
            let barrier = Arc::clone(&barrier);
            let id = proposal.id.clone();
            joins.push(std::thread::spawn(move || {
                barrier.wait();
                facade.approve_publication(&id, OWNER)
            }));
        }
        barrier.wait();
        let results = joins
            .into_iter()
            .map(|join| join.join().unwrap())
            .collect::<Vec<_>>();
        assert!(results.iter().all(Result::is_ok), "round {attempt}: {results:?}");
        assert_eq!(
            facade
                .list_memories_for_ui(&owner, &WorkspaceId::new("__personal__"))
                .unwrap()
                .len(),
            1,
            "round {attempt}"
        );
        assert!(
            facade
                .get_publication_link(&source.reference)
                .unwrap()
                .is_some(),
            "round {attempt}"
        );
    }
}

fn unique_db_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "local-first-memory-publication-{label}-{}.sqlite",
        uuid::Uuid::new_v4()
    ))
}

fn remove_sqlite_files(path: &Path) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{}-wal", path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", path.display()));
}

#[test]
fn schema_v7_open_remains_compatible() {
    let path = unique_db_path("schema-v4");
    let store = SQLiteMemoryStore::open(&path).unwrap();
    assert_eq!(store.schema_version().unwrap(), 8);
    drop(store);
    let reopened = SQLiteMemoryStore::open(&path).unwrap();
    assert_eq!(reopened.schema_version().unwrap(), 8);
    remove_sqlite_files(&path);
}

#[test]
fn store_rejects_cross_owner_or_thread_publication_proposals() {
    let fixture = PublicationFixture::new();
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    let store = SQLiteMemoryStore::open_in_memory().unwrap();

    let mut cross_owner = proposal.clone();
    cross_owner.id = uuid::Uuid::new_v4().to_string();
    cross_owner.destination_user_id = UserId::new("other");
    assert!(matches!(
        store.create_memory_publication_proposal(&cross_owner),
        Err(MemoryPublicationStoreError::Validation(_))
    ));

    let mut thread_destination = proposal;
    thread_destination.id = uuid::Uuid::new_v4().to_string();
    thread_destination.destination_workspace_id = WorkspaceId::new("__threads__");
    assert!(matches!(
        store.create_memory_publication_proposal(&thread_destination),
        Err(MemoryPublicationStoreError::Validation(_))
    ));
}

#[test]
fn legacy_publication_rows_are_backfilled_to_valid_typed_states() {
    let path = unique_db_path("legacy-publications");
    let owner = UserId::new(OWNER);
    let source = MemoryRef::generated(
        MemoryRefKind::Memory,
        owner.clone(),
        WorkspaceId::new(PROJECT),
    );
    let duplicate = MemoryRef::generated(
        MemoryRefKind::Memory,
        owner.clone(),
        WorkspaceId::new("__personal__"),
    );
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "create table memory_publication_proposals (
                id text primary key,
                source_ref_json text not null,
                source_user_id text not null,
                source_workspace_id text not null,
                destination_user_id text not null,
                destination_workspace_id text not null,
                proposed_text text not null,
                proposed_memory_type text not null,
                proposed_privacy_domain text not null,
                proposed_sensitivity text not null,
                duplicate_ref_json text,
                status text not null,
                proposed_by text not null,
                decided_by text,
                created_at text not null,
                updated_at text not null
            );
            create table memory_publication_links (
                source_ref_json text primary key,
                destination_ref_json text not null,
                approved_by text not null,
                created_at text not null
            );",
        )
        .unwrap();
    for (id, status, decided_by, memory_type, duplicate_ref) in [
        ("approved", "approved", Some(OWNER), "preference", None),
        ("rejected", "rejected", Some(OWNER), "preference", None),
        ("failed", "failed", Some(OWNER), "preference", None),
        (
            "pending-duplicate",
            "pending",
            None,
            "preference",
            Some(duplicate.clone()),
        ),
        ("pending", "pending", None, "note", None),
        ("pending-fact", "pending", None, "fact", None),
        ("pending-preference", "pending", None, "preference", None),
        ("pending-goal", "pending", None, "goal", None),
        ("pending-artifact", "pending", None, "artifact", None),
        ("pending-episode", "pending", None, "episode", None),
        (
            "pending-unknown",
            "pending",
            None,
            "unknown_legacy_type",
            None,
        ),
    ] {
        connection
            .execute(
                "insert into memory_publication_proposals(
                    id, source_ref_json, source_user_id, source_workspace_id,
                    destination_user_id, destination_workspace_id, proposed_text,
                    proposed_memory_type, proposed_privacy_domain, proposed_sensitivity,
                    duplicate_ref_json, status, proposed_by, decided_by, created_at, updated_at
                 ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                rusqlite::params![
                    id,
                    serde_json::to_string(&source).unwrap(),
                    OWNER,
                    PROJECT,
                    OWNER,
                    "__personal__",
                    "Prefers Italian",
                    memory_type,
                    "personal",
                    "private",
                    duplicate_ref.map(|reference| serde_json::to_string(&reference).unwrap()),
                    status,
                    OWNER,
                    decided_by,
                    "unix:1.000000000",
                    "unix:1.000000000",
                ],
            )
            .unwrap();
    }
    connection
        .execute(
            "insert into memory_publication_proposals(
                id, source_ref_json, source_user_id, source_workspace_id,
                destination_user_id, destination_workspace_id, proposed_text,
                proposed_memory_type, proposed_privacy_domain, proposed_sensitivity,
                duplicate_ref_json, status, proposed_by, decided_by, created_at, updated_at
             ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            rusqlite::params![
                "pending-corrupt",
                serde_json::to_string(&source).unwrap(),
                OWNER,
                PROJECT,
                OWNER,
                "__personal__",
                "Prefers Italian",
                "preference",
                "personal",
                "private",
                "{corrupt-legacy-ref",
                "pending",
                OWNER,
                Option::<&str>::None,
                "unix:1.000000000",
                "unix:1.000000000",
            ],
        )
        .unwrap();
    drop(connection);

    let facade = MemoryFacade::new(SQLiteMemoryStore::open(&path).unwrap());
    assert_eq!(
        facade
            .get_publication_proposal("approved")
            .unwrap()
            .unwrap()
            .reason_code,
        MemoryPublicationReasonCode::Approved
    );
    assert_eq!(
        facade
            .get_publication_proposal("approved")
            .unwrap()
            .unwrap()
            .proposal_version,
        1
    );
    assert_eq!(
        facade
            .get_publication_proposal("rejected")
            .unwrap()
            .unwrap()
            .reason_code,
        MemoryPublicationReasonCode::Rejected
    );
    let failed = facade.get_publication_proposal("failed").unwrap().unwrap();
    assert_eq!(
        failed.reason_code,
        MemoryPublicationReasonCode::PublicationFailed
    );
    assert_eq!(failed.failure_reason.as_deref(), Some("legacy_failure"));
    let pending_duplicate = facade
        .get_publication_proposal("pending-duplicate")
        .unwrap()
        .unwrap();
    assert_eq!(
        pending_duplicate.candidate,
        Some(MemoryPublicationCandidate::CompatibleDuplicate {
            destination_ref: duplicate,
        })
    );
    assert_eq!(pending_duplicate.status, MemoryPublicationStatus::Failed);
    assert_eq!(
        pending_duplicate.failure_reason.as_deref(),
        Some("publication_source_changed")
    );
    assert_eq!(
        facade
            .get_publication_proposal("pending")
            .unwrap()
            .unwrap()
            .status,
        MemoryPublicationStatus::Failed
    );
    assert!(facade.get_publication_proposal("pending-corrupt").is_err());
    assert!(facade.get_publication_proposal("pending-fact").is_err());
    assert!(facade.get_publication_proposal("pending-unknown").is_err());
    for (id, expected_collection) in [
        ("pending-preference", MemoryCollectionKey::Preferences),
        ("pending-goal", MemoryCollectionKey::Goals),
        ("pending-artifact", MemoryCollectionKey::Artifacts),
        ("pending-episode", MemoryCollectionKey::Episodes),
    ] {
        assert_eq!(
            facade
                .get_publication_proposal(id)
                .unwrap()
                .unwrap()
                .proposed_collection,
            expected_collection,
        );
    }

    let mut conflict_source = memory(
        &owner,
        &WorkspaceId::new(PROJECT),
        "preference",
        "Prefers Italian",
    );
    conflict_source.metadata = serde_json::json!({"subject_key": "reply_language"});
    facade.upsert_memory(&conflict_source).unwrap();
    let mut conflicting_destination = memory(
        &owner,
        &WorkspaceId::new("__personal__"),
        "preference",
        "Prefers English",
    );
    conflicting_destination.metadata = serde_json::json!({"subject_key": "reply_language"});
    facade.upsert_memory(&conflicting_destination).unwrap();
    let conflict = facade
        .create_publication_proposal(
            &conflict_source,
            &MemoryPublicationDestination::personal(owner.clone()),
            OWNER,
        )
        .unwrap();
    assert_eq!(
        conflict.reason_code,
        MemoryPublicationReasonCode::PublicationConflict
    );
    assert_eq!(
        facade
            .approve_publication(&conflict.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_conflict"
    );
    facade
        .set_publication_resolution(&conflict.id, OWNER, MemoryPublicationResolution::CreateNew)
        .unwrap();
    facade.approve_publication(&conflict.id, OWNER).unwrap();
    drop(facade);
    remove_sqlite_files(&path);
}

#[test]
fn publication_preserves_safe_profile_semantics_and_detects_later_subject_conflict() {
    let fixture = PublicationFixture::new();
    let mut profile = memory(&fixture.owner, &fixture.project, "fact", "Uses Italian");
    profile.metadata = serde_json::json!({"scope": "personal", "subject_key": "language"});
    fixture.facade.upsert_memory(&profile).unwrap();
    let proposal = fixture
        .facade
        .create_publication_proposal(&profile, &fixture.personal_destination(), OWNER)
        .unwrap();
    choose_create_new(&fixture.facade, &proposal.id);
    let published = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap();
    assert_eq!(
        MemoryCollectionKey::for_memory(&published.destination),
        Some(MemoryCollectionKey::Profile)
    );
    assert_eq!(published.destination.metadata["subject_key"], "language");

    let mut contradictory = memory(&fixture.owner, &fixture.project, "fact", "Uses English");
    contradictory.metadata = serde_json::json!({"scope": "personal", "subject_key": "language"});
    fixture.facade.upsert_memory(&contradictory).unwrap();
    let conflict = fixture
        .facade
        .create_publication_proposal(&contradictory, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(
        conflict.reason_code,
        MemoryPublicationReasonCode::PublicationConflict
    );
}

#[test]
fn inactive_sources_and_destinations_do_not_participate_in_publication() {
    let fixture = PublicationFixture::new();
    for status in [MemoryStatus::Stale, MemoryStatus::Rejected] {
        let mut source = fixture.insert_source_preference("Prefers Italian");
        source.status = status;
        fixture.facade.upsert_memory(&source).unwrap();
        assert_eq!(
            fixture
                .facade
                .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
                .unwrap_err()
                .as_str(),
            "publication_source_inactive"
        );
    }
    for status in [MemoryStatus::Stale, MemoryStatus::Rejected] {
        let mut destination = memory(
            &fixture.owner,
            &WorkspaceId::new("__personal__"),
            "preference",
            "Prefers Italian",
        );
        destination.status = status;
        fixture.facade.upsert_memory(&destination).unwrap();
    }
    let source = fixture.insert_source_preference("Prefers Italian");
    let proposal = fixture
        .facade
        .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(proposal.reason_code, MemoryPublicationReasonCode::Pending);
    assert_eq!(
        fixture
            .facade
            .approve_publication(&proposal.id, OWNER)
            .unwrap_err()
            .as_str(),
        "publication_decision_required"
    );
}

#[test]
fn update_existing_keeps_all_structural_provenance_and_stable_recall_link() {
    let fixture = PublicationFixture::new();
    let first = fixture.insert_source_preference("Prefers Italian");
    let first_proposal = fixture
        .facade
        .create_publication_proposal(&first, &fixture.personal_destination(), OWNER)
        .unwrap();
    choose_create_new(&fixture.facade, &first_proposal.id);
    let first_result = fixture
        .facade
        .approve_publication(&first_proposal.id, OWNER)
        .unwrap();
    let second = fixture.insert_source_preference("Prefers Italian");
    let second_proposal = fixture
        .facade
        .create_publication_proposal(&second, &fixture.personal_destination(), OWNER)
        .unwrap();
    fixture
        .facade
        .set_publication_resolution(
            &second_proposal.id,
            OWNER,
            MemoryPublicationResolution::UpdateExisting {
                destination_ref: first_result.destination.reference.clone(),
            },
        )
        .unwrap();
    let second_result = fixture
        .facade
        .approve_publication(&second_proposal.id, OWNER)
        .unwrap();
    assert_eq!(
        second_result.destination.reference,
        first_result.destination.reference
    );
    let refs: Vec<MemoryRef> = serde_json::from_value(
        second_result.destination.metadata["publication_source_refs"].clone(),
    )
    .unwrap();
    assert!(refs.contains(&first.reference) && refs.contains(&second.reference));
    let link = serde_json::to_string(&first_result.destination.reference).unwrap();
    assert_eq!(second_result.destination.metadata["publication_link"], link);
    assert_eq!(
        fixture.get_source(&second.reference).metadata["publication_link"],
        link
    );
    assert_eq!(
        fixture
            .facade
            .get_publication_link(&first.reference)
            .unwrap()
            .unwrap()
            .destination_ref,
        first_result.destination.reference
    );
    assert_eq!(
        fixture
            .facade
            .get_publication_link(&second.reference)
            .unwrap()
            .unwrap()
            .destination_ref,
        first_result.destination.reference
    );
}

#[test]
fn validated_structural_provenance_is_not_secret_scanned_but_malformed_fields_fail_closed() {
    let fixture = PublicationFixture::new();
    let mut first = fixture.insert_source_preference("Prefers Italian");
    first.reference = MemoryRef::new(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        fixture.project.clone(),
        "AKIAIOSFODNN7EXAMPLE",
    );
    fixture.facade.upsert_memory(&first).unwrap();
    let proposal = fixture
        .facade
        .create_publication_proposal(&first, &fixture.personal_destination(), OWNER)
        .unwrap();
    choose_create_new(&fixture.facade, &proposal.id);
    let destination = fixture
        .facade
        .approve_publication(&proposal.id, OWNER)
        .unwrap()
        .destination;
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&first, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "publication_already_published"
    );
    let second = fixture.insert_source_preference("Prefers Italian");
    let duplicate = fixture
        .facade
        .create_publication_proposal(&second, &fixture.personal_destination(), OWNER)
        .unwrap();
    assert_eq!(
        duplicate.reason_code,
        MemoryPublicationReasonCode::PublicationDuplicateCompatible
    );
    assert_eq!(
        duplicate.candidate,
        Some(MemoryPublicationCandidate::CompatibleDuplicate {
            destination_ref: destination.reference
        })
    );

    let mut malformed = fixture.insert_source_preference("Other preference");
    malformed.metadata = serde_json::json!({"publication_link": "not-a-memory-ref"});
    fixture.facade.upsert_memory(&malformed).unwrap();
    assert_eq!(
        fixture
            .facade
            .create_publication_proposal(&malformed, &fixture.personal_destination(), OWNER)
            .unwrap_err()
            .as_str(),
        "publication_provenance_invalid"
    );
}

#[test]
fn nested_publication_metadata_is_closed_schema() {
    let fixture = PublicationFixture::new();
    for (extra, proposal_id, published_at) in [
        (
            Some(("extra_secret", "AKIAIOSFODNN7EXAMPLE")),
            uuid::Uuid::new_v4().to_string(),
            "unix:1.000000000".to_string(),
        ),
        (
            None,
            "AKIAIOSFODNN7EXAMPLE".to_string(),
            "unix:1.000000000".to_string(),
        ),
        (
            None,
            uuid::Uuid::new_v4().to_string(),
            "not-a-timestamp".to_string(),
        ),
    ] {
        let mut source = fixture.insert_source_preference("Nested metadata");
        let mut publication = serde_json::json!({
            "source_ref": source.reference,
            "proposal_id": proposal_id,
            "published_at": published_at,
        });
        if let Some((key, value)) = extra {
            publication[key] = serde_json::Value::String(value.to_string());
        }
        source.metadata = serde_json::json!({"publication": publication});
        fixture.facade.upsert_memory(&source).unwrap();
        assert_eq!(
            fixture
                .facade
                .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
                .unwrap_err()
                .as_str(),
            "publication_provenance_invalid"
        );
    }
}

#[test]
fn publication_link_requires_a_local_owned_memory_scope() {
    let fixture = PublicationFixture::new();
    for mut reference in [
        MemoryRef::new(
            MemoryRefKind::Memory,
            fixture.owner.clone(),
            WorkspaceId::new("__threads__"),
            "thread",
        ),
        MemoryRef::new(
            MemoryRefKind::Memory,
            fixture.owner.clone(),
            WorkspaceId::new("__personal__"),
            "remote",
        ),
        MemoryRef::new(
            MemoryRefKind::Memory,
            fixture.owner.clone(),
            WorkspaceId::new(""),
            "empty",
        ),
    ] {
        if reference.key == "remote" {
            reference.scope = "remote".to_string();
        }
        let mut source = fixture.insert_source_preference("Invalid link");
        source.metadata =
            serde_json::json!({"publication_link": serde_json::to_string(&reference).unwrap()});
        fixture.facade.upsert_memory(&source).unwrap();
        assert_eq!(
            fixture
                .facade
                .create_publication_proposal(&source, &fixture.personal_destination(), OWNER)
                .unwrap_err()
                .as_str(),
            "publication_provenance_invalid"
        );
    }
    let mut valid = fixture.insert_source_preference("Valid link");
    let reference = MemoryRef::new(
        MemoryRefKind::Memory,
        fixture.owner.clone(),
        WorkspaceId::new("__personal__"),
        "valid",
    );
    valid.metadata =
        serde_json::json!({"publication_link": serde_json::to_string(&reference).unwrap()});
    fixture.facade.upsert_memory(&valid).unwrap();
    assert!(
        fixture
            .facade
            .create_publication_proposal(&valid, &fixture.personal_destination(), OWNER)
            .is_ok()
    );
}
