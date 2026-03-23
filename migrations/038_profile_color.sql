-- Add color field to profiles (replaces avatar_emoji for visual indicator).
-- Default '#3B82F6' (blue) for existing profiles.
ALTER TABLE profiles ADD COLUMN color TEXT NOT NULL DEFAULT '#3B82F6';
