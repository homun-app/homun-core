//! Gateway system — channel instances stored in the database.
//!
//! A gateway is a configured instance of a channel type (Telegram bot, WhatsApp account, etc.).
//! Multiple gateways of the same type are supported (e.g. personal + work Telegram bots).
//! Each gateway has its own profile, response mode, and configuration.

pub mod db;
pub mod migrate;

use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::config::ChannelBehavior;
use crate::storage::Database;

// ── Domain types ────────────────────────────────────────────────────

/// A gateway row from the database.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Gateway {
    pub id: i64,
    pub name: String,
    pub channel_type: String,
    pub enabled: i64,
    pub config_json: String,
    pub default_profile: String,
    pub default_agent: String,
    pub response_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl Gateway {
    /// Deserialize `config_json` into a typed channel config struct.
    ///
    /// Example: `gw.parsed_config::<TelegramConfig>()?`
    pub fn parsed_config<T: DeserializeOwned>(&self) -> Result<T> {
        serde_json::from_str(&self.config_json)
            .with_context(|| format!("Failed to parse config_json for gateway {}", self.id))
    }

    /// Extract common behavior fields from config_json.
    ///
    /// Returns owned values since the parsed JSON is temporary.
    pub fn behavior(&self) -> Result<GatewayBehavior> {
        let v: serde_json::Value = serde_json::from_str(&self.config_json)
            .with_context(|| format!("Failed to parse config_json for gateway {}", self.id))?;

        Ok(GatewayBehavior {
            persona: json_str(&v, "persona"),
            tone_of_voice: json_str(&v, "tone_of_voice"),
            response_mode: self.response_mode.clone(),
            notify_channel: json_opt_str(&v, "notify_channel"),
            notify_chat_id: json_opt_str(&v, "notify_chat_id"),
            allow_from: json_str_vec(&v, "allow_from"),
            pairing_required: v
                .get("pairing_required")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            default_agent: self.default_agent.clone(),
            default_profile: self.default_profile.clone(),
        })
    }

    /// Whether this gateway is enabled (SQLite stores as i64).
    pub fn is_enabled(&self) -> bool {
        self.enabled != 0
    }
}

/// Extract a string value from a JSON object, defaulting to empty.
fn json_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Extract an optional string value from a JSON object.
fn json_opt_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// Extract a string array from a JSON object, defaulting to empty vec.
fn json_str_vec(v: &serde_json::Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

// ── GatewayBehavior ─────────────────────────────────────────────────

/// Owned behavior values extracted from a gateway's config_json.
///
/// Implements `ChannelBehavior` so it can be used wherever the trait is needed.
#[derive(Debug, Clone)]
pub struct GatewayBehavior {
    pub persona: String,
    pub tone_of_voice: String,
    pub response_mode: String,
    pub notify_channel: Option<String>,
    pub notify_chat_id: Option<String>,
    pub allow_from: Vec<String>,
    pub pairing_required: bool,
    pub default_agent: String,
    pub default_profile: String,
}

impl ChannelBehavior for GatewayBehavior {
    fn persona(&self) -> &str {
        &self.persona
    }
    fn tone_of_voice(&self) -> &str {
        &self.tone_of_voice
    }
    fn response_mode(&self) -> &str {
        &self.response_mode
    }
    fn notify_channel(&self) -> Option<&str> {
        self.notify_channel.as_deref()
    }
    fn notify_chat_id(&self) -> Option<&str> {
        self.notify_chat_id.as_deref()
    }
    fn allow_from(&self) -> &[String] {
        &self.allow_from
    }
    fn pairing_required(&self) -> bool {
        self.pairing_required
    }
    fn default_agent(&self) -> &str {
        &self.default_agent
    }
    fn default_profile(&self) -> &str {
        &self.default_profile
    }
}

// ── GatewayRegistry ─────────────────────────────────────────────────

/// In-memory cache of all gateways, loaded from DB at startup.
#[derive(Clone)]
pub struct GatewayRegistry {
    gateways: Arc<RwLock<Vec<Gateway>>>,
}

impl GatewayRegistry {
    /// Load all gateways from the database.
    pub async fn load(database: &Database) -> Result<Self> {
        let all = db::load_all_gateways(database.pool()).await?;
        Ok(Self {
            gateways: Arc::new(RwLock::new(all)),
        })
    }

    /// Reload gateways from the database.
    pub async fn reload(&self, database: &Database) -> Result<()> {
        let all = db::load_all_gateways(database.pool()).await?;
        *self.gateways.write().await = all;
        Ok(())
    }

    /// Get a gateway by database id.
    pub async fn by_id(&self, id: i64) -> Option<Gateway> {
        self.gateways
            .read()
            .await
            .iter()
            .find(|g| g.id == id)
            .cloned()
    }

    /// Get all gateways of a given channel type (e.g. "telegram").
    pub async fn by_channel_type(&self, channel_type: &str) -> Vec<Gateway> {
        self.gateways
            .read()
            .await
            .iter()
            .filter(|g| g.channel_type == channel_type)
            .cloned()
            .collect()
    }

    /// Get all enabled gateways.
    pub async fn enabled(&self) -> Vec<Gateway> {
        self.gateways
            .read()
            .await
            .iter()
            .filter(|g| g.is_enabled())
            .cloned()
            .collect()
    }

    /// List all gateways.
    pub async fn list(&self) -> Vec<Gateway> {
        self.gateways.read().await.clone()
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_behavior_from_json() {
        let gw = Gateway {
            id: 1,
            name: "Test Telegram".into(),
            channel_type: "telegram".into(),
            enabled: 1,
            config_json: r#"{
                "persona": "bot",
                "tone_of_voice": "casual",
                "allow_from": ["123", "456"],
                "pairing_required": true
            }"#
            .into(),
            default_profile: "personal".into(),
            default_agent: "".into(),
            response_mode: "automatic".into(),
            user_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        let b = gw.behavior().expect("parse behavior");
        assert_eq!(b.persona(), "bot");
        assert_eq!(b.tone_of_voice(), "casual");
        assert_eq!(b.response_mode(), "automatic");
        assert_eq!(b.allow_from(), &["123", "456"]);
        assert!(b.pairing_required());
        assert_eq!(b.default_profile(), "personal");
    }

    #[test]
    fn gateway_behavior_defaults() {
        let gw = Gateway {
            id: 1,
            name: "Empty".into(),
            channel_type: "telegram".into(),
            enabled: 1,
            config_json: "{}".into(),
            default_profile: "".into(),
            default_agent: "".into(),
            response_mode: "automatic".into(),
            user_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        let b = gw.behavior().expect("parse behavior");
        assert_eq!(b.persona(), "");
        assert_eq!(b.allow_from().len(), 0);
        assert!(!b.pairing_required());
    }

    #[test]
    fn is_enabled_check() {
        let mut gw = Gateway {
            id: 1,
            name: "Test".into(),
            channel_type: "telegram".into(),
            enabled: 1,
            config_json: "{}".into(),
            default_profile: "".into(),
            default_agent: "".into(),
            response_mode: "automatic".into(),
            user_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        };

        assert!(gw.is_enabled());
        gw.enabled = 0;
        assert!(!gw.is_enabled());
    }
}
