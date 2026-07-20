use local_first_desktop_gateway::usage_store::{
    ProviderSnapshotStatus, ProviderUsagePolicy, ProviderUsageSnapshot, UsageBreakdownDimension,
    UsageStore, UsageWindow,
};
use local_first_inference_usage::{
    CostProvenance, InferencePurpose, Locality, NormalizedUsage, UsageAttemptEvent, UsageContext,
    UsageProvenance,
};

fn terminal_attempt(
    attempt_id: &str,
    cost_microusd: Option<u64>,
    cost_provenance: CostProvenance,
) -> UsageAttemptEvent {
    let started = UsageAttemptEvent::started(
        UsageContext::new(
            format!("call-{attempt_id}"),
            InferencePurpose::ChatResponse,
            "local",
        ),
        attempt_id,
        "openrouter",
        "vendor/model",
        Locality::Cloud,
        100,
    );
    let mut terminal = started.completed(
        110,
        NormalizedUsage {
            input_tokens: Some(1_000),
            output_tokens: Some(250),
            ..NormalizedUsage::default()
        },
    );
    terminal.usage_provenance = UsageProvenance::ProviderReported;
    terminal.cost_microusd = cost_microusd;
    terminal.cost_provenance = cost_provenance;
    terminal
}

fn terminal_attempt_at(
    attempt_id: &str,
    provider_id: &str,
    model_id: &str,
    input_tokens: u64,
    output_tokens: u64,
    recorded_at: i64,
) -> UsageAttemptEvent {
    let started = UsageAttemptEvent::started(
        UsageContext::new(
            format!("call-{attempt_id}"),
            InferencePurpose::ChatResponse,
            "local",
        ),
        attempt_id,
        provider_id,
        model_id,
        Locality::Cloud,
        recorded_at.saturating_sub(10),
    );
    let mut terminal = started.completed(
        recorded_at,
        NormalizedUsage {
            input_tokens: Some(input_tokens),
            output_tokens: Some(output_tokens),
            ..NormalizedUsage::default()
        },
    );
    terminal.usage_provenance = UsageProvenance::ProviderReported;
    terminal.cost_provenance = CostProvenance::Unavailable;
    terminal
}

#[test]
fn mixed_cost_provenance_and_provider_account_state_remain_separate() {
    let store = UsageStore::open_in_memory().unwrap();
    for event in [
        terminal_attempt("reported", Some(1_000), CostProvenance::ProviderReported),
        terminal_attempt("catalog", Some(2_000), CostProvenance::CatalogEstimated),
        terminal_attempt("manual", Some(3_000), CostProvenance::ManualEstimated),
        terminal_attempt("unknown", None, CostProvenance::Unavailable),
    ] {
        store.append(&event).unwrap();
    }

    let policy = ProviderUsagePolicy {
        user_id: "local".into(),
        provider_id: "openrouter".into(),
        monthly_budget_microusd: Some(20_000_000),
        currency: "USD".into(),
        reset_day: Some(1),
        timezone: Some("Europe/Rome".into()),
        alert_threshold_percent: Some(80),
        pricing_overrides: vec![],
    };
    store.upsert_provider_policy(&policy, 120).unwrap();
    let snapshot = ProviderUsageSnapshot {
        snapshot_id: "openrouter-120".into(),
        user_id: "local".into(),
        provider_id: "openrouter".into(),
        status: ProviderSnapshotStatus::Available,
        metric: "credits".into(),
        used_value: Some(12_500_000),
        limit_value: Some(50_000_000),
        remaining_value: Some(37_500_000),
        unit: Some("microusd".into()),
        source: "provider_standard_key".into(),
        observed_at: 120,
        error_code: None,
    };
    store.append_provider_snapshot(&snapshot).unwrap();

    let summary = store.summary("local", UsageWindow::All, 120).unwrap();
    assert_eq!(summary.cost_microusd, 6_000);
    assert_eq!(summary.cost_breakdown.provider_reported_microusd, 1_000);
    assert_eq!(summary.cost_breakdown.catalog_estimated_microusd, 2_000);
    assert_eq!(summary.cost_breakdown.manual_estimated_microusd, 3_000);
    assert_eq!(summary.cost_breakdown.unknown_cost_attempts, 1);
    assert_eq!(summary.cost_breakdown.cost_coverage_percent, 75);

    let providers = store
        .breakdown(
            "local",
            UsageWindow::All,
            120,
            UsageBreakdownDimension::Provider,
        )
        .unwrap();
    assert_eq!(providers.len(), 1);
    assert_eq!(providers[0].key, "openrouter");
    assert_eq!(providers[0].cost_breakdown, summary.cost_breakdown);

    let loaded_policy = store.provider_policy("local", "openrouter").unwrap().unwrap();
    let loaded_snapshots = store
        .latest_provider_snapshots("local", "openrouter")
        .unwrap();
    assert_eq!(loaded_policy.monthly_budget_microusd, Some(20_000_000));
    assert_eq!(loaded_snapshots[0].limit_value, Some(50_000_000));
    assert_ne!(
        loaded_policy.monthly_budget_microusd,
        loaded_snapshots[0].limit_value,
        "manual budget must not be presented as a provider-reported limit",
    );
}

#[test]
fn explicitly_not_billed_local_attempts_have_complete_cost_coverage() {
    let store = UsageStore::open_in_memory().unwrap();
    let mut event = terminal_attempt("local", None, CostProvenance::NotBilled);
    event.provider_id = Some("ollama".into());
    event.locality = Locality::Local;
    store.append(&event).unwrap();

    let summary = store.summary("local", UsageWindow::All, 120).unwrap();
    assert_eq!(summary.cost_breakdown.not_billed_attempts, 1);
    assert_eq!(summary.cost_breakdown.unknown_cost_attempts, 0);
    assert_eq!(summary.cost_breakdown.cost_coverage_percent, 100);
}

#[test]
fn compact_summary_reports_active_providers_dominant_model_and_token_trend() {
    const DAY: i64 = 86_400;
    let now = 20 * DAY;
    let store = UsageStore::open_in_memory().unwrap();
    for event in [
        terminal_attempt_at("current-a", "openrouter", "model-a", 1_400, 600, now - DAY),
        terminal_attempt_at("current-b", "anthropic", "model-b", 700, 300, now - 2 * DAY),
        terminal_attempt_at("previous", "openrouter", "model-a", 1_500, 500, now - 8 * DAY),
    ] {
        store.append(&event).unwrap();
    }

    let summary = store.summary("local", UsageWindow::SevenDays, now).unwrap();
    assert_eq!(summary.active_providers, 2);
    assert_eq!(summary.dominant_model.as_deref(), Some("model-a"));
    assert_eq!(summary.trend_percent, Some(50));
}

#[test]
fn compact_summary_omits_unbounded_or_baseless_trends() {
    const DAY: i64 = 86_400;
    let now = 20 * DAY;
    let store = UsageStore::open_in_memory().unwrap();
    store
        .append(&terminal_attempt_at(
            "current",
            "ollama",
            "qwen",
            100,
            50,
            now - DAY,
        ))
        .unwrap();

    assert_eq!(
        store
            .summary("local", UsageWindow::SevenDays, now)
            .unwrap()
            .trend_percent,
        None,
    );
    assert_eq!(
        store
            .summary("local", UsageWindow::All, now)
            .unwrap()
            .trend_percent,
        None,
    );
}
