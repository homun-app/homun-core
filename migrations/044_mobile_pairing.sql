-- Mobile app pairing sessions and registered devices.

CREATE TABLE IF NOT EXISTS mobile_pairing_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    nonce_hash TEXT NOT NULL,
    base_url TEXT NOT NULL,
    server_fingerprint TEXT NOT NULL,
    device_name TEXT,
    platform TEXT,
    app_version TEXT,
    device_public_key TEXT,
    device_push_token TEXT,
    device_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at TEXT,
    approved_at TEXT,
    completed_at TEXT,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mobile_pairing_sessions_user
    ON mobile_pairing_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mobile_pairing_sessions_status
    ON mobile_pairing_sessions(status, expires_at);

CREATE TABLE IF NOT EXISTS mobile_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL,
    app_version TEXT,
    public_key TEXT,
    push_token TEXT,
    token TEXT NOT NULL REFERENCES webhook_tokens(token) ON DELETE CASCADE,
    can_emergency_stop INTEGER NOT NULL DEFAULT 0,
    server_fingerprint_at_pair TEXT NOT NULL,
    last_seen_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_user
    ON mobile_devices(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mobile_devices_token
    ON mobile_devices(token);
