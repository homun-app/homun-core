use local_first_browser_automation::{
    BrowserUrlApprovalGrant, BrowserUrlApprovalScope, BrowserUrlPolicyStore, BrowserVisibilityMode,
    origin_for_url,
};

#[test]
fn origin_normalizes_scheme_and_host_without_path() {
    assert_eq!(
        origin_for_url("https://WWW.Trenitalia.com/it.html?x=1").unwrap(),
        "https://www.trenitalia.com"
    );
}

#[test]
fn once_grants_are_not_persisted() {
    let store = BrowserUrlPolicyStore::open_in_memory().unwrap();

    let result = store
        .grant(&BrowserUrlApprovalGrant {
            user_id: "user".to_string(),
            workspace_id: "workspace".to_string(),
            url: "https://www.trenitalia.com/it.html".to_string(),
            action: "navigate".to_string(),
            scope: BrowserUrlApprovalScope::Once,
            visibility: BrowserVisibilityMode::Visible,
        })
        .unwrap();

    assert!(result.is_none());
    assert!(
        store
            .rule_for_url(
                "user",
                "workspace",
                "https://www.trenitalia.com/it.html",
                "navigate"
            )
            .unwrap()
            .is_none()
    );
}

#[test]
fn always_grants_are_persisted_by_origin_and_visibility() {
    let store = BrowserUrlPolicyStore::open_in_memory().unwrap();

    let rule = store
        .grant(&BrowserUrlApprovalGrant {
            user_id: "user".to_string(),
            workspace_id: "workspace".to_string(),
            url: "https://www.trenitalia.com/it.html".to_string(),
            action: "navigate".to_string(),
            scope: BrowserUrlApprovalScope::Always,
            visibility: BrowserVisibilityMode::Headless,
        })
        .unwrap()
        .unwrap();

    assert_eq!(rule.origin, "https://www.trenitalia.com");
    assert_eq!(rule.visibility, BrowserVisibilityMode::Headless);
    assert_eq!(
        store
            .rule_for_url(
                "user",
                "workspace",
                "https://www.trenitalia.com/search",
                "navigate"
            )
            .unwrap()
            .unwrap()
            .visibility,
        BrowserVisibilityMode::Headless
    );
}
