-- Allow marking a mobile device as the default notification target.
-- Only one device should be marked at a time (enforced in app logic).

ALTER TABLE mobile_devices ADD COLUMN is_notify_target INTEGER NOT NULL DEFAULT 0;
