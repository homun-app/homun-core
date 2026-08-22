//! Agent turn model provider seed owner.
//!
//! Owns the pre-loop consumption of the resolved model provider into
//! `LoopState`. Capability warm-up and provider binding construction stay in
//! their existing model routing/client owners.

use super::*;

pub(crate) async fn seed_agent_turn_model_provider(
    loop_state: &mut local_first_engine::LoopState,
    http: &reqwest::Client,
    model: String,
    base_url: String,
    api_key: Option<String>,
) {
    warm_turn_provider_capabilities(http, &base_url, &model).await;
    loop_state.provider = crate::model_client::gateway_provider_binding(model, base_url, api_key);
}
