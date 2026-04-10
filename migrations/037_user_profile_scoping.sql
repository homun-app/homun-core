-- Add user_id to all parent-scoped tables and profile_id to tables that miss it.
-- Seeds a default admin user for v2 (single-user mode).
-- user_id is TEXT (UUID) matching the existing users.id schema from migration 003.

-- 1. Seed default admin user (idempotent)
INSERT OR IGNORE INTO users (id, username, roles)
VALUES ('00000000-0000-0000-0000-000000000001', 'admin', '["admin"]');

-- 2. Add user_id FK to profiles
ALTER TABLE profiles ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);

-- 3. Add user_id to tables that already have profile_id
ALTER TABLE memory_chunks ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_user ON memory_chunks(user_id);

ALTER TABLE rag_chunks ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_user ON rag_chunks(user_id);

ALTER TABLE contacts ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);

ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

ALTER TABLE automations ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id);

ALTER TABLE workflows ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_workflows_user ON workflows(user_id);

-- 4. Add both user_id + profile_id to tables that have neither
ALTER TABLE memory_summaries ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE memory_summaries ADD COLUMN profile_id INTEGER REFERENCES profiles(id);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_user ON memory_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_profile ON memory_summaries(profile_id);

ALTER TABLE rag_sources ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE rag_sources ADD COLUMN profile_id INTEGER REFERENCES profiles(id);
CREATE INDEX IF NOT EXISTS idx_rag_sources_user ON rag_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_rag_sources_profile ON rag_sources(profile_id);

-- Note: `businesses` table columns were added here historically; the feature
-- has been removed and migration 053 drops the tables. Fresh installs never
-- create the businesses table, so those ALTER statements were removed.

ALTER TABLE email_pending ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE email_pending ADD COLUMN profile_id INTEGER REFERENCES profiles(id);
CREATE INDEX IF NOT EXISTS idx_email_pending_user ON email_pending(user_id);
CREATE INDEX IF NOT EXISTS idx_email_pending_profile ON email_pending(profile_id);
