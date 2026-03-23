-- Contact gateway overrides: per-contact, per-gateway profile assignment.
-- When a contact writes on a specific gateway, use this profile instead of the default.
-- Example: Marco on "Telegram Aziendale" → Profile "Fabio Lavoro",
--          Marco on "WhatsApp" → Profile "Fabio Personale".

CREATE TABLE IF NOT EXISTS contact_gateway_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    gateway_id INTEGER NOT NULL REFERENCES gateways(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(contact_id, gateway_id)
);

CREATE INDEX IF NOT EXISTS idx_cgo_contact ON contact_gateway_overrides(contact_id);
CREATE INDEX IF NOT EXISTS idx_cgo_gateway ON contact_gateway_overrides(gateway_id);
