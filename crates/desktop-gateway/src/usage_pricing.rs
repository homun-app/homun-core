use local_first_inference_usage::{
    AttemptEventKind, CostProvenance, Locality, NormalizedUsage, UsageAttemptEvent, UsageRecorder,
};
use std::{collections::HashMap, sync::{Arc, RwLock}};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsagePrice {
    pub input_microusd_per_million: Option<u64>,
    pub output_microusd_per_million: Option<u64>,
    pub reasoning_microusd_per_million: Option<u64>,
    pub cache_read_microusd_per_million: Option<u64>,
    pub cache_write_microusd_per_million: Option<u64>,
    pub source: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelPricing {
    pub catalog: Option<UsagePrice>,
    pub manual: Option<UsagePrice>,
}

#[derive(Debug, Clone, Default)]
pub struct PricingSnapshot {
    prices: HashMap<(String, String), ModelPricing>,
}

impl PricingSnapshot {
    pub fn insert(&mut self, provider_id: impl Into<String>, model_id: impl Into<String>, pricing: ModelPricing) {
        self.prices.insert((provider_id.into(), model_id.into()), pricing);
    }

    pub fn get(&self, provider_id: &str, model_id: &str) -> Option<&ModelPricing> {
        self.prices.get(&(provider_id.to_string(), model_id.to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostResolution {
    pub cost_microusd: Option<u64>,
    pub provenance: CostProvenance,
    pub pricing_source: Option<String>,
    pub pricing_version: Option<String>,
}

pub fn resolve_cost(
    provider_reported_cost: Option<u64>,
    usage: &NormalizedUsage,
    catalog: Option<&UsagePrice>,
    manual: Option<&UsagePrice>,
    locality: Locality,
) -> CostResolution {
    if let Some(cost) = provider_reported_cost {
        return CostResolution {
            cost_microusd: Some(cost),
            provenance: CostProvenance::ProviderReported,
            pricing_source: Some("provider_response".to_string()),
            pricing_version: None,
        };
    }
    for (price, provenance) in [
        (manual, CostProvenance::ManualEstimated),
        (catalog, CostProvenance::CatalogEstimated),
    ] {
        if let Some(price) = price {
            if let Some(cost) = estimate_cost(usage, price) {
                return CostResolution {
                    cost_microusd: Some(cost),
                    provenance,
                    pricing_source: Some(price.source.clone()),
                    pricing_version: Some(price.version.clone()),
                };
            }
        }
    }
    if locality == Locality::Local {
        CostResolution {
            cost_microusd: None,
            provenance: CostProvenance::NotBilled,
            pricing_source: None,
            pricing_version: None,
        }
    } else {
        CostResolution {
            cost_microusd: None,
            provenance: CostProvenance::Unavailable,
            pricing_source: None,
            pricing_version: None,
        }
    }
}

fn estimate_cost(usage: &NormalizedUsage, price: &UsagePrice) -> Option<u64> {
    let components = [
        (usage.input_tokens, price.input_microusd_per_million),
        (usage.output_tokens, price.output_microusd_per_million),
        (usage.reasoning_tokens, price.reasoning_microusd_per_million),
        (usage.cache_read_tokens, price.cache_read_microusd_per_million),
        (usage.cache_write_tokens, price.cache_write_microusd_per_million),
    ];
    let mut total = 0u128;
    let mut priced = false;
    for (tokens, rate) in components {
        let Some(rate) = rate.filter(|rate| *rate > 0) else { continue };
        priced = true;
        let tokens = u128::from(tokens?);
        total = total.checked_add(tokens.checked_mul(u128::from(rate))? / 1_000_000)?;
    }
    priced.then(|| u64::try_from(total).ok()).flatten()
}

pub struct CostEnrichingUsageRecorder {
    inner: Arc<dyn UsageRecorder>,
    snapshot: Arc<RwLock<PricingSnapshot>>,
}

impl CostEnrichingUsageRecorder {
    pub fn new(inner: Arc<dyn UsageRecorder>, snapshot: Arc<RwLock<PricingSnapshot>>) -> Self {
        Self { inner, snapshot }
    }
}

impl UsageRecorder for CostEnrichingUsageRecorder {
    fn record(&self, mut event: UsageAttemptEvent) {
        if event.event_kind != AttemptEventKind::AttemptStarted {
            let pricing = event
                .provider_id
                .as_deref()
                .zip(event.model_id.as_deref())
                .and_then(|(provider, model)| self.snapshot.read().ok()?.get(provider, model).cloned())
                .unwrap_or_default();
            let usage = NormalizedUsage {
                input_tokens: event.input_tokens,
                output_tokens: event.output_tokens,
                reasoning_tokens: event.reasoning_tokens,
                cache_read_tokens: event.cache_read_tokens,
                cache_write_tokens: event.cache_write_tokens,
            };
            let cost = resolve_cost(
                event.cost_microusd,
                &usage,
                pricing.catalog.as_ref(),
                pricing.manual.as_ref(),
                event.locality,
            );
            event.cost_microusd = cost.cost_microusd;
            event.cost_provenance = cost.provenance;
            event.pricing_source = cost.pricing_source;
            event.pricing_version = cost.pricing_version;
        }
        self.inner.record(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64) -> NormalizedUsage {
        NormalizedUsage { input_tokens: Some(input), output_tokens: Some(output), ..Default::default() }
    }

    fn catalog_price() -> UsagePrice {
        UsagePrice {
            input_microusd_per_million: Some(500_000),
            output_microusd_per_million: Some(1_000_000),
            source: "provider_catalog".to_string(),
            version: "catalog-1".to_string(),
            ..Default::default()
        }
    }

    fn manual_price() -> UsagePrice {
        UsagePrice {
            input_microusd_per_million: Some(1_000_000),
            output_microusd_per_million: Some(2_000_000),
            source: "manual".to_string(),
            version: "manual-1".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn provider_reported_cost_wins_unchanged() {
        let result = resolve_cost(Some(1_234), &usage(1_000, 500), Some(&catalog_price()), Some(&manual_price()), Locality::Cloud);
        assert_eq!(result.cost_microusd, Some(1_234));
        assert_eq!(result.provenance, CostProvenance::ProviderReported);
    }

    #[test]
    fn manual_override_wins_over_catalog_for_estimates() {
        let result = resolve_cost(None, &usage(1_000_000, 500_000), Some(&catalog_price()), Some(&manual_price()), Locality::Cloud);
        assert_eq!(result.cost_microusd, Some(2_000_000));
        assert_eq!(result.provenance, CostProvenance::ManualEstimated);
    }

    #[test]
    fn missing_token_component_does_not_become_zero_cost() {
        let mut value = usage(1_000, 500);
        value.output_tokens = None;
        assert_eq!(resolve_cost(None, &value, Some(&catalog_price()), None, Locality::Cloud).cost_microusd, None);
    }

    #[test]
    fn local_without_a_price_is_not_billed() {
        let result = resolve_cost(None, &usage(10, 5), None, None, Locality::Local);
        assert_eq!(result.provenance, CostProvenance::NotBilled);
    }
}
