-- Settings key-value store: DB overrides TOML for config sections.
-- Each row holds one JSON blob per config section (e.g. "security.execution_sandbox").
-- At startup, values here overlay the TOML defaults. On save, DB is primary + TOML backup.
CREATE TABLE IF NOT EXISTS settings (
    section    TEXT PRIMARY KEY NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
