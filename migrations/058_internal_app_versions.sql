-- Version history for generated app blueprints.
CREATE TABLE IF NOT EXISTS internal_app_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    blueprint_json TEXT NOT NULL,
    change_note TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(app_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_internal_app_versions_app
    ON internal_app_versions(app_id, version_number DESC);
