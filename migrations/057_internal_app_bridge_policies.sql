-- Bridge policy for generated apps.
-- Fail-closed: missing row or missing capability means denied.
CREATE TABLE IF NOT EXISTS internal_app_bridge_policies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    policy_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_app_bridge_policy_app
    ON internal_app_bridge_policies(app_id);
