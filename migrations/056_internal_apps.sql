-- Internal App Factory: generic blueprint apps and records
CREATE TABLE IF NOT EXISTS internal_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    profile_id INTEGER,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    blueprint_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT,
    UNIQUE(user_id, slug)
);

CREATE TABLE IF NOT EXISTS internal_app_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    entity_name TEXT NOT NULL,
    data_json TEXT NOT NULL,
    status TEXT,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS internal_app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES internal_apps(id) ON DELETE CASCADE,
    record_id INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    actor_user_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_internal_apps_user_profile ON internal_apps(user_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_internal_app_records_app_entity ON internal_app_records(app_id, entity_name);
CREATE INDEX IF NOT EXISTS idx_internal_app_events_app_record ON internal_app_events(app_id, record_id);
