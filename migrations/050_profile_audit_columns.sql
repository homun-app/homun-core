-- Profile scoping for audit/log tables that were created before profile isolation.
-- Adds profile_id to vault_access_log, skill_audit, and pending_responses.
-- Existing rows get NULL (= global, visible to all profiles).

ALTER TABLE vault_access_log ADD COLUMN profile_id INTEGER;
ALTER TABLE skill_audit ADD COLUMN profile_id INTEGER;
ALTER TABLE pending_responses ADD COLUMN profile_id INTEGER;
