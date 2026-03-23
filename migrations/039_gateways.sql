-- Gateway instances: N channels per type, each with its own config and profile.
-- Replaces singleton [channels.*] in config.toml.
-- Tokens stored as "***ENCRYPTED***" marker; real values in vault (gateway.{id}.token).

CREATE TABLE IF NOT EXISTS gateways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    default_profile TEXT NOT NULL DEFAULT '',
    default_agent TEXT NOT NULL DEFAULT '',
    response_mode TEXT NOT NULL DEFAULT 'automatic',
    user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_gateways_channel_type ON gateways(channel_type);
CREATE INDEX IF NOT EXISTS idx_gateways_user ON gateways(user_id);
CREATE INDEX IF NOT EXISTS idx_gateways_enabled ON gateways(enabled);
