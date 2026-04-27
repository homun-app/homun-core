-- Add local account lifecycle flags for admin-managed users.

ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_users_enabled ON users(enabled);
