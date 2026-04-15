mod account;
mod agents;
mod approvals;
mod automations;
mod browser;
mod browser_sites;
mod channels;
mod chat;
mod connections;
mod contacts;
mod crashes;
mod devices;
mod email_accounts;
mod embeddings;
mod gateways;
mod health;
mod knowledge;
mod logs;
mod maintenance;
mod mcp;
mod memory;
mod metrics;
mod mobile;
mod onboarding;
mod openai;
mod permissions;
mod profiles;
mod providers;
mod sandbox;
mod sessions;
mod settings;
mod sharing;
mod skills;
mod status;
mod traces;
mod usage;
mod vault;
mod workflows;

pub(crate) use chat::{
    cleanup_chat_upload_dirs, default_chat_conversation_id, ensure_chat_conversation_access,
    web_session_key, ChatUploadCleanupStats,
};
pub use health::{health, webhook_ingress};
pub(crate) use metrics::metrics_handler;

use std::sync::Arc;

use axum::Router;
use serde::Serialize;

use super::server::AppState;

pub fn router() -> Router<Arc<AppState>> {
    let api_router = Router::new()
        // Note: /health and /v1/webhook/{token} are registered as public routes in server.rs
        .merge(logs::routes())
        .merge(status::routes())
        .merge(metrics::routes())
        .merge(crashes::routes())
        .merge(skills::routes())
        .merge(providers::routes())
        .merge(mcp::routes())
        // --- Channels ---
        .merge(channels::routes())
        // Note: /v1/webhook/{token} is registered as public route in server.rs
        // --- Account ---
        .merge(account::routes())
        // --- Memory ---
        .merge(memory::routes())
        // --- Chat ---
        .merge(chat::routes())
        // --- Vault + 2FA ---
        .merge(vault::routes())
        .merge(permissions::routes())
        .merge(sandbox::routes())
        // --- Approvals ---
        .merge(approvals::routes())
        // --- Email Accounts (multi-account) ---
        .merge(email_accounts::routes())
        // --- Connection Recipes ---
        .merge(connections::routes())
        .merge(automations::routes())
        // --- Maintenance ---
        .merge(maintenance::routes())
        // --- Usage ---
        .merge(usage::routes())
        .merge(workflows::routes())
        .merge(contacts::routes())
        .merge(profiles::routes())
        .merge(gateways::routes())
        .merge(sharing::routes())
        .merge(onboarding::routes())
        .merge(agents::routes())
        .merge(devices::routes())
        .merge(mobile::routes())
        // --- OpenAI-compatible API ---
        .merge(openai::routes())
        .merge(sessions::routes())
        .merge(settings::routes())
        .merge(traces::routes());

    // --- Knowledge Base (RAG) ---
    #[cfg(feature = "embeddings")]
    let api_router = api_router.merge(knowledge::routes());

    // --- Embedding Index Management ---
    #[cfg(feature = "embeddings")]
    let api_router = api_router.merge(embeddings::routes());

    // --- Browser (optional) ---
    #[cfg(feature = "browser")]
    let api_router = api_router.merge(browser::routes());

    // --- Browser allowed sites (always available, even without browser feature) ---
    let api_router = api_router.merge(browser_sites::routes());

    api_router.merge(health::routes())
}

pub fn public_router() -> Router<Arc<AppState>> {
    mobile::public_routes()
}

#[derive(Serialize)]
struct OkResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}
