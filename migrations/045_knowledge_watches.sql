-- Monitored folders for automatic RAG ingestion.
-- Each watch has its own namespace, profile, and contact scoping.

CREATE TABLE IF NOT EXISTS knowledge_watches (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL,
    recursive   INTEGER NOT NULL DEFAULT 1,
    enabled     INTEGER NOT NULL DEFAULT 1,
    profile_id  INTEGER,
    namespace   TEXT NOT NULL DEFAULT '_private',
    contact_ids TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(path)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_watches_enabled ON knowledge_watches(enabled);
