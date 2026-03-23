-- Shared resources: explicit sharing of skills, MCP servers, tools, and namespaces
-- with specific contacts. The ONLY way for a contact to access resources
-- outside their perimeter base.

CREATE TABLE IF NOT EXISTS shared_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    owner_profile_id INTEGER NOT NULL REFERENCES profiles(id),
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(resource_type, resource_id, owner_profile_id)
);

CREATE TABLE IF NOT EXISTS shared_resource_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shared_resource_id INTEGER NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'read',
    scope_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(shared_resource_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_shared_resources_type ON shared_resources(resource_type);
CREATE INDEX IF NOT EXISTS idx_shared_resources_profile ON shared_resources(owner_profile_id);
CREATE INDEX IF NOT EXISTS idx_shared_access_contact ON shared_resource_access(contact_id);
CREATE INDEX IF NOT EXISTS idx_shared_access_resource ON shared_resource_access(shared_resource_id);
