use local_first_host_computer::grants::*;

fn scope(workspace: &str) -> GrantScope {
    GrantScope {
        user_id: "user".into(),
        workspace_id: workspace.into(),
    }
}
fn app(team: &str) -> SignedAppIdentity {
    SignedAppIdentity {
        bundle_id: "com.example.Editor".into(),
        team_id: team.into(),
        designated_requirement_sha256: "requirement".into(),
    }
}
fn grant(id: &str, scope: GrantScope, app: SignedAppIdentity, level: GrantLevel) -> AppGrant {
    AppGrant {
        grant_id: id.into(),
        scope,
        app,
        level,
        expires_at_unix_ms: None,
    }
}

#[test]
fn scope_and_signing_identity_are_exact() {
    let store = GrantStore::in_memory().unwrap();
    store
        .upsert(
            &grant("g1", scope("a"), app("TEAM1"), GrantLevel::Control),
            1,
        )
        .unwrap();
    assert_eq!(
        store.resolve(&scope("a"), &app("TEAM1"), 2).unwrap(),
        Some(GrantLevel::Control)
    );
    assert_eq!(store.resolve(&scope("b"), &app("TEAM1"), 2).unwrap(), None);
    assert_eq!(store.resolve(&scope("a"), &app("TEAM2"), 2).unwrap(), None);
}

#[test]
fn expiry_revoke_and_factory_reset_are_immediate() {
    let store = GrantStore::in_memory().unwrap();
    let mut value = grant("g1", scope("a"), app("TEAM1"), GrantLevel::Observe);
    value.expires_at_unix_ms = Some(10);
    store.upsert(&value, 1).unwrap();
    assert_eq!(store.resolve(&scope("a"), &app("TEAM1"), 10).unwrap(), None);
    value.expires_at_unix_ms = None;
    store.upsert(&value, 11).unwrap();
    assert!(store.revoke("g1", &scope("a")).unwrap());
    store.upsert(&value, 12).unwrap();
    assert_eq!(store.clear_all().unwrap(), 1);
}
