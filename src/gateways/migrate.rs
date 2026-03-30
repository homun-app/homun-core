//! TOML-to-DB migration for channel configurations.
//!
//! Runs once at startup if the gateways table is empty.
//! Reads existing `[channels.*]` from config.toml and creates gateway rows.

use anyhow::{Context, Result};
use sqlx::{Pool, Sqlite};

use super::db;
use crate::config::Config;
use crate::storage::SecretKey;

/// Migrate TOML channel configs to the gateways table.
///
/// Idempotent: only runs if the gateways table is empty.
/// Tokens are stored in vault with `gateway.{id}.token` keys;
/// the config_json stores `"***ENCRYPTED***"` markers.
pub async fn migrate_toml_to_gateways(pool: &Pool<Sqlite>, config: &Config) -> Result<()> {
    if db::count_gateways(pool).await? > 0 {
        tracing::debug!("Gateways table already populated, skipping TOML migration");
        return Ok(());
    }

    tracing::info!("Migrating TOML channel configs to gateways table");

    let ch = &config.channels;

    // Telegram
    if ch.telegram.enabled || !ch.telegram.token.is_empty() {
        migrate_channel(pool, "Telegram", "telegram", &ch.telegram, config).await?;
    }

    // WhatsApp
    if ch.whatsapp.enabled {
        migrate_channel(pool, "WhatsApp", "whatsapp", &ch.whatsapp, config).await?;
    }

    // Discord
    if ch.discord.enabled || !ch.discord.token.is_empty() {
        migrate_channel(pool, "Discord", "discord", &ch.discord, config).await?;
    }

    // Slack
    if ch.slack.enabled || !ch.slack.token.is_empty() {
        migrate_channel(pool, "Slack", "slack", &ch.slack, config).await?;
    }

    // Email multi-account (EmailAccountConfig implements ChannelBehavior)
    // Use the account key directly as the gateway name (no "Email: " prefix).
    for (name, email_cfg) in &ch.emails {
        if email_cfg.enabled {
            migrate_channel(pool, name, "email", email_cfg, config).await?;
        }
    }

    // Email legacy single account (EmailConfig does not implement ChannelBehavior)
    if ch.email.enabled && ch.emails.is_empty() {
        let config_json =
            serde_json::to_string(&ch.email).context("Failed to serialize legacy email config")?;
        let id = db::insert_gateway(
            pool,
            "Email",
            "email",
            &config_json,
            "",
            "",
            "automatic",
            None,
        )
        .await?;
        copy_vault_token("email", id).await;
        tracing::info!(id, "Migrated legacy email to gateway");
    }

    // MCP channels
    for (name, mcp_cfg) in &ch.mcp {
        if mcp_cfg.enabled {
            migrate_channel(
                pool,
                &format!("MCP: {name}"),
                &format!("mcp:{name}"),
                mcp_cfg,
                config,
            )
            .await?;
        }
    }

    Ok(())
}

/// Migrate a single channel config to a gateway row.
///
/// Serializes the config struct to JSON, copies vault tokens, and creates the row.
async fn migrate_channel<T: serde::Serialize + crate::config::ChannelBehavior>(
    pool: &Pool<Sqlite>,
    display_name: &str,
    channel_type: &str,
    channel_config: &T,
    _config: &Config,
) -> Result<()> {
    // Serialize config to JSON
    let config_json = serde_json::to_string(channel_config)
        .with_context(|| format!("Failed to serialize {channel_type} config"))?;

    let behavior = channel_config;
    let default_profile = behavior.default_profile().to_string();
    let default_agent = behavior.default_agent().to_string();
    let response_mode = behavior.response_mode().to_string();
    let response_mode = if response_mode.is_empty() {
        "automatic".to_string()
    } else {
        response_mode
    };

    // Insert gateway row
    let id = db::insert_gateway(
        pool,
        display_name,
        channel_type,
        &config_json,
        &default_profile,
        &default_agent,
        &response_mode,
        None,
    )
    .await?;

    // Copy vault token from old key to new key
    copy_vault_token(channel_type, id).await;

    tracing::info!(
        id,
        name = %display_name,
        channel_type,
        default_profile = %default_profile,
        "Migrated channel to gateway"
    );

    Ok(())
}

/// Copy a vault token from the legacy `channel.{type}.token` key to `gateway.{id}.token`.
async fn copy_vault_token(channel_type: &str, gateway_id: i64) {
    let Ok(secrets) = crate::storage::global_secrets() else {
        return;
    };

    let old_key = SecretKey::channel_token(channel_type);
    let new_key = SecretKey::gateway_token(gateway_id);

    if let Ok(Some(token)) = secrets.get(&old_key) {
        if let Err(e) = secrets.set(&new_key, &token) {
            tracing::warn!(
                error = %e,
                channel_type,
                gateway_id,
                "Failed to copy vault token to gateway key"
            );
        }
    }

    // Slack also has app_token
    if channel_type == "slack" {
        let old_app_key = SecretKey::custom(&format!("channel.{channel_type}.app_token"));
        let new_app_key = SecretKey::gateway_app_token(gateway_id);
        if let Ok(Some(token)) = secrets.get(&old_app_key) {
            let _ = secrets.set(&new_app_key, &token);
        }
    }
}
