use crate::{model_registry::ProviderKind, usage_store::{ProviderSnapshotStatus, ProviderUsageSnapshot}};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountUsageCapability {
    StandardKey,
    UnsupportedWithStandardKey,
}

pub fn adapter_capability(provider_id: &str, kind: ProviderKind) -> AccountUsageCapability {
    if provider_id.eq_ignore_ascii_case("openrouter") && kind == ProviderKind::OpenaiCompat {
        AccountUsageCapability::StandardKey
    } else {
        AccountUsageCapability::UnsupportedWithStandardKey
    }
}

pub fn parse_openrouter_key_state(
    user_id: &str,
    provider_id: &str,
    observed_at: i64,
    body: &serde_json::Value,
) -> Result<Vec<ProviderUsageSnapshot>, String> {
    let data = body.get("data").ok_or_else(|| "missing data".to_string())?;
    let value = |name: &str| data.get(name).and_then(decimal_json_to_microusd);
    Ok(vec![ProviderUsageSnapshot {
        snapshot_id: uuid::Uuid::new_v4().to_string(),
        user_id: user_id.to_string(),
        provider_id: provider_id.to_string(),
        status: ProviderSnapshotStatus::Available,
        metric: "credits".to_string(),
        used_value: value("usage"),
        limit_value: value("limit"),
        remaining_value: value("limit_remaining"),
        unit: Some("microusd".to_string()),
        source: "provider_standard_key".to_string(),
        observed_at,
        error_code: None,
    }])
}

fn decimal_json_to_microusd(value: &serde_json::Value) -> Option<u64> {
    let text = match value {
        serde_json::Value::Number(number) => number.to_string(),
        serde_json::Value::String(text) => text.clone(),
        _ => return None,
    };
    decimal_to_scale(&text, 6)
}

fn decimal_to_scale(value: &str, scale: usize) -> Option<u64> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') { return None; }
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.len() > scale
    {
        return None;
    }
    let whole = whole.parse::<u128>().ok()?;
    let fraction = if fraction.is_empty() { 0 } else {
        fraction.parse::<u128>().ok()? * 10u128.checked_pow((scale - fraction.len()) as u32)?
    };
    u64::try_from(whole.checked_mul(10u128.checked_pow(scale as u32)?)?.checked_add(fraction)?).ok()
}

fn status_snapshot(
    user_id: &str,
    provider_id: &str,
    observed_at: i64,
    status: ProviderSnapshotStatus,
    error_code: Option<&str>,
) -> ProviderUsageSnapshot {
    ProviderUsageSnapshot {
        snapshot_id: uuid::Uuid::new_v4().to_string(),
        user_id: user_id.to_string(),
        provider_id: provider_id.to_string(),
        status,
        metric: "account".to_string(),
        used_value: None,
        limit_value: None,
        remaining_value: None,
        unit: None,
        source: "provider_standard_key".to_string(),
        observed_at,
        error_code: error_code.map(str::to_string),
    }
}

pub async fn refresh_provider_usage(
    http: &reqwest::Client,
    user_id: &str,
    provider_id: &str,
    kind: ProviderKind,
    base_url: &str,
    api_key: Option<&str>,
    observed_at: i64,
) -> Vec<ProviderUsageSnapshot> {
    if adapter_capability(provider_id, kind) == AccountUsageCapability::UnsupportedWithStandardKey {
        return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Unsupported, Some("unsupported_with_standard_key"))];
    }
    let Some(api_key) = api_key.filter(|key| !key.trim().is_empty()) else {
        return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Unauthorized, Some("missing_standard_key"))];
    };
    let trimmed = base_url.trim_end_matches('/');
    let endpoint = if trimmed.ends_with("/api/v1") {
        format!("{trimmed}/key")
    } else if let Some((origin, _)) = trimmed.split_once("/api/") {
        format!("{origin}/api/v1/key")
    } else {
        format!("{trimmed}/api/v1/key")
    };
    let response = match http.get(endpoint).bearer_auth(api_key).timeout(std::time::Duration::from_secs(20)).send().await {
        Ok(response) => response,
        Err(_) => return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Error, Some("transport"))],
    };
    let status = response.status().as_u16();
    if matches!(status, 401 | 403) {
        return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Unauthorized, Some("unauthorized"))];
    }
    if status == 404 {
        return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Unsupported, Some("unsupported"))];
    }
    if !(200..300).contains(&status) {
        return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Error, Some("provider_error"))];
    }
    let body = match response.json::<serde_json::Value>().await {
        Ok(body) => body,
        Err(_) => return vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Error, Some("decode"))],
    };
    parse_openrouter_key_state(user_id, provider_id, observed_at, &body)
        .unwrap_or_else(|_| vec![status_snapshot(user_id, provider_id, observed_at, ProviderSnapshotStatus::Error, Some("invalid_response"))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openrouter_key_response_becomes_a_credit_snapshot() {
        let rows = parse_openrouter_key_state("local", "openrouter", 100, &serde_json::json!({
            "data": {"limit": 50.0, "usage": 12.5, "limit_remaining": 37.5, "is_free_tier": false}
        })).unwrap();
        assert_eq!(rows[0].source, "provider_standard_key");
        assert_eq!(rows[0].used_value, Some(12_500_000));
        assert_eq!(rows[0].remaining_value, Some(37_500_000));
        assert_eq!(rows[0].unit.as_deref(), Some("microusd"));
    }

    #[test]
    fn anthropic_standard_key_is_explicitly_unsupported_for_org_usage() {
        assert_eq!(adapter_capability("anthropic", ProviderKind::Anthropic), AccountUsageCapability::UnsupportedWithStandardKey);
    }
}
