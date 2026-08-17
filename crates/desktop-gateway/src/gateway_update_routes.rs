//! Update HTTP route owner.
//!
//! Owns the server-side redeploy webhook surface. The webhook URL remains in
//! gateway process environment and is never returned to the renderer.

use std::{env, time::Duration};

use axum::{Json, extract::State};
use serde::Serialize;

use crate::AppState;

fn update_webhook_from_env_value(value: Option<&str>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn update_webhook() -> Option<String> {
    update_webhook_from_env_value(env::var("HOMUN_UPDATE_WEBHOOK").ok().as_deref())
}

#[derive(Serialize)]
pub(crate) struct UpdateInfoResponse {
    /// True on a server deploy where a redeploy webhook (Coolify/PaaS) is set.
    webhook_configured: bool,
}

pub(crate) async fn update_info() -> Json<UpdateInfoResponse> {
    Json(UpdateInfoResponse {
        webhook_configured: update_webhook().is_some(),
    })
}

#[derive(Serialize)]
pub(crate) struct UpdateTriggerResponse {
    ok: bool,
    message: Option<String>,
}

pub(crate) async fn update_trigger(State(state): State<AppState>) -> Json<UpdateTriggerResponse> {
    let Some(webhook) = update_webhook() else {
        return Json(UpdateTriggerResponse {
            ok: false,
            message: Some("No update webhook configured (set HOMUN_UPDATE_WEBHOOK).".to_string()),
        });
    };
    match state
        .http
        .post(&webhook)
        .timeout(Duration::from_secs(15))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => Json(UpdateTriggerResponse {
            ok: true,
            message: None,
        }),
        Ok(response) => Json(UpdateTriggerResponse {
            ok: false,
            message: Some(format!("Webhook returned HTTP {}", response.status())),
        }),
        Err(error) => Json(UpdateTriggerResponse {
            ok: false,
            message: Some(format!("Webhook call failed: {error}")),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_webhook_env_normalization_trims_and_rejects_empty() {
        assert_eq!(
            update_webhook_from_env_value(Some("  https://example.test/hook  ")),
            Some("https://example.test/hook".to_string())
        );
        assert_eq!(update_webhook_from_env_value(Some("   ")), None);
        assert_eq!(update_webhook_from_env_value(None), None);
    }
}
