-- Contact perimeters: isolation by default for every contact.
-- Controls what the agent can access when responding to a specific contact.
-- A contact without a row here uses safe defaults (contact_only, _public, no vault).

CREATE TABLE IF NOT EXISTS contact_perimeters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL UNIQUE REFERENCES contacts(id) ON DELETE CASCADE,
    knowledge_namespaces TEXT NOT NULL DEFAULT '["_public"]',
    memory_scope TEXT NOT NULL DEFAULT 'contact_only',
    tools_allowed TEXT NOT NULL DEFAULT '[]',
    tools_denied TEXT NOT NULL DEFAULT '["vault"]',
    can_see_contacts INTEGER NOT NULL DEFAULT 0,
    can_see_calendar INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contact_perimeters_contact ON contact_perimeters(contact_id);
